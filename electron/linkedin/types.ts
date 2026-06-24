export type VoyagerEntity = Record<string, any>

export type VoyagerResponse = {
  data?: any
  included?: VoyagerEntity[]
}

export type LinkedinSession = {
  authenticated: boolean
  memberUrn?: string
  displayName?: string
  publicId?: string
}

export type NormalizedLinkedinProfile = {
  urn: string
  public_id: string | null
  first_name: string | null
  last_name: string | null
  full_name: string
  occupation: string | null
  location: string | null
  picture_url: string | null
  linkedin_url: string | null
}

export type NormalizedLinkedinConversation = {
  id: string
  participant_urns: string[]
  participant_names: string[]
  participant_pictures: string[]
  last_message: string | null
  last_activity_at: number
  read: number
  archived: number
  category: string | null
  starred: number
}

export type NormalizedLinkedinMessage = {
  id: string
  conversation_id: string
  sender_urn: string | null
  sender_name: string | null
  sender_picture: string | null
  body: string | null
  created_at_ms: number
  is_from_me: number
  attachments_json?: string | null
}

