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
