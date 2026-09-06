/**
 * RelaySocket — a TCP-like socket that runs over the relay's WebSocket.
 *
 * Works in the worker and in the UI thread. Binary frames carry bytes.
 * Text frames carry JSON control messages (connected / starttls / error).
 *
 *   const s = await RelaySocket.connect({ relayUrl, host, port, tls: true })
 *   s.write(bytes)
 *   for await (const chunk of s) { ... }
 *   await s.startTls()   // after the protocol's STARTTLS handshake
 *   s.close()
 */

export interface RelaySocketOptions {
  relayUrl: string
  token?: string
  host: string
  port: number
  tls: boolean
  /** ms to wait for the relay + target to connect. Default 15000. */
  connectTimeout?: number
}

type Ctl = { ok?: string; tls?: boolean; error?: string }

import type { SocketLike } from './socket'

export class RelaySocket implements SocketLike {
  private ws!: WebSocket
  private queue: Uint8Array[] = []
  private waiters: Array<(v: IteratorResult<Uint8Array>) => void> = []
  private ctlWaiters: Array<{ ok: string; resolve: () => void; reject: (e: Error) => void }> = []
  private closedReason: Error | null = null
  private _closed = false

  readonly host: string
  readonly port: number
  secure: boolean

  private constructor(opts: RelaySocketOptions) {
    this.host = opts.host
    this.port = opts.port
    this.secure = opts.tls
  }

  get closed() {
    return this._closed
  }

  static connect(opts: RelaySocketOptions): Promise<RelaySocket> {
    const sock = new RelaySocket(opts)
    return new Promise((resolve, reject) => {
      const u = new URL(opts.relayUrl)
      u.searchParams.set('host', opts.host)
      u.searchParams.set('port', String(opts.port))
      u.searchParams.set('tls', opts.tls ? '1' : '0')
      if (opts.token) u.searchParams.set('token', opts.token)

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        sock.destroy(new Error('Connect timeout'))
        reject(new Error(`Connect timeout to ${opts.host}:${opts.port}`))
      }, opts.connectTimeout ?? 15000)

      const ws = new WebSocket(u.toString())
      ws.binaryType = 'arraybuffer'
      sock.ws = ws

      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === 'string') {
          let ctl: Ctl
          try {
            ctl = JSON.parse(ev.data)
          } catch {
            return
          }
          if (ctl.error) {
            const err = new Error(ctl.error)
            if (!settled) {
              settled = true
              clearTimeout(timer)
              reject(err)
            }
            sock.destroy(err)
            return
          }
          if (ctl.ok === 'connected' && !settled) {
            settled = true
            clearTimeout(timer)
            resolve(sock)
            return
          }
          if (ctl.ok) {
            const i = sock.ctlWaiters.findIndex(w => w.ok === ctl.ok)
            if (i >= 0) sock.ctlWaiters.splice(i, 1)[0]!.resolve()
          }
          return
        }
        sock.push(new Uint8Array(ev.data as ArrayBuffer))
      }
      ws.onerror = () => {
        const err = new Error(`Relay connection failed (${opts.relayUrl})`)
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
        sock.destroy(err)
      }
      ws.onclose = (ev) => {
        const err = new Error(ev.reason || `Socket closed (${ev.code})`)
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
        sock.destroy(ev.code === 1000 ? null : err)
      }
    })
  }

  /** Send raw bytes. */
  write(data: Uint8Array | string) {
    if (this._closed) throw this.closedReason ?? new Error('Socket closed')
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    // TS 5.7+ types Uint8Array over ArrayBufferLike; WebSocket wants a plain ArrayBuffer view.
    this.ws.send(bytes as Uint8Array<ArrayBuffer>)
  }

  /**
   * Ask the relay to wrap the plain socket in TLS. Only call after the
   * protocol said yes to STARTTLS (e.g. SMTP "220", IMAP "OK Begin TLS").
   */
  startTls(): Promise<void> {
    if (this.secure) return Promise.reject(new Error('Already secure'))
    return new Promise((resolve, reject) => {
      this.ctlWaiters.push({
        ok: 'starttls',
        resolve: () => {
          this.secure = true
          resolve()
        },
        reject,
      })
      this.ws.send(JSON.stringify({ cmd: 'starttls' }))
    })
  }

  /** Next chunk of bytes, or done when closed. */
  read(): Promise<IteratorResult<Uint8Array>> {
    const chunk = this.queue.shift()
    if (chunk) return Promise.resolve({ value: chunk, done: false })
    if (this._closed) {
      if (this.closedReason) return Promise.reject(this.closedReason)
      return Promise.resolve({ value: undefined, done: true })
    }
    return new Promise(res => this.waiters.push(res))
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return { next: () => this.read() }
  }

  close() {
    this.destroy(null)
  }

  private push(chunk: Uint8Array) {
    const w = this.waiters.shift()
    if (w) w({ value: chunk, done: false })
    else this.queue.push(chunk)
  }

  private destroy(err: Error | null) {
    if (this._closed) return
    this._closed = true
    this.closedReason = err
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(1000)
    } catch {
      /* ignore */
    }
    // wake up readers
    const done: IteratorResult<Uint8Array> = { value: undefined, done: true }
    this.waiters.splice(0).forEach(w => w(done))
    this.ctlWaiters.splice(0).forEach(w => w.reject(err ?? new Error('Socket closed')))
  }
}

export { LineReader } from './socket'
