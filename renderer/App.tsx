import { useEffect, useState } from 'react'
import { LoginScreen } from './screens/LoginScreen'
import { MainScreen } from './screens/MainScreen'
import type { AuthStatus } from './conv-api'

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null)

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

  return <MainScreen email={auth.email ?? ''} />
}
