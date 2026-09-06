/**
 * IMAP client (RFC 3501 + common extensions: IDLE, MOVE, UIDPLUS, LITERAL+,
 * SPECIAL-USE, SASL-IR, CONDSTORE for CHANGEDSINCE).
 *
 * One command at a time. A background read loop dispatches responses:
 *   tagged      -> resolves the running command
 *   untagged    -> collected on the running command, or sent to onUnsolicited
 *   continuation-> resolves whoever is waiting to send a literal / SASL step
 *
 * IDLE is special: it "runs" until another command needs the line, at which
 * point the client sends DONE first.
 */
import { RelaySocket } from '../net/relay-socket'
import { LineReader, te, type SocketLike } from '../net/socket'
import { pairsToMap, parseResponse, readResponse, tokList, tokNum, tokStr, type Response, type Token } from './parser'
import { decodeUtf7Imap, encodeUtf7Imap } from './utf7'

export type Security = 'tls' | 'starttls' | 'none'
export type Logger = (dir: 'C' | 'S' | 'I', line: string) => void

export interface ImapConnectOptions {
  relayUrl: string
  token?: string
  host: string
  port: number
  security: Security
  logger?: Logger
  connectTimeout?: number
  /** for tests */
  socket?: SocketLike
}

export class ImapError extends Error {
  status: 'NO' | 'BAD' | 'BYE'
  code: Token[] | null
  command: string | undefined
  constructor(message: string, status: 'NO' | 'BAD' | 'BYE', code: Token[] | null, command?: string) {
    super(message)
    this.name = 'ImapError'
    this.status = status
    this.code = code
    this.command = command
  }
}

export interface Untagged {
  num: number | null
  type: string
  tokens: Token[]
  code: Token[] | null
  text: string
}

export interface CommandResult {
  status: 'OK' | 'NO' | 'BAD'
  code: Token[] | null
  text: string
  untagged: Untagged[]
}

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'all'

export interface Mailbox {
  path: string
  name: string
  delimiter: string | null
  flags: string[]
  role: FolderRole | null
  selectable: boolean
  hasChildren: boolean | null
}

export interface SelectState {
  path: string
  exists: number
  recent: number
  flags: string[]
  permanentFlags: string[]
  uidValidity: number | null
  uidNext: number | null
  highestModSeq: number | null
  readOnly: boolean
}

export interface FetchItem {
  seq: number
  uid: number | null
  attrs: Map<string, Token>
}

export interface MailboxStatus {
  messages: number | null
  unseen: number | null
  uidNext: number | null
  uidValidity: number | null
  highestModSeq: number | null
}

type Piece = string | Uint8Array

interface Pending {
  tag: string
  untagged: Untagged[]
  resolve: (r: CommandResult) => void
  reject: (e: Error) => void
  collectUntagged: boolean
}

export class ImapClient {
  private sock: SocketLike
  private reader: LineReader
  private log: Logger
  private tagCounter = 0
  private current: Pending | null = null
  private contWaiter: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private closedErr: Error | null = null
  private idleDone: Promise<CommandResult> | null = null

  capabilities = new Set<string>()
  selected: SelectState | null = null
  greeting = ''
  /** untagged responses that arrive outside a collecting command (IDLE, or between commands) */
  onUnsolicited: ((u: Untagged) => void) | null = null
  onClose: ((err: Error | null) => void) | null = null

  private constructor(sock: SocketLike, logger?: Logger) {
    this.sock = sock
    this.reader = new LineReader(sock)
    this.log = logger ?? (() => {})
  }

  // ---------- connect ----------

  static async connect(opts: ImapConnectOptions): Promise<ImapClient> {
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
    const c = new ImapClient(sock, opts.logger)
    await c.readGreeting()
    void c.readLoop()
    if (opts.security === 'starttls') await c.starttls()
    if (!c.capabilities.size) await c.capability()
    return c
  }

  private async readGreeting() {
    const parts = await readResponse(this.reader)
    if (!parts) throw new Error('No IMAP greeting')
    const r = parseResponse(parts)
    this.log('S', String(parts[0]))
    if (r.kind !== 'untagged' || (r.type !== 'OK' && r.type !== 'PREAUTH')) {
      throw new Error(`Bad IMAP greeting: ${String(parts[0])}`)
    }
    this.greeting = r.text
    if (r.code && tokStr(r.code[0]).toUpperCase() === 'CAPABILITY') this.setCapabilities(r.code.slice(1))
  }

  private setCapabilities(toks: Token[]) {
    this.capabilities = new Set(toks.map(t => tokStr(t).toUpperCase()))
  }

  get closed() {
    return this.closedErr !== null || this.sock.closed
  }
  get supportsIdle() {
    return this.capabilities.has('IDLE')
  }
  get isIdling() {
    return this.idleDone !== null
  }

  // ---------- read loop ----------

  private async readLoop() {
    try {
      for (;;) {
        const parts = await readResponse(this.reader)
        if (!parts) break
        this.log('S', summarize(parts))
        this.dispatch(parseResponse(parts))
      }
      this.handleClose(null)
    } catch (e) {
      this.handleClose(e as Error)
    }
  }

  private handleClose(err: Error | null) {
    if (this.closedErr) return
    this.closedErr = err ?? new Error('IMAP connection closed')
    const c = this.current
    this.current = null
    c?.reject(this.closedErr)
    const w = this.contWaiter
    this.contWaiter = null
    w?.reject(this.closedErr)
    this.idleDone = null
    this.onClose?.(err)
  }

  private dispatch(r: Response) {
    if (r.kind === 'continuation') {
      const w = this.contWaiter
      this.contWaiter = null
      if (w) w.resolve(r.text)
      else this.log('I', `unexpected continuation: ${r.text}`)
      return
    }
    if (r.kind === 'tagged') {
      const c = this.current
      if (c && c.tag === r.tag) {
        this.current = null
        c.resolve({ status: r.status, code: r.code, text: r.text, untagged: c.untagged })
      } else {
        this.log('I', `stray tagged response ${r.tag}`)
      }
      return
    }
    // untagged
    const u: Untagged = { num: r.num, type: r.type, tokens: r.tokens, code: r.code, text: r.text }
    this.trackState(u)
    if (u.type === 'BYE') {
      this.log('I', `server BYE: ${u.text}`)
    }
    const c = this.current
    if (c && c.collectUntagged) c.untagged.push(u)
    else this.onUnsolicited?.(u)
  }

  private trackState(u: Untagged) {
    const s = this.selected
    if (!s) return
    if (u.type === 'EXISTS' && u.num !== null) s.exists = u.num
    else if (u.type === 'RECENT' && u.num !== null) s.recent = u.num
    else if (u.type === 'EXPUNGE' && u.num !== null) s.exists = Math.max(0, s.exists - 1)
    else if (u.type === 'FLAGS') s.flags = tokList(u.tokens[0]).map(t => tokStr(t))
  }

  // ---------- command plumbing ----------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => {})
    return p
  }

  private waitContinuation(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.contWaiter = { resolve, reject }
    })
  }

  private async sendPieces(pieces: Piece[]) {
    for (const p of pieces) {
      if (typeof p === 'string') {
        this.sock.write(p)
        continue
      }
      const nonSync = this.capabilities.has('LITERAL+') || (this.capabilities.has('LITERAL-') && p.length <= 4096)
      if (nonSync) {
        this.sock.write(`{${p.length}+}\r\n`)
        this.sock.write(p)
      } else {
        const wait = this.waitContinuation()
        this.sock.write(`{${p.length}}\r\n`)
        await wait
        this.sock.write(p)
      }
    }
    this.sock.write('\r\n')
  }

  /** Run one command. Throws ImapError on NO/BAD. */
  run(pieces: Piece[] | string, opts: { collectUntagged?: boolean } = {}): Promise<CommandResult> {
    return this.exclusive(async () => {
      if (this.idleDone) await this.stopIdleInternal()
      return this.runRaw(pieces, opts)
    })
  }

  private async runRaw(pieces: Piece[] | string, opts: { collectUntagged?: boolean } = {}): Promise<CommandResult> {
    if (this.closedErr) throw this.closedErr
    const arr = typeof pieces === 'string' ? [pieces] : pieces
    const tag = `A${++this.tagCounter}`
    const label = describe(arr)
    const result = new Promise<CommandResult>((resolve, reject) => {
      this.current = { tag, untagged: [], resolve, reject, collectUntagged: opts.collectUntagged ?? true }
    })
    this.log('C', `${tag} ${label}`)
    await this.sendPieces([`${tag} `, ...arr])
    const r = await result
    if (r.status !== 'OK') throw new ImapError(r.text || r.status, r.status, r.code, label)
    return r
  }

  // ---------- session ----------

  async capability(): Promise<Set<string>> {
    const r = await this.run('CAPABILITY')
    const u = r.untagged.find(x => x.type === 'CAPABILITY')
    if (u) this.setCapabilities(u.tokens)
    else if (r.code && tokStr(r.code[0]).toUpperCase() === 'CAPABILITY') this.setCapabilities(r.code.slice(1))
    return this.capabilities
  }

  async starttls() {
    if (!this.capabilities.size) await this.capability()
    if (!this.capabilities.has('STARTTLS')) throw new Error('Server does not offer STARTTLS')
    await this.run('STARTTLS')
    await this.sock.startTls()
    this.capabilities.clear()
    await this.capability()
  }

  async login(user: string, pass: string) {
    if (this.capabilities.has('AUTH=PLAIN')) {
      const ir = btoa(String.fromCharCode(...te.encode(`\0${user}\0${pass}`)))
      if (this.capabilities.has('SASL-IR')) {
        await this.run(`AUTHENTICATE PLAIN ${ir}`)
      } else {
        await this.exclusive(async () => {
          if (this.idleDone) await this.stopIdleInternal()
          const tag = `A${++this.tagCounter}`
          const result = new Promise<CommandResult>((resolve, reject) => {
            this.current = { tag, untagged: [], resolve, reject, collectUntagged: true }
          })
          this.log('C', `${tag} AUTHENTICATE PLAIN`)
          const wait = this.waitContinuation()
          this.sock.write(`${tag} AUTHENTICATE PLAIN\r\n`)
          await wait
          this.sock.write(`${ir}\r\n`)
          const r = await result
          if (r.status !== 'OK') throw new ImapError(r.text || r.status, r.status, r.code, 'AUTHENTICATE PLAIN')
        })
      }
    } else {
      if (this.capabilities.has('LOGINDISABLED')) throw new Error('Server disabled LOGIN and offers no AUTH=PLAIN')
      await this.run(['LOGIN ', astring(user), ' ', astring(pass)])
    }
    // capabilities usually change after auth
    await this.capability()
  }

  async noop(): Promise<CommandResult> {
    return this.run('NOOP')
  }

  async logout() {
    try {
      await this.run('LOGOUT')
    } catch {
      /* BYE races are fine */
    }
    this.close()
  }

  close() {
    this.sock.close()
    this.handleClose(null)
  }

  // ---------- mailboxes ----------

  async list(): Promise<Mailbox[]> {
    const ext = this.capabilities.has('LIST-EXTENDED') && this.capabilities.has('SPECIAL-USE') ? ' RETURN (SPECIAL-USE)' : ''
    const r = await this.run(`LIST "" "*"${ext}`)
    const boxes: Mailbox[] = []
    for (const u of r.untagged) {
      if (u.type !== 'LIST' && u.type !== 'XLIST') continue
      const flags = tokList(u.tokens[0]).map(t => tokStr(t))
      const delimiter = u.tokens[1] === null ? null : tokStr(u.tokens[1])
      const path = decodeUtf7Imap(tokStr(u.tokens[2]))
      const name = delimiter ? (path.split(delimiter).pop() ?? path) : path
      const lower = flags.map(f => f.toLowerCase())
      boxes.push({
        path,
        name,
        delimiter,
        flags,
        role: roleFromFlags(lower) ?? roleFromName(path, name),
        selectable: !lower.includes('\\noselect') && !lower.includes('\\nonexistent'),
        hasChildren: lower.includes('\\haschildren') ? true : lower.includes('\\hasnochildren') ? false : null,
      })
    }
    if (!boxes.some(b => b.path.toUpperCase() === 'INBOX')) {
      boxes.unshift({ path: 'INBOX', name: 'INBOX', delimiter: boxes[0]?.delimiter ?? '/', flags: [], role: 'inbox', selectable: true, hasChildren: null })
    }
    return boxes
  }

  async select(path: string, readOnly = false): Promise<SelectState> {
    const r = await this.run(`${readOnly ? 'EXAMINE' : 'SELECT'} ${mailboxArg(path)}`)
    const s: SelectState = {
      path,
      exists: 0,
      recent: 0,
      flags: [],
      permanentFlags: [],
      uidValidity: null,
      uidNext: null,
      highestModSeq: null,
      readOnly: readOnly || (r.code ? tokStr(r.code[0]).toUpperCase() === 'READ-ONLY' : false),
    }
    for (const u of r.untagged) {
      if (u.type === 'EXISTS' && u.num !== null) s.exists = u.num
      else if (u.type === 'RECENT' && u.num !== null) s.recent = u.num
      else if (u.type === 'FLAGS') s.flags = tokList(u.tokens[0]).map(t => tokStr(t))
      else if (u.type === 'OK' && u.code) {
        const k = tokStr(u.code[0]).toUpperCase()
        if (k === 'UIDVALIDITY') s.uidValidity = tokNum(u.code[1])
        else if (k === 'UIDNEXT') s.uidNext = tokNum(u.code[1])
        else if (k === 'HIGHESTMODSEQ') s.highestModSeq = tokNum(u.code[1])
        else if (k === 'PERMANENTFLAGS') s.permanentFlags = tokList(u.code[1]).map(t => tokStr(t))
      }
    }
    this.selected = s
    return s
  }

  async status(path: string, items = ['MESSAGES', 'UNSEEN', 'UIDNEXT', 'UIDVALIDITY']): Promise<MailboxStatus> {
    const r = await this.run(`STATUS ${mailboxArg(path)} (${items.join(' ')})`)
    const u = r.untagged.find(x => x.type === 'STATUS')
    const m = u ? pairsToMap(tokList(u.tokens[1])) : new Map<string, Token>()
    return {
      messages: tokNum(m.get('MESSAGES')),
      unseen: tokNum(m.get('UNSEEN')),
      uidNext: tokNum(m.get('UIDNEXT')),
      uidValidity: tokNum(m.get('UIDVALIDITY')),
      highestModSeq: tokNum(m.get('HIGHESTMODSEQ')),
    }
  }

  async create(path: string) {
    await this.run(`CREATE ${mailboxArg(path)}`)
  }
  async delete(path: string) {
    await this.run(`DELETE ${mailboxArg(path)}`)
  }
  async rename(from: string, to: string) {
    await this.run(`RENAME ${mailboxArg(from)} ${mailboxArg(to)}`)
  }

  // ---------- messages ----------

  async fetch(set: string, items: string[], opts: { uid?: boolean; changedSince?: number } = {}): Promise<FetchItem[]> {
    const uid = opts.uid ?? true
    const mod = opts.changedSince ? ` (CHANGEDSINCE ${opts.changedSince})` : ''
    const r = await this.run(`${uid ? 'UID ' : ''}FETCH ${set} (${items.join(' ')})${mod}`)
    return r.untagged
      .filter(u => u.type === 'FETCH' && u.num !== null)
      .map(u => {
        const attrs = pairsToMap(tokList(u.tokens[0]))
        return { seq: u.num!, uid: tokNum(attrs.get('UID')), attrs }
      })
  }

  async search(criteria: Piece[] | string, opts: { uid?: boolean } = {}): Promise<number[]> {
    const uid = opts.uid ?? true
    const pieces = typeof criteria === 'string' ? [criteria] : criteria
    const r = await this.run([`${uid ? 'UID ' : ''}SEARCH `, ...pieces])
    const out: number[] = []
    for (const u of r.untagged) if (u.type === 'SEARCH') for (const t of u.tokens) {
      const n = tokNum(t)
      if (n !== null) out.push(n)
    }
    return out
  }

  async store(set: string, flags: string[], mode: 'add' | 'remove' | 'set', opts: { uid?: boolean; silent?: boolean } = {}) {
    const uid = opts.uid ?? true
    const sign = mode === 'add' ? '+' : mode === 'remove' ? '-' : ''
    const silent = opts.silent ?? true ? '.SILENT' : ''
    return this.run(`${uid ? 'UID ' : ''}STORE ${set} ${sign}FLAGS${silent} (${flags.join(' ')})`)
  }

  async copy(set: string, dest: string, opts: { uid?: boolean } = {}) {
    const uid = opts.uid ?? true
    return this.run(`${uid ? 'UID ' : ''}COPY ${set} ${mailboxArg(dest)}`)
  }

  /** MOVE if the server has it, else COPY + \Deleted + EXPUNGE. */
  async move(set: string, dest: string, opts: { uid?: boolean } = {}) {
    const uid = opts.uid ?? true
    if (this.capabilities.has('MOVE')) return this.run(`${uid ? 'UID ' : ''}MOVE ${set} ${mailboxArg(dest)}`)
    await this.copy(set, dest, { uid })
    await this.store(set, ['\\Deleted'], 'add', { uid })
    if (uid && this.capabilities.has('UIDPLUS')) return this.run(`UID EXPUNGE ${set}`)
    return this.run('EXPUNGE')
  }

  async deleteMessages(set: string, opts: { uid?: boolean } = {}) {
    const uid = opts.uid ?? true
    await this.store(set, ['\\Deleted'], 'add', { uid })
    if (uid && this.capabilities.has('UIDPLUS')) return this.run(`UID EXPUNGE ${set}`)
    return this.run('EXPUNGE')
  }

  async expunge() {
    return this.run('EXPUNGE')
  }

  /** Returns the new UID if the server reports APPENDUID. */
  async append(path: string, bytes: Uint8Array, flags: string[] = [], date?: Date): Promise<number | null> {
    const pieces: Piece[] = [`APPEND ${mailboxArg(path)} (${flags.join(' ')}) `]
    if (date) pieces.push(`"${imapDate(date)}" `)
    pieces.push(bytes)
    const r = await this.run(pieces)
    if (r.code && tokStr(r.code[0]).toUpperCase() === 'APPENDUID') return tokNum(r.code[2])
    return null
  }

  // ---------- IDLE ----------

  /** Start idling. Untagged responses go to onUnsolicited. Any other command ends it. */
  startIdle(): Promise<void> {
    return this.exclusive(async () => {
      if (this.idleDone) return
      if (!this.supportsIdle) throw new Error('Server has no IDLE')
      if (this.closedErr) throw this.closedErr
      const tag = `A${++this.tagCounter}`
      const result = new Promise<CommandResult>((resolve, reject) => {
        this.current = { tag, untagged: [], resolve, reject, collectUntagged: false }
      })
      this.log('C', `${tag} IDLE`)
      const wait = this.waitContinuation()
      this.sock.write(`${tag} IDLE\r\n`)
      await wait
      this.idleDone = result
    })
  }

  stopIdle(): Promise<void> {
    return this.exclusive(() => this.stopIdleInternal())
  }

  private async stopIdleInternal() {
    const done = this.idleDone
    if (!done) return
    this.idleDone = null
    this.log('C', 'DONE')
    this.sock.write('DONE\r\n')
    await done
  }
}

// ---------- helpers ----------

/** Quote a string, or return it as a literal if it has CR/LF or non-ASCII. */
export function astring(s: string): Piece {
  if (/[\r\n-￿]/.test(s)) return te.encode(s)
  return `"${s.replace(/[\\"]/g, m => '\\' + m)}"`
}

export function mailboxArg(path: string): string {
  const enc = encodeUtf7Imap(path)
  return `"${enc.replace(/[\\"]/g, m => '\\' + m)}"`
}

function describe(pieces: Piece[]): string {
  return pieces
    .map(p => (typeof p === 'string' ? p : `{${p.length} bytes}`))
    .join('')
    .replace(/(LOGIN "[^"]*" )"[^"]*"/, '$1"***"')
    .replace(/(AUTHENTICATE PLAIN )\S+/, '$1***')
}

function summarize(parts: Array<string | Uint8Array>): string {
  return parts.map(p => (typeof p === 'string' ? p : `<${p.length} bytes>`)).join('').slice(0, 300)
}

function roleFromFlags(lower: string[]): FolderRole | null {
  if (lower.includes('\\inbox')) return 'inbox'
  if (lower.includes('\\sent')) return 'sent'
  if (lower.includes('\\drafts')) return 'drafts'
  if (lower.includes('\\trash')) return 'trash'
  if (lower.includes('\\junk') || lower.includes('\\spam')) return 'spam'
  if (lower.includes('\\archive')) return 'archive'
  if (lower.includes('\\all')) return 'all'
  return null
}

function roleFromName(path: string, name: string): FolderRole | null {
  if (path.toUpperCase() === 'INBOX') return 'inbox'
  const n = name.toLowerCase()
  if (/^(sent|sent items|sent mail|sent messages|gesendet|envoyés|enviados)$/.test(n)) return 'sent'
  if (/^(drafts|draft|entwürfe|brouillons|borradores)$/.test(n)) return 'drafts'
  if (/^(trash|deleted items|deleted messages|bin|papierkorb|corbeille|papelera)$/.test(n)) return 'trash'
  if (/^(spam|junk|junk e-mail|junk email|bulk mail)$/.test(n)) return 'spam'
  if (/^(archive|archives|all mail|archiv)$/.test(n)) return n.startsWith('all') ? 'all' : 'archive'
  return null
}

/** IMAP date-time: "06-Sep-2026 15:30:00 +0000" */
export function imapDate(d: Date): string {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${p(d.getDate())}-${MON[d.getMonth()]}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(a / 60))}${p(a % 60)}`
}

/** Compress a UID list into an IMAP sequence set: 1,2,3,7,9,10 -> "1:3,7,9:10" */
export function seqSet(uids: number[]): string {
  const s = [...new Set(uids)].sort((a, b) => a - b)
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++
    out.push(j > i ? `${s[i]}:${s[j]}` : String(s[i]))
    i = j + 1
  }
  return out.join(',')
}
