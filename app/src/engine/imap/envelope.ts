/**
 * IMAP ENVELOPE -> plain objects, with RFC 2047 words decoded.
 * ENVELOPE = (date subject from sender reply-to to cc bcc in-reply-to message-id)
 * address   = (name adl mailbox host)
 */
import { decodeWords } from 'postal-mime'
import { tokList, tokStr, type Token } from './parser'

export interface EnvAddress {
  name: string
  address: string
}

export interface Envelope {
  date: Date | null
  subject: string
  from: EnvAddress[]
  sender: EnvAddress[]
  replyTo: EnvAddress[]
  to: EnvAddress[]
  cc: EnvAddress[]
  bcc: EnvAddress[]
  inReplyTo: string | null
  messageId: string | null
}

function addr(t: Token | undefined): EnvAddress[] {
  const out: EnvAddress[] = []
  for (const a of tokList(t)) {
    const l = tokList(a)
    const mailbox = l[2] == null ? '' : tokStr(l[2])
    const host = l[3] == null ? '' : tokStr(l[3])
    if (!mailbox || !host) continue // group markers
    out.push({ name: l[0] == null ? '' : safeDecode(tokStr(l[0])), address: `${mailbox}@${host}` })
  }
  return out
}

export function safeDecode(s: string): string {
  try {
    return decodeWords(s)
  } catch {
    return s
  }
}

export function parseEnvelope(t: Token | undefined): Envelope {
  const l = tokList(t)
  const dateStr = l[0] == null ? '' : tokStr(l[0])
  const d = dateStr ? new Date(dateStr) : null
  return {
    date: d && !Number.isNaN(d.getTime()) ? d : null,
    subject: l[1] == null ? '' : safeDecode(tokStr(l[1])),
    from: addr(l[2]),
    sender: addr(l[3]),
    replyTo: addr(l[4]),
    to: addr(l[5]),
    cc: addr(l[6]),
    bcc: addr(l[7]),
    inReplyTo: l[8] == null ? null : tokStr(l[8]),
    messageId: l[9] == null ? null : tokStr(l[9]),
  }
}
