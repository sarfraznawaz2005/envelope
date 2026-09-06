/**
 * POP3 client (RFC 1939 + STLS, CAPA, UIDL, TOP).
 * Strictly one command at a time. Simple +OK / -ERR replies.
 */
import { RelaySocket } from '../net/relay-socket'
import { LineReader, td, type SocketLike } from '../net/socket'
import type { Logger, Security } from '../imap/client'

export interface Pop3ConnectOptions {
  relayUrl: string
  token?: string
  host: string
  port: number
  security: Security
  logger?: Logger
  connectTimeout?: number
  socket?: SocketLike
}

export class Pop3Error extends Error {
  command: string | undefined
  constructor(message: string, command?: string) {
    super(message)
    this.name = 'Pop3Error'
    this.command = command
  }
}

export class Pop3Client {
  private sock: SocketLike
  private reader: LineReader
  private log: Logger
  private chain: Promise<unknown> = Promise.resolve()
  capabilities = new Set<string>()
  greeting = ''

  private constructor(sock: SocketLike, logger?: Logger) {
    this.sock = sock
    this.reader = new LineReader(sock)
    this.log = logger ?? (() => {})
  }

  static async connect(opts: Pop3ConnectOptions): Promise<Pop3Client> {
    const sock =
      opts.socket ??
      (await RelaySocket.connect({
        relayUrl: opts.relayUrl,
        token: opts.token,
        host: opts.host,
        port: opts.port,
        tls: opts.security === 'tls',
        connectTimeout: opts.connectTimeout,
      }))
    const c = new Pop3Client(sock, opts.logger)
    const g = await c.reader.readLine()
    c.log('S', g ?? '')
    if (!g || !g.startsWith('+OK')) throw new Pop3Error(`Bad POP3 greeting: ${g}`)
    c.greeting = g.slice(3).trim()
    await c.capa()
    if (opts.security === 'starttls') {
      await c.cmd('STLS')
      await sock.startTls()
      await c.capa()
    }
    return c
  }

  get closed() {
    return this.sock.closed
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => {})
    return p
  }

  private cmd(line: string, multi = false): Promise<{ text: string; data: Uint8Array | null }> {
    return this.exclusive(async () => {
      this.log('C', line.startsWith('PASS ') ? 'PASS ***' : line)
      this.sock.write(`${line}\r\n`)
      const reply = await this.reader.readLine()
      this.log('S', reply ?? '<closed>')
      if (reply === null) throw new Pop3Error('Connection closed', line)
      if (!reply.startsWith('+OK')) throw new Pop3Error(reply.replace(/^-ERR\s*/, '') || 'Command failed', line)
      const text = reply.slice(3).trim()
      const data = multi ? await this.reader.readDotBlock() : null
      return { text, data }
    })
  }

  async capa(): Promise<Set<string>> {
    try {
      const r = await this.cmd('CAPA', true)
      const lines = td.decode(r.data!).split(/\r?\n/).filter(Boolean)
      this.capabilities = new Set(lines.map(l => l.trim().toUpperCase()))
    } catch {
      this.capabilities = new Set()
    }
    return this.capabilities
  }

  async login(user: string, pass: string) {
    await this.cmd(`USER ${user}`)
    await this.cmd(`PASS ${pass}`)
  }

  async stat(): Promise<{ count: number; size: number }> {
    const r = await this.cmd('STAT')
    const [c, s] = r.text.split(/\s+/)
    return { count: Number(c), size: Number(s) }
  }

  async list(): Promise<Array<{ num: number; size: number }>> {
    const r = await this.cmd('LIST', true)
    return td
      .decode(r.data!)
      .split(/\r?\n/)
      .filter(Boolean)
      .map(l => {
        const [n, s] = l.trim().split(/\s+/)
        return { num: Number(n), size: Number(s) }
      })
  }

  async uidl(): Promise<Array<{ num: number; uid: string }>> {
    const r = await this.cmd('UIDL', true)
    return td
      .decode(r.data!)
      .split(/\r?\n/)
      .filter(Boolean)
      .map(l => {
        const sp = l.trim().indexOf(' ')
        return { num: Number(l.slice(0, sp)), uid: l.slice(sp + 1).trim() }
      })
  }

  /** Whole message, raw bytes. */
  async retr(num: number): Promise<Uint8Array> {
    const r = await this.cmd(`RETR ${num}`, true)
    return r.data!
  }

  /** Headers + first n body lines. */
  async top(num: number, lines = 0): Promise<Uint8Array> {
    const r = await this.cmd(`TOP ${num} ${lines}`, true)
    return r.data!
  }

  async dele(num: number) {
    await this.cmd(`DELE ${num}`)
  }

  async rset() {
    await this.cmd('RSET')
  }

  async noop() {
    await this.cmd('NOOP')
  }

  async quit() {
    try {
      await this.cmd('QUIT')
    } catch {
      /* ignore */
    }
    this.close()
  }

  close() {
    this.sock.close()
  }
}
