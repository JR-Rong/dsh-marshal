/** 与 sse.ts 里原来的退避一致：500ms 起，封顶 15s。成功连上后从 0 重新计。 */
export function streamBackoffMs(attempt: number): number {
  return Math.min(15_000, 500 * 2 ** Math.min(Math.max(1, attempt), 5))
}

export function noteStreamDrop(attempt: number): { attempt: number; delayMs: number } {
  const next = attempt + 1
  return { attempt: next, delayMs: streamBackoffMs(next) }
}

export function noteStreamOpen(): number {
  return 0
}

export function shouldReconnectStream(input: { event: string; closed: boolean; reconnect: boolean }): boolean {
  if (input.closed || !input.reconnect) return false
  return input.event === 'end' || input.event === 'error'
}

function cursorRank(value: string): [string, number] | null {
  const index = value.lastIndexOf(':')
  if (index <= 0) return null
  const epoch = value.slice(0, index)
  const n = Number(value.slice(index + 1))
  if (!epoch || !Number.isInteger(n) || n < 0) return null
  return [epoch, n]
}

function preferCursor(current: string | null, next: string | null): string | null {
  if (!next) return current
  if (!current) return next
  const left = cursorRank(current)
  const right = cursorRank(next)
  if (!left || !right || left[0] !== right[0]) return next
  return right[1] >= left[1] ? next : current
}

/** Hub 的可回放游标在 SSE id 上；reset 帧则把游标放在 JSON 里。 */
export function nextResumeCursor(
  current: string | null,
  message: { event: string; id?: string; data: unknown },
): string | null {
  if (typeof message.id === 'string' && message.id.length > 0) return message.id
  if (message.event !== 'reset' || typeof message.data !== 'object' || message.data === null) return current
  const data = message.data as Record<string, unknown>
  let cursor = current
  const replay = data.replay
  if (typeof replay === 'object' && replay !== null) {
    const value = (replay as Record<string, unknown>).cursor
    if (typeof value === 'string' && value) cursor = preferCursor(cursor, value)
  }
  if (typeof data.cursor === 'string' && data.cursor) cursor = preferCursor(cursor, data.cursor)
  return cursor
}
