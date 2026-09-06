/**
 * Frees local storage from old, already-read mail. Only prunes IMAP
 * accounts' message bodies/attachments — the header row (subject, from,
 * date, flags) stays, so the message list is unaffected, and the body is
 * fetched again from the server the next time it's opened (`messageGet`'s
 * existing lazy-fetch, `mail-actions.ts`). POP3 accounts have no
 * server-side re-fetch path (the whole message may already be gone from
 * the server after download), so their mail is never pruned here — pruning
 * it would mean losing it for good. Flagged messages are always kept in
 * full, regardless of age.
 */
import { getDb, now, type Row } from './db'
import { log } from './rpc/server'
import { getSetting } from './settings'

export interface PruneResult {
  prunedMessages: number
  prunedAttachments: number
}

export async function pruneOldMail(): Promise<PruneResult> {
  const db = await getDb()
  const cacheDays = await getSetting('mail.cacheDays')
  if (!cacheDays) return { prunedMessages: 0, prunedAttachments: 0 } // 0 = "Everything" — never prune

  const cutoff = now() - cacheDays * 24 * 60 * 60 * 1000
  const rows = await db.all<Row>(
    `SELECT m.id FROM messages m
     JOIN accounts a ON a.id = m.account_id
     WHERE a.kind = 'imap' AND m.body_fetched = 1 AND m.flagged = 0 AND m.date IS NOT NULL AND m.date < ?`,
    [cutoff],
  )
  if (!rows.length) return { prunedMessages: 0, prunedAttachments: 0 }

  let prunedAttachments = 0
  await db.tx(async () => {
    for (const row of rows) {
      const id = Number(row.id)
      prunedAttachments += await db.scalar<number>('SELECT count(*) FROM attachments WHERE message_id = ?', [id])
      await db.exec('DELETE FROM attachments WHERE message_id = ?', [id])
      await db.exec('DELETE FROM message_bodies WHERE message_id = ?', [id])
      await db.exec('UPDATE messages SET body_fetched = 0 WHERE id = ?', [id])
      await db.exec('UPDATE messages_fts SET body = ? WHERE rowid = ?', ['', id])
    }
  })
  log('info', `[cache-prune] freed ${rows.length} message bodies older than ${cacheDays}d (${prunedAttachments} attachments)`)
  return { prunedMessages: rows.length, prunedAttachments }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Runs once shortly after boot, then once a day for as long as this tab stays the leader. */
export function startCachePruneSchedule(): void {
  setTimeout(() => void pruneOldMail().catch(e => log('warn', `[cache-prune] ${(e as Error).message}`)), 30_000)
  setInterval(() => void pruneOldMail().catch(e => log('warn', `[cache-prune] ${(e as Error).message}`)), DAY_MS)
}
