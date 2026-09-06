/**
 * Wraps the browser's "Add to home screen" / "Install app" flow
 * (beforeinstallprompt). A tiny module-level singleton so every component
 * that asks sees the same state — the event only fires once per page load.
 */
import { computed, ref } from 'vue'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const deferred = ref<BeforeInstallPromptEvent | null>(null)
const installed = ref(window.matchMedia?.('(display-mode: standalone)').matches ?? false)

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault()
  deferred.value = e as BeforeInstallPromptEvent
})
window.addEventListener('appinstalled', () => {
  deferred.value = null
  installed.value = true
})

export function useInstallPrompt() {
  const canInstall = computed(() => !!deferred.value && !installed.value)
  async function promptInstall() {
    const e = deferred.value
    if (!e) return
    await e.prompt()
    await e.userChoice
    deferred.value = null
  }
  return { canInstall, installed, promptInstall }
}
