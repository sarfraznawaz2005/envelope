/**
 * Settings that live in the database. Loaded once the engine is ready.
 * Writes go straight through to the engine; the local copy updates first.
 */
import { useEngine } from '@/engine'
import { SETTINGS_DEFAULTS, type SettingKey, type Settings } from '@/shared/settings'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'

export const useSettingsStore = defineStore('settings', () => {
  const values = ref<Settings>({ ...SETTINGS_DEFAULTS })
  const loaded = ref(false)

  async function load() {
    const engine = useEngine()
    values.value = await engine.api.settingsGetAll()
    loaded.value = true
  }

  async function set<K extends SettingKey>(key: K, value: Settings[K]) {
    const previous = values.value[key]
    values.value[key] = value
    const engine = useEngine()
    try {
      await engine.api.settingsSet(key, value)
    } catch (e) {
      // Undo the optimistic write and say so — otherwise a toggle could show "on" in the UI
      // forever while the engine never actually got the change.
      values.value[key] = previous
      toast.error(`Could not save setting: ${(e as Error).message}`)
      throw e
    }
  }

  /** Apply a change that came from the engine (another tab, an import). */
  function applyRemote(key: SettingKey, value: unknown) {
    ;(values.value as unknown as Record<string, unknown>)[key] = value
  }

  return { values, loaded, load, set, applyRemote }
})

/** v-model-able ref for one setting. */
export function useSetting<K extends SettingKey>(key: K) {
  const s = useSettingsStore()
  return computed<Settings[K]>({
    get: () => s.values[key],
    set: v => {
      // set() already surfaces failures via toast and rolls back the optimistic write; this
      // just needs to keep that rejection from becoming an unhandled promise rejection.
      s.set(key, v).catch(() => {})
    },
  })
}
