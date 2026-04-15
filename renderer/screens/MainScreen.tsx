import { useCallback, useEffect, useRef, useState } from 'react'
import { ContactDetailScreen } from './ContactDetailScreen'
import { GroupScreen } from './GroupScreen'
import { LinkedinProfileScreen } from './LinkedinProfileScreen'
import type { ContactDetail, SidebarContext } from '../conv-api'

type PersonLookupState =
  | { kind: 'idle' }
  | { kind: 'loading'; phone: string }
  | { kind: 'not-found'; phone: string; waName: string | null }
  | { kind: 'found'; contact: ContactDetail }
  | { kind: 'error'; message: string }

export function MainScreen({ email }: { email: string }) {
  const [phoneInput, setPhoneInput] = useState('')
  const [context, setContext] = useState<SidebarContext>({
    tab: 'wa',
    state: { kind: 'none' },
  })
  const [personLookup, setPersonLookup] = useState<PersonLookupState>({ kind: 'idle' })
  const lastHitPhoneRef = useRef<string | null>(null)

  const runPersonLookup = useCallback(
    async (rawPhone: string, waName: string | null = null) => {
      setPersonLookup({ kind: 'loading', phone: rawPhone })
      try {
        const contact = await window.conv.contact.byPhone(rawPhone)
        if (contact) {
          setPersonLookup({ kind: 'found', contact })
          lastHitPhoneRef.current = rawPhone
        } else {
          setPersonLookup({ kind: 'not-found', phone: rawPhone, waName })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Lookup failed'
        setPersonLookup({ kind: 'error', message })
      }
    },
    [],
  )

  // Subscribe to the unified sidebar-context events from main.
  useEffect(() => {
    window.conv.sidebar.onContext((ctx) => {
      setContext(ctx)
      if (ctx.tab === 'wa' && ctx.state.kind === 'person') {
        runPersonLookup(ctx.state.phone, ctx.state.name)
      } else if (ctx.tab === 'wa' && ctx.state.kind === 'none') {
        setPersonLookup({ kind: 'idle' })
        lastHitPhoneRef.current = null
      }
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
            disabled={personLookup.kind === 'loading' || !phoneInput.trim()}
          >
            Look up
          </button>
        </form>
      </details>

      <div className="body">
        <Body
          context={context}
          personLookup={personLookup}
          onRefreshPerson={handleRefresh}
        />
      </div>
    </div>
  )
}

// ─── Body router ──────────────────────────────────────────────────────

function Body({
  context,
  personLookup,
  onRefreshPerson,
}: {
  context: SidebarContext
  personLookup: PersonLookupState
  onRefreshPerson: () => void
}) {
  if (context.tab === 'wa') {
    if (context.state.kind === 'none') {
      return (
        <div className="empty">
          <strong>No active chat</strong>
          <div className="muted small">
            Open a WhatsApp conversation to see contact details.
          </div>
        </div>
      )
    }
    if (context.state.kind === 'group') {
      return (
        <GroupScreen
          groupId={context.state.groupId}
          groupName={context.state.name}
          participants={context.state.participants}
        />
      )
    }
    // kind === 'person' → show the personLookup state
    if (personLookup.kind === 'loading') {
      return <div className="loading">Looking up {personLookup.phone}…</div>
    }
    if (personLookup.kind === 'not-found') {
      return (
        <div className="empty">
          <strong>Not in reThink</strong>
          <div className="muted">{personLookup.waName ?? personLookup.phone}</div>
          <div className="muted small">{personLookup.phone}</div>
        </div>
      )
    }
    if (personLookup.kind === 'error') {
      return <div className="error">{personLookup.message}</div>
    }
    if (personLookup.kind === 'found') {
      return (
        <ContactDetailScreen
          contact={personLookup.contact}
          onRefresh={onRefreshPerson}
        />
      )
    }
    return <div className="empty">Idle.</div>
  }

  // LinkedIn tab
  if (context.state.kind === 'none') {
    return (
      <div className="empty">
        <strong>LinkedIn</strong>
        <div className="muted small">
          Open a profile page to see the contact in reThink.
        </div>
      </div>
    )
  }
  return <LinkedinProfileScreen state={context.state} />
}
