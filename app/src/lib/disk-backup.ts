/**
 * Disk auto-save with the File System Access API (Chrome / Edge).
 *
 * The user picks a folder once. We keep the folder handle in IndexedDB.
 * On a timer, and on close, we write:
 *   mailclient.db               whole SQLite file (atomic swap by the browser)
 *   mailclient-settings.json    accounts / settings / contacts / rules
 *
 * Firefox and Safari have no picker. They get manual download / upload
 * (see SettingsStorage.vue), built on the same engine calls.
 */
import { useEngine } from '@/engine'
import { metaDel, metaGet, metaSet } from '@/shared/idb-meta'
import { useSettingsStore } from '@/stores/settings'
import { computed, ref, shallowRef, watch } from 'vue'

const HANDLE_KEY = 'backup.dirHandle'
const DB_NAME = 'mailclient.db'
const SETTINGS_NAME = 'mailclient-settings.json'

type Perm = 'granted' | 'prompt' | 'denied'

const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window
const handle = shallowRef<FileSystemDirectoryHandle | null>(null)
const permission = ref<Perm | null>(null)
const saving = ref(false)
const lastError = ref<string | null>(null)
let timer: number | null = null
let initialised = false

async function queryPerm(h: FileSystemDirectoryHandle): Promise<Perm> {
  try {
    return (await h.queryPermission({ mode: 'readwrite' })) as Perm
  } catch {
    return 'denied'
  }
}

async function init() {
  if (initialised || !supported) return
  initialised = true
  try {
    const h = await metaGet<FileSystemDirectoryHandle>(HANDLE_KEY)
    if (h) {
      handle.value = h
      permission.value = await queryPerm(h)
    }
  } catch (e) {
    lastError.value = (e as Error).message
  }
}

async function pickFolder() {
  const h = await window.showDirectoryPicker({ id: 'mailclient-data', mode: 'readwrite', startIn: 'documents' })
  await metaSet(HANDLE_KEY, h)
  handle.value = h
  permission.value = await queryPerm(h)
  const s = useSettingsStore()
  await s.set('backup.disk.folderName', h.name)
  await s.set('backup.disk.enabled', true)
}

/** Must be called from a user gesture (click). */
async function requestPermission(): Promise<boolean> {
  const h = handle.value
  if (!h) return false
  try {
    permission.value = (await h.requestPermission({ mode: 'readwrite' })) as Perm
  } catch {
    permission.value = 'denied'
  }
  return permission.value === 'granted'
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob | Uint8Array | string) {
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable({ keepExistingData: false })
  await w.write(data as FileSystemWriteChunkType)
  await w.close()
}

async function saveNow(): Promise<boolean> {
  const h = handle.value
  if (!h || saving.value) return false
  if ((await queryPerm(h)) !== 'granted') {
    permission.value = 'prompt'
    return false
  }
  saving.value = true
  lastError.value = null
  try {
    const engine = useEngine()
    const bytes = await engine.api.dbDump()
    await writeFile(h, DB_NAME, bytes)
    const json = await engine.api.backupExport({ accounts: true, settings: true, contacts: true, rules: true, signatures: true })
    await writeFile(h, SETTINGS_NAME, JSON.stringify(json, null, 2))
    await useSettingsStore().set('backup.disk.lastSavedAt', Date.now())
    return true
  } catch (e) {
    lastError.value = (e as Error).message
    return false
  } finally {
    saving.value = false
  }
}

async function readDiskDb(): Promise<{ bytes: Uint8Array; modified: number } | null> {
  const h = handle.value
  if (!h) return null
  try {
    const fh = await h.getFileHandle(DB_NAME)
    const f = await fh.getFile()
    return { bytes: new Uint8Array(await f.arrayBuffer()), modified: f.lastModified }
  } catch {
    return null
  }
}

/** Replace the browser database with the disk copy, then reload. */
async function restoreFromDisk(): Promise<boolean> {
  const d = await readDiskDb()
  if (!d) throw new Error(`No ${DB_NAME} in the chosen folder.`)
  await useEngine().api.dbImport(d.bytes)
  location.reload()
  return true
}

async function forget() {
  await metaDel(HANDLE_KEY)
  handle.value = null
  permission.value = null
  const s = useSettingsStore()
  await s.set('backup.disk.enabled', false)
  await s.set('backup.disk.folderName', null)
}

function schedule() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  const s = useSettingsStore()
  if (!supported || !s.values['backup.disk.enabled'] || !handle.value) return
  const mins = Math.max(1, s.values['backup.disk.intervalMin'])
  timer = window.setInterval(() => void saveNow(), mins * 60_000)
}

function onPageHide() {
  const s = useSettingsStore()
  if (!s.values['backup.disk.enabled'] || !s.values['backup.disk.onClose']) return
  // Best effort. The browser may not wait for this. The timer save is the real safety net.
  void saveNow()
}

let wired = false
export function useDiskBackup() {
  const settings = useSettingsStore()
  if (!wired && supported) {
    wired = true
    void init()
    watch(
      () => [settings.values['backup.disk.enabled'], settings.values['backup.disk.intervalMin'], handle.value] as const,
      schedule,
      { immediate: true },
    )
    window.addEventListener('pagehide', onPageHide)
  }

  return {
    supported,
    handle,
    permission,
    saving,
    lastError,
    folderName: computed(() => settings.values['backup.disk.folderName']),
    lastSavedAt: computed(() => settings.values['backup.disk.lastSavedAt']),
    enabled: computed(() => settings.values['backup.disk.enabled']),
    pickFolder,
    requestPermission,
    saveNow,
    readDiskDb,
    restoreFromDisk,
    forget,
  }
}
