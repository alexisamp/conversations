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
  // LinkedIn's class names are obfuscated and shift frequently. Try a stack
  // of selectors in descending order of reliability, then fall back to a
  // structural walk from the h1.
  const selectors = [
    '[data-generated-suggestion-target]',
    '.pv-text-details__right-panel .text-body-medium',
    '.pv-top-card-v2-ctas + .text-body-medium',
    '.ph5 .text-body-medium.break-words',
    'main section .text-body-medium.break-words',
    '.text-body-medium.break-words',
    'main .pv-top-card .text-body-medium',
    'main .text-body-medium',
  ]
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) continue
    const text = el.innerText?.trim()
    if (!text || text.length < 2 || text.length > 200) continue
    // Skip obvious false positives (multi-line, weird patterns)
    if (text.includes('\n')) continue
    return text
  }

  // Structural fallback: walk up from the h1 that holds the name and look
  // for the first text element right below it that isn't the name itself
  // and isn't a nested button/link container.
  const h1 = document.querySelector('main h1') as HTMLElement | null
  if (h1) {
    const name = h1.innerText?.trim() ?? ''
    let container: HTMLElement | null = h1.parentElement
    for (let depth = 0; depth < 4 && container; depth++) {
      const candidates = container.querySelectorAll<HTMLElement>('div, span, p')
      for (const el of Array.from(candidates)) {
        const text = el.innerText?.trim() ?? ''
        if (!text || text === name) continue
        if (text.length < 5 || text.length > 200) continue
        if (text.includes('\n')) continue
        if (el.querySelector('button, a, h1')) continue
        if (el.children.length > 2) continue
        return text
      }
      container = container.parentElement
    }
  }

  return null
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
      console.log('[li-preload] not on a profile (url=' + href + ')')
      ipcRenderer.send('li:profile:changed', { kind: 'none' })
    }
    return
  }

  const key = 'profile:' + parsed.slug
  if (key === currentKey) return
  currentKey = key

  // Emit immediately so the backend slug-based lookup can fire even before
  // LinkedIn finishes rendering name/title. If the scrape succeeds later
  // (retries below), we re-emit with the enriched info.
  const emit = (source: string) => {
    const name = scrapeName()
    const jobTitle = scrapeJobTitle()
    const avatarDataUrl = scrapeAvatar()
    const profile: LinkedinProfile = {
      url: parsed.url,
      slug: parsed.slug,
      name,
      jobTitle,
      avatarDataUrl,
    }
    console.log(
      `[li-preload] profile(${source}) → ${profile.url} name=${name ?? 'null'} title=${jobTitle ?? 'null'}`,
    )
    ipcRenderer.send('li:profile:changed', { kind: 'profile', ...profile })
  }

  // First shot — sometimes the DOM is already ready, especially after a
  // client-side route change.
  emit('fast')

  // Retry passes in case name/title weren't mounted yet. Stops early if the
  // user navigated away to another profile (currentKey changed).
  const retryDelays = [300, 800, 1800]
  retryDelays.forEach((delay) => {
    setTimeout(() => {
      if (currentKey !== key) return
      const name = scrapeName()
      if (name) emit(`retry-${delay}ms`)
    }, delay)
  })
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
