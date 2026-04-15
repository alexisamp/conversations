// Preload script for the WhatsApp Web WebContentsView.
//
// Phase 2 + 2.5 — Active chat detection (person OR group).
//
// WhatsApp data-id format:
//   1-on-1:     "true_15551234567@c.us_MSGID"          (outbound)
//               "false_15551234567@c.us_MSGID"         (inbound)
//   group in:   "false_GROUPID@g.us_MSGID_5215551234567@c.us"
//   group out:  "true_GROUPID@g.us_MSGID"
//
// We split by "_" so the FIRST segment carrying "@c.us" or "@g.us" is the
// chat ID; for groups, the LAST segment ending in "@c.us" is the sender.

import { ipcRenderer } from 'electron'

const POLL_INTERVAL_MS = 600

type Participant = {
  // Exactly one of phone or lid is populated:
  //   - phone: sender identified by @c.us (real phone number, +E164 format)
  //   - lid:   sender identified by @lid  (opaque WhatsApp Linked ID; can't be
  //            looked up by phone, needs name-based fallback in the backend)
  phone: string | null
  lid: string | null
  waName: string | null
  avatarDataUrl: string | null
}

type ChatIdentity =
  | { kind: 'none' }
  | { kind: 'person'; phone: string }
  | { kind: 'group'; groupId: string }

let currentSignature: string | null = null
// phone → avatarDataUrl cache so we don't re-capture every tick
const avatarCache = new Map<string, string>()
// Dedupe captured messages by WhatsApp's own data-id (idempotent per session)
const processedMessages = new Set<string>()
// Track when the current chat became active so we can skip the historical
// render pass. Anything added within 5s of a chat switch is treated as DOM
// rehydration, not a new inbound/outbound message.
let currentChatActivatedAt = 0
let messageObserver: MutationObserver | null = null

// ─────────────────────────────────────────────────────────────────────
// DOM probes

function firstChatSegment(dataId: string): string | null {
  // Matches the first ID segment ending in @c.us or @g.us after true_/false_
  // Example: "false_120363012345678901@g.us_3AABCD_5215551234567@c.us"
  // → "120363012345678901@g.us"
  const prefix = dataId.startsWith('true_')
    ? dataId.slice(5)
    : dataId.startsWith('false_')
      ? dataId.slice(6)
      : null
  if (!prefix) return null
  // First segment is up to the next "_"
  const underscore = prefix.indexOf('_')
  const firstSeg = underscore >= 0 ? prefix.slice(0, underscore) : prefix
  if (firstSeg.endsWith('@c.us') || firstSeg.endsWith('@g.us')) return firstSeg
  return null
}

function lastSenderIdentity(
  dataId: string,
): { phone: string } | { lid: string } | null {
  // Group message data-ids carry the sender as a trailing segment. Two
  // formats coexist in modern WhatsApp:
  //   - "…_18573900458@c.us" — real phone number (legacy)
  //   - "…_244482926760154@lid" — Linked ID (newer, opaque)
  // Take the LAST matching segment (the group ID is earlier in the string).
  const matches = Array.from(dataId.matchAll(/(\d+)@(c\.us|lid)/g))
  if (matches.length === 0) return null
  const last = matches[matches.length - 1]
  const value = last[1]
  const suffix = last[2]
  return suffix === 'c.us' ? { phone: value } : { lid: value }
}

function getActiveChatIdentity(): ChatIdentity {
  const messages = document.querySelectorAll('[data-id]')
  for (const msg of Array.from(messages)) {
    const dataId = msg.getAttribute('data-id')
    if (!dataId) continue
    const chatId = firstChatSegment(dataId)
    if (!chatId) continue
    if (chatId.endsWith('@g.us')) return { kind: 'group', groupId: chatId }
    return { kind: 'person', phone: chatId.slice(0, -'@c.us'.length) }
  }
  return { kind: 'none' }
}

function getChatNameFromDom(): string | null {
  const candidates: Array<() => string | null> = [
    () => (document.querySelector('header [title]') as HTMLElement | null)?.getAttribute('title')?.trim() ?? null,
    () => {
      const el = document.querySelector('header span[dir="auto"]') as HTMLElement | null
      const text = el?.innerText?.trim()
      return text && text.length >= 2 && text.length < 100 ? text : null
    },
    () => {
      const el = document.querySelector('header h1') as HTMLElement | null
      const text = el?.innerText?.trim()
      return text && text.length >= 2 && text.length < 100 ? text : null
    },
  ]
  for (const fn of candidates) {
    try {
      const name = fn()
      if (name) return name.split('\n')[0]?.trim() ?? null
    } catch {
      /* ignore */
    }
  }
  return null
}

function extractWaNameFromMessageEl(msg: Element): string | null {
  // data-pre-plain-text format: "[HH:MM, DD/MM/YYYY] Sender Name: "
  const el = msg.querySelector('[data-pre-plain-text]') as HTMLElement | null
  const pre = el?.getAttribute('data-pre-plain-text') ?? ''
  const match = pre.match(/\]\s*([^:]+):/)
  return match ? match[1].trim() : null
}

function captureAvatarFor(identifier: string): string | null {
  if (avatarCache.has(identifier)) return avatarCache.get(identifier)!
  // Look for messages whose data-id ends with this participant's @c.us or @lid suffix.
  const selector = `[data-id$="_${identifier}@c.us"], [data-id$="_${identifier}@lid"]`
  const messages = Array.from(document.querySelectorAll(selector))
  for (const msg of messages) {
    // The avatar is usually an <img> inside or beside the message row.
    // Walk outward a couple of levels and look for a blob:-src image.
    let node: Element | null = msg
    for (let i = 0; i < 4 && node; i++) {
      const img = node.querySelector('img[src^="blob:"]') as HTMLImageElement | null
      if (img && img.complete && img.naturalWidth > 0) {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          const ctx = canvas.getContext('2d')
          if (!ctx) break
          ctx.drawImage(img, 0, 0)
          const url = canvas.toDataURL('image/jpeg', 0.7)
          avatarCache.set(identifier, url)
          return url
        } catch {
          // Tainted canvas (CORS). Give up for this participant.
          return null
        }
      }
      node = node.parentElement
    }
  }
  return null
}

function getGroupParticipants(): Participant[] {
  const messages = document.querySelectorAll('[data-id]')
  const seen = new Map<string, Participant>()
  for (const msg of Array.from(messages)) {
    const dataId = msg.getAttribute('data-id') ?? ''
    // Only take messages FROM others (false_...), not ones we sent
    // (true_...); our own outgoing messages in groups shouldn't make us
    // appear as a participant of that group in the sidebar.
    if (!dataId.startsWith('false_')) continue
    const identity = lastSenderIdentity(dataId)
    if (!identity) continue

    // Dedupe key: use the phone/lid string itself so duplicates collapse.
    const key = 'phone' in identity ? 'phone:' + identity.phone : 'lid:' + identity.lid
    if (seen.has(key)) continue

    const waName = extractWaNameFromMessageEl(msg)
    const rawId = 'phone' in identity ? identity.phone : identity.lid
    const avatarDataUrl = captureAvatarFor(rawId)
    seen.set(key, {
      phone: 'phone' in identity ? '+' + identity.phone : null,
      lid: 'lid' in identity ? identity.lid : null,
      waName,
      avatarDataUrl,
    })
  }
  return Array.from(seen.values())
}

// ─────────────────────────────────────────────────────────────────────
// Emitter

let diagnosticLoggedForGroup: string | null = null

// ─────────────────────────────────────────────────────────────────────
// Per-message capture

type CapturedMessage = {
  wa_data_id: string
  chat_phone: string
  chat_kind: 'person' | 'group'
  direction: 'inbound' | 'outbound'
  sender_phone: string | null
  sender_lid: string | null
  sender_name: string | null
  text: string | null
  timestamp_ms: number
}

function parseTimestampFromPre(pre: string | null): number | null {
  // Format: "[HH:MM, DD/MM/YYYY] Sender Name: "
  if (!pre) return null
  const m = pre.match(/\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\]/)
  if (!m) return null
  const [, hh, mm, dd, mo, yy] = m
  const d = new Date(Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mm))
  return isNaN(d.getTime()) ? null : d.getTime()
}

function extractTextFromMessageEl(msg: Element): string | null {
  // Preferred: the copyable-text span that WA uses for plain text bubbles.
  const copyable = msg.querySelector<HTMLElement>(
    'span.selectable-text.copyable-text, span.copyable-text, div.copyable-text span, span.selectable-text',
  )
  if (copyable) {
    const t = copyable.innerText?.trim()
    if (t) return t
  }
  // Last resort: innerText of the message minus any trailing "HH:MM" timestamp.
  const raw = (msg as HTMLElement).innerText?.trim() ?? ''
  if (!raw) return null
  return raw.replace(/\s*\d{1,2}:\d{2}\s*$/, '').trim() || null
}

function buildCapturedMessage(msg: Element): CapturedMessage | null {
  const dataId = msg.getAttribute('data-id')
  if (!dataId || !dataId.includes('@')) return null

  const identity = getActiveChatIdentity()
  if (identity.kind === 'none') return null

  // Direction: message-out marker in class name indicates outbound.
  const isOutbound = msg.classList.contains('message-out') ||
    msg.querySelector('.message-out') !== null ||
    dataId.startsWith('true_')

  // Chat identifier in our own normalized form.
  const chatPhone =
    identity.kind === 'person'
      ? '+' + identity.phone
      : identity.groupId // groups use the raw groupid@g.us
  const chatKind: 'person' | 'group' = identity.kind

  // For group messages, extract the sender (phone or LID) from the data-id.
  let senderPhone: string | null = null
  let senderLid: string | null = null
  if (identity.kind === 'group' && !isOutbound) {
    const sender = lastSenderIdentity(dataId)
    if (sender) {
      if ('phone' in sender) senderPhone = '+' + sender.phone
      else senderLid = sender.lid
    }
  }

  // Sender name + timestamp from data-pre-plain-text.
  const preEl = msg.querySelector<HTMLElement>('[data-pre-plain-text]')
  const pre = preEl?.getAttribute('data-pre-plain-text') ?? null
  const nameMatch = pre?.match(/\]\s*([^:]+):/)
  const senderName = nameMatch ? nameMatch[1].trim() : null
  const timestampMs = parseTimestampFromPre(pre) ?? Date.now()

  const text = extractTextFromMessageEl(msg)

  return {
    wa_data_id: dataId,
    chat_phone: chatPhone,
    chat_kind: chatKind,
    direction: isOutbound ? 'outbound' : 'inbound',
    sender_phone: senderPhone,
    sender_lid: senderLid,
    sender_name: senderName,
    text,
    timestamp_ms: timestampMs,
  }
}

function handleNewMessageNode(node: Element): void {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return

  // Direct match: the node itself carries a message data-id with @c.us or @lid
  const isDirect =
    node.hasAttribute('data-id') &&
    (node.getAttribute('data-id')?.includes('@c.us') ||
      node.getAttribute('data-id')?.includes('@lid'))

  const candidates: Element[] = []
  if (isDirect) candidates.push(node)
  // Nested: the added node is a container holding one or more message rows.
  candidates.push(
    ...Array.from(node.querySelectorAll('[data-id*="@c.us"], [data-id*="@lid"]')),
  )

  for (const el of candidates) {
    const dataId = el.getAttribute('data-id')
    if (!dataId) continue

    // Dedupe
    if (processedMessages.has(dataId)) continue
    processedMessages.add(dataId)

    // Skip historical-render pass: anything added within 5s of the chat
    // becoming active is WA's own DOM rehydration, not a live message.
    if (Date.now() - currentChatActivatedAt < 5000) continue

    const captured = buildCapturedMessage(el)
    if (!captured) continue

    // Scope cut (phase 3b): skip group messages entirely. The session
    // capture pipeline is 1:1 only for now; groups are visual-only and
    // don't generate interactions or health score changes.
    if (captured.chat_kind === 'group') continue

    console.log(
      '[wa-preload] msg',
      captured.direction,
      captured.chat_phone,
      captured.text ? captured.text.slice(0, 40) : '(no text)',
    )
    ipcRenderer.send('wa:message', captured)
  }
}

function attachMessageObserver(): void {
  if (messageObserver) return
  const observe = (panel: Element): void => {
    messageObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            handleNewMessageNode(node as Element)
          }
        })
      }
    })
    messageObserver.observe(panel, { childList: true, subtree: true })
    console.log('[wa-preload] message observer attached')
  }
  const tryAttach = (): void => {
    const panel =
      document.querySelector('[data-testid="conversation-panel-messages"]') ??
      document.querySelector('div.copyable-area') ??
      document.querySelector('#main') ??
      document.body
    if (panel) observe(panel)
    else setTimeout(tryAttach, 500)
  }
  tryAttach()
}

function tick(): void {
  let identity: ChatIdentity = { kind: 'none' }
  try {
    identity = getActiveChatIdentity()
  } catch (err) {
    console.error('[wa-preload] identity probe error:', err)
  }

  // Build a stable signature so we only emit when something changed.
  let signature = 'none'
  if (identity.kind === 'person') {
    signature = 'person:' + identity.phone
  } else if (identity.kind === 'group') {
    const participants = getGroupParticipants()

    // One-shot diagnostic: if we landed in a group but couldn't pull any
    // participants, dump a few raw data-ids so we can see what WA changed.
    if (participants.length === 0 && diagnosticLoggedForGroup !== identity.groupId) {
      diagnosticLoggedForGroup = identity.groupId
      const samples = Array.from(document.querySelectorAll('[data-id]'))
        .slice(0, 8)
        .map((el) => el.getAttribute('data-id'))
      console.warn('[wa-preload] group but 0 participants. samples:', samples)
    }

    const keys = participants
      .map((p) => (p.phone ?? '') + '|' + (p.lid ?? ''))
      .sort()
      .join(',')
    signature = 'group:' + identity.groupId + '|' + keys
    if (signature !== currentSignature) {
      currentSignature = signature
      const name = getChatNameFromDom()
      console.log(
        '[wa-preload] group changed →',
        identity.groupId,
        name,
        `(${participants.length} participants)`,
      )
      ipcRenderer.send('wa:chat:changed', {
        kind: 'group',
        groupId: identity.groupId,
        name,
        participants,
      })
    }
    return
  }

  if (signature === currentSignature) return
  currentSignature = signature
  // New chat context → reset the "skip history" window so the next 5s of
  // DOM mutations are treated as rehydration, not new messages.
  currentChatActivatedAt = Date.now()

  if (identity.kind === 'none') {
    console.log('[wa-preload] no active chat')
    ipcRenderer.send('wa:chat:changed', { kind: 'none' })
    return
  }

  // Person
  const name = getChatNameFromDom()
  const normalized = identity.phone.startsWith('+') ? identity.phone : '+' + identity.phone
  console.log('[wa-preload] person chat changed →', normalized, name)
  ipcRenderer.send('wa:chat:changed', { kind: 'person', phone: normalized, name })
}

function start(): void {
  console.log('[wa-preload] active chat detector started')
  setInterval(tick, POLL_INTERVAL_MS)
  setTimeout(tick, 100)
  attachMessageObserver()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}
