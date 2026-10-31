import { MAX_INTERACTION_INPUT_BYTES } from '../wire/limits.ts'
import type { AskUserQuestionAnswerLike, UserQuestionLike } from '../dsh-types.ts'
import type { CardMapping } from './privacy.ts'

/** 创建卡片时的协商授权快照；结算、快照恢复都必须与当前值原样匹配。 */
export interface InputAuthorization {
  readonly relay: 'off' | 'notify' | 'remote'
  readonly operatorId: string
  readonly policyRevision: number
  readonly allowInteractions: boolean
  readonly content: boolean
}

/** 结算/失效的终态；`timeout`/`expired` 对外都映射为 `expired`，`aborted` 映射为 `cancelled`。 */
export type InputOutcome =
  | 'remote' | 'timeout' | 'expired' | 'local' | 'invalidated' | 'declined' | 'cancelled' | 'aborted'

export interface PendingInput {
  readonly deviceId: string
  readonly agent: string
  readonly runtimeEpoch: string
  readonly sessionId: string
  readonly requestId: string
  /** 缺省为普通问题（v0 兼容）；审批卡记为 approval。 */
  readonly kind?: 'question' | 'approval'
  /** 原生问题（含原始 label），回写只用它，不用投影文本；审批卡为空数组。 */
  readonly questions: readonly UserQuestionLike[]
  readonly mapping: CardMapping
  /** 审批卡投影决策 id -> 原生写回值（一次只接受其中之一）；问题卡不设置。 */
  readonly decisions?: ReadonlyMap<string, string>
  readonly authorization: InputAuthorization | undefined
  readonly expiresAt: number
  /** 认领时固定的单调截止时刻；墙钟回拨/重连都不能延长。 */
  readonly monoDeadline: number
  settled: boolean
  /** outcome 为 undefined 时只结束等待，不发 `input.resolved`（发送失败或 dispose）。 */
  finish(value?: unknown, outcome?: InputOutcome): void
}

/**
 * 复合键 `(deviceId, agent, sessionId, runtimeEpoch, requestId)`。
 * requestId 随机且表很小，get 用四元匹配即可，无需再拆 epoch 参数。
 */
export class InputTable {
  private readonly entries = new Map<string, PendingInput>()

  private static key(entry: PendingInput): string {
    return [
      entry.deviceId, entry.agent, entry.sessionId, entry.runtimeEpoch, entry.requestId,
    ].join('\u0000')
  }

  /** 同一 requestId 只能有一份待答；重复认领直接拒绝。 */
  add(entry: PendingInput): boolean {
    const key = InputTable.key(entry)
    if (this.entries.has(key)) return false
    for (const existing of this.entries.values()) {
      if (existing.requestId === entry.requestId) return false
    }
    this.entries.set(key, entry)
    return true
  }

  get(deviceId: string, agent: string, sessionId: string, requestId: string): PendingInput | undefined {
    for (const entry of this.entries.values()) {
      if (entry.deviceId === deviceId && entry.agent === agent
        && entry.sessionId === sessionId && entry.requestId === requestId) return entry
    }
    return undefined
  }

  /** 按 requestId 反查：用于区分 session-mismatch 与 unknown。 */
  find(requestId: string): PendingInput | undefined {
    for (const entry of this.entries.values()) {
      if (entry.requestId === requestId) return entry
    }
    return undefined
  }

  values(): readonly PendingInput[] {
    return [...this.entries.values()]
  }

  remove(entry: PendingInput): void {
    this.entries.delete(InputTable.key(entry))
  }

  /** 一次性结束全部等待；outcome 为空时只交回本地，不发终态事件。 */
  invalidateAll(outcome?: InputOutcome): void {
    for (const entry of this.values()) entry.finish(undefined, outcome)
    this.entries.clear()
  }

  get size(): number { return this.entries.size }
}

/** 当前协商授权是否仍允许结算旧快照；任一前提不成立都按撤权处理。 */
export function stillAuthorized(
  snapshot: InputAuthorization | undefined,
  current: InputAuthorization | undefined,
): boolean {
  if (current === undefined) return false
  if (current.relay !== 'remote' || !current.allowInteractions) return false
  return snapshot !== undefined
    && snapshot.relay === 'remote'
    && current.operatorId === snapshot.operatorId
    && current.policyRevision === snapshot.policyRevision
}

export type NativeExpiry =
  | { readonly kind: 'node-clock'; readonly atMs: number }
  | {
      readonly kind: 'foreign-clock'
      readonly atMs: number
      readonly foreignNowMs: number
      readonly uncertaintyMs: number
    }

const NATIVE_EXPIRY_FIELDS = ['nativeExpiry', 'expiresAt', 'expires_at', 'deadline'] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record)
  return own.length === keys.length && own.every(key => keys.includes(key))
}

/**
 * 读取原生期限。只有已声明的时钟域形状才算“可验证”；
 * 数值、相对时长或未知 `kind` 一律 unverifiable，调用方必须本地回退而不认领。
 */
export function readNativeExpiry(request: unknown): NativeExpiry | 'none' | 'unverifiable' {
  const record = asRecord(request)
  if (record === undefined) return 'none'
  let present = false
  let value: unknown
  for (const field of NATIVE_EXPIRY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue
    present = true
    value = record[field]
    break
  }
  if (!present) return 'none'
  const expiry = asRecord(value)
  if (expiry === undefined) return 'unverifiable'
  if (expiry.kind === 'node-clock') {
    if (!hasOnlyKeys(expiry, ['kind', 'atMs']) || !isFiniteNumber(expiry.atMs)) return 'unverifiable'
    return { kind: 'node-clock', atMs: expiry.atMs }
  }
  if (expiry.kind === 'foreign-clock') {
    if (!hasOnlyKeys(expiry, ['kind', 'atMs', 'foreignNowMs', 'uncertaintyMs'])) return 'unverifiable'
    if (!isFiniteNumber(expiry.atMs) || !isFiniteNumber(expiry.foreignNowMs)) return 'unverifiable'
    if (!isFiniteNumber(expiry.uncertaintyMs) || expiry.uncertaintyMs < 0) return 'unverifiable'
    return {
      kind: 'foreign-clock',
      atMs: expiry.atMs,
      foreignNowMs: expiry.foreignNowMs,
      uncertaintyMs: expiry.uncertaintyMs,
    }
  }
  return 'unverifiable'
}

export interface DeadlineInput {
  readonly createdAt: number
  readonly timeoutMs: number
  readonly now: number
  readonly monoNow: number
  readonly native: NativeExpiry | 'none' | 'unverifiable'
}

export interface Deadline {
  readonly expiresAt: number
  readonly monoDeadline: number
}

/**
 * 归一化到 node 时钟域：`expiresAt = min(createdAt + timeoutMs, 原生最早可能截止)`。
 * 不套用 hub↔node 偏差；异域期限必须带有限不确定度，取最早可能值。
 */
export function resolveDeadline(input: DeadlineInput): Deadline | undefined {
  const { createdAt, timeoutMs, now, monoNow, native } = input
  if (!Number.isInteger(createdAt) || timeoutMs < 0 || !Number.isInteger(timeoutMs)) return undefined
  if (!isFiniteNumber(now) || !isFiniteNumber(monoNow)) return undefined
  if (native === 'unverifiable') return undefined

  let expiresAt: number
  if (native === 'none') {
    expiresAt = createdAt + timeoutMs
  } else if (native.kind === 'node-clock') {
    if (!Number.isInteger(native.atMs)) return undefined
    expiresAt = Math.min(createdAt + timeoutMs, native.atMs)
  } else {
    if (!Number.isInteger(native.atMs)
      || !Number.isInteger(native.foreignNowMs)
      || !Number.isInteger(native.uncertaintyMs)
      || native.uncertaintyMs < 0) return undefined
    // 取最早可能截止：异域“现在”的不确定度必须扣掉，不能乐观延长。
    const remaining = native.atMs - native.foreignNowMs - native.uncertaintyMs
    expiresAt = Math.min(createdAt + timeoutMs, createdAt + remaining)
  }
  if (!Number.isFinite(expiresAt)) return undefined
  return { expiresAt, monoDeadline: monoNow + Math.max(0, expiresAt - now) }
}

export interface WireAnswerItem {
  readonly id: string
  readonly selectedOptionIds: readonly string[]
  readonly text?: string
}

interface ParsedWireAnswers {
  readonly items: readonly WireAnswerItem[]
}

function parseWireAnswers(value: unknown): ParsedWireAnswers | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const raw = record.answers
  if (!Array.isArray(raw) || raw.length > 64) return undefined
  const items: WireAnswerItem[] = []
  for (const entry of raw) {
    const item = asRecord(entry)
    if (item === undefined) return undefined
    if (typeof item.id !== 'string' || item.id === '') return undefined
    const selected = item.selectedOptionIds
    if (!Array.isArray(selected) || selected.length > 64) return undefined
    if (!selected.every(optionId => typeof optionId === 'string' && optionId !== '')) return undefined
    if (item.text !== undefined && typeof item.text !== 'string') return undefined
    items.push({
      id: item.id,
      selectedOptionIds: selected as string[],
      ...(item.text === undefined ? {} : { text: item.text }),
    })
  }
  return { items }
}

/**
 * 把 wire 答案映射回原生答案：ID 必须来自本卡映射，label 只用原始值。
 * 任一不合法返回 undefined，调用方保持等待（无效答案不消耗请求）。
 */
export function mapAnswer(value: unknown, mapping: CardMapping): AskUserQuestionAnswerLike | undefined {
  const parsed = parseWireAnswers(value)
  if (parsed === undefined) return undefined
  const items = parsed.items
  if (items.length !== mapping.questions.size) return undefined
  const seen = new Set<string>()
  const answers: { id: string; selected: string[]; custom?: string }[] = []
  for (const item of items) {
    if (seen.has(item.id)) return undefined
    seen.add(item.id)
    const question = mapping.questions.get(item.id)
    // 多出的问题 id 或未映射的 id 都不能进入原生写回。
    if (question === undefined) return undefined

    const selectedLabels: string[] = []
    const selectedSeen = new Set<string>()
    for (const optionId of item.selectedOptionIds) {
      if (selectedSeen.has(optionId)) return undefined
      selectedSeen.add(optionId)
      const label = question.options.get(optionId)
      if (label === undefined) return undefined
      selectedLabels.push(label)
    }

    if (!question.multi && selectedLabels.length > 1) return undefined
    // 只要带了 text 字段就必须允许自由文本；空串按“未填”处理但不能绕过 custom=false。
    if (item.text !== undefined) {
      if (!question.custom) return undefined
      if (item.text !== '' && Buffer.byteLength(item.text, 'utf8') > MAX_INTERACTION_INPUT_BYTES) {
        return undefined
      }
    }
    const text = item.text === '' ? undefined : item.text
    // 必答题必须有选项或自由文本；单选/多选的最低数量都由这一条覆盖。
    if (question.required && selectedLabels.length === 0 && text === undefined) return undefined
    answers.push({
      id: question.nativeId,
      selected: selectedLabels,
      ...(text === undefined ? {} : { custom: text }),
    })
  }
  return { answers }
}
