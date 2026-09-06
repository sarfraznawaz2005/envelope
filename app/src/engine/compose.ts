/**
 * Sending mail: build the MIME message, send it over SMTP, copy it to Sent
 * (IMAP APPEND) if the account wants that, mark the original as answered
 * when this was a reply, and collect recipients as contacts.
 */
import type { ComposeSendInput } from '@/shared/rpc'
import { getAccount, getCredentials, openSmtp } from './accounts'
import { collectContact } from './contacts'
import { getDb, json, type Row } from './db'
import { buildMessage } from './mime/build'
import { messageSetFlag, withImap } from './mail-actions'
import { log } from './rpc/server'
import { getAllSettings } from './settings'
import { syncNow } from './sync'

export async function composeSend(input: ComposeSendInput): Promise<{ messageId: string }> {
  const account = await getAccount(input.accountId)
  const creds = await getCredentials(account)
  const db = await getDb()

  let inReplyToHeader: string | undefined
  let references: string[] | undefined
  if (input.inReplyToId != null) {
    const orig = await db.get<Row>('SELECT message_id, refs FROM messages WHERE id = ?', [input.inReplyToId])
    if (orig?.message_id) {
      inReplyToHeader = String(orig.message_id)
      references = [...json<string[]>(orig.refs, []), String(orig.message_id)]
    }
  }

  const msg = buildMessage({
    from: { name: account.displayName || undefined, address: account.email },
    to: input.to,
    cc: input.cc.length ? input.cc : undefined,
    bcc: input.bcc.length ? input.bcc : undefined,
    subject: input.subject,
    text: input.text,
    html: input.html || undefined,
    attachments: input.attachments,
    inReplyTo: inReplyToHeader,
    references,
    userAgent: 'Envelope/0.1',
  })

  const smtp = await openSmtp(account, creds)
  try {
    await smtp.send({ from: account.email, to: msg.recipients, data: msg.bytes })
  } finally {
    await smtp.quit()
  }

  if (account.kind === 'imap' && account.smtpCopyToSent) {
    try {
      const sent = await db.get<Row>("SELECT path FROM folders WHERE account_id = ? AND role = 'sent'", [account.id])
      if (sent) {
        await withImap(account, c => c.append(String(sent.path), msg.bytes, ['\\Seen']))
      }
    } catch (e) {
      log('warn', `[compose] copy to Sent failed: ${(e as Error).message}`)
    }
  }

  if (input.inReplyToId != null) {
    await messageSetFlag(input.inReplyToId, 'answered', true).catch(() => {})
  }

  const settings = await getAllSettings()
  if (settings['contacts.autoCollect']) {
    const all = [...input.to, ...input.cc, ...input.bcc]
    for (const a of all) await collectContact(a.address, a.name).catch(() => {})
  }

  syncNow(account.id)
  return { messageId: msg.messageId }
}
