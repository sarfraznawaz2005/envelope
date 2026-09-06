<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useEngine } from '@/engine'
import type { EngineStatus, FolderSummary, MessageSummary, NewMailEvent, SyncStatusEntry } from '@/shared/rpc'
import { useAccountsStore } from '@/stores/accounts'
import { useSetting } from '@/stores/settings'
import { onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'

const engine = useEngine()
const relayUrl = useSetting('relay.url')
const relayToken = useSetting('relay.token')

const status = ref<EngineStatus | null>(null)
const relayResult = ref('')
const busy = ref(false)

const host = ref('imap.gmail.com')
const port = ref(993)
const tls = ref(true)
const sockResult = ref('')

const accounts = useAccountsStore()
const accountId = ref<number | null>(null)
const folderPath = ref('INBOX')
const sendTo = ref('')
const devResult = ref('')

// ---- 5. live sync ----
const syncStatuses = ref<Record<number, SyncStatusEntry>>({})
const folders = ref<FolderSummary[]>([])
const selectedFolderId = ref<number | null>(null)
const messages = ref<MessageSummary[]>([])
const liveFeed = ref<Array<{ t: number; subject: string; from: string }>>([])

async function loadFolders() {
  if (!accountId.value) {
    folders.value = []
    return
  }
  folders.value = await engine.api.foldersList(accountId.value)
  if (!folders.value.some(f => f.id === selectedFolderId.value)) selectedFolderId.value = folders.value[0]?.id ?? null
  await loadMessages()
}
async function loadMessages() {
  if (!selectedFolderId.value) {
    messages.value = []
    return
  }
  messages.value = await engine.api.messagesList([selectedFolderId.value], 20, 0)
}
async function syncNowClick() {
  if (!accountId.value) return
  await engine.api.syncNow(accountId.value)
  toast.info('Sync kicked — watch the panel below.')
}
watch(accountId, loadFolders)
watch(selectedFolderId, loadMessages)

async function refresh() {
  if (!engine.ready.value) return
  status.value = await engine.api.getStatus()
  await accounts.load()
  accountId.value ??= accounts.list[0]?.id ?? null
  await loadFolders()
}
onMounted(() => {
  void refresh()
  engine.on('sync:status', s => {
    const e = s as SyncStatusEntry
    syncStatuses.value = { ...syncStatuses.value, [e.accountId]: e }
  })
  engine.on('folders:changed', e => {
    if ((e as { accountId: number }).accountId === accountId.value) void loadFolders()
  })
  engine.on('mail:new', e => {
    const ev = e as NewMailEvent
    liveFeed.value.unshift({ t: Date.now(), subject: ev.subject || '(no subject)', from: ev.from })
    if (liveFeed.value.length > 20) liveFeed.value.length = 20
  })
})
watch(() => engine.ready.value, refresh)

async function devCall(fn: () => Promise<unknown>) {
  busy.value = true
  devResult.value = ''
  try {
    devResult.value = JSON.stringify(await fn(), null, 2)
  } catch (e) {
    devResult.value = `ERROR: ${(e as Error).message}`
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
const listFolders = () => devCall(() => engine.api.devListFolders(accountId.value!))
const fetchRecent = () => devCall(() => engine.api.devFetchRecent(accountId.value!, folderPath.value || 'INBOX', 5))
const sendTest = () => devCall(() => engine.api.devSendMail(accountId.value!, sendTo.value, 'Envelope test', `Hello from Envelope at ${new Date().toLocaleString()}.\n`))

async function ping() {
  const t0 = performance.now()
  const r = await engine.api.ping()
  toast.success(`Worker says "${r}" in ${Math.round(performance.now() - t0)} ms`)
}

async function testRelay() {
  busy.value = true
  relayResult.value = ''
  try {
    const r = await engine.api.testRelay(relayUrl.value, relayToken.value || undefined)
    relayResult.value = r.ok ? `OK — relay v${r.version}` : `FAIL — ${r.error}`
    r.ok ? toast.success('Relay reachable') : toast.error(r.error)
  } finally {
    busy.value = false
  }
}

async function testSocket() {
  busy.value = true
  sockResult.value = ''
  try {
    const r = await engine.api.testSocket({
      relayUrl: relayUrl.value,
      token: relayToken.value || undefined,
      host: host.value,
      port: Number(port.value),
      tls: tls.value,
    })
    sockResult.value = r.ok ? `OK in ${r.ms} ms — server said:\n${r.greeting}` : `FAIL — ${r.error}`
    r.ok ? toast.success(`Connected to ${host.value}:${port.value}`) : toast.error(r.error)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex-1 overflow-y-auto">
    <div class="max-w-2xl mx-auto p-8 space-y-8 text-sm">
      <div>
        <h1 class="text-2xl font-semibold">Developer tools</h1>
        <p class="text-muted-foreground">Checks: worker runs, database open, relay answers, a real socket opens.</p>
      </div>

      <section class="rounded-lg border p-4 space-y-3">
        <div class="font-medium">1. Engine worker + database</div>
        <div class="flex items-center gap-3 flex-wrap">
          <span>Leader: <b>{{ engine.isLeader.value ? 'yes' : 'no' }}</b></span>
          <span>Ready: <b>{{ engine.ready.value ? 'yes' : 'no' }}</b></span>
          <span v-if="status">Storage: <b>{{ status.storage }}</b></span>
          <span v-if="status">SQLite: <b>{{ status.sqliteVersion || '—' }}</b></span>
          <Button size="sm" :disabled="!engine.ready.value" @click="ping">Ping worker</Button>
        </div>
      </section>

      <section class="rounded-lg border p-4 space-y-3">
        <div class="font-medium">2. Relay</div>
        <div class="grid grid-cols-[1fr_auto] gap-2 items-end">
          <div class="space-y-1">
            <Label for="relay">Relay URL</Label>
            <Input id="relay" v-model="relayUrl" class="font-mono" />
          </div>
          <Button :disabled="busy || !engine.ready.value" @click="testRelay">Test relay</Button>
          <div class="space-y-1 col-span-2">
            <Label for="token">Token (optional)</Label>
            <Input id="token" v-model="relayToken" type="password" autocomplete="off" />
          </div>
        </div>
        <pre v-if="relayResult" class="rounded bg-muted p-2 text-xs whitespace-pre-wrap">{{ relayResult }}</pre>
        <p class="text-xs text-muted-foreground">
          Start it with: <code class="bg-muted px-1 rounded">cd relay &amp;&amp; node index.js --verbose</code>
        </p>
      </section>

      <section class="rounded-lg border p-4 space-y-3">
        <div class="font-medium">3. Open a socket to a mail server</div>
        <div class="grid grid-cols-[1fr_100px_auto] gap-2 items-end">
          <div class="space-y-1"><Label for="host">Host</Label><Input id="host" v-model="host" class="font-mono" /></div>
          <div class="space-y-1"><Label for="port">Port</Label><Input id="port" v-model="port" type="number" class="font-mono" /></div>
          <div class="flex items-center gap-2 h-9"><Switch id="tls" v-model="tls" /><Label for="tls">TLS</Label></div>
        </div>
        <Button :disabled="busy || !engine.ready.value" @click="testSocket">Connect and read greeting</Button>
        <pre v-if="sockResult" class="rounded bg-muted p-2 text-xs whitespace-pre-wrap">{{ sockResult }}</pre>
        <p class="text-xs text-muted-foreground">No login happens. It only reads the first line the server sends.</p>
      </section>

      <section class="rounded-lg border p-4 space-y-3">
        <div class="font-medium">4. Real account (Phase 4 exit checks)</div>
        <div v-if="!accounts.list.length" class="text-xs text-muted-foreground">No accounts yet. <RouterLink to="/setup" class="underline">Add one</RouterLink>.</div>
        <template v-else>
          <div class="flex items-center gap-2 flex-wrap">
            <select v-model="accountId" class="h-9 rounded-md border bg-background px-2 text-sm">
              <option v-for="a in accounts.list" :key="a.id" :value="a.id">{{ a.name }} ({{ a.email }})</option>
            </select>
            <Button size="sm" variant="outline" :disabled="busy || !accountId" @click="listFolders">List folders</Button>
            <Input v-model="folderPath" class="w-40 font-mono" placeholder="INBOX" />
            <Button size="sm" variant="outline" :disabled="busy || !accountId" @click="fetchRecent">Fetch last 5</Button>
          </div>
          <div class="flex items-center gap-2">
            <Input v-model="sendTo" class="w-64" placeholder="send a test mail to…" />
            <Button size="sm" variant="outline" :disabled="busy || !accountId || !sendTo" @click="sendTest">Send test mail</Button>
          </div>
          <pre v-if="devResult" class="rounded bg-muted p-2 text-xs whitespace-pre-wrap max-h-72 overflow-auto">{{ devResult }}</pre>
        </template>
      </section>

      <section class="rounded-lg border p-4 space-y-3">
        <div class="font-medium">5. Live sync (Phase 5 exit check)</div>
        <div v-if="!accounts.list.length" class="text-xs text-muted-foreground">No accounts yet.</div>
        <template v-else>
          <div class="flex items-center gap-3 flex-wrap text-xs">
            <span>Status: <b>{{ accountId && syncStatuses[accountId] ? syncStatuses[accountId]!.state : 'starting…' }}</b></span>
            <span v-if="accountId && syncStatuses[accountId]?.idle" class="text-emerald-600">IDLE (instant push)</span>
            <span v-if="accountId && syncStatuses[accountId]?.lastSyncAt">last sync {{ new Date(syncStatuses[accountId]!.lastSyncAt!).toLocaleTimeString() }}</span>
            <span v-if="accountId && syncStatuses[accountId]?.error" class="text-red-500">{{ syncStatuses[accountId]!.error }}</span>
            <Button size="sm" variant="outline" :disabled="!accountId" @click="syncNowClick">Sync now</Button>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <div class="text-xs text-muted-foreground mb-1">Folders — from the local database, updates live</div>
              <table class="w-full text-xs">
                <tbody>
                  <tr v-for="f in folders" :key="f.id" class="cursor-pointer" :class="f.id === selectedFolderId ? 'bg-muted' : ''" @click="selectedFolderId = f.id">
                    <td class="py-0.5">{{ f.name }}</td>
                    <td class="py-0.5 text-right">{{ f.total }}</td>
                    <td class="py-0.5 text-right text-muted-foreground">{{ f.unread }} unread</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div>
              <div class="text-xs text-muted-foreground mb-1">Messages in selected folder</div>
              <div class="max-h-56 overflow-y-auto space-y-1">
                <div v-for="m in messages" :key="m.id" class="text-xs border-b pb-1" :class="!m.seen ? 'font-semibold' : ''">
                  {{ m.subject || '(no subject)' }} — <span class="text-muted-foreground font-normal">{{ m.from }}</span>
                </div>
                <div v-if="!messages.length" class="text-muted-foreground text-xs">empty</div>
              </div>
            </div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground mb-1">Live new-mail feed — fires the instant mail arrives, no refresh</div>
            <div class="max-h-40 overflow-y-auto text-xs space-y-0.5">
              <div v-for="(e, i) in liveFeed" :key="i">{{ new Date(e.t).toLocaleTimeString() }} — {{ e.subject }} ({{ e.from }})</div>
              <div v-if="!liveFeed.length" class="text-muted-foreground">nothing yet</div>
            </div>
          </div>
        </template>
      </section>

      <section class="rounded-lg border p-4 space-y-2">
        <div class="font-medium">Engine log</div>
        <div class="max-h-60 overflow-y-auto font-mono text-xs space-y-0.5">
          <div v-for="(l, i) in engine.logs.value" :key="i" :class="l.level === 'error' ? 'text-red-500' : l.level === 'warn' ? 'text-amber-500' : ''">
            {{ new Date(l.t).toLocaleTimeString() }} [{{ l.level }}] {{ l.msg }}
          </div>
          <div v-if="!engine.logs.value.length" class="text-muted-foreground">nothing yet</div>
        </div>
      </section>
    </div>
  </div>
</template>
