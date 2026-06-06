import Database from 'better-sqlite3'
import { app, shell } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  latestBridgeMessageSummary,
  upsertBridgeMessages,
  type BridgeMessageInput,
} from '../db/local'

const DEFAULT_ADDR = '127.0.0.1:8765'

export type WhatsappBridgeState =
  | 'not_installed'
  | 'starting'
  | 'needs_linking'
  | 'connected'
  | 'offline'

export type WhatsappBridgeStatus = {
  state: WhatsappBridgeState
  label: string
  detail: string
  daemonUrl: string
  pairUrl: string
  storeDir: string
  binaryPath: string | null
  lastImportedAt: number | null
  importedToday: number
  error?: string
}

type SealjayMessageRow = {
  id: string
  chat_jid: string
  sender: string | null
  content: string | null
  timestamp: string
  is_from_me: number | boolean
  media_type: string | null
  chat_name: string | null
}

function bridgeAddr(): string {
  return process.env.WHATSAPP_MCP_ADDR || DEFAULT_ADDR
}

function bridgeStoreDir(): string {
  return process.env.WHATSAPP_MCP_STORE ||
    path.join(app.getPath('userData'), 'whatsapp-mcp-store')
}

function bridgeBaseUrl(): string {
  return `http://${bridgeAddr()}`
}

function candidateBinaries(): string[] {
  const home = os.homedir()
  return [
    process.env.WHATSAPP_MCP_BINARY || '',
    path.join(home, 'bin', 'whatsapp-mcp'),
    path.join(home, '.local', 'bin', 'whatsapp-mcp'),
    '/opt/homebrew/bin/whatsapp-mcp',
    '/usr/local/bin/whatsapp-mcp',
  ].filter(Boolean)
}

function findBinary(): string | null {
  for (const candidate of candidateBinaries()) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function isPersonJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net')
}

function phoneFromJid(jid: string): string | null {
  const user = jid.split('@')[0] || ''
  if (!/^\d{7,16}$/.test(user)) return null
  return `+${user}`
}

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export class WhatsappBridge {
  private starting = false

  getStoreDir(): string {
    return bridgeStoreDir()
  }

  getPairUrl(): string {
    return `${bridgeBaseUrl()}/pair`
  }

  async ensureStarted(): Promise<void> {
    const status = await this.probeHttp()
    if (status.ok || this.starting) return
    const binary = findBinary()
    if (!binary) return

    fs.mkdirSync(this.getStoreDir(), { recursive: true, mode: 0o700 })
    this.starting = true
    try {
      const child = spawn(binary, ['-store', this.getStoreDir(), 'serve'], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          WHATSAPP_MCP_ADDR: bridgeAddr(),
          WHATSAPP_MCP_MEDIA_ROOT:
            process.env.WHATSAPP_MCP_MEDIA_ROOT ||
            path.join(this.getStoreDir(), 'uploads'),
        },
      })
      child.unref()
    } catch (err) {
      console.warn('[whatsapp-bridge] failed to start daemon:', err)
    } finally {
      setTimeout(() => {
        this.starting = false
      }, 5000)
    }
  }

  async openPairing(): Promise<void> {
    await this.ensureStarted()
    await shell.openExternal(this.getPairUrl())
  }

  async getStatus(): Promise<WhatsappBridgeStatus> {
    const binary = findBinary()
    const http = await this.probeHttp()
    const summary = this.localSummary()
    const base = {
      daemonUrl: bridgeBaseUrl(),
      pairUrl: this.getPairUrl(),
      storeDir: this.getStoreDir(),
      binaryPath: binary,
      lastImportedAt: summary.lastImportedAt,
      importedToday: summary.importedToday,
    }

    if (!binary && !http.ok) {
      return {
        ...base,
        state: 'not_installed',
        label: 'WhatsApp bridge not installed',
        detail: 'Install Sealjay whatsapp-mcp or set WHATSAPP_MCP_BINARY.',
        error: http.error,
      }
    }
    if (this.starting) {
      return {
        ...base,
        state: 'starting',
        label: 'Starting WhatsApp bridge',
        detail: 'Launching local whatsmeow daemon...',
      }
    }
    if (!http.ok) {
      return {
        ...base,
        state: 'offline',
        label: 'WhatsApp bridge offline',
        detail: 'Daemon is not responding on 127.0.0.1. Conversations will use webview fallback.',
        error: http.error,
      }
    }
    const hasStore = fs.existsSync(path.join(this.getStoreDir(), 'messages.db'))
    if (!hasStore) {
      return {
        ...base,
        state: 'needs_linking',
        label: 'WhatsApp bridge needs linking',
        detail: 'Open pairing and scan the QR code from WhatsApp linked devices.',
      }
    }
    return {
      ...base,
      state: 'connected',
      label: 'WhatsApp bridge connected',
      detail: summary.lastImportedAt
        ? `Latest bridge message ${formatAgo(summary.lastImportedAt)} ago`
        : 'Bridge store is ready; waiting for messages.',
    }
  }

  importRecentMessages(limit = 2500): { imported: number; scanned: number; error?: string } {
    const dbPath = path.join(this.getStoreDir(), 'messages.db')
    if (!fs.existsSync(dbPath)) return { imported: 0, scanned: 0, error: 'messages.db not found' }

    let handle: Database.Database | null = null
    try {
      handle = new Database(dbPath, { readonly: true, fileMustExist: true })
      const rows = handle
        .prepare(`
          SELECT
            messages.id,
            messages.chat_jid,
            messages.sender,
            messages.content,
            messages.timestamp,
            messages.is_from_me,
            messages.media_type,
            chats.name AS chat_name
          FROM messages
          JOIN chats ON chats.jid = messages.chat_jid
          ORDER BY messages.timestamp DESC
          LIMIT ?
        `)
        .all(limit) as SealjayMessageRow[]

      const inputs: BridgeMessageInput[] = []
      for (const row of rows) {
        const timestampMs = parseTimestamp(row.timestamp)
        if (!timestampMs) continue
        if (!isPersonJid(row.chat_jid)) continue
        const mediaType = row.media_type || null
        inputs.push({
          wa_message_id: row.id,
          chat_id: row.chat_jid,
          chat_kind: 'person',
          chat_name: row.chat_name || null,
          sender: row.sender || null,
          sender_phone: phoneFromJid(row.sender || ''),
          direction: row.is_from_me ? 'outbound' : 'inbound',
          text: row.content || (mediaType ? `[${mediaType}]` : null),
          media_type: mediaType,
          timestamp_ms: timestampMs,
        })
      }
      const imported = upsertBridgeMessages(inputs)
      return { imported, scanned: rows.length }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { imported: 0, scanned: 0, error: message }
    } finally {
      handle?.close()
    }
  }

  private async probeHttp(): Promise<{ ok: boolean; error?: string }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)
    try {
      const res = await fetch(this.getPairUrl(), { signal: controller.signal })
      return { ok: res.status < 500 }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timeout)
    }
  }

  private localSummary(): { lastImportedAt: number | null; importedToday: number } {
    const summary = latestBridgeMessageSummary()
    return { lastImportedAt: summary.timestamp_ms, importedToday: summary.count_today }
  }
}

function formatAgo(timestamp: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
