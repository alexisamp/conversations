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
// Dedupe the one-shot photo DOM diagnostic so we only dump once per profile.
const diagnosedProfiles = new Set<string>()

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

function diagnosePhotoDom(slug: string): void {
  // Runs once per slug. Dumps every <img> in <main> plus any element with
  // an inline background-image URL, so we can see what the DOM actually
  // looks like inside Electron's WebContentsView (which may differ from
  // a Chrome content script for LinkedIn's SPA).
  if (diagnosedProfiles.has(slug)) return
  diagnosedProfiles.add(slug)

  const report: Record<string, unknown> = {}
  const mains = document.querySelectorAll('main')
  report.mainCount = mains.length
  report.totalImgs = document.querySelectorAll('img').length

  const mainEl = mains[0] as HTMLElement | undefined
  if (mainEl) {
    const imgs = Array.from(mainEl.querySelectorAll<HTMLImageElement>('img'))
    report.mainImgCount = imgs.length
    report.mainImgs = imgs.slice(0, 15).map((img) => ({
      src: (img.src || '').slice(0, 120),
      dataDelayedUrl: (img.getAttribute('data-delayed-url') || '').slice(0, 120),
      dataGhostUrl: (img.getAttribute('data-ghost-url') || '').slice(0, 120),
      alt: img.getAttribute('alt') || '',
      className: (img.className || '').toString().slice(0, 100),
      parentCls: (img.parentElement?.className || '').toString().slice(0, 100),
      w: img.naturalWidth,
      h: img.naturalHeight,
    }))

    // Also check for background-image on divs — LinkedIn sometimes renders
    // photos via CSS background instead of <img> tags.
    const bgCandidates: Array<{ cls: string; bg: string }> = []
    const divs = mainEl.querySelectorAll<HTMLElement>(
      'div[style*="background"], section[style*="background"]',
    )
    for (const d of Array.from(divs).slice(0, 10)) {
      const style = d.getAttribute('style') || ''
      const m = style.match(/url\(["']?([^"')]+)["']?\)/)
      if (m) {
        bgCandidates.push({
          cls: d.className.toString().slice(0, 80),
          bg: m[1].slice(0, 120),
        })
      }
    }
    report.bgImages = bgCandidates
  }

  console.log('[li-preload] photo-dom-diagnostic', JSON.stringify(report))
}

function scrapePhotoUrl(slug: string): string | null {
  // Ported directly from reThink-2026/extension/src/content-scripts/linkedin-profile.ts
  // which is known to work across LinkedIn releases.
  //
  // Two critical details:
  //   1. Only scan <main>. The logged-in user's own avatar lives in the nav
  //      header OUTSIDE main, so restricting the search automatically avoids
  //      picking up "your own face" when viewing someone else's profile.
  //   2. Accept src OR data-delayed-url OR data-ghost-url. LinkedIn uses
  //      those attributes for lazy-loaded + ghost-rendered images on its
  //      SPA route transitions.
  //
  // The distinguishing URL fragment is "profile-displayphoto" (the profile
  // photo) vs "profile-displaybackgroundimage" (the cover banner). We
  // strongly prefer the former, fall back to any licdn dms/image inside main.
  //
  // On each first scrape for a profile we also dump a one-shot DOM diagnostic
  // so we can see what LinkedIn actually renders inside Electron.
  diagnosePhotoDom(slug)

  function readUrl(img: HTMLImageElement): string | null {
    const url =
      img.src ||
      img.getAttribute('data-delayed-url') ||
      img.getAttribute('data-ghost-url') ||
      ''
    if (url && url.includes('media.licdn.com')) return url
    return null
  }

  const mainEl = document.querySelector('main')
  if (!mainEl) return null
  const imgs = Array.from(mainEl.querySelectorAll<HTMLImageElement>('img'))

  // Step 1: preferred — the contact's profile photo
  for (const img of imgs) {
    const url = readUrl(img)
    if (url && url.indexOf('profile-displayphoto') !== -1) return url
  }

  // Step 2: fallback to any media.licdn.com/dms/image inside main — but
  // explicitly exclude backgroundimage paths so we don't pick up the banner.
  for (const img of imgs) {
    const url = readUrl(img)
    if (!url || url.indexOf('media.licdn.com/dms/image') === -1) continue
    if (url.indexOf('displaybackgroundimage') !== -1) continue
    return url
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
    const photoUrl = scrapePhotoUrl(parsed.slug)
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
