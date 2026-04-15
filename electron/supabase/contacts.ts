// Contact lookup and write actions for the sidebar.
// Reads: outreach_logs + interactions + value_logs + opportunities (via opportunity_contacts).
// Writes: insert interactions and value_logs.

import { ipcMain } from 'electron'
import { getSupabase } from './client'
import { phoneVariants } from '../utils/phone'

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

async function findContactByPhone(phone: string): Promise<ContactDetail | null> {
  const supabase = getSupabase()
  const contactId = await resolveContactIdByPhone(phone)
  if (!contactId) return null

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

// ─── IPC registration ────────────────────────────────────────────────────────

export function registerContactIpc(): void {
  ipcMain.handle('contact:byPhone', (_event, phone: string) => findContactByPhone(phone))
  ipcMain.handle('contact:logInteraction', (_event, input: LogInteractionInput) =>
    logInteraction(input),
  )
  ipcMain.handle('contact:addValueLog', (_event, input: AddValueLogInput) =>
    addValueLog(input),
  )
}
