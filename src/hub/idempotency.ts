/**
 * hub 侧幂等登记：in-flight 合并 + 有界完成缓存。
 *
 * 幂等域由调用方先归一化成 domainKey；这里只关心域键与载荷摘要。
 * `accepted/confirmed/rejected` 进入完成缓存；`pending-confirmation/outcome-unknown`
 * 只进入未决缓存（同键重试返回原状态、绝不再下发），不会被当作成功结果。
 */

export const DEFAULT_COMPLETED_LIMIT = 1_000

export interface InflightEntry<T> {
  readonly digest: string
  readonly promise: Promise<T>
}

export type IdempotencyLookup<T> =
  | { readonly kind: 'inflight'; readonly promise: Promise<T> }
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'unresolved'; readonly value: T }
  | { readonly kind: 'conflict' }

interface Stored<T> {
  readonly digest: string
  value: T
}

export class HubIdempotency<T> {
  private readonly inflight = new Map<string, InflightEntry<T>>()
  private readonly completed = new Map<string, Stored<T>>()
  private readonly unresolved = new Map<string, Stored<T>>()

  constructor(private readonly limit = DEFAULT_COMPLETED_LIMIT) {}

  lookup(key: string, digest: string): IdempotencyLookup<T> | undefined {
    const running = this.inflight.get(key)
    if (running !== undefined) {
      return running.digest === digest
        ? { kind: 'inflight', promise: running.promise }
        : { kind: 'conflict' }
    }
    const settled = this.lookupStored(this.completed, key, digest)
    if (settled !== undefined) return settled
    return this.lookupStored(this.unresolved, key, digest)
  }

  begin(key: string, digest: string, promise: Promise<T>): void {
    this.inflight.set(key, { digest, promise })
  }

  /** 只删除属于这次调用的 in-flight 条目。 */
  end(key: string, promise: Promise<T>): void {
    if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key)
  }

  /**
   * 完成登记。`resolved=false` 表示 pending-confirmation/outcome-unknown：
   * 仍然阻止再次下发，但放在独立表里，语义上不是成功缓存。
   */
  complete(key: string, digest: string, value: T, resolved: boolean): void {
    const table = resolved ? this.completed : this.unresolved
    table.delete(key)
    table.set(key, { digest, value })
    while (table.size > this.limit) {
      const oldest = table.keys().next()
      if (oldest.done === true) break
      table.delete(oldest.value)
    }
  }

  clear(): void {
    this.inflight.clear()
    this.completed.clear()
    this.unresolved.clear()
  }

  /**
   * 就地去掉已缓存的结果正文（断线/授权收紧）。只改完成表；in-flight 的
   * promise 无法收回，调用方仍需按未知处理。digest 保持不变以维持幂等域。
   */
  stripBodies(matches: (key: string) => boolean, transform: (value: T) => T): void {
    for (const table of [this.completed, this.unresolved]) {
      for (const [key, entry] of [...table]) {
        if (!matches(key)) continue
        table.set(key, { digest: entry.digest, value: transform(entry.value) })
      }
    }
  }

  private lookupStored(
    table: Map<string, Stored<T>>,
    key: string,
    digest: string,
  ): IdempotencyLookup<T> | undefined {
    const entry = table.get(key)
    if (entry === undefined) return undefined
    if (entry.digest !== digest) return { kind: 'conflict' }
    // 命中即移到 Map 末尾，淘汰顺序按最近使用。
    table.delete(key)
    table.set(key, entry)
    return { kind: table === this.completed ? 'completed' : 'unresolved', value: entry.value }
  }
}
