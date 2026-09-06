/**
 * Compose autosave. One row per in-progress compose session (id is a
 * client-generated UUID), overwritten in place every few seconds.
 * Attachments are not persisted — if the tab crashes mid-compose, text
 * recovers but attachments must be re-picked.
 */
import type { DraftInput, DraftRecord } from '@/shared/rpc'
import { getDb, json, now, type Row } from './db'

export async function draftSave(input: DraftInput): Promise<void> {
  const db = await getDb()
  await db.exec(
    `INSERT INTO drafts (id, account_id, to_json, cc_json, bcc_json, subject, is_html, body, in_reply_to_id, reply_mode, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id, to_json = excluded.to_json, cc_json = excluded.cc_json, bcc_json = excluded.bcc_json,
       subject = excluded.subject, is_html = excluded.is_html, body = excluded.body,
       in_reply_to_id = excluded.in_reply_to_id, reply_mode = excluded.reply_mode, updated_at = excluded.updated_at`,
    [
      input.id,
      input.accountId,
      JSON.stringify(input.to),
      JSON.stringify(input.cc),
      JSON.stringify(input.bcc),
      input.subject,
      input.isHtml ? 1 : 0,
      input.body,
      input.inReplyToId ?? null,
      input.replyMode ?? null,
      now(),
    ],
  )
}

export async function draftGet(id: string): Promise<DraftRecord | null> {
  const db = await getDb()
  const row = await db.get<Row>('SELECT * FROM drafts WHERE id = ?', [id])
  if (!row) return null
  return {
    id: String(row.id),
    accountId: Number(row.account_id),
    to: json(row.to_json, []),
    cc: json(row.cc_json, []),
    bcc: json(row.bcc_json, []),
    subject: String(row.subject),
    isHtml: !!row.is_html,
    body: String(row.body),
    inReplyToId: row.in_reply_to_id == null ? null : Number(row.in_reply_to_id),
    replyMode: (row.reply_mode as DraftRecord['replyMode']) ?? null,
    updatedAt: Number(row.updated_at),
  }
}

export async function draftDelete(id: string): Promise<void> {
  const db = await getDb()
  await db.exec('DELETE FROM drafts WHERE id = ?', [id])
}
