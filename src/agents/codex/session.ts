import type { EventFrame } from '../../wire/frames.ts'

/**
 * 每会话观察者登记与受管会话集合。
 *
 * - 通知来自同一条 app-server 连接，本文件不发起原生订阅；
 * - 观察者各自持有有界队列，溢出时终止该观察者（调用方应从历史重新同步），
 *   绝不无界缓存正文；
 * - 受管集合只在 create/fork 成功后登记，进程退出/重启即清空。
 */
export const CODEX_MAX_QUEUED_EVENTS = 2048

export interface CodexSessionRegistry {
  markManaged(sessionId: string): void
  isManaged(sessionId: string): boolean
  managedIds(): readonly string[]
  publish(sessionId: string, event: EventFrame): void
  observe(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame>
  subscriberCount(sessionId: string): number
  clear(): void
}

export interface CodexSessionRegistryOptions {
  readonly maxQueuedEvents?: number
}

interface Listener {
  readonly queue: EventFrame[]
  readonly waiters: Array<() => void>
  closed: boolean
}

function wake(listener: Listener): void {
  const waiters = listener.waiters.splice(0, listener.waiters.length)
  for (const resolve of waiters) resolve()
}

function closeListener(listener: Listener): void {
  if (listener.closed) return
  listener.closed = true
  listener.queue.length = 0
  wake(listener)
}

export function createCodexSessionRegistry(
  options: CodexSessionRegistryOptions = {},
): CodexSessionRegistry {
  const maxQueued = Math.max(1, options.maxQueuedEvents ?? CODEX_MAX_QUEUED_EVENTS)
  const managed = new Set<string>()
  const listeners = new Map<string, Set<Listener>>()

  const publish = (sessionId: string, event: EventFrame): void => {
    const set = listeners.get(sessionId)
    if (set === undefined) return
    for (const listener of [...set]) {
      if (listener.closed) continue
      listener.queue.push(event)
      if (listener.queue.length > maxQueued) {
        // 慢观察者不能拖垮进程内存；结束该观察者，由调用方从历史补齐。
        closeListener(listener)
        continue
      }
      wake(listener)
    }
  }

  const observe = async function* (
    sessionId: string,
    signal: AbortSignal,
  ): AsyncIterable<EventFrame> {
    if (signal.aborted) return
    const listener: Listener = { queue: [], waiters: [], closed: false }
    let set = listeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      listeners.set(sessionId, set)
    }
    set.add(listener)
    const onAbort = (): void => closeListener(listener)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        const next = listener.queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (listener.closed) return
        await new Promise<void>(resolve => listener.waiters.push(resolve))
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      set.delete(listener)
      if (set.size === 0) listeners.delete(sessionId)
      closeListener(listener)
    }
  }

  return {
    markManaged(sessionId: string): void { managed.add(sessionId) },
    isManaged(sessionId: string): boolean { return managed.has(sessionId) },
    managedIds(): readonly string[] { return [...managed] },
    publish,
    observe,
    subscriberCount(sessionId: string): number {
      const set = listeners.get(sessionId)
      if (set === undefined) return 0
      let count = 0
      for (const listener of set) if (!listener.closed) count += 1
      return count
    },
    clear(): void {
      for (const set of listeners.values()) {
        for (const listener of set) closeListener(listener)
      }
      listeners.clear()
      managed.clear()
    },
  }
}
