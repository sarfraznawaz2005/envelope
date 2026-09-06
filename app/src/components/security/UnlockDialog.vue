<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSecurityStore } from '@/stores/security'
import { useSettingsStore } from '@/stores/settings'
import { computed, ref, watch } from 'vue'

const sec = useSecurityStore()
const settings = useSettingsStore()

const dismissed = ref(false)
const open = computed({
  get: () => sec.loaded && sec.needsUnlock && !dismissed.value,
  set: v => {
    if (!v) dismissed.value = true
  },
})
watch(() => sec.needsUnlock, v => {
  if (v) dismissed.value = false
})

const pw = ref('')
const remember = ref(true)
const busy = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await sec.unlock(pw.value, remember.value && settings.values['security.remember'] !== 'never')
    pw.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Unlock Envelope</DialogTitle>
        <DialogDescription>Enter your master password to use your account passwords.</DialogDescription>
      </DialogHeader>
      <form class="space-y-3" @submit.prevent="submit">
        <div class="space-y-1">
          <Label for="unlock-pw">Master password</Label>
          <Input id="unlock-pw" v-model="pw" type="password" autocomplete="current-password" autofocus />
        </div>
        <label v-if="settings.values['security.remember'] !== 'never'" class="flex items-center gap-2 text-sm">
          <Checkbox v-model="remember" />
          {{ settings.values['security.remember'] === '7d' ? 'Remember for 7 days' : 'Remember on this device' }}
        </label>
        <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="ghost" @click="open = false">Later</Button>
          <Button type="submit" :disabled="busy || !pw">Unlock</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
