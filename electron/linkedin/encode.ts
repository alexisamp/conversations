export interface RawValue { __raw: string }

export function raw(value: string): RawValue {
  return { __raw: value }
}

export function encodeUrnChars(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/:/g, '%3A')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/,/g, '%2C')
    .replace(/=/g, '%3D')
    .replace(/&/g, '%26')
    .replace(/#/g, '%23')
    .replace(/\+/g, '%2B')
    .replace(/ /g, '%20')
}

export function linkedInVariables(params: Record<string, string | number | boolean | RawValue>): string {
  const parts = Object.entries(params).map(([key, value]) => {
    if (typeof value === 'number' || typeof value === 'boolean') return `${key}:${value}`
    if (value && typeof value === 'object' && '__raw' in value) return `${key}:${value.__raw}`
    return `${key}:${encodeUrnChars(value as string)}`
  })
  return `(${parts.join(',')})`
}

