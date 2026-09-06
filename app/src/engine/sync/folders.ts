/**
 * Local folder bookkeeping: mirror the server's mailbox list into the
 * `folders` table, and read it back for the sync loop / UI.
 */
import type { Database, Row } from '../db'
import type { Mailbox } from '../imap/client'
import type { FolderSummary } from '@/shared/rpc'

export interface LocalFolder {
  id: number
  accountId: number
  path: string
  name: string
  role: string | null
  selectable: boolean
  uidvalidity: number | null
  uidnext: number | null
  highestmodseq: number | null
  total: number
  unread: number
}

function rowToFolder(r: Row): LocalFolder {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    path: String(r.path),
    name: String(r.name),
    role: (r.role as string | null) ?? null,
    selectable: !!r.selectable,
    uidvalidity: r.uidvalidity == null ? null : Number(r.uidvalidity),
    uidnext: r.uidnext == null ? null : Number(r.uidnext),
    highestmodseq: r.highestmodseq == null ? null : Number(r.highestmodseq),
    total: Number(r.total),
    unread: Number(r.unread),
  }
}

export async function upsertFolders(db: Database, accountId: number, boxes: Mailbox[]): Promise<void> {
  await db.tx(async () => {
    for (const b of boxes) {
      const existing = await db.get<Row>('SELECT id FROM folders WHERE account_id = ? AND path = ?', [accountId, b.path])
      if (existing) {
        await db.exec('UPDATE folders SET name = ?, delimiter = ?, role = ?, selectable = ? WHERE id = ?', [
          b.name,
          b.delimiter,
          b.role,
          b.selectable ? 1 : 0,
          existing.id,
        ])
      } else {
        await db.insert(
          'INSERT INTO folders (account_id, path, name, delimiter, role, selectable, total, unread) VALUES (?, ?, ?, ?, ?, ?, 0, 0)',
          [accountId, b.path, b.name, b.delimiter, b.role, b.selectable ? 1 : 0],
        )
      }
    }
  })
}

/** POP3 has no mailbox list; give it one local "INBOX" row to hold messages. */
export async function ensurePop3Inbox(db: Database, accountId: number): Promise<LocalFolder> {
  const existing = await db.get<Row>('SELECT * FROM folders WHERE account_id = ? AND path = ?', [accountId, 'INBOX'])
  if (existing) return rowToFolder(existing)
  const id = await db.insert('INSERT INTO folders (account_id, path, name, role, selectable, total, unread) VALUES (?, ?, ?, ?, 1, 0, 0)', [
    accountId,
    'INBOX',
    'Inbox',
    'inbox',
  ])
  return rowToFolder((await db.get<Row>('SELECT * FROM folders WHERE id = ?', [id]))!)
}

export async function getLocalFolders(db: Database, accountId: number): Promise<LocalFolder[]> {
  return (await db.all<Row>('SELECT * FROM folders WHERE account_id = ? ORDER BY sort_order, id', [accountId])).map(rowToFolder)
}

export async function listFoldersForApi(db: Database, accountId: number): Promise<FolderSummary[]> {
  const rows = await getLocalFolders(db, accountId)
  return rows.map(f => ({ id: f.id, path: f.path, name: f.name, role: f.role as FolderSummary['role'], selectable: f.selectable, total: f.total, unread: f.unread }))
}
