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
  location: string | null
  about: string | null
  photoUrl: string | null
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

function scrapeLocation(): string | null {
  // Location sits under the headline in the top card. It's usually in a
  // smaller gray text block with the pattern "City, Region, Country".
  const selectors = [
    '.pv-text-details__left-panel .text-body-small:not(.inline)',
    '.ph5 .text-body-small.inline.t-black--light.break-words',
    '.pv-text-details__left-panel span.text-body-small',
    '.pv-top-card .text-body-small.inline',
  ]
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) continue
    const text = el.innerText?.trim()
    if (!text || text.length < 3 || text.length > 150) continue
    // A location usually contains a comma and no pipe/bullet
    if (!text.includes(',')) continue
    if (text.includes('|') || text.includes('·')) continue
    return text
  }
  // Structural fallback: small-text block near h1 that has a comma and ends
  // near a "Contact info" link.
  const contactInfo = Array.from(document.querySelectorAll('a, button')).find(
    (el) => ((el as HTMLElement).innerText?.trim().toLowerCase() ?? '') === 'contact info',
  )
  if (contactInfo) {
    const container = contactInfo.parentElement
    if (container) {
      const siblings = container.querySelectorAll<HTMLElement>('span')
      for (const s of Array.from(siblings)) {
        const text = s.innerText?.trim() ?? ''
        if (text.length > 5 && text.length < 150 && text.includes(',')) return text
      }
    }
  }
  return null
}

function scrapeAbout(): string | null {
  // Find the "About" section by walking from its heading.
  const headings = Array.from(
    document.querySelectorAll<HTMLElement>('section h2, section div[id="about"]'),
  )
  for (const heading of headings) {
    const text = heading.innerText?.trim().toLowerCase() ?? ''
    if (text !== 'about' && text !== 'acerca de') continue
    const section = heading.closest('section')
    if (!section) continue
    // The content is usually in a descendant with "inline-show-more-text"
    // class or similar; fall back to the section's visible text minus the
    // heading itself.
    const contentEl =
      section.querySelector<HTMLElement>('.inline-show-more-text') ??
      section.querySelector<HTMLElement>('[class*="inline-show-more"]') ??
      section.querySelector<HTMLElement>('div.display-flex > span[aria-hidden="true"]')
    if (contentEl) {
      const aboutText = contentEl.innerText?.trim()
      if (aboutText && aboutText.length > 10 && aboutText.length < 5000) return aboutText
    }
  }
  // Fallback: look for a section whose first h2 is "About".
  const aboutSection = Array.from(document.querySelectorAll('section')).find((s) => {
    const h = s.querySelector('h2')
    const t = (h as HTMLElement | null)?.innerText?.trim().toLowerCase() ?? ''
    return t === 'about' || t === 'acerca de'
  })
  if (aboutSection) {
    const text = (aboutSection as HTMLElement).innerText?.trim() ?? ''
    // Strip the leading "About\n" heading if present
    const withoutHeading = text.replace(/^about\s*/i, '').trim()
    if (withoutHeading.length > 10 && withoutHeading.length < 5000) return withoutHeading
  }
  return null
}

function scrapePhotoUrl(): string | null {
  // LinkedIn serves profile photos from media.licdn.com via <img>. Class
  // names rotate constantly — the old .pv-top-card-profile-picture__image
  // selector doesn't survive modern releases. Walk from the name h1 and
  // find the first licdn-hosted image of profile-picture size (≥100px).
  function readSrc(img: HTMLImageElement): string | null {
    const candidates = [
      img.currentSrc,
      img.src,
      img.getAttribute('src'),
      img.getAttribute('data-delayed-url'),
      img.getAttribute('data-src'),
    ]
    for (const c of candidates) {
      if (!c) continue
      if (c.startsWith('data:') || c.startsWith('blob:')) continue
      if (c.includes('licdn.com')) return c
    }
    return null
  }

  function isProfileSized(img: HTMLImageElement): boolean {
    const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width') ?? '0', 10)
    const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height') ?? '0', 10)
    // Reject tiny icons; accept anything roughly square and ≥80px
    if (w === 0 && h === 0) return true // unloaded, give it a chance
    return w >= 80 || h >= 80
  }

  // 1. Structural walk from the name h1 upward — the profile photo lives
  //    in the top-card ancestor.
  const h1 = document.querySelector('main h1') as HTMLElement | null
  if (h1) {
    let container: HTMLElement | null = h1.parentElement
    for (let depth = 0; depth < 6 && container; depth++) {
      const imgs = container.querySelectorAll<HTMLImageElement>('img')
      for (const img of Array.from(imgs)) {
        if (!isProfileSized(img)) continue
        const src = readSrc(img)
        if (src) return src
      }
      container = container.parentElement
    }
  }

  // 2. Fallback: any licdn image on the page with profile-picture size.
  const allImgs = document.querySelectorAll<HTMLImageElement>('main img, section img')
  for (const img of Array.from(allImgs)) {
    if (!isProfileSized(img)) continue
    const src = readSrc(img)
    if (src) return src
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
    const location = scrapeLocation()
    const about = scrapeAbout()
    const photoUrl = scrapePhotoUrl()
    const avatarDataUrl = scrapeAvatar()
    const profile: LinkedinProfile = {
      url: parsed.url,
      slug: parsed.slug,
      name,
      jobTitle,
      location,
      about,
      photoUrl,
      avatarDataUrl,
    }
    console.log(
      `[li-preload] profile(${source}) → ${profile.url}`,
      `name=${name ?? 'null'}`,
      `title=${jobTitle ?? 'null'}`,
      `loc=${location ? 'yes' : 'null'}`,
      `about=${about ? `${about.length}chars` : 'null'}`,
      `photo=${photoUrl ? 'yes' : 'null'}`,
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
