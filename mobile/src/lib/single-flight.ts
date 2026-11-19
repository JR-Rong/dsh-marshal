/** 同一 key 的并发调用只执行第一次。 */
export function createSingleFlight(): {
  run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined>
} {
  const pending = new Set<string>()
  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
      if (pending.has(key)) return undefined
      pending.add(key)
      try {
        return await fn()
      } finally {
        pending.delete(key)
      }
    },
  }
}
