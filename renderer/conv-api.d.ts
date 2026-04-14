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

export type ConvApi = {
  auth: {
    status(): Promise<AuthStatus>
    signIn(): Promise<void>
    signOut(): Promise<void>
    onChanged(cb: (status: AuthStatus) => void): void
  }
  contact: {
    byPhone(phone: string): Promise<ContactDetail | null>
    logInteraction(input: LogInteractionInput): Promise<WriteResult>
    addValueLog(input: AddValueLogInput): Promise<WriteResult>
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
