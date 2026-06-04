import { getDb } from '../db/local'
import { getSupabase } from '../supabase/client'

type HistoricalEntry = {
  timestamp: number
  direction: 'inbound' | 'outbound'
  dataId: string
  text: string | null
}

type BackfillImportResult = {
  windowsFound: number
  windowsImported: number
  skipped: number
  error?: string
}

type WaPersonContext = {
  kind: 'person'
  phone: string | null
  name: string | null
}

type WaContext =
  | { kind: 'none' }
  | WaPersonContext
  | { kind: 'group'; groupId: string; name?: string | null }

export type SyncState =
  | 'idle'
  | 'scanning'
  | 'up_to_date'
  | 'needs_identity_resolution'
  | 'failed'

export type SyncStatus = {
  state: SyncState
  label: string
  detail: string
  activeJob: string | null
  lastRunAt: number | null
  uploadedCount: number
  unmatchedCount: number
  issueCount: number
  error?: string
}

export type SyncIssue = {
  id: number
  issue_key: string
  kind: 'identity_resolution' | 'history_import' | 'sync_error'
  severity: 'info' | 'warning' | 'error'
  title: string
  detail: string | null
  chat_key: string | null
  contact_id: string | null
  status: 'open' | 'resolved' | 'dismissed'
  created_at: number
  updated_at: number
  resolved_at: number | null
}

type RecentChat = {
  index: number
  key: string
  name: string | null
  phone: string | null
  unread: boolean
  selected: boolean
}

type CreateSyncCoordinatorOptions = {
  getWhatsAppWebContents: () => Electron.WebContents | null
  getCurrentWaContext: () => WaContext
  scanVisibleHistory: () => Promise<HistoricalEntry[]>
  importBackfillWindows: (input: {
    contactId: string
    phone: string
    entries: HistoricalEntry[]
    reachedStart?: boolean
  }) => Promise<BackfillImportResult>
  resolveContactByPhone: (phone: string) => Promise<string | null>
  publishStatus: (status: SyncStatus) => void
}

type JobResult = {
  chatsScanned: number
  uploadedCount: number
  unmatchedCount: number
}

const ACTIVE_SCAN_DEBOUNCE_MS = 1800
const STARTUP_CATCHUP_DELAY_MS = 12000
const CHAT_SWITCH_SETTLE_MS = 1800
const DEFAULT_RECENT_LIMIT = 12

const COLLECT_RECENT_CHATS_SCRIPT = `
(function() {
  function parsePhone(raw) {
    var digits = (raw || '').replace(/[^\\d+]/g, '');
    if (/^\\+?\\d{7,15}$/.test(digits)) return digits.charAt(0) === '+' ? digits : '+' + digits;
    return null;
  }
  function rowName(row) {
    var title = row.querySelector('[title]');
    var titleText = title && title.getAttribute('title');
    if (titleText && titleText.trim().length > 1) return titleText.trim();
    var spans = Array.prototype.slice.call(row.querySelectorAll('span[dir="auto"]'));
    for (var i = 0; i < spans.length; i++) {
      var text = (spans[i].innerText || '').trim();
      if (text.length >= 2 && text.length <= 120 && !/^\\d{1,2}:\\d{2}$/.test(text)) return text;
    }
    var raw = (row.innerText || '').trim();
    if (!raw) return null;
    return raw.split(/\\n/)[0].trim() || null;
  }
  var list =
    document.querySelector('[role="grid"][aria-label="Chat list"]') ||
    document.querySelector('[role="grid"][aria-label*="chat"]') ||
    document.querySelector('[role="grid"][aria-label*="Chat"]') ||
    document.querySelector('#pane-side');
  if (!list) return [];
  var rows = Array.prototype.slice.call(list.querySelectorAll('[role="row"], [aria-selected]'));
  var out = [];
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var rect = row.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) continue;
    var name = rowName(row);
    if (!name) continue;
    if (/^(archived|chats|status|calls)$/i.test(name)) continue;
    var phone = parsePhone(name);
    var key = phone || ('name:' + name.toLowerCase());
    if (seen[key]) continue;
    seen[key] = true;
    var text = (row.innerText || '') + ' ' + (row.getAttribute('aria-label') || '');
    var unread = /unread|no leídos?|sin leer/i.test(text);
    var selected = row.getAttribute('aria-selected') === 'true';
    out.push({ index: i, key: key, name: name, phone: phone, unread: unread, selected: selected });
    if (out.length >= 30) break;
  }
  return out;
})()
`.trim()

function clickChatScript(index: number): string {
  return `
    (function() {
      var list =
        document.querySelector('[role="grid"][aria-label="Chat list"]') ||
        document.querySelector('[role="grid"][aria-label*="chat"]') ||
        document.querySelector('[role="grid"][aria-label*="Chat"]') ||
        document.querySelector('#pane-side');
      if (!list) return false;
      var rows = Array.prototype.slice.call(list.querySelectorAll('[role="row"], [aria-selected]'));
      var row = rows[${JSON.stringify(index)}];
      if (!row) return false;
      row.scrollIntoView({ block: 'center' });
      row.click();
      return true;
    })()
  `.trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function localDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

type BackfillWindow = {
  timestamp: number
  direction: 'inbound' | 'outbound'
  messageCount: number
  windowEnd: number
  entries: HistoricalEntry[]
}

function groupInto6HourWindows(entries: HistoricalEntry[]): BackfillWindow[] {
  if (entries.length === 0) return []
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp)
  const sixHours = 6 * 60 * 60 * 1000
  const windows: BackfillWindow[] = []
  let group: HistoricalEntry[] = []
  let windowStart = sorted[0].timestamp

  const flush = () => {
    if (group.length === 0) return
    const outbound = group.filter((entry) => entry.direction === 'outbound').length
    windows.push({
      timestamp: windowStart,
      direction: outbound >= group.length - outbound ? 'outbound' : 'inbound',
      messageCount: group.length,
      windowEnd: windowStart + sixHours,
      entries: [...group],
    })
  }

  for (const entry of sorted) {
    if (entry.timestamp - windowStart > sixHours) {
      flush()
      windowStart = entry.timestamp
      group = [entry]
    } else {
      group.push(entry)
    }
  }
  flush()
  return windows
}

function conversationPreview(win: BackfillWindow): string {
  const lines = win.entries
    .filter((entry) => entry.text?.trim())
    .slice(0, 12)
    .map((entry) => {
      const speaker = entry.direction === 'outbound' ? 'Yo' : 'Ellos'
      return `${speaker}: ${entry.text!.trim()}`
    })
  return lines.join('\n') || `[whatsapp] ${win.messageCount} messages without text captions`
}

function chatKeyFor(ctx: WaPersonContext): string {
  return ctx.phone ?? (ctx.name ? `name:${ctx.name.toLowerCase()}` : 'unknown')
}

export function createSyncCoordinator(options: CreateSyncCoordinatorOptions) {
  let activeJob: string | null = null
  let running = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let startupCatchupScheduled = false

  function getStatus(activeOverride = activeJob, error?: string): SyncStatus {
    const db = getDb()
    const latest = db
      .prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1')
      .get() as
      | {
          started_at: number
          uploaded_count: number
          unmatched_count: number
          error: string | null
        }
      | undefined
    const openIssues = db
      .prepare('SELECT COUNT(*) AS c FROM sync_issues WHERE status = ?')
      .get('open') as { c: number }
    const identityIssues = db
      .prepare('SELECT COUNT(*) AS c FROM sync_issues WHERE status = ? AND kind = ?')
      .get('open', 'identity_resolution') as { c: number }

    if (activeOverride) {
      return {
        state: 'scanning',
        label: 'Scanning',
        detail: activeOverride,
        activeJob: activeOverride,
        lastRunAt: latest?.started_at ?? null,
        uploadedCount: latest?.uploaded_count ?? 0,
        unmatchedCount: latest?.unmatched_count ?? 0,
        issueCount: openIssues.c,
        error,
      }
    }
    if (error || latest?.error) {
      return {
        state: 'failed',
        label: 'Sync failed',
        detail: error ?? latest?.error ?? 'Unknown sync error',
        activeJob: null,
        lastRunAt: latest?.started_at ?? null,
        uploadedCount: latest?.uploaded_count ?? 0,
        unmatchedCount: latest?.unmatched_count ?? 0,
        issueCount: openIssues.c,
        error: error ?? latest?.error ?? undefined,
      }
    }
    if (identityIssues.c > 0) {
      return {
        state: 'needs_identity_resolution',
        label: 'Needs identity resolution',
        detail: `${identityIssues.c} conversation${identityIssues.c === 1 ? '' : 's'} need matching in reThink`,
        activeJob: null,
        lastRunAt: latest?.started_at ?? null,
        uploadedCount: latest?.uploaded_count ?? 0,
        unmatchedCount: identityIssues.c,
        issueCount: openIssues.c,
      }
    }
    if (latest) {
      return {
        state: 'up_to_date',
        label: 'Up to date',
        detail: latest.uploaded_count > 0 ? `${latest.uploaded_count} uploaded` : 'No pending conversations found',
        activeJob: null,
        lastRunAt: latest.started_at,
        uploadedCount: latest.uploaded_count,
        unmatchedCount: latest.unmatched_count,
        issueCount: openIssues.c,
      }
    }
    return {
      state: 'idle',
      label: 'Not scanned yet',
      detail: 'Open WhatsApp or run catch-up',
      activeJob: null,
      lastRunAt: null,
      uploadedCount: 0,
      unmatchedCount: 0,
      issueCount: openIssues.c,
    }
  }

  function publish(error?: string) {
    options.publishStatus(getStatus(activeJob, error))
  }

  function openIssue(input: {
    issueKey: string
    kind: SyncIssue['kind']
    severity: SyncIssue['severity']
    title: string
    detail?: string | null
    chatKey?: string | null
    contactId?: string | null
  }) {
    getDb()
      .prepare(
        `
        INSERT INTO sync_issues
          (issue_key, kind, severity, title, detail, chat_key, contact_id, status, created_at, updated_at)
        VALUES
          (@issueKey, @kind, @severity, @title, @detail, @chatKey, @contactId, 'open', @now, @now)
        ON CONFLICT(issue_key) DO UPDATE SET
          severity = excluded.severity,
          title = excluded.title,
          detail = excluded.detail,
          chat_key = excluded.chat_key,
          contact_id = excluded.contact_id,
          status = 'open',
          updated_at = excluded.updated_at,
          resolved_at = NULL
      `,
      )
      .run({
        ...input,
        detail: input.detail ?? null,
        chatKey: input.chatKey ?? null,
        contactId: input.contactId ?? null,
        now: Date.now(),
      })
  }

  function resolveIssue(issueKey: string) {
    getDb()
      .prepare(
        "UPDATE sync_issues SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE issue_key = ?",
      )
      .run(Date.now(), Date.now(), issueKey)
  }

  function recordChatState(input: {
    chatKey: string
    waName: string | null
    phone: string | null
    contactId: string | null
    status: 'up_to_date' | 'needs_identity_resolution' | 'failed' | 'skipped'
    entriesSeen: number
    windowsWritten: number
    error?: string | null
  }) {
    getDb()
      .prepare(
        `
        INSERT INTO chat_sync_state
          (chat_key, wa_name, phone, contact_id, status, last_scanned_at, entries_seen, windows_written, error)
        VALUES
          (@chatKey, @waName, @phone, @contactId, @status, @now, @entriesSeen, @windowsWritten, @error)
        ON CONFLICT(chat_key) DO UPDATE SET
          wa_name = excluded.wa_name,
          phone = excluded.phone,
          contact_id = excluded.contact_id,
          status = excluded.status,
          last_scanned_at = excluded.last_scanned_at,
          entries_seen = excluded.entries_seen,
          windows_written = excluded.windows_written,
          error = excluded.error
      `,
      )
      .run({
        ...input,
        now: Date.now(),
        error: input.error ?? null,
      })
  }

  async function createReviewItemsForUnmatched(
    ctx: WaPersonContext,
    entries: HistoricalEntry[],
  ): Promise<number> {
    const supabase = getSupabase()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) throw new Error('not signed in')

    const chatKey = chatKeyFor(ctx)
    const windows = groupInto6HourWindows(entries)
    let written = 0

    for (const win of windows) {
      const startIso = new Date(win.timestamp).toISOString()
      const sourceExternalId = `wa-unmatched:${chatKey}:${startIso}`
      const notes = conversationPreview(win)
      const title = `Resolve WhatsApp conversation: ${ctx.name ?? ctx.phone ?? 'Unknown chat'}`
      const payload = {
        type: 'whatsapp',
        channel: 'whatsapp',
        direction: win.direction,
        interaction_date: localDay(win.timestamp),
        notes,
        wa_phone: ctx.phone,
        wa_name: ctx.name,
        source_kind: 'identity_resolution',
        message_count: win.messageCount,
        window_start: startIso,
        window_end: new Date(win.windowEnd).toISOString(),
      }

      const { data: existing } = await supabase
        .from('review_items')
        .select('id')
        .eq('user_id', user.id)
        .eq('source', 'conversations')
        .eq('source_external_id', sourceExternalId)
        .eq('status', 'pending')
        .maybeSingle()

      if (existing?.id) {
        const { error } = await supabase
          .from('review_items')
          .update({
            title,
            body: notes,
            proposed_payload: payload,
            proposed_target: 'interaction',
          })
          .eq('id', existing.id)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await supabase.from('review_items').insert({
          user_id: user.id,
          source: 'conversations',
          source_external_id: sourceExternalId,
          source_url: null,
          title,
          body: notes,
          proposed_target: 'interaction',
          proposed_payload: payload,
          contact_id: null,
          status: 'pending',
        })
        if (error && error.code !== '23505') throw new Error(error.message)
      }
      written++
    }
    return written
  }

  async function scanContext(ctx: WaContext, label: string): Promise<JobResult> {
    if (ctx.kind !== 'person') return { chatsScanned: 0, uploadedCount: 0, unmatchedCount: 0 }

    const chatKey = chatKeyFor(ctx)
    const issueKey = `identity:${chatKey}`
    const entries = await options.scanVisibleHistory()
    if (entries.length === 0) {
      recordChatState({
        chatKey,
        waName: ctx.name,
        phone: ctx.phone,
        contactId: null,
        status: 'skipped',
        entriesSeen: 0,
        windowsWritten: 0,
      })
      return { chatsScanned: 1, uploadedCount: 0, unmatchedCount: 0 }
    }

    let contactId: string | null = null
    if (ctx.phone) contactId = await options.resolveContactByPhone(ctx.phone)

    if (contactId) {
      const result = await options.importBackfillWindows({
        contactId,
        phone: ctx.phone ?? chatKey,
        entries,
        reachedStart: false,
      })
      if (result.error) throw new Error(result.error)
      recordChatState({
        chatKey,
        waName: ctx.name,
        phone: ctx.phone,
        contactId,
        status: 'up_to_date',
        entriesSeen: entries.length,
        windowsWritten: result.windowsImported,
      })
      resolveIssue(issueKey)
      console.log('[sync-coordinator] %s matched chat=%s entries=%d imported=%d skipped=%d',
        label,
        chatKey,
        entries.length,
        result.windowsImported,
        result.skipped,
      )
      return {
        chatsScanned: 1,
        uploadedCount: result.windowsImported,
        unmatchedCount: 0,
      }
    }

    const reviewItems = await createReviewItemsForUnmatched(ctx, entries)
    openIssue({
      issueKey,
      kind: 'identity_resolution',
      severity: 'warning',
      title: ctx.name ?? ctx.phone ?? 'Unmatched WhatsApp conversation',
      detail: `${entries.length} messages uploaded to reThink review. Match this WhatsApp chat to a contact before accepting.`,
      chatKey,
    })
    recordChatState({
      chatKey,
      waName: ctx.name,
      phone: ctx.phone,
      contactId: null,
      status: 'needs_identity_resolution',
      entriesSeen: entries.length,
      windowsWritten: reviewItems,
    })
    console.log('[sync-coordinator] %s unmatched chat=%s entries=%d review_items=%d',
      label,
      chatKey,
      entries.length,
      reviewItems,
    )
    return { chatsScanned: 1, uploadedCount: reviewItems, unmatchedCount: 1 }
  }

  async function runJob(label: string, fn: () => Promise<JobResult>): Promise<JobResult> {
    if (running) return { chatsScanned: 0, uploadedCount: 0, unmatchedCount: 0 }
    running = true
    activeJob = label
    publish()
    const db = getDb()
    const startedAt = Date.now()
    const runId = Number(
      db
        .prepare('INSERT INTO sync_runs (reason, status, started_at) VALUES (?, ?, ?)')
        .run(label, 'running', startedAt).lastInsertRowid,
    )
    try {
      const result = await fn()
      db.prepare(
        `
        UPDATE sync_runs
        SET status = 'succeeded', finished_at = ?, chats_scanned = ?, uploaded_count = ?, unmatched_count = ?
        WHERE id = ?
      `,
      ).run(Date.now(), result.chatsScanned, result.uploadedCount, result.unmatchedCount, runId)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      db.prepare(
        "UPDATE sync_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?",
      ).run(Date.now(), message, runId)
      openIssue({
        issueKey: `sync-error:${label}`,
        kind: 'sync_error',
        severity: 'error',
        title: 'Conversation sync failed',
        detail: message,
      })
      publish(message)
      throw err
    } finally {
      running = false
      activeJob = null
      publish()
    }
  }

  async function runActiveChat(reason = 'active chat scan'): Promise<JobResult> {
    return runJob(reason, async () => scanContext(options.getCurrentWaContext(), reason))
  }

  async function runRecentCatchUp(limit = DEFAULT_RECENT_LIMIT): Promise<JobResult> {
    return runJob('recent chats catch-up', async () => {
      const webContents = options.getWhatsAppWebContents()
      if (!webContents) throw new Error('WhatsApp view not ready')
      const chats = (await webContents.executeJavaScript(
        COLLECT_RECENT_CHATS_SCRIPT,
        true,
      )) as RecentChat[]
      const selected = chats.find((chat) => chat.selected)
      const prioritized = [...chats]
        .sort((a, b) => Number(b.unread) - Number(a.unread))
        .slice(0, Math.max(1, limit))

      let total: JobResult = { chatsScanned: 0, uploadedCount: 0, unmatchedCount: 0 }
      for (const chat of prioritized) {
        const clicked = (await webContents.executeJavaScript(
          clickChatScript(chat.index),
          true,
        )) as boolean
        if (!clicked) continue
        await sleep(CHAT_SWITCH_SETTLE_MS)
        const result = await scanContext(options.getCurrentWaContext(), 'recent chats catch-up')
        total = {
          chatsScanned: total.chatsScanned + result.chatsScanned,
          uploadedCount: total.uploadedCount + result.uploadedCount,
          unmatchedCount: total.unmatchedCount + result.unmatchedCount,
        }
      }

      if (selected) {
        await webContents.executeJavaScript(clickChatScript(selected.index), true).catch(() => {})
      }
      return total
    })
  }

  function scheduleActiveChat(reason: string): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void runActiveChat(reason).catch((err) => {
        console.error('[sync-coordinator] scheduled active scan failed:', err)
      })
    }, ACTIVE_SCAN_DEBOUNCE_MS)
  }

  function scheduleStartupCatchUp(): void {
    if (startupCatchupScheduled) return
    startupCatchupScheduled = true
    setTimeout(() => {
      void runRecentCatchUp(DEFAULT_RECENT_LIMIT).catch((err) => {
        console.error('[sync-coordinator] startup catch-up failed:', err)
      })
    }, STARTUP_CATCHUP_DELAY_MS)
  }

  function listIssues(): SyncIssue[] {
    return getDb()
      .prepare('SELECT * FROM sync_issues WHERE status = ? ORDER BY updated_at DESC LIMIT 100')
      .all('open') as SyncIssue[]
  }

  function dismissIssue(issueKey: string): void {
    getDb()
      .prepare(
        "UPDATE sync_issues SET status = 'dismissed', resolved_at = ?, updated_at = ? WHERE issue_key = ?",
      )
      .run(Date.now(), Date.now(), issueKey)
    publish()
  }

  return {
    getStatus,
    listIssues,
    dismissIssue,
    runActiveChat,
    runRecentCatchUp,
    scheduleActiveChat,
    scheduleStartupCatchUp,
  }
}
