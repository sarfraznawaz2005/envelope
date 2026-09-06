/**
 * Engine Worker entry point.
 * Owns the database and all mail connections. The UI never touches those.
 * Talks to the UI only through the RPC layer.
 */
import { ENGINE_VERSION, type EngineStatus } from '@/shared/rpc'
import { deleteAccount, devFetchRecent, devListFolders, devSendMail, listAccounts, saveAccount, testAccount } from './accounts'
import { backupExport, backupImport, dbDump, dbImport } from './backup'
import { changeMasterPassword, forgetDevice, lock, securityStatus, setupMasterPassword, tryAutoUnlock, unlock } from './crypto/master'
import { getDb } from './db'
import { RelaySocket, LineReader } from './net/relay-socket'
import { emit, log, serveRpc } from './rpc/server'
import { getAllSettings, setSetting } from './settings'
import { pruneOldMail, startCachePruneSchedule } from './cache-prune'
import { emptyData, folderStorage, storageStats } from './storage'
import { composeSend } from './compose'
import {
  contactDelete,
  contactFindByEmail,
  contactGet,
  contactGroupCreate,
  contactGroupsList,
  contactMoveToSaved,
  contactSave,
  contactsAutocomplete,
  contactsExportVcf,
  contactsImportVcf,
  contactsList,
} from './contacts'
import { getSignature, setSignature } from './signatures'
import { ruleDelete, ruleSave, rulesList, rulesReorder, rulesRunNow } from './rules'
import { draftDelete, draftGet, draftSave } from './drafts'
import { listFoldersForApi } from './sync/folders'
import { getSyncStatuses, restartAccount, startSyncEngine, stopAccount, syncNow } from './sync'
import { countMessagesInFolders, listMessagesInFolders, listThreadMessages, searchMessages } from './sync/messages'
import {
  attachmentGet,
  imagesAllowSender,
  imagesIsSenderAllowed,
  imagesListAllowed,
  imagesRemoveSender,
  messageArchive,
  messageDelete,
  messageGet,
  messageGetSource,
  messageMoveToFolder,
  messageSetFlag,
  messageSpam,
} from './mail-actions'

const startedAt = Date.now()
let storage: EngineStatus['storage'] = 'none'
let dbReady = false

// Open the database at start. RPC handlers await this before touching data.
const boot = (async () => {
  try {
    const db = await getDb()
    storage = db.mode
    dbReady = true
    log('info', `SQLite ${db.sqliteVersion} open via ${db.mode}`)
    await tryAutoUnlock()
  } catch (e) {
    log('error', `Database failed to open: ${(e as Error).message}`)
    throw e
  }
})()

serveRpc({
  async ping() {
    return 'pong' as const
  },

  async getStatus(): Promise<EngineStatus> {
    let sqliteVersion = ''
    if (dbReady) sqliteVersion = (await getDb()).sqliteVersion
    return { version: ENGINE_VERSION, startedAt, isLeader: true, storage, sqliteVersion, dbReady }
  },

  // ---------- relay + sockets ----------

  async testRelay(relayUrl, token) {
    try {
      const u = new URL(relayUrl)
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
      u.pathname = '/health'
      u.search = ''
      const res = await fetch(u.toString(), { headers: token ? { 'x-relay-token': token } : {} })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = (await res.json()) as { version?: string }
      emit('relay:status', { connected: true, version: j.version })
      return { ok: true as const, version: j.version ?? '?' }
    } catch (e) {
      const msg = (e as Error).message
      emit('relay:status', { connected: false, error: msg })
      return { ok: false as const, error: msg }
    }
  },

  async testSocket({ relayUrl, token, host, port, tls }) {
    const t0 = performance.now()
    let sock: RelaySocket | null = null
    try {
      sock = await RelaySocket.connect({ relayUrl, token, host, port, tls })
      const reader = new LineReader(sock)
      const greeting = (await reader.readLine()) ?? ''
      log('info', `${host}:${port} greeted: ${greeting}`)
      return { ok: true as const, greeting, ms: Math.round(performance.now() - t0) }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    } finally {
      sock?.close()
    }
  },

  // ---------- settings ----------

  async settingsGetAll() {
    await boot
    return getAllSettings()
  },
  async settingsSet(key, value) {
    await boot
    await setSetting(key, value)
    if (key === 'mail.cacheDays') void pruneOldMail().catch(e => log('warn', `[cache-prune] ${(e as Error).message}`))
  },

  // ---------- security ----------

  async securityStatus() {
    await boot
    return securityStatus()
  },
  async securitySetup(password, remember) {
    await boot
    const s = await setupMasterPassword(password, remember)
    syncNow()
    return s
  },
  async securityUnlock(password, remember) {
    await boot
    const s = await unlock(password, remember)
    syncNow()
    return s
  },
  async securityLock() {
    await boot
    return lock()
  },
  async securityChange(oldPassword, newPassword) {
    await boot
    return changeMasterPassword(oldPassword, newPassword)
  },
  async securityForgetDevice() {
    await boot
    return forgetDevice()
  },

  // ---------- storage ----------

  async storageStats() {
    await boot
    return storageStats()
  },
  async folderStorage(accountId) {
    await boot
    return folderStorage(accountId)
  },
  async emptyData(scope) {
    await boot
    return emptyData(scope)
  },

  // ---------- backup ----------

  async backupExport(opts) {
    await boot
    return backupExport(opts)
  },
  async backupImport(file, backupPassword) {
    await boot
    return backupImport(file, backupPassword)
  },
  async dbDump() {
    await boot
    return dbDump()
  },
  async dbImport(bytes) {
    await boot
    return dbImport(bytes)
  },

  // ---------- accounts ----------

  async accountsList() {
    await boot
    return listAccounts()
  },
  async accountsSave(input) {
    await boot
    const a = await saveAccount(input)
    emit('accounts:changed', { id: a.id })
    await restartAccount(a.id)
    return a
  },
  async accountsDelete(id) {
    await boot
    stopAccount(id)
    await deleteAccount(id)
    emit('accounts:changed', { id })
  },
  async accountsTest(input) {
    await boot
    return testAccount(input)
  },

  // ---------- dev ----------

  async devListFolders(accountId) {
    await boot
    return devListFolders(accountId)
  },
  async devFetchRecent(accountId, path, n) {
    await boot
    return devFetchRecent(accountId, path, n)
  },
  async devSendMail(accountId, to, subject, text) {
    await boot
    return devSendMail(accountId, to, subject, text)
  },

  // ---------- sync ----------

  async syncStatus() {
    await boot
    return getSyncStatuses()
  },
  async syncNow(accountId) {
    await boot
    syncNow(accountId)
  },
  async foldersList(accountId) {
    await boot
    return listFoldersForApi(await getDb(), accountId)
  },

  // ---------- mail ----------

  async messagesList(folderIds, limit, offset) {
    await boot
    return listMessagesInFolders(await getDb(), folderIds, limit, offset)
  },
  async messagesCount(folderIds) {
    await boot
    return countMessagesInFolders(await getDb(), folderIds)
  },
  async searchMessages(query, opts) {
    await boot
    return searchMessages(await getDb(), query, opts)
  },
  async messageGet(id) {
    await boot
    return messageGet(id)
  },
  async messageGetSource(id) {
    await boot
    return messageGetSource(id)
  },
  async threadMessages(id) {
    await boot
    return listThreadMessages(await getDb(), id)
  },
  async messageSetFlag(id, flag, value) {
    await boot
    return messageSetFlag(id, flag, value)
  },
  async messageMoveToFolder(id, destFolderId) {
    await boot
    return messageMoveToFolder(id, destFolderId)
  },
  async messageArchive(id) {
    await boot
    return messageArchive(id)
  },
  async messageSpam(id) {
    await boot
    return messageSpam(id)
  },
  async messageDelete(id) {
    await boot
    return messageDelete(id)
  },
  async attachmentGet(id) {
    await boot
    return attachmentGet(id)
  },
  async imagesIsSenderAllowed(address) {
    await boot
    return imagesIsSenderAllowed(address)
  },
  async imagesAllowSender(address) {
    await boot
    return imagesAllowSender(address)
  },
  async imagesListAllowed() {
    await boot
    return imagesListAllowed()
  },
  async imagesRemoveSender(address) {
    await boot
    return imagesRemoveSender(address)
  },

  // ---------- compose ----------

  async contactsAutocomplete(query) {
    await boot
    return contactsAutocomplete(query)
  },

  // ---------- contacts ----------

  async contactsList(filter) {
    await boot
    return contactsList(filter)
  },
  async contactGet(id) {
    await boot
    return contactGet(id)
  },
  async contactFindByEmail(email) {
    await boot
    return contactFindByEmail(email)
  },
  async contactSave(input) {
    await boot
    return contactSave(input)
  },
  async contactDelete(id) {
    await boot
    return contactDelete(id)
  },
  async contactMoveToSaved(id) {
    await boot
    return contactMoveToSaved(id)
  },
  async contactGroupsList() {
    await boot
    return contactGroupsList()
  },
  async contactGroupCreate(name) {
    await boot
    return contactGroupCreate(name)
  },
  async contactsExportVcf(ids) {
    await boot
    return contactsExportVcf(ids)
  },
  async contactsImportVcf(text) {
    await boot
    return contactsImportVcf(text)
  },

  // ---------- rules ----------

  async rulesList() {
    await boot
    return rulesList()
  },
  async ruleSave(input) {
    await boot
    return ruleSave(input)
  },
  async ruleDelete(id) {
    await boot
    return ruleDelete(id)
  },
  async rulesReorder(orderedIds) {
    await boot
    return rulesReorder(orderedIds)
  },
  async rulesRunNow(folderId) {
    await boot
    return rulesRunNow(folderId)
  },

  async signatureGet(accountId) {
    await boot
    return getSignature(accountId)
  },
  async signatureSet(accountId, input) {
    await boot
    return setSignature(accountId, input)
  },
  async draftSave(input) {
    await boot
    return draftSave(input)
  },
  async draftGet(id) {
    await boot
    return draftGet(id)
  },
  async draftDelete(id) {
    await boot
    return draftDelete(id)
  },
  async composeSend(input) {
    await boot
    return composeSend(input)
  },
})

boot.then(
  () => {
    emit('engine:ready', { version: ENGINE_VERSION, storage })
    void startSyncEngine()
    startCachePruneSchedule()
  },
  () => emit('engine:ready', { version: ENGINE_VERSION, storage: 'none' }),
)
