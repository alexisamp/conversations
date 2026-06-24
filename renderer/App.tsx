import { useEffect, useState } from 'react'
import { LoginScreen } from './screens/LoginScreen'
import { MainScreen } from './screens/MainScreen'
import { LinkedinMessagesScreen } from './screens/LinkedinMessagesScreen'
import type { AuthStatus } from './conv-api'

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const mode = new URLSearchParams(window.location.search).get('mode')

  useEffect(() => {
    let mounted = true
    window.conv.auth.status().then((status) => {
      if (mounted) setAuth(status)
    })
    window.conv.auth.onChanged((status) => {
      if (mounted) setAuth(status)
    })
    return () => {
      mounted = false
    }
  }, [])

  if (!auth) {
    return <div className="loading">Loading…</div>
  }

  if (!auth.signedIn) {
    return <LoginScreen />
  }

  if (mode === 'linkedin-messages') {
    return <LinkedinMessagesScreen />
  }

  return <MainScreen email={auth.email ?? ''} />
}
