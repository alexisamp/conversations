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
  db = handle
  console.log('[localdb] opened', file)
  return db
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
