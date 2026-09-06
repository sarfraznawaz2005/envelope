<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import MailEditor from '@/components/mail/MailEditor.vue'
import { useEngine } from '@/engine'
import { useAccountsStore } from '@/stores/accounts'
import { onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'

const engine = useEngine()
const accounts = useAccountsStore()
const accountId = ref<number | null>(null)
const content = ref('')
const isHtml = ref(true)
const position = ref<'above' | 'below'>('below')
const useOnReply = ref(true)
const saving = ref(false)

async function load() {
  if (!accounts.loaded) await accounts.load()
  accountId.value ??= accounts.list[0]?.id ?? null
  if (!accountId.value) return
  const sig = await engine.api.signatureGet(accountId.value)
  content.value = sig?.content ?? ''
  isHtml.value = sig?.isHtml ?? true
  position.value = sig?.position ?? 'below'
  useOnReply.value = sig?.useOnReply ?? true
}
onMounted(load)
watch(accountId, async id => {
  if (id == null) return
  const sig = await engine.api.signatureGet(id)
  content.value = sig?.content ?? ''
  isHtml.value = sig?.isHtml ?? true
  position.value = sig?.position ?? 'below'
  useOnReply.value = sig?.useOnReply ?? true
})

async function save() {
  if (!accountId.value) return
  saving.value = true
  try {
    await engine.api.signatureSet(accountId.value, { isHtml: isHtml.value, content: content.value, position: position.value, useOnReply: useOnReply.value })
    toast.success('Signature saved')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-2xl font-semibold">Signatures</h1>
    <p class="text-sm text-muted-foreground">One signature per account, inserted automatically when you compose.</p>

    <div v-if="!accounts.list.length" class="text-sm text-muted-foreground">No accounts yet.</div>
    <template v-else>
      <div class="flex items-center gap-3">
        <select v-model="accountId" class="h-9 rounded-md border bg-background px-2 text-sm">
          <option v-for="a in accounts.list" :key="a.id" :value="a.id">{{ a.name }} ({{ a.email }})</option>
        </select>
        <label class="ml-auto flex items-center gap-1.5 text-xs"><Checkbox v-model="isHtml" /> Rich text (HTML)</label>
      </div>

      <MailEditor v-if="isHtml" v-model="content" />
      <Textarea v-else v-model="content" rows="6" placeholder="e.g.&#10;Jane Doe&#10;Product Manager, Acme Corp" class="font-mono text-sm" />

      <div class="flex items-center gap-6 text-sm">
        <RadioGroup v-model="position" class="flex items-center gap-4">
          <label class="flex items-center gap-2"><RadioGroupItem value="above" /> Above quoted text</label>
          <label class="flex items-center gap-2"><RadioGroupItem value="below" /> Below quoted text</label>
        </RadioGroup>
        <label class="flex items-center gap-2"><Checkbox v-model="useOnReply" /> Include on replies</label>
      </div>

      <Button :disabled="saving" @click="save">Save signature</Button>
    </template>
  </div>
</template>
