import { getLinkedinMemberUrn, linkedinVoyagerFetch } from './client'
import { linkedInVariables } from './encode'
import type { VoyagerResponse } from './types'

export type InboxCategory = 'PRIMARY_INBOX' | 'SECONDARY_INBOX' | 'ARCHIVE' | 'SPAM'
const MESSAGE_PAGE_SIZE = 20

const inflightMessageBackfills = new Map<string, Promise<VoyagerResponse[]>>()

export async function fetchConversationsPage(
  category: InboxCategory = 'PRIMARY_INBOX',
  cursor: string | null = null,
): Promise<{ response: VoyagerResponse; nextCursor: string | null }> {
  const memberUrn = await getLinkedinMemberUrn()
  const encodedUrn = encodeURIComponent(memberUrn)
  const variables = cursor
    ? `(query:(predicateUnions:List((conversationCategoryPredicate:(category:${category})))),count:20,mailboxUrn:${encodedUrn},nextCursor:${encodeURIComponent(cursor)})`
    : `(query:(predicateUnions:List((conversationCategoryPredicate:(category:${category})))),count:20,mailboxUrn:${encodedUrn})`
  const res = await linkedinVoyagerFetch(
    `/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.9501074288a12f3ae9e3c7ea243bccbf&variables=${variables}`,
  )
  if (!res.ok) throw new Error(`LinkedIn conversations fetch failed: ${res.status}`)
  const data = await res.json()
  const nextCursor = data?.data?.data?.messengerConversationsByCategoryQuery?.metadata?.nextCursor || null
  return { response: data, nextCursor }
}

export async function fetchMessages(
  conversationId: string,
  count = MESSAGE_PAGE_SIZE,
  start = 0,
): Promise<VoyagerResponse> {
  const memberUrn = await getLinkedinMemberUrn()
  const conversationUrn = `urn:li:msg_conversation:(${memberUrn},${conversationId})`
  const variables = linkedInVariables({ conversationUrn, count, start })
  const res = await linkedinVoyagerFetch(
    `/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.5846eeb71c981f11e0134cb6626cc314&variables=${variables}`,
  )
  if (!res.ok) throw new Error(`LinkedIn messages fetch failed: ${res.status}`)
  return res.json()
}

export async function fetchAllMessages(
  conversationId: string,
  maxPages = 10,
): Promise<VoyagerResponse[]> {
  const existing = inflightMessageBackfills.get(conversationId)
  if (existing) return existing

  const promise = (async () => {
    const pages: VoyagerResponse[] = []
    for (let page = 0; page < maxPages; page++) {
      const raw = await fetchMessages(conversationId, MESSAGE_PAGE_SIZE, page * MESSAGE_PAGE_SIZE)
      pages.push(raw)
      const messageCount = (raw.included || []).filter(
        (entity: any) => entity.$type === 'com.linkedin.messenger.Message',
      ).length
      // LinkedIn can return short pages even when older pages exist, so only
      // stop when the page has no messages. This mirrors inflow's backfill.
      if (messageCount === 0) break
    }
    return pages
  })()

  inflightMessageBackfills.set(conversationId, promise)
  const cleanup = () => inflightMessageBackfills.delete(conversationId)
  promise.then(cleanup, cleanup)
  return promise
}
