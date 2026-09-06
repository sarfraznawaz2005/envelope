<script setup lang="ts">
import AppHeader from '@/components/layout/AppHeader.vue'
import UnlockDialog from '@/components/security/UnlockDialog.vue'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useEngine } from '@/engine'
import { useDiskBackup } from '@/lib/disk-backup'
import { useMailNotify } from '@/lib/mail-notify'
import { useMailStore } from '@/stores/mail'
import { useSecurityStore } from '@/stores/security'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { ref, watch } from 'vue'

// boot theme + engine as early as possible
useUiStore()
const engine = useEngine()
const settings = useSettingsStore()
const security = useSecurityStore()
const mail = useMailStore()

// A failure anywhere in this chain (most likely: the database failed to open) used to leave
// the app on a blank screen with no error and no way to recover short of the user guessing to
// reload — nothing here was wrapped in try/catch, and the worker still emits "engine:ready"
// even when its own boot failed.
const bootError = ref<string | null>(null)
function reload() {
  window.location.reload()
}

// once the worker is up: load settings + security state, then wire live events
watch(
  () => engine.ready.value,
  async ready => {
    if (!ready) return
    try {
      if (engine.storage.value === 'none') throw new Error('The local database could not be opened.')
      await Promise.all([settings.load(), security.refresh()])
      engine.on('settings:changed', e => settings.applyRemote(e.key, e.value))
      engine.on('security:status', s => security.apply(s))
      useDiskBackup() // starts the auto-save timer if configured
      useMailNotify() // desktop notifications + unread count in the tab title
      mail.wireEvents()
      await mail.loadAllFolders()
      await mail.loadMessages()
    } catch (e) {
      bootError.value = (e as Error).message
      console.error('[app boot]', e)
    }
  },
  { immediate: true },
)
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div class="h-dvh flex flex-col overflow-hidden bg-background text-foreground">
      <AppHeader />
      <main class="flex-1 min-h-0 flex">
        <div v-if="bootError" class="m-auto max-w-sm text-center space-y-3 p-6">
          <p class="text-sm font-medium">Envelope could not start</p>
          <p class="text-sm text-muted-foreground">{{ bootError }}</p>
          <Button size="sm" @click="reload">Reload</Button>
        </div>
        <RouterView v-else />
      </main>
    </div>
    <UnlockDialog />
    <Toaster rich-colors close-button />
  </TooltipProvider>
</template>
