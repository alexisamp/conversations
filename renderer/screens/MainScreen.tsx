import { useCallback, useEffect, useRef, useState } from 'react'
import { ContactDetailScreen } from './ContactDetailScreen'
import { GroupScreen } from './GroupScreen'
import type { ContactDetail, GroupParticipant } from '../conv-api'

type LookupState =
  | { kind: 'idle' }
  | { kind: 'no-active-chat' }
  | { kind: 'loading-person'; phone: string }
  | { kind: 'person-not-found'; phone: string; waName: string | null }
  | { kind: 'person-found'; contact: ContactDetail }
  | {
      kind: 'group'
      groupId: string
      name: string | null
      participants: GroupParticipant[]
    }
  | { kind: 'error'; message: string }

export function MainScreen({ email }: { email: string }) {
  const [phoneInput, setPhoneInput] = useState('')
  const [state, setState] = useState<LookupState>({ kind: 'no-active-chat' })
  const lastHitPhoneRef = useRef<string | null>(null)

  const runPersonLookup = useCallback(
    async (rawPhone: string, waName: string | null = null) => {
      setState({ kind: 'loading-person', phone: rawPhone })
      try {
        const contact = await window.conv.contact.byPhone(rawPhone)
        if (contact) {
          setState({ kind: 'person-found', contact })
          lastHitPhoneRef.current = rawPhone
        } else {
          setState({ kind: 'person-not-found', phone: rawPhone, waName })
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
      if (event.kind === 'none') {
        setState({ kind: 'no-active-chat' })
        lastHitPhoneRef.current = null
        return
      }
      if (event.kind === 'person') {
        runPersonLookup(event.phone, event.name)
        return
      }
      // group
      setState({
        kind: 'group',
        groupId: event.groupId,
        name: event.name,
        participants: event.participants,
      })
      lastHitPhoneRef.current = null
    })
  }, [runPersonLookup])

  async function handleManualSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = phoneInput.trim()
    if (!trimmed) return
    await runPersonLookup(trimmed)
  }

  async function handleRefresh() {
    if (lastHitPhoneRef.current) {
      await runPersonLookup(lastHitPhoneRef.current)
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
            disabled={state.kind === 'loading-person' || !phoneInput.trim()}
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
        {state.kind === 'loading-person' && (
          <div className="loading">Looking up {state.phone}…</div>
        )}
        {state.kind === 'person-not-found' && (
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
        {state.kind === 'person-found' && (
          <ContactDetailScreen contact={state.contact} onRefresh={handleRefresh} />
        )}
        {state.kind === 'group' && (
          <GroupScreen
            groupId={state.groupId}
            groupName={state.name}
            participants={state.participants}
          />
        )}
      </div>
    </div>
  )
}
