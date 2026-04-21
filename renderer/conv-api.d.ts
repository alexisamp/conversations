// Ambient types for the `window.conv` API exposed by electron/preload-sidebar.ts.

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
  phone: string | null
  lid: string | null
  waName: string | null
  avatarDataUrl: string | null
}

export type ParticipantLookupInput = {
  phone: string | null
  lid: string | null
  waName: string | null
}

export type WaState =
  | { kind: 'none' }
  // Since WhatsApp's 2026-04 DOM update, saved contacts expose a name but no
  // phone. Unsaved chats expose a phone (visible in the row/header). Either
  // field may be null; the sidebar lookup tries phone first, then name.
  | { kind: 'person'; phone: string | null; name: string | null }
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

export type ConvApi = {
  auth: {
    status(): Promise<AuthStatus>
    signIn(): Promise<void>
    signOut(): Promise<void>
    onChanged(cb: (status: AuthStatus) => void): void
  }
  contact: {
    byPhone(phone: string): Promise<ContactDetail | null>
    byName(name: string): Promise<ContactDetail | null>
    byLinkedinUrl(url: string): Promise<ContactDetail | null>
    logInteraction(input: LogInteractionInput): Promise<WriteResult>
    addValueLog(input: AddValueLogInput): Promise<WriteResult>
    briefsForParticipants(
      participants: ParticipantLookupInput[],
    ): Promise<Record<string, ContactBrief | null>>
    searchByName(query: string): Promise<ContactBrief[]>
    createFromParticipant(input: CreateContactInput): Promise<CreateContactResult>
    attachPhone(input: AttachPhoneInput): Promise<WriteResult>
    attachLid(input: AttachLidInput): Promise<WriteResult>
    attachWaName(input: { contact_id: string; waName: string }): Promise<WriteResult>
    createFromLinkedinProfile(input: CreateFromLiInput): Promise<CreateContactResult>
    enrichFromLinkedinProfile(input: EnrichFromLiInput): Promise<WriteResult>
  }
  sidebar: {
    onContext(cb: (ctx: SidebarContext) => void): void
    toggle(): Promise<void>
  }
  wa: {
    navigateToDm(phone: string): Promise<{ ok: boolean; error?: string }>
    invalidatePhoneCache(phone: string): void
  }
  backfill: {
    scanHistory(): Promise<{ entries: HistoricalEntry[]; error?: string }>
    scanWithScroll(): Promise<{
      entries: HistoricalEntry[]
      scrolls: number
      clicks: number
      reachedStart: boolean
      error?: string
    }>
    importWindows(input: BackfillImportInput): Promise<BackfillImportResult>
  }
  li: {
    navigate(url: string): Promise<{ ok: boolean; error?: string }>
  }
  updater: {
    getStatus(): Promise<UpdaterStatus>
    check(): Promise<UpdaterStatus>
    download(): Promise<UpdaterStatus>
    restartInstall(): Promise<void>
    onStatus(cb: (status: UpdaterStatus) => void): () => void
  }
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

declare global {
  interface Window {
    conv: ConvApi
  }
}

export {}
