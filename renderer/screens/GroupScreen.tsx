import { useEffect, useMemo, useState } from 'react'
import type { ContactBrief, GroupParticipant } from '../conv-api'
import {
  daysSince,
  healthState,
  initialsOf,
  VALUE_TYPE_OPTIONS,
  INTERACTION_TYPE_OPTIONS,
} from '../lib/contact-helpers'
import { MapParticipantModal } from './MapParticipantModal'

type Props = {
  groupName: string | null
  groupId: string
  participants: GroupParticipant[]
}

export function GroupScreen({ groupName, groupId, participants }: Props) {
  const [briefs, setBriefs] = useState<Record<string, ContactBrief | null>>({})
  const [loading, setLoading] = useState(true)
  const [mappingTarget, setMappingTarget] = useState<GroupParticipant | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  // Fetch briefs for all participants (batch)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const phones = participants.map((p) => p.phone)
    window.conv.contact.briefsByPhones(phones).then((data) => {
      if (!cancelled) {
        setBriefs(data)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [participants, refreshTick])

  const { matched, unmapped } = useMemo(() => {
    const matched: Array<{ participant: GroupParticipant; brief: ContactBrief }> = []
    const unmapped: GroupParticipant[] = []
    for (const p of participants) {
      const b = briefs[p.phone]
      if (b) matched.push({ participant: p, brief: b })
      else unmapped.push(p)
    }
    return { matched, unmapped }
  }, [participants, briefs])

  return (
    <div className="group">
      <div className="group-header">
        <div className="group-icon">👥</div>
        <div className="group-info">
          <div className="group-name">{groupName ?? 'Group'}</div>
          <div className="group-meta">
            {participants.length} seen · {matched.length} in reThink ·{' '}
            {unmapped.length} unmapped
          </div>
        </div>
      </div>

      {loading && <div className="loading">Looking up participants…</div>}

      {!loading && matched.length > 0 && (
        <div className="group-section">
          <div className="group-section-title">Recognized</div>
          <ul className="participant-list">
            {matched.map(({ participant, brief }) => (
              <ParticipantRow
                key={participant.phone}
                participant={participant}
                brief={brief}
                onRefresh={() => setRefreshTick((t) => t + 1)}
              />
            ))}
          </ul>
        </div>
      )}

      {!loading && unmapped.length > 0 && (
        <div className="group-section">
          <div className="group-section-title">Unmapped</div>
          <ul className="participant-list">
            {unmapped.map((p) => (
              <UnmappedParticipantRow
                key={p.phone}
                participant={p}
                onAdd={() => setMappingTarget(p)}
              />
            ))}
          </ul>
        </div>
      )}

      {!loading && participants.length === 0 && (
        <div className="empty">
          <strong>No participants detected yet</strong>
          <div className="muted small">
            Scroll the group to load recent messages, then switch chats and come back.
          </div>
        </div>
      )}

      {mappingTarget && (
        <MapParticipantModal
          participant={mappingTarget}
          onClose={() => setMappingTarget(null)}
          onDone={() => {
            setMappingTarget(null)
            setRefreshTick((t) => t + 1)
          }}
        />
      )}
    </div>
  )
}

// ─── Matched participant row ──────────────────────────────────────────

function ParticipantRow({
  participant,
  brief,
  onRefresh,
}: {
  participant: GroupParticipant
  brief: ContactBrief
  onRefresh: () => void
}) {
  const [openAction, setOpenAction] = useState<'none' | 'log' | 'value'>('none')
  const state = healthState(daysSince(brief.last_interaction_at))
  const avatar = brief.profile_photo_url ?? participant.avatarDataUrl

  async function handleDm() {
    await window.conv.wa.navigateToDm(participant.phone)
  }

  return (
    <li className="participant">
      <div className={`avatar with-ring ring-${state}`}>
        {avatar ? (
          <img src={avatar} alt={brief.name} />
        ) : (
          <div className="avatar-initials">{initialsOf(brief.name)}</div>
        )}
      </div>
      <div className="participant-info">
        <div className="participant-name-row">
          <span className="participant-name">{brief.name}</span>
          {brief.tier && (
            <span className={`tier tier-${brief.tier}`}>T{brief.tier}</span>
          )}
        </div>
        <div className="participant-subtitle">
          {[brief.job_title, brief.company].filter(Boolean).join(' · ') || '—'}
        </div>
        <div className="participant-actions">
          <button
            className="tiny-action"
            title="Log interaction"
            onClick={() => setOpenAction(openAction === 'log' ? 'none' : 'log')}
          >
            + Log
          </button>
          <button
            className="tiny-action"
            title="Add value"
            onClick={() => setOpenAction(openAction === 'value' ? 'none' : 'value')}
          >
            + Value
          </button>
          <button className="tiny-action" title="Private DM" onClick={handleDm}>
            💬 DM
          </button>
        </div>

        {openAction === 'log' && (
          <QuickLogForm
            contactId={brief.id}
            onCancel={() => setOpenAction('none')}
            onSaved={() => {
              setOpenAction('none')
              onRefresh()
            }}
          />
        )}
        {openAction === 'value' && (
          <QuickValueForm
            contactId={brief.id}
            onCancel={() => setOpenAction('none')}
            onSaved={() => {
              setOpenAction('none')
              onRefresh()
            }}
          />
        )}
      </div>
    </li>
  )
}

// ─── Unmapped participant row ──────────────────────────────────────────

function UnmappedParticipantRow({
  participant,
  onAdd,
}: {
  participant: GroupParticipant
  onAdd: () => void
}) {
  const display = participant.waName ?? participant.phone
  const avatar = participant.avatarDataUrl

  async function handleDm() {
    await window.conv.wa.navigateToDm(participant.phone)
  }

  return (
    <li className="participant unmapped">
      <div className="avatar">
        {avatar ? (
          <img src={avatar} alt={display} />
        ) : (
          <div className="avatar-initials">{initialsOf(display)}</div>
        )}
      </div>
      <div className="participant-info">
        <div className="participant-name">{display}</div>
        <div className="participant-subtitle">{participant.phone}</div>
        <div className="participant-actions">
          <button className="tiny-action primary" onClick={onAdd}>
            + Add to reThink
          </button>
          <button className="tiny-action" onClick={handleDm}>
            💬 DM
          </button>
        </div>
      </div>
    </li>
  )
}

// ─── Inline quick forms (compact versions) ─────────────────────────────

function QuickLogForm({
  contactId,
  onCancel,
  onSaved,
}: {
  contactId: string
  onCancel: () => void
  onSaved: () => void
}) {
  const [type, setType] = useState('whatsapp')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    const r = await window.conv.contact.logInteraction({
      contact_id: contactId,
      type,
      notes: notes.trim() || null,
      next_step: null,
      next_step_date: null,
    })
    setSaving(false)
    if (r.ok) onSaved()
  }

  return (
    <div className="inline-form compact">
      <select value={type} onChange={(e) => setType(e.target.value)}>
        {INTERACTION_TYPE_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <input
        placeholder="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={save}>
          Save
        </button>
        <button className="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function QuickValueForm({
  contactId,
  onCancel,
  onSaved,
}: {
  contactId: string
  onCancel: () => void
  onSaved: () => void
}) {
  const [type, setType] = useState('introduction')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    const r = await window.conv.contact.addValueLog({
      contact_id: contactId,
      type,
      description: description.trim() || null,
    })
    setSaving(false)
    if (r.ok) onSaved()
  }

  return (
    <div className="inline-form compact">
      <select value={type} onChange={(e) => setType(e.target.value)}>
        {VALUE_TYPE_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <input
        placeholder="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={save}>
          Save
        </button>
        <button className="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
