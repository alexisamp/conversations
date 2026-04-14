// Minimal .env loader — no external dependency.
// Reads KEY=VALUE pairs and injects them into process.env (only if not already set).

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

function candidatePaths(): string[] {
  if (app.isPackaged) {
    return [path.join(process.resourcesPath, '.env')]
  }
  // In dev, this file lives at dist/electron/supabase/env.js — project root is three levels up.
  return [
    path.join(__dirname, '../../..', '.env'),
    path.join(process.cwd(), '.env'),
  ]
}

export function loadEnvFile(): void {
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue
      const content = fs.readFileSync(p, 'utf8')
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const key = line.slice(0, eq).trim()
        let value = line.slice(eq + 1).trim()
        // Strip surrounding quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        if (process.env[key] === undefined) {
          process.env[key] = value
        }
      }
      return
    } catch (err) {
      console.warn('[env] failed to read', p, err)
    }
  }
  console.warn('[env] no .env file found in:', candidatePaths().join(', '))
}
