import type { EventFrame } from '../../wire/frames.ts'

/**
 * Claude 受管会话集合 + 每会话观察者登记。
 *
 * - 只有本适配器 `createSession`/`forkSession` 成功建立的会话才进入 managed；
 *   外部会话永远不在集合里，`acquire` 因此只能拿 ownership-unverified。
 * - 观察者各自持有有界队列，溢出即结束该观察者（调用方应从历史补齐），
 *   绝不无界缓存正文；正常关闭、异常退出、输入取消都走 `clear`/`closeSession`。
 * - 本文件不发起任何原生订阅：Claude 侧没有可比的多会话通知面，
 *   事件只来自我们自己的 Query 消息泵。
 */
export const CLAUDE_MAX_QUEUED_EVENTS = 2048

export interface ClaudeSessionRegistry {
  markManaged(sessionId: string): void
  isManaged(sessionId: string): boolean
  managedIds(): readonly string[]
  publish(sessionId: string, event: EventFrame): void
  observe(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame>
  subscriberCount(sessionId: string): number
  /** 结束某会话的所有观察者（Query 关闭/失败时），但保留 managed 身份。 */
  closeSession(sessionId: string): void
  clear(): void
}

export interface ClaudeSessionRegistryOptions {
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
  // 保留已入队的终止帧：调用方需要看到 agent-crashed/session.updated 才能
  // 知道该会话已结束；队列由 maxQueued 截断，不会无限增长。
  listener.closed = true
  wake(listener)
}

export function createClaudeSessionRegistry(
  options: ClaudeSessionRegistryOptions = {},
): ClaudeSessionRegistry {
  const maxQueued = Math.max(1, options.maxQueuedEvents ?? CLAUDE_MAX_QUEUED_EVENTS)
  const managed = new Set<string>()
  const listeners = new Map<string, Set<Listener>>()

  const closeSet = (set: Set<Listener> | undefined, dropQueued = false): void => {
    if (set === undefined) return
    for (const listener of set) {
      if (dropQueued) listener.queue.length = 0
      closeListener(listener)
    }
  }

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
      // closeSession 之后可能已有新观察者注册到新的 set；只清理自己那一份。
      if (set.size === 0 && listeners.get(sessionId) === set) listeners.delete(sessionId)
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
    closeSession(sessionId: string): void {
      const set = listeners.get(sessionId)
      if (set === undefined) return
      closeSet(set)
      listeners.delete(sessionId)
    },
    clear(): void {
      // stop 是显式销毁：未消费的帧不再有意义，直接丢弃。
      for (const set of listeners.values()) closeSet(set, true)
      listeners.clear()
      managed.clear()
    },
  }
}
