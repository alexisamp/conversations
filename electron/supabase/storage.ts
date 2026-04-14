// File-based storage adapter for the Supabase JS client.
// Supabase expects a browser-like Storage interface; we persist to a JSON file
// inside the user data directory so sessions survive restarts.

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

type Bag = Record<string, string>

export type SupabaseFileStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function createFileStorage(): SupabaseFileStorage {
  const dir = app.getPath('userData')
  const file = path.join(dir, 'auth-session.json')

  function read(): Bag {
    try {
      if (!fs.existsSync(file)) return {}
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Bag
    } catch {
      return {}
    }
  }

  function write(bag: Bag): void {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(bag, null, 2), 'utf8')
    } catch (err) {
      console.error('[storage] failed to write session:', err)
    }
  }

  return {
    getItem: (key) => {
      const bag = read()
      return bag[key] ?? null
    },
    setItem: (key, value) => {
      const bag = read()
      bag[key] = value
      write(bag)
    },
    removeItem: (key) => {
      const bag = read()
      delete bag[key]
      write(bag)
    },
  }
}
