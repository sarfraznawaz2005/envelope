/**
 * Settings stored in the `settings` table. Values are JSON.
 * Unknown keys are ignored. Missing keys fall back to SETTINGS_DEFAULTS.
 */
import { SETTINGS_DEFAULTS, type SettingKey, type Settings } from '@/shared/settings'
import { getDb, now } from './db'
import { emit } from './rpc/server'

let cache: Settings | null = null

export async function getAllSettings(): Promise<Settings> {
  if (cache) return cache
  const db = await getDb()
  const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM settings')
  const out: Settings = { ...SETTINGS_DEFAULTS }
  for (const r of rows) {
    if (!(r.key in SETTINGS_DEFAULTS)) continue
    try {
      ;(out as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value)
    } catch {
      /* keep default */
    }
  }
  cache = out
  return out
}

export async function getSetting<K extends SettingKey>(key: K): Promise<Settings[K]> {
  return (await getAllSettings())[key]
}

export async function setSetting<K extends SettingKey>(key: K, value: Settings[K]): Promise<void> {
  if (!(key in SETTINGS_DEFAULTS)) throw new Error(`Unknown setting: ${key}`)
  const db = await getDb()
  await db.exec(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), now()],
  )
  if (cache) cache[key] = value
  emit('settings:changed', { key, value })
}

export function invalidateSettingsCache() {
  cache = null
}
