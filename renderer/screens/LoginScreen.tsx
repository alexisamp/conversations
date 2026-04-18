import { useState } from 'react'

export function LoginScreen() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSignIn() {
    setLoading(true)
    setError(null)
    try {
      await window.conv.auth.signIn()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign-in failed'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login">
      <img
        src="./icon.png"
        alt="Conversations"
        className="login-logo"
        width={72}
        height={72}
      />
      <h1>Conversations</h1>
      <p>Sign in to access your reThink contacts.</p>
      <button onClick={handleSignIn} disabled={loading}>
        {loading ? 'Opening browser…' : 'Sign in with Google'}
      </button>
      {error && <div className="error">{error}</div>}
      <div className="login-hint">
        A browser tab will open for Google auth. After signing in, return to
        this window.
      </div>
    </div>
  )
}
