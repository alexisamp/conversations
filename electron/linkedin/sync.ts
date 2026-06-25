import {
  linkedinConversation,
  linkedinMessagesForConversation,
  listLinkedinConversations,
  setLinkedinSyncState,
  upsertLinkedinConversations,
  upsertLinkedinMessages,
  upsertLinkedinProfiles,
  type LinkedinConversationRow,
  type LinkedinMessageRow,
} from '../db/local'
import { getLinkedinMemberUrn } from './client'
import { fetchAllMessages, fetchConversationsPage, type InboxCategory } from './api'
import { normalizeConversations, normalizeMessages } from './normalizer'

const CATEGORIES: InboxCategory[] = ['PRIMARY_INBOX', 'SECONDARY_INBOX', 'ARCHIVE', 'SPAM']

export type LinkedinInboxSummary = {
  authenticated: boolean
  conversations: LinkedinConversationRow[]
  error?: string
}

export async function syncLinkedinInbox(maxPagesPerCategory = 1): Promise<{ conversations: number; messages: number }> {
  const memberUrn = await getLinkedinMemberUrn()
  let conversationsChanged = 0
  let messagesChanged = 0
  for (const category of CATEGORIES) {
    let cursor: string | null = null
    for (let page = 0; page < maxPagesPerCategory; page++) {
      const result = await fetchConversationsPage(category, cursor)
      const normalized = normalizeConversations(result.response, memberUrn)
      conversationsChanged += upsertLinkedinConversations(normalized.conversations)
      upsertLinkedinProfiles(normalized.profiles)
      for (const conv of normalized.conversations.slice(0, 8)) {
        messagesChanged += await syncLinkedinConversation(conv.id, 1)
      }
      cursor = result.nextCursor
      if (!cursor) break
    }
  }
  setLinkedinSyncState('last_inbox_sync_at', String(Date.now()))
  return { conversations: conversationsChanged, messages: messagesChanged }
}

export async function syncLinkedinConversation(conversationId: string, maxPages = 3): Promise<number> {
  const memberUrn = await getLinkedinMemberUrn()
  let changed = 0
  const pages = await fetchAllMessages(conversationId, maxPages)
  for (const raw of pages) {
    const messages = normalizeMessages(raw, conversationId, memberUrn)
    changed += upsertLinkedinMessages(messages)
  }
  return changed
}

export async function linkedinInbox(): Promise<LinkedinInboxSummary> {
  return {
    authenticated: true,
    conversations: listLinkedinConversations(120),
  }
}

export function linkedinThread(conversationId: string): {
  conversation: LinkedinConversationRow | null
  messages: LinkedinMessageRow[]
} {
  return {
    conversation: linkedinConversation(conversationId),
    messages: linkedinMessagesForConversation(conversationId, 300),
  }
}
