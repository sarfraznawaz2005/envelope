/**
 * Reading and acting on a single message: fetch the body on first open
 * (IMAP only — POP3 already stores the whole thing at sync time), mark
 * read/flagged, move/archive/spam/delete, and attachment bytes.
 *
 * Actions open a short-lived connection rather than borrowing the sync
 * runner's live one — simpler, and the runner already stops IDLE before any
 * command runs on its own connection, so the two never race each other.
 */
import type { Account } from '@/shared/accounts'
import type { MessageAddress, MessageDetail, MessageFlagName } from '@/shared/rpc'
import { getAccount, getCredentials, openImap } from './accounts'
import { getDb, now, type Database, type Row } from './db'
import { ImapClient } from './imap/client'
import { makeSnippet, parseMessage, type ParsedAttachment } from './mime/parse'
import { emit, log } from './rpc/server'
import { syncNow } from './sync'

export async function withImap<T>(account: Account, fn: (c: ImapClient) => Promise<T>): Promise<T> {
  const creds = await getCredentials(account)
  const c = await openImap(account, creds)
  try {
    return await fn(c)
  } finally {
    await c.logout()
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Swap `cid:...` references for data: URIs so inline images render without a network request. */
function inlineContentIds(html: string, attachments: ParsedAttachment[]): string {
  let out = html
  for (const a of attachments) {
    if (!a.contentId) continue
    const dataUri = `data:${a.mime};base64,${toBase64(a.data)}`
    out = out.replace(new RegExp(`cid:${escapeRegExp(a.contentId)}`, 'gi'), dataUri)
  }
  return out
}

interface Context {
  row: Row
  folder: Row
  account: Account
}

async function loadContext(db: Database, messageId: number): Promise<Context> {
  const row = await db.get<Row>('SELECT * FROM messages WHERE id = ?', [messageId])
  if (!row) throw new Error('Message not found')
  const folder = await db.get<Row>('SELECT * FROM folders WHERE id = ?', [row.folder_id])
  if (!folder) throw new Error('Folder not found')
  const account = await getAccount(Number(row.account_id))
  return { row, folder, account }
}

async function adjustFolderCounts(db: Database, folderId: number, deltaTotal: number, deltaUnread: number) {
  await db.exec('UPDATE folders SET total = MAX(0, total + ?), unread = MAX(0, unread + ?) WHERE id = ?', [deltaTotal, deltaUnread, folderId])
}

async function findFolderByRole(db: Database, accountId: number, role: string): Promise<Row | null> {
  return db.get<Row>('SELECT * FROM folders WHERE account_id = ? AND role = ?', [accountId, role])
}

function addrList(json: unknown): MessageAddress[] {
  try {
    return JSON.parse(String(json)) as MessageAddress[]
  } catch {
    return []
  }
}

async function loadMessageDetail(db: Database, id: number): Promise<MessageDetail> {
  const row = await db.get<Row>('SELECT * FROM messages WHERE id = ?', [id])
  if (!row) throw new Error('Message not found')
  const body = await db.get<Row>('SELECT text, html FROM message_bodies WHERE message_id = ?', [id])
  const atts = await db.all<Row>('SELECT id, filename, mime, size, content_id, disposition FROM attachments WHERE message_id = ? ORDER BY id', [id])
  return {
    id,
    accountId: Number(row.account_id),
    folderId: Number(row.folder_id),
    uid: Number(row.uid),
    subject: String(row.subject),
    from: addrList(row.from_json),
    to: addrList(row.to_json),
    cc: addrList(row.cc_json),
    bcc: addrList(row.bcc_json),
    date: row.date == null ? null : Number(row.date),
    seen: !!row.seen,
    flagged: !!row.flagged,
    text: body ? ((body.text as string | null) ?? null) : null,
    html: body ? ((body.html as string | null) ?? null) : null,
    attachments: atts.map(a => ({
      id: Number(a.id),
      filename: String(a.filename),
      mime: String(a.mime),
      size: Number(a.size),
      contentId: a.content_id == null ? null : String(a.content_id),
      disposition: String(a.disposition),
    })),
  }
}

export async function messageGet(id: number): Promise<MessageDetail> {
  const db = await getDb()
  const { row, folder, account } = await loadContext(db, id)
  if (!row.body_fetched && account.kind === 'imap') {
    const raw = await withImap(account, async c => {
      await c.select(String(folder.path), true)
      const items = await c.fetch(String(row.uid), ['BODY.PEEK[]'], { uid: true })
      const t = items[0]?.attrs.get('BODY[]')
      return t instanceof Uint8Array ? t : null
    })
    if (raw) {
      const parsed = await parseMessage(raw)
      const html = parsed.html ? inlineContentIds(parsed.html, parsed.attachments) : null
      await db.tx(async () => {
        await db.exec(
          `INSERT INTO message_bodies (message_id, text, html, headers, raw, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(message_id) DO UPDATE SET text = excluded.text, html = excluded.html, headers = excluded.headers, raw = excluded.raw, fetched_at = excluded.fetched_at`,
          [id, parsed.text, html, JSON.stringify(parsed.headers), raw, now()],
        )
        for (let i = 0; i < parsed.attachments.length; i++) {
          const a = parsed.attachments[i]!
          await db.exec('INSERT INTO attachments (message_id, part_id, filename, mime, size, content_id, disposition, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            id,
            String(i),
            a.filename,
            a.mime,
            a.size,
            a.contentId,
            a.disposition ?? 'attachment',
            a.data,
          ])
        }
        const snippet = makeSnippet(parsed.text, parsed.html)
        await db.exec('UPDATE messages SET body_fetched = 1, has_attachments = ?, snippet = ? WHERE id = ?', [parsed.attachments.length ? 1 : 0, snippet, id])
        await db.exec('UPDATE messages_fts SET body = ? WHERE rowid = ?', [parsed.text ?? '', id])
      })
    } else {
      await db.exec('UPDATE messages SET body_fetched = 1 WHERE id = ?', [id])
    }
  }
  return loadMessageDetail(db, id)
}

const FLAG_COLUMN: Record<MessageFlagName, string> = { seen: 'seen', flagged: 'flagged', answered: 'answered' }
const FLAG_IMAP: Record<MessageFlagName, string> = { seen: '\\Seen', flagged: '\\Flagged', answered: '\\Answered' }

export async function messageSetFlag(id: number, flag: MessageFlagName, value: boolean): Promise<void> {
  const db = await getDb()
  const { row, folder, account } = await loadContext(db, id)
  const col = FLAG_COLUMN[flag]
  const was = !!row[col]
  if (was === value) return
  await db.exec(`UPDATE messages SET ${col} = ? WHERE id = ?`, [value ? 1 : 0, id])
  if (flag === 'seen') {
    await adjustFolderCounts(db, Number(folder.id), 0, value ? -1 : 1)
    if (row.thread_id != null) await db.exec('UPDATE threads SET unread = MAX(0, unread + ?) WHERE id = ?', [value ? -1 : 1, row.thread_id])
    emit('folders:changed', { accountId: account.id })
  }
  if (account.kind === 'imap') {
    const imapFlag = FLAG_IMAP[flag]
    try {
      await withImap(account, async c => {
        await c.select(String(folder.path), false)
        await c.store(String(row.uid), [imapFlag], value ? 'add' : 'remove')
      })
    } catch (e) {
      log('warn', `[mail-actions] flag sync to server failed: ${(e as Error).message}`)
    }
  }
}

export async function messageMoveToFolder(id: number, destFolderId: number): Promise<void> {
  const db = await getDb()
  const { row, folder, account } = await loadContext(db, id)
  const dest = await db.get<Row>('SELECT * FROM folders WHERE id = ? AND account_id = ?', [destFolderId, account.id])
  if (!dest) throw new Error('Destination folder not found')

  if (account.kind === 'imap') {
    await withImap(account, async c => {
      await c.select(String(folder.path), false)
      await c.move(String(row.uid), String(dest.path))
    })
    await db.exec('DELETE FROM messages WHERE id = ?', [id])
    syncNow(account.id)
  } else {
    await db.exec('UPDATE messages SET folder_id = ? WHERE id = ?', [destFolderId, id])
    await adjustFolderCounts(db, destFolderId, 1, row.seen ? 0 : 1)
  }
  await adjustFolderCounts(db, Number(folder.id), -1, row.seen ? 0 : -1)
  emit('folders:changed', { accountId: account.id })
}

export async function messageArchive(id: number): Promise<void> {
  const db = await getDb()
  const { account } = await loadContext(db, id)
  const dest = await findFolderByRole(db, account.id, 'archive')
  if (!dest) throw new Error('This account has no Archive folder.')
  await messageMoveToFolder(id, Number(dest.id))
}

export async function messageSpam(id: number): Promise<void> {
  const db = await getDb()
  const { account } = await loadContext(db, id)
  const dest = await findFolderByRole(db, account.id, 'spam')
  if (!dest) throw new Error('This account has no Spam folder.')
  await messageMoveToFolder(id, Number(dest.id))
}

export async function messageDelete(id: number): Promise<void> {
  const db = await getDb()
  const { row, folder, account } = await loadContext(db, id)
  if (account.kind !== 'imap') {
    await db.exec('DELETE FROM messages WHERE id = ?', [id])
    await adjustFolderCounts(db, Number(folder.id), -1, row.seen ? 0 : -1)
    emit('folders:changed', { accountId: account.id })
    return
  }
  const trash = await findFolderByRole(db, account.id, 'trash')
  if (trash && Number(trash.id) !== Number(folder.id)) {
    await messageMoveToFolder(id, Number(trash.id))
    return
  }
  await withImap(account, async c => {
    await c.select(String(folder.path), false)
    await c.deleteMessages(String(row.uid))
  })
  await db.exec('DELETE FROM messages WHERE id = ?', [id])
  await adjustFolderCounts(db, Number(folder.id), -1, row.seen ? 0 : -1)
  emit('folders:changed', { accountId: account.id })
  syncNow(account.id)
}

const rawDecoder = new TextDecoder('utf-8', { fatal: false })

export async function messageGetSource(id: number): Promise<string> {
  const db = await getDb()
  const row = await db.get<Row>('SELECT raw FROM message_bodies WHERE message_id = ?', [id])
  if (!row?.raw) return '(source not available — open the message first)'
  return rawDecoder.decode(row.raw as Uint8Array)
}

export async function attachmentGet(id: number): Promise<{ filename: string; mime: string; data: Uint8Array }> {
  const db = await getDb()
  const row = await db.get<Row>('SELECT filename, mime, data FROM attachments WHERE id = ?', [id])
  if (!row) throw new Error('Attachment not found')
  if (!row.data) throw new Error('Attachment not downloaded yet — open the message first.')
  return { filename: String(row.filename), mime: String(row.mime), data: row.data as Uint8Array }
}

export async function imagesIsSenderAllowed(address: string): Promise<boolean> {
  const db = await getDb()
  const row = await db.get<Row>('SELECT 1 FROM sender_image_allow WHERE pattern = ?', [address.toLowerCase()])
  return !!row
}

export async function imagesAllowSender(address: string): Promise<void> {
  const db = await getDb()
  await db.exec('INSERT OR IGNORE INTO sender_image_allow (pattern, created_at) VALUES (?, ?)', [address.toLowerCase(), now()])
}

export async function imagesListAllowed(): Promise<string[]> {
  const db = await getDb()
  const rows = await db.all<Row>('SELECT pattern FROM sender_image_allow ORDER BY created_at DESC')
  return rows.map(r => String(r.pattern))
}

export async function imagesRemoveSender(address: string): Promise<void> {
  const db = await getDb()
  await db.exec('DELETE FROM sender_image_allow WHERE pattern = ?', [address.toLowerCase()])
}
