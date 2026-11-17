import { readFileSync } from 'node:fs'
import { PreCallRejection } from '../types.ts'
import { attachmentText, validateOptions, type PromptExtras, type SessionControls } from '../../agents/controls.ts'
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
  controls?(sessionId: string, signal: AbortSignal): Promise<SessionControls>
  list(signal: AbortSignal): Promise<DshSurfaceListResult>
  follow(sessionId: string, signal: AbortSignal): AsyncIterable<unknown>
  history?(request: { sessionId: string; cursor?: string; limit?: number }, signal: AbortSignal): Promise<{
    events: unknown[]; hasMore: boolean; nextCursor?: string
  }>
  /** 只发 requestId/sessionId/content；不带 mode，受理语义由原生控制器决定。 */
  prompt(input: { sessionId: string; text: string; requestId: string } & PromptExtras): Promise<unknown>
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

  const controls = async (sessionId: string, signal: AbortSignal): Promise<SessionControls> => {
    if (!controller.modelCatalog || !controller.selectModel) throw new PreCallRejection('unsupported')
    const [catalog, sessions] = await Promise.all([controller.modelCatalog(), list(signal)])
    const selection = sessions.items.find(row => row.sessionId === sessionId)?.projections?.values?.modelSelection?.next
    return {
      models: (catalog.groups ?? []).flatMap((group: any) => (group.models ?? []).map((model: any) => ({
        id: group.id + '/' + model.id, label: group.name + ' · ' + (model.name || model.id),
        efforts: (model.reasoning?.efforts ?? []).map((effort: any) => effort.id),
      }))).slice(0, 100),
      ...(selection ? { current: { model: selection.provider + '/' + selection.model, ...(selection.reasoningEffort ? { reasoning: selection.reasoningEffort } : {}) } } : {}),
    }
  }
  const prompt = async ({ sessionId, text, requestId, ...extras }: {
    sessionId: string; text: string; requestId: string
  } & PromptExtras): Promise<unknown> => {
    const abort = new AbortController()
    if (extras.options && (extras.options.model || extras.options.reasoning)) {
      const catalog = await controls(sessionId, abort.signal)
      validateOptions(catalog, extras.options)
      const id = extras.options.model ?? catalog.current?.model
      if (!id) throw new PreCallRejection('invalid-args')
      const slash = id.indexOf('/')
      await controller.selectModel!({ sessionId, provider: id.slice(0, slash), model: id.slice(slash + 1),
        ...(extras.options.reasoning ? { reasoningEffort: extras.options.reasoning } : {}) })
    }
    // 不传 mode：普通 prompt 的“idle + 受理”必须由原生控制器一步完成。
    // 原生异常原样上抛：没有“受理前”证据，适配器不能自行分类成 rejected。
    return await controller.prompt(
      { requestId, sessionId, content: [{ type: 'text', text: attachmentText(text, extras.files) },
        ...(extras.files ?? []).filter(file => file.mime.startsWith('image/')).map(file => ({ type: 'image', mediaType: file.mime, name: file.name, data: readFileSync(file.path).toString('base64') }))] },
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
    controls,
    list,
    ...(typeof controller.page !== 'function' ? {} : { async history(request: { sessionId: string; cursor?: string; limit?: number }, signal: AbortSignal) {
      const address = { kind: 'session', sessionId: request.sessionId }
      let page: any
      let throughSeq: number
      if (request.cursor === undefined) {
        const iterator = controller.follow({ address, maxMessages: request.limit ?? 20 }, signal)[Symbol.asyncIterator]()
        try {
          const first = await iterator.next()
          page = first.value
          if (page?.type !== 'snapshot' || !Number.isSafeInteger(page.cursor)) throw new Error('history snapshot unavailable')
          throughSeq = page.cursor
        } finally { await iterator.return?.() }
      } else {
        const cursor: unknown = JSON.parse(request.cursor)
        if (!Array.isArray(cursor) || cursor.length !== 2 || !cursor.every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('invalid history cursor')
        throughSeq = cursor[0] as number
        page = await controller.page!({ address, throughSeq, beforeSeq: cursor[1], maxMessages: request.limit ?? 20 }, signal)
      }
      if (!Array.isArray(page?.records)) throw new Error('invalid history page')
      const events = page.records.map((record: any) => record.event)
      const beforeSeq = events[0]?.seq
      return { events, hasMore: page.hasMore === true,
        ...(page.hasMore === true && Number.isSafeInteger(beforeSeq) ? { nextCursor: JSON.stringify([throughSeq, beforeSeq]) } : {}) }
    } }),
    follow(sessionId, signal) {
      return controller.follow({ address: { kind: 'session', sessionId }, assistantStream: true }, signal)
    },
    prompt,
    ...(activeTurn === undefined ? {} : { activeTurn }),
    ...(cancelTurn === undefined ? {} : { cancelTurn }),
  }
}
