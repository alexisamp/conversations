// LinkedIn company page scraper — navigates the main LinkedIn WebContents
// to the company's About page, scrapes the static fields, then navigates
// back to the URL the user was viewing. User sees a brief flash; we get
// a reliable scrape because we're reusing the fully-authenticated LI
// session with all cookies/JWTs already loaded.

import type { WebContents } from 'electron'

export type CompanyScrape = {
  headline: string | null        // the tagline under company name
  description: string | null     // the full overview paragraph
  domain: string | null
  websiteUrl: string | null
  industry: string | null
  companySize: string | null     // e.g. "51-200 employees"
  employeeCountEstimate: number | null  // parsed from companySize range
  employeesOnLinkedIn: number | null    // actual members count — more accurate
  foundedYear: number | null
  hqLocation: string | null
  logoUrl: string | null
  followers: number | null
}

/**
 * Navigate an existing LinkedIn WebContents to the company's About page,
 * wait for the DOM to hydrate, scrape, then navigate back to wherever the
 * user was. Safe to fire in parallel with other UI operations — navigation
 * serializes at the webContents level.
 */
export async function scrapeLinkedInCompanyInView(
  webContents: WebContents,
  companyUrl: string,
): Promise<CompanyScrape | null> {
  const base = companyUrl.replace(/\/?(?:about\/?)?$/, '/')
  const aboutUrl = base + 'about/'

  // Remember where the user was so we can return them after scraping.
  const returnUrl = webContents.getURL()

  try {
    console.log('[scrape-company] navigating →', aboutUrl)
    await webContents.loadURL(aboutUrl)

    // Wait for the About panel to hydrate. Poll for a definition list or
    // logo image — either is enough to mean the page has real content.
    const ready = await webContents.executeJavaScript(`
      new Promise((resolve) => {
        const start = Date.now()
        const tick = () => {
          const hasAbout =
            document.querySelector('section dl') ||
            document.querySelector('dt') ||
            document.querySelector('main img[alt*="logo"]')
          if (hasAbout) return resolve(true)
          if (Date.now() - start > 8000) return resolve(false)
          setTimeout(tick, 300)
        }
        tick()
      })
    `, true)

    if (!ready) {
      console.warn('[scrape-company] about section never rendered for', aboutUrl)
    }

    const data = await webContents.executeJavaScript(COMPANY_SCRAPE_SCRIPT, true) as CompanyScrape | null
    console.log('[scrape-company] result →', JSON.stringify({
      hasLogo: !!data?.logoUrl,
      hasDomain: !!data?.domain,
      followers: data?.followers,
      size: data?.companySize,
      industry: data?.industry,
    }))
    return data
  } catch (err) {
    console.warn('[scrape-company] error:', err)
    return null
  } finally {
    // Always navigate back — even on error.
    if (returnUrl && returnUrl !== aboutUrl) {
      try {
        await webContents.loadURL(returnUrl)
      } catch (err) {
        console.warn('[scrape-company] failed to return to', returnUrl, err)
      }
    }
  }
}

// Self-contained script — runs in the company's About page main world.
const COMPANY_SCRAPE_SCRIPT = `
(function() {
  function textOf(el) {
    if (!el) return null
    const t = (el.innerText || el.textContent || '').trim()
    return t.length > 0 ? t.replace(/\\s+/g, ' ') : null
  }

  // ── Logo ─────────────────────────────────────────────────────
  let logoUrl = null
  const imgs = Array.from(document.querySelectorAll('img'))
  for (const img of imgs) {
    const s = img.src || img.getAttribute('data-delayed-url') || ''
    const alt = (img.alt || '').toLowerCase()
    if (!s.includes('media.licdn.com')) continue
    if (alt.includes('logo') || s.includes('company-logo')) { logoUrl = s; break }
  }
  if (!logoUrl) {
    for (const img of imgs) {
      const s = img.src || img.getAttribute('data-delayed-url') || ''
      if (s.includes('media.licdn.com') && !s.includes('profile-displayphoto')) {
        logoUrl = s; break
      }
    }
  }

  // ── Definition-list picker (dt/dd-ish pairs) ────────────────
  function pickDl(labels) {
    const dts = Array.from(document.querySelectorAll('dt, h3, dt h4'))
    for (const dt of dts) {
      const label = (dt.innerText || '').trim().toLowerCase()
      for (const l of labels) {
        if (label.includes(l)) {
          const dd = dt.nextElementSibling
          const txt = textOf(dd)
          if (txt) return txt
        }
      }
    }
    return null
  }

  const websiteUrl = pickDl(['website', 'sitio web'])
  const industry = pickDl(['industry', 'industria', 'sector'])
  const companySize = pickDl(['company size', 'tamaño de la empresa', 'tamaño'])
  const foundedRaw = pickDl(['founded', 'fundada', 'año de fundación'])

  // Derive domain from website
  let domain = null
  if (websiteUrl) {
    try {
      const u = new URL(websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl)
      domain = u.hostname.replace(/^www\\./, '')
    } catch (e) {}
  }

  // Employee count estimate from the bucket range ("51-200" → 200)
  let employeeCountEstimate = null
  if (companySize) {
    const m = companySize.match(/([\\d,]+)(?:\\s*-\\s*([\\d,]+))?/)
    if (m) {
      const parseNum = s => parseInt(s.replace(/[^\\d]/g, ''), 10)
      const a = parseNum(m[1])
      const b = m[2] ? parseNum(m[2]) : null
      employeeCountEstimate = b ?? a
    }
  }

  // ── Associated members (actual employee count — more accurate than bucket) ──
  // LI About page shows "N associated members" right below the size range
  // (e.g. "11-50 employees" + "104 associated members"). This is the REAL
  // count; the bucket range often lags years behind. Different from
  // followers (those are external subscribers, not employees).
  let employeesOnLinkedIn = null
  const bodyText = document.body.innerText || ''
  const em = bodyText.match(/([\\d.,]+)\\s+(associated members|miembros asociados|employees on linkedin|empleados en linkedin)/i)
  if (em) {
    employeesOnLinkedIn = parseInt(em[1].replace(/[^\\d]/g, ''), 10) || null
  }

  // ── Founded year ─────────────────────────────────────────────
  let foundedYear = null
  if (foundedRaw) {
    const ym = foundedRaw.match(/\\b(19|20)\\d{2}\\b/)
    if (ym) foundedYear = parseInt(ym[0], 10) || null
  }

  // ── Headline/tagline ─────────────────────────────────────────
  // The tagline sits below the company name in the page header. LI uses
  // various classes, but the text is always a short sentence before the
  // follow button. Pick the first short <p>/<span> inside the top <header>
  // region that isn't the company name, follower count, or a CTA.
  let headline = null
  const header = document.querySelector('main section:first-of-type')
                 || document.querySelector('header')
                 || document.querySelector('main')
  if (header) {
    const nodes = Array.from(header.querySelectorAll('h2, h3, p, span[dir]'))
    for (const n of nodes) {
      const t = textOf(n)
      if (!t) continue
      if (t.length < 15 || t.length > 280) continue
      // Skip CTAs and counters
      if (/^(follow|message|share|learn more|visit website|about us)$/i.test(t)) continue
      if (/followers|seguidores|employees|empleados|\\d+\\s+(members|miembros)/i.test(t)) continue
      // Skip if this is the "name" heading (usually an h1 sibling of the tagline)
      if (n.tagName === 'H1') continue
      // Skip location-like (has city pattern)
      if (/^[A-Z][a-zñ]+\\s*,\\s*[A-Z]/.test(t)) continue
      headline = t
      break
    }
  }

  // ── Overview / description — long paragraph in About section ─
  let description = null
  const paras = Array.from(
    document.querySelectorAll('main section p, main section span[dir], main section div[class*="about"] p, main section div[class*="overview"] p')
  )
  for (const p of paras) {
    const t = textOf(p)
    if (t && t.length >= 80 && t.length <= 5000 && !t.startsWith('Follow') && !t.includes('·\\s*Follow')) {
      description = t
      break
    }
  }

  // ── HQ location ──────────────────────────────────────────────
  // Primary path: the "Locations" section shows "Primary · Headquarters"
  // followed by the full street address. Look for an H2/H3 containing
  // "Locations" / "Ubicaciones" and grab the nearest address block.
  let hqLocation = null
  const locHeading = Array.from(document.querySelectorAll('h2, h3')).find(h => {
    const t = (h.innerText || '').toLowerCase()
    return /^locations\\b|^ubicaciones\\b/.test(t)
  })
  if (locHeading) {
    const section = locHeading.closest('section') || locHeading.parentElement
    if (section) {
      // Find the element that contains "Headquarters" / "Sede" label and grab
      // the NEXT text chunk (that's the address).
      const labelEl = Array.from(section.querySelectorAll('span, p, div, h4'))
        .find(el => /^(headquarters|sede|ubicación principal)$/i.test((el.innerText || '').trim()))
      if (labelEl) {
        // The address is either the next sibling or within the same card
        let candidate = labelEl.nextElementSibling
        while (candidate) {
          const t = textOf(candidate)
          if (t && t.length > 5 && t.length < 200 && !/^get directions$/i.test(t)) {
            hqLocation = t
            break
          }
          candidate = candidate.nextElementSibling
        }
      }
      // Fallback: any line in the section that looks like a full address
      // (contains a comma and a common country code / word)
      if (!hqLocation) {
        const lines = (section.innerText || '').split(/\\n+/).map(s => s.trim())
        for (const line of lines) {
          if (line.length > 10 && line.length < 200 && line.includes(',') && /\\b(GB|US|UK|USA|CL|MX|AR|ES|CA|FR|DE|Chile|España|Estados Unidos)\\b/i.test(line)) {
            hqLocation = line
            break
          }
        }
      }
    }
  }
  // Last-resort fallback: the old dt/dd pair for "Headquarters" (city name only)
  if (!hqLocation) {
    hqLocation = pickDl(['headquarters', 'sede', 'ubicación'])
  }

  // ── Followers ────────────────────────────────────────────────
  let followers = null
  const fm = bodyText.match(/([\\d.,]+)\\s+(followers|seguidores)/i)
  if (fm) {
    followers = parseInt(fm[1].replace(/[^\\d]/g, ''), 10) || null
  }

  return {
    headline,
    description,
    domain,
    websiteUrl,
    industry,
    companySize,
    employeeCountEstimate,
    employeesOnLinkedIn,
    foundedYear,
    hqLocation,
    logoUrl,
    followers,
  }
})()
`.trim()
