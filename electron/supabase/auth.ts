// Google OAuth sign-in for Electron using Supabase's PKCE flow.
//
// Flow:
//   1. Renderer calls auth:signIn
//   2. Main calls supabase.auth.signInWithOAuth({ provider: 'google', skipBrowserRedirect: true })
//      which gives us a Google OAuth URL and stashes a PKCE verifier in our file storage.
//   3. Main spins up a one-shot loopback HTTP server on REDIRECT_PORT.
//   4. Main opens the Google OAuth URL in the user's default browser.
//   5. User logs in. Supabase redirects back to http://localhost:54321/callback?code=...
//   6. Loopback server captures `code`, sends the user a friendly HTML page, closes.
//   7. Main calls supabase.auth.exchangeCodeForSession(code) → we are signed in.
//
// REQUIRED ONE-TIME SETUP IN THE SUPABASE DASHBOARD:
//   Authentication → URL Configuration → Redirect URLs → add:
//     http://localhost:54321/callback
//   Otherwise Supabase will refuse the OAuth redirect.

import { ipcMain, shell } from 'electron'
import * as http from 'http'
import { getSupabase } from './client'

const REDIRECT_PORT = 54321
const REDIRECT_URL = `http://localhost:${REDIRECT_PORT}/callback`
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

export type AuthStatus = {
  signedIn: boolean
  email?: string
  userId?: string
}

let activeServer: http.Server | null = null

async function getStatus(): Promise<AuthStatus> {
  const supabase = getSupabase()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return { signedIn: false }
  return {
    signedIn: true,
    email: session.user.email ?? undefined,
    userId: session.user.id,
  }
}

async function signOut(): Promise<void> {
  await getSupabase().auth.signOut()
}

async function signInWithGoogle(): Promise<void> {
  const supabase = getSupabase()

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: REDIRECT_URL,
      skipBrowserRedirect: true,
    },
  })
  if (error) throw error
  if (!data?.url) throw new Error('Supabase did not return an OAuth URL')

  // Start the loopback server BEFORE opening the browser so we never miss the redirect.
  const codePromise = waitForCallback()
  await shell.openExternal(data.url)
  const code = await codePromise

  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
  if (exchangeError) throw exchangeError
}

function waitForCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Kill any previous server still bound to the port
    if (activeServer) {
      try {
        activeServer.close()
      } catch {
        // noop
      }
      activeServer = null
    }

    const timeout = setTimeout(() => {
      try {
        activeServer?.close()
      } catch {
        // noop
      }
      activeServer = null
      reject(new Error('OAuth timed out after 5 minutes'))
    }, OAUTH_TIMEOUT_MS)

    const server = http.createServer((req, res) => {
      if (!req.url || !req.url.startsWith('/callback')) {
        res.writeHead(404)
        res.end()
        return
      }

      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`)
      const code = url.searchParams.get('code')
      const oauthError = url.searchParams.get('error')

      if (oauthError) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(htmlPage('Sign-in failed', oauthError))
        clearTimeout(timeout)
        try {
          server.close()
        } catch {
          // noop
        }
        activeServer = null
        reject(new Error(oauthError))
        return
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('Missing code parameter')
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        htmlPage(
          'Signed in to Conversations',
          'You can close this tab and return to the app.',
        ),
      )
      clearTimeout(timeout)
      setTimeout(() => {
        try {
          server.close()
        } catch {
          // noop
        }
        activeServer = null
      }, 200)
      resolve(code)
    })

    server.on('error', (err) => {
      clearTimeout(timeout)
      activeServer = null
      reject(err)
    })

    server.listen(REDIRECT_PORT, '127.0.0.1')
    activeServer = server
  })
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100vh; margin: 0; background: #f5f7f9; color: #111;
      text-align: center; padding: 24px;
    }
    h1 { color: #003720; margin: 0 0 12px; font-size: 24px; }
    p { color: #536471; max-width: 420px; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(body)}</p>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function registerAuthIpc(broadcast: (status: AuthStatus) => void): void {
  ipcMain.handle('auth:status', () => getStatus())

  ipcMain.handle('auth:signIn', async () => {
    await signInWithGoogle()
    broadcast(await getStatus())
  })

  ipcMain.handle('auth:signOut', async () => {
    await signOut()
    broadcast(await getStatus())
  })

  // Also broadcast whenever Supabase's internal auth state changes (e.g., token refresh, sign-out).
  const supabase = getSupabase()
  supabase.auth.onAuthStateChange(async () => {
    broadcast(await getStatus())
  })
}
