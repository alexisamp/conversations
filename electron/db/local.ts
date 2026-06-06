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
  for (const [column, type] of [
    ['interactions_written', 'INTEGER NOT NULL DEFAULT 0'],
    ['contact_facts_written', 'INTEGER NOT NULL DEFAULT 0'],
    ['value_logs_written', 'INTEGER NOT NULL DEFAULT 0'],
    ['todos_written', 'INTEGER NOT NULL DEFAULT 0'],
    ['review_items_written', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    if (!hasColumn(handle, 'daily_ai_runs', column)) {
      handle.prepare(`ALTER TABLE daily_ai_runs ADD COLUMN ${column} ${type}`).run()
    }
  }
  handle.prepare(`
    CREATE TABLE IF NOT EXISTS ai_run_outputs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       INTEGER NOT NULL REFERENCES daily_ai_runs(id) ON DELETE CASCADE,
      source_key   TEXT NOT NULL,
      target       TEXT NOT NULL CHECK (target IN ('interaction','contact_fact','value_log','todo','review_item')),
      contact_id   TEXT,
      supabase_id  TEXT,
      label        TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `).run()
  handle.prepare('CREATE INDEX IF NOT EXISTS idx_ai_run_outputs_run ON ai_run_outputs(run_id, target)').run()
  handle.prepare('CREATE INDEX IF NOT EXISTS idx_ai_run_outputs_contact ON ai_run_outputs(contact_id, created_at DESC)').run()
  handle.prepare(`
    CREATE TABLE IF NOT EXISTS ai_staged_outputs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id            INTEGER REFERENCES daily_ai_runs(id) ON DELETE SET NULL,
      dedupe_key        TEXT NOT NULL UNIQUE,
      source_key        TEXT NOT NULL,
      target            TEXT NOT NULL CHECK (target IN ('interaction','contact_fact','value_log','todo','review_item')),
      contact_id        TEXT,
      interaction_date  TEXT,
      title             TEXT,
      body              TEXT,
      payload_json      TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','synced','failed')),
      supabase_id       TEXT,
      error             TEXT,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      confirmed_at      INTEGER
    )
  `).run()
  handle.prepare('CREATE INDEX IF NOT EXISTS idx_ai_staged_outputs_status ON ai_staged_outputs(status, created_at DESC)').run()
  handle.prepare('CREATE INDEX IF NOT EXISTS idx_ai_staged_outputs_contact ON ai_staged_outputs(contact_id, interaction_date DESC)').run()
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
        AND chat_id LIKE '%@s.whatsapp.net'
        AND synced_at IS NULL
      ORDER BY chat_id ASC, timestamp_ms ASC
    `)
    .all(startMs, endMs) as BridgeMessageRow[]
}

export function bridgeMessagesForStructuredRepair(startMs: number, endMs: number): BridgeMessageRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM bridge_messages
      WHERE chat_kind = 'person'
        AND timestamp_ms >= ?
        AND timestamp_ms <= ?
        AND contact_id IS NOT NULL
        AND chat_id LIKE '%@s.whatsapp.net'
      ORDER BY chat_id ASC, timestamp_ms ASC
    `)
    .all(startMs, endMs) as BridgeMessageRow[]
}

export function bridgeMessagesForChat(chatId: string): BridgeMessageRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM bridge_messages
      WHERE chat_id = ? AND chat_kind = 'person' AND chat_id LIKE '%@s.whatsapp.net' AND synced_at IS NULL
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
  interactions_written: number
  contact_facts_written: number
  value_logs_written: number
  todos_written: number
  review_items_written: number
  error: string | null
  created_at: number
  finished_at: number | null
}

export type AiRunOutputRow = {
  id: number
  run_id: number
  source_key: string
  target: 'interaction' | 'contact_fact' | 'value_log' | 'todo' | 'review_item'
  contact_id: string | null
  supabase_id: string | null
  label: string | null
  created_at: number
}

export type AiStagedOutputRow = {
  id: number
  run_id: number | null
  dedupe_key: string
  source_key: string
  target: 'interaction' | 'contact_fact' | 'value_log' | 'todo' | 'review_item'
  contact_id: string | null
  interaction_date: string | null
  title: string | null
  body: string | null
  payload_json: string
  status: 'pending' | 'approved' | 'rejected' | 'synced' | 'failed'
  supabase_id: string | null
  error: string | null
  created_at: number
  updated_at: number
  confirmed_at: number | null
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
    interactions_written?: number
    contact_facts_written?: number
    value_logs_written?: number
    todos_written?: number
    review_items_written?: number
    error?: string | null
  },
): void {
  getDb()
    .prepare(`
      UPDATE daily_ai_runs
      SET status = ?, messages_seen = ?, conversations_processed = ?, outputs_written = ?,
          interactions_written = ?, contact_facts_written = ?, value_logs_written = ?,
          todos_written = ?, review_items_written = ?,
          error = ?, finished_at = ?
      WHERE id = ?
    `)
    .run(
      input.status,
      input.messages_seen,
      input.conversations_processed,
      input.outputs_written,
      input.interactions_written ?? 0,
      input.contact_facts_written ?? 0,
      input.value_logs_written ?? 0,
      input.todos_written ?? 0,
      input.review_items_written ?? 0,
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

export function getAiOutput(sourceKey: string): { target: string; supabase_id: string | null } | null {
  const row = getDb()
    .prepare('SELECT target, supabase_id FROM ai_output_dedupe WHERE source_key = ?')
    .get(sourceKey) as { target: string; supabase_id: string | null } | undefined
  return row ?? null
}

export function recordAiOutput(sourceKey: string, target: string, supabaseId?: string | null): void {
  getDb()
    .prepare(`
      INSERT INTO ai_output_dedupe (source_key, target, supabase_id)
      VALUES (?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        target = excluded.target,
        supabase_id = COALESCE(ai_output_dedupe.supabase_id, excluded.supabase_id)
    `)
    .run(sourceKey, target, supabaseId ?? null)
}

export function recordAiRunOutput(input: {
  run_id: number
  source_key: string
  target: AiRunOutputRow['target']
  contact_id: string | null
  supabase_id?: string | null
  label?: string | null
}): void {
  getDb()
    .prepare(`
      INSERT INTO ai_run_outputs
        (run_id, source_key, target, contact_id, supabase_id, label)
      VALUES
        (@run_id, @source_key, @target, @contact_id, @supabase_id, @label)
    `)
    .run({
      run_id: input.run_id,
      source_key: input.source_key,
      target: input.target,
      contact_id: input.contact_id,
      supabase_id: input.supabase_id ?? null,
      label: input.label ?? null,
    })
}

export function latestAiRunOutputs(limit = 200): AiRunOutputRow[] {
  return getDb()
    .prepare('SELECT * FROM ai_run_outputs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as AiRunOutputRow[]
}

export function stageAiOutput(input: {
  run_id: number
  source_key: string
  target: AiStagedOutputRow['target']
  contact_id: string | null
  interaction_date?: string | null
  title?: string | null
  body?: string | null
  payload: Record<string, unknown>
}): number | null {
  const body = input.body ?? null
  const dedupeKey = [
    input.source_key,
    input.target,
    input.contact_id ?? '',
    input.interaction_date ?? '',
    body ?? '',
  ].join('|')
  const result = getDb()
    .prepare(`
      INSERT OR IGNORE INTO ai_staged_outputs
        (run_id, dedupe_key, source_key, target, contact_id, interaction_date, title, body, payload_json)
      VALUES
        (@run_id, @dedupe_key, @source_key, @target, @contact_id, @interaction_date, @title, @body, @payload_json)
    `)
    .run({
      run_id: input.run_id,
      dedupe_key: dedupeKey,
      source_key: input.source_key,
      target: input.target,
      contact_id: input.contact_id,
      interaction_date: input.interaction_date ?? null,
      title: input.title ?? null,
      body,
      payload_json: JSON.stringify(input.payload),
    })
  return result.lastInsertRowid ? Number(result.lastInsertRowid) : null
}

export function latestAiStagedOutputs(limit = 300): AiStagedOutputRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM ai_staged_outputs
      ORDER BY
        CASE status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 WHEN 'synced' THEN 2 ELSE 3 END,
        created_at DESC
      LIMIT ?
    `)
    .all(limit) as AiStagedOutputRow[]
}

export function pendingAiStagedOutputs(limit = 500): AiStagedOutputRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM ai_staged_outputs
      WHERE status IN ('pending','failed')
      ORDER BY created_at ASC
      LIMIT ?
    `)
    .all(limit) as AiStagedOutputRow[]
}

export function getAiStagedOutput(id: number): AiStagedOutputRow | null {
  const row = getDb()
    .prepare('SELECT * FROM ai_staged_outputs WHERE id = ?')
    .get(id) as AiStagedOutputRow | undefined
  return row ?? null
}

export function updateAiStagedOutput(input: {
  id: number
  body?: string | null
  status?: AiStagedOutputRow['status']
  payload?: Record<string, unknown>
  supabase_id?: string | null
  error?: string | null
  confirmed_at?: number | null
}): void {
  const row = getAiStagedOutput(input.id)
  if (!row) return
  let payloadJson = row.payload_json
  if (input.payload) payloadJson = JSON.stringify(input.payload)
  getDb()
    .prepare(`
      UPDATE ai_staged_outputs
      SET body = ?, status = ?, payload_json = ?, supabase_id = ?, error = ?,
          confirmed_at = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(
      input.body ?? row.body,
      input.status ?? row.status,
      payloadJson,
      input.supabase_id ?? row.supabase_id,
      input.error ?? null,
      input.confirmed_at ?? row.confirmed_at,
      Date.now(),
      input.id,
    )
}

export function updateAiStagedOutputsStatus(
  ids: number[],
  status: AiStagedOutputRow['status'],
  error: string | null = null,
): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  getDb()
    .prepare(`
      UPDATE ai_staged_outputs
      SET status = ?, error = ?, updated_at = ?
      WHERE id IN (${placeholders})
    `)
    .run(status, error, Date.now(), ...ids)
}

export function countPendingAiStagedOutputs(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c FROM ai_staged_outputs WHERE status IN ('pending','failed')")
    .get() as { c: number }
  return row.c
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
