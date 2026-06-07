import {
  bridgeMessagesForChat,
  bridgeMessagesForRange,
  bridgeMessagesForStructuredRepair,
  addAiFeedback,
  createDailyAiRun,
  finishDailyAiRun,
  getAiOutput,
  getDb,
  latestAiRunOutputs,
  latestAiStagedOutputs,
  lastSuccessfulDailyAiRunAt,
  latestDailyAiRuns,
  markBridgeMessagesSynced,
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
} from '../db/local'
import { getSupabase } from '../supabase/client'
import { extractWhatsappInsights } from './gemini'
import type { WhatsappBridge } from '../whatsapp/bridge'

const TZ = 'America/New_York'
const WINDOW_MS = 6 * 60 * 60 * 1000
const STARTUP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

type ResolveContact = (input: {
  chatId: string
  phone: string | null
  waName: string | null
}) => Promise<string | null>

type DailyInsightRunnerOptions = {
  bridge: WhatsappBridge
  resolveContact: ResolveContact
  publishStatus: () => void
}

type Window = {
  chatId: string
  chatName: string | null
  phone: string | null
  messages: BridgeMessageRow[]
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

function conversationText(messages: BridgeMessageRow[]): string {
  return messages
    .map((message) => {
      const speaker = message.direction === 'outbound' ? 'Yo' : message.chat_name || message.sender || 'Ellos'
      return `${speaker}: ${message.text || `[${message.media_type || 'media'}]`}`
    })
    .join('\n')
}

function dominantDirection(messages: BridgeMessageRow[]): 'inbound' | 'outbound' {
  const outbound = messages.filter((message) => message.direction === 'outbound').length
  return outbound >= messages.length - outbound ? 'outbound' : 'inbound'
}

function sourceKey(win: Window): string {
  const first = win.messages[0]
  const last = win.messages[win.messages.length - 1]
  return `wa-bridge:${win.chatId}:${first.timestamp_ms}:${last.timestamp_ms}`
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
    const start = lastSuccessfulDailyAiRunAt() ?? end - STARTUP_LOOKBACK_MS
    return this.runRange(start, end, reason)
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
    if (input.decision === 'reject') {
      updateAiStagedOutputsStatus([row.id], 'rejected')
    }
    this.options.publishStatus()
    return { ok: true }
  }

  private async runRange(startMs: number, endMs: number, reason: string): Promise<InsightRunResult> {
    const messages = bridgeMessagesForRange(startMs, endMs)
    return this.runMessages(messages, reason)
  }

  private async runMessages(
    messages: BridgeMessageRow[],
    reason: string,
    options: { repairInteractionOnly?: boolean } = {},
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
        if (previousOutput && (!options.repairInteractionOnly || previousOutput.target !== 'interaction')) {
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
        let windowStructuredOutputs = 0

        if (!options.repairInteractionOnly) {
          const payload = {
            contact_id: contactId,
            type: 'whatsapp',
            direction: dominantDirection(win.messages),
            notes: extraction.summary,
            interaction_date: interactionDate,
            next_step: extraction.next_step,
            next_step_date: extraction.next_step_date,
            next_step_owner: extraction.next_step_owner,
            channel: 'whatsapp',
            window_start: new Date(first.timestamp_ms).toISOString(),
            window_end: new Date(last.timestamp_ms).toISOString(),
            message_count: win.messages.length,
          }
          const stagedId = stageAiOutput({
            run_id: runId,
            source_key: key,
            target: 'interaction',
            contact_id: contactId,
            interaction_date: interactionDate,
            title: win.chatName ?? win.phone ?? win.chatId,
            body: extraction.summary,
            payload,
          })
          if (stagedId) {
            outputsWritten++
            counters.interactions_written++
          }
          recordAiRunOutput({
            run_id: runId,
            source_key: key,
            target: 'interaction',
            contact_id: contactId,
            supabase_id: null,
            label: extraction.summary.slice(0, 160),
          })
        }

        for (const fact of extraction.contact_facts.slice(0, 5)) {
          if (!fact.value?.trim()) continue
          const semanticKeyDateKey = keyDateSemanticKey({
            contactId,
            title: win.chatName ?? win.phone ?? win.chatId,
            category: fact.category,
            eventType: fact.event_type,
            subject: fact.subject,
            relation: fact.relation,
            value: fact.value,
          })
          if (semanticKeyDateKey && seenKeyDateKeys.has(semanticKeyDateKey)) continue
          if (semanticKeyDateKey) seenKeyDateKeys.add(semanticKeyDateKey)
          const semanticFactKey = factSemanticKey(contactId, fact.category, fact.value)
          if (semanticFactKey && seenFactKeys.has(semanticFactKey)) continue
          if (semanticFactKey) seenFactKeys.add(semanticFactKey)
          if (fact.needs_review) {
            const payload = {
              title: `Review WhatsApp fact: ${win.chatName ?? win.phone ?? win.chatId}`,
              body: fact.value,
              proposed_target: 'contact_fact',
              contact_id: contactId,
              proposed_payload: fact,
            }
            const stagedId = stageAiOutput({
              run_id: runId,
              source_key: key + ':fact:' + fact.value.slice(0, 40),
              target: 'review_item',
              contact_id: contactId,
              interaction_date: interactionDate,
              title: win.chatName ?? win.phone ?? win.chatId,
              body: fact.value,
              payload,
            })
            if (stagedId) {
              outputsWritten++
              counters.review_items_written++
              windowStructuredOutputs++
            }
            recordAiRunOutput({
              run_id: runId,
              source_key: key,
              target: 'review_item',
              contact_id: contactId,
              supabase_id: null,
              label: fact.value.slice(0, 160),
            })
          } else {
            const payload = {
              contact_id: contactId,
              category: fact.category || 'other',
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
            }
            const stagedId = stageAiOutput({
              run_id: runId,
              source_key: key,
              target: 'contact_fact',
              contact_id: contactId,
              interaction_date: interactionDate,
              title: win.chatName ?? win.phone ?? win.chatId,
              body: fact.value,
              payload,
            })
            if (stagedId) {
              outputsWritten++
              counters.contact_facts_written++
              windowStructuredOutputs++
            }
            recordAiRunOutput({
              run_id: runId,
              source_key: key,
              target: 'contact_fact',
              contact_id: contactId,
              supabase_id: null,
              label: `${fact.label ?? fact.category}: ${fact.value}`.slice(0, 160),
            })
          }
        }

        for (const value of extraction.value_logs.slice(0, 5)) {
          if (!value.description?.trim()) continue
          const payload = {
            outreach_log_id: contactId,
            type: value.type || 'other',
            description: value.description,
            direction: value.direction || 'given',
            date: interactionDate,
          }
          const stagedId = stageAiOutput({
            run_id: runId,
            source_key: key,
            target: 'value_log',
            contact_id: contactId,
            interaction_date: interactionDate,
            title: win.chatName ?? win.phone ?? win.chatId,
            body: value.description,
            payload,
          })
          if (stagedId) {
            outputsWritten++
            counters.value_logs_written++
            windowStructuredOutputs++
          }
          recordAiRunOutput({
            run_id: runId,
            source_key: key,
            target: 'value_log',
            contact_id: contactId,
            supabase_id: null,
            label: value.description.slice(0, 160),
          })
        }

        for (const todo of extraction.todos.slice(0, 5)) {
          if (!todo.text?.trim()) continue
          const payload = {
            text: todo.text,
            date: todo.date || interactionDate,
            contact_id: contactId,
          }
          const stagedId = stageAiOutput({
            run_id: runId,
            source_key: key,
            target: 'todo',
            contact_id: contactId,
            interaction_date: interactionDate,
            title: win.chatName ?? win.phone ?? win.chatId,
            body: todo.text,
            payload,
          })
          if (stagedId) {
            outputsWritten++
            counters.todos_written++
            windowStructuredOutputs++
          }
          recordAiRunOutput({
            run_id: runId,
            source_key: key,
            target: 'todo',
            contact_id: contactId,
            supabase_id: null,
            label: todo.text.slice(0, 160),
          })
        }

        recordAiOutput(
          key,
          options.repairInteractionOnly || windowStructuredOutputs > 0 ? 'structured' : 'interaction',
          null,
        )
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
          channel: 'whatsapp',
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
