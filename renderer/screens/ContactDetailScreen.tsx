import { useState } from 'react'
import type { ContactDetail } from '../conv-api'
import {
  daysSince,
  formatAgo,
  healthLabel,
  healthState,
  initialsOf,
  INTERACTION_TYPE_LABELS,
  INTERACTION_TYPE_OPTIONS,
  VALUE_TYPE_LABELS,
  VALUE_TYPE_OPTIONS,
} from '../lib/contact-helpers'

type Props = {
  contact: ContactDetail
  onRefresh: () => void
}

export function ContactDetailScreen({ contact, onRefresh }: Props) {
  const [loggingOpen, setLoggingOpen] = useState(false)
  const [valueOpen, setValueOpen] = useState(false)

  const lastDays = daysSince(contact.last_interaction_at)
  const state = healthState(lastDays)

  const pendingTubos = contact.recent_interactions.filter(
    (i) => i.next_step && (i.next_step_owner === 'me' || i.next_step_owner == null),
  )

  return (
    <div className="detail">
      {/* ── Header ── */}
      <div className="detail-header">
        <div className="avatar">
          {contact.profile_photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={contact.profile_photo_url} alt={contact.name} />
          ) : (
            <div className="avatar-initials">{initialsOf(contact.name)}</div>
          )}
        </div>
        <div className="header-info">
          <div className="header-name-row">
            <div className="name">{contact.name}</div>
            {contact.tier && (
              <span className={`tier tier-${contact.tier}`}>T{contact.tier}</span>
            )}
          </div>
          <div className="subtitle">
            {[contact.job_title, contact.company].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
      </div>

      {/* ── Stat row ── */}
      <div className="stat-row">
        <span className={`health-dot dot-${state}`} />
        <span className={`health-label state-${state}`}>{healthLabel(state)}</span>
        <span className="muted">· {formatAgo(lastDays)}</span>
        <span className="sep">·</span>
        <span className="stat">
          <strong>{contact.interaction_count}</strong> int
        </span>
        <span className="sep">·</span>
        <span className="stat">
          <strong>{contact.value_log_count}</strong> value
        </span>
      </div>

      {/* ── Personal context ── */}
      {contact.personal_context && (
        <div className="block block-context">
          <div className="block-label">Context</div>
          <div className="block-body">{contact.personal_context}</div>
        </div>
      )}

      {/* ── Active opportunity ── */}
      {contact.active_opportunities.length > 0 && (
        <div className="block block-opp">
          <div className="block-label">🎯 Active Opportunity</div>
          {contact.active_opportunities.map((o) => (
            <div key={o.id} className="opp-item">
              <div className="opp-title">{o.title}</div>
              <div className="opp-meta">
                {o.company_name ?? 'No company'}{' '}
                <span className={`stage stage-${o.stage}`}>· {o.stage}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Tubo: pending next_steps ── */}
      {pendingTubos.length > 0 && (
        <div className="block block-tubo">
          <div className="block-label">⏰ Tubo ({pendingTubos.length})</div>
          {pendingTubos.map((i) => (
            <div key={i.id} className="tubo-item">
              <div className="tubo-text">{i.next_step}</div>
              <div className="tubo-meta">
                from {INTERACTION_TYPE_LABELS[i.type] ?? i.type} on {i.interaction_date}
                {i.next_step_date && ` · due ${i.next_step_date}`}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Chips ── */}
      {(contact.linkedin_url || contact.referred_by || contact.status) && (
        <div className="chip-row">
          {contact.linkedin_url && (
            <a
              className="chip chip-link"
              href={contact.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              LinkedIn
            </a>
          )}
          {contact.referred_by && <span className="chip">Referred</span>}
          {contact.status && <span className="chip">{contact.status}</span>}
        </div>
      )}

      {/* ── Recent activity ── */}
      <div className="section">
        <div className="section-header">
          <span className="section-title">Recent Activity</span>
          {!loggingOpen && (
            <button className="section-action" onClick={() => setLoggingOpen(true)}>
              + Log
            </button>
          )}
        </div>

        {loggingOpen && (
          <LogInteractionForm
            contactId={contact.id}
            onCancel={() => setLoggingOpen(false)}
            onSaved={() => {
              setLoggingOpen(false)
              onRefresh()
            }}
          />
        )}

        {contact.recent_interactions.length === 0 ? (
          <div className="empty small">No interactions yet.</div>
        ) : (
          <ul className="timeline">
            {contact.recent_interactions.slice(0, 6).map((i) => (
              <li key={i.id} className="tl-item">
                <div className={`tl-dot tl-${i.type}`} />
                <div className="tl-content">
                  <div className="tl-line1">
                    <span className="tl-type">
                      {INTERACTION_TYPE_LABELS[i.type] ?? i.type}
                    </span>
                    {i.direction && <span className="tl-dir">· {i.direction}</span>}
                    <span className="tl-date">{i.interaction_date}</span>
                  </div>
                  {i.notes && <div className="tl-notes">{i.notes}</div>}
                  {i.next_step && (
                    <div className="tl-next">
                      ⏭ {i.next_step}
                      {i.next_step_date ? ` (${i.next_step_date})` : ''}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Value given ── */}
      <div className="section">
        <div className="section-header">
          <span className="section-title">Value Given</span>
          {!valueOpen && (
            <button className="section-action" onClick={() => setValueOpen(true)}>
              + Add
            </button>
          )}
        </div>

        {valueOpen && (
          <AddValueLogForm
            contactId={contact.id}
            onCancel={() => setValueOpen(false)}
            onSaved={() => {
              setValueOpen(false)
              onRefresh()
            }}
          />
        )}

        {contact.value_logs.length === 0 ? (
          <div className="empty small">No value logs yet.</div>
        ) : (
          <ul className="value-list">
            {contact.value_logs.map((v) => (
              <li key={v.id} className="value-item">
                <span className="value-badge">
                  {VALUE_TYPE_LABELS[v.type] ?? v.type}
                </span>
                <span className="value-desc">{v.description || '—'}</span>
                <span className="value-date">{v.date}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ─── Inline forms ──────────────────────────────────────────────────────────

function LogInteractionForm({
  contactId,
  onCancel,
  onSaved,
}: {
  contactId: string
  onCancel: () => void
  onSaved: () => void
}) {
  const [type, setType] = useState('call')
  const [notes, setNotes] = useState('')
  const [nextStep, setNextStep] = useState('')
  const [nextStepDate, setNextStepDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setSaving(true)
    setError(null)
    const result = await window.conv.contact.logInteraction({
      contact_id: contactId,
      type,
      notes: notes.trim() || null,
      next_step: nextStep.trim() || null,
      next_step_date: nextStepDate.trim() || null,
    })
    setSaving(false)
    if (result.ok) {
      onSaved()
    } else {
      setError(result.error)
    }
  }

  return (
    <div className="inline-form">
      <select value={type} onChange={(e) => setType(e.target.value)}>
        {INTERACTION_TYPE_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <textarea
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
      />
      <input
        placeholder="Next step (optional)"
        value={nextStep}
        onChange={(e) => setNextStep(e.target.value)}
      />
      {nextStep.trim() && (
        <input
          type="date"
          value={nextStepDate}
          onChange={(e) => setNextStepDate(e.target.value)}
        />
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function AddValueLogForm({
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
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setSaving(true)
    setError(null)
    const result = await window.conv.contact.addValueLog({
      contact_id: contactId,
      type,
      description: description.trim() || null,
    })
    setSaving(false)
    if (result.ok) {
      onSaved()
    } else {
      setError(result.error)
    }
  }

  return (
    <div className="inline-form">
      <select value={type} onChange={(e) => setType(e.target.value)}>
        {VALUE_TYPE_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <input
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
