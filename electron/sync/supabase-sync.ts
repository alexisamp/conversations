// SupabaseSync — drains the local sync_queue and writes to Supabase.
//
// Runs on a poll interval (default 10s). Each tick:
//   1. SELECT rows from sync_queue WHERE next_attempt <= now(), ordered by id
//   2. For each row, execute the appropriate Supabase write
//   3. On success → DELETE the row
//   4. On failure → increment attempts, set next_attempt with exponential
//      backoff, store last_error for debugging
//
// Operations supported:
//   - interaction:insert      → INSERT into interactions, store the returned
//                                id back into sessions.supabase_interaction_id
//   - interaction:update_notes → UPDATE interactions SET notes = ? WHERE id = ?
//   - window:insert           → INSERT into extension_interaction_windows
//   - window:bump             → UPDATE extension_interaction_windows SET
//                                message_count + 1
//   - habit:bump              → call updateNetworkingHabit logic
//
// Designed to be crash-safe: all state is in SQLite. If the app quits
// mid-sync, the rows stay in sync_queue and get retried on next boot.

import { getSupabase } from '../supabase/client'
import { getDb } from '../db/local'

const POLL_INTERVAL_MS = 10_000 // 10 seconds
const MAX_ATTEMPTS = 10
const BASE_BACKOFF_MS = 5_000 // 5s, 10s, 20s, 40s, ...

let pollTimer: ReturnType<typeof setInterval> | null = null
let processing = false

type QueueRow = {
  id: number
  op: string
  payload: string
  attempts: number
  last_error: string | null
  next_attempt: number
  created_at: number
}

export function startSync(): void {
  if (pollTimer) return
  console.log('[sync] starting sync worker (poll every %ds)', POLL_INTERVAL_MS / 1000)
  // Run once immediately, then on interval
  void drainQueue()
  pollTimer = setInterval(() => void drainQueue(), POLL_INTERVAL_MS)
}

export function stopSync(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function drainQueue(): Promise<void> {
  if (processing) return // guard against overlapping ticks
  processing = true
  try {
    const db = getDb()
    const now = Date.now()
    const rows = db
      .prepare(
        'SELECT * FROM sync_queue WHERE next_attempt <= ? ORDER BY id ASC LIMIT 20',
      )
      .all(now) as QueueRow[]

    if (rows.length === 0) {
      processing = false
      return
    }

    console.log('[sync] processing %d queued ops', rows.length)

    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload)
        await processOp(row.op, payload, row)
        // Success → delete from queue
        db.prepare('DELETE FROM sync_queue WHERE id = ?').run(row.id)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const nextAttempt =
          row.attempts + 1 >= MAX_ATTEMPTS
            ? now + 24 * 60 * 60 * 1000 // park for 24h after max retries
            : now + BASE_BACKOFF_MS * Math.pow(2, row.attempts)

        db.prepare(
          'UPDATE sync_queue SET attempts = attempts + 1, last_error = ?, next_attempt = ? WHERE id = ?',
        ).run(errMsg, nextAttempt, row.id)

        console.error(
          '[sync] op=%s id=%d failed (attempt %d): %s',
          row.op,
          row.id,
          row.attempts + 1,
          errMsg,
        )
      }
    }
  } finally {
    processing = false
  }
}

async function processOp(
  op: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
  row: QueueRow,
): Promise<void> {
  const supabase = getSupabase()
  const db = getDb()

  switch (op) {
    case 'interaction:insert': {
      // Get the user_id from the current Supabase session
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) throw new Error('Not signed in')
      const userId = session.user.id

      const interactionDate =
        payload.interaction_date ?? new Date().toISOString().slice(0, 10)

      const { data: inserted, error } = await supabase
        .from('interactions')
        .insert({
          user_id: userId,
          contact_id: payload.contact_id,
          type: payload.type ?? 'whatsapp',
          direction: payload.direction ?? 'outbound',
          notes: null, // filled later by interaction:update_notes
          interaction_date: interactionDate,
        })
        .select('id')
        .single()

      if (error) throw new Error(error.message)

      // Store the Supabase interaction id back in the local session row
      if (payload.session_id && inserted?.id) {
        db.prepare(
          'UPDATE sessions SET supabase_interaction_id = ? WHERE id = ?',
        ).run(inserted.id, payload.session_id)
      }

      // Also bump last_interaction_at on the contact
      const nowIso = new Date().toISOString()
      await supabase
        .from('outreach_logs')
        .update({ last_interaction_at: nowIso, updated_at: nowIso })
        .eq('id', payload.contact_id)

      console.log(
        '[sync] interaction:insert OK → supabase_id=%s contact=%s',
        inserted?.id,
        payload.contact_id,
      )
      break
    }

    case 'interaction:update_notes': {
      // Look up the supabase_interaction_id from the local session
      const session = db
        .prepare('SELECT supabase_interaction_id FROM sessions WHERE id = ?')
        .get(payload.session_id) as { supabase_interaction_id: string | null } | undefined

      const interactionId = session?.supabase_interaction_id
      if (!interactionId) {
        // The interaction:insert hasn't been synced yet. Re-queue by throwing.
        throw new Error(
          'interaction not yet synced for session ' + payload.session_id,
        )
      }

      const { error } = await supabase
        .from('interactions')
        .update({ notes: payload.notes })
        .eq('id', interactionId)

      if (error) throw new Error(error.message)

      console.log(
        '[sync] interaction:update_notes OK → id=%s notes="%s"',
        interactionId,
        (payload.notes ?? '').slice(0, 50),
      )
      break
    }

    case 'window:insert': {
      const {
        data: { session: authSession },
      } = await supabase.auth.getSession()
      if (!authSession) throw new Error('Not signed in')
      const userId = authSession.user.id

      // Look up the supabase_interaction_id
      const localSession = db
        .prepare('SELECT supabase_interaction_id FROM sessions WHERE id = ?')
        .get(payload.session_id) as { supabase_interaction_id: string | null } | undefined

      const interactionId = localSession?.supabase_interaction_id
      if (!interactionId) {
        throw new Error(
          'interaction not yet synced for session ' + payload.session_id,
        )
      }

      const { data: inserted, error } = await supabase
        .from('extension_interaction_windows')
        .insert({
          user_id: userId,
          contact_id: payload.contact_id,
          interaction_id: interactionId,
          channel: payload.channel ?? 'whatsapp',
          window_start: payload.window_start,
          window_end: payload.window_end,
          direction: payload.direction ?? 'outbound',
          message_count: 1,
        })
        .select('id')
        .single()

      if (error) throw new Error(error.message)

      if (payload.session_id && inserted?.id) {
        db.prepare(
          'UPDATE sessions SET supabase_window_id = ? WHERE id = ?',
        ).run(inserted.id, payload.session_id)
      }

      console.log('[sync] window:insert OK → id=%s', inserted?.id)
      break
    }

    case 'window:bump': {
      // Increment message_count on the Supabase window row
      const localSession = db
        .prepare('SELECT supabase_window_id FROM sessions WHERE id = ?')
        .get(payload.session_id) as { supabase_window_id: string | null } | undefined

      const windowId = localSession?.supabase_window_id
      if (!windowId) {
        throw new Error(
          'window not yet synced for session ' + payload.session_id,
        )
      }

      // Supabase doesn't support atomic increment via JS client easily;
      // we'll just update to the current local count.
      const localCount = db
        .prepare('SELECT message_count FROM sessions WHERE id = ?')
        .get(payload.session_id) as { message_count: number } | undefined

      const { error } = await supabase
        .from('extension_interaction_windows')
        .update({
          message_count: localCount?.message_count ?? 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', windowId)

      if (error) throw new Error(error.message)
      console.log('[sync] window:bump OK → id=%s count=%d', windowId, localCount?.message_count)
      break
    }

    case 'habit:bump': {
      // TODO: port updateNetworkingHabit logic from the extension
      console.log('[sync] habit:bump — not yet implemented, skipping')
      break
    }

    default:
      console.warn('[sync] unknown op:', op)
  }
}
