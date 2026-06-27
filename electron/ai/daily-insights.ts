import {
  bridgeMessagesForChat,
  bridgeMessagesForAllLocal,
  bridgeMessagesForRange,
  bridgeMessagesForStructuredRepair,
  addAiFeedback,
  createDailyAiRun,
  finishDailyAiRun,
  getAiOutput,
  getDb,
  latestAiRunOutputs,
  latestAiStagedOutputs,
  linkedinConversation,
  linkedinMessagesForAllLocal,
  linkedinMessagesForInsightRange,
  linkedinProfileByUrn,
  latestDailyAiRuns,
  markBridgeMessagesSynced,
  markLinkedinMessagesSynced,
  pendingAiStagedOutputs,
  pruneSyncedBridgeMessages,
  recordAiOutput,
  recordAiRunOutput,
  recentAiFeedback,
  stageAiOutput,
  updateAiStagedOutput,
  updateAiStagedOutputsStatus,
  getAiStagedOutput,
  type AiRunOutputRow,
  type AiStagedOutputRow,
  type BridgeMessageRow,
  type DailyAiRunRow,
  type LinkedinMessageRow,
} from '../db/local'
import { getSupabase } from '../supabase/client'
import { extractWhatsappInsights, type WhatsappInsightExtraction } from './gemini'
import type { WhatsappBridge } from '../whatsapp/bridge'

const TZ = 'America/New_York'
const WINDOW_MS = 6 * 60 * 60 * 1000
const STARTUP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

type ResolveContact = (input: {
  chatId: string
  phone: string | null
  waName: string | null
}) => Promise<string | null>

type ResolveLinkedinContact = (input: {
  conversationId: string
  linkedinUrl: string | null
  name: string | null
}) => Promise<string | null>

type DailyInsightRunnerOptions = {
  bridge: WhatsappBridge
  resolveContact: ResolveContact
  resolveLinkedinContact?: ResolveLinkedinContact
  publishStatus: () => void
}

type Window = {
  chatId: string
  chatName: string | null
  phone: string | null
  messages: BridgeMessageRow[]
}

type LinkedinWindow = {
  conversationId: string
  title: string
  linkedinUrl: string | null
  messages: LinkedinMessageRow[]
}

export type InsightRunResult = {
  runId: number
  messagesSeen: number
  conversationsProcessed: number
  outputsWritten: number
  interactionsWritten?: number
  contactFactsWritten?: number
  valueLogsWritten?: number
  todosWritten?: number
  reviewItemsWritten?: number
}

type OutputCounters = {
  interactions_written: number
  contact_facts_written: number
  value_logs_written: number
  todos_written: number
  review_items_written: number
}

export type InsightOutputAuditRow = AiRunOutputRow

function emptyCounters(): OutputCounters {
  return {
    interactions_written: 0,
    contact_facts_written: 0,
    value_logs_written: 0,
    todos_written: 0,
    review_items_written: 0,
  }
}

function localDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms))
}

function formatIssueTimestamp(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms))
}

function phoneFromChatId(chatId: string): string | null {
  const user = chatId.split('@')[0] || ''
  return /^\d{7,16}$/.test(user) ? `+${user}` : null
}

function scheduledLabel(ms = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(ms))
}

function normalizeForKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, ' ')
    .trim()
}

function factSemanticKey(contactId: string | null, category: string | null, value: string): string | null {
  if (!contactId) return null
  const text = normalizeForKey(value)
  if (!text) return null

  if (/\b(hijo|hija|nino|nina|bebe)\b/.test(text)) {
    const nameMatch = text.match(/\b(?:llamad[oa]?|nombre|se llama)\s+([a-z]{2,})\b/)
    return `${contactId}|family|child|${nameMatch?.[1] ?? 'exists'}`
  }
  if (/\b(espos[ao]|pareja|marid[ao])\b/.test(text)) return `${contactId}|family|partner`
  if (/\b(boston)\b/.test(text)) return `${contactId}|location|boston`
  if (/\b(chile)\b/.test(text)) return `${contactId}|location|chile`
  if (/\b(usa|estados unidos|united states)\b/.test(text)) return `${contactId}|location|usa`
  if (/\b(busca trabajo|buscando empleo|busqueda laboral|networking|pipeline)\b/.test(text)) return `${contactId}|career|job-search`
  if (/\b(salario|compensacion|sueldo|bonus|bono|\$)\b/.test(text)) return `${contactId}|compensation|${text.slice(0, 90)}`
  if (/\b(chocolate)\b/.test(text)) return `${contactId}|preference|chocolate`
  if (/\b(prefiere|le gusta|ama|apasiona|odia|no le gusta)\b/.test(text)) return `${contactId}|preference|${text.slice(0, 80)}`

  const compact = text
    .split(' ')
    .filter((token) => token.length > 2 && !['tiene', 'esta', 'para', 'como', 'que', 'con', 'una', 'uno', 'del', 'por'].includes(token))
    .slice(0, 10)
    .join('-')
  return `${contactId}|${category ?? 'other'}|${compact}`
}

function inferKeyDateEvent(text: string): string | null {
  if (/\b(cumpleanos|birthday|nacio|nacimiento)\b/.test(text)) return 'birthday'
  if (/\b(aniversario|anniversary)\b/.test(text)) return 'anniversary'
  if (/\b(vuelve|regresa)\b/.test(text)) return 'return'
  if (/\b(viaje|vacaciones|sale de viaje|partida)\b/.test(text)) return 'travel'
  if (/\b(mudanza|se muda|se mudo)\b/.test(text)) return 'move'
  return null
}

function keyDateSemanticKey(input: {
  contactId: string | null
  title?: string | null
  category?: string | null
  eventType?: string | null
  subject?: string | null
  relation?: string | null
  value?: string | null
}): string | null {
  if (!input.contactId) return null
  const text = normalizeForKey(`${input.eventType ?? ''} ${input.subject ?? ''} ${input.relation ?? ''} ${input.value ?? ''}`)
  const eventType = normalizeForKey(input.eventType ?? '') || inferKeyDateEvent(text)
  if (input.category !== 'key_date' && !eventType) return null

  const title = normalizeForKey(input.title ?? '')
  const subject = normalizeForKey(input.subject ?? '')
  const titleFirst = title.split(' ')[0] ?? ''
  const subjectKey = !subject || (title && (title.includes(subject) || subject.includes(titleFirst)))
    ? 'primary'
    : subject
  return `${input.contactId}|key_date|${eventType ?? 'important_date'}|${input.relation ?? 'contact'}|${subjectKey}`
}

function aiFeedbackGuidance(): string | null {
  const rows = recentAiFeedback(20)
  if (rows.length === 0) return null
  return rows
    .map((row) => {
      const body = (row.body ?? '').replace(/\s+/g, ' ').slice(0, 180)
      const feedback = row.feedback.replace(/\s+/g, ' ').slice(0, 220)
      return `- ${row.decision.toUpperCase()} ${row.target}: "${body}" => ${feedback}`
    })
    .join('\n')
}

export function nextInsightRunAt(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const y = Number(parts.find((p) => p.type === 'year')?.value)
  const m = Number(parts.find((p) => p.type === 'month')?.value)
  const d = Number(parts.find((p) => p.type === 'day')?.value)

  // This app runs on the user's Mac. The user's current timezone is expected to
  // be America/New_York; these local constructors intentionally align with the
  // scheduled wall-clock times requested for the product.
  const five = new Date(y, m - 1, d, 5, 0, 0, 0)
  const noon = new Date(y, m - 1, d, 12, 0, 0, 0)
  if (now.getTime() < five.getTime()) return five.getTime()
  if (now.getTime() < noon.getTime()) return noon.getTime()
  return new Date(y, m - 1, d + 1, 5, 0, 0, 0).getTime()
}

function groupWindows(messages: BridgeMessageRow[]): Window[] {
  const byChat = new Map<string, BridgeMessageRow[]>()
  for (const message of messages) {
    const arr = byChat.get(message.chat_id) ?? []
    arr.push(message)
    byChat.set(message.chat_id, arr)
  }

  const windows: Window[] = []
  for (const [chatId, rows] of byChat) {
    const sorted = [...rows].sort((a, b) => a.timestamp_ms - b.timestamp_ms)
    let current: BridgeMessageRow[] = []
    let start = sorted[0]?.timestamp_ms ?? 0
    for (const row of sorted) {
      const crossesWindow = current.length > 0 && row.timestamp_ms - start > WINDOW_MS
      const crossesLocalDate = current.length > 0 && localDate(row.timestamp_ms) !== localDate(start)
      if (crossesWindow || crossesLocalDate) {
        windows.push({
          chatId,
          chatName: current[0]?.chat_name ?? null,
          phone: phoneFromChatId(chatId),
          messages: current,
        })
        current = [row]
        start = row.timestamp_ms
      } else {
        current.push(row)
      }
    }
    if (current.length > 0) {
      windows.push({
        chatId,
        chatName: current[0]?.chat_name ?? null,
        phone: phoneFromChatId(chatId),
        messages: current,
      })
    }
  }
  return windows
}

function parseStringList(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function groupLinkedinWindows(messages: LinkedinMessageRow[]): LinkedinWindow[] {
  const byConversation = new Map<string, LinkedinMessageRow[]>()
  for (const message of messages) {
    const arr = byConversation.get(message.conversation_id) ?? []
    arr.push(message)
    byConversation.set(message.conversation_id, arr)
  }

  const windows: LinkedinWindow[] = []
  for (const [conversationId, rows] of byConversation) {
    const conversation = linkedinConversation(conversationId)
    const urn = parseStringList(conversation?.participant_urns)[0] ?? null
    const profile = urn ? linkedinProfileByUrn(urn) : null
    const title = parseStringList(conversation?.participant_names)[0] || profile?.full_name || 'LinkedIn contact'
    const linkedinUrl = profile?.linkedin_url || (profile?.public_id ? `https://www.linkedin.com/in/${profile.public_id}` : null)
    const sorted = [...rows].sort((a, b) => a.created_at_ms - b.created_at_ms)
    let current: LinkedinMessageRow[] = []
    let start = sorted[0]?.created_at_ms ?? 0
    for (const row of sorted) {
      const crossesWindow = current.length > 0 && row.created_at_ms - start > WINDOW_MS
      const crossesLocalDate = current.length > 0 && localDate(row.created_at_ms) !== localDate(start)
      if (crossesWindow || crossesLocalDate) {
        windows.push({ conversationId, title, linkedinUrl, messages: current })
        current = [row]
        start = row.created_at_ms
      } else {
        current.push(row)
      }
    }
    if (current.length > 0) windows.push({ conversationId, title, linkedinUrl, messages: current })
  }
  return windows
}

function conversationText(messages: BridgeMessageRow[]): string {
  return messages
    .map((message) => {
      const speaker = message.direction === 'outbound' ? 'Yo' : message.chat_name || message.sender || 'Ellos'
      return `${speaker}: ${message.text || `[${message.media_type || 'media'}]`}`
    })
    .join('\n')
}

function linkedinConversationText(messages: LinkedinMessageRow[]): string {
  return messages
    .map((message) => {
      const speaker = message.is_from_me ? 'Yo' : message.sender_name || 'Ellos'
      return `${speaker}: ${message.body || '[media]'}`
    })
    .join('\n')
}

function dominantDirection(messages: BridgeMessageRow[]): 'inbound' | 'outbound' {
  const outbound = messages.filter((message) => message.direction === 'outbound').length
  return outbound >= messages.length - outbound ? 'outbound' : 'inbound'
}

function dominantLinkedinDirection(messages: LinkedinMessageRow[]): 'inbound' | 'outbound' {
  const outbound = messages.filter((message) => message.is_from_me).length
  return outbound >= messages.length - outbound ? 'outbound' : 'inbound'
}

function sourceKey(win: Window): string {
  const first = win.messages[0]
  const last = win.messages[win.messages.length - 1]
  return `wa-bridge:${win.chatId}:${first.timestamp_ms}:${last.timestamp_ms}`
}

function linkedinSourceKey(win: LinkedinWindow): string {
  const first = win.messages[0]
  const last = win.messages[win.messages.length - 1]
  return `linkedin:${win.conversationId}:${first.created_at_ms}:${last.created_at_ms}`
}

function compactName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function sameLooseName(a: unknown, b: unknown): boolean {
  const left = compactName(a)
  const right = compactName(b)
  if (!left || !right) return false
  return normalizeForKey(left) === normalizeForKey(right)
}

function hasIntroductionColumns(payload: Record<string, unknown>): boolean {
  if (payload.type !== 'introduction' && payload.type !== 'referral') return false
  return Boolean(
    compactName(payload.connector_name) ||
    compactName(payload.introduced_person_name) ||
    compactName(payload.introduced_person_company) ||
    compactName(payload.introduced_to_name) ||
    compactName(payload.introduced_to_company) ||
    compactName(payload.relationship_context),
  )
}

function suggestionKeyPart(value: string): string {
  return normalizeForKey(value).replace(/\s+/g, '-').slice(0, 80) || 'item'
}

function contactFactTarget(fact: WhatsappInsightExtraction['contact_facts'][number]): 'contact_fact' | 'key_date' {
  return fact.category === 'key_date' ? 'key_date' : 'contact_fact'
}

function buildSuggestions(input: {
  sourceKey: string
  contactId: string
  channel: 'whatsapp' | 'linkedin'
  title: string
  interactionDate: string
  direction: 'inbound' | 'outbound'
  extraction: WhatsappInsightExtraction
}): Array<{
  source_external_id: string
  target: 'todo' | 'contact_fact' | 'key_date' | 'value_log' | 'intro' | 'next_step'
  title: string
  body: string
  payload: Record<string, unknown>
  confidence: 'low' | 'medium' | 'high'
}> {
  const rows: Array<{
    source_external_id: string
    target: 'todo' | 'contact_fact' | 'key_date' | 'value_log' | 'intro' | 'next_step'
    title: string
    body: string
    payload: Record<string, unknown>
    confidence: 'low' | 'medium' | 'high'
  }> = []

  if (input.extraction.next_step?.trim()) {
    rows.push({
      source_external_id: `${input.sourceKey}:next-step:${suggestionKeyPart(input.extraction.next_step)}`,
      target: 'next_step',
      title: `Next step for ${input.title}`,
      body: input.extraction.next_step,
      confidence: 'medium',
      payload: {
        contact_id: input.contactId,
        channel: input.channel,
        direction: input.direction,
        next_step: input.extraction.next_step,
        next_step_date: input.extraction.next_step_date,
        next_step_owner: input.extraction.next_step_owner,
        interaction_date: input.interactionDate,
      },
    })
  }

  input.extraction.contact_facts.slice(0, 8).forEach((fact, index) => {
    if (!fact.value?.trim()) return
    const target = contactFactTarget(fact)
    rows.push({
      source_external_id: `${input.sourceKey}:${target}:${index}:${suggestionKeyPart(fact.value)}`,
      target,
      title: `${target === 'key_date' ? 'Important date' : 'Contact fact'}: ${fact.label ?? fact.category}`,
      body: fact.value,
      confidence: fact.needs_review ? 'low' : 'medium',
      payload: {
        contact_id: input.contactId,
        channel: input.channel,
        category: fact.category,
        label: fact.label,
        value: fact.value,
        importance: fact.importance || 2,
        source: 'chat_capture',
        event_type: fact.event_type ?? null,
        subject: fact.subject ?? null,
        relation: fact.relation ?? null,
        date_value: fact.date_value ?? null,
        date_precision: fact.date_precision ?? null,
        description: fact.value,
        interaction_date: input.interactionDate,
      },
    })
  })

  input.extraction.value_logs.slice(0, 8).forEach((value, index) => {
    if (!value.description?.trim()) return
    const target = value.type === 'introduction' || value.type === 'referral' ? 'intro' : 'value_log'
    rows.push({
      source_external_id: `${input.sourceKey}:${target}:${index}:${suggestionKeyPart(value.description)}`,
      target,
      title: `${target === 'intro' ? 'Intro' : 'Value'}: ${input.title}`,
      body: value.description,
      confidence: value.confidence ?? 'medium',
      payload: {
        contact_id: input.contactId,
        outreach_log_id: input.contactId,
        source_contact_id: input.contactId,
        source_contact_name: input.title,
        channel: input.channel,
        type: value.type || 'other',
        description: value.description,
        direction: value.direction || 'given',
        date: input.interactionDate,
        introduced_person_name: value.introduced_person_name ?? null,
        introduced_person_company: value.introduced_person_company ?? null,
        introduced_to_name: value.introduced_to_name ?? null,
        introduced_to_company: value.introduced_to_company ?? null,
        connector_name: value.connector_name ?? null,
        relationship_context: value.relationship_context ?? null,
        introduction_status: value.introduction_status ?? null,
        confidence: value.confidence ?? null,
      },
    })
  })

  input.extraction.todos.slice(0, 8).forEach((todo, index) => {
    if (!todo.text?.trim()) return
    rows.push({
      source_external_id: `${input.sourceKey}:todo:${index}:${suggestionKeyPart(todo.text)}`,
      target: 'todo',
      title: `Todo: ${input.title}`,
      body: todo.text,
      confidence: 'medium',
      payload: {
        contact_id: input.contactId,
        channel: input.channel,
        text: todo.text,
        date: todo.date || input.interactionDate,
        interaction_date: input.interactionDate,
      },
    })
  })

  return rows
}

export class DailyInsightRunner {
  constructor(private readonly options: DailyInsightRunnerOptions) {}

  getLastRuns(limit = 5): DailyAiRunRow[] {
    return latestDailyAiRuns(limit)
  }

  getOutputAudit(limit = 250): InsightOutputAuditRow[] {
    return latestAiRunOutputs(limit)
  }

  getNextRunAt(): number {
    return nextInsightRunAt()
  }

  async runNow(reason = 'manual'): Promise<InsightRunResult> {
    await this.options.bridge.ensureStarted()
    this.options.bridge.importRecentMessages()

    const end = Date.now()
    const start = end - STARTUP_LOOKBACK_MS
    const whatsapp = await this.runRange(start, end, reason)
    const linkedin = await this.runLinkedinRange(start, end, reason)
    return {
      runId: linkedin.runId || whatsapp.runId,
      messagesSeen: whatsapp.messagesSeen + linkedin.messagesSeen,
      conversationsProcessed: whatsapp.conversationsProcessed + linkedin.conversationsProcessed,
      outputsWritten: whatsapp.outputsWritten + linkedin.outputsWritten,
      interactionsWritten: (whatsapp.interactionsWritten ?? 0) + (linkedin.interactionsWritten ?? 0),
      contactFactsWritten: (whatsapp.contactFactsWritten ?? 0) + (linkedin.contactFactsWritten ?? 0),
      valueLogsWritten: (whatsapp.valueLogsWritten ?? 0) + (linkedin.valueLogsWritten ?? 0),
      todosWritten: (whatsapp.todosWritten ?? 0) + (linkedin.todosWritten ?? 0),
      reviewItemsWritten: (whatsapp.reviewItemsWritten ?? 0) + (linkedin.reviewItemsWritten ?? 0),
    }
  }

  async runFullLocalBackfill(): Promise<InsightRunResult> {
    await this.options.bridge.ensureStarted()
    this.options.bridge.importRecentMessages()

    const whatsapp = await this.runMessages(
      bridgeMessagesForAllLocal(),
      'full-local-backfill',
      { rewriteMissingInteraction: true },
    )
    const linkedin = await this.runLinkedinMessages(
      linkedinMessagesForAllLocal(),
      'linkedin:full-local-backfill',
      { rewriteMissingInteraction: true },
    )
    return {
      runId: linkedin.runId || whatsapp.runId,
      messagesSeen: whatsapp.messagesSeen + linkedin.messagesSeen,
      conversationsProcessed: whatsapp.conversationsProcessed + linkedin.conversationsProcessed,
      outputsWritten: whatsapp.outputsWritten + linkedin.outputsWritten,
      interactionsWritten: (whatsapp.interactionsWritten ?? 0) + (linkedin.interactionsWritten ?? 0),
      contactFactsWritten: (whatsapp.contactFactsWritten ?? 0) + (linkedin.contactFactsWritten ?? 0),
      valueLogsWritten: (whatsapp.valueLogsWritten ?? 0) + (linkedin.valueLogsWritten ?? 0),
      todosWritten: (whatsapp.todosWritten ?? 0) + (linkedin.todosWritten ?? 0),
      reviewItemsWritten: (whatsapp.reviewItemsWritten ?? 0) + (linkedin.reviewItemsWritten ?? 0),
    }
  }

  async runChat(chatId: string): Promise<InsightRunResult> {
    this.options.bridge.importRecentMessages()
    const messages = bridgeMessagesForChat(chatId)
    return this.runMessages(messages, `identity:${chatId}`)
  }

  async repairStructuredOutputs(): Promise<InsightRunResult> {
    await this.options.bridge.ensureStarted()
    this.options.bridge.importRecentMessages()
    const end = Date.now()
    const start = end - STARTUP_LOOKBACK_MS
    const messages = bridgeMessagesForStructuredRepair(start, end)
    return this.runMessages(messages, 'structured-repair', { repairInteractionOnly: true })
  }

  getStagedOutputs(limit = 300): AiStagedOutputRow[] {
    return latestAiStagedOutputs(limit)
  }

  updateStagedOutput(id: number, body: string): AiStagedOutputRow | null {
    updateAiStagedOutput({ id, body })
    return getAiStagedOutput(id)
  }

  async approveStagedOutput(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const row = getAiStagedOutput(id)
    if (!row) return { ok: false, error: 'Staged output not found' }
    try {
      await this.syncStagedOutput(row)
      this.options.publishStatus()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      updateAiStagedOutput({ id, status: 'failed', error: message })
      this.options.publishStatus()
      return { ok: false, error: message }
    }
  }

  async approvePendingStagedOutputs(): Promise<{ ok: true; synced: number; failed: number }> {
    const rows = pendingAiStagedOutputs(500)
    let synced = 0
    let failed = 0
    for (const row of rows) {
      try {
        await this.syncStagedOutput(row)
        synced++
      } catch (err) {
        failed++
        const message = err instanceof Error ? err.message : String(err)
        updateAiStagedOutput({ id: row.id, status: 'failed', error: message })
      }
    }
    this.options.publishStatus()
    return { ok: true, synced, failed }
  }

  async approveStagedOutputs(ids: number[]): Promise<{ ok: true; synced: number; failed: number }> {
    let synced = 0
    let failed = 0
    for (const id of ids) {
      const row = getAiStagedOutput(id)
      if (!row || row.status === 'synced') continue
      try {
        await this.syncStagedOutput(row)
        synced++
      } catch (err) {
        failed++
        const message = err instanceof Error ? err.message : String(err)
        updateAiStagedOutput({ id, status: 'failed', error: message })
      }
    }
    this.options.publishStatus()
    return { ok: true, synced, failed }
  }

  rejectStagedOutputs(ids: number[]): { ok: true } {
    updateAiStagedOutputsStatus(ids, 'rejected')
    this.options.publishStatus()
    return { ok: true }
  }

  addFeedback(input: {
    id: number
    feedback: string
    decision: 'note' | 'reject'
  }): { ok: true } | { ok: false; error: string } {
    const row = getAiStagedOutput(input.id)
    if (!row) return { ok: false, error: 'Staged output not found' }
    const feedback = input.feedback.trim()
    if (!feedback) return { ok: false, error: 'Feedback is empty' }
    addAiFeedback({
      staged_output_id: row.id,
      target: row.target,
      contact_id: row.contact_id,
      title: row.title,
      body: row.body,
      feedback,
      decision: input.decision,
    })
    updateAiStagedOutputsStatus([row.id], 'rejected')
    this.options.publishStatus()
    return { ok: true }
  }

  private async runRange(startMs: number, endMs: number, reason: string): Promise<InsightRunResult> {
    const messages = bridgeMessagesForRange(startMs, endMs)
    return this.runMessages(messages, reason)
  }

  private async writeInteractionBundle(input: {
    sourceKey: string
    contactId: string
    title: string
    type: 'whatsapp' | 'linkedin_msg'
    channel: 'whatsapp' | 'linkedin'
    direction: 'inbound' | 'outbound'
    interactionDate: string
    windowStart: string
    windowEnd: string
    messageCount: number
    summary: string
    participants: Array<Record<string, unknown>>
    excerpts: Array<Record<string, unknown>>
    suggestions: ReturnType<typeof buildSuggestions>
  }): Promise<{ interactionId: string | null; suggestionsWritten: number }> {
    const supabase = getSupabase()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) throw new Error('not signed in')

    const interactionPayload = {
      user_id: user.id,
      contact_id: input.contactId,
      type: input.type,
      direction: input.direction,
      notes: input.summary,
      interaction_date: input.interactionDate,
      channel: input.channel,
      external_id: input.sourceKey,
    }

    const { data: existingInteraction, error: lookupError } = await supabase
      .from('interactions')
      .select('id')
      .eq('user_id', user.id)
      .eq('contact_id', input.contactId)
      .eq('external_id', input.sourceKey)
      .maybeSingle()
    if (lookupError) throw new Error(lookupError.message)

    const interactionWrite = existingInteraction?.id
      ? await supabase
        .from('interactions')
        .update(interactionPayload)
        .eq('id', existingInteraction.id)
        .eq('user_id', user.id)
        .select('id')
        .single()
      : await supabase
        .from('interactions')
        .insert(interactionPayload)
        .select('id')
        .single()
    const { data: interaction, error: interactionError } = interactionWrite
    if (interactionError) throw new Error(interactionError.message)

    const interactionId = (interaction?.id as string | undefined) ?? null
    if (!interactionId) throw new Error('interaction upsert returned no id')

    const { error: detailError } = await supabase
      .from('interaction_details')
      .upsert({
        user_id: user.id,
        interaction_id: interactionId,
        channel: input.channel,
        source_external_id: input.sourceKey,
        window_start: input.windowStart,
        window_end: input.windowEnd,
        message_count: input.messageCount,
        participants: input.participants,
        summary: input.summary,
        excerpts: input.excerpts,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,source_external_id' })
    if (detailError) throw new Error(detailError.message)

    if (input.suggestions.length > 0) {
      const rows = input.suggestions.map((suggestion) => ({
        user_id: user.id,
        interaction_id: interactionId,
        contact_id: input.contactId,
        source_external_id: suggestion.source_external_id,
        target: suggestion.target,
        title: suggestion.title,
        body: suggestion.body,
        payload: suggestion.payload,
        confidence: suggestion.confidence,
      }))
      const { error: suggestionsError } = await supabase
        .from('interaction_suggestions')
        .upsert(rows, { onConflict: 'user_id,source_external_id,target', ignoreDuplicates: true })
      if (suggestionsError) throw new Error(suggestionsError.message)
    }

    await supabase.from('outreach_logs')
      .update({
        last_interaction_at: input.windowStart,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.contactId)
      .eq('user_id', user.id)

    return { interactionId, suggestionsWritten: input.suggestions.length }
  }

  private async runLinkedinRange(startMs: number, endMs: number, reason: string): Promise<InsightRunResult> {
    const messages = linkedinMessagesForInsightRange(startMs, endMs)
    if (messages.length === 0) {
      return {
        runId: 0,
        messagesSeen: 0,
        conversationsProcessed: 0,
        outputsWritten: 0,
        interactionsWritten: 0,
        contactFactsWritten: 0,
        valueLogsWritten: 0,
        todosWritten: 0,
        reviewItemsWritten: 0,
      }
    }
    return this.runLinkedinMessages(messages, `linkedin:${reason}`)
  }

  private async runLinkedinMessages(
    messages: LinkedinMessageRow[],
    reason: string,
    options: { rewriteMissingInteraction?: boolean } = {},
  ): Promise<InsightRunResult> {
    const dateCovered = messages[0] ? localDate(messages[0].created_at_ms) : localDate(Date.now())
    const runId = createDailyAiRun({
      scheduled_for: reason === 'manual' ? 'manual' : scheduledLabel(),
      date_covered: dateCovered,
    })
    let conversationsProcessed = 0
    let outputsWritten = 0
    const counters = emptyCounters()
    try {
      const windows = groupLinkedinWindows(messages)
      for (const win of windows) {
        const contactId = this.options.resolveLinkedinContact
          ? await this.options.resolveLinkedinContact({
              conversationId: win.conversationId,
              linkedinUrl: win.linkedinUrl,
              name: win.title,
            })
          : null

        if (!contactId) {
          await this.createLinkedinIdentityReviewItem(win)
          this.openLinkedinIdentityIssue(win)
          continue
        }

        const key = linkedinSourceKey(win)
        const previousOutput = getAiOutput(key)
        if (previousOutput?.supabase_id || (previousOutput && !options.rewriteMissingInteraction)) {
          markLinkedinMessagesSynced(win.messages.map((message) => message.id), contactId)
          continue
        }

        const first = win.messages[0]
        const last = win.messages[win.messages.length - 1]
        const interactionDate = localDate(first.created_at_ms)
        const extraction = await extractWhatsappInsights({
          conversationText: linkedinConversationText(win.messages),
          interactionDate,
          contactName: win.title,
          feedbackGuidance: aiFeedbackGuidance(),
        })
        const payload = {
          contact_id: contactId,
          type: 'linkedin_msg',
          direction: dominantLinkedinDirection(win.messages),
          notes: extraction.summary,
          interaction_date: interactionDate,
          next_step: extraction.next_step,
          next_step_date: extraction.next_step_date,
          next_step_owner: extraction.next_step_owner,
          channel: 'linkedin',
          window_start: new Date(first.created_at_ms).toISOString(),
          window_end: new Date(last.created_at_ms).toISOString(),
          message_count: win.messages.length,
        }
        const suggestions = buildSuggestions({
          sourceKey: key,
          contactId,
          channel: 'linkedin',
          title: win.title,
          interactionDate,
          direction: payload.direction,
          extraction,
        })
        const written = await this.writeInteractionBundle({
          sourceKey: key,
          contactId,
          title: win.title,
          type: 'linkedin_msg',
          channel: 'linkedin',
          direction: payload.direction,
          interactionDate,
          windowStart: payload.window_start,
          windowEnd: payload.window_end,
          messageCount: win.messages.length,
          summary: extraction.summary,
          participants: [{ name: win.title, linkedin_url: win.linkedinUrl }],
          excerpts: win.messages.slice(-8).map((message) => ({
            timestamp: new Date(message.created_at_ms).toISOString(),
            speaker: message.is_from_me ? 'Me' : (message.sender_name || win.title),
            direction: message.is_from_me ? 'outbound' : 'inbound',
            text: (message.body || '[media]').replace(/\s+/g, ' ').slice(0, 500),
          })),
          suggestions,
        })
        outputsWritten += 1 + written.suggestionsWritten
        counters.interactions_written++
        counters.contact_facts_written += suggestions.filter((row) => row.target === 'contact_fact' || row.target === 'key_date').length
        counters.value_logs_written += suggestions.filter((row) => row.target === 'value_log' || row.target === 'intro').length
        counters.todos_written += suggestions.filter((row) => row.target === 'todo' || row.target === 'next_step').length
        recordAiRunOutput({
          run_id: runId,
          source_key: key,
          target: 'interaction',
          contact_id: contactId,
          supabase_id: written.interactionId,
          label: extraction.summary.slice(0, 160),
        })
        recordAiOutput(key, 'interaction', written.interactionId)
        markLinkedinMessagesSynced(win.messages.map((message) => message.id), contactId)
        conversationsProcessed++
      }
      finishDailyAiRun(runId, {
        status: 'succeeded',
        messages_seen: messages.length,
        conversations_processed: conversationsProcessed,
        outputs_written: outputsWritten,
        ...counters,
      })
      this.options.publishStatus()
      return {
        runId,
        messagesSeen: messages.length,
        conversationsProcessed,
        outputsWritten,
        interactionsWritten: counters.interactions_written,
        contactFactsWritten: counters.contact_facts_written,
        valueLogsWritten: counters.value_logs_written,
        todosWritten: counters.todos_written,
        reviewItemsWritten: counters.review_items_written,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      finishDailyAiRun(runId, {
        status: 'failed',
        messages_seen: messages.length,
        conversations_processed: conversationsProcessed,
        outputs_written: outputsWritten,
        ...counters,
        error: message,
      })
      this.openSyncError(`ai:${reason}`, 'LinkedIn insight failed', message)
      this.options.publishStatus()
      throw err
    }
  }

  private async runMessages(
    messages: BridgeMessageRow[],
    reason: string,
    options: { repairInteractionOnly?: boolean; rewriteMissingInteraction?: boolean } = {},
  ): Promise<InsightRunResult> {
    const dateCovered = messages[0] ? localDate(messages[0].timestamp_ms) : localDate(Date.now())
    const runId = createDailyAiRun({
      scheduled_for: reason === 'manual' ? 'manual' : scheduledLabel(),
      date_covered: dateCovered,
    })
    let conversationsProcessed = 0
    let outputsWritten = 0
    const counters = emptyCounters()
    const seenFactKeys = new Set<string>()
    const seenKeyDateKeys = new Set<string>()
    for (const output of latestAiStagedOutputs(5000)) {
      if (output.target !== 'contact_fact' || output.status === 'rejected') continue
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(output.payload_json) as Record<string, unknown>
      } catch {
        payload = {}
      }
      const key = factSemanticKey(output.contact_id, null, output.body ?? '')
      if (key) seenFactKeys.add(key)
      const keyDateKey = keyDateSemanticKey({
        contactId: output.contact_id,
        title: output.title,
        category: String(payload.category ?? ''),
        eventType: payload.event_type ? String(payload.event_type) : null,
        subject: payload.subject ? String(payload.subject) : null,
        relation: payload.relation ? String(payload.relation) : null,
        value: output.body ?? String(payload.value ?? ''),
      })
      if (keyDateKey) seenKeyDateKeys.add(keyDateKey)
    }

    try {
      const windows = groupWindows(messages)
      for (const win of windows) {
        const contactId = await this.options.resolveContact({
          chatId: win.chatId,
          phone: win.phone,
          waName: win.chatName,
        })

        if (!contactId) {
          if (this.isDismissedIdentityIssue(win.chatId)) continue
          await this.createIdentityReviewItem(win)
          this.openIdentityIssue(win)
          continue
        }

        const key = sourceKey(win)
        const previousOutput = getAiOutput(key)
        if (
          previousOutput?.supabase_id ||
          (previousOutput && !options.rewriteMissingInteraction && (!options.repairInteractionOnly || previousOutput.target !== 'interaction'))
        ) {
          markBridgeMessagesSynced(win.messages.map((message) => message.id), contactId)
          continue
        }
        if (options.repairInteractionOnly && previousOutput?.target !== 'interaction') continue

        const first = win.messages[0]
        const last = win.messages[win.messages.length - 1]
        const interactionDate = localDate(first.timestamp_ms)
        const extraction = await extractWhatsappInsights({
          conversationText: conversationText(win.messages),
          interactionDate,
          contactName: win.chatName,
          feedbackGuidance: aiFeedbackGuidance(),
        })
        if (options.repairInteractionOnly) continue
        const title = win.chatName ?? win.phone ?? win.chatId
        const direction = dominantDirection(win.messages)
        const windowStart = new Date(first.timestamp_ms).toISOString()
        const windowEnd = new Date(last.timestamp_ms).toISOString()
        const suggestions = buildSuggestions({
          sourceKey: key,
          contactId,
          channel: 'whatsapp',
          title,
          interactionDate,
          direction,
          extraction,
        })
        const written = await this.writeInteractionBundle({
          sourceKey: key,
          contactId,
          title,
          type: 'whatsapp',
          channel: 'whatsapp',
          direction,
          interactionDate,
          windowStart,
          windowEnd,
          messageCount: win.messages.length,
          summary: extraction.summary,
          participants: [{ name: win.chatName, phone: win.phone, chat_id: win.chatId }],
          excerpts: win.messages.slice(-8).map((message) => ({
            timestamp: new Date(message.timestamp_ms).toISOString(),
            speaker: message.direction === 'outbound' ? 'Me' : (message.chat_name || message.sender || title),
            direction: message.direction,
            text: (message.text || `[${message.media_type || 'media'}]`).replace(/\s+/g, ' ').slice(0, 500),
          })),
          suggestions,
        })
        outputsWritten += 1 + written.suggestionsWritten
        counters.interactions_written++
        counters.contact_facts_written += suggestions.filter((row) => row.target === 'contact_fact' || row.target === 'key_date').length
        counters.value_logs_written += suggestions.filter((row) => row.target === 'value_log' || row.target === 'intro').length
        counters.todos_written += suggestions.filter((row) => row.target === 'todo' || row.target === 'next_step').length
        recordAiRunOutput({
          run_id: runId,
          source_key: key,
          target: 'interaction',
          contact_id: contactId,
          supabase_id: written.interactionId,
          label: extraction.summary.slice(0, 160),
        })
        recordAiOutput(key, 'interaction', written.interactionId)
        markBridgeMessagesSynced(win.messages.map((message) => message.id), contactId)
        conversationsProcessed++
      }

      finishDailyAiRun(runId, {
        status: 'succeeded',
        messages_seen: messages.length,
        conversations_processed: conversationsProcessed,
        outputs_written: outputsWritten,
        ...counters,
      })
      pruneSyncedBridgeMessages()
      this.options.publishStatus()
      return {
        runId,
        messagesSeen: messages.length,
        conversationsProcessed,
        outputsWritten,
        interactionsWritten: counters.interactions_written,
        contactFactsWritten: counters.contact_facts_written,
        valueLogsWritten: counters.value_logs_written,
        todosWritten: counters.todos_written,
        reviewItemsWritten: counters.review_items_written,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      finishDailyAiRun(runId, {
        status: 'failed',
        messages_seen: messages.length,
        conversations_processed: conversationsProcessed,
        outputs_written: outputsWritten,
        ...counters,
        error: message,
      })
      this.openSyncError(`ai:${reason}`, 'Daily WhatsApp insight failed', message)
      this.options.publishStatus()
      throw err
    }
  }

  private async syncStagedOutput(row: AiStagedOutputRow): Promise<void> {
    if (row.status === 'synced') return
    const supabase = getSupabase()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) throw new Error('not signed in')

    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    if (row.body?.trim()) {
      if (row.target === 'interaction') payload.notes = row.body.trim()
      if (row.target === 'contact_fact') payload.value = row.body.trim()
      if (row.target === 'value_log') payload.description = row.body.trim()
      if (row.target === 'todo') payload.text = row.body.trim()
      if (row.target === 'review_item') payload.body = row.body.trim()
    }

    let supabaseId: string | null = null
    if (row.target === 'interaction') {
      const windowStart = payload.window_start as string | undefined
      const windowEnd = payload.window_end as string | undefined
      const messageCount = Number(payload.message_count ?? 0)
      const interactionPayload = {
        user_id: user.id,
        contact_id: payload.contact_id,
        type: payload.type,
        direction: payload.direction,
        notes: payload.notes,
        interaction_date: payload.interaction_date,
        next_step: payload.next_step,
        next_step_date: payload.next_step_date,
        next_step_owner: payload.next_step_owner,
        channel: payload.channel,
      }
      const { data, error } = await supabase
        .from('interactions')
        .insert(interactionPayload)
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      supabaseId = data?.id ?? null
      if (supabaseId && windowStart && windowEnd) {
          await supabase.from('extension_interaction_windows').insert({
            user_id: user.id,
            contact_id: payload.contact_id,
            interaction_id: supabaseId,
            channel: payload.channel ?? 'whatsapp',
            window_start: windowStart,
            window_end: windowEnd,
            direction: payload.direction,
          message_count: messageCount,
        }).then(({ error }) => {
          if (error) console.warn('[daily-insights] approved window insert failed:', error.message)
        })
      }
      if (payload.contact_id && windowStart) {
        await supabase.from('outreach_logs')
          .update({
            last_interaction_at: windowStart,
            updated_at: new Date().toISOString(),
          })
          .eq('id', payload.contact_id)
          .eq('user_id', user.id)
      }
    } else if (row.target === 'contact_fact') {
      if (payload.category === 'key_date') {
        const { data: keyDate, error: keyDateError } = await supabase
          .from('contact_key_dates')
          .insert({
            user_id: user.id,
            contact_id: payload.contact_id,
            event_type: payload.event_type,
            subject: payload.subject,
            relation: payload.relation,
            date_value: payload.date_value,
            date_precision: payload.date_precision,
            description: payload.description ?? payload.value,
            source: payload.source,
            source_interaction_date: row.interaction_date,
          })
          .select('id')
          .single()
        if (!keyDateError) {
          supabaseId = keyDate?.id ?? null
        } else {
          throw new Error(`contact_key_dates insert failed: ${keyDateError.message}`)
        }
      }
      if (!supabaseId) {
        const { data, error } = await supabase.from('contact_facts').insert({
        user_id: user.id,
        contact_id: payload.contact_id,
        category: payload.category,
        label: payload.label,
        value: payload.value,
        importance: payload.importance,
        source: payload.source,
        }).select('id').single()
        if (error) throw new Error(error.message)
        supabaseId = data?.id ?? null
      }
    } else if (row.target === 'value_log') {
      const { data, error } = await supabase.from('value_logs').insert({
        user_id: user.id,
        outreach_log_id: payload.outreach_log_id,
        type: payload.type,
        description: payload.description,
        direction: payload.direction,
        date: payload.date,
      }).select('id').single()
      if (error) throw new Error(error.message)
      supabaseId = data?.id ?? null
      if (supabaseId && hasIntroductionColumns(payload)) {
        const connectorContactId = sameLooseName(payload.connector_name, payload.source_contact_name)
          ? payload.source_contact_id
          : null
        const { error: introError } = await supabase.from('contact_introductions').upsert({
          user_id: user.id,
          source_contact_id: payload.source_contact_id ?? payload.outreach_log_id,
          connector_contact_id: connectorContactId,
          introduced_contact_id: null,
          introduced_to_contact_id: null,
          connector_name: compactName(payload.connector_name),
          introduced_person_name: compactName(payload.introduced_person_name),
          introduced_person_company: compactName(payload.introduced_person_company),
          introduced_to_name: compactName(payload.introduced_to_name),
          introduced_to_company: compactName(payload.introduced_to_company),
          relationship_context: compactName(payload.relationship_context) ?? compactName(payload.description),
          status: compactName(payload.introduction_status) ?? 'made',
          direction: payload.direction === 'received' ? 'received' : 'given',
          confidence: compactName(payload.confidence) ?? 'medium',
          source_channel: compactName(payload.source_channel) ?? compactName(payload.channel) ?? 'whatsapp',
          source_interaction_date: payload.date,
          source_external_id: row.dedupe_key,
          source_value_log_id: supabaseId,
        }, { onConflict: 'user_id,source_external_id' })
        if (introError) throw new Error(`contact_introductions insert failed: ${introError.message}`)
      }
    } else if (row.target === 'todo') {
      const { data, error } = await supabase.from('todos').insert({
        user_id: user.id,
        text: payload.text,
        date: payload.date,
        contact_id: payload.contact_id,
      }).select('id').single()
      if (error) throw new Error(error.message)
      supabaseId = data?.id ?? null
    } else if (row.target === 'review_item') {
      const { data, error } = await supabase.from('review_items').insert({
        user_id: user.id,
        source: 'conversations',
        source_external_id: row.source_key,
        source_url: null,
        title: payload.title ?? row.title,
        body: payload.body ?? row.body,
        proposed_target: payload.proposed_target,
        proposed_payload: payload.proposed_payload,
        contact_id: payload.contact_id ?? row.contact_id,
        status: 'pending',
      }).select('id').single()
      if (error && error.code !== '23505') throw new Error(error.message)
      supabaseId = data?.id ?? null
    }

    updateAiStagedOutput({
      id: row.id,
      status: 'synced',
      payload,
      supabase_id: supabaseId,
      error: null,
      confirmed_at: Date.now(),
    })
  }

  private async createIdentityReviewItem(win: Window): Promise<void> {
    const supabase = getSupabase()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return
    await this.createReviewItem(user.id, `wa-identity:${win.chatId}`, {
      title: `Link WhatsApp chat: ${win.chatName ?? win.phone ?? win.chatId}`,
      body: this.identityIssueDetail(win),
      proposed_target: 'interaction',
      contact_id: null,
      proposed_payload: {
        type: 'whatsapp',
        channel: 'whatsapp',
        source_kind: 'identity_resolution',
        wa_chat_id: win.chatId,
        wa_phone: win.phone,
        wa_name: win.chatName,
        interaction_date: localDate(win.messages[0].timestamp_ms),
        message_count: win.messages.length,
      },
    })
  }

  private async createLinkedinIdentityReviewItem(win: LinkedinWindow): Promise<void> {
    const supabase = getSupabase()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return
    const first = win.messages[0]
    await this.createReviewItem(user.id, `linkedin-identity:${win.conversationId}`, {
      title: `Link LinkedIn chat: ${win.title}`,
      body: this.linkedinIdentityIssueDetail(win),
      proposed_target: 'interaction',
      contact_id: null,
      proposed_payload: {
        type: 'linkedin_msg',
        channel: 'linkedin',
        source_kind: 'identity_resolution',
        conversation_id: win.conversationId,
        linkedin_url: win.linkedinUrl,
        name: win.title,
        interaction_date: first ? localDate(first.created_at_ms) : localDate(Date.now()),
        message_count: win.messages.length,
      },
    })
  }

  private isDismissedIdentityIssue(chatId: string): boolean {
    const issueKey = `bridge-identity:${chatId}`
    const row = getDb()
      .prepare('SELECT status FROM sync_issues WHERE issue_key = ?')
      .get(issueKey) as { status: string } | undefined
    return row?.status === 'dismissed'
  }

  private identityIssueDetail(win: Window): string {
    const first = win.messages[0]
    const last = win.messages[win.messages.length - 1]
    const range = first && last
      ? `${formatIssueTimestamp(first.timestamp_ms)} - ${formatIssueTimestamp(last.timestamp_ms)}`
      : 'No timestamp'
    const phone = win.phone ? `Phone: ${win.phone}. ` : ''
    const samples = win.messages.slice(-4).map((message) => {
      const speaker = message.direction === 'outbound' ? 'Me' : (message.chat_name || message.sender || 'Them')
      const text = (message.text || `[${message.media_type || 'media'}]`).replace(/\s+/g, ' ').trim()
      return `${formatIssueTimestamp(message.timestamp_ms)} ${speaker}: ${text.slice(0, 180)}`
    })
    const preview = samples.length ? `\nRecent context:\n${samples.join('\n')}` : '\nRecent context: no text messages captured yet.'
    return `${phone}${win.messages.length} message${win.messages.length === 1 ? '' : 's'} captured, ${range}. Link/create the contact once; Conversations will backfill previous local messages automatically.${preview}`
  }

  private async createReviewItem(
    userId: string,
    sourceExternalId: string,
    input: {
      title: string
      body: string | null
      proposed_target: string
      proposed_payload: Record<string, unknown>
      contact_id: string | null
    },
  ): Promise<string | null> {
    const supabase = getSupabase()
    const { data: existing } = await supabase
      .from('review_items')
      .select('id')
      .eq('user_id', userId)
      .eq('source', 'conversations')
      .eq('source_external_id', sourceExternalId)
      .eq('status', 'pending')
      .maybeSingle()
    if (existing?.id) return existing.id
    const { data, error } = await supabase.from('review_items').insert({
      user_id: userId,
      source: 'conversations',
      source_external_id: sourceExternalId,
      source_url: null,
      title: input.title,
      body: input.body,
      proposed_target: input.proposed_target,
      proposed_payload: input.proposed_payload,
      contact_id: input.contact_id,
      status: 'pending',
    }).select('id').single()
    if (error && error.code !== '23505') throw new Error(error.message)
    return data?.id ?? null
  }

  private openIdentityIssue(win: Window): void {
    const db = getDb()
    const now = Date.now()
    const issueKey = `bridge-identity:${win.chatId}`
    const existing = db
      .prepare('SELECT status FROM sync_issues WHERE issue_key = ?')
      .get(issueKey) as { status: string } | undefined
    if (existing?.status === 'dismissed') return
    db.prepare(`
      INSERT INTO sync_issues
        (issue_key, kind, severity, title, detail, chat_key, contact_id, status, created_at, updated_at)
      VALUES
        (?, 'identity_resolution', 'warning', ?, ?, ?, NULL, 'open', ?, ?)
      ON CONFLICT(issue_key) DO UPDATE SET
        title = excluded.title,
        detail = excluded.detail,
        chat_key = excluded.chat_key,
        status = 'open',
        updated_at = excluded.updated_at,
        resolved_at = NULL
    `).run(
      issueKey,
      win.chatName ?? win.phone ?? 'Unmatched WhatsApp chat',
      this.identityIssueDetail(win),
      win.chatId,
      now,
      now,
    )
  }

  private openLinkedinIdentityIssue(win: LinkedinWindow): void {
    const db = getDb()
    const now = Date.now()
    const issueKey = `linkedin-identity:${win.conversationId}`
    const existing = db
      .prepare('SELECT status FROM sync_issues WHERE issue_key = ?')
      .get(issueKey) as { status: string } | undefined
    if (existing?.status === 'dismissed') return
    const first = win.messages[0]
    const last = win.messages[win.messages.length - 1]
    const range = first && last
      ? `${formatIssueTimestamp(first.created_at_ms)} - ${formatIssueTimestamp(last.created_at_ms)}`
      : 'No timestamp'
    const samples = win.messages.slice(-4).map((message) => {
      const speaker = message.is_from_me ? 'Me' : (message.sender_name || win.title)
      const text = (message.body || '[media]').replace(/\s+/g, ' ').trim()
      return `${formatIssueTimestamp(message.created_at_ms)} ${speaker}: ${text.slice(0, 180)}`
    })
    const detail = this.linkedinIdentityIssueDetail(win, range, samples)
    db.prepare(`
      INSERT INTO sync_issues
        (issue_key, kind, severity, title, detail, chat_key, contact_id, status, created_at, updated_at)
      VALUES
        (?, 'identity_resolution', 'warning', ?, ?, ?, NULL, 'open', ?, ?)
      ON CONFLICT(issue_key) DO UPDATE SET
        title = excluded.title,
        detail = excluded.detail,
        chat_key = excluded.chat_key,
        status = 'open',
        updated_at = excluded.updated_at,
        resolved_at = NULL
    `).run(issueKey, win.title, detail, `linkedin:${win.conversationId}`, now, now)
  }

  private linkedinIdentityIssueDetail(win: LinkedinWindow, range?: string, samples?: string[]): string {
    const first = win.messages[0]
    const last = win.messages[win.messages.length - 1]
    const resolvedRange = range ?? (first && last
      ? `${formatIssueTimestamp(first.created_at_ms)} - ${formatIssueTimestamp(last.created_at_ms)}`
      : 'No timestamp')
    const resolvedSamples = samples ?? win.messages.slice(-4).map((message) => {
      const speaker = message.is_from_me ? 'Me' : (message.sender_name || win.title)
      const text = (message.body || '[media]').replace(/\s+/g, ' ').trim()
      return `${formatIssueTimestamp(message.created_at_ms)} ${speaker}: ${text.slice(0, 180)}`
    })
    const linkedin = win.linkedinUrl ? `LinkedIn: ${win.linkedinUrl}. ` : ''
    return `${linkedin}${win.messages.length} LinkedIn message${win.messages.length === 1 ? '' : 's'} captured, ${resolvedRange}. Link/create the contact once; Conversations will backfill local LinkedIn messages automatically.\nRecent context:\n${resolvedSamples.join('\n')}`
  }

  private openSyncError(issueKey: string, title: string, detail: string): void {
    const db = getDb()
    const now = Date.now()
    db.prepare(`
      INSERT INTO sync_issues
        (issue_key, kind, severity, title, detail, chat_key, contact_id, status, created_at, updated_at)
      VALUES
        (?, 'sync_error', 'error', ?, ?, NULL, NULL, 'open', ?, ?)
      ON CONFLICT(issue_key) DO UPDATE SET
        title = excluded.title,
        detail = excluded.detail,
        status = 'open',
        updated_at = excluded.updated_at,
        resolved_at = NULL
    `).run(issueKey, title, detail, now, now)
  }
}
