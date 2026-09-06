/**
 * UI-side entry to the engine.
 *
 * - Takes the leader lock (Web Locks).
 * - The leader tab starts the Engine Worker.
 * - Other tabs wait; when the leader closes, the next tab starts its own worker.
 *
 * Use `useEngine()` in components. It returns reactive status plus the client.
 */
import type { EngineStatus } from '@/shared/rpc'
import { readonly, ref, shallowRef } from 'vue'
import { requestLeadership } from './leader'
import { createEngineClient, type EngineClient } from './rpc/client'

const client = shallowRef<EngineClient | null>(null)
const isLeader = ref(false)
const ready = ref(false)
const storage = ref<EngineStatus['storage']>('none')
const logs = ref<Array<{ t: number; level: string; msg: string }>>([])

let started = false

// The engine holds a Web Lock and a worker. Hot-swapping this module would
// leave the old copy holding both, so force a full reload instead.
if (import.meta.hot) import.meta.hot.accept(() => import.meta.hot!.invalidate())

function startWorker() {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'envelope-engine' })
  const c = createEngineClient(worker)
  c.on('engine:ready', e => {
    storage.value = e.storage
    ready.value = true
  })
  c.on('engine:log', e => {
    logs.value.push({ t: Date.now(), level: e.level, msg: e.msg })
    if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500)
    if (e.level === 'error') console.error('[engine]', e.msg)
  })
  client.value = c
}

export function bootEngine() {
  if (started) return
  started = true
  if (import.meta.env.DEV) {
    // dev console helper: __mc.api.ping()
    ;(window as unknown as { __mc: unknown }).__mc = {
      get api() {
        return client.value?.api
      },
      logs,
      terminate: () => client.value?.terminate(),
    }
  }
  const lead = requestLeadership(() => {
    isLeader.value = true
    startWorker()
  })
  isLeader.value = lead.isLeader
}

export function useEngine() {
  bootEngine()
  return {
    client,
    isLeader: readonly(isLeader),
    ready: readonly(ready),
    storage: readonly(storage),
    logs: readonly(logs),
    /** Throws if the engine is not running in this tab yet. */
    get api() {
      const c = client.value
      if (!c) throw new Error('Engine not running in this tab (another tab is leader)')
      return c.api
    },
    /** Subscribe to an engine event. No-op until the worker exists. */
    on: ((event: string, fn: (d: unknown) => void) => {
      const c = client.value
      if (!c) return () => {}
      return c.on(event as never, fn as never)
    }) as EngineClient['on'],
  }
}
