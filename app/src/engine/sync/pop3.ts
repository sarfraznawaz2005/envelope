/**
 * POP3 sync: UIDL to find messages we have not downloaded yet, RETR the new
 * ones, and honor "leave on server" / "delete after N days".
 * POP3 has no numeric UID, so messages.uid is a hash of the UIDL string.
 */
import type { NewMailEvent } from '@/shared/rpc'
import type { Database, Row } from '../db'
import { now } from '../db'
import { makeSnippet, parseMessage } from '../mime/parse'
import type { Pop3Client } from '../pop3/client'
import type { LocalFolder } from './folders'
import { applyRulesLocal, type Rule, type RuleMatchable } from './rules'
import { normalizeSubject } from './threads'

/** FNV-1a, kept positive so it fits SQLite's INTEGER column. */
export function hashUidl(uidl: string): number {
  let h = 2166136261
  for (let i = 0; i < uidl.length; i++) {
    h ^= uidl.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 1
}

async function linkThread(db: Database, accountId: number, subject: string, dateMs: number | null): Promise<number> {
  const norm = normalizeSubject(subject)
  const existing = await db.get<Row>('SELECT id, first_date, last_date FROM threads WHERE account_id = ? AND subject_norm = ? ORDER BY last_date DESC LIMIT 1', [
    accountId,
    norm,
  ])
  if (existing) {
    const id = Number(existing.id)
    const first = existing.first_date == null ? dateMs : Math.min(Number(existing.first_date), dateMs ?? Number(existing.first_date))
    const last = existing.last_date == null ? dateMs : Math.max(Number(existing.last_date), dateMs ?? Number(existing.last_date))
    await db.exec('UPDATE threads SET count = count + 1, first_date = ?, last_date = ? WHERE id = ?', [first, last, id])
    return id
  }
  return db.insert('INSERT INTO threads (account_id, subject_norm, first_date, last_date, count, unread) VALUES (?, ?, ?, ?, 1, 0)', [
    accountId,
    norm,
    dateMs,
    dateMs,
  ])
}

export async function syncPop3Inbox(
  db: Database,
  client: Pop3Client,
  accountId: number,
  folder: LocalFolder,
  popLeaveOnServer: boolean,
  popDeleteAfterDays: number,
  rules: Rule[],
): Promise<NewMailEvent[]> {
  const items = await client.uidl()
  const seenRows = await db.all<Row>('SELECT uidl, first_seen_at FROM pop3_seen WHERE account_id = ?', [accountId])
  const seen = new Set(seenRows.map(r => String(r.uidl)))
  const created: NewMailEvent[] = []

  for (const it of items) {
    if (seen.has(it.uid)) continue
    const raw = await client.retr(it.num)
    const parsed = await parseMessage(raw)
    const dateMs = parsed.date ? parsed.date.getTime() : Date.now()
    const uidNum = hashUidl(it.uid)
    const snippet = makeSnippet(parsed.text, parsed.html)

    const cols: Record<string, unknown> = {
      account_id: accountId,
      folder_id: folder.id,
      uid: uidNum,
      message_id: parsed.messageId,
      in_reply_to: parsed.inReplyTo,
      refs: JSON.stringify(parsed.references),
      subject: parsed.subject,
      from_json: JSON.stringify(parsed.from),
      to_json: JSON.stringify(parsed.to),
      cc_json: JSON.stringify(parsed.cc),
      bcc_json: JSON.stringify(parsed.bcc),
      reply_to_json: JSON.stringify(parsed.replyTo),
      date: dateMs,
      internal_date: dateMs,
      size: raw.byteLength,
      flags: '[]',
      seen: 0,
      has_attachments: parsed.attachments.length ? 1 : 0,
      snippet,
      body_fetched: 1,
      created_at: now(),
    }
    const keys = Object.keys(cols)
    const vals = keys.map(k => cols[k] as never)
    const fromText = parsed.from.map(a => `${a.name} ${a.address}`).join(' ')
    const toText = parsed.to.map(a => `${a.name} ${a.address}`).join(' ')

    // Everything DB-side for this message (row, body, thread link, FTS, rule outcome, and the
    // pop3_seen marker) happens in one transaction. POP3 has no server-side re-fetch once a
    // UIDL is marked seen, so previously an interruption between these statements could leave
    // a message permanently stuck with no body — this makes it all-or-nothing so a retry after
    // interruption starts clean instead of half-done.
    let msgId: number | null = null
    let movedAway = false
    await db.tx(async () => {
      await db.raw.run(`INSERT INTO messages (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) ON CONFLICT(folder_id, uid) DO NOTHING`, vals)
      const changed = Number(db.raw.changes())
      if (changed) {
        msgId = Number(db.raw.lastInsertRowId())
        await db.exec('INSERT INTO message_bodies (message_id, text, html, headers, raw, fetched_at) VALUES (?, ?, ?, ?, ?, ?)', [
          msgId,
          parsed.text,
          parsed.html,
          JSON.stringify(parsed.headers),
          raw,
          now(),
        ])
        const threadId = await linkThread(db, accountId, parsed.subject, dateMs)
        await db.exec('UPDATE messages SET thread_id = ? WHERE id = ?', [threadId, msgId])
        await db.exec('UPDATE threads SET unread = unread + 1 WHERE id = ?', [threadId])
        await db.exec('INSERT INTO messages_fts (rowid, subject, from_text, to_text, body) VALUES (?, ?, ?, ?, ?)', [msgId, parsed.subject, fromText, toText, parsed.text ?? ''])

        if (rules.length) {
          const matchable: RuleMatchable = {
            subject: parsed.subject,
            from: fromText,
            to: toText,
            fromAddresses: parsed.from.map(a => a.address),
            toAddresses: parsed.to.map(a => a.address),
            hasAttachments: parsed.attachments.length > 0,
          }
          const r = await applyRulesLocal(db, msgId, matchable, rules)
          movedAway = r.movedAway
        }
      }
      await db.exec('INSERT OR REPLACE INTO pop3_seen (account_id, uidl, message_id, first_seen_at) VALUES (?, ?, ?, ?)', [accountId, it.uid, msgId, now()])
    })
    if (msgId != null && !movedAway) {
      created.push({
        id: msgId,
        accountId,
        folderId: folder.id,
        folderPath: folder.path,
        uid: uidNum,
        subject: parsed.subject,
        from: fromText.trim() || parsed.from.map(a => a.address).join(', '),
        date: dateMs,
        snippet,
      })
    }
    if (!popLeaveOnServer) await client.dele(it.num).catch(() => {})
  }

  if (popLeaveOnServer && popDeleteAfterDays > 0) {
    const cutoff = now() - popDeleteAfterDays * 86400000
    const stale = await db.all<Row>('SELECT uidl FROM pop3_seen WHERE account_id = ? AND first_seen_at < ?', [accountId, cutoff])
    for (const s of stale) {
      const match = items.find(it => it.uid === String(s.uidl))
      if (match) await client.dele(match.num).catch(() => {})
    }
  }

  const total = await db.scalar<number>('SELECT COUNT(*) FROM messages WHERE folder_id = ?', [folder.id])
  const unread = await db.scalar<number>('SELECT COUNT(*) FROM messages WHERE folder_id = ? AND seen = 0', [folder.id])
  await db.exec('UPDATE folders SET total = ?, unread = ?, last_sync_at = ? WHERE id = ?', [total, unread, now(), folder.id])

  return created
}
