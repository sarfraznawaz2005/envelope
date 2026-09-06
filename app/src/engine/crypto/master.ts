/**
 * Master password and encrypted secrets.
 *
 *  password --PBKDF2(600k, SHA-256, salt)--> master key (AES-GCM 256)
 *  master key encrypts each secret (account passwords) with a fresh IV.
 *
 * "Remember on this device": a random non-extractable device key is kept in
 * IndexedDB. The master key, wrapped by the device key, is stored next to it
 * with an expiry. On start we unwrap it and unlock without asking.
 * Clearing site data removes both. Nothing leaves the browser.
 */
import type { SecurityStatus } from '@/shared/rpc'
import { getDb, now } from '../db'
import { getSetting } from '../settings'
import { emit } from '../rpc/server'
import { metaDel, metaGet, metaSet } from '@/shared/idb-meta'

const KDF_ITERATIONS = 600_000
const VERIFIER_TEXT = 'mailclient-master-verifier-v1'
const REMEMBER_KEY = 'security.remembered'

interface KdfParams {
  salt: string // base64
  iterations: number
  verifier: string // base64 ciphertext
  verifierIv: string // base64
}

interface Remembered {
  deviceKey: CryptoKey
  wrapped: ArrayBuffer
  iv: ArrayBuffer
  expiresAt: number | null
}

let masterKey: CryptoKey | null = null
let remembered = false
let rememberExpiresAt: number | null = null

// ---------- helpers ----------

const enc = new TextEncoder()
const dec = new TextDecoder()

export const b64 = {
  encode: (buf: ArrayBuffer | Uint8Array) => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  },
  decode: (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number, extractable: boolean): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  )
}

async function encryptWith(key: CryptoKey, plaintext: Uint8Array): Promise<{ ct: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext as BufferSource))
  return { ct, iv }
}

async function decryptWith(key: CryptoKey, ct: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource))
}

async function loadKdf(): Promise<KdfParams | null> {
  const db = await getDb()
  const row = await db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'security.kdf'`)
  return row ? (JSON.parse(row.value) as KdfParams) : null
}

async function saveKdf(p: KdfParams) {
  const db = await getDb()
  await db.exec(
    `INSERT INTO settings (key, value, updated_at) VALUES ('security.kdf', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [JSON.stringify(p), now()],
  )
}

async function verify(key: CryptoKey, p: KdfParams): Promise<boolean> {
  try {
    const pt = await decryptWith(key, b64.decode(p.verifier), b64.decode(p.verifierIv))
    return dec.decode(pt) === VERIFIER_TEXT
  } catch {
    return false
  }
}

// ---------- status ----------

export async function securityStatus(): Promise<SecurityStatus> {
  const kdf = await loadKdf()
  return { hasPassword: !!kdf, unlocked: !!masterKey, remembered, rememberExpiresAt }
}

async function announce(): Promise<SecurityStatus> {
  const s = await securityStatus()
  emit('security:status', s)
  return s
}

export function isUnlocked() {
  return !!masterKey
}

export function requireKey(): CryptoKey {
  if (!masterKey) throw new Error('Locked. Enter the master password first.')
  return masterKey
}

// ---------- setup / unlock / lock ----------

export async function setupMasterPassword(password: string, remember: boolean): Promise<SecurityStatus> {
  if (await loadKdf()) throw new Error('A master password is already set. Use "change" instead.')
  if (password.length < 8) throw new Error('Master password must be at least 8 characters.')

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(password, salt, KDF_ITERATIONS, true)
  const v = await encryptWith(key, enc.encode(VERIFIER_TEXT))
  await saveKdf({ salt: b64.encode(salt), iterations: KDF_ITERATIONS, verifier: b64.encode(v.ct), verifierIv: b64.encode(v.iv) })

  masterKey = key
  if (remember) await rememberOnDevice()
  return announce()
}

export async function unlock(password: string, remember: boolean): Promise<SecurityStatus> {
  const kdf = await loadKdf()
  if (!kdf) throw new Error('No master password is set.')
  const key = await deriveKey(password, b64.decode(kdf.salt), kdf.iterations, true)
  if (!(await verify(key, kdf))) throw new Error('Wrong master password.')
  masterKey = key
  if (remember) await rememberOnDevice()
  return announce()
}

export async function lock(): Promise<SecurityStatus> {
  masterKey = null
  remembered = false
  rememberExpiresAt = null
  await metaDel(REMEMBER_KEY)
  return announce()
}

export async function changeMasterPassword(oldPassword: string, newPassword: string): Promise<SecurityStatus> {
  const kdf = await loadKdf()
  if (!kdf) throw new Error('No master password is set.')
  if (newPassword.length < 8) throw new Error('New master password must be at least 8 characters.')

  const oldKey = await deriveKey(oldPassword, b64.decode(kdf.salt), kdf.iterations, true)
  if (!(await verify(oldKey, kdf))) throw new Error('Wrong current master password.')

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const newKey = await deriveKey(newPassword, salt, KDF_ITERATIONS, true)

  const db = await getDb()
  await db.tx(async () => {
    // re-encrypt every secret
    const rows = await db.all<{ id: number; ct: Uint8Array; iv: Uint8Array }>('SELECT id, ct, iv FROM secrets')
    for (const r of rows) {
      const pt = await decryptWith(oldKey, r.ct, r.iv)
      const { ct, iv } = await encryptWith(newKey, pt)
      await db.exec('UPDATE secrets SET ct = ?, iv = ? WHERE id = ?', [ct, iv, r.id])
    }
    const v = await encryptWith(newKey, enc.encode(VERIFIER_TEXT))
    await saveKdf({ salt: b64.encode(salt), iterations: KDF_ITERATIONS, verifier: b64.encode(v.ct), verifierIv: b64.encode(v.iv) })
  })

  masterKey = newKey
  const wasRemembered = remembered
  await metaDel(REMEMBER_KEY)
  remembered = false
  rememberExpiresAt = null
  if (wasRemembered) await rememberOnDevice()
  return announce()
}

// ---------- remember on device ----------

async function rememberOnDevice() {
  const key = requireKey()
  const policy = await getSetting('security.remember')
  if (policy === 'never') return

  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  const { ct, iv } = await encryptWith(deviceKey, raw)
  const expiresAt = policy === '7d' ? now() + 7 * 24 * 3600 * 1000 : null
  const rec: Remembered = { deviceKey, wrapped: ct.buffer as ArrayBuffer, iv: iv.buffer as ArrayBuffer, expiresAt }
  await metaSet(REMEMBER_KEY, rec)
  remembered = true
  rememberExpiresAt = expiresAt
}

/** Called once at engine start. Silent on failure. */
export async function tryAutoUnlock(): Promise<SecurityStatus> {
  try {
    const rec = await metaGet<Remembered>(REMEMBER_KEY)
    const kdf = await loadKdf()
    if (!rec || !kdf) return announce()
    if (rec.expiresAt && rec.expiresAt < now()) {
      await metaDel(REMEMBER_KEY)
      return announce()
    }
    const raw = await decryptWith(rec.deviceKey, new Uint8Array(rec.wrapped), new Uint8Array(rec.iv))
    const key = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    if (!(await verify(key, kdf))) {
      await metaDel(REMEMBER_KEY)
      return announce()
    }
    masterKey = key
    remembered = true
    rememberExpiresAt = rec.expiresAt
  } catch {
    /* fall through: stays locked */
  }
  return announce()
}

/**
 * After the database file was replaced: does the key in memory still open
 * the (possibly different) KDF in the new database? If not, lock.
 */
export async function revalidateKey(): Promise<SecurityStatus> {
  const kdf = await loadKdf()
  if (masterKey && kdf && (await verify(masterKey, kdf))) return announce()
  masterKey = null
  remembered = false
  rememberExpiresAt = null
  await metaDel(REMEMBER_KEY)
  return announce()
}

export async function forgetDevice(): Promise<SecurityStatus> {
  await metaDel(REMEMBER_KEY)
  remembered = false
  rememberExpiresAt = null
  return announce()
}

// ---------- secrets ----------

export async function putSecret(plaintext: string, id?: number): Promise<number> {
  const key = requireKey()
  const db = await getDb()
  const { ct, iv } = await encryptWith(key, enc.encode(plaintext))
  if (id) {
    await db.exec('UPDATE secrets SET ct = ?, iv = ? WHERE id = ?', [ct, iv, id])
    return id
  }
  return db.insert('INSERT INTO secrets (ct, iv, created_at) VALUES (?, ?, ?)', [ct, iv, now()])
}

export async function getSecret(id: number): Promise<string> {
  const key = requireKey()
  const db = await getDb()
  const row = await db.get<{ ct: Uint8Array; iv: Uint8Array }>('SELECT ct, iv FROM secrets WHERE id = ?', [id])
  if (!row) throw new Error(`Secret ${id} not found`)
  return dec.decode(await decryptWith(key, row.ct, row.iv))
}

export async function deleteSecret(id: number) {
  const db = await getDb()
  await db.exec('DELETE FROM secrets WHERE id = ?', [id])
}

/** For backup export: raw encrypted blobs plus the KDF params to open them. */
export async function exportSecretsRaw(ids: number[]): Promise<{ kdf: KdfParams | null; secrets: Record<number, { ct: string; iv: string }> }> {
  const db = await getDb()
  const kdf = await loadKdf()
  const out: Record<number, { ct: string; iv: string }> = {}
  for (const id of ids) {
    const row = await db.get<{ ct: Uint8Array; iv: Uint8Array }>('SELECT ct, iv FROM secrets WHERE id = ?', [id])
    if (row) out[id] = { ct: b64.encode(row.ct), iv: b64.encode(row.iv) }
  }
  return { kdf, secrets: out }
}

/**
 * For backup import: decrypt a blob that was encrypted under another KDF.
 * If the backup's KDF equals ours, the current master key opens it.
 * Otherwise the caller must supply the backup's master password.
 */
export async function decryptForeignSecret(
  blob: { ct: string; iv: string },
  backupKdf: KdfParams | undefined,
  backupPassword: string | undefined,
): Promise<string> {
  const ours = await loadKdf()
  let key: CryptoKey
  if (!backupKdf || (ours && backupKdf.salt === ours.salt && backupKdf.verifier === ours.verifier)) {
    key = requireKey()
  } else {
    if (!backupPassword) {
      const err = new Error('Backup was made with a different master password.')
      err.name = 'NeedsBackupPassword'
      throw err
    }
    key = await deriveKey(backupPassword, b64.decode(backupKdf.salt), backupKdf.iterations, false)
    if (!(await verify(key, backupKdf))) throw new Error('Wrong backup master password.')
  }
  return dec.decode(await decryptWith(key, b64.decode(blob.ct), b64.decode(blob.iv)))
}
