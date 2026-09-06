<script setup lang="ts">
import SettingsAccounts from '@/components/settings/SettingsAccounts.vue'
import SettingsContacts from '@/components/settings/SettingsContacts.vue'
import SettingsEmpty from '@/components/settings/SettingsEmpty.vue'
import SettingsGeneral from '@/components/settings/SettingsGeneral.vue'
import SettingsImagesHtml from '@/components/settings/SettingsImagesHtml.vue'
import SettingsNotifications from '@/components/settings/SettingsNotifications.vue'
import SettingsRelay from '@/components/settings/SettingsRelay.vue'
import SettingsRules from '@/components/settings/SettingsRules.vue'
import SettingsSecurity from '@/components/settings/SettingsSecurity.vue'
import SettingsSignatures from '@/components/settings/SettingsSignatures.vue'
import SettingsStorage from '@/components/settings/SettingsStorage.vue'
import { useEngine } from '@/engine'
import { useSettingsStore } from '@/stores/settings'
import { cn } from '@/lib/utils'
import { AtSign, Bell, Eraser, Filter, HardDrive, Image, Lock, PenLine, Plug, SlidersHorizontal, Users } from '@lucide/vue'
import { computed, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()
const engine = useEngine()
const settings = useSettingsStore()

const tabs: Array<{ key: string; label: string; icon: Component; comp: Component; props?: Record<string, unknown> }> = [
  { key: 'general', label: 'General', icon: SlidersHorizontal, comp: SettingsGeneral },
  { key: 'accounts', label: 'Accounts', icon: AtSign, comp: SettingsAccounts },
  { key: 'signatures', label: 'Signatures', icon: PenLine, comp: SettingsSignatures },
  { key: 'rules', label: 'Rules', icon: Filter, comp: SettingsRules },
  { key: 'html', label: 'Images & HTML', icon: Image, comp: SettingsImagesHtml },
  { key: 'notifications', label: 'Notifications', icon: Bell, comp: SettingsNotifications },
  { key: 'contacts', label: 'Contacts', icon: Users, comp: SettingsContacts },
  { key: 'storage', label: 'Storage & Backup', icon: HardDrive, comp: SettingsStorage },
  { key: 'empty', label: 'Empty data', icon: Eraser, comp: SettingsEmpty },
  { key: 'relay', label: 'Relay', icon: Plug, comp: SettingsRelay },
  { key: 'security', label: 'Security', icon: Lock, comp: SettingsSecurity },
]

const current = computed(() => tabs.find(t => t.key === route.params.tab) ?? tabs[0]!)
function go(key: string) {
  router.replace({ name: 'settings', params: { tab: key } })
}
</script>

<template>
  <div class="flex-1 flex min-h-0">
    <aside class="w-56 shrink-0 border-r bg-sidebar p-2 text-sm space-y-0.5 overflow-y-auto">
      <button
        v-for="t in tabs" :key="t.key"
        :class="cn('w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-sidebar-accent', current.key === t.key && 'bg-primary/10 text-primary font-medium')"
        @click="go(t.key)"
      >
        <component :is="t.icon" class="size-4" /> {{ t.label }}
      </button>
    </aside>

    <main class="flex-1 overflow-y-auto">
      <div class="max-w-3xl mx-auto px-8 py-8 text-sm">
        <div v-if="!engine.isLeader.value" class="rounded-md border bg-muted px-3 py-2 text-xs mb-4">
          Another tab is running the engine. Settings are read-only here. Close the other tab or use it instead.
        </div>
        <div v-else-if="!settings.loaded" class="text-muted-foreground">Loading settings…</div>
        <component :is="current.comp" v-else v-bind="current.props ?? {}" />
      </div>
    </main>
  </div>
</template>
