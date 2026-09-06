/**
 * Tiny promise wrapper over IndexedDB for a single key/value store.
 * Used to keep non-extractable CryptoKeys and directory handles — things that
 * cannot go into SQLite. Works in the worker and in the UI thread.
 */

const DB_NAME = 'mailclient-meta'
const STORE = 'kv'

function openMeta(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openMeta().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const req = fn(tx.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        tx.oncomplete = () => db.close()
      }),
  )
}

export const metaGet = <T = unknown>(key: string) => withStore<T | undefined>('readonly', s => s.get(key) as IDBRequest<T | undefined>)
export const metaSet = (key: string, value: unknown) => withStore('readwrite', s => s.put(value, key))
export const metaDel = (key: string) => withStore('readwrite', s => s.delete(key))
