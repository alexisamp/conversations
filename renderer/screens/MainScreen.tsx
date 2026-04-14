import { useCallback, useState } from 'react'
import { ContactDetailScreen } from './ContactDetailScreen'
import type { ContactDetail } from '../conv-api'

type LookupState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'not-found'; phone: string }
  | { kind: 'found'; contact: ContactDetail }
  | { kind: 'error'; message: string }

export function MainScreen({ email }: { email: string }) {
  const [phone, setPhone] = useState('')
  const [state, setState] = useState<LookupState>({ kind: 'idle' })
  // Remember the last phone that produced a hit so we can re-fetch after a write.
  const [lastHitPhone, setLastHitPhone] = useState<string | null>(null)

  const runLookup = useCallback(async (rawPhone: string) => {
    setState({ kind: 'loading' })
    try {
      const contact = await window.conv.contact.byPhone(rawPhone)
      if (contact) {
        setState({ kind: 'found', contact })
        setLastHitPhone(rawPhone)
      } else {
        setState({ kind: 'not-found', phone: rawPhone })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lookup failed'
      setState({ kind: 'error', message })
    }
  }, [])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = phone.trim()
    if (!trimmed) return
    await runLookup(trimmed)
  }

  async function handleRefresh() {
    if (lastHitPhone) await runLookup(lastHitPhone)
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

      <div className="dev-lookup">
        <div className="dev-label">Phase 1 dev — look up by phone</div>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="+5215551234567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button type="submit" disabled={state.kind === 'loading' || !phone.trim()}>
            {state.kind === 'loading' ? '…' : 'Look up'}
          </button>
        </form>
      </div>

      <div className="body">
        {state.kind === 'idle' && (
          <div className="empty">Type a phone number to look up a reThink contact.</div>
        )}
        {state.kind === 'loading' && <div className="loading">Looking up…</div>}
        {state.kind === 'not-found' && (
          <div className="empty">
            <strong>No reThink contact</strong>
            <div className="muted">{state.phone}</div>
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
