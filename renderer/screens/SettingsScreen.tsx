import { useEffect, useState } from 'react'
import type { UpdaterStatus } from '../conv-api'

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<UpdaterStatus | null>(null)

  useEffect(() => {
    // Snapshot on mount
    window.conv.updater.getStatus().then(setStatus)
    // Live updates via IPC
    const unsubscribe = window.conv.updater.onStatus(setStatus)
    return unsubscribe
  }, [])

  async function handleCheck() {
    setStatus((s) => (s ? { ...s, state: 'checking', error: undefined } : s))
    const next = await window.conv.updater.check()
    setStatus(next)
  }

  async function handleDownload() {
    await window.conv.updater.download()
  }

  async function handleRestart() {
    await window.conv.updater.restartInstall()
  }

  return (
    <div className="settings">
      <header className="settings-header">
        <button className="ghost-button" onClick={onBack}>
          ← Back
        </button>
        <h2>Settings</h2>
      </header>

      <section className="settings-section">
        <div className="settings-section-title">About</div>
        <div className="settings-row">
          <span className="muted">Version</span>
          <span className="mono">{status?.currentVersion ?? '—'}</span>
        </div>
        {status?.dev && (
          <div className="settings-row">
            <span className="muted small">Dev build — auto-update disabled</span>
          </div>
        )}
      </section>

      <section className="settings-section">
        <div className="settings-section-title">Updates</div>
        <UpdateBlock
          status={status}
          onCheck={handleCheck}
          onDownload={handleDownload}
          onRestart={handleRestart}
        />
      </section>
    </div>
  )
}

function UpdateBlock({
  status,
  onCheck,
  onDownload,
  onRestart,
}: {
  status: UpdaterStatus | null
  onCheck: () => void
  onDownload: () => void
  onRestart: () => void
}) {
  if (!status) return <div className="muted small">Loading…</div>

  if (status.dev) {
    return (
      <div className="muted small">
        You're running the dev build from <code>npm run dev</code>. Updates apply only
        to packaged builds shipped via GitHub Releases.
      </div>
    )
  }

  const { state, availableVersion, progressPercent, error } = status

  return (
    <>
      <div className="settings-row">
        <span className="muted">Status</span>
        <StatusLabel state={state} availableVersion={availableVersion} />
      </div>

      {state === 'downloading' && typeof progressPercent === 'number' && (
        <div className="progress-bar">
          <div className="progress-bar-fill" style={{ width: `${progressPercent}%` }} />
          <div className="progress-bar-text">{progressPercent}%</div>
        </div>
      )}

      {state === 'error' && error && (
        <div className="settings-error">{error}</div>
      )}

      <div className="settings-actions">
        {state === 'downloaded' ? (
          <button className="primary-button" onClick={onRestart}>
            Restart to install v{availableVersion}
          </button>
        ) : state === 'available' ? (
          <button className="primary-button" onClick={onDownload}>
            Install v{availableVersion}
          </button>
        ) : (
          <button
            className="primary-button"
            onClick={onCheck}
            disabled={state === 'checking' || state === 'downloading'}
          >
            {state === 'checking'
              ? 'Checking…'
              : state === 'downloading'
                ? 'Downloading…'
                : 'Check for updates'}
          </button>
        )}
      </div>
    </>
  )
}

function StatusLabel({
  state,
  availableVersion,
}: {
  state: UpdaterStatus['state']
  availableVersion?: string
}) {
  switch (state) {
    case 'idle':
      return <span className="mono">Ready</span>
    case 'checking':
      return <span className="mono">Checking…</span>
    case 'available':
      return (
        <span className="mono" style={{ color: 'var(--pastel)' }}>
          v{availableVersion} available
        </span>
      )
    case 'not-available':
      return (
        <span className="mono" style={{ color: 'var(--shuttle)' }}>
          Up to date
        </span>
      )
    case 'downloading':
      return <span className="mono">Downloading…</span>
    case 'downloaded':
      return (
        <span className="mono" style={{ color: 'var(--pastel)' }}>
          Ready to install
        </span>
      )
    case 'error':
      return (
        <span className="mono" style={{ color: 'var(--mercury)' }}>
          Error
        </span>
      )
    default:
      return <span className="mono">{state}</span>
  }
}
