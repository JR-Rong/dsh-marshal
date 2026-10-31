import type { EventFrame } from '../../wire/frames.ts'

interface Meta { deviceId: string; agent: string; sessionId: string; nodeEpoch: string }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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
    if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') return emit('reasoning.delta', { text: chunk.text })
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') return emit('message.delta', { text: chunk.text })
    return []
  }

  if (record.type !== 'event') return []
  const event = asRecord(record.event)
  const data = asRecord(event?.data)
  if (event === undefined || data === undefined) return []

  switch (event.type) {
    case 'turn/start':
      return emit('turn.started', { turn: data.turn })
    case 'turn/end':
      return emit('turn.completed', { turn: data.turn, reason: data.reason })
    case 'assistant/message':
      return emit('message.completed', { turn: data.turn, step: data.step })
    case 'tool/call':
      return emit('tool.started', { callId: data.callId, name: data.name, arguments: data.arguments })
    case 'tool/result': {
      const message = asRecord(data.message)
      return emit('tool.completed', {
        callId: message?.toolCallId,
        content: message?.content,
        isError: message?.isError === true || data.error !== undefined,
      })
    }
    default:
      return []
  }
}
