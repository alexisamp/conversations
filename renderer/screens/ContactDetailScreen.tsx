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
  const [valueFormOpen, setValueFormOpen] = useState(false)
  const [ledgerOpen, setLedgerOpen] = useState(false)

  const lastDays = daysSince(contact.last_interaction_at)
  const state = healthState(lastDays)
  const tier = contact.tier && contact.tier >= 1 && contact.tier <= 3 ? contact.tier : 3
  const tierClass = `t${tier}`

  const pendingTubos = contact.recent_interactions.filter(
    (i) => i.next_step && (i.next_step_owner === 'me' || i.next_step_owner == null),
  )
  const channels = Array.from(
    new Set(
      [
        contact.phone ? 'wa' : null,
        contact.linkedin_url ? 'li' : null,
        contact.email ? 'mail' : null,
        ...contact.recent_interactions.map((i) =>
          i.channel === 'whatsapp' || i.type === 'whatsapp'
            ? 'wa'
            : i.channel === 'linkedin' || i.type === 'linkedin_msg'
              ? 'li'
              : i.channel === 'email' || i.type === 'email'
                ? 'mail'
                : null,
        ),
      ].filter(Boolean) as Array<'wa' | 'li' | 'mail'>,
    ),
  )
  const keyDates = [
    contact.birthday ? { label: 'Birthday', date: contact.birthday, soon: true } : null,
    contact.last_interaction_at
      ? { label: 'Last touch', date: formatAgo(lastDays), soon: state === 'cold' }
      : { label: 'First touch', date: 'Not logged', soon: false },
    ...pendingTubos
      .filter((i) => i.next_step_date)
      .slice(0, 2)
      .map((i) => ({ label: 'Next step', date: i.next_step_date ?? '', soon: true })),
  ].filter(Boolean) as Array<{ label: string; date: string; soon: boolean }>
  const listChips = [
    contact.category,
    contact.status,
    contact.referred_by ? 'Referred' : null,
    contact.health_score != null ? `Health ${contact.health_score}` : null,
  ].filter(Boolean) as string[]
  const contextText =
    contact.personal_context ||
    `No AI context has been saved for ${contact.name} yet. Import chat history or log the next interaction to build memory.`
  const valueCount = contact.value_logs.length
  const valueKind = valueCount > 0 ? 'credit' : 'even'
  const primaryOpp = contact.active_opportunities[0]

  return (
    <div className="rp-scope">
      <div className="rp-head">
        <div className={`r-ring ${tierClass}`}>
          <div className="r-av">
            {contact.profile_photo_url ? (
              <img src={contact.profile_photo_url} alt={contact.name} />
            ) : (
              <span>{initialsOf(contact.name)}</span>
            )}
          </div>
        </div>
        <div className="rp-id">
          <div className="rp-name-row">
            <span className="rp-name">{contact.name}</span>
            <span className={`rp-tier ${tierClass}`}>T{tier}</span>
          </div>
          <div className="rp-role">
            {[contact.job_title, contact.company].filter(Boolean).join(' · ') || 'No role saved'}
          </div>
        </div>
      </div>

      <div className="rp-bar">
        <div className="rp-chans">
          {channels.length === 0 ? (
            <span className="rp-chan muted" title="No channel linked">•</span>
          ) : (
            channels.map((channel) => (
              <span key={channel} className={`rp-chan ch-${channel}`} title={channelLabel(channel)}>
                {channelIcon(channel)}
              </span>
            ))
          )}
        </div>
        <span className="rp-bar-meta">
          <span className={`rp-dot ${state === 'active' ? 'on' : ''}`} />
          {healthLabel(state)} · {formatAgo(lastDays)}
        </span>
      </div>

      <div className="rp-listrow">
        <div className="rp-lists">
          {listChips.length > 0 ? (
            listChips.map((chip) => (
              <span key={chip} className="rp-listchip">
                {chip}
              </span>
            ))
          ) : (
            <span className="rp-listchip quiet">Unclassified</span>
          )}
          {contact.linkedin_url && (
            <a className="rp-classify" href={contact.linkedin_url} target="_blank" rel="noreferrer">
              LinkedIn ↗
            </a>
          )}
        </div>
      </div>

      <div className="rp-ctx">
        <div className="rp-ctx-hd">
          <span className="rp-ai">✦ AI</span>
          Context
          <button className="rp-recheck" title="Refresh contact" onClick={onRefresh}>
            ↻
          </button>
        </div>
        <p className="rp-ctx-body">{contextText}</p>
        <div className="rp-facts">
          {contact.company && <span className="rp-fact">⌘ Company: {contact.company}</span>}
          {contact.referred_by && <span className="rp-fact">↗ Referred by saved contact</span>}
          {contact.email && <span className="rp-fact">✉ {contact.email}</span>}
        </div>
      </div>

      <button
        className={`rp-value ${valueKind} ${ledgerOpen ? 'open' : ''}`}
        aria-expanded={ledgerOpen}
        onClick={() => setLedgerOpen((open) => !open)}
      >
        <span className="rpv-badge">{valueCount > 0 ? '↑' : '='}</span>
        <span className="rpv-lbl">{valueCount > 0 ? 'Value logged' : 'Value balance'}</span>
        <span className="rpv-net">{valueCount > 0 ? `+${valueCount}` : '0'}</span>
        <span className="rpv-chev">⌄</span>
      </button>
      {ledgerOpen && (
        <div className="rp-value-detail">
          <div className="rpv-col">
            <div className="rpv-col-hd">
              You gave <span>{valueCount}</span>
            </div>
            {contact.value_logs.length === 0 ? (
              <div className="rpv-none">Nothing logged yet.</div>
            ) : (
              contact.value_logs.slice(0, 4).map((v) => (
                <div className="rpv-item" key={v.id}>
                  <span className="rpv-tag">{VALUE_TYPE_LABELS[v.type] ?? v.type}</span>
                  <div className="rpv-body">
                    <div className="rpv-tx">{v.description || 'Value exchange'}</div>
                    <div className="rpv-dt">{v.date}</div>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="rpv-col">
            <div className="rpv-col-hd">
              You received <span>0</span>
            </div>
            <div className="rpv-none">No received value logged in this app yet.</div>
          </div>
        </div>
      )}

      <section className="rp-sec">
        <div className="rp-sec-hd">
          <span className="rp-lbl">Key dates</span>
          <button className="rp-add" onClick={() => setLoggingOpen(true)}>
            + log
          </button>
        </div>
        <div className="rp-dates">
          {keyDates.map((date) => (
            <div className="rp-date" key={`${date.label}-${date.date}`}>
              <span className={`rp-date-ic ${date.soon ? 'soon' : ''}`}>◷</span>
              <span className="rp-date-lb">{date.label}</span>
              <span className="rp-date-dt">{date.date}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="rp-sec">
        <div className="rp-sec-hd">
          <span className="rp-lbl">To-do's</span>
          <span className="rp-ct">{pendingTubos.length}</span>
          <button className="rp-add" onClick={() => setLoggingOpen(true)}>
            + add
          </button>
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
        <div className="rp-todos">
          {pendingTubos.length === 0 ? (
            <div className="rp-empty">No pending next steps.</div>
          ) : (
            pendingTubos.map((i) => (
              <div className="rp-todo" key={i.id}>
                <span className="rp-cb" />
                <span className="rp-todo-tx">
                  {i.next_step}
                  {i.next_step_date && <span className="rp-due">due {i.next_step_date}</span>}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rp-sec">
        <div className="rp-sec-hd">
          <span className="rp-lbl">Value ledger</span>
          {!valueFormOpen && (
            <button className="rp-add" onClick={() => setValueFormOpen(true)}>
              + Add
            </button>
          )}
        </div>
        {valueFormOpen && (
          <AddValueLogForm
            contactId={contact.id}
            onCancel={() => setValueFormOpen(false)}
            onSaved={() => {
              setValueFormOpen(false)
              onRefresh()
            }}
          />
        )}
      </section>

      {primaryOpp && (
        <section className="rp-sec">
          <div className="rp-sec-hd">
            <span className="rp-lbl">Linked opportunity</span>
          </div>
          <div className="rp-opp">
            <span className="rp-opp-ic">◎</span>
            <span className="rp-opp-name">{primaryOpp.title}</span>
            <span className="rp-opp-meta">
              {primaryOpp.company_name ?? 'No company'} · {primaryOpp.stage}
            </span>
            <span className="rp-opp-go">↗</span>
          </div>
        </section>
      )}

      <section className="rp-sec">
        <div className="rp-sec-hd">
          <span className="rp-lbl">Recent activity</span>
          <span className="rp-ct">{contact.interaction_count}</span>
          <BackfillButton contactId={contact.id} contactName={contact.name} onImported={onRefresh} />
        </div>
        {contact.recent_interactions.length === 0 ? (
          <div className="rp-empty">No interactions yet.</div>
        ) : (
          <ul className="rp-timeline">
            {contact.recent_interactions.slice(0, 6).map((i) => (
              <li key={i.id} className="rp-tl-item">
                <div className={`rp-tl-dot tl-${i.type}`} />
                <div className="rp-tl-content">
                  <div className="rp-tl-line">
                    <span>{INTERACTION_TYPE_LABELS[i.type] ?? i.type}</span>
                    <time>{i.interaction_date}</time>
                  </div>
                  {i.notes && <div className="rp-tl-notes">{i.notes}</div>}
                  {i.next_step && <div className="rp-tl-next">{i.next_step}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function channelLabel(channel: 'wa' | 'li' | 'mail'): string {
  if (channel === 'wa') return 'WhatsApp'
  if (channel === 'li') return 'LinkedIn'
  return 'Email'
}

function channelIcon(channel: 'wa' | 'li' | 'mail'): string {
  if (channel === 'wa') return 'W'
  if (channel === 'li') return 'in'
  return '@'
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

// ─── Phase 5a: Import history button ────────────────────────────

function BackfillButton({
  contactId,
  contactName,
  onImported,
}: {
  contactId: string
  contactName: string
  onImported: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<string>('')
  const [result, setResult] = useState<string | null>(null)

  async function runImport(withScroll: boolean) {
    setBusy(true)
    setResult(null)
    setPhase(withScroll ? 'Scrolling chat to the top…' : 'Scanning visible messages…')
    try {
      const scanRes = withScroll
        ? await window.conv.backfill.scanWithScroll()
        : await window.conv.backfill.scanHistory()
      if (scanRes.error) {
        setResult(`Error: ${scanRes.error}`)
        return
      }
      if (!scanRes.entries.length) {
        setResult('No messages found — open the chat first')
        return
      }
      const scrollCount =
        'scrolls' in scanRes ? (scanRes as { scrolls: number }).scrolls : 0
      setPhase(
        `Found ${scanRes.entries.length} messages` +
          (scrollCount ? ` after ${scrollCount} scrolls` : '') +
          ' — summarizing…',
      )
      const reachedStart =
        'reachedStart' in scanRes ? (scanRes as { reachedStart: boolean }).reachedStart : false
      const importRes = await window.conv.backfill.importWindows({
        contactId,
        phone: '',
        entries: scanRes.entries,
        reachedStart,
      })
      if (importRes.error) {
        setResult(`Error: ${importRes.error}`)
        return
      }
      const { windowsFound, windowsImported, skipped } = importRes
      setResult(
        `Imported ${windowsImported} of ${windowsFound} windows (${skipped} skipped)`,
      )
      if (windowsImported > 0) onImported()
    } catch (err) {
      setResult(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setBusy(false)
      setPhase('')
    }
  }

  return (
    <div className="backfill-wrap">
      <button
        className="section-action"
        onClick={() => runImport(true)}
        disabled={busy}
        title={`Scroll ${contactName}'s chat to load all history, then import with Gemini summaries`}
      >
        {busy ? '📥 …' : '📥 Import history'}
      </button>
      <button
        className="section-action-ghost"
        onClick={() => runImport(false)}
        disabled={busy}
        title="Scan only what's currently rendered (no scrolling)"
      >
        quick
      </button>
      {phase && <span className="backfill-result">{phase}</span>}
      {!phase && result && <span className="backfill-result">{result}</span>}
    </div>
  )
}
