import {
  bridgeMessagesForChat,
  bridgeMessagesForRange,
  bridgeMessagesForStructuredRepair,
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

    try {
      const windows = groupWindows(messages)
      for (const win of windows) {
        const contactId = await this.options.resolveContact({
          chatId: win.chatId,
          phone: win.phone,
          waName: win.chatName,
        })

        if (!contactId) {
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
      body: 'This 1:1 WhatsApp chat needs to be linked to a reThink contact before AI outputs can be written.',
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
      `bridge-identity:${win.chatId}`,
      win.chatName ?? win.phone ?? 'Unmatched WhatsApp chat',
      'Link or create this person once; Conversations will backfill previous messages automatically.',
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
