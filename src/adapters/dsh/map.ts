import type { EventFrame } from '../../wire/frames.ts'

interface Meta { deviceId: string; agent: string; sessionId: string; nodeEpoch: string }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

const INTERACTION_KEYS: ReadonlySet<string> = new Set([
  'questions', 'answers', 'approval', 'decisions', 'selectedOptionIds', 'requestId',
])

function isQuestionLike(value: unknown): boolean {
  const item = asRecord(value)
  return item !== undefined
    && typeof item.id === 'string'
    && (typeof item.question === 'string' || typeof item.prompt === 'string')
}

/**
 * 源端剔除工具参数/结果里承载的交互正文：按 request/call/item 的结构识别，
 * 无法安全分离时就整段丢弃（上层投影随后只发元数据）。
 */
export function stripInteraction(value: unknown, depth = 0): { readonly value?: unknown; readonly removed: boolean } {
  if (depth > 16) return { value: '[truncated]', removed: false }
  if (Array.isArray(value)) {
    let removed = false
    const items: unknown[] = []
    for (const item of value) {
      const stripped = stripInteraction(item, depth + 1)
      if (stripped.removed) { removed = true; continue }
      items.push(stripped.value)
    }
    return removed ? { removed } : { value: items, removed: false }
  }
  const record = asRecord(value)
  if (record === undefined) return { value, removed: false }
  if (Array.isArray(record.questions) && record.questions.some(isQuestionLike)) return { removed: true }
  if (record.kind === 'question' || record.kind === 'approval') return { removed: true }
  if (record.approval !== undefined && typeof record.approval === 'object') return { removed: true }

  let removed = false
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (INTERACTION_KEYS.has(key)) { removed = true; continue }
    const stripped = stripInteraction(item, depth + 1)
    if (stripped.removed) { removed = true; continue }
    out[key] = stripped.value
  }
  return removed ? { removed } : { value: out, removed: false }
}

function turnState(reason: unknown): 'running' | 'completed' | 'failed' | 'interrupted' {
  if (reason === 'failed' || reason === 'interrupted') return reason
  return 'completed'
}

/**
 * 跟随流可能重复交付同一完成态（原生重放/重订阅）。按 `(callId,status)`、
 * `(turnId,state)`、`message.completed(itemId)` 去重，每个会话有界 1000 条。
 * 去重发生在分配公开 seq 之前，被丢弃的重复帧不占序号。
 */
const MAX_DEDUPE_PER_SESSION = 1_000
const MAX_DEDUPE_SESSIONS = 256

function dedupeKey(event: EventFrame): string | undefined {
  const payload = asRecord(event.payload)
  if (payload === undefined) return undefined
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined
  switch (event.kind) {
    case 'tool.started':
    case 'tool.completed': {
      const callId = text(payload.callId)
      return callId === undefined ? undefined : `tool:${callId}:${String(payload.status ?? '')}`
    }
    case 'turn.started':
    case 'turn.completed': {
      const turnId = text(payload.turnId)
      return turnId === undefined ? undefined : `turn:${turnId}:${String(payload.state ?? '')}`
    }
    case 'message.completed': {
      const itemId = text(payload.itemId)
      return itemId === undefined ? undefined : `message:${itemId}`
    }
    default:
      return undefined
  }
}

export interface EventDeduper {
  /** true 表示该事件可以投递；重复的完成态返回 false。 */
  accept(sessionId: string, event: EventFrame): boolean
}

export function createEventDeduper(): EventDeduper {
  const seen = new Map<string, Set<string>>()
  const accept = (sessionId: string, event: EventFrame): boolean => {
    const key = dedupeKey(event)
    if (key === undefined) return true
    let keys = seen.get(sessionId)
    if (keys === undefined) {
      if (seen.size >= MAX_DEDUPE_SESSIONS) {
        const oldest = seen.keys().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
      keys = new Set()
    } else {
      // 刷新 LRU 顺序：活跃会话不会先被淘汰。
      seen.delete(sessionId)
    }
    seen.set(sessionId, keys)
    if (keys.has(key)) return false
    keys.add(key)
    if (keys.size > MAX_DEDUPE_PER_SESSION) {
      const oldest = keys.values().next().value
      if (oldest !== undefined) keys.delete(oldest)
    }
    return true
  }
  return { accept }
}

/**
 * 把 DSH 的 `SessionFollowFrame` 翻成 marshal 事件。
 * 分支以 `tests/fixtures/dsh-follow.jsonl` 为事实来源：
 * `snapshot` 不重放历史，`tool-call-delta` 不产卡片（持久 `tool/call` 才产）。
 */
export function toMarshalEvents(frame: unknown, meta: Meta, nextSeq: () => number): EventFrame[] {
  const record = asRecord(frame)
  if (record === undefined) return []

  const emit = (kind: EventFrame['kind'], payload: unknown): EventFrame[] => [{
    v: 2, type: 'event', deviceId: meta.deviceId, agent: meta.agent, sessionId: meta.sessionId,
    nodeEpoch: meta.nodeEpoch, seq: nextSeq(), ts: Date.now(), kind, payload,
  }]

  if (record.type === 'assistant-stream') {
    const stream = asRecord(record.frame)
    if (stream?.type !== 'chunk') return []
    const chunk = asRecord(stream.chunk)
    const attemptId = typeof stream.attemptId === 'string' ? stream.attemptId : 'attempt'
    const index = typeof chunk?.index === 'number' ? chunk.index : 0
    if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      return emit('reasoning.delta', { itemId: `${attemptId}:reasoning:${index}`, text: chunk.text })
    }
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      return emit('message.delta', { itemId: `${attemptId}:text:${index}`, text: chunk.text })
    }
    return []
  }

  if (record.type !== 'event') return []
  const event = asRecord(record.event)
  const data = asRecord(event?.data)
  if (event === undefined || data === undefined) return []

  switch (event.type) {
    case 'turn/start':
      return emit('turn.started', { turnId: String(data.turn), state: 'running' })
    case 'turn/end':
      return emit('turn.completed', { turnId: String(data.turn), state: turnState(data.reason) })
    case 'assistant/message':
      return emit('message.completed', { itemId: `${String(data.turn)}:${String(data.step)}` })
    case 'tool/call': {
      const args = stripInteraction(data.arguments)
      return emit('tool.started', {
        callId: data.callId,
        tool: data.name,
        status: 'running',
        ...(args.removed || args.value === undefined ? {} : { arguments: args.value }),
      })
    }
    case 'tool/result': {
      const message = asRecord(data.message)
      const content = stripInteraction(message?.content)
      const isError = message?.isError === true || data.error !== undefined
      return emit('tool.completed', {
        callId: message?.toolCallId,
        status: isError ? 'error' : 'ok',
        ...(content.removed || content.value === undefined ? {} : { content: content.value }),
      })
    }
    default:
      return []
  }
}
