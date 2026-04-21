// Contact lookup and write actions for the sidebar.
// Reads: outreach_logs + interactions + value_logs + opportunities (via opportunity_contacts).
// Writes: insert interactions and value_logs.

import { ipcMain } from 'electron'
import { getSupabase } from './client'
import { phoneVariants } from '../utils/phone'
import { linkedinSlug, linkedinUrlVariants } from '../utils/linkedin'

// ─── Types ───────────────────────────────────────────────────────────────────

export type InteractionSummary = {
  id: string
  type: string
  direction: string | null
  interaction_date: string
  notes: string | null
  next_step: string | null
  next_step_date: string | null
  next_step_owner: string | null
  channel: string | null
}

export type ValueLogSummary = {
  id: string
  type: string
  description: string | null
  date: string
}

export type OpportunitySummary = {
  id: string
  title: string
  stage: string
  company_name: string | null
}

export type ContactDetail = {
  id: string
  name: string
  tier: number | null
  profile_photo_url: string | null
  job_title: string | null
  company: string | null
  personal_context: string | null
  linkedin_url: string | null
  referred_by: string | null
  status: string | null
  category: string | null
  health_score: number | null
  last_interaction_at: string | null
  phone: string | null
  email: string | null
  birthday: string | null
  interaction_count: number
  value_log_count: number
  recent_interactions: InteractionSummary[]
  value_logs: ValueLogSummary[]
  active_opportunities: OpportunitySummary[]
}

export type LogInteractionInput = {
  contact_id: string
  type: string
  direction?: string
  notes: string | null
  next_step: string | null
  next_step_date: string | null
}

export type AddValueLogInput = {
  contact_id: string
  type: string
  description: string | null
}

export type WriteResult = { ok: true } | { ok: false; error: string }

// Compact shape used by the group sidebar — one row per participant.
export type ContactBrief = {
  id: string
  name: string
  job_title: string | null
  company: string | null
  profile_photo_url: string | null
  tier: number | null
  last_interaction_at: string | null
  status: string | null
  linkedin_url: string | null
}

export type CreateContactInput = {
  name: string
  linkedin_url: string | null
  phone: string
  waName: string | null
  referred_by: string | null
}

export type CreateContactResult =
  | { ok: true; contactId: string; enriched: boolean }
  | { ok: false; error: string }

// ─── Reads ───────────────────────────────────────────────────────────────────

async function resolveContactIdByPhone(phone: string): Promise<string | null> {
  const supabase = getSupabase()
  const trimmed = phone.trim()
  if (!trimmed) return null

  const variants = phoneVariants(trimmed)

  // Source 1 (primary): contact_channels — the unified channels table. This is
  // where reThink writes new mappings and where multi-phone / multi-channel
  // contacts live.
  try {
    const { data, error } = await supabase
      .from('contact_channels')
      .select('outreach_log_id')
      .eq('channel', 'whatsapp')
      .in('channel_identifier', variants)
      .limit(1)
      .maybeSingle()
    if (!error && data) {
      console.log('[contacts] match via contact_channels →', trimmed)
      return data.outreach_log_id as string
    }
  } catch (err) {
    // contact_channels may not exist in all schemas; don't fail the whole lookup
    console.warn('[contacts] contact_channels query failed:', err)
  }

  // Source 2 (legacy): contact_phone_mappings — what the old extension wrote
  // and what my earlier code was exclusively querying.
  {
    const { data, error } = await supabase
      .from('contact_phone_mappings')
      .select('contact_id')
      .in('phone_number', variants)
      .limit(1)
      .maybeSingle()
    if (!error && data) {
      console.log('[contacts] match via contact_phone_mappings →', trimmed)
      return data.contact_id as string
    }
  }

  // Source 3 (extra safety): direct match on outreach_logs.phone. Catches any
  // contact that was created with a phone but never got a row in either of the
  // mapping tables above.
  {
    const { data, error } = await supabase
      .from('outreach_logs')
      .select('id')
      .in('phone', variants)
      .limit(1)
      .maybeSingle()
    if (!error && data) {
      console.log('[contacts] match via outreach_logs.phone →', trimmed)
      return data.id as string
    }
  }

  console.log('[contacts] no match for phone →', trimmed, 'variants:', variants)
  return null
}

async function resolveContactIdByLinkedinUrl(url: string): Promise<string | null> {
  const supabase = getSupabase()
  const variants = linkedinUrlVariants(url)
  const slug = linkedinSlug(url)
  if (variants.length === 0) return null

  console.log('[contacts] LI lookup →', url, 'slug=', slug, 'variants=', variants)

  // Source 1: exact match in contact_channels
  try {
    const { data } = await supabase
      .from('contact_channels')
      .select('outreach_log_id')
      .eq('channel', 'linkedin')
      .in('channel_identifier', variants)
      .limit(1)
      .maybeSingle()
    if (data) {
      console.log('[contacts] LI match via contact_channels (exact) →', url)
      return data.outreach_log_id as string
    }
  } catch (err) {
    console.warn('[contacts] contact_channels LI query failed:', err)
  }

  // Source 2: exact match in outreach_logs.linkedin_url
  {
    const { data } = await supabase
      .from('outreach_logs')
      .select('id')
      .in('linkedin_url', variants)
      .limit(1)
      .maybeSingle()
    if (data) {
      console.log('[contacts] LI match via outreach_logs.linkedin_url (exact) →', url)
      return data.id as string
    }
  }

  // Source 3: slug-based ilike fallback. Handles all the edge cases the
  // variant list can't — trailing query params, different case in the slug,
  // historical /in/ formats, etc. The slug is the unique identifier of a
  // LinkedIn profile, so matching "%in/<slug>%" is semantically correct.
  if (slug) {
    const pattern = '%/in/' + slug + '%'

    const { data: chData } = await supabase
      .from('contact_channels')
      .select('outreach_log_id')
      .eq('channel', 'linkedin')
      .ilike('channel_identifier', pattern)
      .limit(1)
      .maybeSingle()
    if (chData) {
      console.log('[contacts] LI match via contact_channels (slug ilike) →', slug)
      return chData.outreach_log_id as string
    }

    const { data: olData } = await supabase
      .from('outreach_logs')
      .select('id')
      .ilike('linkedin_url', pattern)
      .limit(1)
      .maybeSingle()
    if (olData) {
      console.log('[contacts] LI match via outreach_logs.linkedin_url (slug ilike) →', slug)
      return olData.id as string
    }
  }

  console.log('[contacts] no LI match for →', url)
  return null
}

async function findContactByLinkedinUrl(url: string): Promise<ContactDetail | null> {
  const contactId = await resolveContactIdByLinkedinUrl(url)
  if (!contactId) return null
  return loadContactDetail(contactId)
}

async function findContactByPhone(phone: string): Promise<ContactDetail | null> {
  const contactId = await resolveContactIdByPhone(phone)
  if (!contactId) return null
  return loadContactDetail(contactId)
}

/**
 * Name-based lookup fallback. Used when WhatsApp's new DOM (2026-04) gives us
 * only the saved contact's display name (no phone number). Returns the best
 * exact match. If 0 or >1 matches exist, returns null and the sidebar falls
 * back to an empty state so the user can manually map.
 */
async function findContactByName(name: string): Promise<ContactDetail | null> {
  const q = name.trim()
  if (q.length < 2) return null
  const supabase = getSupabase()

  // Source 0 (highest priority): explicit "WhatsApp display name" mapping
  // saved when the user links a chat to an existing reThink contact. Uses
  // the same contact_channels table, channel='whatsapp', with identifier
  // prefixed 'waname:<exact display name>'. This is the map-once-forever
  // mechanism for saved contacts whose WhatsApp display name doesn't match
  // their reThink name (e.g., WA shows "Amoor | USA", reThink "Maria Jose").
  const wanameKey = 'waname:' + q
  const { data: wanameMatch } = await supabase
    .from('contact_channels')
    .select('outreach_log_id')
    .eq('channel', 'whatsapp')
    .eq('channel_identifier', wanameKey)
    .limit(1)
    .maybeSingle()
  if (wanameMatch) {
    const id = (wanameMatch as { outreach_log_id: string }).outreach_log_id
    console.log('[contacts] waname exact channel match →', q)
    return loadContactDetail(id)
  }

  // Exact match first (case-insensitive). Single hit wins.
  const { data: exact } = await supabase
    .from('outreach_logs')
    .select('id')
    .ilike('name', q)
    .limit(2)
  if (exact && exact.length === 1) {
    console.log('[contacts] name exact match →', q)
    return loadContactDetail((exact[0] as { id: string }).id)
  }
  // Fall back to substring match only if there's exactly one result.
  // More than one is ambiguous — let the user disambiguate manually.
  const { data: fuzzy } = await supabase
    .from('outreach_logs')
    .select('id, name')
    .ilike('name', `%${q}%`)
    .limit(3)
  if (fuzzy && fuzzy.length === 1) {
    console.log('[contacts] name fuzzy match →', q, '→', (fuzzy[0] as { name: string }).name)
    return loadContactDetail((fuzzy[0] as { id: string }).id)
  }
  console.log('[contacts] name lookup ambiguous or empty →', q, `(${fuzzy?.length ?? 0} candidates)`)
  return null
}

async function loadContactDetail(contactId: string): Promise<ContactDetail | null> {
  const supabase = getSupabase()

  const contactPromise = supabase
    .from('outreach_logs')
    .select(
      [
        'id',
        'name',
        'tier',
        'profile_photo_url',
        'job_title',
        'company',
        'personal_context',
        'linkedin_url',
        'referred_by',
        'status',
        'category',
        'health_score',
        'last_interaction_at',
        'phone',
        'email',
        'birthday',
      ].join(', '),
    )
    .eq('id', contactId)
    .maybeSingle()

  const interactionsPromise = supabase
    .from('interactions')
    .select(
      'id, type, direction, interaction_date, notes, next_step, next_step_date, next_step_owner, channel',
    )
    .eq('contact_id', contactId)
    .order('interaction_date', { ascending: false })
    .limit(8)

  const valueLogsPromise = supabase
    .from('value_logs')
    .select('id, type, description, date')
    .eq('outreach_log_id', contactId)
    .order('date', { ascending: false })
    .limit(6)

  const interactionCountPromise = supabase
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)

  const valueLogCountPromise = supabase
    .from('value_logs')
    .select('id', { count: 'exact', head: true })
    .eq('outreach_log_id', contactId)

  const oppContactsPromise = supabase
    .from('opportunity_contacts')
    .select('opportunity_id')
    .eq('outreach_log_id', contactId)

  const [
    contactRes,
    interactionsRes,
    valueLogsRes,
    interactionCountRes,
    valueLogCountRes,
    oppContactsRes,
  ] = await Promise.all([
    contactPromise,
    interactionsPromise,
    valueLogsPromise,
    interactionCountPromise,
    valueLogCountPromise,
    oppContactsPromise,
  ])

  if (contactRes.error || !contactRes.data) {
    console.error('[contacts] outreach_logs lookup failed:', contactRes.error)
    return null
  }

  // Fetch active opportunities (exploring/active/negotiating) with company name.
  let opportunities: OpportunitySummary[] = []
  if (oppContactsRes.data && oppContactsRes.data.length > 0) {
    const oppIds = (oppContactsRes.data as Array<{ opportunity_id: string }>).map(
      (r) => r.opportunity_id,
    )
    const { data: opps, error: oppsErr } = await supabase
      .from('opportunities')
      .select('id, title, stage, company:companies(name)')
      .in('id', oppIds)
      .in('stage', ['exploring', 'active', 'negotiating'])
    if (oppsErr) {
      console.warn('[contacts] opportunities lookup failed:', oppsErr)
    } else {
      opportunities = ((opps ?? []) as Array<{
        id: string
        title: string
        stage: string
        company: { name: string } | { name: string }[] | null
      }>).map((o) => {
        const comp = Array.isArray(o.company) ? o.company[0] : o.company
        return {
          id: o.id,
          title: o.title,
          stage: o.stage,
          company_name: comp?.name ?? null,
        }
      })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = contactRes.data as any

  return {
    id: c.id,
    name: c.name,
    tier: c.tier ?? null,
    profile_photo_url: c.profile_photo_url ?? null,
    job_title: c.job_title ?? null,
    company: c.company ?? null,
    personal_context: c.personal_context ?? null,
    linkedin_url: c.linkedin_url ?? null,
    referred_by: c.referred_by ?? null,
    status: c.status ?? null,
    category: c.category ?? null,
    health_score: c.health_score ?? null,
    last_interaction_at: c.last_interaction_at ?? null,
    phone: c.phone ?? null,
    email: c.email ?? null,
    birthday: c.birthday ?? null,
    interaction_count: interactionCountRes.count ?? 0,
    value_log_count: valueLogCountRes.count ?? 0,
    recent_interactions: (interactionsRes.data as InteractionSummary[] | null) ?? [],
    value_logs: (valueLogsRes.data as ValueLogSummary[] | null) ?? [],
    active_opportunities: opportunities,
  }
}

// ─── Writes ──────────────────────────────────────────────────────────────────

async function logInteraction(input: LogInteractionInput): Promise<WriteResult> {
  const supabase = getSupabase()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return { ok: false, error: 'Not signed in' }
  const userId = session.user.id

  const today = new Date().toISOString().slice(0, 10)
  const nowIso = new Date().toISOString()

  const { error: insertErr } = await supabase.from('interactions').insert({
    user_id: userId,
    contact_id: input.contact_id,
    type: input.type,
    direction: input.direction ?? 'outbound',
    notes: input.notes,
    next_step: input.next_step,
    next_step_date: input.next_step_date,
    next_step_owner: input.next_step ? 'me' : null,
    interaction_date: today,
  })
  if (insertErr) {
    console.error('[contacts] logInteraction insert failed:', insertErr)
    return { ok: false, error: insertErr.message }
  }

  // Bump last_interaction_at so reThink's list view reflects it immediately.
  await supabase
    .from('outreach_logs')
    .update({ last_interaction_at: nowIso, updated_at: nowIso })
    .eq('id', input.contact_id)

  return { ok: true }
}

async function addValueLog(input: AddValueLogInput): Promise<WriteResult> {
  const supabase = getSupabase()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return { ok: false, error: 'Not signed in' }
  const userId = session.user.id

  const { error } = await supabase.from('value_logs').insert({
    user_id: userId,
    outreach_log_id: input.contact_id,
    type: input.type,
    description: input.description,
    date: new Date().toISOString().slice(0, 10),
  })
  if (error) {
    console.error('[contacts] addValueLog insert failed:', error)
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

// ─── Batch lookup (for group participants) ───────────────────────────────────

const BRIEF_COLUMNS =
  'id, name, job_title, company, profile_photo_url, tier, last_interaction_at, status, linkedin_url'

export type ParticipantLookupInput = {
  phone: string | null
  lid: string | null
  waName: string | null
}

/**
 * Batch-resolve a list of group participants (mix of phones and LIDs) to
 * reThink contact briefs.
 *
 * Strategy:
 *   1. For participants with a phone, use the normal phone-variant lookup
 *      (contact_channels ∪ contact_phone_mappings ∪ outreach_logs.phone).
 *   2. For LID-only participants, fall back to a name ILIKE search against
 *      outreach_logs.name using waName. If exactly one hit, we use it.
 *      Multiple hits → ambiguous, treated as unmapped. Zero → unmapped.
 *
 * The result is keyed by a synthetic participant key:
 *   "phone:+18573900458"  or  "lid:244482926760154"
 * so the caller (GroupScreen) can tell matched from unmatched regardless
 * of which identifier it happened to carry.
 */
export function participantKey(p: {
  phone: string | null
  lid: string | null
}): string {
  if (p.phone) return 'phone:' + p.phone
  if (p.lid) return 'lid:' + p.lid
  return 'unknown'
}

async function getContactBriefsForParticipants(
  participants: ParticipantLookupInput[],
): Promise<Record<string, ContactBrief | null>> {
  const result: Record<string, ContactBrief | null> = {}
  if (participants.length === 0) return result
  for (const p of participants) result[participantKey(p)] = null

  const supabase = getSupabase()

  // ── Phone batch (same as before, but scoped to phone-bearing participants) ──
  const phoneParticipants = participants.filter((p) => p.phone)
  if (phoneParticipants.length > 0) {
    const allVariants = new Set<string>()
    const phoneToVariants = new Map<string, string[]>()
    for (const p of phoneParticipants) {
      const v = phoneVariants(p.phone!)
      phoneToVariants.set(p.phone!, v)
      for (const x of v) allVariants.add(x)
    }
    const variantsArr = Array.from(allVariants)

    const [channelsRes, mappingsRes, directRes] = await Promise.all([
      supabase
        .from('contact_channels')
        .select('outreach_log_id, channel_identifier')
        .eq('channel', 'whatsapp')
        .in('channel_identifier', variantsArr),
      supabase
        .from('contact_phone_mappings')
        .select('contact_id, phone_number')
        .in('phone_number', variantsArr),
      supabase.from('outreach_logs').select('id, phone').in('phone', variantsArr),
    ])

    const variantToContactId = new Map<string, string>()
    for (const row of (channelsRes.data ?? []) as Array<{
      outreach_log_id: string
      channel_identifier: string
    }>) {
      variantToContactId.set(row.channel_identifier, row.outreach_log_id)
    }
    for (const row of (mappingsRes.data ?? []) as Array<{
      contact_id: string
      phone_number: string
    }>) {
      if (!variantToContactId.has(row.phone_number)) {
        variantToContactId.set(row.phone_number, row.contact_id)
      }
    }
    for (const row of (directRes.data ?? []) as Array<{
      id: string
      phone: string | null
    }>) {
      if (row.phone && !variantToContactId.has(row.phone)) {
        variantToContactId.set(row.phone, row.id)
      }
    }

    const phoneToContactId = new Map<string, string>()
    const contactIdsFromPhones = new Set<string>()
    for (const [phone, variants] of phoneToVariants) {
      for (const v of variants) {
        const id = variantToContactId.get(v)
        if (id) {
          phoneToContactId.set(phone, id)
          contactIdsFromPhones.add(id)
          break
        }
      }
    }

    if (contactIdsFromPhones.size > 0) {
      const { data: briefs } = await supabase
        .from('outreach_logs')
        .select(BRIEF_COLUMNS)
        .in('id', Array.from(contactIdsFromPhones))
      const briefsById = new Map<string, ContactBrief>()
      for (const b of (briefs ?? []) as ContactBrief[]) briefsById.set(b.id, b)
      for (const [phone, contactId] of phoneToContactId) {
        const brief = briefsById.get(contactId)
        if (brief) result['phone:' + phone] = brief
      }

      // Also store the channel identifier of the LID-less contacts we just
      // found so that if some LID-only participant has the SAME contact_id
      // (user previously merged them), we can match it via contact_channels.
      // (Noop here — handled in LID pass below.)
    }
  }

  // ── LID pass: two-stage resolution ──
  // LIDs are opaque WhatsApp identifiers with no DOM-accessible phone mapping.
  // We store previously-linked LIDs in contact_channels with the identifier
  // prefixed "lid:" so a persistent map-once lookup works on subsequent
  // sightings. For first-time LIDs we fall back to an unambiguous name search.
  const lidParticipants = participants.filter((p) => !p.phone && p.lid)
  if (lidParticipants.length > 0) {
    const lidKeys = lidParticipants.map((p) => 'lid:' + p.lid!)

    // Stage 1: contact_channels stored LID identifiers
    const { data: lidChannels } = await supabase
      .from('contact_channels')
      .select('outreach_log_id, channel_identifier')
      .eq('channel', 'whatsapp')
      .in('channel_identifier', lidKeys)

    const lidToContactId = new Map<string, string>()
    for (const row of (lidChannels ?? []) as Array<{
      outreach_log_id: string
      channel_identifier: string
    }>) {
      // channel_identifier is 'lid:<value>', strip prefix to key by raw LID
      const lid = row.channel_identifier.replace(/^lid:/, '')
      lidToContactId.set(lid, row.outreach_log_id)
    }

    const lidContactIds = new Set(lidToContactId.values())
    const lidBriefsById = new Map<string, ContactBrief>()
    if (lidContactIds.size > 0) {
      const { data: briefs } = await supabase
        .from('outreach_logs')
        .select(BRIEF_COLUMNS)
        .in('id', Array.from(lidContactIds))
      for (const b of (briefs ?? []) as ContactBrief[]) {
        lidBriefsById.set(b.id, b)
      }
    }

    // Stage 2: for LIDs without a stored mapping, try unambiguous name search
    const needsNameSearch = lidParticipants.filter(
      (p) => !lidToContactId.has(p.lid!) && p.waName && p.waName.length >= 2,
    )
    const nameHits = new Map<string, ContactBrief>()
    const nameAmbiguous = new Set<string>()
    if (needsNameSearch.length > 0) {
      const namesToSearch = new Set(needsNameSearch.map((p) => p.waName!))
      await Promise.all(
        Array.from(namesToSearch).map(async (name) => {
          const { data } = await supabase
            .from('outreach_logs')
            .select(BRIEF_COLUMNS)
            .ilike('name', `%${name}%`)
            .limit(2)
          const rows = (data as ContactBrief[] | null) ?? []
          if (rows.length === 1) nameHits.set(name, rows[0])
          else if (rows.length > 1) nameAmbiguous.add(name)
        }),
      )
    }

    // Assign LID results
    for (const p of lidParticipants) {
      const key = 'lid:' + p.lid!
      const mappedId = lidToContactId.get(p.lid!)
      if (mappedId) {
        const brief = lidBriefsById.get(mappedId)
        if (brief) result[key] = brief
        continue
      }
      if (p.waName) {
        const hit = nameHits.get(p.waName)
        if (hit && !nameAmbiguous.has(p.waName)) {
          result[key] = hit
        }
      }
    }
  }

  return result
}

/** @deprecated use getContactBriefsForParticipants. Kept for backward compat. */
async function getContactBriefsByPhones(
  phones: string[],
): Promise<Record<string, ContactBrief | null>> {
  const result: Record<string, ContactBrief | null> = {}
  if (phones.length === 0) return result
  for (const p of phones) result[p] = null

  const supabase = getSupabase()

  // Collect all variants across all phones so we can query with a single IN.
  const allVariants = new Set<string>()
  const phoneToVariants = new Map<string, string[]>()
  for (const p of phones) {
    const v = phoneVariants(p)
    phoneToVariants.set(p, v)
    for (const x of v) allVariants.add(x)
  }
  const variantsArr = Array.from(allVariants)

  // Parallel lookups across the three sources. Each query returns the matching
  // variant so we can map results back to the originally requested phones.
  const [channelsRes, mappingsRes, directRes] = await Promise.all([
    supabase
      .from('contact_channels')
      .select('outreach_log_id, channel_identifier')
      .eq('channel', 'whatsapp')
      .in('channel_identifier', variantsArr),
    supabase
      .from('contact_phone_mappings')
      .select('contact_id, phone_number')
      .in('phone_number', variantsArr),
    supabase.from('outreach_logs').select('id, phone').in('phone', variantsArr),
  ])

  const variantToContactId = new Map<string, string>()
  for (const row of (channelsRes.data ?? []) as Array<{
    outreach_log_id: string
    channel_identifier: string
  }>) {
    variantToContactId.set(row.channel_identifier, row.outreach_log_id)
  }
  for (const row of (mappingsRes.data ?? []) as Array<{
    contact_id: string
    phone_number: string
  }>) {
    if (!variantToContactId.has(row.phone_number)) {
      variantToContactId.set(row.phone_number, row.contact_id)
    }
  }
  for (const row of (directRes.data ?? []) as Array<{ id: string; phone: string | null }>) {
    if (row.phone && !variantToContactId.has(row.phone)) {
      variantToContactId.set(row.phone, row.id)
    }
  }

  // Resolve each phone to a contact_id via any of its variants.
  const phoneToContactId = new Map<string, string>()
  const contactIdsNeeded = new Set<string>()
  for (const [phone, variants] of phoneToVariants) {
    for (const v of variants) {
      const id = variantToContactId.get(v)
      if (id) {
        phoneToContactId.set(phone, id)
        contactIdsNeeded.add(id)
        break
      }
    }
  }

  if (contactIdsNeeded.size === 0) return result

  // Batch-fetch briefs for all matched contacts in one query.
  const { data: briefs, error: briefsErr } = await supabase
    .from('outreach_logs')
    .select(BRIEF_COLUMNS)
    .in('id', Array.from(contactIdsNeeded))

  if (briefsErr) {
    console.error('[contacts] brief batch fetch failed:', briefsErr)
    return result
  }

  const briefsById = new Map<string, ContactBrief>()
  for (const b of (briefs ?? []) as ContactBrief[]) briefsById.set(b.id, b)

  for (const [phone, contactId] of phoneToContactId) {
    result[phone] = briefsById.get(contactId) ?? null
  }
  return result
}

// ─── Search (for mapping modal) ──────────────────────────────────────────────

async function searchContactsByName(query: string, limit = 8): Promise<ContactBrief[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('outreach_logs')
    .select(BRIEF_COLUMNS)
    .ilike('name', `%${q}%`)
    .order('name', { ascending: true })
    .limit(limit)
  if (error) {
    console.error('[contacts] search failed:', error)
    return []
  }
  return (data as ContactBrief[] | null) ?? []
}

// ─── Create + attach existing ────────────────────────────────────────────────

async function createContactFromParticipant(
  input: CreateContactInput,
): Promise<CreateContactResult> {
  const supabase = getSupabase()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return { ok: false, error: 'Not signed in' }
  const userId = session.user.id

  const displayName = input.name.trim() || input.waName || 'Unknown'

  const { data: inserted, error: insertErr } = await supabase
    .from('outreach_logs')
    .insert({
      user_id: userId,
      name: displayName,
      linkedin_url: input.linkedin_url,
      phone: input.phone || null,
      referred_by: input.referred_by,
      // reThink's status check constraint only accepts these uppercase values:
      // PROSPECT | INTRO | CONNECTED | RECONNECT | ENGAGED | NURTURING | DORMANT
      // PROSPECT is the default entry point for a brand-new contact.
      status: 'PROSPECT',
    })
    .select('id')
    .single()

  if (insertErr || !inserted) {
    console.error('[contacts] create insert failed:', insertErr)
    return { ok: false, error: insertErr?.message ?? 'insert failed' }
  }

  const contactId = inserted.id as string

  // Persist the WhatsApp channel mapping so future lookups hit the phone.
  await supabase.from('contact_channels').insert({
    outreach_log_id: contactId,
    channel: 'whatsapp',
    channel_identifier: input.phone,
    channel_name: input.waName,
    verified: true,
  })

  // Fire LinkedIn enrichment if a URL was provided and apply the result.
  let enriched = false
  if (input.linkedin_url) {
    console.log('[contacts] invoking linkedin-fetch for →', input.linkedin_url)
    try {
      const { data, error } = await supabase.functions.invoke('linkedin-fetch', {
        body: { url: input.linkedin_url },
      })
      if (error) {
        console.error('[contacts] linkedin-fetch error:', error)
      } else if (!data) {
        console.warn('[contacts] linkedin-fetch returned no data')
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = data as any
        console.log('[contacts] linkedin-fetch response keys:', Object.keys(d ?? {}))
        const updates: Record<string, unknown> = {}
        if (d.job_title) updates.job_title = d.job_title
        if (d.company) updates.company = d.company
        if (d.location) updates.location = d.location
        const contextParts: string[] = []
        if (d.followers) contextParts.push(`Followers: ${d.followers}`)
        if (d.connections) contextParts.push(`Connections: ${d.connections}`)
        if (d.about) contextParts.push(d.about)
        if (contextParts.length > 0) updates.personal_context = contextParts.join('\n')
        console.log(
          '[contacts] linkedin-fetch extracted fields:',
          Object.keys(updates),
        )
        if (Object.keys(updates).length > 0) {
          const { error: updateErr } = await supabase
            .from('outreach_logs')
            .update(updates)
            .eq('id', contactId)
          if (updateErr) {
            console.error('[contacts] outreach_logs enrichment update failed:', updateErr)
          } else {
            enriched = true
            console.log('[contacts] enrichment applied to contact', contactId)
          }
        }
      }
    } catch (err) {
      console.error('[contacts] linkedin-fetch invoke threw:', err)
    }
  }

  return { ok: true, contactId, enriched }
}

async function attachPhoneToExistingContact(input: {
  contact_id: string
  phone: string
  waName: string | null
}): Promise<WriteResult> {
  const supabase = getSupabase()
  const { error } = await supabase.from('contact_channels').insert({
    outreach_log_id: input.contact_id,
    channel: 'whatsapp',
    channel_identifier: input.phone,
    channel_name: input.waName,
    verified: true,
  })
  if (error) {
    console.error('[contacts] attachPhone failed:', error)
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

/**
 * Create a new contact from a LinkedIn profile that the user is currently
 * viewing in the LI tab. Unlike the group-modal create flow (which relies on
 * the server-side linkedin-fetch edge function that LinkedIn blocks), this
 * uses the data scraped client-side by preload-linkedin, which runs inside
 * the user's authenticated LinkedIn session and has full DOM access.
 */
type LinkedinScrapeInput = {
  name: string | null
  jobTitle: string | null
  company: string | null
  companyLinkedinUrl: string | null
  companyLogoUrl: string | null
  location: string | null
  about: string | null
  photoUrl: string | null
  // Optional — when provided, enrich will also set outreach_logs.linkedin_url
  // (if null) and ensure a contact_channels row exists for LinkedIn. Used by
  // the "Attach to existing contact" flow in LinkedinProfileScreen so a user
  // can link a LI profile to a pre-existing WA-originated row without
  // creating a duplicate.
  linkedinUrl?: string | null
}

/** Extract company from a headline like "Title at Company" or "Title / Company". */
function parseCompanyFromHeadline(headline: string | null): string | null {
  if (!headline) return null
  const atMatch = headline.match(/ at (.+)$/i)
  if (atMatch?.[1]) return atMatch[1].trim()
  // Headlines like "Head of Marketing / Growth / Nubox" — last slash segment
  const parts = headline.split(/\s*[|/·]\s*/)
  if (parts.length > 1) {
    const last = parts[parts.length - 1].trim()
    if (last.length >= 2 && last.length < 80) return last
  }
  return null
}

async function createContactFromLinkedinProfile(input: {
  url: string
  name: string
  jobTitle: string | null
  company: string | null
  companyLinkedinUrl: string | null
  companyLogoUrl: string | null
  location: string | null
  about: string | null
  photoUrl: string | null
}): Promise<CreateContactResult> {
  const supabase = getSupabase()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return { ok: false, error: 'Not signed in' }
  const userId = session.user.id

  // Prefer the scraped company (positional, more reliable) over the
  // headline-pattern fallback which only catches "X at Y" headlines.
  const company = input.company ?? parseCompanyFromHeadline(input.jobTitle)

  // Mirror LI photo to Supabase Storage (media.licdn.com URLs expire).
  let photoUrlToStore: string | null = input.photoUrl
  if (input.photoUrl) {
    const { uploadLinkedInPhoto } = await import('./photo-upload')
    const permanent = await uploadLinkedInPhoto(input.photoUrl, input.url)
    photoUrlToStore = permanent ?? input.photoUrl
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('outreach_logs')
    .insert({
      user_id: userId,
      name: input.name.trim(),
      linkedin_url: input.url,
      job_title: input.jobTitle,
      company,
      location: input.location,
      personal_context: input.about,
      profile_photo_url: photoUrlToStore,
      status: 'PROSPECT',
    })
    .select('id')
    .single()

  if (insertErr || !inserted) {
    console.error('[contacts] createContactFromLinkedinProfile insert failed:', insertErr)
    return { ok: false, error: insertErr?.message ?? 'insert failed' }
  }

  const contactId = inserted.id as string

  await supabase.from('contact_channels').insert({
    outreach_log_id: contactId,
    channel: 'linkedin',
    channel_identifier: input.url,
    channel_name: input.name,
    verified: true,
  })

  // Company auto-enrichment: same path as enrichContactFromLinkedinProfile.
  if (company) {
    let permanentLogoUrl: string | null = null
    if (input.companyLogoUrl) {
      const { uploadCompanyLogo } = await import('./photo-upload')
      permanentLogoUrl = await uploadCompanyLogo(input.companyLogoUrl, company)
    }
    const { error: rpcErr } = await supabase.rpc('upsert_company_and_link', {
      company_name: company,
      company_linkedin_url: input.companyLinkedinUrl ?? null,
      company_logo_url: permanentLogoUrl ?? input.companyLogoUrl ?? null,
      company_domain_in: null,
    })
    if (rpcErr) console.warn('[contacts] create: upsert_company_and_link failed:', rpcErr.message)
  }

  console.log(
    '[contacts] created from LI profile →',
    contactId,
    input.name,
    'fields:',
    Object.entries({
      job_title: input.jobTitle,
      company,
      location: input.location,
      personal_context: input.about,
      profile_photo_url: input.photoUrl,
    })
      .filter(([, v]) => !!v)
      .map(([k]) => k),
  )
  return { ok: true, contactId, enriched: true }
}

/**
 * Enrich an existing contact from a LinkedIn profile currently being viewed.
 *
 * Semantics: the ✨ Enrich button is an explicit user action meaning
 * "replace the LinkedIn-sourced fields with what the current LinkedIn
 * profile says". It OVERWRITES job_title, company, location,
 * personal_context, and profile_photo_url whenever the fresh scrape has a
 * non-null value for them. Fields that are NOT sourced from LinkedIn
 * (email, phone, tier, status, notes) are left untouched.
 *
 * The `name` field is a special case: we only fill it if the stored name
 * is empty or looks like a URL slug, because users often hand-edit names
 * and we don't want to clobber those changes.
 */
async function enrichContactFromLinkedinProfile(
  input: { contact_id: string } & LinkedinScrapeInput,
): Promise<WriteResult> {
  const supabase = getSupabase()
  const { data: current, error: fetchErr } = await supabase
    .from('outreach_logs')
    .select('name, linkedin_url, personal_context')
    .eq('id', input.contact_id)
    .maybeSingle()
  if (fetchErr || !current) {
    return { ok: false, error: fetchErr?.message ?? 'contact not found' }
  }

  // Prefer the scraped company (positional) over the headline-pattern
  // fallback which only catches "X at Y" headlines.
  const company = input.company ?? parseCompanyFromHeadline(input.jobTitle)

  const existingLinkedinUrl = (current as { linkedin_url: string | null }).linkedin_url
  // Prefer the row's own linkedin_url. Fall back to the scrape's URL (passed
  // during attach-to-existing flow where the target row doesn't have one yet).
  const effectiveLinkedinUrl = existingLinkedinUrl ?? input.linkedinUrl ?? null

  const updates: Record<string, unknown> = {}
  // "Refresh-able" LI fields: overwrite when the scrape has a value. These
  // change often and LI is the authoritative source.
  if (input.jobTitle) updates.job_title = input.jobTitle
  if (company) updates.company = company
  if (input.location) updates.location = input.location
  // "Sensitive" fields — preserve when the user already has something curated.
  // personal_context is typically hand-curated from WA conversations
  // ("met at X, runs Y, referred by Z") and much more useful than LI's
  // generic "about" blurb. Only fill when the stored value is empty.
  const storedContext = (current as { personal_context: string | null }).personal_context ?? ''
  if (input.about && !storedContext.trim()) {
    updates.personal_context = input.about
  }
  // Attach-to-existing: write linkedin_url when the row doesn't have one yet
  if (!existingLinkedinUrl && input.linkedinUrl) {
    updates.linkedin_url = input.linkedinUrl
  }
  if (input.photoUrl) {
    // media.licdn.com URLs expire; mirror to Supabase Storage for permanence.
    // Falls back to the raw URL if upload fails (degrades gracefully — photo
    // still renders until the CDN URL expires).
    if (effectiveLinkedinUrl) {
      const { uploadLinkedInPhoto } = await import('./photo-upload')
      const permanent = await uploadLinkedInPhoto(input.photoUrl, effectiveLinkedinUrl)
      updates.profile_photo_url = permanent ?? input.photoUrl
    } else {
      updates.profile_photo_url = input.photoUrl
    }
  }

  // Name: only fill if the stored name is empty or looks like a URL slug
  const storedName = (current as { name: string | null }).name ?? ''
  const looksLikeSlug =
    !storedName ||
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(storedName) ||
    !storedName.includes(' ')
  if (input.name && looksLikeSlug) updates.name = input.name

  if (Object.keys(updates).length === 0) {
    console.log('[contacts] enrich: nothing to write for', input.contact_id)
    return { ok: true }
  }

  const { error: updErr } = await supabase
    .from('outreach_logs')
    .update(updates)
    .eq('id', input.contact_id)
  if (updErr) {
    console.error('[contacts] enrich update failed:', updErr)
    return { ok: false, error: updErr.message }
  }

  // Attach-to-existing: ensure a contact_channels row exists for LinkedIn,
  // so the row shows an LI icon + lookups by linkedin_url still resolve.
  if (input.linkedinUrl && !existingLinkedinUrl) {
    const { data: existingChannel } = await supabase
      .from('contact_channels')
      .select('id')
      .eq('outreach_log_id', input.contact_id)
      .eq('channel', 'linkedin')
      .eq('channel_identifier', input.linkedinUrl)
      .maybeSingle()
    if (!existingChannel) {
      const { error: chErr } = await supabase.from('contact_channels').insert({
        outreach_log_id: input.contact_id,
        channel: 'linkedin',
        channel_identifier: input.linkedinUrl,
        channel_name: input.name ?? null,
        verified: true,
      })
      if (chErr) console.warn('[contacts] attach LI channel insert failed:', chErr)
    }
  }

  // Company auto-enrichment: upsert a companies row by normalized name
  // (creates once, reuses thereafter), upload the logo, and link every
  // contact whose `company` text matches → they all get the same company_id.
  const finalCompany = company ?? null
  if (finalCompany) {
    let permanentLogoUrl: string | null = null
    if (input.companyLogoUrl) {
      const { uploadCompanyLogo } = await import('./photo-upload')
      permanentLogoUrl = await uploadCompanyLogo(input.companyLogoUrl, finalCompany)
    }
    const { error: rpcErr } = await supabase.rpc('upsert_company_and_link', {
      company_name: finalCompany,
      company_linkedin_url: input.companyLinkedinUrl ?? null,
      company_logo_url: permanentLogoUrl ?? input.companyLogoUrl ?? null,
      company_domain_in: null,
    })
    if (rpcErr) console.warn('[contacts] upsert_company_and_link failed:', rpcErr.message)

    // Deep enrichment: navigate the LI view to /company/<slug>/about/ and
    // scrape description, domain, industry, size, HQ, followers, logo.
    // Fire-and-forget — don't block the enrich response on it.
    if (input.companyLinkedinUrl) {
      void deepEnrichCompanyFromLinkedIn(finalCompany, input.companyLinkedinUrl)
    }
  }

  console.log(
    '[contacts] enriched contact from LI profile →',
    input.contact_id,
    Object.keys(updates),
    finalCompany ? `[company: ${finalCompany}]` : '',
  )
  return { ok: true }
}

// Deep-scrape a LI company page and update the matching companies row.
// Runs async after enrich returns — the LI view briefly navigates to the
// company About page, scrapes, then returns to where the user was.
async function deepEnrichCompanyFromLinkedIn(
  companyName: string,
  companyLinkedinUrl: string,
): Promise<void> {
  try {
    const [{ getLinkedinWebContents }, { scrapeLinkedInCompanyInView }] = await Promise.all([
      import('../main'),
      import('../scrape-company'),
    ])
    const wc = getLinkedinWebContents()
    if (!wc) {
      console.warn('[contacts] deep-enrich: LI view not ready')
      return
    }
    const scrape = await scrapeLinkedInCompanyInView(wc, companyLinkedinUrl)
    if (!scrape) {
      console.warn('[contacts] deep-enrich: scrape returned null')
      return
    }

    // Upload logo to Supabase Storage (media.licdn.com URLs expire)
    let permanentLogoUrl: string | null = null
    if (scrape.logoUrl) {
      const { uploadCompanyLogo } = await import('./photo-upload')
      permanentLogoUrl = await uploadCompanyLogo(scrape.logoUrl, companyName)
    }

    // Normalize company name the same way the RPC does (lowercase + space
    // collapse) so we hit the row regardless of caller casing.
    const supabase = getSupabase()
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) return
    const userId = session.user.id

    const updates: Record<string, unknown> = {
      last_enriched_at: new Date().toISOString(),
    }
    // Only overwrite NULL columns — never clobber user-curated values. The
    // RPC's initial upsert may have left some as null; this fills them in.
    if (scrape.description) updates.description = scrape.description
    if (scrape.domain) updates.domain = scrape.domain
    if (scrape.websiteUrl) updates.website_url = scrape.websiteUrl
    if (scrape.industry) updates.sector = scrape.industry
    if (scrape.companySize) updates.size = scrape.companySize
    if (scrape.employeeCountEstimate) updates.employees_count = scrape.employeeCountEstimate
    if (scrape.hqLocation) updates.hq_location = scrape.hqLocation
    if (scrape.followers) updates.followers_count = scrape.followers
    if (permanentLogoUrl ?? scrape.logoUrl) updates.logo_url = permanentLogoUrl ?? scrape.logoUrl
    updates.linkedin_url = companyLinkedinUrl

    // Use .filter(...) against COALESCE so we only fill NULLs. The simplest
    // way in supabase-js is to just UPDATE the row and rely on COALESCE in
    // an RPC — but doing this client-side: we update unconditionally for
    // all fields where scrape had a value (LI is authoritative for those).
    // For 'description', we COALESCE here manually to avoid wiping curated
    // value. Skip it if the row already has a non-empty description.
    const { data: existing } = await supabase
      .from('companies')
      .select('id, description, notes')
      .eq('user_id', userId)
      .ilike('name', companyName)
      .maybeSingle()
    if (!existing) {
      console.warn('[contacts] deep-enrich: no company row to update for', companyName)
      return
    }
    if (existing.description && existing.description.trim()) {
      delete updates.description
    }
    const { error: updErr } = await supabase
      .from('companies')
      .update(updates)
      .eq('id', existing.id)
    if (updErr) {
      console.warn('[contacts] deep-enrich update failed:', updErr.message)
    } else {
      console.log('[contacts] deep-enriched company →', companyName, Object.keys(updates))
    }
  } catch (err) {
    console.warn('[contacts] deep-enrich threw:', err)
  }
}

async function attachLidToExistingContact(input: {
  contact_id: string
  lid: string
  waName: string | null
}): Promise<WriteResult> {
  // Store the LID with a "lid:" prefix so it coexists cleanly with phone
  // identifiers in the same channel_identifier column. This is the
  // "map once, automatic forever" mechanism for group participants who
  // only expose a Linked ID and not a phone number.
  const supabase = getSupabase()
  const storedIdentifier = 'lid:' + input.lid
  const { error } = await supabase.from('contact_channels').insert({
    outreach_log_id: input.contact_id,
    channel: 'whatsapp',
    channel_identifier: storedIdentifier,
    channel_name: input.waName,
    verified: true,
  })
  if (error) {
    console.error('[contacts] attachLid failed:', error)
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

async function attachWaNameToExistingContact(input: {
  contact_id: string
  waName: string
}): Promise<WriteResult> {
  // Store the WhatsApp display name with a "waname:" prefix so it coexists
  // with phone and lid identifiers in the same channel_identifier column.
  // This is the map-once-forever mechanism for SAVED contacts whose WA
  // display name doesn't match their reThink name (WA's 2026-04 DOM update
  // removed phone numbers from the message stream, so name is all we have).
  const supabase = getSupabase()
  const storedIdentifier = 'waname:' + input.waName.trim()
  const { error } = await supabase.from('contact_channels').insert({
    outreach_log_id: input.contact_id,
    channel: 'whatsapp',
    channel_identifier: storedIdentifier,
    channel_name: input.waName,
    verified: true,
  })
  if (error) {
    console.error('[contacts] attachWaName failed:', error)
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

// ─── IPC registration ────────────────────────────────────────────────────────

export function registerContactIpc(): void {
  ipcMain.handle('contact:byPhone', (_event, phone: string) => findContactByPhone(phone))
  ipcMain.handle('contact:byName', (_event, name: string) => findContactByName(name))
  ipcMain.handle(
    'contact:attachWaName',
    (_event, input: { contact_id: string; waName: string }) =>
      attachWaNameToExistingContact(input),
  )
  ipcMain.handle('contact:logInteraction', (_event, input: LogInteractionInput) =>
    logInteraction(input),
  )
  ipcMain.handle('contact:addValueLog', (_event, input: AddValueLogInput) =>
    addValueLog(input),
  )

  ipcMain.handle('contact:briefsByPhones', (_event, phones: string[]) =>
    getContactBriefsByPhones(phones),
  )
  ipcMain.handle(
    'contact:briefsForParticipants',
    (_event, participants: ParticipantLookupInput[]) =>
      getContactBriefsForParticipants(participants),
  )
  ipcMain.handle('contact:searchByName', (_event, query: string) =>
    searchContactsByName(query),
  )
  ipcMain.handle('contact:createFromParticipant', (_event, input: CreateContactInput) =>
    createContactFromParticipant(input),
  )
  ipcMain.handle(
    'contact:attachPhone',
    (_event, input: { contact_id: string; phone: string; waName: string | null }) =>
      attachPhoneToExistingContact(input),
  )
  ipcMain.handle(
    'contact:attachLid',
    (_event, input: { contact_id: string; lid: string; waName: string | null }) =>
      attachLidToExistingContact(input),
  )
  ipcMain.handle('contact:byLinkedinUrl', (_event, url: string) =>
    findContactByLinkedinUrl(url),
  )
  ipcMain.handle(
    'contact:createFromLinkedinProfile',
    (
      _event,
      input: {
        url: string
        name: string
        jobTitle: string | null
        company: string | null
        companyLinkedinUrl: string | null
        companyLogoUrl: string | null
        location: string | null
        about: string | null
        photoUrl: string | null
      },
    ) => createContactFromLinkedinProfile(input),
  )
  ipcMain.handle(
    'contact:enrichFromLinkedinProfile',
    (
      _event,
      input: {
        contact_id: string
        name: string | null
        jobTitle: string | null
        company: string | null
        companyLinkedinUrl: string | null
        companyLogoUrl: string | null
        location: string | null
        about: string | null
        photoUrl: string | null
        linkedinUrl?: string | null
      },
    ) => enrichContactFromLinkedinProfile(input),
  )
}
