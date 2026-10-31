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
