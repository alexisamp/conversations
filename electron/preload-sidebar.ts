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
    logInteraction: (input: LogInteractionInput): Promise<WriteResult> =>
      ipcRenderer.invoke('contact:logInteraction', input),
    addValueLog: (input: AddValueLogInput): Promise<WriteResult> =>
      ipcRenderer.invoke('contact:addValueLog', input),
  },
  sidebar: {
    toggle: (): Promise<void> => ipcRenderer.invoke('sidebar:toggle'),
  },
}

contextBridge.exposeInMainWorld('conv', api)

export type ConvApi = typeof api
