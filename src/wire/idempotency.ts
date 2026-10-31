import { createHash } from 'node:crypto'
import type { CommandFrame } from './frames.ts'

/**
 * 契约 §6 的幂等域：`(operatorId, target, idempotencyKey)`。
 * target 含 deviceId/agent/sessionId，因此不同设备、不同 agent、不同会话
 * 使用同名 key 永远不会互相命中。op 与 args 属于载荷，不进入域。
 */
export interface CommandDomain {
  readonly operatorId: string
  readonly target: CommandFrame['target']
  readonly idempotencyKey: string
}

/** 域键用固定顺序的 JSON 数组再哈希；分隔符/转义不会造成跨域碰撞。 */
export function commandDomainKey(domain: CommandDomain): string {
  const canonical = JSON.stringify([
    domain.operatorId,
    domain.target.deviceId,
    domain.target.agent,
    domain.target.sessionId,
    domain.idempotencyKey,
  ])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export type Lookup = { hit: true; result: unknown } | { hit: false }

/** 记住已受理指令的结果，防止重连后重复执行。 */
export class CommandLog {
  private readonly entries = new Map<string, { at: number; result: unknown }>()

  constructor(
    private readonly ttlMs = 30_000,
    private readonly limit = 512,
    private readonly now: () => number = Date.now,
  ) {}

  remember(key: string, result: unknown): void {
    this.prune()
    // 先删除再写入，令重复 key 移到 Map 末尾，使淘汰顺序按最近使用（LRU）而非插入顺序。
    this.entries.delete(key)
    this.entries.set(key, { at: this.now(), result })
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  lookup(key: string): Lookup {
    this.prune()
    const entry = this.entries.get(key)
    return entry === undefined ? { hit: false } : { hit: true, result: entry.result }
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key)
    }
  }
}
