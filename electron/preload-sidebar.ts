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
}

export type ContactDetail = {
  id: string
  name: string
  company: string | null
  phone: string | null
  status: string | null
  health_score: number | null
  last_interaction_at: string | null
  recent_interactions: InteractionSummary[]
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
  },
  sidebar: {
    toggle: (): Promise<void> => ipcRenderer.invoke('sidebar:toggle'),
  },
}

contextBridge.exposeInMainWorld('conv', api)

export type ConvApi = typeof api
