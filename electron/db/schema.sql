-- Conversations local database schema.
-- Location: app.getPath('userData')/conv.db
--
-- This database is the single source of truth for RAW message data.
-- Only aggregated/summarized data (session summaries, interaction rows)
-- gets synced to Supabase. Raw message text never leaves the machine.

-- Each individual WhatsApp message we've captured.
-- Scraped by preload-whatsapp from live DOM events.
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_phone      TEXT NOT NULL,          -- normalized +E164 for 1:1, or lid/groupid for groups
  chat_kind       TEXT NOT NULL CHECK (chat_kind IN ('person','group')),
  wa_data_id      TEXT NOT NULL UNIQUE,   -- WhatsApp's own message id, used for dedupe
  direction       TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_phone    TEXT,                   -- only populated for group messages
  sender_lid      TEXT,                   -- alternative identifier in modern groups
  sender_name     TEXT,                   -- display name from WA DOM (may be null)
  text            TEXT,                   -- full message body (best-effort from DOM)
  timestamp_ms    INTEGER NOT NULL,       -- unix ms of the message
  session_id      INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts     ON messages(chat_phone, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_messages_session     ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_unassigned  ON messages(session_id) WHERE session_id IS NULL;

-- One row per 6h sliding-window conversation session.
CREATE TABLE IF NOT EXISTS sessions (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_phone                TEXT NOT NULL,
  chat_kind                 TEXT NOT NULL CHECK (chat_kind IN ('person','group')),
  contact_id                TEXT,                 -- outreach_logs.id once resolved
  started_at                INTEGER NOT NULL,     -- first message ts
  last_message_at           INTEGER NOT NULL,     -- updated every msg; window closes 6h after this
  closed_at                 INTEGER,              -- null = still open
  direction_first           TEXT NOT NULL CHECK (direction_first IN ('inbound','outbound')),
  message_count             INTEGER NOT NULL DEFAULT 0,
  summary                   TEXT,                 -- Gemini 2-line summary (filled on close)
  supabase_interaction_id   TEXT,                 -- set when synced to interactions table
  supabase_window_id        TEXT                  -- set when synced to extension_interaction_windows
);
CREATE INDEX IF NOT EXISTS idx_sessions_open
  ON sessions(chat_phone, closed_at) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_contact
  ON sessions(contact_id, last_message_at);

-- Async write queue for Supabase ops that fail (offline, 5xx, etc).
-- The sync worker drains this with exponential backoff.
CREATE TABLE IF NOT EXISTS sync_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  op            TEXT NOT NULL,    -- 'interaction:insert' | 'interaction:update_notes' | 'window:insert' | 'window:bump' | 'habit:bump'
  payload       TEXT NOT NULL,    -- JSON
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_attempt  INTEGER NOT NULL DEFAULT 0, -- unix ms; 0 = ready now
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_ready ON sync_queue(next_attempt);

-- Small generic k/v store for runtime state that shouldn't live in JSON files.
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
