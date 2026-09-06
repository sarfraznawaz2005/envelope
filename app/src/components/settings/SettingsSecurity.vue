<script setup lang="ts">
import SettingRow from './SettingRow.vue'
import MasterPasswordDialog from '@/components/security/MasterPasswordDialog.vue'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSecurityStore } from '@/stores/security'
import { useSetting } from '@/stores/settings'
import { Info } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'

const sec = useSecurityStore()
const remember = useSetting('security.remember')
const idle = useSetting('security.idleLockMin')
const idleStr = computed({ get: () => String(idle.value), set: v => (idle.value = Number(v)) })

const open = ref(false)
const mode = ref<'set' | 'change'>('set')
function show(m: 'set' | 'change') {
  mode.value = m
  open.value = true
}

async function lockNow() {
  await sec.lock()
  toast.success('Locked')
}
async function forget() {
  await sec.forgetDevice()
  toast.success('This device will ask for the password next time')
}
const expires = computed(() => (sec.status.rememberExpiresAt ? new Date(sec.status.rememberExpiresAt).toLocaleString() : null))
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold mb-4">Security</h1>

    <SettingRow label="Master password" description="Encrypts account passwords and the backup file. Nothing leaves the browser.">
      <div class="flex items-center gap-2">
        <span class="text-xs text-muted-foreground">
          <template v-if="!sec.status.hasPassword">Not set</template>
          <template v-else-if="sec.status.unlocked">Unlocked<template v-if="sec.status.remembered"> · remembered</template></template>
          <template v-else>Locked</template>
        </span>
        <Button v-if="!sec.status.hasPassword" size="sm" @click="show('set')">Set…</Button>
        <Button v-else size="sm" variant="outline" @click="show('change')">Change…</Button>
      </div>
    </SettingRow>

    <SettingRow label="Ask for the master password">
      <template #description>
        <span class="inline-flex items-center gap-1">
          How often the app asks when it opens.
          <Tooltip>
            <TooltipTrigger as-child><Info class="size-3 cursor-help" /></TooltipTrigger>
            <TooltipContent class="max-w-64">
              <div class="font-medium">What "remember" means</div>
              <div class="text-xs opacity-80">The unlock key is kept in this browser profile only — it never leaves the device. "Every time" is safest on a shared computer. "Remember on this device" is least safe if someone else can use this browser profile.</div>
            </TooltipContent>
          </Tooltip>
        </span>
      </template>
      <Select v-model="remember">
        <SelectTrigger class="w-52"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="never">Every time</SelectItem>
          <SelectItem value="7d">Remember for 7 days</SelectItem>
          <SelectItem value="always">Remember on this device</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>

    <SettingRow label="Lock after idle" description="Re-asks for the master password after this much inactivity.">
      <Select v-model="idleStr">
        <SelectTrigger class="w-52"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="0">Never</SelectItem>
          <SelectItem value="15">15 minutes</SelectItem>
          <SelectItem value="60">1 hour</SelectItem>
          <SelectItem value="480">8 hours</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>

    <SettingRow v-if="sec.status.hasPassword" label="This session">
      <template #description>
        <template v-if="sec.status.remembered">Remembered on this device<template v-if="expires"> until {{ expires }}</template>.</template>
        <template v-else>Not remembered on this device.</template>
      </template>
      <div class="flex gap-2">
        <Button v-if="sec.status.remembered" size="sm" variant="outline" @click="forget">Forget device</Button>
        <Button v-if="sec.status.unlocked" size="sm" variant="outline" @click="lockNow">Lock now</Button>
      </div>
    </SettingRow>

    <MasterPasswordDialog v-model:open="open" :mode="mode" />
  </div>
</template>
