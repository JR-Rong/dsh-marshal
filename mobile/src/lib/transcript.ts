export type TranscriptRole = 'user' | 'assistant' | 'reason' | 'tool' | 'system'

export interface TranscriptMessage {
  id: string
  role: TranscriptRole
  text: string
  open: boolean
  at: number
}

export const TOOL_OUTPUT_PREVIEW_LIMIT = 8000
export const TOOL_ARGS_PREVIEW_LIMIT = 2000

/** DSH 的 limit 表示完整消息数（每条含多次工具调用），初始取 20 避开 1 MiB 帧上限；Codex/Claude 初始取 40。 */
export function initialHistoryLimit(agent: string): number {
  return agent === 'dsh' ? 20 : 40
}

export function nextSmallerHistoryLimit(current: number): number | null {
  if (!Number.isFinite(current) || current <= 1) return null
  return Math.max(1, Math.floor(current / 2))
}

/** Codex 与 Claude 历史分页是正序向后翻页，DSH 是倒序向前翻页。 */
export function historyLoadsForward(agent?: string): boolean {
  return agent === 'codex' || agent === 'claude'
}

export interface AdaptiveHistoryResult<T> {
  result: T
  usedLimit: number
}

/**
 * 遇到 Hub/Node 返回 `result-too-large`（单页超过 1 MiB 协议帧上限）时自动减半重试：
 * 20 → 10 → 5 → 2 → 1（或 40 → 20 → 10 → 5 → 2 → 1），保证大体积会话也能正常读取。
 */
export async function fetchHistoryAdaptive<T extends { ok: boolean; error?: string; code?: string }>(
  fetchPage: (limit: number) => Promise<T>,
  startLimit: number,
  isCurrent: () => boolean = () => true,
): Promise<AdaptiveHistoryResult<T>> {
  let limit = Math.max(1, Math.floor(startLimit))
  for (;;) {
    const result = await fetchPage(limit)
    if (result.ok || !isCurrent()) return { result, usedLimit: limit }
    if (result.code !== 'result-too-large') return { result, usedLimit: limit }
    const smaller = nextSmallerHistoryLimit(limit)
    if (smaller === null) return { result, usedLimit: limit }
    limit = smaller
  }
}

/** 从纯文本、content block 数组或结构化对象里安全提取可读文本，避免出现 [object Object]。 */
export function extractPayloadText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      if (typeof item === 'string') {
        if (item) parts.push(item)
        continue
      }
      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>
        if (typeof record.text === 'string' && record.text) {
          parts.push(record.text)
          continue
        }
      }
      try {
        const serialized = JSON.stringify(item)
        if (serialized) parts.push(serialized)
      } catch { /* ignore unserializable */ }
    }
    return parts.join('\n')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return ''
    }
  }
  return String(value)
}

export function truncateWithNotice(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, limit) + `\n…（已截断，共 ${text.length} 字）`
}

export function historyToMessage(item: {
  kind: string
  payload?: Record<string, unknown>
  seq?: number
  ts?: number
}): TranscriptMessage | null {
  const payload = item.payload ?? {}
  const at = typeof item.ts === 'number' ? item.ts : Date.now()
  const stableId = payload.itemId ?? (item.kind.startsWith('tool.') ? payload.callId : payload.turnId)
  const id = typeof stableId === 'string' ? stableId : 'seq-' + String(item.seq ?? Math.random())
  const text = typeof payload.text === 'string' ? payload.text : ''
  switch (item.kind) {
    case 'user.message': return { id, role: 'user', text, open: false, at }
    case 'message.delta':
    case 'message.completed': return text ? { id, role: 'assistant', text, open: false, at } : null
    case 'reasoning.delta': return text ? { id, role: 'reason', text, open: false, at } : null
    case 'tool.started': {
      const name = String(payload.name ?? payload.tool ?? 'tool')
      const args = payload.arguments !== undefined ? truncateWithNotice(extractPayloadText(payload.arguments), TOOL_ARGS_PREVIEW_LIMIT) : ''
      return { id, role: 'tool', text: args ? `开始：${name}\n参数：\n${args}` : '开始：' + name, open: false, at }
    }
    case 'tool.output': {
      const chunk = extractPayloadText(payload.text ?? payload.output ?? payload.content)
      return chunk ? { id, role: 'tool', text: truncateWithNotice(chunk, TOOL_OUTPUT_PREVIEW_LIMIT), open: false, at } : null
    }
    case 'tool.completed': {
      const prefix = payload.isError === true || payload.status === 'error' ? '失败：' : '完成：'
      const body = truncateWithNotice(extractPayloadText(payload.text ?? payload.output ?? payload.content), TOOL_OUTPUT_PREVIEW_LIMIT)
      return { id, role: 'tool', text: prefix + body, open: false, at }
    }
    case 'turn.completed': return { id, role: 'system', text: '回合完成（' + String(payload.state ?? 'completed') + '）', open: false, at }
    default: return null
  }
}

export type TranscriptDiff =
  | { kind: 'incremental'; updates: Array<{ index: number; text: string; open: boolean }>; appends: TranscriptMessage[] }
  | { kind: 'rebuild' }

/** 只在前缀消息身份不变时增量更新，避免流式片段整页重建。 */
export function diffMessages(before: TranscriptMessage[], after: TranscriptMessage[]): TranscriptDiff {
  if (after.length < before.length) return { kind: 'rebuild' }
  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index]
    const next = after[index]
    if (!previous || !next || previous.id !== next.id || previous.role !== next.role) return { kind: 'rebuild' }
  }
  const updates: Array<{ index: number; text: string; open: boolean }> = []
  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index]!
    const next = after[index]!
    if (previous.text !== next.text || previous.open !== next.open) {
      updates.push({ index, text: next.text, open: next.open })
    }
  }
  return { kind: 'incremental', updates, appends: after.slice(before.length) }
}

/**
 * Hub 派生帧（capability.changed、session.updated）的 seq 是 0，不参与底价去重。
 * 否则中断按钮用的 runtimeEpoch 会停在旧值上。
 */
export function acceptEventSeq(lastSeq: number, seq: unknown): { accept: boolean; lastSeq: number } {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return { accept: true, lastSeq }
  if (seq <= 0) return { accept: true, lastSeq }
  if (seq <= lastSeq) return { accept: false, lastSeq }
  return { accept: true, lastSeq: seq }
}
