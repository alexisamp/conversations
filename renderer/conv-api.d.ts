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

export type ConvApi = {
  auth: {
    status(): Promise<AuthStatus>
    signIn(): Promise<void>
    signOut(): Promise<void>
    onChanged(cb: (status: AuthStatus) => void): void
  }
  contact: {
    byPhone(phone: string): Promise<ContactDetail | null>
  }
  sidebar: {
    toggle(): Promise<void>
  }
}

declare global {
  interface Window {
    conv: ConvApi
  }
}

export {}
