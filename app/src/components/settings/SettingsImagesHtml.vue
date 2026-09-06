<script setup lang="ts">
import SettingRow from './SettingRow.vue'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useEngine } from '@/engine'
import { useSetting } from '@/stores/settings'
import { X } from '@lucide/vue'
import { onMounted, ref } from 'vue'

const engine = useEngine()
const policy = useSetting('images.policy')
const htmlEnabled = useSetting('html.enabled')
const styleTags = useSetting('html.allowStyleTags')
const externalCss = useSetting('html.allowExternalCss')
const warnLinks = useSetting('html.warnLinks')

// ---------- always-allow senders ----------
const allowed = ref<string[]>([])
const newSender = ref('')
async function loadAllowed() {
  allowed.value = await engine.api.imagesListAllowed()
}
onMounted(loadAllowed)
async function addSender() {
  const v = newSender.value.trim().toLowerCase()
  if (!v) return
  await engine.api.imagesAllowSender(v)
  newSender.value = ''
  await loadAllowed()
}
async function removeSender(pattern: string) {
  await engine.api.imagesRemoveSender(pattern)
  await loadAllowed()
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold mb-4">Images &amp; HTML</h1>

    <h2 class="font-medium mt-2 mb-1">External images</h2>
    <p class="text-xs text-muted-foreground mb-3">Remote images can tell the sender when you open a mail. Images attached to the mail always show.</p>
    <RadioGroup v-model="policy" class="space-y-2 mb-6">
      <div class="flex items-start gap-2">
        <RadioGroupItem id="img-never" value="never" class="mt-0.5" />
        <Label for="img-never" class="flex flex-col gap-0.5 font-normal"><b>Never load</b><span class="text-xs text-muted-foreground">Show a "Load images" button on each mail.</span></Label>
      </div>
      <div class="flex items-start gap-2">
        <RadioGroupItem id="img-ask" value="ask" class="mt-0.5" />
        <Label for="img-ask" class="flex flex-col gap-0.5 font-normal"><b>Ask</b><span class="text-xs text-muted-foreground">Block, but remember "always for this sender". Recommended.</span></Label>
      </div>
      <div class="flex items-start gap-2">
        <RadioGroupItem id="img-always" value="always" class="mt-0.5" />
        <Label for="img-always" class="flex flex-col gap-0.5 font-normal"><b>Always load</b><span class="text-xs text-muted-foreground">Least private.</span></Label>
      </div>
    </RadioGroup>

    <div class="rounded-lg border p-3 mb-6">
      <div class="text-xs font-medium mb-2 flex items-center gap-1.5">
        Always load images from these senders
        <Tooltip>
          <TooltipTrigger as-child><span class="text-muted-foreground cursor-help">(?)</span></TooltipTrigger>
          <TooltipContent>Matches the exact sender address, or the whole domain if you enter just a domain (e.g. "stripe.com"). Also grows when you click "Load images" on a mail and choose "always for this sender".</TooltipContent>
        </Tooltip>
      </div>
      <div class="flex flex-wrap gap-1.5 items-center">
        <Badge v-for="p in allowed" :key="p" variant="secondary" class="gap-1">
          {{ p }}
          <button type="button" class="text-muted-foreground hover:text-foreground" @click="removeSender(p)"><X class="size-3" /></button>
        </Badge>
        <span v-if="!allowed.length" class="text-xs text-muted-foreground">None yet.</span>
        <input
          v-model="newSender"
          type="text"
          placeholder="add sender or domain…"
          class="text-xs h-6 px-2 rounded-full border border-dashed bg-transparent w-48 focus:outline-none focus:ring-1 focus:ring-ring"
          @keydown.enter.prevent="addSender"
        >
      </div>
    </div>

    <h2 class="font-medium mb-1">HTML mail</h2>
    <SettingRow label="Show HTML mail" description="Off = show the plain-text part only.">
      <Switch v-model="htmlEnabled" />
    </SettingRow>
    <SettingRow label="Allow <style> blocks">
      <template #description>
        On = mails look as designed. Off = safer and plainer. Inline <code>style=""</code> is always kept. Scripts are always removed.
      </template>
      <Switch v-model="styleTags" />
    </SettingRow>
    <SettingRow label="Allow external fonts and CSS files" description="These are network requests to the sender. Off is safer.">
      <Switch v-model="externalCss" />
    </SettingRow>
    <SettingRow label="Warn on misleading links" description="Open links in a new tab and warn when the link text does not match where it goes.">
      <Switch v-model="warnLinks" />
    </SettingRow>
  </div>
</template>
