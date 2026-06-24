import { session } from 'electron'
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
const SESSION_TTL_MS = 30_000

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

export async function linkedinVoyagerFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const cookies = await cookieHeader()
  if (!cookies) throw new Error('LinkedIn session cookies not found. Sign in to LinkedIn first.')
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
  return fetch(url, {
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
}

export async function getLinkedinSession(): Promise<LinkedinSession> {
  if (cachedSession && Date.now() - cachedSessionAt < SESSION_TTL_MS) return cachedSession
  try {
    const res = await linkedinVoyagerFetch('/me')
    if (!res.ok) return { authenticated: false }
    const data = await res.json()
    const miniProfile = data.included?.find(
      (item: any) => item.$type === 'com.linkedin.voyager.identity.shared.MiniProfile',
    )
    const memberId = miniProfile?.entityUrn?.split(':').pop() || ''
    const memberUrn = memberId ? `urn:li:fsd_profile:${memberId}` : ''
    if (!memberUrn) return { authenticated: false }
    cachedSession = {
      authenticated: true,
      memberUrn,
      displayName: `${miniProfile?.firstName || ''} ${miniProfile?.lastName || ''}`.trim() || undefined,
      publicId: miniProfile?.publicIdentifier,
    }
    cachedSessionAt = Date.now()
    return cachedSession
  } catch {
    return { authenticated: false }
  }
}

export async function getLinkedinMemberUrn(): Promise<string> {
  const state = await getLinkedinSession()
  if (!state.memberUrn) throw new Error('LinkedIn is not authenticated')
  return state.memberUrn
}

