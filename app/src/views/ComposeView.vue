<script setup lang="ts">
import MailEditor from '@/components/mail/MailEditor.vue'
import RecipientInput from '@/components/mail/RecipientInput.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useEngine } from '@/engine'
import { buildForwardHtml, buildForwardText, buildReplyQuoteHtml, buildReplyQuoteText, withPrefix } from '@/lib/quote-mail'
import type { ComposeAttachment, MessageAddress, MessageDetail, ReplyMode, Signature } from '@/shared/rpc'
import { useAccountsStore } from '@/stores/accounts'
import { Check, Paperclip, PenLine, Send, Trash2, X } from '@lucide/vue'
import { useTimeAgo } from '@vueuse/core'
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'

const route = useRoute()
const router = useRouter()
const engine = useEngine()
const accounts = useAccountsStore()

const draftId = crypto.randomUUID()
const accountId = ref<number | null>(null)
const to = ref<MessageAddress[]>([])
const cc = ref<MessageAddress[]>([])
const bcc = ref<MessageAddress[]>([])
const showCc = ref(false)
const showBcc = ref(false)
const subject = ref('')
const plainMode = ref(false)
const richHtml = ref('')
const plainText = ref('')
const attachments = ref<Array<ComposeAttachment & { size: number }>>([])
const sending = ref(false)
const ready = ref(false)
const inReplyToId = ref<number | null>(null)
const replyMode = ref<ReplyMode | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const toInput = ref<InstanceType<typeof RecipientInput> | null>(null)
const ccInput = ref<InstanceType<typeof RecipientInput> | null>(null)
const bccInput = ref<InstanceType<typeof RecipientInput> | null>(null)
const mailEditor = ref<InstanceType<typeof MailEditor> | null>(null)
const lastSavedAt = ref<number | null>(null)
const savedAgo = useTimeAgo(() => lastSavedAt.value ?? 0)
const saveError = ref<string | null>(null)
const bootError = ref<string | null>(null)

const account = computed(() => (accountId.value ? accounts.byId.get(accountId.value) : null))

function sigToHtml(sig: Signature): string {
  if (sig.isHtml) return sig.content
  return `<p>${sig.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>')}</p>`
}

async function loadForwardAttachments(original: MessageDetail) {
  let failed = 0
  for (const a of original.attachments) {
    if (a.disposition === 'inline' && a.contentId) continue // already inlined in the forwarded html
    try {
      const { filename, mime, data } = await engine.api.attachmentGet(a.id)
      attachments.value.push({ filename, mime, data: markRaw(data), size: data.byteLength })
    } catch {
      failed++
    }
  }
  // Previously silent — the user would send the forward believing every attachment made it,
  // with no indication one had quietly vanished.
  if (failed) toast.error(`${failed} attachment${failed > 1 ? 's' : ''} could not be loaded and will not be forwarded.`)
}

async function applySignature(bodyHtml: string, bodyText: string): Promise<{ html: string; text: string }> {
  if (!accountId.value) return { html: bodyHtml, text: bodyText }
  const sig = await engine.api.signatureGet(accountId.value)
  if (!sig || !sig.content) return { html: bodyHtml, text: bodyText }
  if (replyMode.value && !sig.useOnReply) return { html: bodyHtml, text: bodyText }
  const sigHtml = sigToHtml(sig)
  const sigText = sig.content
  if (!replyMode.value) return { html: bodyHtml + sigHtml, text: bodyText ? `${bodyText}\n\n${sigText}` : sigText }
  return sig.position === 'above'
    ? { html: sigHtml + bodyHtml, text: `${sigText}\n\n${bodyText}` }
    : { html: bodyHtml + sigHtml, text: `${bodyText}\n\n${sigText}` }
}

async function boot() {
  try {
    await accounts.load()
    const replyId = route.query.reply ? Number(route.query.reply) : null
    const replyAllId = route.query.replyAll ? Number(route.query.replyAll) : null
    const forwardId = route.query.forward ? Number(route.query.forward) : null
    const id = replyId ?? replyAllId ?? forwardId

    if (id != null) {
      const original = await engine.api.messageGet(id)
      accountId.value = original.accountId
      inReplyToId.value = original.id

      if (forwardId != null) {
        replyMode.value = 'forward'
        subject.value = withPrefix(original.subject, 'Fwd')
        const html = buildForwardHtml(original)
        const text = buildForwardText(original)
        const signed = await applySignature(html, text)
        richHtml.value = signed.html
        plainText.value = signed.text
        await loadForwardAttachments(original)
      } else {
        replyMode.value = replyAllId != null ? 'replyAll' : 'reply'
        subject.value = withPrefix(original.subject, 'Re')
        to.value = original.from
        if (replyAllId != null) {
          const mine = account.value?.email.toLowerCase()
          to.value = [...original.from, ...original.to].filter(a => a.address.toLowerCase() !== mine)
          cc.value = original.cc.filter(a => a.address.toLowerCase() !== mine)
          if (cc.value.length) showCc.value = true
        }
        const html = buildReplyQuoteHtml(original)
        const text = buildReplyQuoteText(original)
        const signed = await applySignature(html, text)
        richHtml.value = signed.html
        plainText.value = signed.text
      }
    } else {
      accountId.value = accounts.list.find(a => a.enabled)?.id ?? accounts.list[0]?.id ?? null
      if (typeof route.query.to === 'string' && route.query.to) to.value = [{ name: '', address: route.query.to }]
      const signed = await applySignature('', '')
      richHtml.value = signed.html
      plainText.value = signed.text
    }
    ready.value = true
  } catch (e) {
    // Previously unguarded: a failed messageGet (deleted message, stale reply link, dropped
    // connection) left a blank "New message" form with Send permanently disabled and no
    // explanation why.
    bootError.value = (e as Error).message
    toast.error(`Could not open this message: ${(e as Error).message}`)
  }
}
onMounted(boot)

// ---------- attachments ----------

function onPickFiles(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (files) void addFiles(files)
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files)
}
async function addFiles(files: FileList) {
  for (const f of Array.from(files)) {
    const data = markRaw(new Uint8Array(await f.arrayBuffer()))
    attachments.value.push({ filename: f.name, mime: f.type || 'application/octet-stream', data, size: data.byteLength })
  }
}
function removeAttachment(i: number) {
  attachments.value.splice(i, 1)
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ---------- signature ----------

async function insertSignature() {
  if (!accountId.value) return
  try {
    const sig = await engine.api.signatureGet(accountId.value)
    if (!sig || !sig.content) {
      toast.info('No signature set for this account.')
      return
    }
    if (plainMode.value) {
      plainText.value = plainText.value ? `${plainText.value}\n\n${sig.content}` : sig.content
    } else {
      mailEditor.value?.insertAtEnd(sigToHtml(sig))
    }
  } catch (e) {
    toast.error((e as Error).message)
  }
}

// ---------- autosave ----------

let autosaveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleAutosave() {
  if (!ready.value || !accountId.value) return
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => void autosave(), 2000)
}
async function autosave() {
  if (!accountId.value) return
  try {
    await engine.api.draftSave({
      id: draftId,
      accountId: accountId.value,
      to: to.value,
      cc: cc.value,
      bcc: bcc.value,
      subject: subject.value,
      isHtml: !plainMode.value,
      body: plainMode.value ? plainText.value : richHtml.value,
      inReplyToId: inReplyToId.value,
      replyMode: replyMode.value,
    })
    lastSavedAt.value = Date.now()
    saveError.value = null
  } catch (e) {
    // A silently-swallowed failure here used to leave "Draft saved Xm ago" stuck on a stale
    // timestamp with no hint the draft had stopped saving — someone could close the tab
    // believing their work was safe when it wasn't.
    saveError.value = (e as Error).message
  }
}
watch([to, cc, bcc, subject, richHtml, plainText], scheduleAutosave, { deep: true })
onBeforeUnmount(() => {
  if (autosaveTimer) clearTimeout(autosaveTimer)
})

// ---------- send / discard ----------

async function send() {
  if (!accountId.value) return
  // flush any address still sitting un-committed in a recipient field (typed but no trailing comma/blur yet)
  toInput.value?.commitAll()
  ccInput.value?.commitAll()
  bccInput.value?.commitAll()
  await nextTick()
  if (!to.value.length) {
    toast.error('Add at least one recipient.')
    return
  }
  sending.value = true
  try {
    await engine.api.composeSend({
      accountId: accountId.value,
      to: to.value,
      cc: cc.value,
      bcc: bcc.value,
      subject: subject.value,
      html: plainMode.value ? undefined : richHtml.value,
      text: plainMode.value ? plainText.value : undefined,
      attachments: attachments.value,
      inReplyToId: inReplyToId.value,
    })
    await engine.api.draftDelete(draftId).catch(() => {})
    toast.success('Sent')
    void router.push('/')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    sending.value = false
  }
}
async function discard() {
  await engine.api.draftDelete(draftId).catch(() => {})
  void router.push('/')
}
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0" @dragover.prevent @drop="onDrop">
    <div class="h-10 shrink-0 flex items-center gap-2 px-3 border-b">
      <span class="text-sm font-medium">{{ replyMode === 'forward' ? 'Forward' : replyMode ? 'Reply' : 'New message' }}</span>
      <span v-if="saveError" class="text-xs text-red-600">Draft not saved: {{ saveError }}</span>
      <span v-else-if="lastSavedAt" class="text-xs text-muted-foreground flex items-center gap-1">
        <Check class="size-3" /> Draft saved {{ savedAgo }}
      </span>
      <div class="ml-auto flex items-center gap-3">
        <label class="flex items-center gap-2 text-xs text-muted-foreground"><Switch v-model="plainMode" /> Plain text</label>
        <Button size="sm" variant="ghost" class="gap-1 text-muted-foreground" @click="discard"><Trash2 class="size-4" /> Discard</Button>
        <Button size="sm" class="gap-1" :disabled="sending || !accountId" @click="send"><Send class="size-4" /> Send</Button>
      </div>
    </div>

    <div v-if="bootError" class="flex-1 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
      <p>Could not open this message: {{ bootError }}</p>
      <Button size="sm" variant="outline" @click="() => { bootError = null; boot() }">Retry</Button>
    </div>
    <div v-else-if="!accounts.list.length" class="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      No accounts yet. <RouterLink to="/setup" class="underline ml-1">Add one</RouterLink>.
    </div>
    <div v-else class="flex-1 flex flex-col min-h-0 max-w-3xl w-full mx-auto p-4 gap-2">
      <div class="flex items-center gap-2 border-b py-1.5">
        <span class="text-xs text-muted-foreground w-10 shrink-0">From</span>
        <select v-model="accountId" class="h-8 rounded-md border bg-background px-2 text-sm flex-1" :disabled="!!replyMode">
          <option v-for="a in accounts.list" :key="a.id" :value="a.id">{{ a.name }} &lt;{{ a.email }}&gt;</option>
        </select>
      </div>

      <RecipientInput ref="toInput" v-model="to" label="To" />
      <div class="flex gap-3 -mt-1">
        <button v-if="!showCc" type="button" class="text-xs text-muted-foreground hover:text-foreground" @click="showCc = true">Cc</button>
        <button v-if="!showBcc" type="button" class="text-xs text-muted-foreground hover:text-foreground" @click="showBcc = true">Bcc</button>
      </div>
      <RecipientInput v-if="showCc" ref="ccInput" v-model="cc" label="Cc" />
      <RecipientInput v-if="showBcc" ref="bccInput" v-model="bcc" label="Bcc" />

      <div class="flex items-center gap-2 border-b py-1.5">
        <span class="text-xs text-muted-foreground w-10 shrink-0">Subject</span>
        <Input v-model="subject" class="h-8 border-0 shadow-none px-0 focus-visible:ring-0" placeholder="Subject" />
      </div>

      <div v-if="attachments.length" class="flex flex-wrap gap-2 py-1">
        <span v-for="(a, i) in attachments" :key="i" class="inline-flex items-center gap-2 border rounded-md px-2 py-1 text-xs">
          <Paperclip class="size-3.5 text-muted-foreground" /> {{ a.filename }} <span class="text-muted-foreground">{{ fmtSize(a.size) }}</span>
          <Tooltip>
            <TooltipTrigger as-child>
              <button type="button" class="text-muted-foreground hover:text-foreground" @click="removeAttachment(i)"><X class="size-3.5" /></button>
            </TooltipTrigger>
            <TooltipContent>Remove attachment</TooltipContent>
          </Tooltip>
        </span>
      </div>

      <MailEditor v-if="!plainMode" ref="mailEditor" v-model="richHtml" class="flex-1 min-h-0" />
      <Textarea v-else v-model="plainText" class="flex-1 min-h-[220px] font-mono text-sm resize-none" />

      <div class="flex items-center gap-2 pt-1 shrink-0">
        <input ref="fileInput" type="file" multiple class="hidden" @change="onPickFiles">
        <Button variant="outline" size="sm" class="gap-1" @click="fileInput?.click()"><Paperclip class="size-4" /> Attach files</Button>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" :disabled="!accountId" @click="insertSignature"><PenLine class="size-4" /></Button>
          </TooltipTrigger>
          <TooltipContent>Insert signature</TooltipContent>
        </Tooltip>
        <span class="text-xs text-muted-foreground">or drag files anywhere on this page</span>
      </div>
    </div>
  </div>
</template>
