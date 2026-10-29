import { randomUUID } from 'node:crypto'
import type { SettleResult } from '../adapters/types.ts'
import type { AskUserQuestionAnswerLike, MarshalContext } from '../dsh-types.ts'
import type { EventFrame } from '../wire/frames.ts'

interface Pending {
  readonly sessionId: string
  readonly questionIds: readonly string[]
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
 * 认领 `user-questions/request`：发给远端等答案，超时或无人回答就 `next()` 交回本地 UI。
 * 与 `packages/sdk/server/src/user-questions.ts` 同一写法。
 */
export function createQuestionRelay(options: QuestionRelayOptions): QuestionRelay {
  const pending = new Map<string, Pending>()
  let disposed = false

  /** 帧超过 1 MiB 时 send 会抛错；提问链路上的发送绝不能把异常带出 waterfall。 */
  const emit = (event: EventFrame): boolean => {
    try {
      options.send(event)
      return true
    } catch {
      return false
    }
  }

  const unsubscribe = options.ctx.on('user-questions/request', async (request, next) => {
    const sessionId = request.agent?.session.id
    if (sessionId === undefined) return next()
    if (request.signal?.aborted === true) return next()

    const requestId = `q-${randomUUID()}`
    const questionIds = request.questions.map(question => question.id)
    const signal = request.signal

    const answered = await new Promise<AskUserQuestionAnswerLike | undefined>(resolve => {
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined

      const entry: Pending = {
        sessionId,
        questionIds,
        settled: false,
        finish(answer, outcome) {
          if (entry.settled) return
          entry.settled = true
          if (timer !== undefined) clearTimeout(timer)
          if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
          pending.delete(requestId)
          if (outcome !== undefined) emit(options.frame(sessionId, 'input.resolved', { requestId, outcome }))
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
      if (!emit(options.frame(sessionId, 'input.requested', { requestId, questions: request.questions }))) {
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
