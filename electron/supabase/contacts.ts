// Contact lookup and write actions for the sidebar.
// Reads: outreach_logs + interactions + value_logs + opportunities (via opportunity_contacts).
// Writes: insert interactions and value_logs.

import { ipcMain } from 'electron'
import { getSupabase } from './client'
import { phoneVariants } from '../utils/phone'
import { linkedinUrlVariants } from '../utils/linkedin'

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
  if (variants.length === 0) return null

  // Source 1: contact_channels (unified)
  try {
    const { data } = await supabase
      .from('contact_channels')
      .select('outreach_log_id')
      .eq('channel', 'linkedin')
      .in('channel_identifier', variants)
      .limit(1)
      .maybeSingle()
    if (data) {
      console.log('[contacts] LI match via contact_channels →', url)
      return data.outreach_log_id as string
    }
  } catch (err) {
    console.warn('[contacts] contact_channels LI query failed:', err)
  }

  // Source 2: direct outreach_logs.linkedin_url
  {
    const { data } = await supabase
      .from('outreach_logs')
      .select('id')
      .in('linkedin_url', variants)
      .limit(1)
      .maybeSingle()
    if (data) {
      console.log('[contacts] LI match via outreach_logs.linkedin_url →', url)
      return data.id as string
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
      phone: input.phone,
      status: 'new',
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
    try {
      const { data, error } = await supabase.functions.invoke('linkedin-fetch', {
        body: { url: input.linkedin_url },
      })
      if (!error && data) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = data as any
        const updates: Record<string, unknown> = {}
        if (d.job_title) updates.job_title = d.job_title
        if (d.company) updates.company = d.company
        if (d.location) updates.location = d.location
        const contextParts: string[] = []
        if (d.followers) contextParts.push(`Followers: ${d.followers}`)
        if (d.connections) contextParts.push(`Connections: ${d.connections}`)
        if (d.about) contextParts.push(d.about)
        if (contextParts.length > 0) updates.personal_context = contextParts.join('\n')
        if (Object.keys(updates).length > 0) {
          await supabase.from('outreach_logs').update(updates).eq('id', contactId)
          enriched = true
        }
      }
    } catch (err) {
      console.warn('[contacts] linkedin-fetch invoke failed:', err)
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

// ─── IPC registration ────────────────────────────────────────────────────────

export function registerContactIpc(): void {
  ipcMain.handle('contact:byPhone', (_event, phone: string) => findContactByPhone(phone))
  ipcMain.handle('contact:logInteraction', (_event, input: LogInteractionInput) =>
    logInteraction(input),
  )
  ipcMain.handle('contact:addValueLog', (_event, input: AddValueLogInput) =>
    addValueLog(input),
  )

  ipcMain.handle('contact:briefsByPhones', (_event, phones: string[]) =>
    getContactBriefsByPhones(phones),
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
  ipcMain.handle('contact:byLinkedinUrl', (_event, url: string) =>
    findContactByLinkedinUrl(url),
  )
}
