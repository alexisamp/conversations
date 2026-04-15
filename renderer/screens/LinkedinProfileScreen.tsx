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
  const [creating, setCreating] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

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

  async function refetch() {
    setLookup({ kind: 'loading' })
    const contact = await window.conv.contact.byLinkedinUrl(state.url)
    if (contact) setLookup({ kind: 'found', contact })
    else setLookup({ kind: 'not-found' })
  }

  async function handleCreate() {
    if (!state.name) {
      setCreateError('Waiting for profile name to load…')
      return
    }
    setCreating(true)
    setCreateError(null)
    const result = await window.conv.contact.createFromLinkedinProfile({
      url: state.url,
      name: state.name,
      jobTitle: state.jobTitle,
    })
    setCreating(false)
    if (result.ok) {
      await refetch()
    } else {
      setCreateError(result.error)
    }
  }

  async function handleEnrich(contact: ContactDetail) {
    setEnriching(true)
    await window.conv.contact.enrichFromLinkedinProfile({
      contact_id: contact.id,
      name: state.name,
      jobTitle: state.jobTitle,
    })
    setEnriching(false)
    await refetch()
  }

  if (lookup.kind === 'loading') {
    return <div className="loading">Looking up {state.name ?? state.slug}…</div>
  }
  if (lookup.kind === 'error') {
    return <div className="error">{lookup.message}</div>
  }
  if (lookup.kind === 'found') {
    // Highlight missing fields that the scraped profile could fill.
    const missingJobTitle = !lookup.contact.job_title && !!state.jobTitle
    const canEnrich = missingJobTitle
    return (
      <div className="li-found">
        {canEnrich && (
          <div className="li-enrich-banner">
            <div className="li-enrich-text">
              Scraped from this profile:{' '}
              {state.jobTitle && <strong>{state.jobTitle}</strong>}
            </div>
            <button
              className="tiny-action primary"
              disabled={enriching}
              onClick={() => handleEnrich(lookup.contact)}
            >
              {enriching ? 'Enriching…' : 'Fill missing fields'}
            </button>
          </div>
        )}
        <ContactDetailScreen contact={lookup.contact} onRefresh={refetch} />
      </div>
    )
  }

  // not-found → show preview + create button
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
          Data scraped live from the LinkedIn profile in your authenticated
          session.
        </div>
      </div>

      <div className="li-empty-actions">
        <button
          className="primary"
          disabled={creating || !state.name}
          onClick={handleCreate}
        >
          {creating ? 'Creating…' : '+ Create in reThink'}
        </button>
        {!state.name && (
          <div className="muted small">
            Waiting for LinkedIn to finish loading the profile…
          </div>
        )}
        {createError && <div className="form-error">{createError}</div>}
      </div>
    </div>
  )
}
