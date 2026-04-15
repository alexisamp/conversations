// LinkedIn URL normalization + variant generation.
// Ported from the extension's normalizeLinkedInUrl + findContactByLinkedInUrl.

/** Canonical form: lowercase, strip trailing slash, drop "www." */
export function normalizeLinkedInUrl(url: string): string {
  return url
    .trim()
    .replace(/\/$/, '')
    .replace('www.linkedin.com', 'linkedin.com')
    .toLowerCase()
}

/**
 * Returns every plausible stored-format variant of a LinkedIn URL so `.in()`
 * matches whatever the DB happens to have (with/without www, with/without
 * trailing slash, https prefix variations).
 */
export function linkedinUrlVariants(url: string): string[] {
  const trimmed = url.trim()
  if (!trimmed) return []
  const stripped = trimmed.replace(/\/$/, '')
  const noWww = normalizeLinkedInUrl(trimmed)
  const noWwwSlash = noWww + '/'
  const withWww = noWww.replace('linkedin.com', 'www.linkedin.com')
  const withWwwSlash = withWww + '/'
  return Array.from(
    new Set([trimmed, stripped, noWww, noWwwSlash, withWww, withWwwSlash]),
  )
}

/** Extract the `/in/<slug>` handle from any LinkedIn URL. */
export function linkedinSlug(url: string): string | null {
  const m = url.match(/linkedin\.com\/in\/([^/?#&]+)/)
  return m ? m[1] : null
}
