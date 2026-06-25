import { useEffect, useMemo, useState } from 'react'
import type { LinkedinConversation, LinkedinMessage } from '../conv-api'
import { initialsOf } from '../lib/contact-helpers'

type ThreadState =
  | { kind: 'idle' }
  | { kind: 'loading'; conversationId: string }
  | { kind: 'loaded'; conversationId: string; messages: LinkedinMessage[] }
  | { kind: 'error'; conversationId: string; message: string }

export function LinkedinMessagesScreen() {
  const [conversations, setConversations] = useState<LinkedinConversation[]>([])
  const [authenticated, setAuthenticated] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [thread, setThread] = useState<ThreadState>({ kind: 'idle' })
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadInbox() {
    const inbox = await window.conv.linkedin.getInbox()
    setAuthenticated(inbox.authenticated)
    setConversations(inbox.conversations)
    return inbox
  }

  async function syncInbox() {
    setSyncing(true)
    setError(null)
    try {
      await window.conv.linkedin.syncInbox()
      await loadInbox()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LinkedIn sync failed'
      if (/not authenticated|session|sign in/i.test(message)) {
        setAuthenticated(false)
        setError(null)
      } else {
        setError(message)
      }
      await loadInbox().catch(() => {})
    } finally {
      setSyncing(false)
    }
  }

  async function selectConversation(conversation: LinkedinConversation) {
    setSelectedId(conversation.id)
    setThread({ kind: 'loading', conversationId: conversation.id })
    void window.conv.linkedin.selectConversation(conversation.id).catch((err) => {
      console.warn('LinkedIn sidebar context failed', err)
    })
    try {
      const result = await window.conv.linkedin.getThread(conversation.id)
      setThread({
        kind: 'loaded',
        conversationId: conversation.id,
        messages: result.messages,
      })
      await loadInbox()
    } catch (err) {
      setThread({
        kind: 'error',
        conversationId: conversation.id,
        message: err instanceof Error ? err.message : 'Thread failed',
      })
    }
  }

  useEffect(() => {
    void loadInbox()
    return window.conv.linkedin.onUpdated(() => {
      void loadInbox()
    })
  }, [])

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  )

  return (
    <div className="li-messages-shell">
      <aside className="li-inbox">
        <div className="li-inbox-header">
          <div>
            <strong>LinkedIn</strong>
            <span>{conversations.length} conversations</span>
          </div>
          <button onClick={syncInbox} disabled={syncing}>
            {syncing ? 'Syncing' : 'Sync'}
          </button>
        </div>
        {!authenticated && (
          <div className="li-inbox-warning">
            <span>LinkedIn session expired. Cached chats are shown.</span>
            <button onClick={() => window.conv.linkedin.showSignin()}>
              Sign in
            </button>
          </div>
        )}
        {error && <div className="li-inbox-error">{error}</div>}
        <div className="li-conversation-list">
          {conversations.length === 0 && !syncing ? (
            <div className="li-empty-list">No LinkedIn messages cached yet.</div>
          ) : (
            conversations.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                selected={conversation.id === selectedId}
                onClick={() => selectConversation(conversation)}
              />
            ))
          )}
        </div>
      </aside>
      <main className="li-thread">
        {!selected ? (
          <div className="li-thread-empty">Select a LinkedIn chat.</div>
        ) : thread.kind === 'loading' ? (
          <div className="li-thread-empty">Loading thread...</div>
        ) : thread.kind === 'error' ? (
          <div className="li-thread-empty">{thread.message}</div>
        ) : (
          <ThreadView conversation={selected} messages={thread.kind === 'loaded' ? thread.messages : []} />
        )}
      </main>
    </div>
  )
}

function ConversationRow({
  conversation,
  selected,
  onClick,
}: {
  conversation: LinkedinConversation
  selected: boolean
  onClick: () => void
}) {
  const names = parseList(conversation.participant_names)
  const pictures = parseList(conversation.participant_pictures)
  const name = names.join(', ') || 'Unknown'
  const picture = pictures.find(Boolean) ?? null
  return (
    <button className={`li-conversation-row ${selected ? 'selected' : ''}`} onClick={onClick}>
      <Avatar name={name} src={picture} />
      <span className="li-row-main">
        <span className="li-row-top">
          <strong>{name}</strong>
          <time>{formatAgo(conversation.last_activity_at)}</time>
        </span>
        <span className="li-row-preview">{conversation.last_message || 'No preview'}</span>
      </span>
      {!conversation.read && <span className="li-unread-dot" />}
    </button>
  )
}

function ThreadView({
  conversation,
  messages,
}: {
  conversation: LinkedinConversation
  messages: LinkedinMessage[]
}) {
  const names = parseList(conversation.participant_names)
  const title = names.join(', ') || 'LinkedIn conversation'
  const fallbackPreview = conversation.last_message?.trim() || null
  return (
    <>
      <header className="li-thread-header">
        <div>
          <strong>{title}</strong>
          <span>{messages.length > 0 ? `${messages.length} messages` : 'Cached preview'}</span>
        </div>
      </header>
      <div className="li-message-list">
        {messages.length === 0 ? (
          fallbackPreview ? (
            <div className="li-message theirs">
              <div className="li-message-meta">
                <span>{title}</span>
                <time>{formatMessageTime(conversation.last_activity_at)}</time>
              </div>
              <div className="li-message-bubble">{fallbackPreview}</div>
            </div>
          ) : (
            <div className="li-thread-empty">No messages cached for this thread yet.</div>
          )
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`li-message ${message.is_from_me ? 'mine' : 'theirs'}`}>
              <div className="li-message-meta">
                <span>{message.is_from_me ? 'Me' : message.sender_name || title}</span>
                <time>{formatMessageTime(message.created_at_ms)}</time>
              </div>
              <div className="li-message-bubble">{message.body || 'Attachment'}</div>
            </div>
          ))
        )}
      </div>
    </>
  )
}

function Avatar({ name, src }: { name: string; src: string | null }) {
  return (
    <span className="li-avatar">
      {src ? <img src={src} alt={name} /> : <span>{initialsOf(name)}</span>}
    </span>
  )
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function formatAgo(timestamp: number) {
  if (!timestamp) return ''
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000))
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function formatMessageTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp))
}
