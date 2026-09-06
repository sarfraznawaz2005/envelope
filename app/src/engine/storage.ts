/**
 * Storage stats, persistence, and "empty data" actions.
 */
import type { EmptyScope, StorageStats } from '@/shared/rpc'
import { getDb, type Row } from './db'
import { emit, log } from './rpc/server'

export async function storageStats(): Promise<StorageStats> {
  const db = await getDb()
  const est = await navigator.storage.estimate()
  const persisted = await navigator.storage.persisted()

  const pageCount = await db.scalar<number>('PRAGMA page_count')
  const pageSize = await db.scalar<number>('PRAGMA page_size')

  const c = async (sql: string) => Number(await db.scalar<number>(sql))
  return {
    usage: est.usage ?? 0,
    quota: est.quota ?? 0,
    persisted,
    dbBytes: pageCount * pageSize,
    counts: {
      accounts: await c('SELECT count(*) FROM accounts'),
      folders: await c('SELECT count(*) FROM folders'),
      messages: await c('SELECT count(*) FROM messages'),
      bodies: await c('SELECT count(*) FROM message_bodies'),
      attachments: await c('SELECT count(*) FROM attachments WHERE data IS NOT NULL'),
      attachmentBytes: await c('SELECT coalesce(sum(length(data)),0) FROM attachments'),
      contacts: await c(`SELECT count(*) FROM contacts WHERE kind = 'saved'`),
      collectedContacts: await c(`SELECT count(*) FROM contacts WHERE kind = 'collected'`),
      rules: await c('SELECT count(*) FROM rules'),
    },
  }
}

/** Cached bytes (attachment data + fetched raw bodies) per folder, for the per-folder "Empty data" list. */
export async function folderStorage(accountId: number): Promise<Record<number, number>> {
  const db = await getDb()
  const folders = await db.all<Row>('SELECT id FROM folders WHERE account_id = ?', [accountId])
  const out: Record<number, number> = {}
  for (const f of folders) {
    const folderId = Number(f.id)
    const attBytes = await db.scalar<number>(
      'SELECT COALESCE(SUM(LENGTH(a.data)),0) FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.folder_id = ?',
      [folderId],
    )
    const bodyBytes = await db.scalar<number>(
      'SELECT COALESCE(SUM(LENGTH(b.raw)),0) FROM message_bodies b JOIN messages m ON m.id = b.message_id WHERE m.folder_id = ?',
      [folderId],
    )
    out[folderId] = Number(attBytes) + Number(bodyBytes)
  }
  return out
}

/**
 * Remove local data. Server mail is never touched here.
 * Everything runs in one transaction, then VACUUM reclaims disk space.
 */
export async function emptyData(scope: EmptyScope): Promise<void> {
  const db = await getDb()
  await db.tx(async () => {
    switch (scope.kind) {
      case 'folder':
        await db.exec('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE folder_id = ?)', [scope.folderId])
        await db.exec('DELETE FROM messages WHERE folder_id = ?', [scope.folderId])
        await db.exec('UPDATE folders SET total = 0, unread = 0, last_sync_at = NULL, uidnext = NULL, highestmodseq = NULL WHERE id = ?', [scope.folderId])
        await db.exec('DELETE FROM sync_state WHERE folder_id = ?', [scope.folderId])
        break
      case 'account':
        await db.exec('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?)', [scope.accountId])
        await db.exec('DELETE FROM messages WHERE account_id = ?', [scope.accountId])
        await db.exec('DELETE FROM threads WHERE account_id = ?', [scope.accountId])
        await db.exec('UPDATE folders SET total = 0, unread = 0, last_sync_at = NULL, uidnext = NULL, highestmodseq = NULL WHERE account_id = ?', [scope.accountId])
        await db.exec('DELETE FROM sync_state WHERE account_id = ?', [scope.accountId])
        break
      case 'attachments':
        await db.exec('UPDATE attachments SET data = NULL')
        break
      case 'collected-contacts':
        await db.exec(`DELETE FROM contacts WHERE kind = 'collected'`)
        break
      case 'search-index':
        await db.exec('DELETE FROM messages_fts')
        // rebuild from cached bodies
        await db.exec(`INSERT INTO messages_fts (rowid, subject, from_text, to_text, body)
          SELECT m.id, m.subject, m.from_json, m.to_json, coalesce(b.text, '')
          FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id`)
        break
      case 'all-mail':
        await db.exec('DELETE FROM messages_fts')
        await db.exec('DELETE FROM messages')
        await db.exec('DELETE FROM threads')
        await db.exec('UPDATE folders SET total = 0, unread = 0, last_sync_at = NULL, uidnext = NULL, highestmodseq = NULL')
        await db.exec('DELETE FROM sync_state')
        break
      case 'everything':
        for (const t of [
          'messages_fts', 'attachments', 'message_bodies', 'messages', 'threads', 'folders', 'sync_state',
          'signatures', 'rule_actions', 'rule_conditions', 'rules',
          'contact_group_members', 'contact_groups', 'contact_emails', 'contacts',
          'sender_image_allow', 'accounts', 'secrets', 'settings',
        ]) await db.exec(`DELETE FROM ${t}`)
        break
    }
  })
  try {
    await db.exec('VACUUM')
  } catch (e) {
    log('warn', `VACUUM failed: ${(e as Error).message}`)
  }
  emit('data:emptied', { scope })
}
