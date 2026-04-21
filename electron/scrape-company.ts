// LinkedIn company page scraper — navigates the main LinkedIn WebContents
// to the company's About page, scrapes the static fields, then navigates
// back to the URL the user was viewing. User sees a brief flash; we get
// a reliable scrape because we're reusing the fully-authenticated LI
// session with all cookies/JWTs already loaded.

import type { WebContents } from 'electron'

export type CompanyScrape = {
  description: string | null
  domain: string | null
  websiteUrl: string | null
  industry: string | null
  companySize: string | null   // e.g. "51-200 employees"
  employeeCountEstimate: number | null
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

  // ── About section: definition list (dt/dd pairs) ────────────
  function pickDl(labels) {
    const dts = Array.from(document.querySelectorAll('dt, h3'))
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
  const hqLocation = pickDl(['headquarters', 'sede', 'ubicación'])

  // Derive domain from website
  let domain = null
  if (websiteUrl) {
    try {
      const u = new URL(websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl)
      domain = u.hostname.replace(/^www\\./, '')
    } catch (e) {}
  }

  // Employee count: "51-200 employees" → 200; "10,001+" → 10001
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

  // ── Description (overview paragraph) ─────────────────────────
  let description = null
  const paras = Array.from(
    document.querySelectorAll('main section p, main section span[dir], main section div[class*="about"] p')
  )
  for (const p of paras) {
    const t = textOf(p)
    if (t && t.length >= 60 && t.length <= 3000 && !t.includes('·')) {
      description = t
      break
    }
  }

  // ── Followers ────────────────────────────────────────────────
  let followers = null
  const bodyText = document.body.innerText || ''
  const fm = bodyText.match(/([\\d.,]+)\\s+(followers|seguidores)/i)
  if (fm) {
    followers = parseInt(fm[1].replace(/[^\\d]/g, ''), 10) || null
  }

  return { description, domain, websiteUrl, industry, companySize, employeeCountEstimate, hqLocation, logoUrl, followers }
})()
`.trim()
