import type { EventFrame } from '../wire/frames.ts'

const MAX_DEPTH = 6

/** 在离开源机器前替换敏感片段；超深子树整体替换为 ***，避免泄漏与遍历失控。 */
export function redact(value: unknown, patterns: readonly RegExp[], depth = 0): unknown {
  if (typeof value === 'string') {
    return patterns.reduce((text, pattern) => text.replace(pattern, '***'), value)
  }
  if (depth >= MAX_DEPTH) {
    // 其余原始类型原样返回；对象/数组一律抹成 *** ，不再透传深层内容。
    return value !== null && typeof value === 'object' ? '***' : value
  }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => redact(item, patterns, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    // 键名同样可能夹带密钥，先脱敏再落盘；碰撞时后写覆盖即可。
    const safeKey = patterns.reduce((text, pattern) => text.replace(pattern, '***'), key)
    out[safeKey] = redact(item, patterns, depth + 1)
  }
  return out
}

/** `privacy: metadata` 时把正文换成尺寸信息；默认档就是这一层。 */
export function stripContent(event: EventFrame): EventFrame {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const chars = (value: unknown): number => {
    if (value === undefined || value === null) return 0
    if (typeof value === 'string') return value.length
    return JSON.stringify(value)?.length ?? 0
  }

  switch (event.kind) {
    case 'reasoning.delta':
    case 'message.delta':
      return { ...event, payload: { chars: chars(payload.text), redacted: true } }
    case 'tool.started': {
      const keys = typeof payload.arguments === 'object' && payload.arguments !== null && !Array.isArray(payload.arguments)
        ? Object.keys(payload.arguments as Record<string, unknown>)
        : []
      return { ...event, payload: { callId: payload.callId, name: payload.name, argumentKeys: keys } }
    }
    case 'tool.output':
    case 'tool.completed':
      return { ...event, payload: { callId: payload.callId, chars: chars(payload.content), redacted: true } }
    default:
      return event
  }
}
