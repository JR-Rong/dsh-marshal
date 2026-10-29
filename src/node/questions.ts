import { randomUUID } from 'node:crypto'
import type { SettleResult } from '../adapters/types.ts'
import type { AskUserQuestionAnswerLike, MarshalContext, UserQuestionLike } from '../dsh-types.ts'
import type { EventFrame } from '../wire/frames.ts'

interface Pending {
  readonly sessionId: string
  readonly questionIds: readonly string[]
  /** 原问题带着 options / multiSelect：结算时按它们校验标签与数量。 */
  readonly questions: readonly UserQuestionLike[]
  /** 每个 pending 只允许结算一次；答案、超时、abort、dispose 共用它。 */
  settled: boolean
  /** outcome 为 undefined 时只结束等待，不再发 `input.resolved`（发送失败或 dispose）。 */
  finish(answer: AskUserQuestionAnswerLike | undefined, outcome?: 'remote' | 'timeout' | 'local'): void
}

export interface QuestionRelay {
  settle(sessionId: string, requestId: string, answers: unknown): SettleResult
  dispose(): void
}

export interface QuestionRelayOptions {
  readonly ctx: Pick<MarshalContext, 'on'>
  readonly timeoutMs: number
  readonly send: (event: EventFrame) => void
  readonly frame: (sessionId: string, kind: EventFrame['kind'], payload: unknown) => EventFrame
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
  let disposed = false

  /** 帧超过 1 MiB 时 send 会抛错；提问链路上的发送绝不能把异常带出 waterfall。 */
  const emit = (sessionId: string, kind: EventFrame['kind'], payload: unknown): boolean => {
    try {
      options.send(options.frame(sessionId, kind, payload))
      return true
    } catch {
      return false
    }
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

    const answered = await new Promise<AskUserQuestionAnswerLike | undefined>(resolve => {
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined

      const entry: Pending = {
        sessionId,
        questionIds,
        questions,
        settled: false,
        finish(answer, outcome) {
          if (entry.settled) return
          entry.settled = true
          if (timer !== undefined) clearTimeout(timer)
          if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
          pending.delete(requestId)
          if (outcome !== undefined) emit(sessionId, 'input.resolved', { requestId, outcome })
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
      if (!emit(sessionId, 'input.requested', { requestId, questions })) {
        entry.finish(undefined)
      }
    })

    return answered ?? next()
  })

  return {
    settle(sessionId, requestId, answers) {
      const entry = pending.get(requestId)
      if (entry === undefined) return 'unknown'
      if (entry.sessionId !== sessionId) return 'session-mismatch'
      const parsed = parseAnswers(answers, entry.questionIds)
      if (parsed === undefined) return 'invalid'
      if (!validateAnswers(parsed.answers, entry.questions)) return 'invalid'
      // 链路正在关闭时 resolved 发不出去也无妨：本地已经拿到答案。
      entry.finish(parsed, 'remote')
      return 'ok'
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      // 卸载时连接即将关闭：只结束等待（交回本地），不再发任何事件。
      for (const entry of [...pending.values()]) entry.finish(undefined)
      pending.clear()
    },
  }
}
