import { useEffect, useState } from 'react'
import type { ContactBrief, ContactDetail, LiState } from '../conv-api'
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
  // Name-based search when URL-based lookup misses — surfaces existing WA/other
  // contacts that might be the same person under a different channel, before
  // the user hits Create and creates a duplicate.
  const [nameMatches, setNameMatches] = useState<ContactBrief[]>([])
  const [attachingId, setAttachingId] = useState<string | null>(null)

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

  // Fire a name-based search when the URL lookup misses — only kicks in once
  // the LI scrape actually has the person's name. Runs whenever we flip to
  // not-found so stale results clear if the user navigates between profiles.
  useEffect(() => {
    if (lookup.kind !== 'not-found' || !state.name || state.name.length < 2) {
      setNameMatches([])
      return
    }
    let cancelled = false
    window.conv.contact.searchByName(state.name).then((rows) => {
      if (!cancelled) setNameMatches(rows)
    })
    return () => { cancelled = true }
  }, [lookup.kind, state.name])

  async function handleAttach(target: ContactBrief) {
    setAttachingId(target.id)
    const result = await window.conv.contact.enrichFromLinkedinProfile({
      contact_id: target.id,
      name: state.name,
      jobTitle: state.jobTitle,
      company: state.company,
      companyLinkedinUrl: state.companyLinkedinUrl,
      companyLogoUrl: state.companyLogoUrl,
      location: state.location,
      about: state.about,
      photoUrl: state.photoUrl,
      linkedinUrl: state.url,
    })
    setAttachingId(null)
    if (result.ok) {
      await refetch()
    } else {
      setCreateError(result.error)
    }
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
      companyLinkedinUrl: state.companyLinkedinUrl,
      companyLogoUrl: state.companyLogoUrl,
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
      companyLinkedinUrl: state.companyLinkedinUrl,
      companyLogoUrl: state.companyLogoUrl,
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
          No contact has this LinkedIn URL attached yet.
        </div>
      </div>

      {nameMatches.length > 0 && (
        <div className="li-name-matches">
          <div className="li-name-matches-header">
            Possible existing contacts by name — attach the LinkedIn profile instead of creating a duplicate.
          </div>
          <ul className="search-results">
            {nameMatches.map((c) => (
              <li key={c.id}>
                <div className="avatar small">
                  {c.profile_photo_url ? (
                    <img src={c.profile_photo_url} alt={c.name} />
                  ) : (
                    <div className="avatar-initials">{initialsOf(c.name)}</div>
                  )}
                </div>
                <div className="search-result-info">
                  <div className="search-result-name">{c.name}</div>
                  <div className="search-result-subtitle">
                    {[c.job_title, c.company].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
                <button
                  className="primary tiny"
                  disabled={attachingId !== null}
                  onClick={() => handleAttach(c)}
                >
                  {attachingId === c.id ? '…' : 'Attach'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="li-empty-actions">
        <button
          className="primary"
          disabled={creating || !state.name}
          onClick={handleCreate}
        >
          {creating ? 'Creating…' : nameMatches.length > 0 ? '+ Create new anyway' : '+ Create in reThink'}
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
