// Preload script for the WhatsApp Web WebContentsView.
//
// Phase 2 — Active chat detection.
//
// WhatsApp Web does NOT change the URL when you switch chats (it's an SPA),
// so URL-based detection doesn't work. Instead we poll the DOM for messages
// carrying a [data-id] attribute. data-id format:
//   "true_PHONE@c.us_MSGID"   (outbound)
//   "false_PHONE@c.us_MSGID"  (inbound)
//
// `[data-id*="@c.us"]` is the most stable selector across WhatsApp Web
// releases — it's how WA tracks message IDs internally and has survived
// every visual rewrite for years (unlike #pane-side which was removed).
//
// We poll every 600ms, compare to the last known phone, and emit
// `wa:chat:changed { phone, name }` to the main process whenever it
// changes. Main forwards it to the sidebar as `chat:changed`.

import { ipcRenderer } from 'electron'

const POLL_INTERVAL_MS = 600

let currentPhone: string | null = null
let started = false

function getPhoneFromDom(): string | null {
  const messages = document.querySelectorAll('[data-id*="@c.us"]')
  for (const msg of Array.from(messages)) {
    const dataId = msg.getAttribute('data-id')
    if (!dataId) continue
    // Format: "true_18573900458@c.us_..." or "false_18573900458@c.us_..."
    const match = dataId.match(/(?:true|false)_(.+?)@c\.us/)
    if (match && match[1]) return match[1]
  }
  return null
}

function getChatNameFromDom(): string | null {
  // Try a few selectors. The first stable one wins. WhatsApp obfuscates
  // class names but the conversation header structure has been roughly
  // consistent: a header with a span carrying the contact name.
  const candidates: Array<() => string | null> = [
    () => {
      const el = document.querySelector('header [title]') as HTMLElement | null
      return el?.getAttribute('title')?.trim() ?? null
    },
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
      // ignore
    }
  }
  return null
}

function tick(): void {
  let phone: string | null = null
  try {
    phone = getPhoneFromDom()
  } catch (err) {
    console.error('[wa-preload] getPhoneFromDom error:', err)
  }

  if (phone !== currentPhone) {
    currentPhone = phone
    if (phone) {
      const name = getChatNameFromDom()
      const normalized = phone.startsWith('+') ? phone : '+' + phone
      console.log('[wa-preload] chat changed →', normalized, name)
      ipcRenderer.send('wa:chat:changed', { phone: normalized, name })
    } else {
      console.log('[wa-preload] no active chat')
      ipcRenderer.send('wa:chat:changed', { phone: null, name: null })
    }
  }
}

function start(): void {
  if (started) return
  started = true
  console.log('[wa-preload] active chat detector started')
  setInterval(tick, POLL_INTERVAL_MS)
  // Run once immediately so we don't wait 600ms on load
  setTimeout(tick, 100)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}
