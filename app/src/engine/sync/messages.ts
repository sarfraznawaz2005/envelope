/**
 * Header sync for one IMAP folder: first sync pulls the most recent N
 * messages, later syncs pull only new UIDs, and (when the server supports
 * CONDSTORE) a cheap CHANGEDSINCE pass picks up flag changes.
 */
import type { NewMailEvent, MessageSummary } from '@/shared/rpc'
import { parseBodyStructure, pickBodyParts } from '../imap/bodystructure'
import type { ImapClient } from '../imap/client'
import { parseEnvelope } from '../imap/envelope'
import { tokList, tokStr, type Token } from '../imap/parser'
import type { Database, Param, Row } from '../db'
import { now } from '../db'
import { getSetting } from '../settings'
import type { Rule, RuleMatchable } from './rules'
import { applyRulesImap } from './rules'
import type { LocalFolder } from './folders'
import { normalizeSubject } from './threads'

const INITIAL_INBOX_COUNT = 100
const INITIAL_OTHER_COUNT = 30

function flagList(t: Token | undefined): string[] {
  if (!t) return []
  return tokList(t).map(x => tokStr(x))
}
function hasFlag(flags: string[], f: string): boolean {
  return flags.some(x => x.toLowerCase() === f.toLowerCase())
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

export async function syncFolderHeaders(db: Database, client: ImapClient, accountId: number, folder: LocalFolder, rules: Rule[]): Promise<NewMailEvent[]> {
  const st = await client.select(folder.path, true)
  let uidvalidity = folder.uidvalidity
  if (uidvalidity != null && st.uidValidity != null && uidvalidity !== st.uidValidity) {
    await db.exec('DELETE FROM messages WHERE folder_id = ?', [folder.id])
    uidvalidity = null
  }
  const isFirst = uidvalidity == null

  // Cheap flag refresh for messages we already have, if the server tells us what changed.
  if (!isFirst && folder.highestmodseq != null && client.capabilities.has('CONDSTORE') && st.exists > 0) {
    const changed = await client.fetch('1:*', ['UID', 'FLAGS'], { uid: true, changedSince: folder.highestmodseq })
    for (const it of changed) {
      if (it.uid == null) continue
      const flags = flagList(it.attrs.get('FLAGS'))
      await db.exec('UPDATE messages SET flags = ?, seen = ?, flagged = ?, answered = ?, draft = ?, deleted = ? WHERE folder_id = ? AND uid = ?', [
        JSON.stringify(flags),
        hasFlag(flags, '\\Seen') ? 1 : 0,
        hasFlag(flags, '\\Flagged') ? 1 : 0,
        hasFlag(flags, '\\Answered') ? 1 : 0,
        hasFlag(flags, '\\Draft') ? 1 : 0,
        hasFlag(flags, '\\Deleted') ? 1 : 0,
        folder.id,
        it.uid,
      ])
    }
  }

  let fetchSet = ''
  let byUid = true
  if (isFirst) {
    const n = folder.role === 'inbox' ? INITIAL_INBOX_COUNT : INITIAL_OTHER_COUNT
    if (st.exists > 0) {
      fetchSet = `${Math.max(1, st.exists - n + 1)}:${st.exists}`
      byUid = false
    }
  } else {
    const lastUid = folder.uidnext != null ? folder.uidnext - 1 : 0
    if (st.uidNext == null || st.uidNext - 1 > lastUid) fetchSet = `${lastUid + 1}:*`
  }

  const created: NewMailEvent[] = []
  if (fetchSet) {
    const items = await client.fetch(fetchSet, ['UID', 'FLAGS', 'ENVELOPE', 'RFC822.SIZE', 'BODYSTRUCTURE'], { uid: byUid })
    for (const it of items) {
      if (it.uid == null) continue
      const env = parseEnvelope(it.attrs.get('ENVELOPE'))
      const flags = flagList(it.attrs.get('FLAGS'))
      const bsToken = it.attrs.get('BODYSTRUCTURE')
      let hasAttachments = false
      try {
        if (bsToken) hasAttachments = pickBodyParts(parseBodyStructure(bsToken)).attachments.length > 0
      } catch {
        /* some servers send odd BODYSTRUCTUREs; attachment flag is best-effort */
      }
      const size = Number(it.attrs.get('RFC822.SIZE') ?? 0)
      const dateMs = env.date ? env.date.getTime() : null

      const cols: Record<string, unknown> = {
        account_id: accountId,
        folder_id: folder.id,
        uid: it.uid,
        message_id: env.messageId,
        in_reply_to: env.inReplyTo,
        subject: env.subject,
        from_json: JSON.stringify(env.from),
        to_json: JSON.stringify(env.to),
        cc_json: JSON.stringify(env.cc),
        bcc_json: JSON.stringify(env.bcc),
        reply_to_json: JSON.stringify(env.replyTo),
        date: dateMs,
        internal_date: dateMs,
        size,
        flags: JSON.stringify(flags),
        seen: hasFlag(flags, '\\Seen') ? 1 : 0,
        flagged: hasFlag(flags, '\\Flagged') ? 1 : 0,
        answered: hasFlag(flags, '\\Answered') ? 1 : 0,
        draft: hasFlag(flags, '\\Draft') ? 1 : 0,
        deleted: hasFlag(flags, '\\Deleted') ? 1 : 0,
        has_attachments: hasAttachments ? 1 : 0,
        created_at: now(),
      }
      const keys = Object.keys(cols)
      const vals = keys.map(k => cols[k] as never)
      const fromText = env.from.map(a => `${a.name} ${a.address}`).join(' ')
      const toText = env.to.map(a => `${a.name} ${a.address}`).join(' ')

      // Insert + thread link + FTS row as one unit: if the tab/worker is interrupted between
      // these statements, a bare retry used to see the message row already there (ON CONFLICT
      // DO NOTHING -> changed=0) and permanently skip thread-linking and search indexing for
      // it. Wrapping them together means either all of it lands or none of it does, so a retry
      // starts clean. IMAP network calls (rule actions) stay OUTSIDE this transaction — holding
      // a DB transaction open across a network round-trip would stall every other DB writer.
      const msgId: number | null = await db.tx(async () => {
        await db.raw.run(`INSERT INTO messages (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) ON CONFLICT(folder_id, uid) DO NOTHING`, vals)
        const changed = Number(db.raw.changes())
        if (!changed) return null
        const id = Number(db.raw.lastInsertRowId())
        const threadId = await linkThread(db, accountId, env.subject, dateMs)
        await db.exec('UPDATE messages SET thread_id = ? WHERE id = ?', [threadId, id])
        if (!hasFlag(flags, '\\Seen')) await db.exec('UPDATE threads SET unread = unread + 1 WHERE id = ?', [threadId])
        await db.exec('INSERT INTO messages_fts (rowid, subject, from_text, to_text, body) VALUES (?, ?, ?, ?, ?)', [id, env.subject, fromText, toText, ''])
        return id
      })
      if (msgId == null) continue

      const matchable: RuleMatchable = {
        subject: env.subject,
        from: fromText,
        to: toText,
        fromAddresses: env.from.map(a => a.address),
        toAddresses: env.to.map(a => a.address),
        hasAttachments,
      }
      let movedAway = false
      if (rules.length) {
        const r = await applyRulesImap({ db, client, folderPath: folder.path, messageDbId: msgId, uid: it.uid, accountId }, matchable, rules)
        movedAway = r.movedAway
      }
      if (!movedAway) {
        created.push({
          id: msgId,
          accountId,
          folderId: folder.id,
          folderPath: folder.path,
          uid: it.uid,
          subject: env.subject,
          from: fromText.trim() || env.from.map(a => a.address).join(', '),
          date: dateMs,
          snippet: '',
        })
      }
    }
  }

  const status = await client.status(folder.path, ['MESSAGES', 'UNSEEN'])

  // Detect messages removed by another client (webmail, phone, ...). This client has no
  // EXPUNGE listener during a plain sync pass (only while idling), so without this check a
  // message deleted elsewhere stays visible here forever — a "ghost" that can never be
  // opened since its UID no longer exists on the server. Only pay for the full UID list when
  // the server's count actually dropped below what we hold locally, since that's the only
  // situation this can happen in.
  if (!isFirst && status.messages != null) {
    const localCount = await db.scalar<number>('SELECT COUNT(*) FROM messages WHERE folder_id = ?', [folder.id])
    if (status.messages < localCount) {
      const serverUids = new Set(await client.search('ALL', { uid: true }))
      const localRows = await db.all<Row>('SELECT id, uid FROM messages WHERE folder_id = ?', [folder.id])
      const gone = localRows.filter(r => !serverUids.has(Number(r.uid)))
      if (gone.length) {
        await db.tx(async () => {
          for (const r of gone) {
            await db.exec('DELETE FROM messages WHERE id = ?', [r.id])
            await db.exec('DELETE FROM messages_fts WHERE rowid = ?', [r.id])
          }
        })
      }
    }
  }

  await db.exec('UPDATE folders SET uidvalidity = ?, uidnext = ?, highestmodseq = ?, total = ?, unread = ?, last_sync_at = ? WHERE id = ?', [
    st.uidValidity,
    st.uidNext,
    st.highestModSeq,
    status.messages ?? st.exists,
    status.unseen ?? 0,
    now(),
    folder.id,
  ])

  return created
}

function rowToSummary(r: Row): MessageSummary {
  const from = JSON.parse(String(r.from_json)) as Array<{ name: string; address: string }>
  const threadCount = r.thread_count == null ? undefined : Number(r.thread_count)
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    uid: Number(r.uid),
    subject: String(r.subject),
    from: from.map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
    date: r.date == null ? null : Number(r.date),
    seen: !!r.seen,
    flagged: !!r.flagged,
    hasAttachments: !!r.has_attachments,
    ...(threadCount && threadCount > 1 ? { threadCount } : {}),
  }
}

/**
 * When "Group messages into threads" is on, collapses every message that
 * shares a thread within the selected folders into a single row (the most
 * recent message), so a 3-message conversation in Inbox shows once, not
 * three times. Messages without a thread (thread_id is always assigned at
 * sync time, but stays defensive) group under themselves via -id.
 */
export async function listMessagesInFolders(db: Database, folderIds: number[], limit: number, offset: number): Promise<MessageSummary[]> {
  if (!folderIds.length) return []
  const placeholders = folderIds.map(() => '?').join(', ')
  if (!(await getSetting('mail.threads'))) {
    const rows = await db.all<Row>(
      `SELECT id, account_id, uid, subject, from_json, date, seen, flagged, has_attachments FROM messages WHERE folder_id IN (${placeholders}) ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`,
      [...folderIds, limit, offset],
    )
    return rows.map(rowToSummary)
  }
  // Thread membership (`threads` table / `thread_id`) is per-account, not per-folder — the same
  // conversation can have members in several folders at once (e.g. your own Sent copy of a message
  // you emailed yourself). `scoped` restricts to the folders being viewed (to decide which threads
  // show up here, and which of their messages is the representative row), but the count badge must
  // reflect the TRUE thread size across every folder, not just this view — otherwise it disagrees
  // with `listThreadMessages` (used when the message is opened), which is unscoped.
  const rows = await db.all<Row>(
    `WITH scoped AS (
       SELECT id, date, seen, thread_id, COALESCE(thread_id, -id) AS grp FROM messages WHERE folder_id IN (${placeholders})
     ),
     latest AS (
       SELECT grp, MAX(id) AS msg_id, MAX(date) AS max_date, MAX(thread_id) AS thread_id FROM scoped GROUP BY grp
     ),
     global_counts AS (
       SELECT thread_id, COUNT(DISTINCT COALESCE(message_id, 'row-' || id)) AS cnt FROM messages
       WHERE thread_id IN (SELECT DISTINCT thread_id FROM scoped WHERE thread_id IS NOT NULL)
       GROUP BY thread_id
     )
     SELECT m.id, m.account_id, m.uid, m.subject, m.from_json, m.date, m.seen, m.flagged, m.has_attachments,
            COALESCE(global_counts.cnt, 1) AS thread_count
     FROM latest
     JOIN messages m ON m.id = latest.msg_id
     LEFT JOIN global_counts ON global_counts.thread_id = latest.thread_id
     ORDER BY latest.max_date DESC, m.id DESC
     LIMIT ? OFFSET ?`,
    [...folderIds, limit, offset],
  )
  return rows.map(rowToSummary)
}

export async function countMessagesInFolders(db: Database, folderIds: number[]): Promise<number> {
  if (!folderIds.length) return 0
  const placeholders = folderIds.map(() => '?').join(', ')
  if (!(await getSetting('mail.threads'))) {
    return db.scalar<number>(`SELECT COUNT(*) FROM messages WHERE folder_id IN (${placeholders})`, folderIds)
  }
  return db.scalar<number>(
    `SELECT COUNT(*) FROM (SELECT DISTINCT COALESCE(thread_id, -id) AS grp FROM messages WHERE folder_id IN (${placeholders}))`,
    folderIds,
  )
}

function ftsQuery(q: string): string {
  const words = q
    .trim()
    .split(/\s+/)
    .map(w => w.replace(/"/g, ''))
    .filter(Boolean)
  if (!words.length) return ''
  return words.map(w => `"${w}"*`).join(' ')
}

/**
 * Every message sharing the same thread as `messageId` (or just itself if unthreaded).
 * When your own mail server hands you a copy of a message you sent yourself, it's one
 * physical email stored in two folders (Sent + Inbox) — same `Message-ID` header, same
 * content. Those are collapsed into one entry here (preferring the non-Sent copy) so a
 * self-sent email reads as "1 message", not "2", matching what actually happened.
 */
export async function listThreadMessages(db: Database, messageId: number): Promise<MessageSummary[]> {
  const row = await db.get<Row>('SELECT thread_id FROM messages WHERE id = ?', [messageId])
  if (!row) return []
  if (row.thread_id == null) {
    const self = await db.get<Row>('SELECT id, account_id, uid, subject, from_json, date, seen, flagged, has_attachments FROM messages WHERE id = ?', [messageId])
    return self ? [rowToSummary(self)] : []
  }
  const rows = await db.all<Row>(
    `SELECT m.id, m.account_id, m.uid, m.subject, m.from_json, m.date, m.seen, m.flagged, m.has_attachments, m.message_id, f.role AS folder_role
     FROM messages m JOIN folders f ON f.id = m.folder_id
     WHERE m.thread_id = ? ORDER BY m.date ASC`,
    [row.thread_id],
  )
  return dedupeByMessageId(rows).map(rowToSummary)
}

/** Keeps one row per real `Message-ID` (falling back to row id when absent), preferring a copy that isn't sitting in a Sent-role folder. */
function dedupeByMessageId(rows: Row[]): Row[] {
  const best = new Map<string, Row>()
  for (const r of rows) {
    const key = r.message_id ? String(r.message_id) : `row-${r.id}`
    const prev = best.get(key)
    if (!prev || (prev.folder_role === 'sent' && r.folder_role !== 'sent')) best.set(key, r)
  }
  return [...best.values()].sort((a, b) => Number(a.date ?? 0) - Number(b.date ?? 0))
}

/** Local full-text search over already-synced subject/from/to/body. */
export async function searchMessages(db: Database, query: string, opts: { folderIds?: number[]; limit?: number }): Promise<MessageSummary[]> {
  const match = ftsQuery(query)
  if (!match) return []
  const limit = opts.limit ?? 50
  const params: Param[] = [match]
  let sql = `SELECT id, account_id, uid, subject, from_json, date, seen, flagged, has_attachments
             FROM messages
             WHERE id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)`
  if (opts.folderIds && opts.folderIds.length) {
    sql += ` AND folder_id IN (${opts.folderIds.map(() => '?').join(', ')})`
    params.push(...opts.folderIds)
  }
  sql += ' ORDER BY date DESC LIMIT ?'
  params.push(limit)
  const rows = await db.all<Row>(sql, params)
  return rows.map(rowToSummary)
}
