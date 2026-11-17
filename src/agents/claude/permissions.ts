import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { NativeInputDecision } from '../types.ts'

/**
 * Claude `canUseTool` 的纯分类与回写映射（不依赖适配器/Query 状态）。
 *
 * 安全边界：
 * - 只有 AskUserQuestion 走问题通道；其余工具（含 ExitPlanMode）一律按审批处理，
 *   不能借问题通道授权开始执行。
 * - allow 永不携带 `updatedPermissions`：一次点击不得写入任何 destination。
 * - 输入形状无法完整解释时 fail closed 为 deny，不猜测“默认允许”。
 */

/** 与 sdk-tools 的 AskUserQuestion 对齐：1..4 题，每题可有 2..4 个选项。 */
const MAX_QUESTIONS = 4

const WHITELIST: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'accept', label: '允许一次' },
  { id: 'decline', label: '拒绝' },
  { id: 'cancel', label: '取消' },
]

const DENIED_UNSUPPORTED: PermissionResult = {
  behavior: 'deny', message: '无法在 marshal 中表达此原生请求',
}
const DENIED_DECLINE: PermissionResult = { behavior: 'deny', message: '已在 marshal 拒绝此操作' }
const DENIED_CANCEL: PermissionResult = {
  behavior: 'deny', message: '已在 marshal 取消此操作', interrupt: true,
}

export interface ClaudeApproval {
  action: string
  title?: string
  detail?: string
  decisions: { id: string; label: string }[]
}

export type ClaudeClassification =
  | {
      readonly kind: 'question'
      readonly questions: unknown[]
      readonly answerKeys: ReadonlyMap<string, string>
      /** 原始输入对象：答案必须回填进同一对象，投影会丢掉 preview 等原生字段。 */
      readonly toolInput?: Record<string, unknown>
    }
  | { readonly kind: 'approval'; readonly approval: ClaudeApproval }
  | { readonly kind: 'deny' }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isPlanReview(toolName: string): boolean {
  if (toolName === 'ExitPlanMode') return true
  return toolName !== '' && /plan/i.test(toolName) && /review|exit|approv/i.test(toolName)
}

function decisions(): { id: string; label: string }[] {
  return WHITELIST.map(entry => ({ id: entry.id, label: entry.label }))
}

/**
 * 投影 AskUserQuestion：只保留问答需要的字段（丢 preview），并为每题分配稳定 id。
 * 远端答案按原始问题文本回填，因此重复文本、已带 answers 或任一形状非法都直接拒绝。
 */
function classifyQuestion(input: unknown): ClaudeClassification {
  const record = asRecord(input)
  if (record === undefined) return { kind: 'deny' }
  // 输入已含 answers 说明上游已有人作答：不能再建一张可能覆盖它的卡。
  if (record.answers !== undefined) return { kind: 'deny' }
  const raw = record.questions
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) return { kind: 'deny' }

  const questions: unknown[] = []
  const answerKeys = new Map<string, string>()
  const seenTexts = new Set<string>()
  for (const [index, item] of raw.entries()) {
    const question = asRecord(item)
    if (question === undefined) return { kind: 'deny' }
    const text = question.question
    if (typeof text !== 'string' || text === '') return { kind: 'deny' }
    if (seenTexts.has(text)) return { kind: 'deny' }
    seenTexts.add(text)

    const id = `q${index + 1}`
    const projected: Record<string, unknown> = { id, question: text }
    if (question.multiSelect !== undefined) {
      if (typeof question.multiSelect !== 'boolean') return { kind: 'deny' }
      projected.multiSelect = question.multiSelect
    }
    if (question.options !== undefined) {
      if (!Array.isArray(question.options)) return { kind: 'deny' }
      const options: Record<string, unknown>[] = []
      for (const optionValue of question.options) {
        const option = asRecord(optionValue)
        if (option === undefined || typeof option.label !== 'string' || option.label === '') {
          return { kind: 'deny' }
        }
        const projectedOption: Record<string, unknown> = { label: option.label }
        if (option.description !== undefined) {
          if (typeof option.description !== 'string') return { kind: 'deny' }
          projectedOption.description = option.description
        }
        options.push(projectedOption)
      }
      projected.options = options
    }
    answerKeys.set(id, text)
    questions.push(projected)
  }
  return { kind: 'question', questions, answerKeys, toolInput: record }
}

export function classifyClaudeTool(toolName: string, input: unknown): ClaudeClassification {
  if (toolName === 'AskUserQuestion') return classifyQuestion(input)
  // 所有其它工具（含 ExitPlanMode）都只按“是否允许一次”表达，不提供选项正文。
  const action = isPlanReview(toolName)
    ? '批准计划'
    : toolName === '' ? '工具调用' : toolName
  return { kind: 'approval', approval: { action, decisions: decisions() } }
}

/** 中继答案 -> 原生工具结果；任何无法完整映射的答案都降级为拒绝。 */
function questionResult(
  classification: Extract<ClaudeClassification, { kind: 'question' }>,
  decision: NativeInputDecision,
): PermissionResult {
  const input = classification.toolInput
  if (input === undefined) return DENIED_UNSUPPORTED
  const value = decision.decision === 'answer' ? asRecord(decision.value) : undefined
  const rawAnswers = value?.answers
  if (!Array.isArray(rawAnswers)) return DENIED_DECLINE

  const answers: Record<string, string> = {}
  let answered = 0
  for (const entry of rawAnswers) {
    const item = asRecord(entry)
    if (item === undefined || typeof item.id !== 'string') return DENIED_DECLINE
    const key = classification.answerKeys.get(item.id)
    if (key === undefined) return DENIED_DECLINE
    if (Object.prototype.hasOwnProperty.call(answers, key)) return DENIED_DECLINE
    if (!Array.isArray(item.selected) || !item.selected.every(option => typeof option === 'string')) {
      return DENIED_DECLINE
    }
    if (item.custom !== undefined && typeof item.custom !== 'string') return DENIED_DECLINE
    const selected = item.selected as string[]
    answers[key] = item.custom !== undefined && item.custom !== '' ? item.custom : selected.join(', ')
    answered += 1
  }
  // 漏答会让原生工具拿到不完整输入；宁可拒绝也不能部分回填。
  if (answered !== classification.answerKeys.size) return DENIED_DECLINE
  return { behavior: 'allow', updatedInput: { ...input, answers } }
}

export function claudePermissionResult(
  classification: ClaudeClassification,
  decision: NativeInputDecision,
): PermissionResult {
  if (classification.kind === 'deny') return DENIED_UNSUPPORTED
  if (decision.decision === 'cancel') return DENIED_CANCEL
  if (decision.decision === 'decline') return DENIED_DECLINE
  if (classification.kind === 'approval') return { behavior: 'allow' }
  return questionResult(classification, decision)
}
