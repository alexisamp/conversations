import { useCallback, useEffect, useRef, useState } from 'react'
import { ContactDetailScreen } from './ContactDetailScreen'
import { GroupScreen } from './GroupScreen'
import { LinkedinProfileScreen } from './LinkedinProfileScreen'
import { MapParticipantModal } from './MapParticipantModal'
import { SettingsScreen } from './SettingsScreen'
import type {
  AiStagedOutput,
  ContactDetail,
  GroupParticipant,
  SidebarContext,
  SyncIssue,
  SyncStatus,
} from '../conv-api'

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
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    state: 'idle',
    label: 'Not scanned yet',
    detail: 'Open WhatsApp or run catch-up',
    activeJob: null,
    lastRunAt: null,
    uploadedCount: 0,
    unmatchedCount: 0,
    issueCount: 0,
  })
  const [syncIssues, setSyncIssues] = useState<SyncIssue[]>([])
  const [stagedOutputs, setStagedOutputs] = useState<AiStagedOutput[]>([])
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false)
  const [aiReviewOpen, setAiReviewOpen] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const [resolvingIssue, setResolvingIssue] = useState<SyncIssue | null>(null)
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

  const refreshSync = useCallback(async () => {
    const [status, issues, outputs] = await Promise.all([
      window.conv.sync.getStatus(),
      window.conv.sync.listIssues(),
      window.conv.insights.getStagedOutputs(),
    ])
    setSyncStatus(status)
    setSyncIssues(issues)
    setStagedOutputs(outputs)
  }, [])

  useEffect(() => {
    void refreshSync()
    const unsubscribe = window.conv.sync.onStatus((status) => {
      setSyncStatus(status)
      void window.conv.sync.listIssues().then(setSyncIssues)
      void window.conv.insights.getStagedOutputs().then(setStagedOutputs)
    })
    return unsubscribe
  }, [refreshSync])

  async function runCatchUp() {
    setSyncBusy(true)
    try {
      await window.conv.sync.runRecentCatchUp()
      await refreshSync()
      if (lastHitPhoneRef.current) await handleRefresh()
    } finally {
      setSyncBusy(false)
    }
  }

  async function runActiveSync() {
    setSyncBusy(true)
    try {
      await window.conv.sync.runActiveChat()
      await refreshSync()
      if (lastHitPhoneRef.current) await handleRefresh()
    } finally {
      setSyncBusy(false)
    }
  }

  async function dismissSyncIssue(issueKey: string) {
    await window.conv.sync.dismissIssue(issueKey)
    await refreshSync()
  }

  async function runInsights() {
    setSyncBusy(true)
    try {
      await window.conv.insights.runNow()
      await refreshSync()
    } finally {
      setSyncBusy(false)
    }
  }

  async function repairStructuredInsights() {
    setSyncBusy(true)
    try {
      await window.conv.insights.repairStructured()
      await refreshSync()
    } finally {
      setSyncBusy(false)
    }
  }

  async function approveAllStagedOutputs() {
    setSyncBusy(true)
    try {
      await window.conv.insights.approvePendingStagedOutputs()
      await refreshSync()
      if (lastHitPhoneRef.current) await handleRefresh()
    } finally {
      setSyncBusy(false)
    }
  }

  async function approveStagedOutput(id: number) {
    setSyncBusy(true)
    try {
      await window.conv.insights.approveStagedOutput(id)
      await refreshSync()
      if (lastHitPhoneRef.current) await handleRefresh()
    } finally {
      setSyncBusy(false)
    }
  }

  async function updateStagedOutput(id: number, body: string) {
    await window.conv.insights.updateStagedOutput(id, body)
    await refreshSync()
  }

  async function retryFailed() {
    setSyncBusy(true)
    try {
      await window.conv.sync.retryFailed()
      await refreshSync()
    } finally {
      setSyncBusy(false)
    }
  }

  async function openBridgePairing() {
    await window.conv.whatsappBridge.link()
    await refreshSync()
  }

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

      <SyncStatusBar
        status={syncStatus}
        busy={syncBusy}
        onOpen={() => setSyncDrawerOpen(true)}
        onRunActive={runActiveSync}
      />

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
      {syncDrawerOpen && (
        <SyncDrawer
          status={syncStatus}
          issues={syncIssues}
          stagedOutputs={stagedOutputs}
          busy={syncBusy}
          onClose={() => setSyncDrawerOpen(false)}
          onRunCatchUp={runCatchUp}
          onRunActive={runActiveSync}
          onRunInsights={runInsights}
          onRepairStructured={repairStructuredInsights}
          onRetryFailed={retryFailed}
          onOpenBridgePairing={openBridgePairing}
          onResolveIssue={setResolvingIssue}
          onDismissIssue={dismissSyncIssue}
          onOpenAiReview={() => setAiReviewOpen(true)}
        />
      )}
      {aiReviewOpen && (
        <AiReviewTable
          outputs={stagedOutputs}
          busy={syncBusy}
          onClose={() => setAiReviewOpen(false)}
          onRefresh={refreshSync}
          onUpdate={updateStagedOutput}
          onApprove={approveStagedOutput}
          onApproveAll={approveAllStagedOutputs}
        />
      )}
      {resolvingIssue && (
        <MapParticipantModal
          participant={{
            phone: issuePhone(resolvingIssue),
            lid: null,
            waName: issueName(resolvingIssue),
            avatarDataUrl: null,
          }}
          onClose={() => setResolvingIssue(null)}
          onDone={async () => {
            setResolvingIssue(null)
            await runInsights()
          }}
        />
      )}
    </div>
  )
}

function SyncStatusBar({
  status,
  busy,
  onOpen,
  onRunActive,
}: {
  status: SyncStatus
  busy: boolean
  onOpen: () => void
  onRunActive: () => void
}) {
  const className = `sync-status sync-${status.state}`
  return (
    <div className={className}>
      <button className="sync-status-main" onClick={onOpen}>
        <span className="sync-dot" />
        <span className="sync-copy">
          <strong>{status.label}</strong>
          <span>{status.detail}</span>
        </span>
      </button>
      <button
        className="sync-mini-action"
        onClick={onRunActive}
        disabled={busy || status.state === 'scanning'}
      >
        {busy || status.state === 'scanning' ? 'Running' : 'Sync chat'}
      </button>
    </div>
  )
}

function SyncDrawer({
  status,
  issues,
  stagedOutputs,
  busy,
  onClose,
  onRunCatchUp,
  onRunActive,
  onRunInsights,
  onRepairStructured,
  onRetryFailed,
  onOpenBridgePairing,
  onResolveIssue,
  onDismissIssue,
  onOpenAiReview,
}: {
  status: SyncStatus
  issues: SyncIssue[]
  stagedOutputs: AiStagedOutput[]
  busy: boolean
  onClose: () => void
  onRunCatchUp: () => void
  onRunActive: () => void
  onRunInsights: () => void
  onRepairStructured: () => void
  onRetryFailed: () => void
  onOpenBridgePairing: () => void
  onResolveIssue: (issue: SyncIssue) => void
  onDismissIssue: (issueKey: string) => void
  onOpenAiReview: () => void
}) {
  const identityIssues = issues.filter((issue) => issue.kind === 'identity_resolution')
  const errorIssues = issues.filter((issue) => issue.kind === 'sync_error')
  const historyIssues = issues.filter((issue) => issue.kind === 'history_import')
  const pendingOutputs = stagedOutputs.filter((output) => output.status === 'pending' || output.status === 'failed')
  const bridge = status.bridgeStatus

  return (
    <div className="sync-drawer-backdrop" onClick={onClose}>
      <aside className="sync-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="sync-drawer-header">
          <div>
            <div className="sync-drawer-eyebrow">Sync health</div>
            <h2>{status.label}</h2>
            <p>{status.detail}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close sync drawer">
            ×
          </button>
        </div>

        <div className="sync-metrics">
          <div>
            <strong>{status.uploadedCount}</strong>
            <span>uploaded</span>
          </div>
          <div>
            <strong>{identityIssues.length}</strong>
            <span>need match</span>
          </div>
          <div>
            <strong>{status.lastRunAt ? formatSyncAgo(status.lastRunAt) : 'never'}</strong>
            <span>last run</span>
          </div>
          <div>
            <strong>{bridge?.importedToday ?? 0}</strong>
            <span>bridge today</span>
          </div>
          <div>
            <strong>{pendingOutputs.length}</strong>
            <span>AI review</span>
          </div>
          <div>
            <strong>{status.lastInsightRun ? formatAiRunCounts(status.lastInsightRun) : 'never'}</strong>
            <span>last AI</span>
          </div>
          <div>
            <strong>{status.nextInsightRunAt ? formatClock(status.nextInsightRunAt) : 'n/a'}</strong>
            <span>next AI</span>
          </div>
        </div>

        {bridge && (
          <div className={`sync-bridge sync-bridge-${bridge.state}`}>
            <div>
              <strong>{bridge.label}</strong>
              <p>{bridge.detail}</p>
              <span>{bridge.storeDir}</span>
            </div>
            {(bridge.state === 'needs_linking' || bridge.state === 'not_installed' || bridge.state === 'offline') && (
              <button onClick={onOpenBridgePairing}>Pair</button>
            )}
          </div>
        )}

        <div className="sync-actions">
          <button className="primary" disabled={busy || status.state === 'scanning'} onClick={onRunCatchUp}>
            {busy || status.state === 'scanning' ? 'Catching up...' : 'Catch up recent chats'}
          </button>
          <button className="ghost" disabled={busy || status.state === 'scanning'} onClick={onRunActive}>
            Sync active chat
          </button>
          <button className="ghost" disabled={busy || status.state === 'scanning'} onClick={onRunInsights}>
            Analyze new
          </button>
          <button className="ghost" disabled={busy || status.state === 'scanning'} onClick={onRepairStructured}>
            Repair structured
          </button>
          <button className="ghost" disabled={busy} onClick={onOpenAiReview}>
            Review AI table
          </button>
          <button className="ghost" disabled={busy || status.state === 'scanning'} onClick={onRetryFailed}>
            Retry failed
          </button>
        </div>

        <SyncIssueGroup
          title="Identity resolution"
          empty="No unmatched conversations."
          issues={identityIssues}
          actionLabel="Link or create contact"
          onResolveIssue={onResolveIssue}
          onDismissIssue={onDismissIssue}
        />
        <SyncIssueGroup
          title="Sync errors"
          empty="No sync errors."
          issues={errorIssues}
          actionLabel="Retry catch-up"
          onResolveIssue={onResolveIssue}
          onDismissIssue={onDismissIssue}
        />
        <SyncIssueGroup
          title="History imports"
          empty="No deep imports needed."
          issues={historyIssues}
          actionLabel="Import manually"
          onResolveIssue={onResolveIssue}
          onDismissIssue={onDismissIssue}
        />
      </aside>
    </div>
  )
}

function SyncIssueGroup({
  title,
  empty,
  issues,
  actionLabel,
  onResolveIssue,
  onDismissIssue,
}: {
  title: string
  empty: string
  issues: SyncIssue[]
  actionLabel: string
  onResolveIssue: (issue: SyncIssue) => void
  onDismissIssue: (issueKey: string) => void
}) {
  return (
    <section className="sync-issue-group">
      <div className="sync-issue-title">
        <span>{title}</span>
        <strong>{issues.length}</strong>
      </div>
      {issues.length === 0 ? (
        <div className="sync-empty">{empty}</div>
      ) : (
        <ul className="sync-issue-list">
          {issues.map((issue) => (
            <li key={issue.issue_key} className={`sync-issue sync-issue-${issue.severity}`}>
              <div>
                <strong>{issue.title}</strong>
                {issue.detail && <p>{issue.detail}</p>}
                <span>{actionLabel}</span>
              </div>
              {issue.kind === 'identity_resolution' && (
                <button onClick={() => onResolveIssue(issue)}>Resolve</button>
              )}
              <button onClick={() => onDismissIssue(issue.issue_key)}>Dismiss</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AiReviewTable({
  outputs,
  busy,
  onClose,
  onRefresh,
  onUpdate,
  onApprove,
  onApproveAll,
}: {
  outputs: AiStagedOutput[]
  busy: boolean
  onClose: () => void
  onRefresh: () => void
  onUpdate: (id: number, body: string) => Promise<void>
  onApprove: (id: number) => Promise<void>
  onApproveAll: () => Promise<void>
}) {
  const [editing, setEditing] = useState<Record<number, string>>({})
  const visible = outputs.filter((output) => output.status !== 'rejected')
  const pending = visible.filter((output) => output.status === 'pending' || output.status === 'failed')

  return (
    <div className="ai-review-backdrop">
      <section className="ai-review">
        <header className="ai-review-header">
          <div>
            <div className="sync-drawer-eyebrow">AI proposals</div>
            <h2>Review before reThink</h2>
            <p>{pending.length} pending rows. Edit text, then approve what should enter the database.</p>
          </div>
          <div className="ai-review-actions">
            <button className="ghost" onClick={onRefresh} disabled={busy}>Refresh</button>
            <button className="primary" onClick={onApproveAll} disabled={busy || pending.length === 0}>
              Approve pending
            </button>
            <button className="icon-button" onClick={onClose} aria-label="Close AI review">×</button>
          </div>
        </header>
        <div className="ai-review-table-wrap">
          <table className="ai-review-table">
            <thead>
              <tr>
                <th>Contact</th>
                <th>Date</th>
                <th>reThink column</th>
                <th>AI proposal</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="ai-review-empty">No AI proposals yet.</td>
                </tr>
              ) : (
                visible.map((output) => {
                  const draft = editing[output.id] ?? output.body ?? ''
                  return (
                    <tr key={output.id} className={`ai-row-${output.status}`}>
                      <td>
                        <strong>{output.title ?? 'Unknown contact'}</strong>
                        <span>{shortId(output.contact_id)}</span>
                      </td>
                      <td>{output.interaction_date ?? 'n/a'}</td>
                      <td><code>{targetLabel(output.target)}</code></td>
                      <td>
                        <textarea
                          value={draft}
                          disabled={output.status === 'synced'}
                          onChange={(event) =>
                            setEditing((current) => ({ ...current, [output.id]: event.target.value }))
                          }
                          onBlur={() => {
                            if (draft !== (output.body ?? '')) void onUpdate(output.id, draft)
                          }}
                        />
                        {output.error && <div className="ai-review-error">{output.error}</div>}
                      </td>
                      <td>{output.status}</td>
                      <td>
                        <button
                          className="ghost"
                          disabled={busy || output.status === 'synced'}
                          onClick={async () => {
                            if (draft !== (output.body ?? '')) await onUpdate(output.id, draft)
                            await onApprove(output.id)
                          }}
                        >
                          Approve
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function formatSyncAgo(timestamp: number) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function formatClock(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function formatAiRunCounts(run: SyncStatus['lastInsightRun']) {
  if (!run) return 'never'
  const parts = [
    run.interactions_written ? `${run.interactions_written} act` : null,
    run.contact_facts_written ? `${run.contact_facts_written} facts` : null,
    run.value_logs_written ? `${run.value_logs_written} value` : null,
    run.todos_written ? `${run.todos_written} todos` : null,
    run.review_items_written ? `${run.review_items_written} review` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' / ') : formatSyncAgo(run.created_at)
}

function targetLabel(target: AiStagedOutput['target']) {
  if (target === 'interaction') return 'interactions'
  if (target === 'contact_fact') return 'contact_facts'
  if (target === 'value_log') return 'value_logs'
  if (target === 'todo') return 'todos'
  return 'review_items'
}

function shortId(id: string | null) {
  return id ? id.slice(0, 8) : 'unlinked'
}

function issuePhone(issue: SyncIssue): string | null {
  const raw = issue.chat_key || ''
  if (/^\+?\d{7,16}$/.test(raw)) return raw.startsWith('+') ? raw : `+${raw}`
  const jidUser = raw.split('@')[0]
  if (/^\d{7,16}$/.test(jidUser)) return `+${jidUser}`
  return null
}

function issueName(issue: SyncIssue): string | null {
  return issue.title?.replace(/^Link WhatsApp chat:\s*/i, '').trim() || null
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
    void window.conv.insights.runNow().catch(() => {})
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
