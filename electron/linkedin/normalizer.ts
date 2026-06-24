import type {
  NormalizedLinkedinConversation,
  NormalizedLinkedinMessage,
  NormalizedLinkedinProfile,
  VoyagerEntity,
  VoyagerResponse,
} from './types'

export function extractProfileId(urn: string | null | undefined): string {
  const match = (urn ?? '').match(/fsd_profile:([^,)]+)/)
  return match ? match[1] : (urn ?? '')
}

function publicIdFromMember(member: any, fallback: string): string | null {
  return member?.profileUrl?.split('/in/')?.[1]?.split(/[/?#]/)[0] || member?.publicIdentifier || fallback || null
}

function pickArtifact(artifacts: any[] | undefined, minWidth = 100): any | null {
  if (!artifacts?.length) return null
  return [...artifacts].sort((a, b) => Math.abs((a.width ?? 0) - minWidth) - Math.abs((b.width ?? 0) - minWidth))[0]
}

function participantPicture(participant: VoyagerEntity | undefined): string | null {
  const pic = participant?.participantType?.member?.profilePicture
  if (!pic) return null
  if (pic.artifacts?.length) {
    const artifact = pickArtifact(pic.artifacts, 100)
    if (artifact?.fileUrl) return artifact.fileUrl
    if (pic.rootUrl && artifact?.fileIdentifyingUrlPathSegment) return `${pic.rootUrl}${artifact.fileIdentifyingUrlPathSegment}`
  }
  const vectorImage = pic.displayImageReference?.vectorImage || pic.vectorImage
  if (vectorImage?.rootUrl && vectorImage?.artifacts?.length) {
    const artifact = pickArtifact(vectorImage.artifacts, 100)
    if (artifact?.fileIdentifyingUrlPathSegment) return `${vectorImage.rootUrl}${artifact.fileIdentifyingUrlPathSegment}`
  }
  return null
}

function profileFromParticipant(entity: VoyagerEntity): NormalizedLinkedinProfile | null {
  const member = entity.participantType?.member
  if (!member) return null
  const profileId = extractProfileId(entity.hostIdentityUrn || entity.entityUrn)
  const publicId = publicIdFromMember(member, profileId)
  const first = member.firstName?.text || ''
  const last = member.lastName?.text || ''
  const fullName = `${first} ${last}`.trim() || 'Unknown'
  return {
    urn: `urn:li:fsd_profile:${profileId}`,
    public_id: publicId,
    first_name: first || null,
    last_name: last || null,
    full_name: fullName,
    occupation: member.headline?.text || null,
    location: member.location?.text || member.geoLocation?.text || null,
    picture_url: participantPicture(entity),
    linkedin_url: publicId ? `https://www.linkedin.com/in/${publicId}` : null,
  }
}

function extractConversationId(urn: string | undefined): string {
  if (!urn) return ''
  const match = urn.match(/msg_conversation:\([^,]+,(.+)\)$/)
  return match?.[1] || urn
}

function pickInboxCategory(categories?: string[]): string {
  if (!categories) return 'PRIMARY_INBOX'
  if (categories.includes('ARCHIVE')) return 'ARCHIVE'
  if (categories.includes('SPAM')) return 'SPAM'
  if (categories.includes('SECONDARY_INBOX')) return 'SECONDARY_INBOX'
  if (categories.includes('PRIMARY_INBOX')) return 'PRIMARY_INBOX'
  if (categories.includes('INMAIL') || categories.includes('OTHER')) return 'SECONDARY_INBOX'
  return 'PRIMARY_INBOX'
}

function messageFallback(message: VoyagerEntity | undefined): string | null {
  const item = Array.isArray(message?.renderContent) ? message?.renderContent[0] : null
  if (!item) return null
  if (item.vectorImage) return 'Sent an image'
  if (item.file) return `Sent a file: ${item.file.name || item.file.fileName || 'File'}`
  if (item.video) return 'Sent a video'
  if (item.audio) return 'Sent a voice message'
  if (item.hostUrnData) return 'Shared a post'
  if (item.externalMedia) return item.externalMedia.title || 'Shared a link'
  if (item.repliedMessageContent) return message?.body?.text || 'Replied to a message'
  return null
}

export function normalizeConversations(raw: VoyagerResponse, myMemberUrn: string): {
  conversations: NormalizedLinkedinConversation[]
  profiles: NormalizedLinkedinProfile[]
} {
  const participantMap = new Map<string, VoyagerEntity>()
  const messageMap = new Map<string, VoyagerEntity>()
  const profiles: NormalizedLinkedinProfile[] = []

  for (const entity of raw.included || []) {
    if (entity.$type === 'com.linkedin.messenger.MessagingParticipant') {
      participantMap.set(entity.entityUrn, entity)
      const profile = profileFromParticipant(entity)
      if (profile) profiles.push(profile)
    } else if (entity.$type === 'com.linkedin.messenger.Message') {
      const convUrn = entity['*conversation']
      const existing = convUrn ? messageMap.get(convUrn) : null
      if (convUrn && (!existing || (entity.deliveredAt || 0) > (existing.deliveredAt || 0))) {
        messageMap.set(convUrn, entity)
      }
    }
  }

  const conversations = (raw.included || [])
    .filter((entity) => entity.$type === 'com.linkedin.messenger.Conversation')
    .map((conv) => {
      const participantUrns: string[] = []
      const participantNames: string[] = []
      const participantPictures: string[] = []
      for (const ref of conv['*conversationParticipants'] || []) {
        const participant = participantMap.get(ref)
        const profile = participant ? profileFromParticipant(participant) : null
        if (!profile || profile.urn === myMemberUrn) continue
        participantUrns.push(profile.urn)
        participantNames.push(profile.full_name)
        participantPictures.push(profile.picture_url ?? '')
      }
      const latest = messageMap.get(conv.entityUrn)
      return {
        id: extractConversationId(conv.entityUrn),
        participant_urns: participantUrns,
        participant_names: participantNames,
        participant_pictures: participantPictures,
        last_message: latest?.body?.text || messageFallback(latest),
        last_activity_at: conv.lastActivityAt || 0,
        read: (conv.unreadCount || 0) === 0 ? 1 : 0,
        archived: conv.categories?.includes('ARCHIVE') ? 1 : 0,
        category: pickInboxCategory(conv.categories),
        starred: conv.categories?.includes('STARRED') ? 1 : 0,
      }
    })
    .filter((conv) => conv.id)

  return { conversations, profiles }
}

export function normalizeMessages(raw: VoyagerResponse, conversationId: string, myMemberUrn: string): NormalizedLinkedinMessage[] {
  const participantMap = new Map<string, VoyagerEntity>()
  for (const entity of raw.included || []) {
    if (entity.$type === 'com.linkedin.messenger.MessagingParticipant') {
      participantMap.set(entity.entityUrn, entity)
    }
  }
  return (raw.included || [])
    .filter((entity) => entity.$type === 'com.linkedin.messenger.Message')
    .map((entity) => {
      const senderRef = entity['*sender'] || entity['*actor'] || ''
      const sender = participantMap.get(senderRef)
      const profile = sender ? profileFromParticipant(sender) : null
      const senderUrn = profile?.urn ?? (senderRef ? `urn:li:fsd_profile:${extractProfileId(senderRef)}` : null)
      return {
        id: entity.entityUrn,
        conversation_id: conversationId,
        sender_urn: senderUrn,
        sender_name: profile?.full_name ?? null,
        sender_picture: profile?.picture_url ?? null,
        body: entity.body?.text || messageFallback(entity),
        created_at_ms: entity.deliveredAt || 0,
        is_from_me: senderUrn === myMemberUrn ? 1 : 0,
        attachments_json: Array.isArray(entity.renderContent) && entity.renderContent.length
          ? JSON.stringify(entity.renderContent)
          : null,
      }
    })
    .filter((message) => message.id && message.created_at_ms)
    .sort((a, b) => a.created_at_ms - b.created_at_ms)
}

