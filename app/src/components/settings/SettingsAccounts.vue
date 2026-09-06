<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useEngine } from '@/engine'
import { useAccountsStore } from '@/stores/accounts'
import type { Account } from '@/shared/accounts'
import type { SyncStatusEntry } from '@/shared/rpc'
import { Plus, Trash2 } from '@lucide/vue'
import { onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'

const engine = useEngine()
const accounts = useAccountsStore()
onMounted(() => accounts.load())

const del = ref<Account | null>(null)
async function confirmDelete() {
  if (!del.value) return
  try {
    await accounts.remove(del.value.id)
    toast.success(`Removed ${del.value.name}`)
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    del.value = null
  }
}
const sec = (s: string) => ({ tls: 'TLS', starttls: 'STARTTLS', none: 'no encryption' })[s] ?? s

// ---------- connection status ----------
const syncStatuses = ref<Record<number, SyncStatusEntry>>({})
async function loadSyncStatus() {
  const list = await engine.api.syncStatus()
  syncStatuses.value = Object.fromEntries(list.map(s => [s.accountId, s]))
}
onMounted(() => {
  void loadSyncStatus()
  engine.on('sync:status', e => {
    const s = e as SyncStatusEntry
    syncStatuses.value = { ...syncStatuses.value, [s.accountId]: s }
  })
})
function statusText(a: Account): string {
  const s = syncStatuses.value[a.id]
  if (!a.enabled) return 'Disabled'
  if (a.kind === 'pop3') {
    let t = `Polls every ${a.pollMinutes} min`
    if (a.popLeaveOnServer) t += a.popDeleteAfterDays > 0 ? `, leaves copy on server, deletes after ${a.popDeleteAfterDays} days` : ', leaves copy on server'
    return t
  }
  if (!s) return 'Starting…'
  if (s.state === 'error') return s.error ? `Error: ${s.error}` : 'Error'
  if (s.state === 'syncing' || s.state === 'connecting') return 'Syncing…'
  if (s.state === 'stopped') return 'Stopped'
  return s.idle ? 'Connected, IDLE' : 'Connected'
}
function statusClass(a: Account): string {
  const s = syncStatuses.value[a.id]
  if (!a.enabled) return 'text-muted-foreground'
  if (a.kind === 'pop3') return 'text-muted-foreground'
  if (s?.state === 'error') return 'text-red-500'
  if (s?.state === 'syncing' || s?.state === 'connecting') return 'text-amber-600'
  if (s?.state === 'idle' || s?.idle) return 'text-emerald-600'
  return 'text-muted-foreground'
}

// ---------- test ----------
const testingId = ref<number | null>(null)
async function test(a: Account) {
  testingId.value = a.id
  try {
    const r = await accounts.test({ ...a, inPassword: undefined, smtpPassword: undefined })
    if (r.ok) {
      toast.success(`${a.name}: connection OK${r.folders != null ? ` · ${r.folders} folders` : ''}`)
    } else {
      const failed = r.steps.find(s => !s.ok)
      toast.error(`${a.name}: ${failed ? `${failed.label} failed — ${failed.detail ?? 'unknown error'}` : 'test failed'}`)
    }
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    testingId.value = null
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center">
      <h1 class="text-2xl font-semibold">Accounts</h1>
      <Button as-child class="ml-auto"><RouterLink to="/setup"><Plus class="size-4" /> Add account</RouterLink></Button>
    </div>

    <div v-if="!accounts.list.length" class="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      No accounts yet. Add one to start.
    </div>

    <div v-for="a in accounts.list" :key="a.id" class="rounded-lg border p-4 flex items-center gap-4">
      <div class="size-10 rounded-full text-white flex items-center justify-center font-bold shrink-0" :style="{ background: a.color }">{{ (a.name || a.email)[0]?.toUpperCase() }}</div>
      <div class="flex-1 min-w-0">
        <div class="font-medium truncate">{{ a.name }} <span class="text-xs font-normal text-muted-foreground">{{ a.email }}</span> <span v-if="!a.enabled" class="text-xs text-amber-600">(disabled)</span></div>
        <div class="text-xs text-muted-foreground mt-0.5 truncate">
          {{ a.kind.toUpperCase() }} {{ a.inHost }}:{{ a.inPort }} ({{ sec(a.inSecurity) }}) · SMTP {{ a.smtpHost }}:{{ a.smtpPort }} ({{ sec(a.smtpSecurity) }})
        </div>
        <div class="text-xs mt-0.5 truncate" :class="statusClass(a)">● {{ statusText(a) }}</div>
      </div>
      <Tooltip>
        <TooltipTrigger as-child><Button size="sm" variant="outline" :disabled="testingId === a.id" @click="test(a)">{{ testingId === a.id ? 'Testing…' : 'Test' }}</Button></TooltipTrigger>
        <TooltipContent>Try to log in to the incoming and outgoing servers now, using the saved password</TooltipContent>
      </Tooltip>
      <Button size="sm" variant="outline" as-child><RouterLink :to="{ name: 'setup', query: { id: a.id } }">Edit</RouterLink></Button>
      <Tooltip>
        <TooltipTrigger as-child><Button size="icon" variant="ghost" class="text-destructive" @click="del = a"><Trash2 class="size-4" /></Button></TooltipTrigger>
        <TooltipContent>Remove account and its local cache</TooltipContent>
      </Tooltip>
    </div>

    <Dialog :open="!!del" @update:open="v => !v && (del = null)">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {{ del?.name }}?</DialogTitle>
          <DialogDescription>Removes the account and its cached mail from this browser. Mail on the server is not touched.</DialogDescription>
        </DialogHeader>
        <DialogFooter><Button variant="outline" @click="del = null">Cancel</Button><Button variant="destructive" @click="confirmDelete">Remove</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
