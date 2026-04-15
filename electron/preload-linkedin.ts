// Preload script for the LinkedIn WebContentsView.
//
// LinkedIn is a SPA — URL changes via pushState. We poll location.href and
// when we land on a /in/<slug>/ profile page, we scrape name, job title and
// best-effort avatar, then emit IPC so the sidebar can look it up in reThink.

import { ipcRenderer } from 'electron'

const POLL_INTERVAL_MS = 500

type LinkedinProfile = {
  url: string
  slug: string
  name: string | null
  jobTitle: string | null
  avatarDataUrl: string | null
}

let currentKey: string | null = null
let started = false

function normalizeProfileUrl(raw: string): { url: string; slug: string } | null {
  const match = raw.match(/linkedin\.com\/in\/([^/?#&]+)/)
  if (!match) return null
  const slug = match[1]
  return { url: `https://www.linkedin.com/in/${slug}`, slug }
}

function scrapeName(): string | null {
  const nameSelectors = [
    'h1.text-heading-xlarge',
    'h1[class*="text-heading"]',
    'h1.t-24',
    'h1.t-bold',
    '.pv-top-card h1',
    '.ph5 h1',
    'main h1',
    'h1',
  ]
  for (const sel of nameSelectors) {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) continue
    const text = el.innerText?.trim()
    if (!text || text.length < 2 || text.length > 80) continue
    if (text.includes('|') || text.includes('·')) continue
    return text
  }
  return null
}

function scrapeJobTitle(): string | null {
  const el = document.querySelector('.text-body-medium.break-words') as HTMLElement | null
  const text = el?.innerText?.trim() ?? null
  if (!text || text.length > 200) return null
  return text
}

function scrapeAvatar(): string | null {
  // Top card profile photo. Selectors vary; try a few.
  const candidates = [
    'img.pv-top-card-profile-picture__image',
    'img.profile-photo-edit__preview',
    'img[class*="profile-picture"]',
    'section img[alt]',
  ]
  for (const sel of candidates) {
    const img = document.querySelector(sel) as HTMLImageElement | null
    if (!img || !img.complete || img.naturalWidth < 32) continue
    try {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.drawImage(img, 0, 0)
      return canvas.toDataURL('image/jpeg', 0.75)
    } catch {
      // Tainted canvas; give up on this one
      continue
    }
  }
  return null
}

function tick(): void {
  const href = window.location.href
  const parsed = normalizeProfileUrl(href)
  if (!parsed) {
    if (currentKey !== 'none') {
      currentKey = 'none'
      console.log('[li-preload] not on a profile')
      ipcRenderer.send('li:profile:changed', { kind: 'none' })
    }
    return
  }

  const key = 'profile:' + parsed.slug
  if (key === currentKey) return

  // LinkedIn's SPA takes a moment to render the new profile after URL change.
  // Name/title may be stale for a frame. Do a short second pass.
  setTimeout(() => {
    const name = scrapeName()
    const jobTitle = scrapeJobTitle()
    const avatarDataUrl = scrapeAvatar()
    if (!name) return // wait for next tick if DOM not ready yet
    currentKey = key
    const profile: LinkedinProfile = {
      url: parsed.url,
      slug: parsed.slug,
      name,
      jobTitle,
      avatarDataUrl,
    }
    console.log('[li-preload] profile →', profile.url, profile.name)
    ipcRenderer.send('li:profile:changed', { kind: 'profile', ...profile })
  }, 200)
}

function start(): void {
  if (started) return
  started = true
  console.log('[li-preload] profile detector started')
  setInterval(tick, POLL_INTERVAL_MS)
  setTimeout(tick, 300)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}
