<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSecurityStore } from '@/stores/security'
import { useSettingsStore } from '@/stores/settings'
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'

const props = defineProps<{ mode: 'set' | 'change' }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ done: [] }>()

const sec = useSecurityStore()
const settings = useSettingsStore()

const oldPw = ref('')
const pw = ref('')
const pw2 = ref('')
const rememberNow = ref(true)
const busy = ref(false)
const error = ref('')

watch(open, v => {
  if (v) {
    oldPw.value = pw.value = pw2.value = ''
    error.value = ''
    rememberNow.value = settings.values['security.remember'] !== 'never'
  }
})

async function submit() {
  error.value = ''
  if (pw.value.length < 8) return (error.value = 'Use at least 8 characters.')
  if (pw.value !== pw2.value) return (error.value = 'The two passwords do not match.')
  busy.value = true
  try {
    if (props.mode === 'set') await sec.setup(pw.value, rememberNow.value)
    else await sec.change(oldPw.value, pw.value)
    open.value = false
    toast.success(props.mode === 'set' ? 'Master password set' : 'Master password changed')
    emit('done')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ mode === 'set' ? 'Set master password' : 'Change master password' }}</DialogTitle>
        <DialogDescription>
          It encrypts your account passwords. There is no reset. If you forget it, you must re-enter your account passwords. Write it down somewhere safe.
        </DialogDescription>
      </DialogHeader>
      <form class="space-y-3" @submit.prevent="submit">
        <div v-if="mode === 'change'" class="space-y-1">
          <Label for="mp-old">Current password</Label>
          <Input id="mp-old" v-model="oldPw" type="password" autocomplete="current-password" />
        </div>
        <div class="space-y-1">
          <Label for="mp-new">{{ mode === 'set' ? 'Password' : 'New password' }}</Label>
          <Input id="mp-new" v-model="pw" type="password" autocomplete="new-password" autofocus />
        </div>
        <div class="space-y-1">
          <Label for="mp-new2">Repeat</Label>
          <Input id="mp-new2" v-model="pw2" type="password" autocomplete="new-password" />
        </div>
        <label v-if="mode === 'set' && settings.values['security.remember'] !== 'never'" class="flex items-center gap-2 text-sm">
          <Checkbox v-model="rememberNow" /> Remember on this device
        </label>
        <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="busy">{{ mode === 'set' ? 'Set password' : 'Change password' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
