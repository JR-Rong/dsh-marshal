import { describe, expect, it } from 'vitest'
import type { ConfirmedSettings, PermissionScope } from '../src/tunables/catalog.ts'
import {
  READBACK_TIMEOUT_MS, SettingsReadback,
  type ReadbackOutcome,
} from '../src/tunables/readback.ts'

/** 注入式假定时器：不依赖 vitest fake timers，也不真实等待 10 秒。 */
class FakeTimers {
  private nextId = 1
  private readonly active = new Map<number, () => void>()
  private readonly delays: number[] = []
  nowMs = 1_000

  readonly now = (): number => this.nowMs

  readonly schedule = (fn: () => void, ms: number): unknown => {
    const id = this.nextId
    this.nextId += 1
    this.active.set(id, fn)
    this.delays.push(ms)
    return id
  }

  readonly cancel = (handle: unknown): void => {
    this.active.delete(handle as number)
  }

  get activeCount(): number {
    return this.active.size
  }

  get lastDelay(): number | undefined {
    return this.delays.at(-1)
  }

  fire(): void {
    const callbacks = [...this.active.values()]
    this.active.clear()
    for (const callback of callbacks) callback()
  }
}

function setup(initial: ConfirmedSettings = { revision: 0 }) {
  const timers = new FakeTimers()
  const readback = new SettingsReadback({
    initial,
    now: timers.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  return { timers, readback }
}

/** 观察 outcome 是否已结算，且吞掉 reject 以免留下未处理拒绝。 */
function watch(outcome: Promise<ReadbackOutcome>): () => ReadbackOutcome | undefined {
  let value: ReadbackOutcome | undefined
  void outcome.then(
    result => { value = result },
    () => { value = undefined },
  )
  return () => value
}

describe('SettingsReadback 关联确认', () => {
  it('确认值相等时更新 current 并只推进一次 revision', async () => {
    const { timers, readback } = setup({ revision: 7, model: 'large' })
    const handle = readback.begin('r1', 'model', 'small')

    expect(timers.activeCount).toBe(1)
    expect(timers.lastDelay).toBe(READBACK_TIMEOUT_MS)

    expect(readback.confirm({ requestId: 'r1', field: 'model', value: 'small' }))
      .toBe('confirmed')
    expect(timers.activeCount).toBe(0)
    expect(readback.snapshot()).toEqual({
      current: { revision: 8, model: 'small' },
      unsafe: false,
    })
    await expect(handle.outcome).resolves
      .toEqual({ status: 'confirmed', revision: 8 })
  })

  it('mismatch 发布实际值、推进 revision 并携带 readback-mismatch', async () => {
    const { readback } = setup({ revision: 2, model: 'large' })
    const handle = readback.begin('r1', 'model', 'small')

    expect(readback.confirm({ requestId: 'r1', field: 'model', value: 'medium' }))
      .toBe('mismatch')

    // 实际值必须发布，不能保留旧值或请求值。
    expect(readback.snapshot().current).toEqual({ revision: 3, model: 'medium' })
    await expect(handle.outcome).resolves
      .toEqual({ status: 'confirmed', revision: 3, code: 'readback-mismatch' })
  })

  it('mismatch 且实际值等于旧 current 时仍返回 mismatch，但 revision 不空转', async () => {
    const { readback } = setup({ revision: 2, model: 'large' })
    const handle = readback.begin('r1', 'model', 'small')

    expect(readback.confirm({ requestId: 'r1', field: 'model', value: 'large' }))
      .toBe('mismatch')
    expect(readback.snapshot().current).toEqual({ revision: 2, model: 'large' })
    await expect(handle.outcome).resolves
      .toEqual({ status: 'confirmed', revision: 2, code: 'readback-mismatch' })
  })

  it('requestId 或 field 不匹配时不结算当前 pending', async () => {
    const { timers, readback } = setup({ revision: 1, model: 'large' })
    const handle = readback.begin('r1', 'model', 'small')

    expect(() => readback.begin('r2', 'plan', 'on')).toThrow('readback: pending exists')
    expect(readback.confirm({ requestId: 'r2', field: 'model', value: 'small' })).toBe('ignored')
    expect(readback.confirm({ requestId: 'r1', field: 'reasoning', value: 'small' })).toBe('ignored')

    expect(timers.activeCount).toBe(1)
    expect(readback.snapshot().pending?.status).toBe('pending')
    expect(readback.snapshot().current).toEqual({ revision: 1, model: 'large' })

    expect(readback.confirm({ requestId: 'r1', field: 'model', value: 'small' }))
      .toBe('confirmed')
    await expect(handle.outcome).resolves.toEqual({ status: 'confirmed', revision: 2 })
  })
})

describe('SettingsReadback 超时与迟到确认', () => {
  it('超时保留旧 current 与 timeout pending，迟到确认在无新 revision 时更新', async () => {
    const { timers, readback } = setup({ revision: 4, model: 'large' })
    const handle = readback.begin('r1', 'model', 'small')

    timers.fire()
    await expect(handle.outcome).resolves
      .toEqual({ status: 'pending-confirmation', code: 'readback-timeout', revision: 4 })

    expect(timers.activeCount).toBe(0)
    const timedOut = readback.snapshot()
    expect(timedOut.current).toEqual({ revision: 4, model: 'large' })
    expect(timedOut.pending).toMatchObject({
      requestId: 'r1',
      field: 'model',
      requested: 'small',
      baseRevision: 4,
      status: 'readback-timeout',
    })

    expect(readback.confirm({ requestId: 'r1', field: 'model', value: 'small' }))
      .toBe('confirmed')
    const late = readback.snapshot()
    expect(late.current).toEqual({ revision: 5, model: 'small' })
    expect(late.pending?.status).toBe('confirmed')
  })

  it('已有更新 revision 时迟到旧值被完全忽略', async () => {
    const { timers, readback } = setup({ revision: 4, model: 'large' })
    const handle = readback.begin('r1', 'model', 'small')
    timers.fire()
    await expect(handle.outcome).resolves
      .toEqual({ status: 'pending-confirmation', code: 'readback-timeout', revision: 4 })

    // 新确认把 revision 推高后，旧请求的迟到值不能覆盖它。
    expect(readback.observe({ field: 'reasoning', value: 'high' })).toBe(true)
    expect(readback.confirm({ requestId: 'r1', field: 'model', value: 'small' }))
      .toBe('ignored')

    const snapshot = readback.snapshot()
    expect(snapshot.current).toEqual({ revision: 5, model: 'large', reasoning: 'high' })
    expect(snapshot.pending?.status).toBe('readback-timeout')
    expect(timers.activeCount).toBe(0)
  })
})

describe('SettingsReadback 长期观察', () => {
  it('observe 更新 current/revision 但绝不结算 pending', async () => {
    const { timers, readback } = setup({ revision: 0 })
    const handle = readback.begin('r1', 'model', 'small')
    const outcome = watch(handle.outcome)

    expect(readback.observe({ field: 'model', value: 'medium' })).toBe(true)
    await Promise.resolve()

    expect(outcome()).toBeUndefined()
    expect(readback.snapshot().current).toEqual({ revision: 1, model: 'medium' })
    expect(readback.snapshot().pending?.status).toBe('pending')
    expect(timers.activeCount).toBe(1)

    // 清理未决 waiter，避免测试结束时留下悬挂 promise。
    handle.abort()
    await expect(handle.outcome).rejects.toThrow('readback: aborted')
  })

  it('observe 相同值不推进 revision', () => {
    const { readback } = setup({ revision: 3, model: 'large' })
    expect(readback.observe({ field: 'model', value: 'large' })).toBe(false)
    expect(readback.snapshot().current).toEqual({ revision: 3, model: 'large' })
  })
})

describe('SettingsReadback unsafe/abort/dispose', () => {
  it('markUnsafe 永久闩锁、阻止 begin 且不改变 current', () => {
    const initial: ConfirmedSettings = { revision: 3, model: 'large', goal: true }
    const { readback } = setup(initial)

    readback.markUnsafe()
    expect(readback.snapshot()).toEqual({ current: initial, unsafe: true })
    expect(() => readback.begin('r1', 'model', 'small')).toThrow('readback: unsafe')

    readback.markUnsafe()
    expect(readback.snapshot().current).toEqual(initial)
    expect(readback.snapshot().unsafe).toBe(true)
  })

  it('abort 拒绝 outcome、清理定时器并移除 pending，重复调用无副作用', async () => {
    const { timers, readback } = setup()
    const handle = readback.begin('r1', 'plan', 'on')
    expect(timers.activeCount).toBe(1)

    handle.abort()
    expect(timers.activeCount).toBe(0)
    expect(readback.snapshot().pending).toBeUndefined()
    await expect(handle.outcome).rejects.toThrow('readback: aborted')

    handle.abort()
    expect(readback.snapshot().pending).toBeUndefined()
  })

  it('dispose 拒绝 pending、幂等，之后的 begin 抛 disposed', async () => {
    const { timers, readback } = setup()
    const handle = readback.begin('r1', 'model', 'small')

    readback.dispose()
    expect(timers.activeCount).toBe(0)
    expect(readback.snapshot().pending).toBeUndefined()
    await expect(handle.outcome).rejects.toThrow('readback: disposed')

    readback.dispose()
    expect(() => readback.begin('r2', 'model', 'small')).toThrow('readback: disposed')
  })
})

describe('SettingsReadback 深比较', () => {
  it('对象键顺序不影响确认结果，数组逐元素比较', async () => {
    const requested: PermissionScope = {
      approvalPolicy: 'on-request',
      sandbox: { fileSystem: 'workspace-write', network: false },
      additionalDirectories: ['src', 'docs'],
      rules: ['no-network'],
    }
    // 同一内容，键与嵌套键顺序全部打乱。
    const actual: PermissionScope = {
      rules: ['no-network'],
      additionalDirectories: ['src', 'docs'],
      sandbox: { network: false, fileSystem: 'workspace-write' },
      approvalPolicy: 'on-request',
    }

    const { readback } = setup({ revision: 10 })
    const handle = readback.begin('r1', 'permission', requested)

    expect(readback.confirm({ requestId: 'r1', field: 'permission', value: actual }))
      .toBe('confirmed')
    expect(readback.snapshot().current.permission).toEqual(actual)
    await expect(handle.outcome).resolves.toEqual({ status: 'confirmed', revision: 11 })
  })

  it('数组元素顺序不同视为不同值', () => {
    const { readback } = setup({ revision: 1 })
    readback.observe({
      field: 'permission',
      value: { additionalDirectories: ['src', 'docs'] },
    })
    expect(readback.observe({
      field: 'permission',
      value: { additionalDirectories: ['docs', 'src'] },
    })).toBe(true)
  })
})
