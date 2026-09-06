/**
 * UI-only state: theme, density, panel sizes. Nothing here touches mail data.
 * Persisted to localStorage so it works before the DB is open.
 */
import { useLocalStorage, usePreferredDark } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, watchEffect } from 'vue'

export type Theme = 'system' | 'light' | 'dark'

export const useUiStore = defineStore('ui', () => {
  const theme = useLocalStorage<Theme>('mc.theme', 'system')
  const density = useLocalStorage<'comfortable' | 'compact'>('mc.density', 'comfortable')
  // null = not manually resized yet — the sidebar sizes itself to fit its content (account/folder
  // names) instead of a fixed pixel guess. Becomes a real pixel value the first time it's dragged.
  const sidebarWidth = useLocalStorage<number | null>('mc.sidebarWidth', null)
  const sidebarCollapsed = useLocalStorage('mc.sidebarCollapsed', false)
  const listWidth = useLocalStorage('mc.listWidth', 380)

  const prefersDark = usePreferredDark()
  const isDark = computed(() => (theme.value === 'system' ? prefersDark.value : theme.value === 'dark'))

  watchEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', isDark.value)
    root.style.colorScheme = isDark.value ? 'dark' : 'light'
  })

  function cycleTheme() {
    theme.value = theme.value === 'system' ? 'light' : theme.value === 'light' ? 'dark' : 'system'
  }

  return { theme, density, isDark, cycleTheme, sidebarWidth, sidebarCollapsed, listWidth }
})
