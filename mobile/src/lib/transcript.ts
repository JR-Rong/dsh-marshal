export type TranscriptRole = 'user' | 'assistant' | 'reason' | 'tool' | 'system'

export interface TranscriptMessage {
  id: string
  role: TranscriptRole
  text: string
  open: boolean
  at: number
}

export function historyToMessage(item: {
  kind: string
  payload?: Record<string, unknown>
  seq?: number
  ts?: number
}): TranscriptMessage | null {
  const payload = item.payload ?? {}
  const at = typeof item.ts === 'number' ? item.ts : Date.now()
  const id = typeof payload.itemId === 'string' ? payload.itemId : 'seq-' + String(item.seq ?? Math.random())
  const text = typeof payload.text === 'string' ? payload.text : ''
  switch (item.kind) {
    case 'user.message': return { id, role: 'user', text, open: false, at }
    case 'message.delta':
    case 'message.completed': return text ? { id, role: 'assistant', text, open: false, at } : null
    case 'reasoning.delta': return text ? { id, role: 'reason', text, open: false, at } : null
    case 'tool.started': return { id, role: 'tool', text: '▶ ' + String(payload.name ?? payload.tool ?? 'tool'), open: false, at }
    case 'tool.completed': return { id, role: 'tool', text: (payload.isError === true ? '✗ ' : '✓ ') + String(payload.content ?? '').slice(0, 400), open: false, at }
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
