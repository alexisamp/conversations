import { useCallback, useEffect, useRef, useState } from 'react'
import { ContactDetailScreen } from './ContactDetailScreen'
import { GroupScreen } from './GroupScreen'
import { LinkedinProfileScreen } from './LinkedinProfileScreen'
import { MapParticipantModal } from './MapParticipantModal'
import { SettingsScreen } from './SettingsScreen'
import type { ContactDetail, GroupParticipant, SidebarContext } from '../conv-api'

type PersonLookupState =
  | { kind: 'idle' }
  | { kind: 'loading'; phone: string | null; name: string | null }
  | { kind: 'not-found'; phone: string | null; waName: string | null }
  | { kind: 'found'; contact: ContactDetail }
  | { kind: 'error'; message: string }

export function MainScreen({ email }: { email: string }) {
  const [phoneInput, setPhoneInput] = useState('')
  const [context, setContext] = useState<SidebarContext>({
    tab: 'wa',
    state: { kind: 'none' },
  })
  const [personLookup, setPersonLookup] = useState<PersonLookupState>({ kind: 'idle' })
  const [view, setView] = useState<'main' | 'settings'>('main')
  const lastHitPhoneRef = useRef<string | null>(null)

  const runPersonLookup = useCallback(
    async (rawPhone: string | null, waName: string | null = null) => {
      setPersonLookup({ kind: 'loading', phone: rawPhone, name: waName })
      try {
        lastHitPhoneRef.current = rawPhone ?? waName
        // Resolution order: phone (most reliable) → name (fallback for saved
        // contacts on WA's new DOM that hides phones).
        let contact: ContactDetail | null = null
        if (rawPhone) {
          contact = await window.conv.contact.byPhone(rawPhone)
        }
        if (!contact && waName) {
          contact = await window.conv.contact.byName(waName)
        }
        if (contact) {
          setPersonLookup({ kind: 'found', contact })
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
    if (!lastHitPhoneRef.current) return
    const looksLikePhone = /^\+?\d/.test(lastHitPhoneRef.current)
    if (looksLikePhone) {
      await runPersonLookup(lastHitPhoneRef.current, null)
    } else {
      await runPersonLookup(null, lastHitPhoneRef.current)
    }
  }

  async function handleSignOut() {
    await window.conv.auth.signOut()
  }

  if (view === 'settings') {
    return <SettingsScreen onBack={() => setView('main')} />
  }

  return (
    <div className="main">
      <header className="main-header">
        <div className="email" title={email}>
          {email}
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            onClick={() => setView('settings')}
            title="Settings"
            aria-label="Settings"
          >
            ⚙︎
          </button>
          <button className="ghost-button" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
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
        <PersonNotFound
          phone={personLookup.phone}
          waName={personLookup.waName}
          onCreated={() => onRefreshPerson()}
        />
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

// ─── Not-found card with "Add to reThink" ──────────────────────────

function PersonNotFound({
  phone,
  waName,
  onCreated,
}: {
  phone: string | null
  waName: string | null
  onCreated: () => void
}) {
  const [showModal, setShowModal] = useState(false)

  // Build a virtual GroupParticipant so we can reuse MapParticipantModal
  const participant: GroupParticipant = {
    phone,
    lid: null,
    waName,
    avatarDataUrl: null,
  }

  function handleDone() {
    setShowModal(false)
    // Invalidate the phone→contactId cache in the main process so
    // the next WA message picks up the new contactId and sessions
    // get properly linked.
    if (phone) window.conv.wa.invalidatePhoneCache(phone)
    onCreated()
  }

  return (
    <div className="not-found-card">
      <div className="not-found-header">
        <div className="not-found-name">{waName ?? phone}</div>
        <div className="not-found-phone">{phone}</div>
      </div>
      <div className="not-found-body">
        <strong>Not in reThink</strong>
        <div className="muted small">
          Add this contact to start tracking interactions and health score.
        </div>
        <button
          className="not-found-add-btn"
          onClick={() => setShowModal(true)}
        >
          + Add to reThink
        </button>
      </div>
      {showModal && (
        <MapParticipantModal
          participant={participant}
          onClose={() => setShowModal(false)}
          onDone={handleDone}
        />
      )}
    </div>
  )
}
