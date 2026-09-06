/**
 * Runs in the UI thread. Wraps a Worker so you can call engine methods like
 * normal async functions, and subscribe to engine events.
 *
 *   const engine = createEngineClient(worker)
 *   await engine.api.ping()
 *   engine.on('engine:log', e => console.log(e.msg))
 */
import type { EngineApi, EngineEvents, RpcRequest, WorkerToUi } from '@/shared/rpc'
import { isReactive, isRef, toRaw } from 'vue'

type Listener<K extends keyof EngineEvents> = (data: EngineEvents[K]) => void

/**
 * A Vue reactive Proxy — even one wrapping a plain array/object with nothing
 * exotic inside — fails the structured-clone algorithm postMessage uses
 * ("could not be cloned"), regardless of what it contains. Strip all
 * reactivity recursively before anything crosses into the worker.
 */
function deepUnwrap(v: unknown): unknown {
  if (isRef(v)) return deepUnwrap(v.value)
  if (v === null || typeof v !== 'object') return v
  const raw = isReactive(v) ? toRaw(v) : v
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer || raw instanceof Blob) return raw
  if (raw instanceof Date || raw instanceof RegExp || raw instanceof Map || raw instanceof Set) return raw
  if (Array.isArray(raw)) return raw.map(deepUnwrap)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) out[k] = deepUnwrap((raw as Record<string, unknown>)[k])
  return out
}

export interface EngineClient {
  api: EngineApi
  on<K extends keyof EngineEvents>(event: K, fn: Listener<K>): () => void
  terminate(): void
}

/** Byte arguments are transferred instead of copied. */
function transferables(args: unknown[]): Transferable[] {
  const out: Transferable[] = []
  for (const a of args) {
    if (a instanceof Uint8Array) out.push(a.buffer as ArrayBuffer)
    else if (a instanceof ArrayBuffer) out.push(a)
  }
  return out
}

// Long enough that a real (if slow) reply always beats it, short enough that a dead/stuck
// worker doesn't leave the UI hanging forever with no error. A handful of calls can
// legitimately run long (e.g. a first full sync) — those are exempted below.
const DEFAULT_TIMEOUT_MS = 30_000
const NO_TIMEOUT_METHODS = new Set(['syncNow', 'dbImport', 'backupImport', 'accountsTest', 'testSocket', 'devFetchRecent'])

export function createEngineClient(worker: Worker): EngineClient {
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }>()
  const listeners = new Map<string, Set<(d: unknown) => void>>()

  function rejectAllPending(reason: string) {
    for (const p of pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    pending.clear()
  }

  worker.onmessage = (e: MessageEvent<WorkerToUi>) => {
    const msg = e.data
    if (msg.kind === 'res') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (p.timer) clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else {
        const err = new Error(msg.error?.message ?? 'Engine error')
        if (msg.error?.name) err.name = msg.error.name
        p.reject(err)
      }
    } else if (msg.kind === 'evt') {
      listeners.get(msg.event)?.forEach(fn => fn(msg.data))
    }
  }

  // A worker error doesn't necessarily kill the worker, but it means something inside it
  // threw outside of any RPC handler's own try/catch — anything already waiting on a reply
  // could hang forever otherwise, so treat it as "assume the in-flight calls are dead."
  worker.onerror = (e) => {
    console.error('[engine worker error]', e.message)
    rejectAllPending(`Engine worker error: ${e.message}`)
  }
  worker.onmessageerror = () => {
    console.error('[engine worker message error]')
  }

  const api = new Proxy({} as EngineApi, {
    get(_t, method: string) {
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = nextId++
          const timer = NO_TIMEOUT_METHODS.has(method)
            ? null
            : setTimeout(() => {
                pending.delete(id)
                reject(new Error(`Engine call "${method}" timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`))
              }, DEFAULT_TIMEOUT_MS)
          pending.set(id, { resolve, reject, timer })
          const cleanArgs = args.map(deepUnwrap)
          const req: RpcRequest = { kind: 'req', id, method, args: cleanArgs }
          worker.postMessage(req, transferables(cleanArgs))
        })
    },
  })

  return {
    api,
    on(event, fn) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(fn as (d: unknown) => void)
      return () => set!.delete(fn as (d: unknown) => void)
    },
    terminate() {
      worker.terminate()
      rejectAllPending('Engine terminated')
    },
  }
}
