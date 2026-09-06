<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useEngine } from '@/engine'
import { useDiskBackup } from '@/lib/disk-backup'
import { downloadBlob, downloadJson, formatBytes, pickFile, timestampForFilename } from '@/lib/files'
import { useInstallPrompt } from '@/lib/install-prompt'
import type { BackupFile, StorageStats } from '@/shared/rpc'
import { useSecurityStore } from '@/stores/security'
import { useSetting } from '@/stores/settings'
import { CheckCircle2, FolderSync, HardDrive, Package, AlertTriangle } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'

const engine = useEngine()
const sec = useSecurityStore()
const disk = useDiskBackup()
const install = useInstallPrompt()

// ---------- stats ----------
const stats = ref<StorageStats | null>(null)
const statsError = ref<string | null>(null)
async function loadStats() {
  statsError.value = null
  try {
    stats.value = await engine.api.storageStats()
  } catch (e) {
    // Without this, a failed call left `stats` null forever and the template's "Loading…"
    // branch (v-else below) never resolved into either data or a visible error.
    statsError.value = (e as Error).message
  }
}
onMounted(loadStats)
const pct = computed(() => (stats.value && stats.value.quota ? Math.max(0.5, (stats.value.usage / stats.value.quota) * 100) : 0))
async function persist() {
  // persist() only exists on the main thread, not in workers
  let ok = false
  try {
    ok = (await navigator.storage.persisted()) || (await navigator.storage.persist())
  } catch (e) {
    toast.error((e as Error).message)
    return
  }
  ok ? toast.success('Persistent storage granted') : toast.warning('Browser did not grant it yet. Install the app or use it more, then try again.')
  await loadStats()
}

// ---------- disk auto-save ----------
const intervalMin = useSetting('backup.disk.intervalMin')
const onClose = useSetting('backup.disk.onClose')
const enabled = useSetting('backup.disk.enabled')
const intervalStr = computed({ get: () => String(intervalMin.value), set: v => (intervalMin.value = Number(v)) })
const lastSaved = computed(() => (disk.lastSavedAt.value ? new Date(disk.lastSavedAt.value).toLocaleString() : 'never'))

async function pick() {
  try {
    await disk.pickFolder()
    toast.success(`Folder chosen: ${disk.folderName.value}`)
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toast.error((e as Error).message)
  }
}
async function grant() {
  ;(await disk.requestPermission()) ? toast.success('Permission granted') : toast.error('Permission not granted')
}
async function saveNow() {
  const ok = await disk.saveNow()
  ok ? toast.success('Saved to disk') : toast.error(disk.lastError.value ?? 'Could not save. Check folder permission.')
  await loadStats()
}
const restoreOpen = ref(false)
async function restore() {
  try {
    await disk.restoreFromDisk()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

// ---------- settings export / import ----------
const opts = ref({ accounts: true, settings: true, contacts: true, rules: true, signatures: true })
async function exportSettings() {
  try {
    const file = await engine.api.backupExport(opts.value)
    downloadJson(`envelope-backup-${timestampForFilename()}.json`, file)
  } catch (e) {
    toast.error((e as Error).message)
  }
}
const importPwOpen = ref(false)
const importPw = ref('')
let pendingImport: BackupFile | null = null
async function importSettings() {
  const f = await pickFile('application/json,.json')
  if (!f) return
  let file: BackupFile
  try {
    file = JSON.parse(await f.text())
  } catch {
    return toast.error('Not a JSON file')
  }
  pendingImport = file
  await runImport()
}
async function runImport(password?: string) {
  if (!pendingImport) return
  try {
    const r = await engine.api.backupImport(pendingImport, password)
    if (r.needsBackupPassword) {
      importPw.value = ''
      importPwOpen.value = true
      return
    }
    importPwOpen.value = false
    pendingImport = null
    toast.success(`Imported: ${r.accounts} accounts, ${r.settings} settings, ${r.contacts} contacts, ${r.rules} rules, ${r.signatures} signatures`)
    await loadStats()
    setTimeout(() => location.reload(), 800)
  } catch (e) {
    toast.error((e as Error).message)
  }
}

// ---------- whole database ----------
async function downloadDb() {
  try {
    const bytes = await engine.api.dbDump()
    downloadBlob(`envelope-${timestampForFilename()}.db`, new Blob([bytes as BlobPart], { type: 'application/x-sqlite3' }))
  } catch (e) {
    toast.error((e as Error).message)
  }
}
const uploadOpen = ref(false)
async function uploadDb() {
  const f = await pickFile('.db,application/x-sqlite3,application/octet-stream')
  if (!f) return
  try {
    await engine.api.dbImport(new Uint8Array(await f.arrayBuffer()))
    toast.success('Database replaced. Reloading…')
    setTimeout(() => location.reload(), 800)
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    uploadOpen.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">Storage &amp; Backup</h1>

    <!-- browser storage -->
    <section class="rounded-lg border p-4 space-y-2">
      <div class="flex items-center gap-2 font-medium"><HardDrive class="size-4" /> Browser storage <span class="ml-auto text-xs text-muted-foreground font-normal">{{ engine.storage.value }}</span></div>
      <template v-if="stats">
        <div class="flex items-center text-xs text-muted-foreground">
          <span>Database {{ formatBytes(stats.dbBytes) }} · site total {{ formatBytes(stats.usage) }}</span>
          <span class="ml-auto">{{ formatBytes(stats.quota) }} available</span>
        </div>
        <div class="h-2 rounded bg-muted overflow-hidden"><div class="h-2 bg-primary" :style="{ width: pct + '%' }" /></div>
        <div class="text-xs flex items-center gap-2">
          <template v-if="stats.persisted"><CheckCircle2 class="size-3.5 text-emerald-500" /> Persistent storage granted. The browser will not auto-delete this data.</template>
          <template v-else><AlertTriangle class="size-3.5 text-amber-500" /> Not persistent yet. The browser may delete data when disk is low. <Button size="sm" variant="link" class="h-auto p-0" @click="persist">Ask now</Button></template>
          <span v-if="install.installed.value" class="flex items-center gap-1"> · <CheckCircle2 class="size-3.5 text-emerald-500" /> Installed as app</span>
        </div>
        <div class="text-xs text-muted-foreground">
          {{ stats.counts.messages }} messages · {{ stats.counts.bodies }} bodies · {{ stats.counts.attachments }} attachments ({{ formatBytes(stats.counts.attachmentBytes) }}) ·
          {{ stats.counts.contacts }} contacts + {{ stats.counts.collectedContacts }} collected · {{ stats.counts.rules }} rules
        </div>
      </template>
      <div v-else-if="statsError" class="text-xs text-red-600">Could not load: {{ statsError }} <Button size="sm" variant="link" class="h-auto p-0" @click="loadStats">Retry</Button></div>
      <div v-else class="text-xs text-muted-foreground">Loading…</div>
    </section>

    <!-- disk auto-save -->
    <section class="rounded-lg border p-4 space-y-3">
      <div class="flex items-center gap-2 font-medium"><FolderSync class="size-4" /> Auto-save database to disk</div>
      <p class="text-xs text-muted-foreground">A copy of the whole database and a settings file are written to a folder you pick. If browser data is ever cleared, you restore from here.</p>

      <template v-if="disk.supported">
        <div class="flex items-center gap-2 text-xs flex-wrap">
          <template v-if="disk.handle.value">
            <span class="bg-muted rounded px-2 py-1 font-mono">{{ disk.folderName.value ?? disk.handle.value.name }}</span>
            <span v-if="disk.permission.value === 'granted'" class="text-emerald-600 flex items-center gap-1"><CheckCircle2 class="size-3.5" /> permission OK</span>
            <Button v-else size="sm" variant="outline" @click="grant">Grant permission</Button>
            <Button size="sm" variant="ghost" @click="pick">Change folder</Button>
            <Button size="sm" variant="ghost" class="text-destructive" @click="disk.forget()">Stop</Button>
          </template>
          <Button v-else size="sm" @click="pick">Choose folder…</Button>
        </div>

        <div v-if="disk.handle.value" class="flex items-center gap-4 text-xs flex-wrap">
          <label class="flex items-center gap-2"><Switch v-model="enabled" /> Enabled</label>
          <label class="flex items-center gap-2">Every
            <Select v-model="intervalStr"><SelectTrigger class="h-7 w-24"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="5">5 min</SelectItem><SelectItem value="15">15 min</SelectItem><SelectItem value="60">1 hour</SelectItem><SelectItem value="360">6 hours</SelectItem></SelectContent>
            </Select>
          </label>
          <label class="flex items-center gap-2"><Checkbox v-model="onClose" /> and when the app closes</label>
          <span class="ml-auto text-muted-foreground">Last saved: {{ lastSaved }}</span>
          <Button size="sm" :disabled="disk.saving.value || disk.permission.value !== 'granted'" @click="saveNow">{{ disk.saving.value ? 'Saving…' : 'Save now' }}</Button>
        </div>
        <div v-if="disk.handle.value" class="text-xs border-t pt-2 flex items-center gap-2">
          <span class="text-muted-foreground">Browser data lost? </span>
          <Button size="sm" variant="outline" :disabled="disk.permission.value !== 'granted'" @click="restoreOpen = true">Restore from disk copy…</Button>
        </div>
        <p v-if="disk.lastError.value" class="text-xs text-red-600">{{ disk.lastError.value }}</p>
      </template>
      <p v-else class="text-xs text-amber-600">This browser has no folder picker (Firefox / Safari). Use the manual download and upload below.</p>
    </section>

    <!-- settings export/import -->
    <section class="rounded-lg border p-4 space-y-3">
      <div class="flex items-center gap-2 font-medium"><Package class="size-4" /> Export / import settings</div>
      <p class="text-xs text-muted-foreground">One JSON file with accounts, settings, contacts, rules, signatures. Passwords stay encrypted with your master password.</p>
      <div class="flex items-center gap-4 text-xs flex-wrap">
        <label class="flex items-center gap-1.5"><Checkbox v-model="opts.accounts" /> Accounts</label>
        <label class="flex items-center gap-1.5"><Checkbox v-model="opts.settings" /> Settings</label>
        <label class="flex items-center gap-1.5"><Checkbox v-model="opts.contacts" /> Contacts</label>
        <label class="flex items-center gap-1.5"><Checkbox v-model="opts.rules" /> Rules</label>
        <label class="flex items-center gap-1.5"><Checkbox v-model="opts.signatures" /> Signatures</label>
      </div>
      <div class="flex gap-2">
        <Button size="sm" @click="exportSettings">Export .json</Button>
        <Button size="sm" variant="outline" :disabled="!sec.status.unlocked && sec.status.hasPassword" @click="importSettings">Import…</Button>
        <span v-if="!sec.status.unlocked && sec.status.hasPassword" class="text-xs text-muted-foreground self-center">Unlock first to import accounts.</span>
      </div>
    </section>

    <!-- whole db -->
    <section class="rounded-lg border p-4 space-y-3">
      <div class="font-medium">Whole database (manual)</div>
      <p class="text-xs text-muted-foreground">Includes cached mail. Works in every browser. The file can be large.</p>
      <div class="flex gap-2">
        <Button size="sm" variant="outline" @click="downloadDb">Download .db</Button>
        <Button size="sm" variant="outline" @click="uploadOpen = true">Upload .db…</Button>
      </div>
    </section>

    <!-- dialogs -->
    <Dialog v-model:open="restoreOpen">
      <DialogContent>
        <DialogHeader><DialogTitle>Restore from disk copy?</DialogTitle>
          <DialogDescription>Everything in the browser right now will be replaced by the file <code>mailclient.db</code> in your chosen folder. The app reloads afterwards.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" @click="restoreOpen = false">Cancel</Button><Button variant="destructive" @click="restore">Replace and reload</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="uploadOpen">
      <DialogContent>
        <DialogHeader><DialogTitle>Replace the database?</DialogTitle>
          <DialogDescription>Everything in the browser right now will be replaced by the file you pick. The app reloads afterwards.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" @click="uploadOpen = false">Cancel</Button><Button variant="destructive" @click="uploadDb">Pick file and replace</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="importPwOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader><DialogTitle>Backup master password</DialogTitle>
          <DialogDescription>This backup was made with a different master password. Enter that one to unlock the account passwords inside it. They will be re-encrypted with your current password.</DialogDescription></DialogHeader>
        <form class="space-y-3" @submit.prevent="runImport(importPw)">
          <div class="space-y-1"><Label for="bk-pw">Password used when the backup was made</Label><Input id="bk-pw" v-model="importPw" type="password" autofocus /></div>
          <DialogFooter><Button type="button" variant="outline" @click="importPwOpen = false">Cancel</Button><Button type="submit">Import</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
