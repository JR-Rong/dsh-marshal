import { randomUUID } from 'node:crypto'
import type { SettleResult } from '../adapters/types.ts'
import type { AskUserQuestionAnswerLike, MarshalContext, UserQuestionLike } from '../dsh-types.ts'
import type { EventFrame } from '../wire/frames.ts'
import type { PrivacyProjector, RelayPolicy } from './privacy.ts'

/** 创建卡片时的协商授权快照；结算与重连时都必须原样匹配。 */
export interface CardAuthorization {
  readonly relay: RelayPolicy
  readonly operatorId: string
  readonly policyRevision: number
  readonly allowInteractions: boolean
  readonly content: boolean
}

interface Pending {
  readonly sessionId: string
  readonly questionIds: readonly string[]
  /** 原问题带着 options / multiSelect：结算时按它们校验标签与数量。 */
  readonly questions: readonly UserQuestionLike[]
  /** 卡片创建时的 operatorId/policyRevision/隐私与交互授权。 */
  readonly authorization: CardAuthorization | undefined
  /** 每个 pending 只允许结算一次；答案、超时、abort、dispose 共用它。 */
  settled: boolean
  /** outcome 为 undefined 时只结束等待，不再发 `input.resolved`（发送失败或 dispose）。 */
  finish(answer: AskUserQuestionAnswerLike | undefined, outcome?: 'remote' | 'timeout' | 'local' | 'invalidated'): void
}

/** 不可远答的卡：仍记住 requestId，伪造答案要明确拒绝而不是“未知”。 */
interface BlockedCard {
  readonly sessionId: string
  readonly expiresAt: number
  readonly authorization: CardAuthorization | undefined
}

const MAX_BLOCKED_CARDS = 64

export interface QuestionRelay {
  settle(sessionId: string, requestId: string, answers: unknown): SettleResult
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
  readonly authorization?: () => CardAuthorization | undefined
}

/** 校验远端答案：每个问题 id 恰好一次，selected 必须是字符串数组。 */
export function parseAnswers(value: unknown, questionIds: readonly string[]): AskUserQuestionAnswerLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as { answers?: unknown }).answers
  if (!Array.isArray(raw)) return undefined
  const answers: { id: string; selected: string[]; custom?: string }[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return undefined
    const { id, selected, custom } = item as { id?: unknown; selected?: unknown; custom?: unknown }
    if (typeof id !== 'string' || !Array.isArray(selected) || !selected.every(label => typeof label === 'string')) return undefined
    if (custom !== undefined && typeof custom !== 'string') return undefined
    answers.push({ id, selected: selected as string[], ...(custom === undefined ? {} : { custom }) })
  }
  const seen = new Set(answers.map(answer => answer.id))
  if (seen.size !== answers.length || answers.length !== questionIds.length) return undefined
  if (!questionIds.every(id => seen.has(id))) return undefined
  return { answers }
}

/**
 * 在形状正确之后再对齐题目：标签必须来自 options，数量必须符合单选/多选规则。
 * 自定义输入（`custom`）不受数量限制，但已选标签仍要在 options 里。
 */
function validateAnswers(
  answers: AskUserQuestionAnswerLike['answers'],
  questions: readonly UserQuestionLike[],
): boolean {
  for (const answer of answers) {
    const question = questions.find(item => item.id === answer.id)
    if (question === undefined) return false
    if (Array.isArray(question.options) && question.options.length > 0) {
      const labels = new Set(
        question.options
          .map(option => option?.label)
          .filter((label): label is string => typeof label === 'string'),
      )
      if (!answer.selected.every(label => labels.has(label))) return false
    }
    if (answer.custom !== undefined) continue
    if (question.multiSelect === true) {
      if (answer.selected.length < 1) return false
    } else if (answer.selected.length !== 1) {
      return false
    }
  }
  return true
}

/**
 * 认领 `user-questions/request`：发给远端等答案，超时或无人回答就 `next()` 交回本地 UI。
 * 与 `packages/sdk/server/src/user-questions.ts` 同一写法。
 */
export function createQuestionRelay(options: QuestionRelayOptions): QuestionRelay {
  const pending = new Map<string, Pending>()
  const blocked = new Map<string, BlockedCard>()
  let disposed = false

  const currentAuthorization = (): CardAuthorization | undefined => options.authorization?.()

  /** 旧卡只有在当前协商仍为 remote、同一 operatorId/policyRevision 时才可结算。 */
  const stillAuthorized = (snapshot: CardAuthorization | undefined): boolean => {
    if (options.authorization === undefined) return true
    const current = currentAuthorization()
    if (current === undefined) return false
    if (current.relay !== 'remote' || !current.allowInteractions) return false
    return snapshot !== undefined
      && snapshot.relay === 'remote'
      && current.operatorId === snapshot.operatorId
      && current.policyRevision === snapshot.policyRevision
  }

  const pruneBlocked = (): void => {
    const at = Date.now()
    for (const [requestId, card] of blocked) {
      if (card.expiresAt <= at) blocked.delete(requestId)
    }
    while (blocked.size > MAX_BLOCKED_CARDS) {
      const first = blocked.keys().next().value
      if (first === undefined) break
      blocked.delete(first)
    }
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

  const emitResolved = (sessionId: string, requestId: string, outcome: 'remote' | 'timeout' | 'local' | 'invalidated'): boolean => {
    const state = outcome === 'remote'
      ? 'answered'
      : outcome === 'timeout'
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
    const requestId = `q-${randomUUID()}`
    const signal = request.signal

    const card = options.projector.card({
      kind: 'question',
      requestId,
      sessionId,
      runtimeEpoch: options.runtimeEpoch,
      expiresAt: Date.now() + options.timeoutMs,
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
      pruneBlocked()
      blocked.set(requestId, {
        sessionId,
        expiresAt: Date.now() + options.timeoutMs,
        authorization: currentAuthorization(),
      })
      emitRequested(sessionId, card.payload)
      return next()
    }

    const authorization = currentAuthorization()
    // 创建可答卡时也必须持有当前 remote 授权；否则按不可远答处理。
    if (!stillAuthorized(authorization)) {
      pruneBlocked()
      blocked.set(requestId, { sessionId, expiresAt: Date.now() + options.timeoutMs, authorization })
      emitRequested(sessionId, card.payload)
      return next()
    }

    const answered = await new Promise<AskUserQuestionAnswerLike | undefined>(resolve => {
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined

      const entry: Pending = {
        sessionId,
        questionIds,
        questions,
        authorization,
        settled: false,
        finish(answer, outcome) {
          if (entry.settled) return
          entry.settled = true
          if (timer !== undefined) clearTimeout(timer)
          if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
          pending.delete(requestId)
          if (outcome !== undefined) emitResolved(sessionId, requestId, outcome)
          resolve(answer)
        },
      }

      timer = setTimeout(() => entry.finish(undefined, 'timeout'), options.timeoutMs)
      // 没人回答时这个定时器不该拖住事件循环（同样适用于忘了 settle 的 pending）。
      timer.unref?.()
      pending.set(requestId, entry)
      if (signal !== undefined) {
        onAbort = () => entry.finish(undefined, 'local')
        signal.addEventListener('abort', onAbort, { once: true })
      }

      // 发不出去就按超时收拾：清掉 pending 与监听，且不再尝试发 input.resolved。
      if (!emitRequested(sessionId, card.payload)) {
        entry.finish(undefined)
      }
    })

    return answered ?? next()
  })

  return {
    settle(sessionId, requestId, answers) {
      const denied = blocked.get(requestId)
      if (denied !== undefined) {
        // 卡片不可远答：即使 requestId 正确也不能把决定送进原生请求。
        return denied.sessionId === sessionId ? 'decision-invalid' : 'session-mismatch'
      }
      const entry = pending.get(requestId)
      if (entry === undefined) return 'unknown'
      if (entry.sessionId !== sessionId) return 'session-mismatch'
      // 回答时必须重新核验当前协商授权；变化或缺失即作废并一次性结算原生等待。
      if (!stillAuthorized(entry.authorization)) {
        entry.finish(undefined, 'invalidated')
        return 'decision-invalid'
      }
      const parsed = parseAnswers(answers, entry.questionIds)
      if (parsed === undefined) return 'invalid'
      if (!validateAnswers(parsed.answers, entry.questions)) return 'invalid'
      // 链路正在关闭时 resolved 发不出去也无妨：本地已经拿到答案。
      entry.finish(parsed, 'remote')
      return 'ok'
    },
    revalidate() {
      if (disposed || options.authorization === undefined) return
      for (const entry of [...pending.values()]) {
        if (!stillAuthorized(entry.authorization)) entry.finish(undefined, 'invalidated')
      }
      for (const [requestId, card] of [...blocked]) {
        if (!stillAuthorized(card.authorization)) blocked.delete(requestId)
      }
    },
    invalidate() {
      if (disposed) return
      for (const entry of [...pending.values()]) entry.finish(undefined, 'invalidated')
      blocked.clear()
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      // 卸载时连接即将关闭：只结束等待（交回本地），不再发任何事件。
      for (const entry of [...pending.values()]) entry.finish(undefined)
      pending.clear()
      blocked.clear()
    },
  }
}
