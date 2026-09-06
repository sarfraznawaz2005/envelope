/**
 * Keeps one IMAP account live: connects, syncs every folder's headers, then
 * either IDLEs on the inbox (instant push) or sleeps and polls (NOOP
 * fallback). Reconnects with exponential backoff on any error.
 */
import type { NewMailEvent, SyncStatusEntry } from '@/shared/rpc'
import { getAccount, getCredentials, openImap } from '../accounts'
import { getDb } from '../db'
import type { ImapClient, Untagged } from '../imap/client'
import { log } from '../rpc/server'
import { getLocalFolders, upsertFolders } from './folders'
import { syncFolderHeaders } from './messages'
import { loadRules } from './rules'

const BACKOFF_MIN = 3000
const BACKOFF_MAX = 120000
const NOOP_POLL_MS = 60000

export class ImapAccountRunner {
  private stopped = true
  private client: ImapClient | null = null
  private backoff = BACKOFF_MIN
  private wake: (() => void) | null = null
  private accountId: number
  private onStatus: (s: SyncStatusEntry) => void
  private onNewMail: (msgs: NewMailEvent[]) => void
  status: SyncStatusEntry

  constructor(accountId: number, onStatus: (s: SyncStatusEntry) => void, onNewMail: (msgs: NewMailEvent[]) => void) {
    this.accountId = accountId
    this.onStatus = onStatus
    this.onNewMail = onNewMail
    this.status = { accountId, state: 'stopped', lastSyncAt: null, error: null, idle: false }
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    void this.loop()
  }

  stop() {
    this.stopped = true
    this.wake?.()
    this.wake = null
    this.client?.close()
    this.client = null
    this.setStatus({ state: 'stopped' })
  }

  /** Wake a sleeping/idling connection and sync right away. */
  kick() {
    this.wake?.()
  }

  private setStatus(patch: Partial<SyncStatusEntry>) {
    this.status = { ...this.status, ...patch }
    this.onStatus(this.status)
  }

  private sleepCancelable(ms: number): Promise<void> {
    return new Promise(resolve => {
      const t = setTimeout(() => {
        this.wake = null
        resolve()
      }, ms)
      this.wake = () => {
        clearTimeout(t)
        this.wake = null
        resolve()
      }
    })
  }

  private async loop() {
    while (!this.stopped) {
      try {
        await this.runOnce()
        this.backoff = BACKOFF_MIN
      } catch (e) {
        if (this.stopped) break
        const msg = (e as Error).message
        this.setStatus({ state: 'error', error: msg })
        log('warn', `[sync account ${this.accountId}] ${msg} — retrying in ${Math.round(this.backoff / 1000)}s`)
        await this.sleepCancelable(this.backoff)
        this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX)
      }
    }
  }

  private async runOnce() {
    this.setStatus({ state: 'connecting', error: null })
    const db = await getDb()
    const account = await getAccount(this.accountId)
    const creds = await getCredentials(account)
    const client = await openImap(account, creds)
    this.client = client
    let closedErr: Error | null = null
    client.onClose = err => {
      closedErr = err
    }
    try {
      const rules = await loadRules(db, this.accountId)
      while (!this.stopped && !client.closed) {
        this.setStatus({ state: 'syncing' })
        const boxes = await client.list()
        await upsertFolders(db, this.accountId, boxes)
        const localFolders = (await getLocalFolders(db, this.accountId)).filter(f => f.selectable)
        const allNew: NewMailEvent[] = []
        for (const f of localFolders) {
          if (this.stopped || client.closed) break
          const created = await syncFolderHeaders(db, client, this.accountId, f, rules)
          allNew.push(...created)
        }
        this.setStatus({ state: 'idle', lastSyncAt: Date.now() })
        if (allNew.length) this.onNewMail(allNew)
        if (this.stopped) break

        const inbox = localFolders.find(f => f.role === 'inbox') ?? localFolders[0]
        const pollMs = Math.max(NOOP_POLL_MS, (account.pollMinutes || 5) * 60000)
        if (client.supportsIdle && inbox) {
          this.setStatus({ idle: true })
          await this.idleForUpTo(client, inbox.path, pollMs)
          this.setStatus({ idle: false })
        } else {
          await this.sleepCancelable(NOOP_POLL_MS)
          if (!this.stopped) await client.noop().catch(() => {})
        }
        if (closedErr) throw closedErr
      }
      if (closedErr) throw closedErr
    } finally {
      this.client = null
      client.close()
    }
  }

  /** IDLE until new mail arrives, `ms` elapses, or someone calls kick()/stop(). */
  private async idleForUpTo(client: ImapClient, folderPath: string, ms: number) {
    await client.select(folderPath, true)
    const prevHandler = client.onUnsolicited
    let resolveWake: (() => void) | null = null
    client.onUnsolicited = (u: Untagged) => {
      prevHandler?.(u)
      if (u.type === 'EXISTS' || u.type === 'EXPUNGE') resolveWake?.()
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      await client.startIdle()
      await new Promise<void>(resolve => {
        resolveWake = resolve
        timer = setTimeout(resolve, ms)
        this.wake = resolve
      })
    } finally {
      if (timer) clearTimeout(timer)
      client.onUnsolicited = prevHandler
      this.wake = null
      await client.stopIdle().catch(() => {})
    }
  }
}
