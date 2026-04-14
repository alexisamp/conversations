// Pure helpers shared between screens. Ported from reThink's PersonDetail.tsx.

export function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
}

export function formatAgo(days: number | null): string {
  if (days === null) return 'Never'
  if (days === 0) return 'Today'
  if (days === 1) return '1d ago'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export type HealthState = 'never' | 'active' | 'warm' | 'cold'

export function healthState(days: number | null): HealthState {
  if (days === null) return 'never'
  if (days <= 14) return 'active'
  if (days <= 30) return 'warm'
  return 'cold'
}

export function healthLabel(state: HealthState): string {
  switch (state) {
    case 'never':
      return 'Never'
    case 'active':
      return 'Active'
    case 'warm':
      return 'Warm'
    case 'cold':
      return 'Cold'
  }
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export const INTERACTION_TYPE_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  linkedin_msg: 'LinkedIn DM',
  email: 'Email',
  call: 'Call',
  virtual_coffee: 'Virtual Coffee',
  in_person: 'In Person',
}

export const INTERACTION_TYPE_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'call', label: 'Call' },
  { key: 'virtual_coffee', label: 'Virtual Coffee' },
  { key: 'in_person', label: 'In Person' },
  { key: 'email', label: 'Email' },
  { key: 'linkedin_msg', label: 'LinkedIn DM' },
]

export const VALUE_TYPE_LABELS: Record<string, string> = {
  introduction: 'Introduction',
  content: 'Content',
  referral: 'Referral',
  advice: 'Advice',
  endorsement: 'Endorsement',
  opportunity: 'Opportunity',
  other: 'Other',
}

export const VALUE_TYPE_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'introduction', label: 'Introduction' },
  { key: 'content', label: 'Content' },
  { key: 'referral', label: 'Referral' },
  { key: 'advice', label: 'Advice' },
  { key: 'endorsement', label: 'Endorsement' },
  { key: 'opportunity', label: 'Opportunity' },
  { key: 'other', label: 'Other' },
]

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}
