import type { ActiveTurnLike, SessionControllerLike, SessionSummaryLike } from '../../dsh-types.ts'
import type { SnapshotCompleteness } from '../types.ts'

/** 硬上限：分页再多也不允许无限跟下去；超限只报告“完整性不可确认”。 */
const MAX_PAGES = 100
const MAX_SESSIONS = 20_000

export interface DshSurfaceListResult {
  readonly items: readonly SessionSummaryLike[]
  readonly completeness: SnapshotCompleteness
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
  cancelTurn?(input: { sessionId: string; turnId: string; runtimeEpoch: string }): Promise<unknown>
}

export interface DshSurfaceOptions {
  readonly maxPages?: number
  readonly maxSessions?: number
}

/** DSH 升级导致签名变化时，只改这一个文件。 */
export function createDshSurface(controller: SessionControllerLike, options: DshSurfaceOptions = {}): DshSurface {
  const maxPages = Math.max(1, options.maxPages ?? MAX_PAGES)
  const maxSessions = Math.max(1, options.maxSessions ?? MAX_SESSIONS)

  /**
   * 完整性只有一个证据：遍历到 `nextCursor` 缺失的终止页。
   * 页大小、页长短、条目数都不是证据；达到上限、cursor 停滞或中途取消
   * 一律返回 `unconfirmed`，绝不把残缺清单当全量。
   */
  const list = async (signal: AbortSignal): Promise<DshSurfaceListResult> => {
    const items: SessionSummaryLike[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    let completeness: SnapshotCompleteness = 'complete'

    signal.throwIfAborted()
    for (;;) {
      let page: { items: readonly SessionSummaryLike[]; nextCursor?: string | undefined }
      try {
        page = await controller.list(cursor === undefined ? {} : { cursor }, signal)
      } catch (error) {
        // 原生调用因取消而失败时没有终止页证据；其它异常仍交给调用方。
        if (signal.aborted) { completeness = 'unconfirmed'; break }
        throw error
      }
      pages += 1
      for (const item of page.items) {
        if (seen.has(item.sessionId)) continue
        seen.add(item.sessionId)
        if (items.length >= maxSessions) { completeness = 'unconfirmed'; break }
        items.push(item)
      }
      if (completeness === 'unconfirmed') break
      if (items.length >= maxSessions) { completeness = 'unconfirmed'; break }

      const next = page.nextCursor
      if (next === undefined) break
      // cursor 不前进会形成死循环；按不可确认处理，绝不重复请求同一页。
      if (next === cursor) { completeness = 'unconfirmed'; break }
      cursor = next
      if (pages >= maxPages) { completeness = 'unconfirmed'; break }
      if (signal.aborted) { completeness = 'unconfirmed'; break }
    }

    return { items, completeness }
  }

  const prompt = async ({ sessionId, text, requestId }: {
    sessionId: string; text: string; requestId: string
  }): Promise<unknown> => {
    const abort = new AbortController()
    // 不传 mode：普通 prompt 的“idle + 受理”必须由原生控制器一步完成。
    // 原生异常原样上抛：没有“受理前”证据，适配器不能自行分类成 rejected。
    return await controller.prompt(
      { requestId, sessionId, content: [{ type: 'text', text }] },
      abort.signal,
    )
  }

  const activeTurn = typeof controller.activeTurn === 'function'
    ? async (sessionId: string): Promise<ActiveTurnLike | undefined> => controller.activeTurn?.(sessionId)
    : undefined
  const cancelTurn = typeof controller.cancelTurn === 'function'
    ? async (input: { sessionId: string; turnId: string; runtimeEpoch: string }): Promise<unknown> =>
        controller.cancelTurn?.(input)
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
