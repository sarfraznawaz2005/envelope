/** Colored labels attached to a sender address. No row means no label. */
import type { SenderLabel } from '@/shared/rpc'
import { getDb, type Row } from './db'

export async function senderLabelsList(): Promise<SenderLabel[]> {
  const db = await getDb()
  const rows = await db.all<Row>('SELECT email, name, color FROM sender_labels ORDER BY name COLLATE NOCASE')
  return rows.map(r => ({ email: String(r.email), name: String(r.name), color: String(r.color) }))
}

/** Sets the label for a sender, or removes it when `label` is null or has an empty name. */
export async function senderLabelSet(email: string, label: { name: string; color: string } | null): Promise<void> {
  const db = await getDb()
  const addr = email.trim().toLowerCase()
  if (!addr) return
  const name = label?.name.trim()
  if (!label || !name) {
    await db.exec('DELETE FROM sender_labels WHERE email = ?', [addr])
    return
  }
  await db.exec(
    'INSERT INTO sender_labels (email, name, color) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name, color = excluded.color',
    [addr, name, label.color],
  )
}
