/**
 * Opens the SQLite database in the best storage the browser offers:
 *
 *   opfs     Chrome 108+, Edge, Firefox 111+, Safari 16.4+. OPFS sync handles.
 *            One file. Fast. Whole-file dump/import works.
 *   opfs-wa  Chrome 121+ only. OPFS + write-ahead. Lets *other connections*
 *            read while one writes. We have a single connection, so it gains
 *            nothing, and its exclusive file lock breaks dump(). Opt-in only.
 *   idb      Very old browsers. IndexedDB-backed. Slow but works.
 *
 * MUST run inside a Web Worker (OPFS sync handles are worker-only).
 */
import { initSQLite, isOpfsReadWriteUnsafeSupported, isOpfsSupported, type SQLiteDB } from '@subframe7536/sqlite-wasm'
import wasmUrl from '@subframe7536/sqlite-wasm/dist/wa-sqlite.wasm?url'
import wasmAsyncUrl from '@subframe7536/sqlite-wasm/dist/wa-sqlite-async.wasm?url'

export const DB_FILE = 'mailclient.db'

/** Flip to true to try the write-ahead driver on Chromium. See note above. */
const PREFER_WRITE_AHEAD = false

export type StorageMode = 'opfs-wa' | 'opfs' | 'idb'

export interface OpenedDb {
  raw: SQLiteDB
  mode: StorageMode
}

export async function openRawDatabase(): Promise<OpenedDb> {
  if (PREFER_WRITE_AHEAD && (await isOpfsReadWriteUnsafeSupported())) {
    const { useOpfsWriteAheadStorage } = await import('@subframe7536/sqlite-wasm/opfs-wa')
    const raw = await initSQLite(useOpfsWriteAheadStorage(DB_FILE, { url: wasmUrl }))
    return { raw, mode: 'opfs-wa' }
  }
  if (await isOpfsSupported()) {
    const { useOpfsStorage } = await import('@subframe7536/sqlite-wasm/opfs')
    const raw = await initSQLite(useOpfsStorage(DB_FILE, { url: wasmUrl }))
    return { raw, mode: 'opfs' }
  }
  const { useIdbStorage } = await import('@subframe7536/sqlite-wasm/idb')
  const raw = await initSQLite(useIdbStorage(DB_FILE, { url: wasmAsyncUrl }))
  return { raw, mode: 'idb' }
}
