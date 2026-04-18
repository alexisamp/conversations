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
      location: string | null
      about: string | null
      photoUrl: string | null
      avatarDataUrl: string | null
    }

export type EnrichFromLiInput = {
  contact_id: string
  name: string | null
  jobTitle: string | null
  location: string | null
  about: string | null
  photoUrl: string | null
}

export type CreateFromLiInput = {
  url: string
  name: string
  jobTitle: string | null
  location: string | null
  about: string | null
  photoUrl: string | null
}

export type SidebarContext =
  | { tab: 'wa'; state: WaState }
  | { tab: 'li'; state: LiState }

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
  },
  wa: {
    navigateToDm: (phone: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('wa:navigate-to-dm', phone),
    invalidatePhoneCache: (phone: string): void => {
      ipcRenderer.send('main:invalidatePhoneCache', phone)
    },
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
