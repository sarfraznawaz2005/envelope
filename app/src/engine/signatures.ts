/**
 * One signature per account. The editor UI is Phase 9 (Settings > Signatures);
 * pulled forward here as a small settings page so Compose has something real
 * to test against.
 */
import type { Signature, SignatureInput } from '@/shared/rpc'
import { getDb, type Row } from './db'

export async function getSignature(accountId: number): Promise<Signature | null> {
  const db = await getDb()
  const row = await db.get<Row>('SELECT * FROM signatures WHERE account_id = ?', [accountId])
  if (!row) return null
  return {
    accountId,
    isHtml: !!row.is_html,
    content: String(row.content),
    position: row.position === 'below' ? 'below' : 'above',
    useOnReply: !!row.use_on_reply,
  }
}

export async function setSignature(accountId: number, input: SignatureInput): Promise<void> {
  const db = await getDb()
  await db.exec(
    `INSERT INTO signatures (account_id, is_html, content, position, use_on_reply) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET is_html = excluded.is_html, content = excluded.content, position = excluded.position, use_on_reply = excluded.use_on_reply`,
    [accountId, input.isHtml ? 1 : 0, input.content, input.position, input.useOnReply ? 1 : 0],
  )
}
