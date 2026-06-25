import { session, type WebContents } from 'electron'
import { linkedinSyncState, setLinkedinSyncState } from '../db/local'
import type { LinkedinSession } from './types'

const BASE_URL = 'https://www.linkedin.com/voyager/api'
const COOKIE_URL = 'https://www.linkedin.com'
const VOYAGER_TIMEOUT_MS = 20_000

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

const PAGE_INSTANCE = `urn:li:page:messaging_thread;${randomHex(12)}`
const SESSION_VERSION = (() => {
  const now = new Date()
  return `1.${now.getFullYear() - 2012}.${now.getMonth() * 4000 + now.getDate() * 100 + Math.floor(Math.random() * 99)}`
})()

const LI_TRACK = JSON.stringify({
  clientVersion: SESSION_VERSION,
  mpVersion: SESSION_VERSION,
  osName: 'web',
  timezoneOffset: new Date().getTimezoneOffset() * -1,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  deviceFormFactor: 'DESKTOP',
  mpName: 'voyager-web',
  displayDensity: 2,
  displayWidth: 1440,
  displayHeight: 900,
})

let cachedSession: LinkedinSession | null = null
let cachedSessionAt = 0
let linkedinWebContents: WebContents | null = null
const SESSION_TTL_MS = 30_000

export function setLinkedinWebContentsForVoyager(webContents: WebContents | null): void {
  linkedinWebContents = webContents
}

async function cookieHeader(): Promise<{ header: string; jsessionId: string } | null> {
  const cookies = await session.fromPartition('persist:linkedin').cookies.get({ url: COOKIE_URL })
  const liAt = cookies.find((cookie) => cookie.name === 'li_at')
  const jsession = cookies.find((cookie) => cookie.name === 'JSESSIONID')
  if (!liAt || !jsession) return null
  return {
    header: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    jsessionId: jsession.value,
  }
}

async function hasLinkedinAuthCookies(): Promise<boolean> {
  return (await cookieHeader()) !== null
}

function cachedLinkedinSessionFromDb(): LinkedinSession | null {
  const memberUrn = linkedinSyncState('session_member_urn')
  if (!memberUrn) return null
  return {
    authenticated: true,
    memberUrn,
    displayName: linkedinSyncState('session_display_name') ?? undefined,
    publicId: linkedinSyncState('session_public_id') ?? undefined,
  }
}

function rememberLinkedinSession(state: LinkedinSession): void {
  if (!state.memberUrn) return
  setLinkedinSyncState('session_member_urn', state.memberUrn)
  if (state.displayName) setLinkedinSyncState('session_display_name', state.displayName)
  if (state.publicId) setLinkedinSyncState('session_public_id', state.publicId)
}

export async function linkedinVoyagerFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const cookies = await cookieHeader()
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
  if (cookies) {
    const direct = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(VOYAGER_TIMEOUT_MS),
      headers: {
        Cookie: cookies.header,
        'csrf-token': cookies.jsessionId.replace(/"/g, ''),
        'x-restli-protocol-version': '2.0.0',
        'x-li-lang': 'en_US',
        'x-li-track': LI_TRACK,
        'x-li-page-instance': PAGE_INSTANCE,
        'x-li-deco-include-micro-schema': 'true',
        Origin: 'https://www.linkedin.com',
        Referer: 'https://www.linkedin.com/messaging/',
        accept: 'application/vnd.linkedin.normalized+json+2.1',
        ...(options.headers ?? {}),
      },
    })
    if (direct.status !== 401 && direct.status !== 403) return direct
  }
  return linkedinVoyagerFetchInWebContents(url, options)
}

async function linkedinVoyagerFetchInWebContents(url: string, options: RequestInit): Promise<Response> {
  if (!linkedinWebContents || linkedinWebContents.isDestroyed()) {
    throw new Error('LinkedIn session cookies not found. Sign in to LinkedIn first.')
  }
  const method = options.method ?? 'GET'
  const body = typeof options.body === 'string' ? options.body : undefined
  const extraHeaders = headersToRecord(options.headers)
  const result = await linkedinWebContents.executeJavaScript(`
    (async () => {
      const cookie = document.cookie || '';
      const jsession = cookie
        .split('; ')
        .find((part) => part.startsWith('JSESSIONID='))
        ?.split('=')
        .slice(1)
        .join('=')
        .replace(/"/g, '') || '';
      const headers = {
        'csrf-token': jsession,
        'x-restli-protocol-version': '2.0.0',
        'x-li-lang': 'en_US',
        'x-li-track': ${JSON.stringify(LI_TRACK)},
        'x-li-page-instance': ${JSON.stringify(PAGE_INSTANCE)},
        'x-li-deco-include-micro-schema': 'true',
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        ...${JSON.stringify(extraHeaders)}
      };
      const response = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        headers,
        body: ${JSON.stringify(body)},
        credentials: 'include'
      });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        text: await response.text()
      };
    })()
  `, true) as { ok: boolean; status: number; statusText: string; headers: [string, string][]; text: string }
  return new Response(result.text, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  })
}

function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const record: Record<string, string> = {}
    headers.forEach((value, key) => {
      record[key] = value
    })
    return record
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers as Record<string, string>
}

export async function getLinkedinSession(): Promise<LinkedinSession> {
  if (cachedSession && Date.now() - cachedSessionAt < SESSION_TTL_MS) return cachedSession
  try {
    const res = await linkedinVoyagerFetch('/me')
    if (!res.ok) {
      if (await hasLinkedinAuthCookies()) return cachedLinkedinSessionFromDb() ?? { authenticated: false }
      return { authenticated: false }
    }
    const data = await res.json()
    const miniProfile = data.included?.find(
      (item: any) => item.$type === 'com.linkedin.voyager.identity.shared.MiniProfile',
    )
    const memberId = miniProfile?.entityUrn?.split(':').pop() || ''
    const memberUrn = memberId ? `urn:li:fsd_profile:${memberId}` : ''
    if (!memberUrn) {
      if (await hasLinkedinAuthCookies()) return cachedLinkedinSessionFromDb() ?? { authenticated: false }
      return { authenticated: false }
    }
    cachedSession = {
      authenticated: true,
      memberUrn,
      displayName: `${miniProfile?.firstName || ''} ${miniProfile?.lastName || ''}`.trim() || undefined,
      publicId: miniProfile?.publicIdentifier,
    }
    rememberLinkedinSession(cachedSession)
    cachedSessionAt = Date.now()
    return cachedSession
  } catch {
    if (await hasLinkedinAuthCookies()) {
      const cached = cachedLinkedinSessionFromDb()
      if (cached) {
        cachedSession = cached
        cachedSessionAt = Date.now()
        return cached
      }
    }
    return { authenticated: false }
  }
}

export async function getLinkedinMemberUrn(): Promise<string> {
  const state = await getLinkedinSession()
  if (!state.memberUrn) {
    if (await hasLinkedinAuthCookies()) {
      const cached = cachedLinkedinSessionFromDb()
      if (cached?.memberUrn) return cached.memberUrn
    }
    throw new Error('LinkedIn is not authenticated')
  }
  return state.memberUrn
}
