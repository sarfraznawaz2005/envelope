/**
 * Keeps one POP3 account live: polls every `pollMinutes`, no IDLE (POP3 has
 * none). "Sync now" / unlocking the master password can wake it early.
 */
import type { NewMailEvent, SyncStatusEntry } from '@/shared/rpc'
import { getAccount, getCredentials, openPop3 } from '../accounts'
import { getDb } from '../db'
import { ensurePop3Inbox } from './folders'
import { syncPop3Inbox } from './pop3'
import { loadRules } from './rules'

export class Pop3AccountRunner {
  private stopped = true
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
    this.setStatus({ state: 'stopped' })
  }

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
      let pollMinutes = 5
      try {
        pollMinutes = await this.runOnce()
      } catch (e) {
        if (this.stopped) break
        this.setStatus({ state: 'error', error: (e as Error).message })
      }
      if (this.stopped) break
      await this.sleepCancelable(Math.max(60000, pollMinutes * 60000))
    }
  }

  private async runOnce(): Promise<number> {
    this.setStatus({ state: 'connecting', error: null })
    const db = await getDb()
    const account = await getAccount(this.accountId)
    const creds = await getCredentials(account)
    const client = await openPop3(account, creds)
    try {
      this.setStatus({ state: 'syncing' })
      const folder = await ensurePop3Inbox(db, this.accountId)
      const rules = await loadRules(db, this.accountId)
      const created = await syncPop3Inbox(db, client, this.accountId, folder, account.popLeaveOnServer, account.popDeleteAfterDays, rules)
      this.setStatus({ state: 'idle', lastSyncAt: Date.now() })
      if (created.length) this.onNewMail(created)
    } finally {
      await client.quit().catch(() => {})
    }
    return account.pollMinutes || 5
  }
}
