import { useEffect, useState } from 'react'
import type { ContactDetail, LiState } from '../conv-api'
import { ContactDetailScreen } from './ContactDetailScreen'
import { initialsOf } from '../lib/contact-helpers'

type Props = {
  state: Extract<LiState, { kind: 'profile' }>
}

type LookupState =
  | { kind: 'loading' }
  | { kind: 'found'; contact: ContactDetail }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }

export function LinkedinProfileScreen({ state }: Props) {
  const [lookup, setLookup] = useState<LookupState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setLookup({ kind: 'loading' })
    window.conv.contact
      .byLinkedinUrl(state.url)
      .then((contact) => {
        if (cancelled) return
        if (contact) setLookup({ kind: 'found', contact })
        else setLookup({ kind: 'not-found' })
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : 'Lookup failed'
        setLookup({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [state.url])

  if (lookup.kind === 'loading') {
    return <div className="loading">Looking up {state.name ?? state.slug}…</div>
  }
  if (lookup.kind === 'error') {
    return <div className="error">{lookup.message}</div>
  }
  if (lookup.kind === 'found') {
    return (
      <ContactDetailScreen
        contact={lookup.contact}
        onRefresh={() => {
          // re-fetch
          setLookup({ kind: 'loading' })
          window.conv.contact.byLinkedinUrl(state.url).then((c) => {
            if (c) setLookup({ kind: 'found', contact: c })
          })
        }}
      />
    )
  }

  // not-found → compact preview + guidance
  return (
    <div className="li-empty">
      <div className="li-empty-header">
        <div className="avatar">
          {state.avatarDataUrl ? (
            <img src={state.avatarDataUrl} alt={state.name ?? 'profile'} />
          ) : (
            <div className="avatar-initials">
              {initialsOf(state.name ?? state.slug)}
            </div>
          )}
        </div>
        <div className="li-empty-info">
          <div className="li-empty-name">{state.name ?? state.slug}</div>
          {state.jobTitle && (
            <div className="li-empty-title">{state.jobTitle}</div>
          )}
        </div>
      </div>
      <div className="empty">
        <strong>Not in reThink</strong>
        <div className="muted small">
          Merge / create flow coming in the next iteration.
        </div>
        <a
          className="chip chip-link"
          href={state.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ marginTop: 10, display: 'inline-block' }}
        >
          Open profile
        </a>
      </div>
    </div>
  )
}
