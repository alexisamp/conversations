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
      company: state.company,
      location: state.location,
      about: state.about,
      photoUrl: state.photoUrl,
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
      company: state.company,
      location: state.location,
      about: state.about,
      photoUrl: state.photoUrl,
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
    // Compute which fields the scrape could fill (for the banner hint).
    const contact = lookup.contact
    const fillableFields: string[] = []
    if (!contact.job_title && state.jobTitle) fillableFields.push('job title')
    if (!contact.company && state.jobTitle?.match(/[|/·]| at /i))
      fillableFields.push('company')
    if (!contact.personal_context && state.about) fillableFields.push('about')
    if (!contact.profile_photo_url && state.photoUrl) fillableFields.push('photo')
    // Location and name we also fill, but only show them in the hint if relevant
    if (!contact.name && state.name) fillableFields.push('name')

    // The button is ALWAYS shown when we're looking at a profile with any
    // scraped data, so the user can force-refresh enrichment at any time.
    const hasAnyScrape = !!state.name || !!state.jobTitle || !!state.about
    return (
      <div className="li-found">
        {hasAnyScrape && (
          <div className="li-enrich-banner">
            <div className="li-enrich-text">
              {fillableFields.length > 0 ? (
                <>
                  <span className="li-enrich-label">Can fill</span>
                  <strong>{fillableFields.join(' · ')}</strong>
                </>
              ) : (
                <>
                  <span className="li-enrich-label">Fully enriched</span>
                  <span className="li-enrich-muted">click to re-scrape</span>
                </>
              )}
            </div>
            <button
              className="enrich-button"
              disabled={enriching}
              onClick={() => handleEnrich(contact)}
              title="Enrich from this LinkedIn profile"
            >
              {enriching ? '…' : '✨ Enrich'}
            </button>
          </div>
        )}
        <ContactDetailScreen contact={contact} onRefresh={refetch} />
      </div>
    )
  }

  // not-found → show preview + create button
  const previewPhoto = state.photoUrl ?? state.avatarDataUrl
  return (
    <div className="li-empty">
      <div className="li-empty-header">
        <div className="avatar">
          {previewPhoto ? (
            <img src={previewPhoto} alt={state.name ?? 'profile'} />
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
