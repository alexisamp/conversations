import { useEffect, useState } from 'react'
import type { ContactBrief, GroupParticipant } from '../conv-api'
import { initialsOf } from '../lib/contact-helpers'

type Props = {
  participant: GroupParticipant
  onClose: () => void
  onDone: () => void
}

export function MapParticipantModal({ participant, onClose, onDone }: Props) {
  const [tab, setTab] = useState<'search' | 'create'>('search')
  const [query, setQuery] = useState(participant.waName ?? '')
  const [searchResults, setSearchResults] = useState<ContactBrief[]>([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [createName, setCreateName] = useState(participant.waName ?? '')
  const [createLinkedin, setCreateLinkedin] = useState('')

  // Live search as you type
  useEffect(() => {
    if (tab !== 'search') return
    const q = query.trim()
    if (q.length < 2) {
      setSearchResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      const results = await window.conv.contact.searchByName(q)
      if (!cancelled) {
        setSearchResults(results)
        setSearching(false)
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, tab])

  async function handleAttach(contact: ContactBrief) {
    setSaving(true)
    setError(null)

    let result
    if (participant.phone) {
      result = await window.conv.contact.attachPhone({
        contact_id: contact.id,
        phone: participant.phone,
        waName: participant.waName,
      })
    } else if (participant.lid) {
      result = await window.conv.contact.attachLid({
        contact_id: contact.id,
        lid: participant.lid,
        waName: participant.waName,
      })
    } else {
      setSaving(false)
      setError('Participant has neither phone nor LID')
      return
    }

    setSaving(false)
    if (result.ok) onDone()
    else setError(result.error)
  }

  async function handleCreate() {
    setSaving(true)
    setError(null)
    // For LID-only participants we create with an empty phone since we don't
    // have one; we'll still attach the LID as a channel on the new record.
    const result = await window.conv.contact.createFromParticipant({
      name: createName.trim(),
      linkedin_url: createLinkedin.trim() || null,
      phone: participant.phone ?? '',
      waName: participant.waName,
    })
    if (result.ok && participant.lid && !participant.phone) {
      // New record created from a LID-only participant; link the LID channel.
      await window.conv.contact.attachLid({
        contact_id: result.contactId,
        lid: participant.lid,
        waName: participant.waName,
      })
    }
    setSaving(false)
    if (result.ok) onDone()
    else setError(result.error)
  }

  const subtitle = participant.phone
    ? participant.phone
    : 'Linked ID (WhatsApp group participant)'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            {participant.lid && !participant.phone ? 'Link to reThink' : 'Add to reThink'}
          </div>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-target">
          <div className="avatar small">
            {participant.avatarDataUrl ? (
              <img src={participant.avatarDataUrl} alt={participant.waName ?? ''} />
            ) : (
              <div className="avatar-initials">
                {initialsOf(participant.waName ?? '??')}
              </div>
            )}
          </div>
          <div>
            <div className="modal-target-name">
              {participant.waName ?? 'Unknown'}
            </div>
            <div className="modal-target-phone">{subtitle}</div>
          </div>
        </div>

        {participant.lid && !participant.phone && (
          <div className="modal-hint" style={{ padding: '6px 14px 0' }}>
            Linking once saves this LID so future sightings in any group are
            recognized automatically.
          </div>
        )}

        <div className="modal-tabs">
          <button
            className={tab === 'search' ? 'active' : ''}
            onClick={() => setTab('search')}
          >
            Search existing
          </button>
          <button
            className={tab === 'create' ? 'active' : ''}
            onClick={() => setTab('create')}
          >
            Create new
          </button>
        </div>

        {tab === 'search' && (
          <div className="modal-body">
            <input
              className="modal-input"
              placeholder="Search by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            {searching && <div className="empty small">Searching…</div>}
            {!searching && query.trim().length >= 2 && searchResults.length === 0 && (
              <div className="empty small">No matches.</div>
            )}
            {searchResults.length > 0 && (
              <ul className="search-results">
                {searchResults.map((c) => (
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
                      disabled={saving}
                      onClick={() => handleAttach(c)}
                    >
                      {participant.lid && !participant.phone ? 'Link' : 'Attach'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === 'create' && (
          <div className="modal-body">
            <label className="modal-label">
              Name
              <input
                className="modal-input"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
              />
            </label>
            <label className="modal-label">
              LinkedIn URL <span className="muted">(optional — auto-enriches)</span>
              <input
                className="modal-input"
                placeholder="https://www.linkedin.com/in/…"
                value={createLinkedin}
                onChange={(e) => setCreateLinkedin(e.target.value)}
              />
            </label>
            <div className="modal-hint">
              If you paste a LinkedIn URL, reThink fetches job title, company,
              and bio automatically.
            </div>
            <button
              className="primary"
              disabled={saving || !createName.trim()}
              onClick={handleCreate}
            >
              {saving ? 'Creating…' : 'Create contact'}
            </button>
          </div>
        )}

        {error && <div className="form-error modal-error">{error}</div>}
      </div>
    </div>
  )
}
