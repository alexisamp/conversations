// Preload for the sidebar React app.
// Exposes a narrow, type-safe API on `window.conv` via contextBridge.

import { contextBridge, ipcRenderer } from 'electron'

export type AuthStatus = {
  signedIn: boolean
  email?: string
  userId?: string
}

export type InteractionSummary = {
  id: string
  type: string
  direction: string | null
  interaction_date: string
  notes: string | null
  next_step: string | null
  next_step_date: string | null
  next_step_owner: string | null
  channel: string | null
}

export type ValueLogSummary = {
  id: string
  type: string
  description: string | null
  date: string
}

export type OpportunitySummary = {
  id: string
  title: string
  stage: string
  company_name: string | null
}

export type ContactDetail = {
  id: string
  name: string
  tier: number | null
  profile_photo_url: string | null
  job_title: string | null
  company: string | null
  personal_context: string | null
  linkedin_url: string | null
  referred_by: string | null
  status: string | null
  category: string | null
  health_score: number | null
  last_interaction_at: string | null
  phone: string | null
  email: string | null
  birthday: string | null
  interaction_count: number
  value_log_count: number
  recent_interactions: InteractionSummary[]
  value_logs: ValueLogSummary[]
  active_opportunities: OpportunitySummary[]
}

export type ContactBrief = {
  id: string
  name: string
  job_title: string | null
  company: string | null
  profile_photo_url: string | null
  tier: number | null
  last_interaction_at: string | null
  status: string | null
  linkedin_url: string | null
}

export type LogInteractionInput = {
  contact_id: string
  type: string
  direction?: string
  notes: string | null
  next_step: string | null
  next_step_date: string | null
}

export type AddValueLogInput = {
  contact_id: string
  type: string
  description: string | null
}

export type WriteResult = { ok: true } | { ok: false; error: string }

export type CreateContactInput = {
  name: string
  linkedin_url: string | null
  phone: string
  waName: string | null
  referred_by: string | null
}

export type CreateContactResult =
  | { ok: true; contactId: string; enriched: boolean }
  | { ok: false; error: string }

export type AttachPhoneInput = {
  contact_id: string
  phone: string
  waName: string | null
}

export type AttachLidInput = {
  contact_id: string
  lid: string
  waName: string | null
}

export type GroupParticipant = {
  // One of phone or lid will be populated. phone is a real +E164 number;
  // lid is an opaque WhatsApp Linked ID with no phone mapping.
  phone: string | null
  lid: string | null
  waName: string | null
  avatarDataUrl: string | null
}

export type WaState =
  | { kind: 'none' }
  | { kind: 'person'; phone: string; name: string | null }
  | {
      kind: 'group'
      groupId: string
      name: string | null
      participants: GroupParticipant[]
    }

export type LiState =
  | { kind: 'none' }
  | {
      kind: 'profile'
      url: string
      slug: string
      name: string | null
      jobTitle: string | null
      company: string | null
      companyLinkedinUrl: string | null
      companyLogoUrl: string | null
      location: string | null
      about: string | null
      photoUrl: string | null
      avatarDataUrl: string | null
    }

export type EnrichFromLiInput = {
  contact_id: string
  name: string | null
  jobTitle: string | null
  company: string | null
  companyLinkedinUrl: string | null
  companyLogoUrl: string | null
  location: string | null
  about: string | null
  photoUrl: string | null
  linkedinUrl?: string | null
}

export type CreateFromLiInput = {
  url: string
  name: string
  jobTitle: string | null
  company: string | null
  companyLinkedinUrl: string | null
  companyLogoUrl: string | null
  location: string | null
  about: string | null
  photoUrl: string | null
}

export type SidebarContext =
  | { tab: 'wa'; state: WaState }
  | { tab: 'li'; state: LiState }
  | { tab: 'ai'; state: { kind: 'review' } }

export type SyncState =
  | 'idle'
  | 'scanning'
  | 'up_to_date'
  | 'needs_identity_resolution'
  | 'insight_pending'
  | 'failed'

export type WhatsappBridgeStatus = {
  state: 'not_installed' | 'starting' | 'needs_linking' | 'connected' | 'offline'
  label: string
  detail: string
  daemonUrl: string
  pairUrl: string
  storeDir: string
  binaryPath: string | null
  lastImportedAt: number | null
  importedToday: number
  error?: string
}

export type DailyAiRun = {
  id: number
  run_at: number
  scheduled_for: string
  date_covered: string
  status: 'running' | 'succeeded' | 'failed'
  messages_seen: number
  conversations_processed: number
  outputs_written: number
  interactions_written: number
  contact_facts_written: number
  value_logs_written: number
  todos_written: number
  review_items_written: number
  error: string | null
  created_at: number
  finished_at: number | null
}

export type AiStagedOutput = {
  id: number
  run_id: number | null
  source_key: string
  target: 'interaction' | 'contact_fact' | 'value_log' | 'todo' | 'review_item'
  contact_id: string | null
  interaction_date: string | null
  title: string | null
  body: string | null
  status: 'pending' | 'approved' | 'rejected' | 'synced' | 'failed'
  supabase_id: string | null
  error: string | null
  created_at: number
  updated_at: number
  confirmed_at: number | null
}

export type SyncStatus = {
  state: SyncState
  label: string
  detail: string
  activeJob: string | null
  lastRunAt: number | null
  uploadedCount: number
  unmatchedCount: number
  issueCount: number
  bridgeStatus?: WhatsappBridgeStatus
  lastInsightRun?: DailyAiRun | null
  nextInsightRunAt?: number | null
  pendingInsightOutputs?: number
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

const api = {
  auth: {
    status: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
    signIn: (): Promise<void> => ipcRenderer.invoke('auth:signIn'),
    signOut: (): Promise<void> => ipcRenderer.invoke('auth:signOut'),
    onChanged: (cb: (status: AuthStatus) => void): void => {
      ipcRenderer.on('auth:changed', (_event, status: AuthStatus) => cb(status))
    },
  },
  contact: {
    byPhone: (phone: string): Promise<ContactDetail | null> =>
      ipcRenderer.invoke('contact:byPhone', phone),
    byName: (name: string): Promise<ContactDetail | null> =>
      ipcRenderer.invoke('contact:byName', name),
    byLinkedinUrl: (url: string): Promise<ContactDetail | null> =>
      ipcRenderer.invoke('contact:byLinkedinUrl', url),
    logInteraction: (input: LogInteractionInput): Promise<WriteResult> =>
      ipcRenderer.invoke('contact:logInteraction', input),
    addValueLog: (input: AddValueLogInput): Promise<WriteResult> =>
      ipcRenderer.invoke('contact:addValueLog', input),
    briefsForParticipants: (
      participants: Array<{ phone: string | null; lid: string | null; waName: string | null }>,
    ): Promise<Record<string, ContactBrief | null>> =>
      ipcRenderer.invoke('contact:briefsForParticipants', participants),
    searchByName: (query: string): Promise<ContactBrief[]> =>
      ipcRenderer.invoke('contact:searchByName', query),
    createFromParticipant: (input: CreateContactInput): Promise<CreateContactResult> =>
      ipcRenderer.invoke('contact:createFromParticipant', input),
    attachPhone: (input: AttachPhoneInput): Promise<WriteResult> =>
      ipcRenderer.invoke('contact:attachPhone', input),
    attachLid: (input: AttachLidInput): Promise<WriteResult> =>
      ipcRenderer.invoke('contact:attachLid', input),
    attachWaName: (input: { contact_id: string; waName: string }): Promise<WriteResult> =>
      ipcRenderer.invoke('contact:attachWaName', input),
    createFromLinkedinProfile: (input: CreateFromLiInput): Promise<CreateContactResult> =>
      ipcRenderer.invoke('contact:createFromLinkedinProfile', input),
    enrichFromLinkedinProfile: (input: EnrichFromLiInput): Promise<WriteResult> =>
      ipcRenderer.invoke('contact:enrichFromLinkedinProfile', input),
  },
  sidebar: {
    onContext: (cb: (ctx: SidebarContext) => void): void => {
      ipcRenderer.on('sidebar:context', (_event, payload: SidebarContext) =>
        cb(payload),
      )
    },
    toggle: (): Promise<void> => ipcRenderer.invoke('sidebar:toggle'),
    openAiReview: (): Promise<void> => ipcRenderer.invoke('tab:switch-ai'),
  },
  sync: {
    getStatus: (): Promise<SyncStatus> => ipcRenderer.invoke('sync:get-status'),
    listIssues: (): Promise<SyncIssue[]> => ipcRenderer.invoke('sync:list-issues'),
    runActiveChat: (): Promise<{
      chatsScanned: number
      uploadedCount: number
      unmatchedCount: number
    }> => ipcRenderer.invoke('sync:run-active-chat'),
    runRecentCatchUp: (limit?: number): Promise<{
      chatsScanned: number
      uploadedCount: number
      unmatchedCount: number
    }> => ipcRenderer.invoke('sync:run-recent-catchup', limit),
    retryFailed: (): Promise<void> => ipcRenderer.invoke('sync:retry-failed'),
    dismissIssue: (issueKey: string): Promise<void> =>
      ipcRenderer.invoke('sync:dismiss-issue', issueKey),
    onStatus: (cb: (status: SyncStatus) => void): (() => void) => {
      const listener = (_: unknown, status: SyncStatus) => cb(status)
      ipcRenderer.on('sync:status', listener)
      return () => ipcRenderer.off('sync:status', listener)
    },
  },
  whatsappBridge: {
    getStatus: (): Promise<WhatsappBridgeStatus> =>
      ipcRenderer.invoke('whatsapp-bridge:get-status'),
    link: (): Promise<void> => ipcRenderer.invoke('whatsapp-bridge:link'),
  },
  insights: {
    runNow: (): Promise<{
      runId: number
      messagesSeen: number
      conversationsProcessed: number
      outputsWritten: number
    }> => ipcRenderer.invoke('insights:run-now'),
    repairStructured: (): Promise<{
      runId: number
      messagesSeen: number
      conversationsProcessed: number
      outputsWritten: number
    }> => ipcRenderer.invoke('insights:repair-structured'),
    getLastRuns: (): Promise<DailyAiRun[]> => ipcRenderer.invoke('insights:get-last-runs'),
    getStagedOutputs: (): Promise<AiStagedOutput[]> =>
      ipcRenderer.invoke('insights:get-staged-outputs'),
    updateStagedOutput: (id: number, body: string): Promise<AiStagedOutput | null> =>
      ipcRenderer.invoke('insights:update-staged-output', id, body),
    approveStagedOutput: (id: number): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('insights:approve-staged-output', id),
    approvePendingStagedOutputs: (): Promise<{ ok: true; synced: number; failed: number }> =>
      ipcRenderer.invoke('insights:approve-pending-staged-outputs'),
    approveStagedOutputs: (ids: number[]): Promise<{ ok: true; synced: number; failed: number }> =>
      ipcRenderer.invoke('insights:approve-staged-outputs', ids),
    rejectStagedOutputs: (ids: number[]): Promise<{ ok: true }> =>
      ipcRenderer.invoke('insights:reject-staged-outputs', ids),
  },
  identity: {
    linkChatToContact: (input: {
      chat_id: string
      contact_id: string
      wa_name: string | null
      phone: string | null
    }): Promise<WriteResult> => ipcRenderer.invoke('identity:link-chat-to-contact', input),
  },
  wa: {
    navigateToDm: (phone: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('wa:navigate-to-dm', phone),
    invalidatePhoneCache: (phone: string): void => {
      ipcRenderer.send('main:invalidatePhoneCache', phone)
    },
  },
  backfill: {
    scanHistory: (): Promise<{ entries: HistoricalEntry[]; error?: string }> =>
      ipcRenderer.invoke('backfill:scan-history'),
    scanWithScroll: (): Promise<{
      entries: HistoricalEntry[]
      scrolls: number
      clicks: number
      reachedStart: boolean
      error?: string
    }> => ipcRenderer.invoke('backfill:scan-with-scroll'),
    importWindows: (
      input: BackfillImportInput,
    ): Promise<BackfillImportResult> =>
      ipcRenderer.invoke('backfill:import-windows', input),
  },
  li: {
    navigate: (url: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('li:navigate', url),
  },
  updater: {
    getStatus: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updater:get-status'),
    check: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updater:check'),
    download: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updater:download'),
    restartInstall: (): Promise<void> => ipcRenderer.invoke('updater:restart-install'),
    onStatus: (cb: (status: UpdaterStatus) => void): (() => void) => {
      const listener = (_: unknown, status: UpdaterStatus) => cb(status)
      ipcRenderer.on('updater:status', listener)
      return () => ipcRenderer.off('updater:status', listener)
    },
  },
}

export interface HistoricalEntry {
  timestamp: number
  direction: 'inbound' | 'outbound'
  dataId: string
}

export interface BackfillImportInput {
  contactId: string
  phone: string
  entries: HistoricalEntry[]
  reachedStart?: boolean
}

export interface BackfillImportResult {
  windowsFound: number
  windowsImported: number
  skipped: number
  error?: string
}

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdaterStatus {
  currentVersion: string
  state: UpdaterState
  availableVersion?: string
  progressPercent?: number
  error?: string
  dev: boolean
}

contextBridge.exposeInMainWorld('conv', api)

export type ConvApi = typeof api
