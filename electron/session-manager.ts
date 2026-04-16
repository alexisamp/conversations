// SessionManager — sliding-window 6h session pipeline.
//
// One session per (chatPhone). When a new message arrives:
//   - If there's an open session for that chat → bump it (reset the 6h timer)
//   - If not → create a new session, enqueue 'interaction:insert' to sync_queue
//
// When the 6h timer expires (no new messages for 6 hours):
//   - Close the session locally
//   - Run GeminiSummarizer on the session's messages → get 2-line summary
//   - Enqueue 'interaction:update_notes' with the summary to sync_queue
//
// On app startup, any sessions that were left open (e.g., app crashed) are
// recovered: if their last_message_at + 6h < now, close them immediately
// (with summary); otherwise restart their timers for the remaining time.

import {
  findOpenSession,
  createSession,
  bumpSession,
  closeSession,
  sessionsStillOpen,
  enqueueSync,
  recentMessagesForSession,
  type SessionRow,
  type MessageInput,
} from './db/local'
import { summarizeSession } from './ai/gemini'

const SESSION_WINDOW_MS = 6 * 60 * 60 * 1000 // 6 hours

// In-memory timers keyed by chatPhone. When the timer fires → closeAndSummarize.
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Dev shortcut: set CONV_SESSION_WINDOW_SECONDS env to use a shorter window
// for testing (e.g., 30 seconds instead of 6 hours).
function getWindowMs(): number {
  const override = process.env.CONV_SESSION_WINDOW_SECONDS
  if (override) {
    const secs = parseInt(override, 10)
    if (secs > 0) return secs * 1000
  }
  return SESSION_WINDOW_MS
}

/**
 * Called by the main process for every captured 1-on-1 message.
 * Returns the session_id the message was assigned to.
 */
export function handleMessage(msg: MessageInput, contactId: string | null): number {
  const chatPhone = msg.chat_phone
  const windowMs = getWindowMs()

  let session = findOpenSession(chatPhone)

  if (session) {
    // Bump existing session
    bumpSession(session.id, msg.timestamp_ms)
    resetTimer(chatPhone, session.id, windowMs)
    console.log(
      '[session] bumped session=%d chat=%s count=%d',
      session.id,
      chatPhone,
      session.message_count + 1,
    )
    return session.id
  }

  // Create new session
  const sessionId = createSession({
    chat_phone: chatPhone,
    chat_kind: msg.chat_kind,
    contact_id: contactId,
    started_at: msg.timestamp_ms,
    direction_first: msg.direction,
  })
  // Bump count to 1 (createSession starts at 0)
  bumpSession(sessionId, msg.timestamp_ms)

  console.log(
    '[session] opened session=%d chat=%s contact=%s dir=%s',
    sessionId,
    chatPhone,
    contactId ?? 'unmapped',
    msg.direction,
  )

  // Enqueue the interaction insert so SupabaseSync can write it.
  // We create the interaction NOW (not at close) so health_score updates
  // immediately — the user sees the score bump as soon as they chat.
  if (contactId) {
    enqueueSync('interaction:insert', {
      session_id: sessionId,
      contact_id: contactId,
      type: 'whatsapp',
      direction: msg.direction,
      interaction_date: new Date(msg.timestamp_ms).toISOString().slice(0, 10),
    })
    enqueueSync('window:insert', {
      session_id: sessionId,
      contact_id: contactId,
      channel: 'whatsapp',
      window_start: new Date(msg.timestamp_ms).toISOString(),
      window_end: new Date(msg.timestamp_ms + windowMs).toISOString(),
      direction: msg.direction,
    })
  }

  resetTimer(chatPhone, sessionId, windowMs)
  return sessionId
}

/**
 * Resets (or starts) the close timer for a session. Every new message
 * calls this, which is what makes the window "sliding".
 */
function resetTimer(chatPhone: string, sessionId: number, windowMs: number): void {
  const existing = activeTimers.get(chatPhone)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(() => {
    activeTimers.delete(chatPhone)
    void closeAndSummarize(sessionId, chatPhone)
  }, windowMs)

  activeTimers.set(chatPhone, timer)
}

/**
 * Closes a session and generates a Gemini summary of its messages.
 */
async function closeAndSummarize(
  sessionId: number,
  chatPhone: string,
): Promise<void> {
  const now = Date.now()
  console.log('[session] closing session=%d chat=%s', sessionId, chatPhone)

  // Get all messages for this session
  const messages = recentMessagesForSession(sessionId)
  if (messages.length === 0) {
    closeSession(sessionId, now, null)
    console.log('[session] closed session=%d (no messages)', sessionId)
    return
  }

  // Build conversation text for Gemini
  const conversationText = messages
    .map((m) => {
      const dir = m.direction === 'outbound' ? 'Yo' : m.sender_name ?? 'Ellos'
      return `${dir}: ${m.text ?? '(media)'}`
    })
    .join('\n')

  let summary: string | null = null
  try {
    summary = await summarizeSession(conversationText)
    console.log('[session] summary for session=%d: "%s"', sessionId, summary)
  } catch (err) {
    console.error('[session] summarize failed for session=%d:', sessionId, err)
  }

  closeSession(sessionId, now, summary)

  // Enqueue the notes update so SupabaseSync writes the summary to interactions
  const session = findOpenSession(chatPhone) // won't find it (just closed)
  // We need the session row to get supabase_interaction_id — but it's
  // not set yet (SupabaseSync hasn't drained the queue). Instead, enqueue
  // with session_id and let SupabaseSync correlate when it processes.
  enqueueSync('interaction:update_notes', {
    session_id: sessionId,
    notes: summary,
  })

  console.log('[session] closed session=%d summary=%s', sessionId, summary ? 'yes' : 'no')
}

/**
 * Called once on app startup. Recovers any sessions that were left open
 * (e.g., app crashed or was quit while a session was active).
 */
export function recoverOpenSessions(): void {
  const open = sessionsStillOpen()
  if (open.length === 0) return
  console.log('[session] recovering %d open sessions from previous run', open.length)

  const now = Date.now()
  const windowMs = getWindowMs()

  for (const session of open) {
    const elapsed = now - session.last_message_at
    if (elapsed >= windowMs) {
      // Window already expired while app was closed → close immediately
      void closeAndSummarize(session.id, session.chat_phone)
    } else {
      // Window still active → restart timer for the remaining time
      const remaining = windowMs - elapsed
      console.log(
        '[session] resuming session=%d chat=%s remaining=%ds',
        session.id,
        session.chat_phone,
        Math.round(remaining / 1000),
      )
      resetTimer(session.chat_phone, session.id, remaining)
    }
  }
}
