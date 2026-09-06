/**
 * Parse raw RFC 5322 bytes with postal-mime.
 * Thin wrapper so the rest of the engine has one stable shape.
 */
import PostalMime, { type Address as PmAddress, type Email } from 'postal-mime'

export interface ParsedAddress {
  name: string
  address: string
}

export interface ParsedAttachment {
  filename: string
  mime: string
  disposition: 'attachment' | 'inline' | null
  contentId: string | null
  data: Uint8Array
  size: number
}

export interface ParsedMessage {
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  subject: string
  date: Date | null
  from: ParsedAddress[]
  to: ParsedAddress[]
  cc: ParsedAddress[]
  bcc: ParsedAddress[]
  replyTo: ParsedAddress[]
  text: string | null
  html: string | null
  headers: Record<string, string>
  attachments: ParsedAttachment[]
  listUnsubscribe: string | null
}

function flatAddresses(list: PmAddress[] | undefined): ParsedAddress[] {
  const out: ParsedAddress[] = []
  for (const a of list ?? []) {
    if ('group' in a && Array.isArray(a.group)) out.push(...flatAddresses(a.group as PmAddress[]))
    else if ('address' in a && a.address) out.push({ name: a.name ?? '', address: a.address })
  }
  return out
}

export async function parseMessage(raw: Uint8Array | string): Promise<ParsedMessage> {
  const e: Email = await PostalMime.parse(raw)
  const headers: Record<string, string> = {}
  for (const h of e.headers ?? []) headers[h.key.toLowerCase()] = h.value

  return {
    messageId: e.messageId ?? null,
    inReplyTo: e.inReplyTo ?? null,
    references: (e.references ?? '').split(/\s+/).filter(Boolean),
    subject: e.subject ?? '',
    date: e.date ? new Date(e.date) : null,
    from: flatAddresses(e.from ? [e.from] : []),
    to: flatAddresses(e.to),
    cc: flatAddresses(e.cc),
    bcc: flatAddresses(e.bcc),
    replyTo: flatAddresses(e.replyTo),
    text: e.text ?? null,
    html: e.html ?? null,
    headers,
    attachments: (e.attachments ?? []).map(a => {
      const data = a.content instanceof Uint8Array ? a.content : typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content as ArrayBuffer)
      return {
        filename: a.filename ?? '',
        mime: a.mimeType ?? 'application/octet-stream',
        disposition: (a.disposition as 'attachment' | 'inline' | null) ?? null,
        contentId: a.contentId ? a.contentId.replace(/^<|>$/g, '') : null,
        data,
        size: data.byteLength,
      }
    }),
    listUnsubscribe: headers['list-unsubscribe'] ?? null,
  }
}

/** Short plain-text preview for message lists. */
export function makeSnippet(text: string | null, html: string | null, max = 160): string {
  let s = text ?? ''
  if (!s && html) s = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  // drop quoted reply lines
  s = s.split(/\r?\n/).filter(l => !/^\s*>/.test(l)).join(' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
