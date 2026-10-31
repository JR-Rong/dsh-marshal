import { randomUUID } from 'node:crypto'
import type { SettleResult } from '../adapters/types.ts'
import type { AskUserQuestionAnswerLike, MarshalContext, UserQuestionLike } from '../dsh-types.ts'
import type { EventFrame } from '../wire/frames.ts'
import type { PrivacyProjector } from './privacy.ts'
import {
  InputTable, mapAnswer, readNativeExpiry, resolveDeadline, stillAuthorized,
  type InputAuthorization, type InputOutcome, type PendingInput,
} from './inputs.ts'

/** 兼容旧命名：授权形状已移入 inputs.ts，这里只做类型别名。 */
export type CardAuthorization = InputAuthorization

/** 不可远答的卡：仍记住 requestId，伪造答案要明确拒绝而不是“未知”。 */
interface BlockedCard {
  readonly sessionId: string
  readonly expiresAt: number
  readonly authorization: InputAuthorization | undefined
}

const MAX_BLOCKED_CARDS = 64

/** 这些字段出现即说明不是普通提问（审批/plan-review/执行许可），v0 不认领。 */
const NON_QUESTION_FIELDS = [
  'approval', 'planReview', 'plan', 'permission', 'permissions', 'execute',
] as const

/** 分类字段只接受明确的 question；未知取值按非提问处理，不能猜。 */
const CLASSIFICATION_FIELDS = ['category', 'kind', 'type'] as const
const QUESTION_CLASSIFICATIONS = new Set<unknown>(['question', 'user-question'])

/** 未注入 authorization 的单元测试/独立用法按固定 remote 授权处理。 */
const FIXED_AUTHORIZATION: InputAuthorization = {
  relay: 'remote', operatorId: 'local', policyRevision: 0,
  allowInteractions: true, content: false,
}

export interface QuestionRelay {
  /** 本 relay 配置的代次；快照结果用它标识卡片来源。 */
  readonly runtimeEpoch: string
  settle(sessionId: string, requestId: string, answers: unknown): SettleResult
  /** 放弃待答：结束本进程的等待并交回本地，不触发任何会话级取消。 */
  cancel(sessionId: string, requestId: string): SettleResult
  /** 当前仍有效、仍授权的卡；重新投影且不延长到期。 */
  snapshot(sessionId: string): readonly unknown[]
  /** 每次合法 hello.ack 后调用：授权变化时一次性结算旧卡。 */
  revalidate(): void
  /** 明确收紧/撤权：立即作废所有待答卡。 */
  invalidate(): void
  dispose(): void
}

export interface QuestionRelayOptions {
  readonly ctx: Pick<MarshalContext, 'on'>
  readonly timeoutMs: number
  /** 单一投影端口：卡片策略、字段白名单和 4096 字节上限都由它决定。 */
  readonly projector: PrivacyProjector
  readonly runtimeEpoch: string
  readonly send: (event: EventFrame) => void
  readonly frame: (sessionId: string, kind: EventFrame['kind'], payload: unknown) => EventFrame
  /** 当前协商授权；缺省视为固定授权（仅单元测试使用）。 */
  readonly authorization?: () => InputAuthorization | undefined
  /** 链路是否可认领新问题；断线/syncing 时必须为 false。 */
  readonly available?: () => boolean
  readonly now?: () => number
  readonly monoNow?: () => number
  readonly deviceId?: string
  readonly agent?: string
}

/** 只认领已验证的普通问题；审批/plan-review 等分类一律交回本地。 */
function isPlainQuestion(request: unknown): boolean {
  if (typeof request !== 'object' || request === null) return false
  const record = request as Record<string, unknown>
  for (const field of CLASSIFICATION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue
    if (!QUESTION_CLASSIFICATIONS.has(record[field])) return false
  }
  return NON_QUESTION_FIELDS.every(field => !Object.prototype.hasOwnProperty.call(record, field))
}

/**
 * 认领 `user-questions/request`：发给远端等答案，超时或无人回答就 `next()` 交回本地 UI。
 * 与 `packages/sdk/server/src/user-questions.ts` 同一写法。
 */
export function createQuestionRelay(options: QuestionRelayOptions): QuestionRelay {
  const table = new InputTable()
  const blocked = new Map<string, BlockedCard>()
  const now = options.now ?? Date.now
  const monoNow = options.monoNow ?? (() => globalThis.performance.now())
  const available = options.available ?? (() => true)
  const deviceId = options.deviceId ?? 'local'
  const agent = options.agent ?? 'unknown'
  let disposed = false

  const currentAuthorization = (): InputAuthorization | undefined =>
    options.authorization === undefined ? FIXED_AUTHORIZATION : options.authorization()

  const authorized = (snapshot: InputAuthorization | undefined): boolean =>
    stillAuthorized(snapshot, currentAuthorization())

  const pruneBlocked = (): void => {
    const at = now()
    for (const [requestId, card] of blocked) {
      if (card.expiresAt <= at) blocked.delete(requestId)
    }
    while (blocked.size > MAX_BLOCKED_CARDS) {
      const first = blocked.keys().next().value
      if (first === undefined) break
      blocked.delete(first)
    }
  }

  const rememberBlocked = (
    requestId: string,
    sessionId: string,
    expiresAt: number,
    authorization: InputAuthorization | undefined,
  ): void => {
    pruneBlocked()
    blocked.set(requestId, { sessionId, expiresAt, authorization })
  }

  /**
   * 卡片 payload 已是投影结果，直接交给 link；`input.resolved` 仍走 projector 的
   * 白名单，避免答案或正文从这条出口漏出。交互帧只走 volatile 路径。
   */
  const emitRequested = (sessionId: string, payload: unknown): boolean => {
    try {
      options.send(options.frame(sessionId, 'input.requested', payload))
      return true
    } catch {
      return false
    }
  }

  /** notify 只发 body-less 的 session.updated waitKind，不注册可答卡。 */
  const emitWaiting = (sessionId: string): void => {
    const projected = options.projector.event(
      options.frame(sessionId, 'session.updated', { waitKind: 'input' }),
    )
    for (const event of projected) {
      try { options.send(event) } catch { /* 通知发不出去不影响本地应答 */ }
    }
  }

  const emitResolved = (sessionId: string, requestId: string, outcome: InputOutcome): boolean => {
    const state = outcome === 'remote'
      ? 'answered'
      : outcome === 'timeout' || outcome === 'expired'
        ? 'expired'
        : outcome === 'invalidated' ? 'invalidated' : 'cancelled'
    const projected = options.projector.event(
      options.frame(sessionId, 'input.resolved', { requestId, state }),
    )
    let sent = false
    for (const event of projected) {
      try { options.send(event); sent = true } catch { return false }
    }
    return sent
  }

  const unsubscribe = options.ctx.on('user-questions/request', async (request, next) => {
    // 已卸载的 relay 不能再认领请求，否则会留下永远不会结算的 pending。
    if (disposed) return next()
    const sessionId = request.agent?.session.id
    if (sessionId === undefined) return next()
    if (request.signal?.aborted === true) return next()

    const questions = request.questions
    const questionIds = questions.map(question => question.id)
    // 空请求或重复 id 无法满足“每个 id 恰好一次”，直接交回本地。
    if (questionIds.length === 0 || new Set(questionIds).size !== questionIds.length) return next()
    // 审批/plan-review 不能借普通提问通道获得执行授权。
    if (!isPlainQuestion(request)) return next()
    // 断线/syncing 期间不认领新的远端问题，避免产生无法结算的卡。
    if (!available()) return next()

    const createdAt = now()
    const mono = monoNow()
    const native = readNativeExpiry(request)
    // 无可信时钟域/单位时不认领，立即走本地安全回退。
    const deadline = resolveDeadline({
      createdAt, timeoutMs: options.timeoutMs, now: createdAt, monoNow: mono, native,
    })
    if (deadline === undefined) return next()
    if (deadline.expiresAt <= createdAt || deadline.monoDeadline <= mono) return next()
    const requestId = `q-${randomUUID()}`
    const signal = request.signal

    const card = options.projector.card({
      kind: 'question',
      requestId,
      sessionId,
      runtimeEpoch: options.runtimeEpoch,
      expiresAt: deadline.expiresAt,
      questions,
    })

    // off：不发任何东西，本地 waterfall 原样继续。
    if (card.mode === 'off') return next()
    // notify：只发无正文等待提示，不能远答，立即交回本地。
    if (card.mode === 'notify') {
      emitWaiting(sessionId)
      return next()
    }
    // 不可远答（脱敏歧义、secret、超限）：保留身份/到期/原因，但立即走本地路径。
    if (!card.answerable) {
      rememberBlocked(requestId, sessionId, deadline.expiresAt, currentAuthorization())
      emitRequested(sessionId, card.payload)
      return next()
    }

    const authorization = currentAuthorization()
    // 可答卡必须同时有稳定映射和当前 remote 授权；否则按不可远答处理。
    if (card.mapping === undefined || !authorized(authorization)) {
      rememberBlocked(requestId, sessionId, deadline.expiresAt, authorization)
      emitRequested(sessionId, card.payload)
      return next()
    }
    const mapping = card.mapping

    const answered = await new Promise<AskUserQuestionAnswerLike | undefined>(resolve => {
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined

      const entry: PendingInput = {
        deviceId,
        agent,
        runtimeEpoch: options.runtimeEpoch,
        sessionId,
        requestId,
        questions,
        mapping,
        authorization,
        expiresAt: deadline.expiresAt,
        monoDeadline: deadline.monoDeadline,
        settled: false,
        finish(answer, outcome) {
          if (entry.settled) return
          entry.settled = true
          if (timer !== undefined) clearTimeout(timer)
          if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
          table.remove(entry)
          if (outcome !== undefined) emitResolved(sessionId, requestId, outcome)
          // finish 现在接受 unknown（审批也会用），问题通道的回写形状仍是 DSH 答案。
          resolve(answer as AskUserQuestionAnswerLike | undefined)
        },
      }

      // 单调期限决定 timer；墙钟回拨不影响。延迟必须落在 setTimeout 允许范围内。
      const delay = Math.min(Math.max(0, entry.monoDeadline - monoNow()), 2_147_483_647)
      timer = setTimeout(() => entry.finish(undefined, 'timeout'), delay)
      // 没人回答时这个定时器不该拖住事件循环（同样适用于忘了 settle 的 pending）。
      timer.unref?.()
      table.add(entry)
      if (signal !== undefined) {
        onAbort = () => entry.finish(undefined, 'local')
        signal.addEventListener('abort', onAbort, { once: true })
      }

      // 发不出去就结束等待：清掉 pending 与监听，且不再尝试发 input.resolved。
      if (!emitRequested(sessionId, card.payload)) {
        entry.finish(undefined)
      }
    })

    return answered ?? next()
  })

  return {
    runtimeEpoch: options.runtimeEpoch,
    settle(sessionId, requestId, answers) {
      const denied = blocked.get(requestId)
      if (denied !== undefined) {
        // 卡片不可远答：即使 requestId 正确也不能把决定送进原生请求。
        return denied.sessionId === sessionId ? 'decision-invalid' : 'session-mismatch'
      }
      const entry = table.find(requestId)
      if (entry === undefined) return 'unknown'
      if (entry.sessionId !== sessionId) return 'session-mismatch'
      // 回答入口同步检查墙钟与单调期限；timer 未触发也不能接收过期答案。
      if (now() >= entry.expiresAt || monoNow() >= entry.monoDeadline) {
        entry.finish(undefined, 'expired')
        return 'expired'
      }
      // 回答时必须重新核验当前协商授权；变化或缺失即作废并一次性结算原生等待。
      if (!stillAuthorized(entry.authorization, currentAuthorization())) {
        entry.finish(undefined, 'invalidated')
        return 'decision-invalid'
      }
      // 无法映射/校验的答案不消耗请求，保持等待。
      const native = mapAnswer(answers, entry.mapping)
      if (native === undefined) return 'invalid'
      // 链路正在关闭时 resolved 发不出去也无妨：本地已经拿到答案。
      entry.finish(native, 'remote')
      return 'ok'
    },
    cancel(sessionId, requestId) {
      const denied = blocked.get(requestId)
      if (denied !== undefined) {
        if (denied.sessionId !== sessionId) return 'session-mismatch'
        // 卡片本来就不能远答：取消只是让这个 requestId 不再被提及。
        blocked.delete(requestId)
        return 'ok'
      }
      const entry = table.find(requestId)
      if (entry === undefined) return 'unknown'
      if (entry.sessionId !== sessionId) return 'session-mismatch'
      if (now() >= entry.expiresAt || monoNow() >= entry.monoDeadline) {
        entry.finish(undefined, 'expired')
        return 'expired'
      }
      if (!stillAuthorized(entry.authorization, currentAuthorization())) {
        entry.finish(undefined, 'invalidated')
        return 'decision-invalid'
      }
      // 放弃即交回本地 waterfall；`input.resolved` 记 cancelled。
      entry.finish(undefined, 'local')
      return 'ok'
    },
    snapshot(sessionId) {
      if (disposed) return []
      const at = now()
      const mono = monoNow()
      const current = currentAuthorization()
      const cards: unknown[] = []
      for (const entry of [...table.values()]) {
        // 只返回本会话/当前 runtimeEpoch 的卡；旧代次不能复活。
        if (entry.sessionId !== sessionId || entry.runtimeEpoch !== options.runtimeEpoch) continue
        if (at >= entry.expiresAt || mono >= entry.monoDeadline) {
          entry.finish(undefined, 'expired')
          continue
        }
        if (!stillAuthorized(entry.authorization, current)) {
          entry.finish(undefined, 'invalidated')
          continue
        }
        // 用当前投影器重投影；到期时刻沿用原值，恢复不能延长等待。
        const card = options.projector.card({
          kind: 'question',
          requestId: entry.requestId,
          sessionId: entry.sessionId,
          runtimeEpoch: entry.runtimeEpoch,
          expiresAt: entry.expiresAt,
          questions: entry.questions,
        })
        if (card.mode !== 'remote' || !card.answerable) {
          entry.finish(undefined, 'invalidated')
          continue
        }
        cards.push(card.payload)
      }
      return cards
    },
    revalidate() {
      if (disposed) return
      const current = currentAuthorization()
      for (const entry of [...table.values()]) {
        if (!stillAuthorized(entry.authorization, current)) entry.finish(undefined, 'invalidated')
      }
      for (const [requestId, card] of [...blocked]) {
        if (!stillAuthorized(card.authorization, current)) blocked.delete(requestId)
      }
    },
    invalidate() {
      if (disposed) return
      table.invalidateAll('invalidated')
      blocked.clear()
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      // 卸载时连接即将关闭：只结束等待（交回本地），不再发任何事件。
      table.invalidateAll()
      blocked.clear()
    },
  }
}
