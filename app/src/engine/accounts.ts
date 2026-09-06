/**
 * Accounts: CRUD, credentials, connection test, and small dev helpers.
 */
import type { Account, AccountInput, AccountTestResult, AccountTestStep } from '@/shared/accounts'
import { deleteSecret, getSecret, isUnlocked, putSecret } from './crypto/master'
import { getDb, now, type Row } from './db'
import { ImapClient, type Logger } from './imap/client'
import { parseEnvelope } from './imap/envelope'
import { tokStr } from './imap/parser'
import { buildMessage } from './mime/build'
import { Pop3Client } from './pop3/client'
import { log } from './rpc/server'
import { getAllSettings } from './settings'
import { SmtpClient } from './smtp/client'

// ---------- mapping ----------

function rowToAccount(r: Row): Account {
  return {
    id: Number(r.id),
    name: String(r.name),
    email: String(r.email),
    displayName: String(r.display_name),
    color: String(r.color),
    sortOrder: Number(r.sort_order),
    enabled: !!r.enabled,
    kind: r.kind as 'imap' | 'pop3',
    inHost: String(r.in_host),
    inPort: Number(r.in_port),
    inSecurity: r.in_security as Account['inSecurity'],
    inUser: String(r.in_user),
    smtpHost: String(r.smtp_host),
    smtpPort: Number(r.smtp_port),
    smtpSecurity: r.smtp_security as Account['smtpSecurity'],
    smtpUser: String(r.smtp_user),
    smtpSameCreds: !!r.smtp_same_creds,
    smtpCopyToSent: !!r.smtp_copy_to_sent,
    popLeaveOnServer: !!r.pop_leave_on_server,
    popDeleteAfterDays: Number(r.pop_delete_after_days),
    pollMinutes: Number(r.poll_minutes),
    notify: !!r.notify,
    hasInPassword: r.in_secret_id != null,
    hasSmtpPassword: r.smtp_secret_id != null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

export async function listAccounts(): Promise<Account[]> {
  const db = await getDb()
  return (await db.all<Row>('SELECT * FROM accounts ORDER BY sort_order, id')).map(rowToAccount)
}

export async function getAccount(id: number): Promise<Account> {
  const db = await getDb()
  const r = await db.get<Row>('SELECT * FROM accounts WHERE id = ?', [id])
  if (!r) throw new Error(`Account ${id} not found`)
  return rowToAccount(r)
}

export async function saveAccount(a: AccountInput): Promise<Account> {
  const db = await getDb()
  if (!a.email.includes('@')) throw new Error('Email address looks wrong.')
  if ((a.inPassword || a.smtpPassword) && !isUnlocked()) throw new Error('Set or unlock the master password first.')

  return db.tx(async () => {
    const existing = a.id ? await db.get<Row>('SELECT * FROM accounts WHERE id = ?', [a.id]) : null
    let inSecret = existing ? (existing.in_secret_id as number | null) : null
    let smtpSecret = existing ? (existing.smtp_secret_id as number | null) : null
    if (a.inPassword) inSecret = await putSecret(a.inPassword, inSecret ?? undefined)
    if (a.smtpSameCreds) {
      if (smtpSecret) {
        await deleteSecret(smtpSecret)
        smtpSecret = null
      }
    } else if (a.smtpPassword) {
      smtpSecret = await putSecret(a.smtpPassword, smtpSecret ?? undefined)
    }

    const cols: Record<string, unknown> = {
      name: a.name || a.email,
      email: a.email.trim(),
      display_name: a.displayName,
      color: a.color,
      enabled: a.enabled ? 1 : 0,
      kind: a.kind,
      in_host: a.inHost.trim(),
      in_port: a.inPort,
      in_security: a.inSecurity,
      in_user: a.inUser,
      in_secret_id: inSecret,
      smtp_host: a.smtpHost.trim(),
      smtp_port: a.smtpPort,
      smtp_security: a.smtpSecurity,
      smtp_user: a.smtpSameCreds ? a.inUser : a.smtpUser,
      smtp_secret_id: smtpSecret,
      smtp_same_creds: a.smtpSameCreds ? 1 : 0,
      smtp_copy_to_sent: a.smtpCopyToSent ? 1 : 0,
      pop_leave_on_server: a.popLeaveOnServer ? 1 : 0,
      pop_delete_after_days: a.popDeleteAfterDays,
      poll_minutes: a.pollMinutes,
      notify: a.notify ? 1 : 0,
      updated_at: now(),
    }
    const keys = Object.keys(cols)
    const vals = keys.map(k => cols[k] as never)
    let id: number
    if (existing) {
      await db.exec(`UPDATE accounts SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...vals, a.id!])
      id = a.id!
    } else {
      const order = Number(await db.scalar<number>('SELECT coalesce(max(sort_order), 0) + 1 FROM accounts'))
      id = await db.insert(`INSERT INTO accounts (${keys.join(', ')}, sort_order, created_at) VALUES (${keys.map(() => '?').join(', ')}, ?, ?)`, [...vals, order, now()])
    }
    return getAccount(id)
  })
}

export async function deleteAccount(id: number) {
  const db = await getDb()
  await db.tx(async () => {
    const r = await db.get<Row>('SELECT in_secret_id, smtp_secret_id FROM accounts WHERE id = ?', [id])
    await db.exec('DELETE FROM accounts WHERE id = ?', [id])
    if (r?.in_secret_id != null) await deleteSecret(Number(r.in_secret_id))
    if (r?.smtp_secret_id != null) await deleteSecret(Number(r.smtp_secret_id))
  })
  try {
    await db.exec('VACUUM')
  } catch {
    /* ignore */
  }
}

export interface Credentials {
  inUser: string
  inPass: string
  smtpUser: string
  smtpPass: string
}

export async function getCredentials(a: Account, override?: Partial<Pick<AccountInput, 'inPassword' | 'smtpPassword'>>): Promise<Credentials> {
  const db = await getDb()
  const r = await db.get<Row>('SELECT in_secret_id, smtp_secret_id FROM accounts WHERE id = ?', [a.id])
  const inPass = override?.inPassword ?? (r?.in_secret_id != null ? await getSecret(Number(r.in_secret_id)) : '')
  const smtpPass = a.smtpSameCreds ? inPass : (override?.smtpPassword ?? (r?.smtp_secret_id != null ? await getSecret(Number(r.smtp_secret_id)) : ''))
  return { inUser: a.inUser, inPass, smtpUser: a.smtpSameCreds ? a.inUser : a.smtpUser, smtpPass }
}

// ---------- connections ----------

export async function relayOpts() {
  const s = await getAllSettings()
  return { relayUrl: s['relay.url'], token: s['relay.token'] || undefined }
}

const protoLogger = (tag: string): Logger => (dir, line) => log('debug', `[${tag}] ${dir} ${line}`)

export async function openImap(a: Account, creds: Credentials): Promise<ImapClient> {
  const r = await relayOpts()
  const c = await ImapClient.connect({ ...r, host: a.inHost, port: a.inPort, security: a.inSecurity, logger: protoLogger(`imap ${a.email}`) })
  await c.login(creds.inUser, creds.inPass)
  return c
}

export async function openPop3(a: Account, creds: Credentials): Promise<Pop3Client> {
  const r = await relayOpts()
  const c = await Pop3Client.connect({ ...r, host: a.inHost, port: a.inPort, security: a.inSecurity, logger: protoLogger(`pop3 ${a.email}`) })
  await c.login(creds.inUser, creds.inPass)
  return c
}

export async function openSmtp(a: Account, creds: Credentials): Promise<SmtpClient> {
  const r = await relayOpts()
  const c = await SmtpClient.connect({ ...r, host: a.smtpHost, port: a.smtpPort, security: a.smtpSecurity, ehloName: 'envelope.local', logger: protoLogger(`smtp ${a.email}`) })
  if (creds.smtpUser || creds.smtpPass) await c.auth(creds.smtpUser, creds.smtpPass)
  return c
}

// ---------- test ----------

export async function testAccount(input: AccountInput): Promise<AccountTestResult> {
  const steps: AccountTestStep[] = []
  const result: AccountTestResult = { ok: false, steps }
  const timed = async <T>(key: string, label: string, fn: () => Promise<T>, detail?: (v: T) => string): Promise<T | null> => {
    const t0 = performance.now()
    try {
      const v = await fn()
      steps.push({ key, label, ok: true, ms: Math.round(performance.now() - t0), detail: detail?.(v) })
      return v
    } catch (e) {
      steps.push({ key, label, ok: false, ms: Math.round(performance.now() - t0), detail: (e as Error).message })
      return null
    }
  }

  // pretend-account so we can reuse the open* helpers
  const fake: Account = {
    ...input,
    id: input.id ?? 0,
    sortOrder: 0,
    hasInPassword: !!input.inPassword,
    hasSmtpPassword: !!input.smtpPassword,
    createdAt: 0,
    updatedAt: 0,
  }
  const creds: Credentials =
    input.id && (!input.inPassword || (!input.smtpSameCreds && !input.smtpPassword))
      ? await getCredentials(await getAccount(input.id), { inPassword: input.inPassword || undefined, smtpPassword: input.smtpPassword || undefined })
      : { inUser: input.inUser, inPass: input.inPassword ?? '', smtpUser: input.smtpSameCreds ? input.inUser : input.smtpUser, smtpPass: input.smtpSameCreds ? (input.inPassword ?? '') : (input.smtpPassword ?? '') }

  const r = await relayOpts()
  const relayOk = await timed('relay', 'Relay', async () => {
    const u = new URL(r.relayUrl)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.pathname = '/health'
    const res = await fetch(u.toString())
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as { version: string }
  }, v => `v${v.version}`)
  if (!relayOk) return result

  if (input.kind === 'imap') {
    let c: ImapClient | null = null
    c = await timed('in-connect', `IMAP connect${input.inSecurity !== 'none' ? ' + TLS' : ''}`, async () => {
      return ImapClient.connect({ ...r, host: input.inHost, port: input.inPort, security: input.inSecurity, logger: protoLogger('imap test') })
    }, v => v.greeting.slice(0, 60))
    if (c) {
      const login = await timed('in-login', 'IMAP login', () => c!.login(creds.inUser, creds.inPass))
      if (login !== null) {
        const boxes = await timed('in-list', 'IMAP folders', () => c!.list(), v => `${v.length} folders`)
        result.folders = boxes?.length
        result.idle = c.supportsIdle
        result.capabilities = [...c.capabilities]
        steps.push({ key: 'in-idle', label: 'Instant push (IDLE)', ok: c.supportsIdle, ms: 0, detail: c.supportsIdle ? 'supported' : 'not supported — will poll every minute' })
      }
      await c.logout()
    }
  } else {
    const c = await timed('in-connect', `POP3 connect${input.inSecurity !== 'none' ? ' + TLS' : ''}`, () =>
      Pop3Client.connect({ ...r, host: input.inHost, port: input.inPort, security: input.inSecurity, logger: protoLogger('pop3 test') }), v => v.greeting.slice(0, 60))
    if (c) {
      const login = await timed('in-login', 'POP3 login', () => c.login(creds.inUser, creds.inPass))
      if (login !== null) await timed('in-stat', 'POP3 mailbox', () => c.stat(), v => `${v.count} messages`)
      await c.quit()
    }
  }

  const s = await timed('smtp-connect', `SMTP connect${input.smtpSecurity === 'starttls' ? ' + STARTTLS' : input.smtpSecurity === 'tls' ? ' + TLS' : ''}`, () =>
    SmtpClient.connect({ ...r, host: input.smtpHost, port: input.smtpPort, security: input.smtpSecurity, ehloName: 'envelope.local', logger: protoLogger('smtp test') }), v => v.greeting.slice(0, 60))
  if (s) {
    if (creds.smtpUser || creds.smtpPass) await timed('smtp-login', 'SMTP login', () => s.auth(creds.smtpUser, creds.smtpPass))
    await s.quit()
  }

  result.ok = steps.every(x => x.ok || x.key === 'in-idle')
  void fake
  return result
}

// ---------- dev helpers (Phase 4 exit checks) ----------

export async function devListFolders(accountId: number) {
  const a = await getAccount(accountId)
  const c = await openImap(a, await getCredentials(a))
  try {
    return await c.list()
  } finally {
    await c.logout()
  }
}

export async function devFetchRecent(accountId: number, path: string, n: number) {
  const a = await getAccount(accountId)
  const c = await openImap(a, await getCredentials(a))
  try {
    const st = await c.select(path, true)
    if (!st.exists) return []
    const from = Math.max(1, st.exists - n + 1)
    const items = await c.fetch(`${from}:${st.exists}`, ['UID', 'FLAGS', 'ENVELOPE', 'RFC822.SIZE'], { uid: false })
    return items.map(i => {
      const env = parseEnvelope(i.attrs.get('ENVELOPE'))
      return {
        uid: i.uid,
        subject: env.subject,
        from: env.from.map(f => (f.name ? `${f.name} <${f.address}>` : f.address)).join(', '),
        date: env.date?.toISOString() ?? null,
        flags: (i.attrs.get('FLAGS') as unknown[] | undefined)?.map(t => tokStr(t as never)) ?? [],
        size: Number(i.attrs.get('RFC822.SIZE') ?? 0),
      }
    }).reverse()
  } finally {
    await c.logout()
  }
}

export async function devSendMail(accountId: number, to: string, subject: string, text: string) {
  const a = await getAccount(accountId)
  const creds = await getCredentials(a)
  const msg = buildMessage({
    from: { name: a.displayName || undefined, address: a.email },
    to: [{ address: to }],
    subject,
    text,
    userAgent: 'Envelope/0.1',
  })
  const s = await openSmtp(a, creds)
  try {
    const reply = await s.send({ from: a.email, to: msg.recipients, data: msg.bytes })
    log('info', `sent ${msg.messageId}: ${reply}`)
    return { messageId: msg.messageId, reply }
  } finally {
    await s.quit()
  }
}
