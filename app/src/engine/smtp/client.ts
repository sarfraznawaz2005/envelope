/**
 * SMTP client (RFC 5321) with STARTTLS, AUTH PLAIN / LOGIN, 8BITMIME, SMTPUTF8.
 */
import { RelaySocket } from '../net/relay-socket'
import { LineReader, stuffDots, te, type SocketLike } from '../net/socket'
import type { Logger, Security } from '../imap/client'

export interface SmtpConnectOptions {
  relayUrl: string
  token?: string
  host: string
  port: number
  security: Security
  /** name we announce in EHLO */
  ehloName?: string
  logger?: Logger
  connectTimeout?: number
  socket?: SocketLike
}

export class SmtpError extends Error {
  code: number
  command: string | undefined
  constructor(code: number, message: string, command?: string) {
    super(message)
    this.name = 'SmtpError'
    this.code = code
    this.command = command
  }
}

export interface SmtpReply {
  code: number
  lines: string[]
}

export class SmtpClient {
  private sock: SocketLike
  private reader: LineReader
  private log: Logger
  private chain: Promise<unknown> = Promise.resolve()
  private ehloName: string
  extensions = new Map<string, string[]>()
  greeting = ''

  private constructor(sock: SocketLike, ehloName: string, logger?: Logger) {
    this.sock = sock
    this.reader = new LineReader(sock)
    this.ehloName = ehloName
    this.log = logger ?? (() => {})
  }

  static async connect(opts: SmtpConnectOptions): Promise<SmtpClient> {
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
    const c = new SmtpClient(sock, opts.ehloName ?? 'localhost', opts.logger)
    const g = await c.readReply()
    if (g.code !== 220) throw new SmtpError(g.code, g.lines.join(' '), 'greeting')
    c.greeting = g.lines.join(' ')
    await c.ehlo()
    if (opts.security === 'starttls') {
      if (!c.extensions.has('STARTTLS')) throw new SmtpError(0, 'Server does not offer STARTTLS')
      await c.cmd('STARTTLS', [220])
      await sock.startTls()
      await c.ehlo()
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

  private async readReply(): Promise<SmtpReply> {
    const lines: string[] = []
    for (;;) {
      const line = await this.reader.readLine()
      if (line === null) throw new SmtpError(0, 'Connection closed')
      this.log('S', line)
      const m = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!m) throw new SmtpError(0, `Bad SMTP reply: ${line}`)
      lines.push(m[3]!)
      if (m[2] === ' ') return { code: Number(m[1]), lines }
    }
  }

  private cmd(line: string, expect: number[]): Promise<SmtpReply> {
    return this.exclusive(async () => {
      this.log('C', /^AUTH |^[A-Za-z0-9+/=]{8,}$/.test(line) ? line.split(' ')[0] + ' ***' : line)
      this.sock.write(`${line}\r\n`)
      const r = await this.readReply()
      if (!expect.includes(r.code)) throw new SmtpError(r.code, r.lines.join(' '), line.split(' ')[0])
      return r
    })
  }

  async ehlo() {
    let r: SmtpReply
    try {
      r = await this.cmd(`EHLO ${this.ehloName}`, [250])
    } catch {
      r = await this.cmd(`HELO ${this.ehloName}`, [250])
      this.extensions = new Map()
      return
    }
    this.extensions = new Map()
    for (const l of r.lines.slice(1)) {
      const [k, ...rest] = l.trim().split(/\s+/)
      if (k) this.extensions.set(k.toUpperCase(), rest.map(x => x.toUpperCase()))
    }
  }

  async auth(user: string, pass: string) {
    const mechs = this.extensions.get('AUTH') ?? []
    const b64 = (s: string) => btoa(String.fromCharCode(...te.encode(s)))
    if (mechs.includes('PLAIN')) {
      await this.cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235])
    } else if (mechs.includes('LOGIN')) {
      await this.cmd('AUTH LOGIN', [334])
      await this.cmd(b64(user), [334])
      await this.cmd(b64(pass), [235])
    } else if (mechs.length === 0) {
      throw new SmtpError(0, 'Server offers no AUTH. Try STARTTLS or a different port.')
    } else {
      throw new SmtpError(0, `No supported AUTH mechanism (server offers ${mechs.join(', ')})`)
    }
  }

  /** Send one message. `data` is the full RFC 5322 message with CRLF line ends. */
  async send(opts: { from: string; to: string[]; data: Uint8Array }): Promise<string> {
    const hasUtf8 = opts.from.concat(opts.to.join('')).split('').some(c => c.charCodeAt(0) > 127)
    const params: string[] = []
    if (this.extensions.has('8BITMIME')) params.push('BODY=8BITMIME')
    if (hasUtf8 && this.extensions.has('SMTPUTF8')) params.push('SMTPUTF8')
    if (this.extensions.has('SIZE')) params.push(`SIZE=${opts.data.byteLength}`)
    await this.cmd(`MAIL FROM:<${opts.from}>${params.length ? ' ' + params.join(' ') : ''}`, [250])
    for (const rcpt of opts.to) await this.cmd(`RCPT TO:<${rcpt}>`, [250, 251])
    await this.cmd('DATA', [354])
    const r = await this.exclusive(async () => {
      this.log('C', `<${opts.data.byteLength} bytes of message data>`)
      this.sock.write(stuffDots(opts.data))
      this.sock.write('.\r\n')
      const reply = await this.readReply()
      if (reply.code !== 250) throw new SmtpError(reply.code, reply.lines.join(' '), 'DATA')
      return reply
    })
    return r.lines.join(' ')
  }

  async rset() {
    await this.cmd('RSET', [250])
  }

  async noop() {
    await this.cmd('NOOP', [250])
  }

  async quit() {
    try {
      await this.cmd('QUIT', [221])
    } catch {
      /* ignore */
    }
    this.close()
  }

  close() {
    this.sock.close()
  }
}
