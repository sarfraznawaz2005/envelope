<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { FolderSummary } from '@/shared/rpc'
import { useEngine } from '@/engine'
import { avatarColor, avatarInitials } from '@/lib/avatar'
import { useAccountsStore } from '@/stores/accounts'
import { useMailStore } from '@/stores/mail'
import { Archive, Flag, FolderInput, MailOpen, Paperclip, RefreshCw, Search, Trash2 } from '@lucide/vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'

const mail = useMailStore()
const accounts = useAccountsStore()
const engine = useEngine()
const scrollParent = ref<HTMLElement | null>(null)
const selected = ref<Set<number>>(new Set())
const searchInput = ref(mail.searchQuery)

const rowVirtualizer = useVirtualizer(
  computed(() => ({
    count: mail.messages.length,
    getScrollElement: () => scrollParent.value,
    estimateSize: () => 68,
    overscan: 8,
  })),
)
const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems())
const totalSize = computed(() => rowVirtualizer.value.getTotalSize())

watch(virtualRows, rows => {
  const last = rows[rows.length - 1]
  if (last && last.index >= mail.messages.length - 10) void mail.loadMore()
})

function toggleSelect(id: number, checked: boolean) {
  const s = new Set(selected.value)
  if (checked) s.add(id)
  else s.delete(id)
  selected.value = s
}
function clearSelection() {
  selected.value = new Set()
}
watch(
  () => mail.selection,
  () => clearSelection(),
)

const allSelected = computed(() => mail.messages.length > 0 && selected.value.size === mail.messages.length)
function toggleSelectAll(checked: boolean) {
  selected.value = checked ? new Set(mail.messages.map(m => m.id)) : new Set()
}

const bulkMoveTargets = computed<FolderSummary[]>(() => {
  const sel = mail.selection
  if (sel.kind !== 'folder') return []
  return (mail.foldersByAccount[sel.accountId] ?? []).filter(f => f.id !== sel.folderId && f.selectable)
})
// Runs fn over every id, keeps going past a failure (one bad message shouldn't abort the rest
// of the batch), and reports how many actually failed instead of just going quiet — leaves
// the failed ones selected so the user can see which ones need a retry.
async function runBulk(label: string, ids: number[], fn: (id: number) => Promise<void>) {
  const failed: number[] = []
  for (const id of ids) {
    try {
      await fn(id)
    } catch {
      failed.push(id)
    }
  }
  if (failed.length) {
    selected.value = new Set(failed)
    toast.error(`${label}: ${ids.length - failed.length} of ${ids.length} succeeded, ${failed.length} failed.`)
  } else {
    clearSelection()
  }
}

async function bulkMoveTo(destId: number) {
  await runBulk('Move', [...selected.value], id => mail.moveTo(id, destId))
}

async function bulkArchive() {
  await runBulk('Archive', [...selected.value], id => mail.archive(id))
}
async function bulkDelete() {
  await runBulk('Delete', [...selected.value], id => mail.remove(id))
}
async function bulkMarkRead() {
  await runBulk('Mark read', [...selected.value], id => mail.setFlag(id, 'seen', true))
}
// Actually checks the mail server for new mail, not just re-reading the local list — matches
// what "Refresh" implies. Live IMAP IDLE already pushes new mail in automatically, so this is
// mainly for "I want to be sure right now" (e.g. after IDLE dropped) or POP3 accounts, which
// only poll on an interval rather than push.
function refresh() {
  const sel = mail.selection
  void engine.api.syncNow(sel.kind === 'folder' ? sel.accountId : undefined).catch(e => toast.error((e as Error).message))
  void mail.loadMessages()
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchInput, v => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => mail.setSearch(v), 250)
})

function fmtDate(ms: number | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.getFullYear() === today.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return d.toLocaleDateString()
}

async function openRow(id: number) {
  await mail.openMessage(id)
}

function accountName(accountId: number): string {
  return accounts.byId.get(accountId)?.name ?? ''
}
</script>

<template>
  <section class="flex flex-col min-h-0">
    <div class="h-10 shrink-0 flex items-center gap-1 px-2 border-b text-muted-foreground">
      <Tooltip>
        <TooltipTrigger as-child>
          <Checkbox class="ml-1 mr-1" :model-value="allSelected" @update:model-value="v => toggleSelectAll(!!v)" />
        </TooltipTrigger>
        <TooltipContent>{{ allSelected ? 'Deselect all' : 'Select all' }}</TooltipContent>
      </Tooltip>
      <template v-if="selected.size">
        <span class="text-xs pl-1 pr-1">{{ selected.size }} selected</span>
        <Tooltip><TooltipTrigger as-child><Button size="icon" variant="ghost" @click="bulkArchive"><Archive class="size-4" /></Button></TooltipTrigger><TooltipContent>Archive</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger as-child><Button size="icon" variant="ghost" @click="bulkDelete"><Trash2 class="size-4" /></Button></TooltipTrigger><TooltipContent>Delete</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger as-child><Button size="icon" variant="ghost" @click="bulkMarkRead"><MailOpen class="size-4" /></Button></TooltipTrigger><TooltipContent>Mark read</TooltipContent></Tooltip>
        <DropdownMenu v-if="bulkMoveTargets.length">
          <Tooltip>
            <TooltipTrigger as-child>
              <DropdownMenuTrigger as-child>
                <Button size="icon" variant="ghost"><FolderInput class="size-4" /></Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Move to</TooltipContent>
          </Tooltip>
          <DropdownMenuContent>
            <DropdownMenuItem v-for="f in bulkMoveTargets" :key="f.id" @click="bulkMoveTo(f.id)">{{ f.name }}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </template>
      <template v-else>
        <div class="relative flex-1">
          <Search class="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input id="mail-search" v-model="searchInput" placeholder="Search mail" class="h-7 pl-7 text-xs" />
        </div>
      </template>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button size="icon" variant="ghost" class="ml-auto" :disabled="mail.isSyncingCurrent" @click="refresh">
            <RefreshCw class="size-4" :class="mail.loadingList || mail.isSyncingCurrent ? 'animate-spin' : ''" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ mail.isSyncingCurrent ? 'Checking your mail server…' : 'Check for new mail now' }}</TooltipContent>
      </Tooltip>
    </div>
    <div class="px-3 py-1 text-[11px] text-muted-foreground border-b" v-if="!mail.searchQuery">
      {{ mail.messages.length ? `1–${mail.messages.length} of ${mail.totalCount}` : mail.loadingList ? 'Loading…' : 'No messages' }}
    </div>
    <div ref="scrollParent" class="flex-1 overflow-y-auto text-sm">
      <div v-if="!mail.messages.length && !mail.loadingList" class="p-6 text-center text-muted-foreground text-sm">
        {{ mail.searchQuery ? 'No matches.' : 'This folder is empty.' }}
      </div>
      <div :style="{ height: `${totalSize}px`, position: 'relative' }">
        <div
          v-for="vr in virtualRows"
          :key="String(vr.key)"
          :style="{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vr.start}px)` }"
        >
          <div
            class="flex gap-3 px-3 py-2.5 cursor-pointer border-b hover:bg-muted/60"
            :class="mail.selectedMessageId === mail.messages[vr.index]!.id ? 'bg-primary/10' : ''"
            @click="openRow(mail.messages[vr.index]!.id)"
          >
            <Checkbox
              class="mt-1"
              :model-value="selected.has(mail.messages[vr.index]!.id)"
              @update:model-value="v => toggleSelect(mail.messages[vr.index]!.id, !!v)"
              @click.stop
            />
            <div class="size-9 rounded-full text-white flex items-center justify-center text-xs font-bold shrink-0 mt-0.5" :class="avatarColor(mail.messages[vr.index]!.from)">
              {{ avatarInitials(mail.messages[vr.index]!.from) }}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="truncate" :class="!mail.messages[vr.index]!.seen ? 'font-semibold' : ''">{{ mail.messages[vr.index]!.from }}</span>
                <span
                  v-if="mail.messages[vr.index]!.threadCount"
                  class="text-xs text-muted-foreground shrink-0 bg-muted rounded-full px-1.5"
                >({{ mail.messages[vr.index]!.threadCount }})</span>
                <span class="ml-auto text-xs whitespace-nowrap" :class="!mail.messages[vr.index]!.seen ? 'text-primary' : 'text-muted-foreground'">{{ fmtDate(mail.messages[vr.index]!.date) }}</span>
              </div>
              <div class="truncate" :class="!mail.messages[vr.index]!.seen ? 'font-semibold' : 'text-foreground/80'">{{ mail.messages[vr.index]!.subject || '(no subject)' }}</div>
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <Paperclip v-if="mail.messages[vr.index]!.hasAttachments" class="size-3.5 shrink-0" />
                <Flag v-if="mail.messages[vr.index]!.flagged" class="size-3.5 shrink-0 fill-amber-500 text-amber-500" />
                <span v-if="mail.selection.kind === 'unified'" class="ml-auto px-1 rounded bg-muted text-[10px] shrink-0">{{ accountName(mail.messages[vr.index]!.accountId) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
