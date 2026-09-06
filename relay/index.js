#!/usr/bin/env node
/**
 * Envelope relay
 * ----------------
 * Browsers cannot open raw TCP sockets. This tiny program accepts a WebSocket
 * from the browser app and opens a TCP (or TLS) socket to the mail server the
 * browser asks for. It then copies bytes both ways. It does not read or parse
 * mail. It has no mail logic.
 *
 * Browser connects to:
 *   ws://127.0.0.1:8765/?host=imap.example.com&port=993&tls=1&token=SECRET
 *
 * Frames:
 *   binary frame  -> raw bytes to/from the mail server
 *   text frame    -> JSON control message
 *       {"cmd":"starttls"}   client asks to upgrade the plain socket to TLS
 *       {"ok":"starttls"}    relay answers when the upgrade is done
 *       {"error":"..."}      relay reports a problem, then closes
 *
 * Security:
 *   - Certificate validation is always on. It cannot be turned off.
 *   - Optional shared token (--token). Required for every connection if set.
 *   - Optional allow list of target hosts (--allow-host, repeatable).
 *   - Target ports are limited to mail ports unless you add more (--allow-port).
 *   - Listens on 127.0.0.1 by default. Use --host 0.0.0.0 to expose it, and
 *     then put it behind HTTPS (wss://) with a reverse proxy.
 */

import { createServer } from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { WebSocketServer } from 'ws'

const VERSION = '0.1.0'
const MAIL_PORTS = [25, 110, 143, 465, 587, 993, 995]
const MAX_BUFFERED = 1024 * 1024 // 1 MB of WebSocket backlog before we pause the TCP side

// ---------- config ----------

const { values: cli } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    token: { type: 'string' },
    config: { type: 'string' },
    'allow-host': { type: 'string', multiple: true },
    'allow-port': { type: 'string', multiple: true },
    'allow-origin': { type: 'string', multiple: true },
    'max-conns': { type: 'string' },
    'no-token': { type: 'boolean' },
    verbose: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (cli.help) {
  console.log(`envelope-relay v${VERSION}

Usage: envelope-relay [options]

  --port <n>            Listen port (default 8765)
  --host <addr>         Listen address (default 127.0.0.1)
  --token <secret>      Require this token on every connection
  --no-token             Disable the token requirement (NOT recommended — see README)
  --allow-host <h>      Only allow these target hosts (repeatable). Default: any
  --allow-port <n>      Extra target ports (repeatable). Default: ${MAIL_PORTS.join(', ')}
  --allow-origin <url>  Only accept browsers from these origins (repeatable)
  --max-conns <n>       Max open sockets (default 64)
  --config <file>       JSON file with the same keys (camelCase)
  --verbose             Log every connection
  -h, --help            This text

If no --token/RELAY_TOKEN/config token is given, one is generated randomly at
startup and printed below. Without a token, ANY web page open in the same
browser — not just this app — can use this relay as a network proxy. Only
pass --no-token if you understand and accept that.
`)
  process.exit(0)
}

let fileCfg = {}
const cfgPath = cli.config ?? (existsSync('./relay.config.json') ? './relay.config.json' : null)
if (cfgPath) {
  try {
    fileCfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  } catch (e) {
    console.error(`Cannot read config ${cfgPath}: ${e.message}`)
    process.exit(1)
  }
}

const noToken = cli['no-token'] ?? fileCfg.noToken ?? false
// A browser WebSocket handshake carries no custom headers, so any page open in the same
// browser can dial this relay unless a token gates it. Loopback binding alone does NOT stop
// that — it only stops OTHER machines. So unless the operator explicitly opts out with
// --no-token, generate a random one and require it.
const generatedToken = noToken ? null : randomBytes(24).toString('hex')

const cfg = {
  port: Number(cli.port ?? fileCfg.port ?? 8765),
  host: cli.host ?? fileCfg.host ?? '127.0.0.1',
  token: cli.token ?? fileCfg.token ?? process.env.RELAY_TOKEN ?? generatedToken,
  tokenWasGenerated: !cli.token && !fileCfg.token && !process.env.RELAY_TOKEN && !!generatedToken,
  allowHosts: (cli['allow-host'] ?? fileCfg.allowHosts ?? []).map(h => h.toLowerCase()),
  allowPorts: new Set([...MAIL_PORTS, ...(cli['allow-port'] ?? fileCfg.allowPorts ?? []).map(Number)]),
  allowOrigins: cli['allow-origin'] ?? fileCfg.allowOrigins ?? [],
  maxConns: Number(cli['max-conns'] ?? fileCfg.maxConns ?? 64),
  verbose: cli.verbose ?? fileCfg.verbose ?? false,
}

const log = (...a) => cfg.verbose && console.log(new Date().toISOString(), ...a)

// ---------- state ----------

let connections = 0
let totalConnections = 0

// ---------- http (health only) ----------

const http = createServer((req, res) => {
  // CORS for the browser app's health check. If allowOrigins is set, only those
  // origins get a CORS header; otherwise any origin may read /health (it holds
  // no secrets). The WebSocket path has its own origin check below.
  const origin = req.headers.origin
  const cors = {}
  if (origin && (!cfg.allowOrigins.length || cfg.allowOrigins.includes(origin))) {
    cors['access-control-allow-origin'] = origin
    cors['access-control-allow-headers'] = 'x-relay-token'
    cors['access-control-allow-methods'] = 'GET, OPTIONS'
    cors['vary'] = 'Origin'
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, name: 'envelope-relay', version: VERSION, connections, totalConnections }))
    return
  }
  res.writeHead(404)
  res.end()
})

// ---------- websocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })

http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  const reject = (code, msg) => {
    log('reject', code, msg, 'from', req.socket.remoteAddress)
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  // origin check (optional)
  if (cfg.allowOrigins.length) {
    const origin = req.headers.origin ?? ''
    if (!cfg.allowOrigins.includes(origin)) return reject(403, 'Origin not allowed')
  }

  // token check (optional)
  if (cfg.token) {
    const t = url.searchParams.get('token') ?? req.headers['x-relay-token']
    if (t !== cfg.token) return reject(401, 'Bad token')
  }

  // target validation
  const host = (url.searchParams.get('host') ?? '').trim().toLowerCase()
  const port = Number(url.searchParams.get('port'))
  const useTls = url.searchParams.get('tls') === '1'

  if (!host || !/^[a-z0-9.-]+$/.test(host)) return reject(400, 'Bad host')
  if (!Number.isInteger(port) || port < 1 || port > 65535) return reject(400, 'Bad port')
  if (!cfg.allowPorts.has(port)) return reject(403, 'Port not allowed')
  if (cfg.allowHosts.length && !cfg.allowHosts.includes(host)) return reject(403, 'Host not allowed')
  if (connections >= cfg.maxConns) return reject(503, 'Too many connections')

  wss.handleUpgrade(req, socket, head, ws => bridge(ws, { host, port, useTls, from: req.socket.remoteAddress }))
})

function bridge(ws, { host, port, useTls, from }) {
  connections++
  totalConnections++
  const id = totalConnections
  log(`#${id} open  ${from} -> ${host}:${port} tls=${useTls}`)

  let sock = null
  let closed = false

  const sendCtl = obj => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj))
  const finish = (reason = '') => {
    if (closed) return
    closed = true
    connections--
    log(`#${id} close ${reason}`)
    try { sock?.destroy() } catch {}
    try { ws.close(1000) } catch {}
  }
  const fail = msg => {
    log(`#${id} error ${msg}`)
    sendCtl({ error: msg })
    finish(msg)
  }

  // wire TCP -> WS with simple backpressure
  const hook = s => {
    s.on('data', chunk => {
      if (ws.readyState !== ws.OPEN) return
      ws.send(chunk, { binary: true }, () => {
        if (s.isPaused() && ws.bufferedAmount < MAX_BUFFERED) s.resume()
      })
      if (ws.bufferedAmount > MAX_BUFFERED) s.pause()
    })
    s.on('end', () => finish('server ended'))
    s.on('close', () => finish('server closed'))
    s.on('error', e => fail(`socket: ${e.message}`))
  }

  // open target
  const opts = { host, port }
  if (useTls) {
    sock = tls.connect({ ...opts, servername: host, rejectUnauthorized: true }, () => {
      if (!sock.authorized) return fail(`tls: ${sock.authorizationError}`)
      hook(sock)
      sendCtl({ ok: 'connected', tls: true })
    })
  } else {
    sock = net.connect(opts, () => {
      hook(sock)
      sendCtl({ ok: 'connected', tls: false })
    })
  }
  sock.setNoDelay(true)
  sock.setKeepAlive(true, 30_000)
  sock.setTimeout(10 * 60_000, () => fail('idle timeout'))
  sock.once('error', e => fail(`connect: ${e.message}`)) // before hook() takes over

  // WS -> TCP
  ws.on('message', (data, isBinary) => {
    if (closed) return
    if (isBinary) {
      if (sock && !sock.destroyed) sock.write(data)
      return
    }
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return fail('bad control frame') }
    if (msg.cmd === 'starttls') return startTls()
    if (msg.cmd === 'ping') return sendCtl({ ok: 'pong' })
    fail(`unknown cmd ${msg.cmd}`)
  })
  ws.on('close', () => finish('browser closed'))
  ws.on('error', e => fail(`ws: ${e.message}`))

  // upgrade plain socket to TLS (STARTTLS). Client must have finished the
  // protocol handshake (e.g. sent STARTTLS and got 220 / OK) before asking.
  function startTls() {
    if (!sock || sock instanceof tls.TLSSocket) return fail('starttls: not a plain socket')
    const plain = sock
    plain.removeAllListeners('data')
    plain.removeAllListeners('end')
    plain.removeAllListeners('close')
    plain.removeAllListeners('error')
    const secure = tls.connect({ socket: plain, servername: host, rejectUnauthorized: true }, () => {
      if (!secure.authorized) return fail(`tls: ${secure.authorizationError}`)
      sock = secure
      hook(secure)
      sendCtl({ ok: 'starttls' })
      log(`#${id} starttls ok`)
    })
    secure.once('error', e => fail(`starttls: ${e.message}`))
  }
}

// ---------- start ----------

http.listen(cfg.port, cfg.host, () => {
  console.log(`envelope-relay v${VERSION} listening on ws://${cfg.host}:${cfg.port}`)
  console.log(`  token: ${cfg.token ? 'required' : 'NONE'} · hosts: ${cfg.allowHosts.length ? cfg.allowHosts.join(', ') : 'any'} · ports: ${[...cfg.allowPorts].join(', ')}`)
  if (cfg.tokenWasGenerated) {
    console.log('')
    console.log(`  Generated token (paste into the app: Settings -> Relay -> Token):`)
    console.log(`    ${cfg.token}`)
    console.log('')
  }
  if (!cfg.token) {
    console.log('  WARNING: no token. Any web page open in this browser can use this relay. Restart without --no-token to fix.')
  }
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
    console.log('  WARNING: listening on a public address. Use --token and put it behind wss:// (HTTPS).')
  }
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nshutting down')
    wss.clients.forEach(c => c.close(1001))
    http.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  })
}
