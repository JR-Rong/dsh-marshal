import { describe, expect, it } from 'vitest'
import {
  SUPERVISOR_RETRY_AFTER_MS, SUPERVISOR_STDERR_LIMIT_BYTES,
  createSupervisor, createWindowsTerminator,
  type SpawnFn, type SupervisorChild, type SupervisorClock,
  type SupervisorExitReason, type SupervisorOptions, type Terminator, type TimerHandle,
} from '../src/agents/supervisor.ts'

class FakeClock implements SupervisorClock {
  private time = 0
  private readonly timers = new Map<number, { readonly at: number; readonly callback: () => void }>()
  private nextId = 1

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback })
    return { id }
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle.id as number)
  }

  advance(ms: number): void {
    const target = this.time + ms
    for (;;) {
      let dueId: number | undefined
      let dueAt = Number.POSITIVE_INFINITY
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at
          dueId = id
        }
      }
      if (dueId === undefined) break
      const timer = this.timers.get(dueId)
      this.timers.delete(dueId)
      this.time = dueAt
      timer?.callback()
    }
    this.time = target
  }
}

class FakeStream {
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>()

  on(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event)
    if (list === undefined) return this
    this.listeners.set(event, list.filter(item => item !== listener))
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

let nextPid = 1000

class FakeChild implements SupervisorChild {
  readonly pid = nextPid++
  readonly stdin: NodeJS.WritableStream | null = null
  readonly stdout: NodeJS.ReadableStream | null = null
  readonly stderr = new FakeStream()
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>()
  readonly killed: Array<string | number | undefined> = []

  on(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event)
    if (list === undefined) return this
    this.listeners.set(event, list.filter(item => item !== listener))
    return this
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal)
    return true
  }

  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
  }

  emitError(error: Error): void {
    this.emit('error', error)
  }

  emitStderr(chunk: Buffer | string): void {
    this.stderr.emit('data', typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

class FakeTerminator implements Terminator {
  readonly calls: string[] = []

  terminate(child: SupervisorChild): void {
    this.calls.push(`term:${child.pid}`)
  }

  kill(child: SupervisorChild): void {
    this.calls.push(`kill:${child.pid}`)
  }
}

interface Harness {
  readonly clock: FakeClock
  readonly children: FakeChild[]
  readonly terminator: FakeTerminator
  readonly exits: Array<[number, SupervisorExitReason]>
  readonly supervisor: ReturnType<typeof createSupervisor>
}

function harness(overrides: Partial<SupervisorOptions> = {}): Harness {
  const clock = new FakeClock()
  const children: FakeChild[] = []
  const spawn: SpawnFn = () => {
    const child = new FakeChild()
    children.push(child)
    return child
  }
  const terminator = new FakeTerminator()
  const exits: Array<[number, SupervisorExitReason]> = []
  const supervisor = createSupervisor({
    command: 'fake-agent',
    spawn,
    clock,
    terminator,
    killGraceMs: 1_000,
    onExit: (generation, reason) => exits.push([generation, reason]),
    ...overrides,
  })
  return { clock, children, terminator, exits, supervisor }
}

function lastChild(h: Harness): FakeChild {
  const child = h.children[h.children.length - 1]
  if (child === undefined) throw new Error('no child spawned')
  return child
}

describe('supervisor restart policy', () => {
  it('restarts on the 1/2/4/8/16/30 second backoff table and caps at 30s', () => {
    const h = harness({ maxStartsPerWindow: 100, restartWindowMs: 10_000_000 })
    expect(h.supervisor.start()).toBe(true)
    expect(h.children).toHaveLength(1)

    const schedule = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    for (const delay of schedule) {
      const count = h.children.length
      lastChild(h).emitExit(1)
      h.clock.advance(delay - 1)
      expect(h.children).toHaveLength(count)
      h.clock.advance(1)
      expect(h.children).toHaveLength(count + 1)
    }
  })

  it('allows at most 5 starts in a 60s window, then waits for recover/retryAt', () => {
    const h = harness()
    expect(h.supervisor.start()).toBe(true)

    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      lastChild(h).emitExit(1)
      h.clock.advance(delay)
    }
    expect(h.children).toHaveLength(5)

    // 第 6 次启动落在 31s，仍在首个 60s 窗口内：拒绝并进入 failed。
    lastChild(h).emitExit(1)
    h.clock.advance(16_000)
    expect(h.children).toHaveLength(5)

    const health = h.supervisor.health()
    expect(health.state).toBe('failed')
    expect(health.reason?.reason).toBe('restart-exhausted')
    expect(health.retryAt).toBe(31_000 + SUPERVISOR_RETRY_AFTER_MS)
    expect(h.supervisor.start()).toBe(false)

    // 显式 recover 允许立即重试，但仍是新的监督窗口。
    expect(h.supervisor.recover()).toBe(true)
    expect(h.children).toHaveLength(6)
    expect(h.supervisor.state).toBe('starting')
  })

  it('does not restart after terminal or config classification', () => {
    for (const kind of ['terminal', 'config'] as const) {
      const h = harness({ classify: () => kind })
      h.supervisor.start()
      lastChild(h).emitError(new Error('classified failure'))

      expect(h.supervisor.state).toBe('failed')
      h.clock.advance(10 * 60_000)
      expect(h.children).toHaveLength(1)
      expect(h.supervisor.health().reason?.reason)
        .toBe(kind === 'config' ? 'config-invalid' : 'terminal-failure')
    }
  })

  it('classifies synchronous spawn failures and stops retrying on terminal errors', () => {
    const h = harness({
      spawn: () => { throw new Error('binary missing') },
      classify: () => 'terminal',
    })
    expect(h.supervisor.start()).toBe(false)
    expect(h.children).toHaveLength(0)
    expect(h.supervisor.state).toBe('failed')
    expect(h.exits).toEqual([[1, 'spawn-failed']])
    h.clock.advance(10 * 60_000)
    expect(h.supervisor.state).toBe('failed')
  })

  it('fail() with a config error terminates the generation without restarting', () => {
    const h = harness({ classify: () => 'config' })
    h.supervisor.start()
    const pid = lastChild(h).pid
    h.supervisor.fail(new Error('authentication failed'))

    expect(h.supervisor.state).toBe('failed')
    expect(h.terminator.calls).toEqual([`term:${pid}`])
    h.clock.advance(10 * 60_000)
    expect(h.children).toHaveLength(1)
    expect(h.supervisor.health().reason?.reason).toBe('config-invalid')
  })
})

describe('supervisor stop and generations', () => {
  it('stop disables restart, rejects pending, and is idempotent', async () => {
    const h = harness()
    h.supervisor.start()
    const pid = lastChild(h).pid

    const pending = h.supervisor.request(() => new Promise<number>(() => {})).catch(error => error)
    const first = h.supervisor.stop()
    const second = h.supervisor.stop()
    expect(first).toBe(second)
    await first

    expect(await pending).toMatchObject({ code: 'stopped' })
    expect(h.terminator.calls).toEqual([`term:${pid}`])
    h.clock.advance(1_000)
    expect(h.terminator.calls).toEqual([`term:${pid}`, `kill:${pid}`])

    h.clock.advance(10 * 60_000)
    expect(h.children).toHaveLength(1)
    expect(h.supervisor.start()).toBe(false)
    expect(h.supervisor.state).toBe('stopped')
  })

  it('rejects pending RPCs on exit and ignores late responses from the old generation', async () => {
    const h = harness()
    h.supervisor.start()
    const generation = h.supervisor.generation
    let resolveLate: ((value: string) => void) | undefined
    const late = h.supervisor.request(() => new Promise<string>(resolve => { resolveLate = resolve }))
    const settled = late.then(() => 'resolved', error => error)

    lastChild(h).emitExit(1)
    const error = await settled
    expect(error).toMatchObject({ code: 'exited', generation })
    expect(h.supervisor.isCurrent(generation)).toBe(false)

    resolveLate?.('late-response')
    await Promise.resolve()
    expect(await settled).toBe(error)

    h.clock.advance(1_000)
    expect(h.children).toHaveLength(2)
    expect(h.supervisor.generation).toBe(generation + 1)

    // 旧代次的迟到退出/错误回调不能再影响新实例。
    h.children[0]?.emitExit(2)
    h.children[0]?.emitError(new Error('late error'))
    expect(h.supervisor.generation).toBe(generation + 1)
    expect(h.supervisor.state).toBe('starting')
  })

  it('rejects an aborted request with aborted', async () => {
    const h = harness()
    h.supervisor.start()
    const controller = new AbortController()
    const pending = h.supervisor.request(
      () => new Promise<number>(() => {}),
      { signal: controller.signal },
    ).catch(error => error)
    controller.abort()
    expect(await pending).toMatchObject({ code: 'aborted' })
  })

  it('rejects requests when no generation is running', async () => {
    const h = harness()
    await expect(h.supervisor.request(() => Promise.resolve(1)))
      .rejects.toMatchObject({ code: 'not-running' })
  })
})

describe('supervisor stderr and idle guard', () => {
  it('keeps stderr bounded and reports truncation', () => {
    const h = harness()
    h.supervisor.start()
    lastChild(h).emitStderr(Buffer.alloc(20 * 1024, 0x61))

    const snapshot = h.supervisor.stderr()
    expect(snapshot.bytes).toBe(SUPERVISOR_STDERR_LIMIT_BYTES)
    expect(snapshot.truncated).toBe(true)
    expect(Buffer.byteLength(snapshot.text, 'utf8')).toBeLessThanOrEqual(SUPERVISOR_STDERR_LIMIT_BYTES)
    expect(snapshot.text.endsWith('a'.repeat(64))).toBe(true)
  })

  it('never reclaims while busy() is true, and never guesses without a predicate', async () => {
    let busy = true
    const h = harness({ busy: () => busy })
    h.supervisor.start()

    expect(h.supervisor.canReclaim()).toBe(false)
    expect(await h.supervisor.reclaim()).toBe(false)
    expect(h.terminator.calls).toHaveLength(0)

    busy = false
    expect(h.supervisor.canReclaim()).toBe(true)
    expect(await h.supervisor.reclaim()).toBe(true)
    expect(h.terminator.calls).toEqual([`term:${lastChild(h).pid}`])
    h.clock.advance(1_000)
    expect(h.terminator.calls[1]).toBe(`kill:${h.children[0]?.pid}`)

    // reclaim 不是 stop：之后仍允许按需启动新代次。
    expect(h.supervisor.start()).toBe(true)
    expect(h.children).toHaveLength(2)

    const guarded = harness()
    guarded.supervisor.start()
    expect(guarded.supervisor.canReclaim()).toBe(false)
  })

  it('treats pending RPCs as busy even when the caller predicate says idle', async () => {
    const h = harness({ busy: () => false })
    h.supervisor.start()
    const pending = h.supervisor.request(() => new Promise<number>(() => {})).catch(error => error)

    expect(h.supervisor.canReclaim()).toBe(false)
    expect(await h.supervisor.reclaim()).toBe(false)
    await h.supervisor.stop()
    expect(await pending).toMatchObject({ code: 'stopped' })
  })

  it('routes both terminate phases through injected taskkill on Windows', () => {
    const calls: number[] = []
    const terminator = createWindowsTerminator(pid => calls.push(pid))
    const child = new FakeChild()

    terminator.terminate(child)
    terminator.kill(child)

    // taskkill /T /F 没有温和阶段：两个动作都必须按 pid 走注入实现。
    expect(calls).toEqual([child.pid, child.pid])
  })
})
