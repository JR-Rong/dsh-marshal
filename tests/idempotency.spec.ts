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
})
