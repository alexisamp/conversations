import { useCallback, useEffect, useRef, useState } from 'react'
import { ContactDetailScreen } from './ContactDetailScreen'
import type { ContactDetail } from '../conv-api'

type LookupState =
  | { kind: 'idle' }
  | { kind: 'no-active-chat' }
  | { kind: 'loading'; phone: string }
  | { kind: 'not-found'; phone: string; waName: string | null }
  | { kind: 'found'; contact: ContactDetail }
  | { kind: 'error'; message: string }

export function MainScreen({ email }: { email: string }) {
  const [phoneInput, setPhoneInput] = useState('')
  const [state, setState] = useState<LookupState>({ kind: 'no-active-chat' })
  // Track the last successful phone so writes can re-fetch.
  const lastHitPhoneRef = useRef<string | null>(null)
  // Track the auto-detected chat so we know when to re-fetch on writes.
  const autoChatRef = useRef<{ phone: string | null; name: string | null }>({
    phone: null,
    name: null,
  })

  const runLookup = useCallback(
    async (rawPhone: string, waName: string | null = null) => {
      setState({ kind: 'loading', phone: rawPhone })
      try {
        const contact = await window.conv.contact.byPhone(rawPhone)
        if (contact) {
          setState({ kind: 'found', contact })
          lastHitPhoneRef.current = rawPhone
        } else {
          setState({ kind: 'not-found', phone: rawPhone, waName })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Lookup failed'
        setState({ kind: 'error', message })
      }
    },
    [],
  )

  // Subscribe to active-chat changes from the WhatsApp preload.
  useEffect(() => {
    window.conv.chat.onChanged((event) => {
      autoChatRef.current = event
      if (event.phone) {
        runLookup(event.phone, event.name)
      } else {
        // Switched out of any chat (e.g. landed on the chat list / settings)
        setState({ kind: 'no-active-chat' })
        lastHitPhoneRef.current = null
      }
    })
  }, [runLookup])

  async function handleManualSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = phoneInput.trim()
    if (!trimmed) return
    await runLookup(trimmed)
  }

  async function handleRefresh() {
    if (lastHitPhoneRef.current) {
      await runLookup(lastHitPhoneRef.current, autoChatRef.current.name)
    }
  }

  async function handleSignOut() {
    await window.conv.auth.signOut()
  }

  return (
    <div className="main">
      <header className="main-header">
        <div className="email" title={email}>
          {email}
        </div>
        <button className="ghost-button" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      <details className="dev-lookup-collapsible">
        <summary>Manual lookup (dev)</summary>
        <form onSubmit={handleManualSubmit}>
          <input
            type="text"
            placeholder="+5215551234567"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
          />
          <button
            type="submit"
            disabled={state.kind === 'loading' || !phoneInput.trim()}
          >
            Look up
          </button>
        </form>
      </details>

      <div className="body">
        {state.kind === 'no-active-chat' && (
          <div className="empty">
            <strong>No active chat</strong>
            <div className="muted small">
              Open a WhatsApp conversation to see contact details.
            </div>
          </div>
        )}
        {state.kind === 'idle' && <div className="empty">Idle.</div>}
        {state.kind === 'loading' && (
          <div className="loading">Looking up {state.phone}…</div>
        )}
        {state.kind === 'not-found' && (
          <div className="empty">
            <strong>Not in reThink</strong>
            <div className="muted">{state.waName ?? state.phone}</div>
            <div className="muted small">{state.phone}</div>
            <div className="muted small">
              Mapping / create person coming in Phase 4.
            </div>
          </div>
        )}
        {state.kind === 'error' && <div className="error">{state.message}</div>}
        {state.kind === 'found' && (
          <ContactDetailScreen contact={state.contact} onRefresh={handleRefresh} />
        )}
      </div>
    </div>
  )
}
