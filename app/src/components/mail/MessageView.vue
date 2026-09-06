<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useEngine } from '@/engine'
import { avatarColor, avatarInitials } from '@/lib/avatar'
import { sanitizeMailHtml, unblockImages } from '@/lib/sanitize-mail'
import type { MessageAttachment } from '@/shared/rpc'
import { useAccountsStore } from '@/stores/accounts'
import { useMailStore } from '@/stores/mail'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import {
  Archive,
  ChevronDown,
  ChevronUp,
  Code,
  Download,
  File,
  FileSpreadsheet,
  FileText,
  Flag,
  FolderInput,
  ImageOff,
  Mail,
  MailOpen,
  Printer,
  Reply,
  ReplyAll,
  Forward,
  ShieldAlert,
  Trash2,
  UserCheck,
  UserPlus,
} from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'

const mail = useMailStore()
const accounts = useAccountsStore()
const settings = useSettingsStore()
const ui = useUiStore()
const engine = useEngine()

const currentFolderName = computed(() => mail.detail && (mail.foldersByAccount[mail.detail.accountId] ?? []).find(f => f.id === mail.detail!.folderId)?.name)
const currentAccountName = computed(() => mail.detail && accounts.byId.get(mail.detail.accountId)?.name)

// ---------- images + html rendering ----------

const imagesForceAllowed = ref(false)
const senderAllowed = ref(false)
const bodyFrame = ref<HTMLIFrameElement | null>(null)
const frameHeight = ref(120)

watch(
  () => mail.detail?.id,
  async id => {
    imagesForceAllowed.value = false
    senderAllowed.value = false
    frameHeight.value = 120
    const addr = mail.detail?.from[0]?.address
    if (addr && id != null) senderAllowed.value = await engine.api.imagesIsSenderAllowed(addr).catch(() => false)
  },
)

const allowImages = computed(() => settings.values['images.policy'] === 'always' || senderAllowed.value || imagesForceAllowed.value)

// `allowImages` starts false and can flip true asynchronously (the "is this sender allowed?" check
// above), sometimes before the iframe even finishes its first load, sometimes after. Re-pointing an
// already-loaded sandboxed iframe's `srcdoc` at new content doesn't reliably reload it in Chrome, so
// baking `allowImages` into the sanitized HTML (and relying on srcdoc reactivity to show it) silently
// never displays the images in that case — even though the sender genuinely is on the always-allow
// list. Fix: the srcdoc is always generated with images blocked (stable per message, see `sanitized`
// below), and unblocking always happens by patching the live DOM directly — this function runs both
// right after the frame loads and whenever `allowImages` later turns true, exactly like the "Load
// images" button already does.
function revealImagesIfAllowed() {
  if (!allowImages.value) return
  const doc = bodyFrame.value?.contentDocument
  if (!doc?.body) return
  unblockImages(doc.body)
  frameHeight.value = Math.min(6000, doc.documentElement.scrollHeight + 16)
}
watch(allowImages, revealImagesIfAllowed)

// ---------- add to contacts ----------

const contactExists = ref(false)
watch(
  () => mail.detail?.id,
  async id => {
    contactExists.value = false
    const addr = mail.detail?.from[0]?.address
    if (addr && id != null) contactExists.value = !!(await engine.api.contactFindByEmail(addr).catch(() => null))
  },
)
async function addToContacts() {
  const from = mail.detail?.from[0]
  if (!from) return
  const name = (from.name || from.address).trim()
  const parts = name.split(/\s+/)
  try {
    await engine.api.contactSave({
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' '),
      phone: '',
      notes: '',
      emails: [{ email: from.address, label: 'work', isPrimary: true }],
      groups: [],
    })
    contactExists.value = true
    toast.success('Added to contacts')
  } catch (e) {
    toast.error((e as Error).message)
  }
}
const showHtml = computed(() => settings.values['html.enabled'] && !!mail.detail?.html)

const sanitized = computed(() => {
  if (!showHtml.value || !mail.detail?.html) return null
  // Always sanitize with images blocked, regardless of `allowImages` — see the comment on
  // `revealImagesIfAllowed` above for why. `hadBlockedImages` still correctly reflects whether the
  // mail has any remote images at all, which is all the "images blocked" bar needs.
  return sanitizeMailHtml(mail.detail.html, { allowStyleTags: settings.values['html.allowStyleTags'], allowImages: false })
})

const frameDoc = computed(() => {
  if (!sanitized.value) return ''
  const color = ui.isDark ? '#e2e8f0' : '#0f172a'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.6;margin:0;padding:0;color:${color};background:transparent;word-wrap:break-word;overflow-wrap:anywhere}
    img{max-width:100%;height:auto} table{max-width:100%}
  </style></head><body>${sanitized.value.html}</body></html>`
})

function onFrameLoad() {
  const doc = bodyFrame.value?.contentDocument
  if (!doc) return
  frameHeight.value = Math.min(6000, doc.documentElement.scrollHeight + 16)
  revealImagesIfAllowed()
}

async function loadImagesNow() {
  imagesForceAllowed.value = true
  await new Promise(r => setTimeout(r, 0)) // let the sandboxed frame re-render with images allowed
  const doc = bodyFrame.value?.contentDocument
  if (doc?.body) unblockImages(doc.body)
  if (doc) frameHeight.value = Math.min(6000, doc.documentElement.scrollHeight + 16)
}
async function alwaysAllowSender() {
  const addr = mail.detail?.from[0]?.address
  if (!addr) return
  try {
    await engine.api.imagesAllowSender(addr)
    senderAllowed.value = true
    await loadImagesNow()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

function escapeHtml(s: string): string {
  // Quotes MUST be escaped too, not just <, >, & — escapeHtml runs before the URL is
  // dropped into href="...", so leaving a raw " in place lets an email body like
  // `https://x/"onmouseover="alert(1)` break out of the attribute and inject markup.
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function linkify(s: string): string {
  return escapeHtml(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="underline">$1</a>')
}
const plainHtml = computed(() => (mail.detail?.text ? linkify(mail.detail.text) : ''))

// ---------- mark read after the configured delay ----------

let markTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => mail.detail?.id,
  id => {
    if (markTimer) clearTimeout(markTimer)
    if (id == null || mail.detail?.seen) return
    const delayMs = settings.values['mail.markReadDelay']
    if (delayMs < 0) return
    markTimer = setTimeout(() => {
      // Background/automatic — a toast here would fire every time the network hiccups while
      // reading mail, but a truly unhandled rejection is still worth avoiding.
      if (mail.detail?.id === id) mail.setFlag(id, 'seen', true).catch(e => console.warn('[mark read]', (e as Error).message))
    }, delayMs)
  },
)

// ---------- actions ----------

async function guarded(fn: () => Promise<void>) {
  try {
    await fn()
  } catch (e) {
    toast.error((e as Error).message)
  }
}
const doArchive = () => mail.detail && guarded(() => mail.archive(mail.detail!.id))
const doSpam = () => mail.detail && guarded(() => mail.spam(mail.detail!.id))
const doDelete = () => mail.detail && guarded(() => mail.remove(mail.detail!.id))
const toggleUnread = () => mail.detail && guarded(() => mail.setFlag(mail.detail!.id, 'seen', !mail.detail!.seen))
const toggleFlag = () => mail.detail && guarded(() => mail.setFlag(mail.detail!.id, 'flagged', !mail.detail!.flagged))
const moveToFolder = (destId: number) => mail.detail && guarded(() => mail.moveTo(mail.detail!.id, destId))
function doPrint() {
  window.print()
}

// Newest message first, oldest last — flex `order` on each thread card/box, so the currently
// open message (which can be any message in the thread, not just the latest) lands in the
// right spot instead of always rendering last.
const threadRank = computed(() => {
  const sorted = [...mail.thread].sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
  return new Map(sorted.map((m, i) => [m.id, i]))
})
function threadOrder(id: number): number {
  return threadRank.value.get(id) ?? 0
}

const moveTargets = computed(() => {
  if (!mail.detail) return []
  return (mail.foldersByAccount[mail.detail.accountId] ?? []).filter(f => f.id !== mail.detail!.folderId && f.selectable)
})

// ---------- attachments ----------

const ATT_ICON: Record<string, typeof File> = { pdf: FileText, xlsx: FileSpreadsheet, xls: FileSpreadsheet, csv: FileSpreadsheet }
function iconFor(a: MessageAttachment) {
  const ext = a.filename.split('.').pop()?.toLowerCase() ?? ''
  return ATT_ICON[ext] ?? File
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
async function download(a: MessageAttachment) {
  try {
    const { filename, mime, data } = await engine.api.attachmentGet(a.id)
    const blob = new Blob([data as BlobPart], { type: mime })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename || 'attachment'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  } catch (e) {
    toast.error((e as Error).message)
  }
}

// ---------- view source ----------

const sourceOpen = ref(false)
const sourceText = ref('')
async function viewSource() {
  if (!mail.detail) return
  try {
    sourceText.value = await engine.api.messageGetSource(mail.detail.id)
    sourceOpen.value = true
  } catch (e) {
    toast.error((e as Error).message)
  }
}

function fmtDate(ms: number | null): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}
function addrLine(list: { name: string; address: string }[]): string {
  return list.map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')
}
</script>

<template>
  <main class="flex flex-col min-w-0 min-h-0">
    <div v-if="!mail.detail && !mail.loadingDetail" class="flex-1 flex items-center justify-center text-muted-foreground text-sm">Select a message</div>
    <div v-else-if="mail.loadingDetail" class="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>
    <div v-else-if="mail.detail" class="flex-1 flex flex-col min-h-0">
      <div class="h-10 shrink-0 flex items-center gap-1 px-3 border-b text-muted-foreground">
        <Tooltip><TooltipTrigger as-child><Button size="icon" variant="ghost" @click="doArchive"><Archive class="size-4" /></Button></TooltipTrigger><TooltipContent>Archive</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger as-child><Button size="icon" variant="ghost" @click="doSpam"><ShieldAlert class="size-4" /></Button></TooltipTrigger><TooltipContent>Spam</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger as-child><Button size="icon" variant="ghost" @click="doDelete"><Trash2 class="size-4" /></Button></TooltipTrigger><TooltipContent>Delete</TooltipContent></Tooltip>
        <span class="w-px h-5 bg-border mx-1" />
        <DropdownMenu v-if="moveTargets.length">
          <Tooltip>
            <TooltipTrigger as-child>
              <DropdownMenuTrigger as-child>
                <Button size="icon" variant="ghost"><FolderInput class="size-4" /></Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Move to</TooltipContent>
          </Tooltip>
          <DropdownMenuContent>
            <DropdownMenuItem v-for="f in moveTargets" :key="f.id" @click="moveToFolder(f.id)">{{ f.name }}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger as-child><Button size="icon" variant="ghost" @click="toggleUnread"><component :is="mail.detail.seen ? Mail : MailOpen" class="size-4" /></Button></TooltipTrigger>
          <TooltipContent>{{ mail.detail.seen ? 'Mark unread' : 'Mark read' }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child><Button size="icon" variant="ghost" @click="toggleFlag"><Flag class="size-4" :class="mail.detail.flagged ? 'fill-amber-500 text-amber-500' : ''" /></Button></TooltipTrigger>
          <TooltipContent>Flag</TooltipContent>
        </Tooltip>
        <span class="w-px h-5 bg-border mx-1" />
        <Tooltip><TooltipTrigger as-child><Button size="icon" variant="ghost" @click="doPrint"><Printer class="size-4" /></Button></TooltipTrigger><TooltipContent>Print</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger as-child><Button size="icon" variant="ghost" @click="viewSource"><Code class="size-4" /></Button></TooltipTrigger><TooltipContent>View source</TooltipContent></Tooltip>
        <div class="ml-auto flex items-center gap-1">
          <Tooltip><TooltipTrigger as-child><Button size="icon" variant="ghost" @click="mail.openAdjacent(-1)"><ChevronUp class="size-4" /></Button></TooltipTrigger><TooltipContent>Previous (k)</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger as-child><Button size="icon" variant="ghost" @click="mail.openAdjacent(1)"><ChevronDown class="size-4" /></Button></TooltipTrigger><TooltipContent>Next (j)</TooltipContent></Tooltip>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto">
        <div class="max-w-[min(98%,1400px)] mx-auto px-4 py-5">
          <h1 class="text-xl font-semibold mb-1">{{ mail.detail.subject || '(no subject)' }}</h1>
          <div class="text-xs text-muted-foreground mb-4 flex items-center gap-2 flex-wrap">
            <span v-if="currentFolderName" class="bg-muted rounded px-1.5 py-0.5">{{ currentFolderName }}</span>
            <span v-if="currentAccountName" class="bg-muted rounded px-1.5 py-0.5">{{ currentAccountName }}</span>
            <span v-if="mail.thread.length > 1">· {{ mail.thread.length }} messages in thread</span>
          </div>

          <div class="flex flex-col gap-2">
            <button
              v-for="m in mail.thread.filter(t => t.id !== mail.detail!.id)"
              :key="m.id"
              :style="{ order: threadOrder(m.id) }"
              class="w-full border rounded-lg px-4 py-2 flex items-center gap-3 text-sm text-muted-foreground hover:bg-muted/60 text-left"
              @click="mail.openMessage(m.id)"
            >
              <div class="size-7 rounded-full text-white flex items-center justify-center text-[10px] font-bold shrink-0" :class="avatarColor(m.from)">{{ avatarInitials(m.from) }}</div>
              <div class="flex-1 truncate"><span class="text-foreground font-medium">{{ m.from }}</span> — {{ m.subject }}</div>
            </button>

          <div class="border rounded-lg" :style="{ order: threadOrder(mail.detail.id) }">
            <div class="px-4 py-3 flex items-start gap-3">
              <div class="size-10 rounded-full text-white flex items-center justify-center text-sm font-bold shrink-0" :class="avatarColor(addrLine(mail.detail.from))">{{ avatarInitials(addrLine(mail.detail.from)) }}</div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-semibold">{{ mail.detail.from[0]?.name || mail.detail.from[0]?.address }}</span>
                  <span class="text-muted-foreground text-sm">&lt;{{ mail.detail.from[0]?.address }}&gt;</span>
                </div>
                <div class="text-xs text-muted-foreground mt-0.5">to {{ addrLine(mail.detail.to) }}<span v-if="mail.detail.cc.length"> · cc: {{ addrLine(mail.detail.cc) }}</span></div>
              </div>
              <div class="flex flex-col items-end gap-1.5 shrink-0">
                <div class="text-xs text-muted-foreground whitespace-nowrap">{{ fmtDate(mail.detail.date) }}</div>
                <Tooltip v-if="settings.values['contacts.showAddButton']">
                  <TooltipTrigger as-child>
                    <Button size="icon" variant="ghost" class="size-7" :class="contactExists ? 'text-primary' : 'text-muted-foreground'" :disabled="contactExists" @click="addToContacts">
                      <component :is="contactExists ? UserCheck : UserPlus" class="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ contactExists ? 'Already in contacts' : 'Add to contacts' }}</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div v-if="showHtml && sanitized?.hadBlockedImages && !allowImages" class="mx-4 mb-3 rounded-md bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-xs px-3 py-2 flex items-center gap-2 flex-wrap">
              <ImageOff class="size-4 shrink-0" />
              <span>External images are blocked to protect your privacy.</span>
              <button class="ml-auto underline font-medium" @click="loadImagesNow">Load images</button>
              <button class="underline" @click="alwaysAllowSender">Always load from this sender</button>
            </div>

            <div v-if="mail.detail.attachments.length" class="mx-4 mb-3 flex gap-2 flex-wrap">
              <button
                v-for="a in mail.detail.attachments.filter(x => x.disposition !== 'inline')"
                :key="a.id"
                class="flex items-center gap-2 border rounded-md px-2.5 py-1.5 text-xs hover:bg-muted/60"
                @click="download(a)"
              >
                <component :is="iconFor(a)" class="size-4 text-muted-foreground" />
                {{ a.filename || 'attachment' }} <span class="text-muted-foreground">{{ fmtSize(a.size) }}</span>
                <Download class="size-3.5 text-muted-foreground" />
              </button>
            </div>

            <div class="px-4 pb-5">
              <iframe
                v-if="showHtml"
                ref="bodyFrame"
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                class="w-full border-0"
                :style="{ height: frameHeight + 'px' }"
                :srcdoc="frameDoc"
                @load="onFrameLoad"
              />
              <div v-else-if="mail.detail.text" class="text-sm whitespace-pre-wrap break-words" v-html="plainHtml" />
              <div v-else class="text-sm text-muted-foreground">(no body)</div>
            </div>

            <div class="border-t px-4 py-3 flex gap-2">
              <Button variant="outline" class="rounded-full gap-2" as-child><RouterLink :to="`/compose?reply=${mail.detail.id}`"><Reply class="size-4" /> Reply</RouterLink></Button>
              <Button variant="outline" class="rounded-full gap-2" as-child><RouterLink :to="`/compose?replyAll=${mail.detail.id}`"><ReplyAll class="size-4" /> Reply all</RouterLink></Button>
              <Button variant="outline" class="rounded-full gap-2" as-child><RouterLink :to="`/compose?forward=${mail.detail.id}`"><Forward class="size-4" /> Forward</RouterLink></Button>
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>

    <Dialog v-model:open="sourceOpen">
      <DialogContent class="max-w-3xl">
        <DialogHeader><DialogTitle>Message source</DialogTitle></DialogHeader>
        <pre class="text-xs whitespace-pre-wrap max-h-[70vh] overflow-auto bg-muted rounded p-3">{{ sourceText }}</pre>
      </DialogContent>
    </Dialog>
  </main>
</template>
