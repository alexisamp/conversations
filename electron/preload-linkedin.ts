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
  company: string | null
  companyLinkedinUrl: string | null
  companyLogoUrl: string | null
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

function cleanNameText(raw: string): string | null {
  // LinkedIn h1 sometimes has suffixes like '· 3rd+' or '| Open to work'.
  // Strip them and take only the first line / first segment.
  const text = raw
    .split(/\n/)[0]
    .split(/\s*[|·•]\s*/)[0]
    .replace(/\s+/g, ' ')
    .trim()
  if (text && text.length >= 2 && text.length < 80) return text
  return null
}

function scrapeName(): string | null {
  const nameSelectors = [
    'main h1.text-heading-xlarge',
    'main h1.inline',
    'main h1[class*="text-heading"]',
    'main h1.t-24',
    'main h1.t-bold',
    '.pv-top-card h1',
    '.ph5 h1',
    'main section h1',
    'main h1',
  ]
  for (const sel of nameSelectors) {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) continue
    const text = cleanNameText(el.innerText ?? '')
    if (text) return text
  }

  // Fallback 1: any heading-role element inside main
  const headingRoles = document.querySelectorAll<HTMLElement>('main [role="heading"]')
  for (const el of Array.from(headingRoles)) {
    const text = cleanNameText(el.innerText ?? '')
    if (text) return text
  }

  // Fallback 2: structural walk from the profile photo. We know the photo
  // matches profile-displayphoto — walk up a few ancestors and look for
  // the first text block that looks like a personal name (2-4 words,
  // not all lowercase, reasonable length).
  const mainEl = document.querySelector('main')
  if (mainEl) {
    const imgs = Array.from(mainEl.querySelectorAll<HTMLImageElement>('img'))
    const photoImg = imgs.find((img) => {
      const src = img.src || img.getAttribute('data-delayed-url') || ''
      return src.includes('profile-displayphoto')
    })
    if (photoImg) {
      let container: HTMLElement | null = photoImg.parentElement
      for (let depth = 0; depth < 6 && container; depth++) {
        // Try any text-bearing element in this ancestor that isn't a button
        // or link and has a name-like shape.
        const candidates = container.querySelectorAll<HTMLElement>('h1, h2, h3, span, div')
        for (const el of Array.from(candidates)) {
          if (el.children.length > 3) continue
          if (el.querySelector('button, a')) continue
          const text = cleanNameText(el.innerText ?? '')
          if (!text) continue
          // Name-likeness: 2-4 words, at least one uppercase letter
          const words = text.split(/\s+/)
          if (words.length < 2 || words.length > 5) continue
          if (!/[A-Z]/.test(text)) continue
          return text
        }
        container = container.parentElement
      }
    }
  }

  // Last resort: anywhere on the page
  const anyH1 = document.querySelector('h1') as HTMLElement | null
  if (anyH1) {
    const text = cleanNameText(anyH1.innerText ?? '')
    if (text) return text
  }
  return null
}

function scrapeJobTitle(): string | null {
  // The headline is the FIRST substantive text block in the top card after
  // the name. It's longer than a location (no comma + city) and longer
  // than "X followers". We use getTopCardTextBlocks() which already skips
  // the name, degree markers, and button labels.
  const blocks = getTopCardTextBlocks()
  for (const b of blocks) {
    const t = b.text
    // Skip location-like (comma inside, single title-case word)
    if (/followers$|connections$/i.test(t)) continue
    if (t.length < 5 || t.length > 220) continue
    // Skip short all-title-case blocks (those are locations / countries)
    const words = t.split(/\s+/)
    if (words.length <= 3) {
      const allTitleCase = words.every((w) => /^[A-Z][a-zA-Z]*$/.test(w))
      if (allTitleCase && !t.includes(' at ')) continue
    }
    // Found the headline
    return t
  }
  return null
}

// ─── Top-card text extraction ─────────────────────────────────────────
//
// LinkedIn's profile top card obfuscates every class name but the
// structural shape is stable: a container near the profile photo holds the
// name, headline, current-company line, location, and follower count as a
// series of short text elements (mostly <p> tags in current releases).
//
// We anchor on the profile-displayphoto img, walk up 3-6 ancestors until we
// find a container that holds the name too, then collect the <p>/<span>
// text blocks inside it in DOM order. Junk (degree indicators, "Contact
// info", button labels) is filtered out. The consumer picks which block is
// the headline / location / company by position + pattern.

type TopCardBlock = { text: string }

function isJunkTopCardText(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (t.length < 2 || t.length > 300) return true
  if (/^·\s*(1st|2nd|3rd|3\+|Following)/i.test(t)) return true
  if (/^(Contact info|Message|Follow|Connect|More|\+ Follow)$/i.test(t)) return true
  if (/^\d+(st|nd|rd|th)\+?$/i.test(t)) return true
  // LI "More actions" truncated button labels (seen rendered as "Read Spec" when
  // clipped) — never a real profile text block.
  if (/^Read Spec/i.test(t)) return true
  // Pronoun tags ("He/Him", "She/Her", "They/Them", sometimes with degree suffix).
  if (/^(he\/him|she\/her|they\/them|he\/they|she\/they|ze\/zir)(\s*·.*)?$/i.test(t)) return true
  return false
}

// Content keywords that identify a block as an education/certification row
// rather than a current-employer company row. Used by scrapeCompany to skip
// MBAs, universities, schools, certifications that render in the same area
// as the current-role company in the profile top card.
const EDUCATION_KEYWORD_RE = /\b(MBA|Master(?:'s)?|PhD|University|Universidad|School of|Business School|Bootcamp|Course|Certificate|Certification|Diploma)\b/i

function getTopCardTextBlocks(): TopCardBlock[] {
  const mainEl = document.querySelector('main')
  if (!mainEl) return []
  const imgs = Array.from(mainEl.querySelectorAll<HTMLImageElement>('img'))
  const photoImg = imgs.find((img) => {
    const s = img.src || img.getAttribute('data-delayed-url') || ''
    return s.includes('profile-displayphoto')
  })
  if (!photoImg) return []

  // Walk up from the photo until we find a container that also contains
  // the person's name.
  const name = scrapeName()
  let container: HTMLElement | null = photoImg.parentElement
  let topCard: HTMLElement | null = null
  for (let i = 0; i < 8 && container; i++) {
    if (name && container.innerText?.includes(name)) {
      topCard = container
      break
    }
    container = container.parentElement
  }
  if (!topCard) return []

  // Only collect <p> tags. They're the atomic text elements LinkedIn uses
  // for headline / current company / location / followers. Collecting divs
  // or spans would include parent containers whose innerText is the
  // concatenation of all their descendants — that's how we ended up with
  // 'Lenny Rachitsky · 3rd Deeply researched…' in the job_title field.
  const blocks: TopCardBlock[] = []
  const seen = new Set<string>()
  const elements = topCard.querySelectorAll<HTMLElement>('p')
  for (const el of Array.from(elements)) {
    const text = (el.innerText ?? '').trim().replace(/\s+/g, ' ')
    if (isJunkTopCardText(text)) continue
    if (text.includes('\n')) continue
    if (seen.has(text)) continue
    seen.add(text)
    if (name && text === name) continue
    blocks.push({ text })
    if (blocks.length >= 20) break
  }
  return blocks
}

// ─── Positional scrapers ────────────────────────────────────────────────
// The top-card blocks always follow this order (LinkedIn has kept it
// stable across 2023–2026 redesigns):
//   [0] headline (job title) — always the first substantive <p>
//   [1..N-3] optional current-company rows
//   [N-2] location ("City, Region" OR "City, Country" OR single country word)
//   [N-1] "N followers" / "N connections"
//
// The old heuristic-on-comma scrapers returned the headline as location on
// profiles whose headline contained a comma ("Data Scientist, AI & Growth").
// The fix: anchor on the followers/connections block at the END and walk
// backwards.

const FOLLOWERS_PATTERN = /\d+\s*(followers|connections|seguidores|contactos)\s*$/i

function findFollowersIndex(blocks: TopCardBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (FOLLOWERS_PATTERN.test(blocks[i].text)) return i
  }
  return -1
}

function looksLikeLocation(t: string): boolean {
  // Length/boundary
  if (t.length > 120 || t.length < 2) return false
  if (FOLLOWERS_PATTERN.test(t)) return false
  if (t.includes('|')) return false
  // Reject education/course rows that sometimes land at fIdx-1
  if (EDUCATION_KEYWORD_RE.test(t)) return false
  // Reject headline-ish ("Title at Company", "of Company", C-suite)
  if (/\b(at|of)\b|Head |Director|Engineer|Manager|Founder|CEO|CTO|CFO/i.test(t)) return false
  return true
}

function scrapeLocation(excludeCompany?: string | null): string | null {
  const blocks = getTopCardTextBlocks()
  if (blocks.length === 0) return null

  const excludeNorm = excludeCompany
    ? excludeCompany.trim().toLowerCase().replace(/\s+/g, ' ')
    : null
  const isExcluded = (t: string): boolean =>
    excludeNorm !== null &&
    t.trim().toLowerCase().replace(/\s+/g, ' ') === excludeNorm

  const fIdx = findFollowersIndex(blocks)

  // Walk BACKWARD from just-before-followers and return the first block
  // that passes location heuristics — and isn't the scraped company name
  // (LI sometimes renders the company name as both an anchor AND a <p>,
  // so a naive location pick could grab "Granola" when real location is
  // the row above).
  if (fIdx > 0) {
    for (let i = fIdx - 1; i >= 1; i--) {
      const t = blocks[i].text
      if (isExcluded(t)) continue
      if (looksLikeLocation(t)) return t
    }
  }

  // Followers block didn't render yet — scan forward for a "City, Region"
  // pattern (comma-separated location is a strong signal).
  for (const b of blocks) {
    if (!b.text.includes(',')) continue
    if (isExcluded(b.text)) continue
    if (looksLikeLocation(b.text)) return b.text
  }
  return null
}

/** Positional company scraper — the <p> between the headline (index 0) and
 *  the location (index fIdx-1). Returns null if no intermediate block. */
function scrapeCompany(): string | null {
  // LEGACY block-based fallback. Primary path is scrapeCompanyInfo() which
  // reads the company name directly from the <a href="/company/..."> anchor
  // (modern LI renders the name inside the anchor, never as a <p>, so block
  // walking can't see it).
  const blocks = getTopCardTextBlocks()
  if (blocks.length === 0) return null

  const fIdx = findFollowersIndex(blocks)
  if (fIdx < 2) return null

  for (let i = 1; i <= fIdx - 2; i++) {
    const t = blocks[i].text
    if (t.length > 100) continue
    if (/\b(at|of)\b|Head |Director|Engineer|Manager|Founder|CEO|CTO|CFO/i.test(t)) continue
    if (EDUCATION_KEYWORD_RE.test(t)) continue
    // Location-looking blocks (comma separators, short country words) aren't
    // companies. Rejecting here avoids picking "United Kingdom" / "Santiago,
    // Chile" as a company.
    if (looksLikeLocation(t)) continue
    return t
  }
  return null
}

// Extract company info (name + URL + logo) from the LinkedIn profile's
// top-card current-role widget. Three layers of detection, most-reliable
// first:
//
//   L1: aria-label on a <button> or <a> — "Current company: Granola" /
//       "Empresa actual: Granola". Most robust post-2024 because LI uses
//       this for accessibility on role-widget buttons even when there's no
//       anchor tag. Covers the variant where the current-role row is a
//       <button> (no href).
//
//   L2: <a href="/company/<slug>/"> anchor text. Covers profiles where the
//       current-role renders as a real anchor, not a button.
//
//   L3: null — caller should fall back to scrapeCompany() (block walker)
//       and parseCompanyFromHeadline().
//
// All layers reject education rows via EDUCATION_KEYWORD_RE — "Marketing
// Week Mini MBA..." never wins.
function scrapeCompanyInfo(): { name: string | null; url: string | null; logoUrl: string | null } {
  function normalizeUrl(raw: string): string | null {
    const m = raw.match(/linkedin\.com\/company\/([^/?#]+)/)
    if (!m) return null
    return `https://www.linkedin.com/company/${m[1]}/`
  }

  // Clean visible element text: remove hidden screen-reader preamble,
  // strip "Current company: X" prefixes that sometimes leak into innerText,
  // collapse whitespace.
  function cleanText(el: Element): string | null {
    const raw = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ')
    if (!raw) return null
    const stripped = raw
      .replace(/^(current company|empresa actual|current role|rol actual):?\s*/i, '')
      .trim()
    if (!stripped || stripped.length > 100) return null
    return stripped
  }

  // Try to extract a logo URL from <img> descendants of el, preferring
  // company-logo-shaped srcs and avoiding the profile photo.
  function pickLogo(el: Element): string | null {
    const imgs = Array.from(el.querySelectorAll<HTMLImageElement>('img'))
    for (const img of imgs) {
      const s = img.src || img.getAttribute('data-delayed-url') || ''
      if (s.includes('company-logo') || s.includes('company_logo')) return s
    }
    for (const img of imgs) {
      const s = img.src || img.getAttribute('data-delayed-url') || ''
      if (s.includes('media.licdn.com') && !s.includes('profile-displayphoto')) return s
    }
    return null
  }

  // Scope to the TOP-CARD container. Walk up from the profile photo img
  // until a parent also contains the h1.
  const mainEl = document.querySelector('main') ?? document.body
  const imgs = Array.from(mainEl.querySelectorAll<HTMLImageElement>('img'))
  const photoImg = imgs.find((img) => {
    const s = img.src || img.getAttribute('data-delayed-url') || ''
    return s.includes('profile-displayphoto')
  })
  let topCard: HTMLElement | null = photoImg?.parentElement ?? null
  for (let i = 0; i < 8 && topCard; i++) {
    if (topCard.querySelector('h1')) break
    topCard = topCard.parentElement
  }
  const scope = topCard ?? mainEl

  // Helper: find a /company/ anchor nearby, trying increasingly broader
  // scopes. Some LI variants put the aria-label on a button with no nested
  // anchor — in that case the actual URL anchor lives in the parent row
  // (same widget item) or elsewhere in the top card.
  function findCompanyUrlNear(el: Element): string | null {
    // 1. Descendant
    const nested = el.querySelector<HTMLAnchorElement>('a[href*="/company/"]')
    if (nested) return normalizeUrl(nested.href)
    // 2. Same widget row
    const row = el.closest('li, .pv-text-details__right-panel-item, [class*="right-panel-item"], section, div')
    if (row && row !== el) {
      const rowA = row.querySelector<HTMLAnchorElement>('a[href*="/company/"]')
      if (rowA) return normalizeUrl(rowA.href)
    }
    // 3. Any /company/ anchor in scope (top card). Best-effort.
    const anyA = scope.querySelector<HTMLAnchorElement>('a[href*="/company/"]')
    if (anyA) return normalizeUrl(anyA.href)
    return null
  }

  // ── L1: aria-label with "Current company: X" / "Empresa actual: X" ──
  const COMPANY_LABEL_RE = /^(?:current company|empresa actual|current role)[:\s]+(.+)$/i
  const labeled = Array.from(
    scope.querySelectorAll<HTMLElement>('[aria-label]'),
  )
  for (const el of labeled) {
    const label = el.getAttribute('aria-label') ?? ''
    const m = label.match(COMPANY_LABEL_RE)
    if (!m) continue
    const name = m[1].trim()
    if (!name || EDUCATION_KEYWORD_RE.test(name)) continue

    const url = findCompanyUrlNear(el)
    const logoUrl = pickLogo(el)
    return { name, url, logoUrl }
  }

  // ── L2: /company/ anchor — text inside the <a> ──
  const anchors = Array.from(
    scope.querySelectorAll<HTMLAnchorElement>('a[href*="/company/"]'),
  )
  for (const a of anchors) {
    const text = cleanText(a)
    if (!text) continue
    if (EDUCATION_KEYWORD_RE.test(text)) continue
    const url = normalizeUrl(a.href)
    const row = a.closest('li, section, div') ?? a
    const logoUrl = pickLogo(row)
    return { name: text, url, logoUrl }
  }

  return { name: null, url: null, logoUrl: null }
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

function diagnosePhotoDom(slug: string, scrapedName: string | null): void {
  // Runs ONCE per slug, gated on 'scrapeName returned something'. That's
  // the most reliable 'DOM is ready' signal.
  if (diagnosedProfiles.has(slug)) return
  if (!scrapedName) return
  diagnosedProfiles.add(slug)

  const report: Record<string, unknown> = {}
  const mainEl = document.querySelector('main') as HTMLElement | null
  if (!mainEl) {
    report.error = 'no main'
    console.log('[li-preload] li-dom-diagnostic', JSON.stringify(report))
    return
  }

  report.mainImgCount = mainEl.querySelectorAll('img').length
  report.scrapedName = scrapedName

  // Flat dump of ALL short text elements inside main, in DOM order.
  // Filter: 3-180 chars, leaf-ish (≤3 children), not a button/link, not
  // containing another candidate. This gives us a linear picture of what
  // the top card looks like so we can find the headline + location by
  // pattern matching.
  const allText = Array.from(mainEl.querySelectorAll<HTMLElement>('span, div, p, a, h1, h2'))
  const seenTexts = new Set<string>()
  const textBlocks: Array<{ tag: string; text: string; cls: string; aria: string }> = []
  for (const el of allText) {
    if (el.children.length > 3) continue
    if (el.querySelector('button')) continue
    const text = (el.innerText || '').trim().replace(/\n+/g, ' | ').slice(0, 150)
    if (!text || text.length < 3 || text.length > 180) continue
    // Dedupe identical strings (parent + child can carry the same text)
    if (seenTexts.has(text)) continue
    seenTexts.add(text)
    textBlocks.push({
      tag: el.tagName,
      text,
      cls: (el.className || '').toString().slice(0, 70),
      aria: el.getAttribute('aria-label')?.slice(0, 50) || '',
    })
    if (textBlocks.length >= 40) break
  }
  report.textBlocks = textBlocks

  console.log('[li-preload] li-dom-diagnostic', JSON.stringify(report))
}

function scrapePhotoUrl(): string | null {
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
    // Fire the one-shot diagnostic once we have a name (DOM is hydrated).
    diagnosePhotoDom(parsed.slug, name)
    const jobTitle = scrapeJobTitle()
    // Anchor-based company detection is authoritative — modern LI DOM holds
    // the company name inside the <a>, not in a <p>. Falls back to the
    // block-walking scrapeCompany() only when anchors are unavailable.
    const companyInfo = scrapeCompanyInfo()
    const company = companyInfo.name ?? scrapeCompany()
    const companyLinkedinUrl = companyInfo.url
    const companyLogoUrl = companyInfo.logoUrl
    // Pass the scraped company to scrapeLocation so it doesn't accidentally
    // pick up the company name as location (LI sometimes renders the name
    // in both the role-widget anchor AND a <p> near the location row).
    const location = scrapeLocation(company)
    const about = scrapeAbout()
    const photoUrl = scrapePhotoUrl()
    const avatarDataUrl = scrapeAvatar()
    const profile: LinkedinProfile = {
      url: parsed.url,
      slug: parsed.slug,
      name,
      jobTitle,
      company,
      companyLinkedinUrl,
      companyLogoUrl,
      location,
      about,
      photoUrl,
      avatarDataUrl,
    }
    console.log(
      `[li-preload] profile(${source}) → ${profile.url}`,
      `name=${name ?? 'null'}`,
      `title=${jobTitle ?? 'null'}`,
      `company=${company ?? 'null'}`,
      `companyUrl=${companyLinkedinUrl ?? 'null'}`,
      `companyLogo=${companyLogoUrl ? 'yes' : 'null'}`,
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
