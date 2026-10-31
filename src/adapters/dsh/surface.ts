import type { ActiveTurnLike, SessionControllerLike, SessionSummaryLike } from '../../dsh-types.ts'
import type { SnapshotCompleteness } from '../types.ts'

/** 硬上限：分页再多也不允许无限跟下去；超限只报告“完整性不可确认”。 */
const MAX_PAGES = 100
const MAX_SESSIONS = 20_000

/**
 * DSH 的 `list` 没有公开每页大小，只能按“已知的最大页”判断终止页是否是满页。
 * 小于这个下限的终止页不按满页处理，避免小清单被误报为不完整。
 */
const DEFAULT_PAGE_SIZE_FLOOR = 20

export interface DshSurfaceListResult {
  readonly items: readonly SessionSummaryLike[]
  readonly completeness: SnapshotCompleteness
}

/**
 * 原生忙拒绝。只有携带结构化 code/kind/reason 的拒绝才会被认出；
 * 消息文本不参与分类（契约 §12 禁止用字符串推断错误类别），
 * 认不出的异常交给 runner 记 outcome-unknown。
 */
export class NativeWriterBusyError extends Error {
  override readonly name = 'NativeWriterBusyError'
  constructor() { super('marshal: writer-busy: native writer is busy') }
}

const NATIVE_BUSY_CODES: ReadonlySet<string> = new Set([
  'writer-busy', 'session-busy', 'prompt-busy', 'turn-active', 'busy',
])

function isNativeBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  for (const key of ['code', 'kind', 'reason'] as const) {
    const value = record[key]
    if (typeof value === 'string' && NATIVE_BUSY_CODES.has(value)) return true
  }
  return false
}

export interface DshSurface {
  list(signal: AbortSignal): Promise<DshSurfaceListResult>
  follow(sessionId: string, signal: AbortSignal): AsyncIterable<unknown>
  /** 只发 requestId/sessionId/content；不带 mode，受理语义由原生控制器决定。 */
  prompt(input: { sessionId: string; text: string; requestId: string }): Promise<unknown>
  /**
   * 仅当原生控制器提供回合绑定时才存在。sessionId-only cancel 不在此暴露：
   * 先读回合再无条件 cancel 无法排除打断新回合。
   */
  activeTurn?(sessionId: string): Promise<ActiveTurnLike | undefined>
  cancelTurn?(input: { sessionId: string; turnId: string }): Promise<unknown>
}

export interface DshSurfaceOptions {
  /** 终止页达到这个长度且没有 cursor 时按满页处理（默认 20）。 */
  readonly pageSizeFloor?: number
  readonly maxPages?: number
  readonly maxSessions?: number
}

/** DSH 升级导致签名变化时，只改这一个文件。 */
export function createDshSurface(controller: SessionControllerLike, options: DshSurfaceOptions = {}): DshSurface {
  const pageSizeFloor = Math.max(1, options.pageSizeFloor ?? DEFAULT_PAGE_SIZE_FLOOR)
  const maxPages = Math.max(1, options.maxPages ?? MAX_PAGES)
  const maxSessions = Math.max(1, options.maxSessions ?? MAX_SESSIONS)

  const list = async (signal: AbortSignal): Promise<DshSurfaceListResult> => {
    const items: SessionSummaryLike[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    let largestPage = 0
    let completeness: SnapshotCompleteness = 'complete'

    for (;;) {
      signal.throwIfAborted()
      const page = await controller.list(cursor === undefined ? {} : { cursor }, signal)
      signal.throwIfAborted()
      pages += 1
      largestPage = Math.max(largestPage, page.items.length)
      for (const item of page.items) {
        if (seen.has(item.sessionId)) continue
        seen.add(item.sessionId)
        if (items.length >= maxSessions) { completeness = 'unconfirmed'; break }
        items.push(item)
      }
      if (completeness === 'unconfirmed') break
      // 恰好到达上限也同样没有“还有下一页”的证据。
      if (items.length >= maxSessions) { completeness = 'unconfirmed'; break }

      const next = page.nextCursor
      if (next === undefined) {
        // 终止页没有 cursor。若它与已知最大页同宽（且不是小清单），
        // 很可能是被截断的默认页：不能沉默地当全量。
        if (page.items.length >= pageSizeFloor && page.items.length === largestPage) {
          completeness = 'unconfirmed'
        }
        break
      }
      // cursor 不前进会形成死循环；按不可确认处理，绝不重复请求同一页。
      if (next === cursor) { completeness = 'unconfirmed'; break }
      cursor = next
      if (pages >= maxPages) { completeness = 'unconfirmed'; break }
    }

    return { items, completeness }
  }

  const prompt = async ({ sessionId, text, requestId }: {
    sessionId: string; text: string; requestId: string
  }): Promise<unknown> => {
    const abort = new AbortController()
    try {
      // 不传 mode：普通 prompt 的“idle + 受理”必须由原生控制器一步完成。
      return await controller.prompt(
        { requestId, sessionId, content: [{ type: 'text', text }] },
        abort.signal,
      )
    } catch (error) {
      if (isNativeBusy(error)) throw new NativeWriterBusyError()
      throw error
    }
  }

  const activeTurn = typeof controller.activeTurn === 'function'
    ? async (sessionId: string): Promise<ActiveTurnLike | undefined> => controller.activeTurn?.(sessionId)
    : undefined
  const cancelTurn = typeof controller.cancelTurn === 'function'
    ? async (input: { sessionId: string; turnId: string }): Promise<unknown> => controller.cancelTurn?.(input)
    : undefined

  return {
    list,
    follow(sessionId, signal) {
      return controller.follow({ address: { kind: 'session', sessionId } }, signal)
    },
    prompt,
    ...(activeTurn === undefined ? {} : { activeTurn }),
    ...(cancelTurn === undefined ? {} : { cancelTurn }),
  }
}
