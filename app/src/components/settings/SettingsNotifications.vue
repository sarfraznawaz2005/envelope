<script setup lang="ts">
import SettingRow from './SettingRow.vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAccountsStore } from '@/stores/accounts'
import { useSetting } from '@/stores/settings'
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'

const desktop = useSetting('notify.desktop')
const sound = useSetting('notify.sound')
const title = useSetting('notify.title')
const toastOn = useSetting('notify.toast')
const inboxOnly = useSetting('notify.inboxOnly')

const perm = ref<NotificationPermission>(typeof Notification !== 'undefined' ? Notification.permission : 'denied')
const permLabel = computed(() => ({ granted: 'Browser permission granted.', denied: 'Browser permission denied. Change it in the site settings of your browser.', default: 'Browser permission not asked yet.' })[perm.value])

async function ask() {
  perm.value = await Notification.requestPermission()
}
function test() {
  if (perm.value !== 'granted') return toast.error('Permission not granted')
  new Notification('Envelope', { body: 'This is a test notification.' })
}

// ---------- per-account notify on/off + POP3 poll interval ----------
const accounts = useAccountsStore()
onMounted(() => {
  if (!accounts.loaded) void accounts.load()
})
async function setNotify(id: number, notify: boolean) {
  const a = accounts.byId.get(id)
  if (!a) return
  await accounts.save({ ...a, notify })
}
async function setPollMinutes(id: number, pollMinutes: number) {
  const a = accounts.byId.get(id)
  if (!a) return
  await accounts.save({ ...a, pollMinutes })
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold mb-4">Notifications</h1>

    <div class="rounded-md border px-3 py-2 text-xs flex items-center gap-3 mb-4" :class="perm === 'granted' ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900' : 'bg-muted'">
      <span>{{ permLabel }}</span>
      <span class="ml-auto flex gap-2">
        <Button v-if="perm !== 'granted'" size="sm" variant="outline" @click="ask">Ask for permission</Button>
        <Button v-else size="sm" variant="outline" @click="test">Send test</Button>
      </span>
    </div>

    <SettingRow label="Desktop notification for new mail" description="Needs the browser permission above. The app tab must stay open.">
      <Switch v-model="desktop" />
    </SettingRow>
    <SettingRow label="Play a sound"><Switch v-model="sound" /></SettingRow>
    <SettingRow label="Show unread count in the tab title"><Switch v-model="title" /></SettingRow>
    <SettingRow label="Show an in-app toast"><Switch v-model="toastOn" /></SettingRow>
    <SettingRow label="Only for Inbox" description="Skip mail that a rule moved somewhere else."><Switch v-model="inboxOnly" /></SettingRow>

    <div v-if="accounts.list.length" class="rounded-lg border divide-y mt-2">
      <div v-for="a in accounts.list" :key="a.id" class="flex items-center px-3 py-2 text-sm gap-3">
        <span>{{ a.name }}</span>
        <span class="ml-auto text-xs text-muted-foreground flex items-center gap-1.5">
          <template v-if="a.kind === 'imap'">IMAP IDLE (instant)</template>
          <template v-else>
            POP3 · check every
            <Select :model-value="String(a.pollMinutes)" @update:model-value="v => setPollMinutes(a.id, Number(v))">
              <SelectTrigger class="h-7 w-20"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 min</SelectItem>
                <SelectItem value="5">5 min</SelectItem>
                <SelectItem value="15">15 min</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </span>
        <Switch :model-value="a.notify" @update:model-value="v => setNotify(a.id, v)" />
      </div>
    </div>
  </div>
</template>
