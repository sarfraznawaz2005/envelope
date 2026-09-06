/**
 * Database facade used by the rest of the engine.
 *
 *   const db = await getDb()
 *   await db.all('SELECT * FROM accounts')
 *   await db.tx(async () => { ... })
 */
import type { SQLiteCompatibleType, SQLiteDB } from '@subframe7536/sqlite-wasm'
import { MIGRATIONS } from './schema'
import { openRawDatabase, type StorageMode } from './open'

export type Row = Record<string, SQLiteCompatibleType>
export type Param = SQLiteCompatibleType

export class Database {
  raw: SQLiteDB
  mode: StorageMode
  private txDepth = 0

  constructor(raw: SQLiteDB, mode: StorageMode) {
    this.raw = raw
    this.mode = mode
  }

  all<T = Row>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.raw.run(sql, params) as Promise<T[]>
  }

  async get<T = Row>(sql: string, params: Param[] = []): Promise<T | null> {
    const rows = await this.all<T>(sql, params)
    return rows[0] ?? null
  }

  async scalar<T extends SQLiteCompatibleType = number>(sql: string, params: Param[] = []): Promise<T> {
    const row = await this.get(sql, params)
    if (!row) throw new Error(`No row for: ${sql}`)
    return Object.values(row)[0] as T
  }

  /** Run a write. Returns number of changed rows. */
  async exec(sql: string, params: Param[] = []): Promise<number> {
    await this.raw.run(sql, params)
    return Number(this.raw.changes())
  }

  /** Insert and return the new rowid. */
  async insert(sql: string, params: Param[] = []): Promise<number> {
    await this.raw.run(sql, params)
    return Number(this.raw.lastInsertRowId())
  }

  /** Serializes top-level transactions so unrelated concurrent tx() calls can never be
   * misread as "nested" (see txDepth note below). */
  private txQueue: Promise<unknown> = Promise.resolve()

  /**
   * Run fn inside a transaction. Nested calls (from within an already-running tx()
   * callback on this same instance) join the outer transaction. BEGIN IMMEDIATE is
   * required by the write-ahead driver.
   *
   * txDepth alone cannot tell a genuinely nested call apart from a totally unrelated
   * concurrent caller that merely started while another transaction was still open — with
   * only async interleaving (no real threads) two unrelated db.tx() calls can easily
   * overlap. Misreading the second as "nested" meant it ran outside its own BEGIN/COMMIT
   * and could be silently rolled back by the FIRST call's failure, even though it had
   * already returned successfully to its own caller. Queuing every top-level call ensures
   * only a truly nested call (made synchronously from inside the running callback, before
   * anything else could get a turn) ever observes txDepth > 0.
   */
  tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0) {
      this.txDepth++
      return fn().finally(() => {
        this.txDepth--
      })
    }
    const run = async (): Promise<T> => {
      this.txDepth = 1
      await this.raw.run('BEGIN IMMEDIATE')
      try {
        const out = await fn()
        await this.raw.run('COMMIT')
        return out
      } catch (e) {
        try {
          await this.raw.run('ROLLBACK')
        } catch {
          /* already rolled back */
        }
        throw e
      } finally {
        this.txDepth = 0
      }
    }
    const result = this.txQueue.then(run, run)
    this.txQueue = result.catch(() => {})
    return result
  }

  get sqliteVersion(): string {
    return this.raw.sqlite.libversion()
  }

  dump(): Promise<Uint8Array<ArrayBuffer>> {
    return this.raw.dump()
  }

  close(): Promise<void> {
    return this.raw.close()
  }
}

// ---------- singleton ----------

let dbPromise: Promise<Database> | null = null
let importLock: Promise<void> | null = null

export function getDb(): Promise<Database> {
  if (importLock) return importLock.then(getDb)
  if (!dbPromise) dbPromise = open()
  return dbPromise
}

/**
 * Blocks every other getDb() caller (sync runners, cache-prune, RPC handlers) until the
 * returned function is called. Used around dbImport's raw file replace, which closes and
 * reopens the database outside of any db.tx() — without this, a concurrent getDb() call
 * could race the close/reopen and either fail or briefly open a second connection onto a
 * half-written file.
 */
export function lockDbForImport(): () => void {
  let release!: () => void
  const p = new Promise<void>(r => (release = r))
  importLock = p
  return () => {
    release()
    if (importLock === p) importLock = null
  }
}

/** Close and forget the singleton (used after a full DB import). */
export async function resetDb() {
  const p = dbPromise
  dbPromise = null
  if (p) {
    try {
      const db = await p
      await db.close()
      // the OPFS driver keeps sync handles until the VFS itself is closed
      await db.raw.vfs.close?.()
    } catch {
      /* ignore */
    }
  }
}

async function open(): Promise<Database> {
  const { raw, mode } = await openRawDatabase()
  const db = new Database(raw, mode)
  await db.exec('PRAGMA foreign_keys = ON')
  await migrate(db)
  return db
}

export async function migrate(db: Database) {
  const current = await db.scalar<number>('PRAGMA user_version')
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    await db.tx(async () => {
      for (const stmt of m.up) await db.exec(stmt)
      await db.exec(`PRAGMA user_version = ${m.version}`)
    })
  }
}

// ---------- tiny helpers ----------

export const now = () => Date.now()

export function json<T>(v: SQLiteCompatibleType, fallback: T): T {
  if (typeof v !== 'string') return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}
