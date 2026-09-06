/**
 * Build an outgoing RFC 5322 / MIME message.
 *
 *   mixed( alternative( text/plain, related( text/html, inline images ) ), attachments )
 *
 * Text parts use quoted-printable, attachments use base64. Header values with
 * non-ASCII get RFC 2047 encoded words. Output uses CRLF line ends.
 */
import { te } from '../net/socket'

export interface Address {
  name?: string
  address: string
}

export interface OutAttachment {
  filename: string
  mime: string
  data: Uint8Array
  /** Content-ID for inline images referenced as cid: in the HTML */
  cid?: string
}

export interface BuildOptions {
  from: Address
  to: Address[]
  cc?: Address[]
  bcc?: Address[]
  replyTo?: Address
  subject: string
  text?: string
  html?: string
  attachments?: OutAttachment[]
  inReplyTo?: string
  references?: string[]
  date?: Date
  messageId?: string
  userAgent?: string
  headers?: Record<string, string>
}

export interface BuiltMessage {
  bytes: Uint8Array
  messageId: string
  /** all envelope recipients (to + cc + bcc), plain addresses */
  recipients: string[]
}

const CRLF = '\r\n'

export function buildMessage(o: BuildOptions): BuiltMessage {
  const messageId = o.messageId ?? makeMessageId(o.from.address)
  const date = o.date ?? new Date()

  const headers: Array<[string, string]> = [
    ['Date', rfc2822Date(date)],
    ['From', formatAddresses([o.from])],
    ['To', formatAddresses(o.to)],
  ]
  if (o.cc?.length) headers.push(['Cc', formatAddresses(o.cc)])
  if (o.replyTo) headers.push(['Reply-To', formatAddresses([o.replyTo])])
  headers.push(['Subject', encodeHeaderText(o.subject)])
  headers.push(['Message-ID', messageId])
  if (o.inReplyTo) headers.push(['In-Reply-To', o.inReplyTo])
  if (o.references?.length) headers.push(['References', o.references.join(' ')])
  headers.push(['MIME-Version', '1.0'])
  if (o.userAgent) headers.push(['User-Agent', o.userAgent])
  for (const [k, v] of Object.entries(o.headers ?? {})) headers.push([k, encodeHeaderText(v)])

  const atts = o.attachments ?? []
  const inline = o.html ? atts.filter(a => a.cid) : []
  const files = atts.filter(a => !inline.includes(a))

  const textNode = o.text !== undefined ? textPart('text/plain', o.text) : null
  let htmlNode = o.html !== undefined ? textPart('text/html', o.html) : null
  if (htmlNode && inline.length) htmlNode = multipart('related', [htmlNode, ...inline.map(attachmentPart)])

  let body: Node
  if (textNode && htmlNode) body = multipart('alternative', [textNode, htmlNode])
  else body = htmlNode ?? textNode ?? textPart('text/plain', '')
  if (files.length) body = multipart('mixed', [body, ...files.map(attachmentPart)])

  const out = headers.map(([k, v]) => foldHeader(k, v)).join(CRLF) + CRLF + serialize(body)
  const recipients = [...o.to, ...(o.cc ?? []), ...(o.bcc ?? [])].map(a => a.address)
  return { bytes: te.encode(out), messageId, recipients }
}

// ---------- nodes ----------

interface Node {
  headers: Array<[string, string]>
  body: string // already encoded, CRLF lines
  children?: Node[]
  boundary?: string
}

function textPart(type: string, text: string): Node {
  const normalized = text.replace(/\r?\n/g, CRLF)
  return {
    headers: [
      ['Content-Type', `${type}; charset=utf-8`],
      ['Content-Transfer-Encoding', 'quoted-printable'],
    ],
    body: quotedPrintable(normalized),
  }
}

function attachmentPart(a: OutAttachment): Node {
  const headers: Array<[string, string]> = [
    ['Content-Type', `${a.mime || 'application/octet-stream'}; ${nameParam('name', a.filename)}`],
    ['Content-Transfer-Encoding', 'base64'],
    ['Content-Disposition', `${a.cid ? 'inline' : 'attachment'}; ${nameParam('filename', a.filename)}`],
  ]
  if (a.cid) headers.push(['Content-ID', `<${a.cid}>`])
  return { headers, body: base64Lines(a.data) }
}

function multipart(subtype: string, children: Node[]): Node {
  const boundary = `=_mc_${randomToken(24)}`
  return { headers: [['Content-Type', `multipart/${subtype}; boundary="${boundary}"`]], body: '', children, boundary }
}

function serialize(n: Node): string {
  const head = n.headers.map(([k, v]) => foldHeader(k, v)).join(CRLF) + CRLF + CRLF
  if (!n.children) return head + n.body + (n.body.endsWith(CRLF) ? '' : CRLF)
  let out = head + 'This is a multi-part message in MIME format.' + CRLF
  for (const c of n.children) out += CRLF + `--${n.boundary}` + CRLF + serialize(c)
  out += CRLF + `--${n.boundary}--` + CRLF
  return out
}

// ---------- encoders ----------

export function quotedPrintable(s: string): string {
  const bytes = te.encode(s)
  let out = ''
  let lineLen = 0
  const push = (chunk: string) => {
    if (lineLen + chunk.length > 75) {
      out += '=' + CRLF
      lineLen = 0
    }
    out += chunk
    lineLen += chunk.length
  }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    if (b === 0x0d && bytes[i + 1] === 0x0a) {
      // trailing space/tab before a line break must be encoded
      if (out.endsWith(' ') || out.endsWith('\t')) {
        const last = out[out.length - 1]!
        out = out.slice(0, -1) + '=' + last.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
      }
      out += CRLF
      lineLen = 0
      i++
      continue
    }
    const printable = (b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9
    push(printable ? String.fromCharCode(b) : '=' + b.toString(16).toUpperCase().padStart(2, '0'))
  }
  if (out.endsWith(' ') || out.endsWith('\t')) {
    const last = out[out.length - 1]!
    out = out.slice(0, -1) + '=' + last.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

export function base64Lines(data: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
  const b64 = btoa(bin)
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76))
  return lines.join(CRLF) + CRLF
}

/** RFC 2047 "B" encoding for a header value if it has non-ASCII. */
export function encodeHeaderText(s: string): string {
  if (!/[^\x20-\x7e]/.test(s)) return s
  const bytes = te.encode(s)
  // split into chunks of at most 45 bytes (→ 60 base64 chars) on UTF-8 boundaries
  const chunks: string[] = []
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(start + 45, bytes.length)
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    chunks.push(`=?UTF-8?B?${btoa(String.fromCharCode(...bytes.subarray(start, end)))}?=`)
    start = end
  }
  return chunks.join(' ')
}

export function formatAddresses(list: Address[]): string {
  return list.map(formatAddress).join(', ')
}

export function formatAddress(a: Address): string {
  if (!a.name) return a.address
  const name = /[^\x20-\x7e]/.test(a.name) ? encodeHeaderText(a.name) : `"${a.name.replace(/["\\]/g, m => '\\' + m)}"`
  return `${name} <${a.address}>`
}

/** RFC 2231 for non-ASCII file names, plain quoted otherwise. */
function nameParam(param: string, filename: string): string {
  const safe = filename.replace(/[\r\n"]/g, '_')
  if (!/[^\x20-\x7e]/.test(safe)) return `${param}="${safe}"`
  return `${param}*=UTF-8''${encodeURIComponent(safe)}`
}

/** Fold long header lines at spaces (RFC 5322 §2.2.3). */
export function foldHeader(name: string, value: string): string {
  const full = `${name}: ${value}`
  if (full.length <= 78) return full
  const words = value.split(' ')
  let line = `${name}:`
  let out = ''
  for (const w of words) {
    if (line.length + 1 + w.length > 76 && line !== `${name}:`) {
      out += line + CRLF
      line = ' ' + w
    } else {
      line += ' ' + w
    }
  }
  return out + line
}

export function rfc2822Date(d: Date): string {
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${DAY[d.getDay()]}, ${p(d.getDate())} ${MON[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(a / 60))}${p(a % 60)}`
}

export function makeMessageId(fromAddress: string): string {
  const domain = fromAddress.split('@')[1] || 'localhost'
  return `<${Date.now().toString(36)}.${randomToken(16)}@${domain}>`
}

export function randomToken(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let s = ''
  for (const b of bytes) s += chars[b % chars.length]
  return s
}
