import { useState } from 'react'
import type { ContactDetail } from '../conv-api'
import RelationshipPeek from '../handoff/components/RelationshipPeek'
import type { KeyDate, RecordRef, RelationshipPerson, Todo } from '../handoff/types'
import {
  daysSince,
  formatAgo,
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
  const [toast, setToast] = useState<string | null>(null)
  const person = relationshipPersonFromContact(contact)

  function flash(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2200)
  }

  function openRecord(ref: RecordRef) {
    if (ref.kind === 'company') {
      flash(`${ref.name} record is not wired in this standalone build yet.`)
    } else {
      flash(`${ref.kind} record overlay is not wired in this standalone build yet.`)
    }
  }

  function addDate(_personId: string, date: KeyDate) {
    void window.conv.contact
      .logInteraction({
        contact_id: contact.id,
        type: 'whatsapp',
        notes: `Key date: ${date.label}${date.date ? ` (${date.date})` : ''}`,
        next_step: null,
        next_step_date: null,
      })
      .then((result) => {
        if (result.ok) onRefresh()
        else flash(result.error)
      })
  }

  function addTodo(_personId: string, todo: Todo) {
    void window.conv.contact
      .logInteraction({
        contact_id: contact.id,
        type: 'whatsapp',
        notes: null,
        next_step: todo.text,
        next_step_date: todo.due ?? null,
      })
      .then((result) => {
        if (result.ok) onRefresh()
        else flash(result.error)
      })
  }

  return (
    <>
      <RelationshipPeek
        person={person}
        onOpenRecord={openRecord}
        onToggleTodo={() => flash('Todo toggling needs a dedicated persistence endpoint.')}
        onAddDate={addDate}
        onAddTodo={addTodo}
        onClassify={() => {
          if (contact.linkedin_url) window.open(contact.linkedin_url, '_blank')
          else flash('No classify picker is wired in this standalone build yet.')
        }}
        onRecheckContext={async () => onRefresh()}
        onToast={flash}
      />
      {toast && <div className="rp-toast on">{toast}</div>}
    </>
  )
}

function relationshipPersonFromContact(contact: ContactDetail): RelationshipPerson {
  const lastDays = daysSince(contact.last_interaction_at)
  const state = healthState(lastDays)
  const tier = contact.tier === 1 || contact.tier === 2 || contact.tier === 3 ? contact.tier : 3
  const pendingTodos = contact.recent_interactions.filter(
    (i) => i.next_step && (i.next_step_owner === 'me' || i.next_step_owner == null),
  )
  const channels = Array.from(
    new Set(
      [
        contact.phone ? 'whatsapp' : null,
        contact.linkedin_url ? 'linkedin' : null,
        contact.email ? 'gmail' : null,
        ...contact.recent_interactions.map((i) =>
          i.channel === 'whatsapp' || i.type === 'whatsapp'
            ? 'whatsapp'
            : i.channel === 'linkedin' || i.type === 'linkedin_msg'
              ? 'linkedin'
              : i.channel === 'email' || i.type === 'email'
                ? 'gmail'
                : null,
        ),
      ].filter(Boolean) as RelationshipPerson['channels'],
    ),
  )
  const dates: KeyDate[] = [
    contact.birthday ? { label: 'Birthday', date: contact.birthday, soon: true } : null,
    contact.last_interaction_at
      ? { label: 'Last touch', date: formatAgo(lastDays), soon: state === 'cold' }
      : { label: 'First touch', date: 'Not logged' },
    ...pendingTodos
      .filter((i) => i.next_step_date)
      .slice(0, 2)
      .map((i) => ({ label: 'Next step', date: i.next_step_date ?? '', soon: true })),
  ].filter(Boolean) as KeyDate[]
  const lists = [
    contact.category,
    contact.status,
    contact.referred_by ? 'Referred' : null,
    contact.health_score != null ? `Health ${contact.health_score}` : null,
  ].filter(Boolean) as string[]
  const primaryOpp = contact.active_opportunities[0]

  return {
    id: contact.id,
    name: contact.name,
    initials: initialsOf(contact.name),
    avColor: avatarColorForTier(tier),
    tier,
    role: contact.job_title || contact.status || contact.category || 'Relationship',
    company: contact.company || primaryOpp?.company_name || 'Unknown company',
    channels,
    active: state === 'active',
    lastSeen: formatAgo(lastDays),
    lists: lists.length ? lists : ['Unclassified'],
    context:
      contact.personal_context ||
      `No AI context has been saved for ${contact.name} yet. Import chat history or log the next interaction to build memory.`,
    facts: [
      contact.company ? { icon: 'buildings', text: contact.company } : null,
      contact.referred_by ? { icon: 'arrow-bend-up-right', text: 'Referred by saved contact' } : null,
      contact.email ? { icon: 'envelope-simple', text: contact.email } : null,
    ].filter(Boolean) as RelationshipPerson['facts'],
    ledger: {
      given: contact.value_logs.length,
      received: 0,
      gaveItems: contact.value_logs.slice(0, 4).map((v) => ({
        tag: VALUE_TYPE_LABELS[v.type] ?? v.type,
        text: v.description || 'Value exchange',
        date: v.date,
      })),
      receivedItems: [],
    },
    dates,
    todos: pendingTodos.map((i) => ({
      text: i.next_step ?? '',
      due: i.next_step_date ?? undefined,
      done: false,
    })),
    intros: [],
    opp: primaryOpp
      ? {
          title: primaryOpp.title,
          role: primaryOpp.stage,
          due: 'active',
          progress: { done: 0, total: 0 },
          recordId: primaryOpp.id,
        }
      : null,
  }
}

function avatarColorForTier(tier: RelationshipPerson['tier']): string {
  if (tier === 1) return '#7a5b3e'
  if (tier === 2) return '#46708a'
  return '#8fa8a0'
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
