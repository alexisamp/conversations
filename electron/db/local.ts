// Local SQLite store for Conversations.
//
// WAL mode for concurrent reads while we write, one connection shared across
// the main process. Better-sqlite3 is synchronous on purpose — the operations
// here are fast enough (single-row insert/update) that doing them sync inside
// an IPC handler is preferable to the async-queue complexity.

import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export type MessageInput = {
  chat_phone: string
  chat_kind: 'person' | 'group'
  wa_data_id: string
  direction: 'inbound' | 'outbound'
  sender_phone: string | null
  sender_lid: string | null
  sender_name: string | null
  text: string | null
  timestamp_ms: number
}

export type MessageRow = MessageInput & {
  id: number
  session_id: number | null
  created_at: number
}

export type BridgeMessageInput = {
  wa_message_id: string
  chat_id: string
  chat_kind: 'person' | 'group'
  chat_name: string | null
  sender: string | null
  sender_phone: string | null
  direction: 'inbound' | 'outbound'
  text: string | null
  media_type: string | null
  timestamp_ms: number
}

export type BridgeMessageRow = BridgeMessageInput & {
  id: number
  captured_at: number
  ai_processed_at: number | null
  synced_at: number | null
  contact_id: string | null
}

export type SessionRow = {
  id: number
  chat_phone: string
  chat_kind: 'person' | 'group'
  contact_id: string | null
  started_at: number
  last_message_at: number
  closed_at: number | null
  direction_first: 'inbound' | 'outbound'
  message_count: number
  summary: string | null
  supabase_interaction_id: string | null
  supabase_window_id: string | null
}

export type SyncQueueOp =
  | 'interaction:insert'
  | 'interaction:update_notes'
  | 'window:insert'
  | 'window:bump'
  | 'habit:bump'

let db: Database.Database | null = null
let schemaSql: string | null = null

function loadSchema(): string {
  if (schemaSql) return schemaSql
  // Look next to the compiled JS first (production), then fall back to the TS
  // source layout (dev from dist/).
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', '..', '..', 'electron', 'db', 'schema.sql'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      schemaSql = fs.readFileSync(p, 'utf8')
      return schemaSql
    }
  }
  throw new Error('[localdb] schema.sql not found in ' + candidates.join(', '))
}

export function getDb(): Database.Database {
  if (db) return db
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'conv.db')
  const handle = new Database(file)
  handle.pragma('journal_mode = WAL')
  handle.pragma('synchronous = NORMAL')
  handle.pragma('foreign_keys = ON')
  handle.exec(loadSchema())
  migrateLocalSchema(handle)
  db = handle
  console.log('[localdb] opened', file)
  return db
}

function hasColumn(handle: Database.Database, table: string, column: string): boolean {
  const rows = handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

function migrateLocalSchema(handle: Database.Database): void {
  if (!hasColumn(handle, 'bridge_messages', 'contact_id')) {
    handle.prepare('ALTER TABLE bridge_messages ADD COLUMN contact_id TEXT').run()
  }
}

// ─── Messages ────────────────────────────────────────────────────────

export function insertMessage(input: MessageInput): number | null {
  const d = getDb()
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO messages
      (chat_phone, chat_kind, wa_data_id, direction, sender_phone, sender_lid, sender_name, text, timestamp_ms)
    VALUES
      (@chat_phone, @chat_kind, @wa_data_id, @direction, @sender_phone, @sender_lid, @sender_name, @text, @timestamp_ms)
  `)
  const result = stmt.run(input)
  return result.lastInsertRowid ? Number(result.lastInsertRowid) : null
}

export function recentMessagesForChat(chatPhone: string, limit = 200): MessageRow[] {
  const d = getDb()
  const stmt = d.prepare(`
    SELECT * FROM messages
    WHERE chat_phone = ?
    ORDER BY timestamp_ms DESC
    LIMIT ?
  `)
  return stmt.all(chatPhone, limit) as MessageRow[]
}

export function countMessages(): number {
  const d = getDb()
  const row = d.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
  return row.c
}

// ─── Bridge messages ─────────────────────────────────────────────────

export function upsertBridgeMessages(inputs: BridgeMessageInput[]): number {
  if (inputs.length === 0) return 0
  const d = getDb()
  const stmt = d.prepare(`
    INSERT INTO bridge_messages
      (wa_message_id, chat_id, chat_kind, chat_name, sender, sender_phone, direction, text, media_type, timestamp_ms)
    VALUES
      (@wa_message_id, @chat_id, @chat_kind, @chat_name, @sender, @sender_phone, @direction, @text, @media_type, @timestamp_ms)
    ON CONFLICT(chat_id, wa_message_id) DO UPDATE SET
      chat_name = excluded.chat_name,
      sender = excluded.sender,
      sender_phone = excluded.sender_phone,
      text = excluded.text,
      media_type = excluded.media_type,
      timestamp_ms = excluded.timestamp_ms
  `)
  const tx = d.transaction((rows: BridgeMessageInput[]) => {
    let changed = 0
    for (const row of rows) {
      const result = stmt.run(row)
      changed += result.changes
    }
    return changed
  })
  return tx(inputs) as number
}

export function latestBridgeMessageAt(): number | null {
  const row = getDb()
    .prepare('SELECT MAX(timestamp_ms) AS latest FROM bridge_messages')
    .get() as { latest: number | null }
  return row.latest ?? null
}

export function bridgeMessagesForRange(startMs: number, endMs: number): BridgeMessageRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM bridge_messages
      WHERE chat_kind = 'person'
        AND timestamp_ms >= ?
        AND timestamp_ms <= ?
        AND synced_at IS NULL
      ORDER BY chat_id ASC, timestamp_ms ASC
    `)
    .all(startMs, endMs) as BridgeMessageRow[]
}

export function bridgeMessagesForChat(chatId: string): BridgeMessageRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM bridge_messages
      WHERE chat_id = ? AND chat_kind = 'person' AND synced_at IS NULL
      ORDER BY timestamp_ms ASC
    `)
    .all(chatId) as BridgeMessageRow[]
}

export function markBridgeMessagesSynced(ids: number[], contactId: string): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  const now = Date.now()
  getDb()
    .prepare(`
      UPDATE bridge_messages
      SET synced_at = ?, ai_processed_at = COALESCE(ai_processed_at, ?), contact_id = ?
      WHERE id IN (${placeholders})
    `)
    .run(now, now, contactId, ...ids)
}

export function latestBridgeMessageSummary(): { timestamp_ms: number | null; count_today: number } {
  const d = getDb()
  const latest = d
    .prepare('SELECT MAX(timestamp_ms) AS latest FROM bridge_messages')
    .get() as { latest: number | null }
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const today = d
    .prepare('SELECT COUNT(*) AS c FROM bridge_messages WHERE timestamp_ms >= ?')
    .get(start.getTime()) as { c: number }
  return { timestamp_ms: latest.latest ?? null, count_today: today.c }
}

export function pruneSyncedBridgeMessages(retentionDays = 30): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const result = getDb()
    .prepare('DELETE FROM bridge_messages WHERE synced_at IS NOT NULL AND timestamp_ms < ?')
    .run(cutoff)
  return result.changes
}

// ─── Daily AI runs + output dedupe ───────────────────────────────────

export type DailyAiRunRow = {
  id: number
  run_at: number
  scheduled_for: string
  date_covered: string
  status: 'running' | 'succeeded' | 'failed'
  messages_seen: number
  conversations_processed: number
  outputs_written: number
  error: string | null
  created_at: number
  finished_at: number | null
}

export function createDailyAiRun(input: {
  scheduled_for: string
  date_covered: string
}): number {
  return Number(
    getDb()
      .prepare(`
        INSERT INTO daily_ai_runs (run_at, scheduled_for, date_covered, status)
        VALUES (?, ?, ?, 'running')
      `)
      .run(Date.now(), input.scheduled_for, input.date_covered).lastInsertRowid,
  )
}

export function finishDailyAiRun(
  runId: number,
  input: {
    status: 'succeeded' | 'failed'
    messages_seen: number
    conversations_processed: number
    outputs_written: number
    error?: string | null
  },
): void {
  getDb()
    .prepare(`
      UPDATE daily_ai_runs
      SET status = ?, messages_seen = ?, conversations_processed = ?, outputs_written = ?,
          error = ?, finished_at = ?
      WHERE id = ?
    `)
    .run(
      input.status,
      input.messages_seen,
      input.conversations_processed,
      input.outputs_written,
      input.error ?? null,
      Date.now(),
      runId,
    )
}

export function latestDailyAiRuns(limit = 5): DailyAiRunRow[] {
  return getDb()
    .prepare('SELECT * FROM daily_ai_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as DailyAiRunRow[]
}

export function lastSuccessfulDailyAiRunAt(): number | null {
  const row = getDb()
    .prepare(`
      SELECT MAX(finished_at) AS finished_at
      FROM daily_ai_runs
      WHERE status = 'succeeded'
    `)
    .get() as { finished_at: number | null }
  return row.finished_at ?? null
}

export function hasAiOutput(sourceKey: string): boolean {
  const row = getDb()
    .prepare('SELECT source_key FROM ai_output_dedupe WHERE source_key = ?')
    .get(sourceKey)
  return Boolean(row)
}

export function recordAiOutput(sourceKey: string, target: string, supabaseId?: string | null): void {
  getDb()
    .prepare(`
      INSERT OR IGNORE INTO ai_output_dedupe (source_key, target, supabase_id)
      VALUES (?, ?, ?)
    `)
    .run(sourceKey, target, supabaseId ?? null)
}

// ─── Sessions ────────────────────────────────────────────────────────

export function findOpenSession(chatPhone: string): SessionRow | undefined {
  const d = getDb()
  return d
    .prepare('SELECT * FROM sessions WHERE chat_phone = ? AND closed_at IS NULL LIMIT 1')
    .get(chatPhone) as SessionRow | undefined
}

export function createSession(input: {
  chat_phone: string
  chat_kind: 'person' | 'group'
  contact_id: string | null
  started_at: number
  direction_first: 'inbound' | 'outbound'
}): number {
  const d = getDb()
  const stmt = d.prepare(`
    INSERT INTO sessions
      (chat_phone, chat_kind, contact_id, started_at, last_message_at, direction_first, message_count)
    VALUES
      (@chat_phone, @chat_kind, @contact_id, @started_at, @started_at, @direction_first, 0)
  `)
  return Number(stmt.run(input).lastInsertRowid)
}

export function bumpSession(sessionId: number, lastMessageAt: number): void {
  const d = getDb()
  d.prepare(
    'UPDATE sessions SET last_message_at = ?, message_count = message_count + 1 WHERE id = ?',
  ).run(lastMessageAt, sessionId)
}

export function closeSession(
  sessionId: number,
  closedAt: number,
  summary: string | null,
): void {
  const d = getDb()
  d.prepare('UPDATE sessions SET closed_at = ?, summary = ? WHERE id = ?').run(
    closedAt,
    summary,
    sessionId,
  )
}

export function sessionsStillOpen(): SessionRow[] {
  const d = getDb()
  return d
    .prepare('SELECT * FROM sessions WHERE closed_at IS NULL')
    .all() as SessionRow[]
}

export function setMessageSession(sessionId: number, messageIds: number[]): void {
  if (messageIds.length === 0) return
  const d = getDb()
  const placeholders = messageIds.map(() => '?').join(',')
  d.prepare(`UPDATE messages SET session_id = ? WHERE id IN (${placeholders})`).run(
    sessionId,
    ...messageIds,
  )
}

export function recentMessagesForSession(sessionId: number, limit = 500): MessageRow[] {
  const d = getDb()
  return d
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp_ms ASC LIMIT ?')
    .all(sessionId, limit) as MessageRow[]
}

export function assignMessageToSession(messageId: number, sessionId: number): void {
  const d = getDb()
  d.prepare('UPDATE messages SET session_id = ? WHERE id = ?').run(sessionId, messageId)
}

// ─── Sync queue ──────────────────────────────────────────────────────

export function enqueueSync(op: SyncQueueOp, payload: unknown): number {
  const d = getDb()
  const result = d
    .prepare('INSERT INTO sync_queue (op, payload) VALUES (?, ?)')
    .run(op, JSON.stringify(payload))
  return Number(result.lastInsertRowid)
}

// ─── Lifecycle ───────────────────────────────────────────────────────

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
