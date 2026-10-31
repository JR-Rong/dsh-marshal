import type { EventFrame } from '../wire/frames.ts'

export interface SeqScope {
  readonly deviceId: string
  readonly agent: string
  readonly sessionId: string
  readonly nodeEpoch: string
}

export interface SeqAllocator {
  /** 为已通过投影/过滤的出站帧分配公开序号。 */
  next(scope: SeqScope): number
}

/**
 * 公开 seq 只在投影与过滤之后分配，键为
 * `(deviceId, agent, sessionId, nodeEpoch)`。
 * 被隐私层丢弃的帧不占号，分片帧按输出顺序取连续号。
 */
export function createSeqAllocator(): SeqAllocator {
  const counters = new Map<string, number>()
  return {
    next(scope: SeqScope): number {
      const key = [scope.deviceId, scope.agent, scope.sessionId, scope.nodeEpoch].join('\u0000')
      const value = (counters.get(key) ?? 0) + 1
      counters.set(key, value)
      return value
    },
  }
}

/** 覆盖适配器预分配的 seq；仅在投影完成之后调用。 */
export function withPublicSeq(
  allocator: SeqAllocator,
  frame: EventFrame,
): EventFrame {
  return { ...frame, seq: allocator.next(frame) }
}
