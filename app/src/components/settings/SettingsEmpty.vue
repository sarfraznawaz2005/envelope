<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useEngine } from '@/engine'
import { formatBytes } from '@/lib/files'
import type { EmptyScope, FolderSummary, StorageStats } from '@/shared/rpc'
import { useAccountsStore } from '@/stores/accounts'
import { Info } from '@lucide/vue'
import { onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'

const engine = useEngine()
const accounts = useAccountsStore()
const stats = ref<StorageStats | null>(null)
async function load() {
  stats.value = await engine.api.storageStats()
}

// ---------- per-account / per-folder breakdown ----------
interface FolderRow extends FolderSummary {
  bytes: number
}
const perAccount = ref<Array<{ accountId: number; name: string; kind: string; folders: FolderRow[] }>>([])
async function loadPerAccount() {
  if (!accounts.loaded) await accounts.load()
  perAccount.value = await Promise.all(
    accounts.list.map(async a => {
      const [folders, bytes] = await Promise.all([engine.api.foldersList(a.id), engine.api.folderStorage(a.id)])
      return { accountId: a.id, name: a.name, kind: a.kind, folders: folders.map(f => ({ ...f, bytes: bytes[f.id] ?? 0 })) }
    }),
  )
}
onMounted(() => {
  void load()
  void loadPerAccount()
})

const open = ref(false)
const pending = ref<{ scope: EmptyScope; label: string; typed: boolean } | null>(null)
const typed = ref('')
const busy = ref(false)

function ask(scope: EmptyScope, label: string, needsTyping = false) {
  pending.value = { scope, label, typed: needsTyping }
  typed.value = ''
  open.value = true
}
async function confirm() {
  if (!pending.value) return
  if (pending.value.typed && typed.value !== 'EMPTY') return
  busy.value = true
  try {
    await engine.api.emptyData(pending.value.scope)
    toast.success(`Emptied: ${pending.value.label}`)
    open.value = false
    if (pending.value.scope.kind === 'everything') setTimeout(() => location.reload(), 600)
    await Promise.all([load(), loadPerAccount()])
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-5">
    <h1 class="text-2xl font-semibold">Empty data</h1>

    <div class="rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900 px-3 py-2 text-xs flex items-start gap-2">
      <Info class="size-4 shrink-0 mt-0.5" />
      <span>This clears the <b>local cache only</b>. Mail on your server is not touched. IMAP folders download again when opened. <b>POP3 mail has no server copy if "leave on server" is off.</b></span>
    </div>

    <section v-for="a in perAccount" :key="a.accountId" class="rounded-lg border divide-y text-sm">
      <div class="px-3 py-2 text-xs font-medium text-muted-foreground">{{ a.name }} ({{ a.kind.toUpperCase() }})</div>
      <div v-for="f in a.folders" :key="f.id" class="flex items-center px-3 py-2">
        <span>{{ f.name }}</span>
        <span class="ml-2 text-xs text-muted-foreground">{{ f.total }} msgs<template v-if="f.bytes"> · {{ formatBytes(f.bytes) }}</template></span>
        <Button size="sm" variant="outline" class="ml-auto" @click="ask({ kind: 'folder', folderId: f.id }, `${a.name} / ${f.name}`)">Empty</Button>
      </div>
      <div class="flex items-center px-3 py-2 bg-muted/40">
        <span class="text-xs">Whole account cache</span>
        <Button size="sm" variant="outline" class="ml-auto border-red-300 text-red-600 hover:text-red-600" @click="ask({ kind: 'account', accountId: a.accountId }, `${a.name} (all folders)`)">Empty account</Button>
      </div>
    </section>

    <section class="rounded-lg border divide-y text-sm">
      <div class="px-3 py-2 text-xs font-medium text-muted-foreground">Mail cache</div>
      <div class="flex items-center px-3 py-2">
        <span>All cached mail</span>
        <span class="ml-2 text-xs text-muted-foreground">{{ stats?.counts.messages ?? '…' }} messages</span>
        <Button size="sm" variant="outline" class="ml-auto" @click="ask({ kind: 'all-mail' }, 'all cached mail')">Empty</Button>
      </div>
      <div class="flex items-center px-3 py-2">
        <span>Attachment cache</span>
        <span class="ml-2 text-xs text-muted-foreground">{{ stats ? formatBytes(stats.counts.attachmentBytes) : '…' }}</span>
        <Button size="sm" variant="outline" class="ml-auto" @click="ask({ kind: 'attachments' }, 'attachment cache')">Empty</Button>
      </div>
      <div class="flex items-center px-3 py-2">
        <span>Search index</span>
        <span class="ml-2 text-xs text-muted-foreground">rebuilt from cached mail</span>
        <Button size="sm" variant="outline" class="ml-auto" @click="ask({ kind: 'search-index' }, 'search index (rebuild)')">Rebuild</Button>
      </div>
    </section>

    <section class="rounded-lg border divide-y text-sm">
      <div class="px-3 py-2 text-xs font-medium text-muted-foreground">Contacts</div>
      <div class="flex items-center px-3 py-2">
        <span>Collected contacts</span>
        <span class="ml-2 text-xs text-muted-foreground">{{ stats?.counts.collectedContacts ?? '…' }}</span>
        <Button size="sm" variant="outline" class="ml-auto" @click="ask({ kind: 'collected-contacts' }, 'collected contacts')">Empty</Button>
      </div>
    </section>

    <section class="rounded-lg border-2 border-red-300 dark:border-red-900 p-4">
      <div class="font-medium text-red-600">Delete everything</div>
      <p class="text-xs text-muted-foreground mt-1 mb-3">Removes all accounts, mail cache, contacts, rules and settings from this browser. Your disk backup is not touched.</p>
      <Button size="sm" variant="destructive" @click="ask({ kind: 'everything' }, 'EVERYTHING', true)">Delete all local data…</Button>
    </section>

    <Dialog v-model:open="open">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Empty {{ pending?.label }}?</DialogTitle>
          <DialogDescription>This removes the local copy only. Server mail stays.<template v-if="pending?.typed"> Type <b>EMPTY</b> to confirm.</template></DialogDescription>
        </DialogHeader>
        <Input v-if="pending?.typed" v-model="typed" placeholder="EMPTY" autofocus />
        <DialogFooter>
          <Button variant="outline" @click="open = false">Cancel</Button>
          <Button variant="destructive" :disabled="busy || (pending?.typed && typed !== 'EMPTY')" @click="confirm">Empty</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
