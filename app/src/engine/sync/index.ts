/**
 * Starts/stops one runner per enabled account and fans their events out
 * through the RPC layer. Call `startSyncEngine()` once at worker boot, and
 * `restartAccount`/`stopAccount` whenever accounts change.
 */
import type { NewMailEvent, SyncStatusEntry } from '@/shared/rpc'
import { listAccounts } from '../accounts'
import { emit } from '../rpc/server'
import { ImapAccountRunner } from './imap-runner'
import { Pop3AccountRunner } from './pop3-runner'

type Runner = ImapAccountRunner | Pop3AccountRunner

const runners = new Map<number, Runner>()
const statuses = new Map<number, SyncStatusEntry>()

function onStatus(s: SyncStatusEntry) {
  statuses.set(s.accountId, s)
  emit('sync:status', s)
}

function onNewMail(msgs: NewMailEvent[]) {
  if (!msgs.length) return
  emit('folders:changed', { accountId: msgs[0]!.accountId })
  for (const m of msgs) emit('mail:new', m)
}

export async function startSyncEngine() {
  const accounts = await listAccounts()
  for (const a of accounts) if (a.enabled) startAccount(a.id, a.kind)
}

export function startAccount(accountId: number, kind: 'imap' | 'pop3') {
  stopAccount(accountId)
  const runner = kind === 'imap' ? new ImapAccountRunner(accountId, onStatus, onNewMail) : new Pop3AccountRunner(accountId, onStatus, onNewMail)
  runners.set(accountId, runner)
  runner.start()
}

export function stopAccount(accountId: number) {
  const r = runners.get(accountId)
  if (r) {
    r.stop()
    runners.delete(accountId)
  }
  statuses.delete(accountId)
}

/** Stops every account's sync loop. Used before a whole-database restore/import so no
 * in-flight sync write can race the restore. */
export function stopAllAccounts() {
  for (const id of [...runners.keys()]) stopAccount(id)
}

/** Call after an account is created/edited/enabled/disabled. */
export async function restartAccount(accountId: number) {
  const accounts = await listAccounts()
  const a = accounts.find(x => x.id === accountId)
  if (!a || !a.enabled) {
    stopAccount(accountId)
    return
  }
  startAccount(a.id, a.kind)
}

/** Wake a waiting/idling account (or all of them) and sync right away. */
export function syncNow(accountId?: number) {
  if (accountId != null) {
    runners.get(accountId)?.kick()
    return
  }
  for (const r of runners.values()) r.kick()
}

export function getSyncStatuses(): SyncStatusEntry[] {
  return [...statuses.values()]
}
