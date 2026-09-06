/**
 * Runs inside the Engine Worker. Turns incoming RpcRequest messages into
 * method calls, and posts RpcResponse back. Also lets engine code emit events.
 */
import type { EngineApi, EngineEvents, RpcEvent, RpcResponse, UiToWorker } from '@/shared/rpc'

type Handlers = {
  [K in keyof EngineApi]: (...args: Parameters<EngineApi[K]>) => ReturnType<EngineApi[K]>
}

// The app tsconfig uses the DOM lib, not WebWorker, so we type only what we use.
const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<UiToWorker>) => void) | null
}

export function emit<K extends keyof EngineEvents>(event: K, data: EngineEvents[K]) {
  const msg: RpcEvent = { kind: 'evt', event, data }
  ctx.postMessage(msg)
}

export function log(level: EngineEvents['engine:log']['level'], msg: string) {
  emit('engine:log', { level, msg })
}

/** Large byte results are transferred instead of copied. */
function transferables(v: unknown): Transferable[] {
  if (v instanceof Uint8Array) return [v.buffer as ArrayBuffer]
  if (v instanceof ArrayBuffer) return [v]
  return []
}

export function serveRpc(handlers: Handlers) {
  ctx.onmessage = async (e: MessageEvent<UiToWorker>) => {
    const req = e.data
    if (!req || req.kind !== 'req') return

    const fn = (handlers as Record<string, unknown>)[req.method]
    let res: RpcResponse
    if (typeof fn !== 'function') {
      res = { kind: 'res', id: req.id, ok: false, error: { message: `Unknown method: ${req.method}` } }
    } else {
      try {
        const result = await (fn as (...a: unknown[]) => unknown)(...req.args)
        res = { kind: 'res', id: req.id, ok: true, result }
      } catch (err) {
        const e = err as Error
        res = { kind: 'res', id: req.id, ok: false, error: { message: e?.message ?? String(err), name: e?.name, stack: e?.stack } }
      }
    }
    ctx.postMessage(res, transferables(res.result))
  }
}
