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
  phone: string
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

function lastSenderPhone(dataId: string): string | null {
  // For group messages, the sender phone is the last segment ending in @c.us.
  const parts = dataId.split('_')
  const last = parts[parts.length - 1]
  if (!last || !last.endsWith('@c.us')) return null
  const phone = last.slice(0, -'@c.us'.length)
  return /^\d+$/.test(phone) ? phone : null
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

function captureAvatarFor(phone: string): string | null {
  if (avatarCache.has(phone)) return avatarCache.get(phone)!
  const messages = Array.from(
    document.querySelectorAll(`[data-id$="_${phone}@c.us"]`),
  )
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
          avatarCache.set(phone, url)
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
    const phone = lastSenderPhone(dataId)
    if (!phone) continue
    if (seen.has(phone)) continue
    const waName = extractWaNameFromMessageEl(msg)
    const avatarDataUrl = captureAvatarFor(phone)
    seen.set(phone, { phone: '+' + phone, waName, avatarDataUrl })
  }
  return Array.from(seen.values())
}

// ─────────────────────────────────────────────────────────────────────
// Emitter

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
    const phones = participants.map((p) => p.phone).sort().join(',')
    signature = 'group:' + identity.groupId + '|' + phones
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}
