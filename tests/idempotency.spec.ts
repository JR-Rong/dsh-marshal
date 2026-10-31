import { describe, expect, it } from 'vitest'
import { CommandLog } from '../src/wire/idempotency.ts'

describe('CommandLog', () => {
  it('命中已记录的结果', () => {
    let now = 1000
    const log = new CommandLog(30_000, 2, () => now)
    log.remember('k1', { ok: true })
    expect(log.lookup('k1')).toEqual({ hit: true, result: { ok: true } })
  })

  it('过期后不再命中', () => {
    let now = 1000
    const log = new CommandLog(30_000, 2, () => now)
    log.remember('k1', 1)
    now += 30_001
    expect(log.lookup('k1')).toEqual({ hit: false })
  })

  it('超过容量时淘汰最旧', () => {
    const log = new CommandLog(30_000, 2, () => 1000)
    log.remember('a', 1); log.remember('b', 2); log.remember('c', 3)
    expect(log.lookup('a').hit).toBe(false)
    expect(log.lookup('c')).toEqual({ hit: true, result: 3 })
  })

  it('重复 remember 会刷新顺序，淘汰真正最久未用的 key', () => {
    const log = new CommandLog(30_000, 2, () => 1000)
    log.remember('a', 1)
    log.remember('b', 2)
    log.remember('a', 1) // 刷新 a，此时 b 才是最久未用
    log.remember('c', 3) // 超出容量，应淘汰 b
    expect(log.lookup('b')).toEqual({ hit: false })
    expect(log.lookup('a')).toEqual({ hit: true, result: 1 })
    expect(log.lookup('c')).toEqual({ hit: true, result: 3 })
  })

  it('重写后按新的写入时间计算 TTL', () => {
    let now = 1000
    const log = new CommandLog(30_000, 2, () => now)
    log.remember('a', 1)
    now += 20_000
    log.remember('a', 2) // 重写，at 更新为 21000
    now += 20_000 // 距首次写入已 40000，距重写仅 20000
    expect(log.lookup('a')).toEqual({ hit: true, result: 2 })
  })
})
