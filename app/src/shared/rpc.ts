/**
 * Message shapes between the UI thread and the Engine Worker.
 * Both sides import this file. Keep it free of DOM and worker globals.
 */
import type { Account, AccountInput, AccountTestResult } from './accounts'
import type { Settings } from './settings'

/** UI -> worker: call a method */
export interface RpcRequest {
  kind: 'req'
  id: number
  method: string
  args: unknown[]
}

/** worker -> UI: answer to a request */
export interface RpcResponse {
  kind: 'res'
  id: number
  ok: boolean
  result?: unknown
  error?: { message: string; name?: string; stack?: string }
}

/** worker -> UI: something happened (new mail, sync state, ...) */
export interface RpcEvent {
  kind: 'evt'
  event: string
  data: unknown
}

export type WorkerToUi = RpcResponse | RpcEvent
export type UiToWorker = RpcRequest

// ---------- shared shapes ----------

export interface EngineStatus {
  version: string
  startedAt: number
  isLeader: boolean
  /** which SQLite storage driver is in use */
  storage: 'opfs-wa' | 'opfs' | 'idb' | 'none'
  sqliteVersion: string
  dbReady: boolean
}

export interface SecurityStatus {
  hasPassword: boolean
  unlocked: boolean
  /** true if a device-remembered key auto-unlocked this session */
  remembered: boolean
  rememberExpiresAt: number | null
}

export interface StorageStats {
  usage: number
  quota: number
  persisted: boolean
  dbBytes: number
  counts: {
    accounts: number
    folders: number
    messages: number
    bodies: number
    attachments: number
    attachmentBytes: number
    contacts: number
    collectedContacts: number
    rules: number
  }
}

export type EmptyScope =
  | { kind: 'folder'; folderId: number }
  | { kind: 'account'; accountId: number }
  | { kind: 'attachments' }
  | { kind: 'collected-contacts' }
  | { kind: 'search-index' }
  | { kind: 'all-mail' }
  | { kind: 'everything' }

export interface BackupOptions {
  accounts: boolean
  settings: boolean
  contacts: boolean
  rules: boolean
  signatures: boolean
}

export interface BackupFile {
  format: 'mailclient-backup'
  version: 1
  exportedAt: string
  appVersion: string
  /** key-derivation params, so the file can be opened with its own master password */
  kdf?: { salt: string; iterations: number; verifier: string; verifierIv: string }
  settings?: Partial<Settings>
  accounts?: Array<Record<string, unknown> & { secrets: Record<string, { ct: string; iv: string }> }>
  contacts?: Array<Record<string, unknown>>
  rules?: Array<Record<string, unknown>>
  signatures?: Array<Record<string, unknown>>
  senderImageAllow?: string[]
}

export interface ImportResult {
  accounts: number
  settings: number
  contacts: number
  rules: number
  signatures: number
  needsBackupPassword?: boolean
}

// ---------- sync ----------

export type SyncState = 'idle' | 'connecting' | 'syncing' | 'error' | 'stopped'

export interface SyncStatusEntry {
  accountId: number
  state: SyncState
  lastSyncAt: number | null
  error: string | null
  idle: boolean
}

export interface FolderSummary {
  id: number
  path: string
  name: string
  role: 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'all' | null
  selectable: boolean
  total: number
  unread: number
}

export interface MessageSummary {
  id: number
  accountId: number
  uid: number
  subject: string
  from: string
  date: number | null
  seen: boolean
  flagged: boolean
  hasAttachments: boolean
  /** Number of messages collapsed into this row when "Group messages into threads" is on. Absent/1 = not a thread. */
  threadCount?: number
}

export interface NewMailEvent {
  id: number
  accountId: number
  folderId: number
  folderPath: string
  uid: number
  subject: string
  from: string
  date: number | null
  snippet: string
}

// ---------- message detail + actions (Phase 6) ----------

export interface MessageAddress {
  name: string
  address: string
}

export interface MessageAttachment {
  id: number
  filename: string
  mime: string
  size: number
  contentId: string | null
  disposition: string
}

export interface MessageDetail {
  id: number
  accountId: number
  folderId: number
  uid: number
  subject: string
  from: MessageAddress[]
  to: MessageAddress[]
  cc: MessageAddress[]
  bcc: MessageAddress[]
  date: number | null
  seen: boolean
  flagged: boolean
  text: string | null
  html: string | null
  attachments: MessageAttachment[]
}

export type MessageFlagName = 'seen' | 'flagged' | 'answered'

// ---------- compose (Phase 7) ----------

export interface ContactSuggestion {
  name: string
  address: string
}

// ---------- contacts (Phase 8) ----------

export interface ContactEmail {
  email: string
  label: string
  isPrimary: boolean
}

export interface Contact {
  id: number
  firstName: string
  lastName: string
  displayName: string
  phone: string
  notes: string
  kind: 'saved' | 'collected'
  lastMailAt: number | null
  emails: ContactEmail[]
  groups: string[]
}

export interface ContactInput {
  id?: number
  firstName: string
  lastName: string
  phone: string
  notes: string
  emails: ContactEmail[]
  groups: string[]
}

export interface ContactGroup {
  id: number
  name: string
  count: number
}

export interface ContactsListFilter {
  kind?: 'saved' | 'collected'
  groupId?: number
  query?: string
}

// ---------- rules (Phase 9) ----------

export type RuleField = 'subject' | 'from' | 'to' | 'hasAttachment'
export type RuleOp = 'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith' | 'regex'
export type RuleActionKind = 'markRead' | 'flag' | 'move' | 'spam' | 'delete' | 'stop'

export interface RuleConditionInput {
  field: RuleField
  op: RuleOp
  value: string
}

export interface RuleActionInput {
  kind: RuleActionKind
  /** destination folder path, for kind === 'move' */
  arg: string
}

export interface RuleRecord {
  id: number
  name: string
  enabled: boolean
  matchMode: 'any' | 'all'
  /** null = applies to every account */
  accountId: number | null
  sortOrder: number
  conditions: RuleConditionInput[]
  actions: RuleActionInput[]
}

export interface RuleInput {
  id?: number
  name: string
  enabled: boolean
  matchMode: 'any' | 'all'
  accountId: number | null
  conditions: RuleConditionInput[]
  actions: RuleActionInput[]
}

export interface SignatureInput {
  isHtml: boolean
  content: string
  position: 'above' | 'below'
  useOnReply: boolean
}
export interface Signature extends SignatureInput {
  accountId: number
}

export type ReplyMode = 'reply' | 'replyAll' | 'forward'

export interface DraftInput {
  id: string
  accountId: number
  to: MessageAddress[]
  cc: MessageAddress[]
  bcc: MessageAddress[]
  subject: string
  isHtml: boolean
  body: string
  inReplyToId?: number | null
  replyMode?: ReplyMode | null
}
export interface DraftRecord extends DraftInput {
  updatedAt: number
}

export interface ComposeAttachment {
  filename: string
  mime: string
  data: Uint8Array
  /** set for an inline image referenced as cid: in the html */
  cid?: string
}

export interface ComposeSendInput {
  accountId: number
  to: MessageAddress[]
  cc: MessageAddress[]
  bcc: MessageAddress[]
  subject: string
  html?: string
  text?: string
  attachments: ComposeAttachment[]
  inReplyToId?: number | null
}

// ---------- events ----------

export interface EngineEvents {
  'engine:ready': { version: string; storage: EngineStatus['storage'] }
  'engine:log': { level: 'debug' | 'info' | 'warn' | 'error'; msg: string }
  'relay:status': { connected: boolean; version?: string; error?: string }
  'security:status': SecurityStatus
  'settings:changed': { key: keyof Settings; value: unknown }
  'data:emptied': { scope: EmptyScope }
  'accounts:changed': { id: number | null }
  'sync:status': SyncStatusEntry
  'folders:changed': { accountId: number }
  'mail:new': NewMailEvent
}

// ---------- methods ----------

export interface EngineApi {
  ping(): Promise<'pong'>
  getStatus(): Promise<EngineStatus>

  // relay + sockets
  testRelay(relayUrl: string, token?: string): Promise<{ ok: true; version: string } | { ok: false; error: string }>
  testSocket(opts: { relayUrl: string; token?: string; host: string; port: number; tls: boolean }): Promise<
    { ok: true; greeting: string; ms: number } | { ok: false; error: string }
  >

  // settings
  settingsGetAll(): Promise<Settings>
  settingsSet<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>

  // security / master password
  securityStatus(): Promise<SecurityStatus>
  securitySetup(password: string, remember: boolean): Promise<SecurityStatus>
  securityUnlock(password: string, remember: boolean): Promise<SecurityStatus>
  securityLock(): Promise<SecurityStatus>
  securityChange(oldPassword: string, newPassword: string): Promise<SecurityStatus>
  securityForgetDevice(): Promise<SecurityStatus>

  // storage
  storageStats(): Promise<StorageStats>
  folderStorage(accountId: number): Promise<Record<number, number>>
  emptyData(scope: EmptyScope): Promise<void>

  // backup
  backupExport(opts: BackupOptions): Promise<BackupFile>
  backupImport(file: BackupFile, backupPassword?: string): Promise<ImportResult>
  /** whole SQLite file. Transferred, not copied. */
  dbDump(): Promise<Uint8Array>
  /** replace the whole database. The engine re-opens afterwards. */
  dbImport(bytes: Uint8Array): Promise<void>

  // accounts
  accountsList(): Promise<Account[]>
  accountsSave(input: AccountInput): Promise<Account>
  accountsDelete(id: number): Promise<void>
  accountsTest(input: AccountInput): Promise<AccountTestResult>

  // dev helpers (Phase 4 exit checks)
  devListFolders(accountId: number): Promise<Array<{ path: string; name: string; role: string | null; selectable: boolean }>>
  devFetchRecent(accountId: number, path: string, n: number): Promise<Array<{ uid: number | null; subject: string; from: string; date: string | null; flags: string[]; size: number }>>
  devSendMail(accountId: number, to: string, subject: string, text: string): Promise<{ messageId: string; reply: string }>

  // sync (Phase 5)
  syncStatus(): Promise<SyncStatusEntry[]>
  /** Wake a waiting/idling account and sync right away. Omit accountId to kick all. */
  syncNow(accountId?: number): Promise<void>
  /** Folders as currently known in the local database (fast, no network). */
  foldersList(accountId: number): Promise<FolderSummary[]>

  // mail (Phase 6)
  /** Most recent messages across one or more folders (e.g. all inbox folders for the unified inbox). */
  messagesList(folderIds: number[], limit: number, offset: number): Promise<MessageSummary[]>
  messagesCount(folderIds: number[]): Promise<number>
  /** Local full-text search (subject/from/to/body of already-synced mail). */
  searchMessages(query: string, opts: { folderIds?: number[]; limit?: number }): Promise<MessageSummary[]>
  /** Fetches the body on first open if not already cached. */
  messageGet(id: number): Promise<MessageDetail>
  messageGetSource(id: number): Promise<string>
  /** Every message sharing a thread with this one, oldest first. */
  threadMessages(id: number): Promise<MessageSummary[]>
  messageSetFlag(id: number, flag: MessageFlagName, value: boolean): Promise<void>
  messageMoveToFolder(id: number, destFolderId: number): Promise<void>
  messageArchive(id: number): Promise<void>
  messageSpam(id: number): Promise<void>
  messageDelete(id: number): Promise<void>
  attachmentGet(id: number): Promise<{ filename: string; mime: string; data: Uint8Array }>
  imagesIsSenderAllowed(address: string): Promise<boolean>
  imagesAllowSender(address: string): Promise<void>
  imagesListAllowed(): Promise<string[]>
  imagesRemoveSender(address: string): Promise<void>

  // compose (Phase 7)
  contactsAutocomplete(query: string): Promise<ContactSuggestion[]>

  // contacts (Phase 8)
  contactsList(filter: ContactsListFilter): Promise<Contact[]>
  contactGet(id: number): Promise<Contact | null>
  contactFindByEmail(email: string): Promise<Contact | null>
  contactSave(input: ContactInput): Promise<Contact>
  contactDelete(id: number): Promise<void>
  contactMoveToSaved(id: number): Promise<void>
  contactGroupsList(): Promise<ContactGroup[]>
  contactGroupCreate(name: string): Promise<ContactGroup>
  contactsExportVcf(ids?: number[]): Promise<string>
  contactsImportVcf(text: string): Promise<{ imported: number }>

  // rules (Phase 9)
  rulesList(): Promise<RuleRecord[]>
  ruleSave(input: RuleInput): Promise<RuleRecord>
  ruleDelete(id: number): Promise<void>
  rulesReorder(orderedIds: number[]): Promise<void>
  /** Applies all enabled rules to the mail already synced into this folder. */
  rulesRunNow(folderId: number): Promise<{ scanned: number; matched: number }>

  signatureGet(accountId: number): Promise<Signature | null>
  signatureSet(accountId: number, input: SignatureInput): Promise<void>
  draftSave(input: DraftInput): Promise<void>
  draftGet(id: string): Promise<DraftRecord | null>
  draftDelete(id: string): Promise<void>
  composeSend(input: ComposeSendInput): Promise<{ messageId: string }>
}

export const ENGINE_VERSION = '0.1.0'
