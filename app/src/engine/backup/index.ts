/**
 * Backup = one JSON file with accounts, settings, contacts, rules, signatures.
 * Account passwords stay encrypted (AES-GCM under the master key). The file
 * carries the KDF params so it can be opened later with the same master
 * password, even on a fresh install.
 *
 * Full database dump/import is separate: raw SQLite bytes.
 */
import { ENGINE_VERSION, type BackupFile, type BackupOptions, type ImportResult } from '@/shared/rpc'
import { SETTINGS_DEFAULTS, type SettingKey, type Settings } from '@/shared/settings'
import { getDb, lockDbForImport, migrate, now, resetDb, type Row } from '../db'
import { DB_FILE } from '../db/open'
import { decryptForeignSecret, exportSecretsRaw, isUnlocked, putSecret, revalidateKey } from '../crypto/master'
import { getAllSettings, invalidateSettingsCache, setSetting } from '../settings'
import { log } from '../rpc/server'
import { startSyncEngine, stopAllAccounts } from '../sync'

const SETTINGS_EXCLUDED: SettingKey[] = ['backup.disk.lastSavedAt', 'backup.disk.folderName']

/** Minimal shape of FileSystemSyncAccessHandle (worker-only API). */
interface SyncAccessHandle {
  truncate(size: number): void
  write(buffer: BufferSource, options?: { at: number }): number
  flush(): void
  close(): void
}

export async function backupExport(opts: BackupOptions): Promise<BackupFile> {
  const db = await getDb()
  const file: BackupFile = { format: 'mailclient-backup', version: 1, exportedAt: new Date().toISOString(), appVersion: ENGINE_VERSION }

  if (opts.settings) {
    const all = await getAllSettings()
    const out: Partial<Settings> = {}
    for (const k of Object.keys(all) as SettingKey[]) {
      if (SETTINGS_EXCLUDED.includes(k)) continue
      if (all[k] !== SETTINGS_DEFAULTS[k]) (out as Record<string, unknown>)[k] = all[k]
    }
    file.settings = out
  }

  if (opts.accounts) {
    const rows = await db.all<Row>('SELECT * FROM accounts ORDER BY sort_order, id')
    const ids = rows.flatMap(r => [r.in_secret_id, r.smtp_secret_id]).filter((x): x is number => typeof x === 'number')
    const { kdf, secrets } = await exportSecretsRaw(ids)
    if (kdf) file.kdf = kdf
    file.accounts = rows.map(r => {
      const { id: _id, in_secret_id, smtp_secret_id, ...rest } = r
      const s: Record<string, { ct: string; iv: string }> = {}
      if (typeof in_secret_id === 'number' && secrets[in_secret_id]) s.in = secrets[in_secret_id]!
      if (typeof smtp_secret_id === 'number' && secrets[smtp_secret_id]) s.smtp = secrets[smtp_secret_id]!
      return { ...rest, secrets: s }
    })
    if (opts.signatures) {
      file.signatures = await db.all<Row>(
        `SELECT a.email AS account_email, s.is_html, s.content, s.position, s.use_on_reply
         FROM signatures s JOIN accounts a ON a.id = s.account_id`,
      )
    }
  }

  if (opts.contacts) {
    const contacts = await db.all<Row>('SELECT * FROM contacts ORDER BY id')
    const emails = await db.all<Row>('SELECT contact_id, email, label, is_primary FROM contact_emails ORDER BY id')
    const groups = await db.all<Row>(
      `SELECT m.contact_id, g.name FROM contact_group_members m JOIN contact_groups g ON g.id = m.group_id`,
    )
    file.contacts = contacts.map(c => {
      const { id, ...rest } = c
      return {
        ...rest,
        emails: emails.filter(e => e.contact_id === id).map(({ contact_id: _c, ...e }) => e),
        groups: groups.filter(g => g.contact_id === id).map(g => g.name),
      }
    })
  }

  if (opts.rules) {
    const rules = await db.all<Row>('SELECT * FROM rules ORDER BY sort_order, id')
    const conds = await db.all<Row>('SELECT rule_id, field, op, value FROM rule_conditions ORDER BY id')
    const acts = await db.all<Row>('SELECT rule_id, kind, arg FROM rule_actions ORDER BY id')
    const accountEmails = new Map<number, string>()
    for (const a of await db.all<{ id: number; email: string }>('SELECT id, email FROM accounts')) accountEmails.set(a.id, a.email)
    file.rules = rules.map(r => {
      const { id, account_id, ...rest } = r
      return {
        ...rest,
        account_email: typeof account_id === 'number' ? (accountEmails.get(account_id) ?? null) : null,
        conditions: conds.filter(c => c.rule_id === id).map(({ rule_id: _r, ...c }) => c),
        actions: acts.filter(a => a.rule_id === id).map(({ rule_id: _r, ...a }) => a),
      }
    })
  }

  file.senderImageAllow = (await db.all<{ pattern: string }>('SELECT pattern FROM sender_image_allow')).map(r => r.pattern)
  return file
}

export async function backupImport(file: BackupFile, backupPassword?: string): Promise<ImportResult> {
  if (file?.format !== 'mailclient-backup' || file.version !== 1) throw new Error('Not a MailClient backup file.')
  // Pause sync while accounts/settings are replaced so a running account runner can't act on
  // rows mid-swap (stale credentials, an account id that just got reused, etc). Restarted in
  // the finally below, whether the import succeeds or fails.
  stopAllAccounts()
  try {
    return await backupImportInner(file, backupPassword)
  } finally {
    void startSyncEngine()
  }
}

async function backupImportInner(file: BackupFile, backupPassword?: string): Promise<ImportResult> {
  const db = await getDb()
  const res: ImportResult = { accounts: 0, settings: 0, contacts: 0, rules: 0, signatures: 0 }

  // Accounts need the master key (to re-encrypt passwords under our key).
  if (file.accounts?.length && !isUnlocked()) throw new Error('Unlock with your master password before importing accounts.')

  // Pre-decrypt all secrets first, so a wrong password fails before we write anything.
  const decrypted = new Map<number, { in?: string; smtp?: string }>()
  if (file.accounts) {
    for (let i = 0; i < file.accounts.length; i++) {
      const a = file.accounts[i]!
      const d: { in?: string; smtp?: string } = {}
      try {
        if (a.secrets?.in) d.in = await decryptForeignSecret(a.secrets.in, file.kdf, backupPassword)
        if (a.secrets?.smtp) d.smtp = await decryptForeignSecret(a.secrets.smtp, file.kdf, backupPassword)
      } catch (e) {
        if ((e as Error).name === 'NeedsBackupPassword') return { ...res, needsBackupPassword: true }
        throw e
      }
      decrypted.set(i, d)
    }
  }

  await db.tx(async () => {
    if (file.settings) {
      for (const [k, v] of Object.entries(file.settings)) {
        if (!(k in SETTINGS_DEFAULTS)) continue
        await setSetting(k as SettingKey, v as never)
        res.settings++
      }
    }

    const accountIdByEmail = new Map<string, number>()
    for (const a of await db.all<{ id: number; email: string }>('SELECT id, email FROM accounts')) accountIdByEmail.set(a.email.toLowerCase(), a.id)

    if (file.accounts) {
      for (let i = 0; i < file.accounts.length; i++) {
        const { secrets: _s, ...a } = file.accounts[i]!
        const d = decrypted.get(i) ?? {}
        const email = String(a.email ?? '').toLowerCase()
        const inSecret = d.in !== undefined ? await putSecret(d.in) : null
        const smtpSecret = d.smtp !== undefined ? await putSecret(d.smtp) : null
        const cols = [
          'name', 'email', 'display_name', 'color', 'sort_order', 'enabled', 'kind', 'in_host', 'in_port', 'in_security', 'in_user',
          'smtp_host', 'smtp_port', 'smtp_security', 'smtp_user', 'smtp_same_creds', 'smtp_copy_to_sent',
          'pop_leave_on_server', 'pop_delete_after_days', 'poll_minutes', 'notify',
        ]
        const vals = cols.map(c => (a[c] as never) ?? null)
        const existing = accountIdByEmail.get(email)
        if (existing) {
          await db.exec(
            `UPDATE accounts SET ${cols.map(c => `${c} = ?`).join(', ')}, in_secret_id = coalesce(?, in_secret_id), smtp_secret_id = coalesce(?, smtp_secret_id), updated_at = ? WHERE id = ?`,
            [...vals, inSecret, smtpSecret, now(), existing],
          )
        } else {
          const id = await db.insert(
            `INSERT INTO accounts (${cols.join(', ')}, in_secret_id, smtp_secret_id, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?, ?)`,
            [...vals, inSecret, smtpSecret, now(), now()],
          )
          accountIdByEmail.set(email, id)
        }
        res.accounts++
      }
    }

    if (file.signatures) {
      for (const s of file.signatures) {
        const id = accountIdByEmail.get(String(s.account_email ?? '').toLowerCase())
        if (!id) continue
        await db.exec(
          `INSERT INTO signatures (account_id, is_html, content, position, use_on_reply) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET is_html = excluded.is_html, content = excluded.content, position = excluded.position, use_on_reply = excluded.use_on_reply`,
          [id, Number(s.is_html ?? 1), String(s.content ?? ''), String(s.position ?? 'above'), Number(s.use_on_reply ?? 1)],
        )
        res.signatures++
      }
    }

    if (file.contacts) {
      for (const c of file.contacts) {
        const emails = (c.emails as Array<{ email: string; label?: string; is_primary?: number }>) ?? []
        // merge by first email if it already exists
        let contactId: number | null = null
        for (const e of emails) {
          const hit = await db.get<{ contact_id: number }>('SELECT contact_id FROM contact_emails WHERE lower(email) = lower(?)', [e.email])
          if (hit) {
            contactId = hit.contact_id
            break
          }
        }
        const fields = [String(c.first_name ?? ''), String(c.last_name ?? ''), String(c.display_name ?? ''), String(c.phone ?? ''), String(c.notes ?? ''), String(c.kind ?? 'saved')]
        if (contactId) {
          await db.exec('UPDATE contacts SET first_name=?, last_name=?, display_name=?, phone=?, notes=?, kind=?, updated_at=? WHERE id=?', [...fields, now(), contactId])
        } else {
          contactId = await db.insert('INSERT INTO contacts (first_name, last_name, display_name, phone, notes, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', [...fields, now(), now()])
        }
        for (const e of emails) {
          await db.exec(
            `INSERT INTO contact_emails (contact_id, email, label, is_primary) VALUES (?, ?, ?, ?)
             ON CONFLICT(lower(email)) DO UPDATE SET contact_id = excluded.contact_id, label = excluded.label, is_primary = excluded.is_primary`,
            [contactId, e.email, e.label ?? 'work', Number(e.is_primary ?? 0)],
          )
        }
        for (const g of (c.groups as string[]) ?? []) {
          await db.exec('INSERT OR IGNORE INTO contact_groups (name) VALUES (?)', [g])
          const gid = await db.scalar<number>('SELECT id FROM contact_groups WHERE name = ?', [g])
          await db.exec('INSERT OR IGNORE INTO contact_group_members (contact_id, group_id) VALUES (?, ?)', [contactId, gid])
        }
        res.contacts++
      }
    }

    if (file.rules) {
      const maxOrder = Number(await db.scalar<number>('SELECT coalesce(max(sort_order), 0) FROM rules'))
      let i = 0
      for (const r of file.rules) {
        const accountId = r.account_email ? (accountIdByEmail.get(String(r.account_email).toLowerCase()) ?? null) : null
        const id = await db.insert('INSERT INTO rules (name, enabled, match_mode, account_id, sort_order, created_at) VALUES (?,?,?,?,?,?)', [
          String(r.name ?? 'Rule'), Number(r.enabled ?? 1), String(r.match_mode ?? 'any'), accountId, maxOrder + ++i, now(),
        ])
        for (const c of (r.conditions as Array<Record<string, unknown>>) ?? [])
          await db.exec('INSERT INTO rule_conditions (rule_id, field, op, value) VALUES (?,?,?,?)', [id, String(c.field), String(c.op), String(c.value ?? '')])
        for (const a of (r.actions as Array<Record<string, unknown>>) ?? [])
          await db.exec('INSERT INTO rule_actions (rule_id, kind, arg) VALUES (?,?,?)', [id, String(a.kind), String(a.arg ?? '')])
        res.rules++
      }
    }

    for (const p of file.senderImageAllow ?? []) await db.exec('INSERT OR IGNORE INTO sender_image_allow (pattern, created_at) VALUES (?, ?)', [p, now()])
  })

  invalidateSettingsCache()
  log('info', `Backup imported: ${JSON.stringify(res)}`)
  return res
}

// ---------- whole-database dump / import ----------

export async function dbDump(): Promise<Uint8Array> {
  const db = await getDb()
  return db.dump()
}

export async function dbImport(bytes: Uint8Array): Promise<void> {
  // quick sanity check: SQLite header
  const magic = new TextDecoder().decode(bytes.subarray(0, 15))
  if (magic !== 'SQLite format 3') throw new Error('Not a SQLite database file.')

  // This closes the live connection and overwrites the file directly — nothing here goes
  // through db.tx(), so it needs its own protection: pause every sync runner (the other
  // regular DB writers) AND hold the import lock so any other getDb() caller (cache-prune's
  // daily timer, a stray RPC call) waits instead of racing the close/reopen or briefly
  // opening a second connection onto a half-written file.
  stopAllAccounts()
  const db = await getDb()
  const mode = db.mode
  const release = lockDbForImport()
  try {
    if (mode === 'idb') {
      // IndexedDB driver: the library can stream into itself
      await db.raw.sync(new Blob([bytes as BlobPart]).stream())
      await resetDb()
    } else {
      // OPFS: the open connection holds a sync handle on the file, so close
      // first, overwrite the file directly, then reopen.
      await resetDb()
      const root = await navigator.storage.getDirectory()
      const fh = await root.getFileHandle(DB_FILE, { create: true })
      // createSyncAccessHandle exists only in workers; the app tsconfig uses the DOM lib
      const h = await (fh as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }).createSyncAccessHandle()
      try {
        h.truncate(0)
        h.write(bytes as BufferSource, { at: 0 })
        h.flush()
      } finally {
        h.close()
      }
      for (const side of ['-wal', '-journal']) {
        try {
          await root.removeEntry(DB_FILE + side)
        } catch {
          /* not there */
        }
      }
    }
  } finally {
    release()
  }
  try {
    const fresh = await getDb()
    await migrate(fresh)
    invalidateSettingsCache()
    await revalidateKey()
    log('info', `Database replaced from import (${bytes.byteLength} bytes)`)
  } finally {
    void startSyncEngine()
  }
}
