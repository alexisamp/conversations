// Phone normalization + variant generator.
// Ported from reThink-2026/extension/src/lib/phoneNormalizer.ts

/**
 * Normalizes a raw phone number to an E.164-like format ("+CC...").
 * WhatsApp data-id has the full international number without the "+"
 * prefix, so we just prepend it. Inputs with "00" country prefix are
 * converted to "+".
 */
export function normalizePhoneNumber(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null
  let cleaned = raw.replace(/[^\d+]/g, '')
  if (!cleaned) return null
  if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2)
  if (!cleaned.startsWith('+')) cleaned = '+' + cleaned
  if (cleaned.length < 5) return null
  return cleaned
}

/**
 * Returns all plausible stored-format variants of a phone number.
 *
 * Used for flexible DB matching because contacts in reThink may have been
 * saved in any of these formats historically:
 *   - as-is:                       "+18573900458"
 *   - digits only:                 "18573900458"
 *   - no country code (US/CA):     "8573900458"
 *   - no country code (Mexico):    "5551234567"
 *
 * The lookup uses `.in('channel_identifier', variants)` so any match wins.
 */
export function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, '')
  const variants = new Set<string>()
  if (phone) variants.add(phone) // as-is
  if (digits) {
    variants.add(digits) // digits only
    variants.add('+' + digits) // with + prefix
  }
  // Mexico (+52): legacy contacts may be stored without the 52
  if (digits.startsWith('52') && digits.length > 10) {
    variants.add(digits.slice(2))
    variants.add('+' + digits.slice(2))
  }
  // US/CA (+1): legacy contacts may be stored without the 1
  if (digits.startsWith('1') && digits.length === 11) {
    variants.add(digits.slice(1))
    variants.add('+' + digits.slice(1))
  }
  return Array.from(variants).filter(Boolean)
}
