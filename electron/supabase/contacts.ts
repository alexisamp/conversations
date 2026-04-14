// Contact lookup by normalized phone number.
// Reads contact_phone_mappings → outreach_logs → interactions (recent).
// No writes in Phase 1.

import { ipcMain } from 'electron'
import { getSupabase } from './client'

export type InteractionSummary = {
  id: string
  type: string
  direction: string | null
  interaction_date: string
  notes: string | null
}

export type ContactDetail = {
  id: string
  name: string
  company: string | null
  phone: string | null
  status: string | null
  health_score: number | null
  last_interaction_at: string | null
  recent_interactions: InteractionSummary[]
}

async function findContactByPhone(phone: string): Promise<ContactDetail | null> {
  const supabase = getSupabase()
  const normalized = phone.trim()
  if (!normalized) return null

  // Step 1: phone mapping → contact_id
  const { data: mapping, error: mappingErr } = await supabase
    .from('contact_phone_mappings')
    .select('contact_id')
    .eq('phone_number', normalized)
    .maybeSingle()

  if (mappingErr) {
    console.error('[contacts] mapping lookup failed:', mappingErr)
    return null
  }
  if (!mapping) return null

  // Step 2: outreach_logs row
  const { data: contact, error: contactErr } = await supabase
    .from('outreach_logs')
    .select('id, name, company, phone, status, health_score, last_interaction_at')
    .eq('id', mapping.contact_id)
    .maybeSingle()

  if (contactErr || !contact) {
    console.error('[contacts] outreach_logs lookup failed:', contactErr)
    return null
  }

  // Step 3: recent interactions
  const { data: interactions, error: interactionsErr } = await supabase
    .from('interactions')
    .select('id, type, direction, interaction_date, notes')
    .eq('contact_id', contact.id)
    .order('interaction_date', { ascending: false })
    .limit(10)

  if (interactionsErr) {
    console.error('[contacts] interactions lookup failed:', interactionsErr)
  }

  return {
    id: contact.id,
    name: contact.name,
    company: contact.company ?? null,
    phone: contact.phone ?? null,
    status: contact.status ?? null,
    health_score: contact.health_score ?? null,
    last_interaction_at: contact.last_interaction_at ?? null,
    recent_interactions: (interactions as InteractionSummary[] | null) ?? [],
  }
}

export function registerContactIpc(): void {
  ipcMain.handle('contact:byPhone', (_event, phone: string) =>
    findContactByPhone(phone),
  )
}
