/**
 * The socket shape the protocol clients need. RelaySocket implements it for
 * real; tests use a scripted fake.
 */
export interface SocketLike extends AsyncIterable<Uint8Array> {
  readonly host: string
  readonly port: number
  secure: boolean
  readonly closed: boolean
  write(data: Uint8Array | string): void
  read(): Promise<IteratorResult<Uint8Array>>
  startTls(): Promise<void>
  close(): void
}

/**
 * LineReader — turns a byte stream into text lines (CRLF) and raw byte reads.
 * IMAP/POP3/SMTP are line-based, but IMAP literals need exact byte counts and
 * POP3 bodies end with a dot terminator.
 */
export class LineReader {
  private buf = new Uint8Array(0)
  private decoder = new TextDecoder('utf-8', { fatal: false })
  private sock: SocketLike

  constructor(sock: SocketLike) {
    this.sock = sock
  }

  private async fill(): Promise<boolean> {
    const r = await this.sock.read()
    if (r.done) return false
    const merged = new Uint8Array(this.buf.length + r.value.length)
    merged.set(this.buf)
    merged.set(r.value, this.buf.length)
    this.buf = merged
    return true
  }

  /** Read one line without the trailing CRLF. Returns null on close. */
  async readLine(): Promise<string | null> {
    for (;;) {
      const i = this.buf.indexOf(0x0a) // \n
      if (i >= 0) {
        let end = i
        if (end > 0 && this.buf[end - 1] === 0x0d) end--
        const line = this.decoder.decode(this.buf.subarray(0, end))
        this.buf = this.buf.subarray(i + 1)
        return line
      }
      if (!(await this.fill())) {
        if (this.buf.length === 0) return null
        const line = this.decoder.decode(this.buf)
        this.buf = new Uint8Array(0)
        return line
      }
    }
  }

  /** Read exactly n bytes (for IMAP literals). */
  async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      if (!(await this.fill())) throw new Error('Socket closed while reading literal')
    }
    const out = this.buf.slice(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }

  /**
   * Read a POP3 / SMTP style multi-line block: raw bytes up to (not including)
   * the "\r\n.\r\n" terminator, with leading double dots un-stuffed.
   * The first line is assumed to already have been consumed (the +OK line).
   */
  async readDotBlock(): Promise<Uint8Array> {
    const term = [0x0d, 0x0a, 0x2e, 0x0d, 0x0a] // \r\n.\r\n
    let scanFrom = 0
    for (;;) {
      // special case: body is empty → buffer starts with ".\r\n"
      if (this.buf.length >= 3 && this.buf[0] === 0x2e && this.buf[1] === 0x0d && this.buf[2] === 0x0a) {
        this.buf = this.buf.subarray(3)
        return new Uint8Array(0)
      }
      const idx = indexOfSeq(this.buf, term, scanFrom)
      if (idx >= 0) {
        const raw = this.buf.slice(0, idx)
        this.buf = this.buf.subarray(idx + term.length)
        return unstuffDots(raw)
      }
      scanFrom = Math.max(0, this.buf.length - term.length)
      if (!(await this.fill())) throw new Error('Socket closed while reading message')
    }
  }
}

function indexOfSeq(hay: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Replace "\r\n.." with "\r\n." (and a leading ".." at the very start). */
function unstuffDots(raw: Uint8Array): Uint8Array {
  const out: number[] = []
  let atLineStart = true
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!
    if (atLineStart && b === 0x2e && raw[i + 1] === 0x2e) {
      // skip the first dot
      atLineStart = false
      continue
    }
    out.push(b)
    atLineStart = b === 0x0a
  }
  return Uint8Array.from(out)
}

/** Add dot-stuffing and make sure the block ends with CRLF (for SMTP DATA / APPEND). */
export function stuffDots(raw: Uint8Array): Uint8Array {
  const out: number[] = []
  let atLineStart = true
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!
    if (atLineStart && b === 0x2e) out.push(0x2e)
    out.push(b)
    atLineStart = b === 0x0a
  }
  if (!(out.length >= 2 && out[out.length - 2] === 0x0d && out[out.length - 1] === 0x0a)) out.push(0x0d, 0x0a)
  return Uint8Array.from(out)
}

export const te = new TextEncoder()
export const td = new TextDecoder('utf-8', { fatal: false })
export const latin1 = new TextDecoder('latin1')

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
