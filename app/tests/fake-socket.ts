/**
 * Scripted fake server for protocol tests.
 *
 *   const s = new FakeSocket([
 *     { reply: '* OK ready\r\n' },                          // greeting (no expect)
 *     { expect: /^A1 LOGIN/, reply: 'A1 OK done\r\n' },
 *   ])
 *
 * Each client line (CRLF-terminated) is matched against the next step's
 * `expect`. Unmatched lines throw, so a test fails loudly.
 */
import type { SocketLike } from '@/engine/net/socket'

export interface Step {
  expect?: RegExp | string
  reply?: string | Uint8Array
  /** for STARTTLS: mark the socket secure when this step runs */
  tls?: boolean
}

const te = new TextEncoder()
const td = new TextDecoder()

export class FakeSocket implements SocketLike {
  readonly host = 'fake'
  readonly port = 0
  secure = false
  closed = false
  sent: string[] = []
  private inbox = ''
  private queue: Uint8Array[] = []
  private waiters: Array<(r: IteratorResult<Uint8Array>) => void> = []
  private steps: Step[]
  errors: string[] = []

  constructor(steps: Step[]) {
    this.steps = [...steps]
    // greeting: leading steps without expect fire immediately
    while (this.steps.length && this.steps[0]!.expect === undefined) this.fire(this.steps.shift()!)
  }

  private fire(step: Step) {
    if (step.tls) this.secure = true
    if (step.reply !== undefined) this.push(typeof step.reply === 'string' ? te.encode(step.reply) : step.reply)
  }

  private push(chunk: Uint8Array) {
    const w = this.waiters.shift()
    if (w) w({ value: chunk, done: false })
    else this.queue.push(chunk)
  }

  write(data: Uint8Array | string) {
    const s = typeof data === 'string' ? data : td.decode(data)
    this.inbox += s
    for (;;) {
      const i = this.inbox.indexOf('\r\n')
      if (i < 0) break
      const line = this.inbox.slice(0, i)
      this.inbox = this.inbox.slice(i + 2)
      this.sent.push(line)
      this.handleLine(line)
    }
  }

  private handleLine(line: string) {
    const step = this.steps[0]
    if (!step) {
      this.errors.push(`unexpected client line: ${line}`)
      return
    }
    const exp = step.expect
    const ok = exp === undefined ? true : typeof exp === 'string' ? line === exp : exp.test(line)
    if (!ok) {
      this.errors.push(`expected ${String(exp)} but got: ${line}`)
      return
    }
    this.steps.shift()
    this.fire(step)
    // any follow-up steps without expect fire right away (e.g. multi-chunk replies)
    while (this.steps.length && this.steps[0]!.expect === undefined) this.fire(this.steps.shift()!)
  }

  read(): Promise<IteratorResult<Uint8Array>> {
    const c = this.queue.shift()
    if (c) return Promise.resolve({ value: c, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise(res => this.waiters.push(res))
  }

  [Symbol.asyncIterator]() {
    return { next: () => this.read() }
  }

  startTls(): Promise<void> {
    this.secure = true
    return Promise.resolve()
  }

  close() {
    this.closed = true
    const done: IteratorResult<Uint8Array> = { value: undefined, done: true }
    this.waiters.splice(0).forEach(w => w(done))
  }

  /** Throws if the script saw anything unexpected or has steps left. */
  assertDone() {
    if (this.errors.length) throw new Error(this.errors.join('\n'))
    if (this.steps.length) throw new Error(`script has ${this.steps.length} unused steps; next expects ${String(this.steps[0]!.expect)}`)
  }
}
