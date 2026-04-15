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
}

export type CreateContactResult =
  | { ok: true; contactId: string; enriched: boolean }
  | { ok: false; error: string }

export type AttachPhoneInput = {
  contact_id: string
  phone: string
  waName: string | null
}

export type GroupParticipant = {
  phone: string
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
      avatarDataUrl: string | null
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
    byLinkedinUrl(url: string): Promise<ContactDetail | null>
    logInteraction(input: LogInteractionInput): Promise<WriteResult>
    addValueLog(input: AddValueLogInput): Promise<WriteResult>
    briefsByPhones(phones: string[]): Promise<Record<string, ContactBrief | null>>
    searchByName(query: string): Promise<ContactBrief[]>
    createFromParticipant(input: CreateContactInput): Promise<CreateContactResult>
    attachPhone(input: AttachPhoneInput): Promise<WriteResult>
  }
  sidebar: {
    onContext(cb: (ctx: SidebarContext) => void): void
    toggle(): Promise<void>
  }
  wa: {
    navigateToDm(phone: string): Promise<{ ok: boolean; error?: string }>
  }
  li: {
    navigate(url: string): Promise<{ ok: boolean; error?: string }>
  }
}

declare global {
  interface Window {
    conv: ConvApi
  }
}

export {}
