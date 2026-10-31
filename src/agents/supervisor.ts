import { spawn } from 'node:child_process'
import type { UnavailableCause } from './types.ts'

/**
 * 通用子进程监督器：不包含 Codex/Claude 协议，只负责代次、stdio 生命周期、
 * 重启退避、停止清理与 stderr 有界诊断。
 *
 * 关键不变量：
 * - generation 单调递增；旧代次的响应、退出回调一律忽略。
 * - 退出/停止/取消分别以 `exited` / `stopped` / `aborted` 拒绝该代次的 pending RPC。
 * - 退避 1/2/4/8/16/30 秒封顶；默认 60 秒窗口最多 5 次启动，超出进入 failed，
 *   由显式 recover() 或调用方在 retryAt 之后重试。
 * - 认证/配置错误由注入的 classify(error) 判定，不循环重启。
 * - stop() 先禁用重启再清理；幂等，停止后零重启。
 * - stderr 只保留有界本机内存；`stderr()` 快照仅供本机诊断，绝不能发往 hub 或写日志。
 * - POSIX 用 detached 进程组 + kill(-pid, SIGTERM)，超时 SIGKILL；Windows 走注入的
 *   taskkill /T /F 式终止。平台分支通过注入实现，不做未经验证的假设。
 */

export const SUPERVISOR_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const
export const SUPERVISOR_RESTART_WINDOW_MS = 60_000
export const SUPERVISOR_MAX_STARTS = 5
export const SUPERVISOR_RETRY_AFTER_MS = 300_000
export const SUPERVISOR_STDERR_LIMIT_BYTES = 16 * 1024
export const SUPERVISOR_KILL_GRACE_MS = 5_000

export type SupervisorState = 'idle' | 'starting' | 'running' | 'backoff' | 'failed' | 'stopped'
export type FailureClass = 'retryable' | 'terminal' | 'config'
export type SupervisorExitReason = 'exited' | 'spawn-failed' | 'stopped'

export type SupervisorErrorCode =
  | 'exited'
  | 'stopped'
  | 'aborted'
  | 'stale-generation'
  | 'not-running'

export class SupervisorError extends Error {
  override readonly name = 'SupervisorError'
  readonly code: SupervisorErrorCode
  readonly generation: number | undefined

  constructor(code: SupervisorErrorCode, generation?: number) {
    super(`marshal: supervisor ${code}`)
    this.code = code
    this.generation = generation
  }
}

/** stderr 只需要事件接口；保留 Node Readable 结构兼容以便注入真实子进程。 */
export interface SupervisorStderr {
  on(event: string, listener: (...args: any[]) => void): this
  removeListener(event: string, listener: (...args: any[]) => void): this
}

/** 与 node:child_process.ChildProcess 结构兼容；测试可注入轻量 fake。 */
export interface SupervisorChild {
  readonly pid?: number | undefined
  readonly stdin: NodeJS.WritableStream | null
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: SupervisorStderr | null
  on(event: string, listener: (...args: any[]) => void): this
  removeListener(event: string, listener: (...args: any[]) => void): this
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface TimerHandle {
  readonly id: unknown
}

export interface SupervisorClock {
  now(): number
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export interface SupervisorSpawnOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** POSIX 默认 true：让子进程成为进程组 leader，便于整组终止。 */
  readonly detached: boolean
  readonly windowsHide: boolean
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SupervisorSpawnOptions,
) => SupervisorChild

/** `terminate` 发温和信号，`kill` 在宽限期后强杀；Windows 两者都是 taskkill /T /F。 */
export interface Terminator {
  terminate(child: SupervisorChild): void
  kill(child: SupervisorChild): void
}

export interface SupervisorTransport {
  readonly generation: number
  readonly stdin: NodeJS.WritableStream | null
  readonly stdout: NodeJS.ReadableStream | null
}

/** 本机诊断快照。`text` 只允许留在本进程/本机诊断，不得进入 wire、审计或日志。 */
export interface StderrSnapshot {
  readonly generation: number
  readonly bytes: number
  readonly truncated: boolean
  readonly text: string
}

export interface SupervisorExitInfo {
  readonly generation: number
  readonly reason: SupervisorExitReason
  readonly at: number
  readonly code?: number | null
  readonly signal?: string | null
}

export interface SupervisorHealth {
  readonly state: SupervisorState
  readonly generation: number
  readonly pending: number
  readonly restarts: number
  readonly reason?: UnavailableCause
  readonly retryAt?: number
  readonly nextRestartAt?: number
  readonly lastExit?: SupervisorExitInfo
}

export interface RequestContext {
  readonly generation: number
  readonly signal: AbortSignal
}

export interface SupervisorOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly spawn?: SpawnFn
  readonly clock?: SupervisorClock
  readonly classify?: (error: unknown) => FailureClass
  readonly onExit?: (generation: number, reason: SupervisorExitReason) => void
  readonly terminator?: Terminator
  readonly platform?: NodeJS.Platform
  /** Windows 默认终止实现；注入后不再调用真实 taskkill。 */
  readonly taskkill?: (pid: number) => void
  readonly stderrLimitBytes?: number
  readonly killGraceMs?: number
  readonly restartWindowMs?: number
  readonly maxStartsPerWindow?: number
  readonly retryAfterMs?: number
  /**
   * 通用 idle 守卫：仅当返回 false 时才允许回收。未提供时保守地不允许回收。
   * 不能按“最后输入时间”判断，活跃回合/待答/待处理命令必须由调用方计入 busy。
   */
  readonly busy?: () => boolean
}

export interface Supervisor {
  readonly generation: number
  readonly state: SupervisorState
  readonly pending: number
  start(): boolean
  recover(): boolean
  markReady(): void
  /** 适配器在握手/探测失败时上报；由 classify 决定是否重启。 */
  fail(error: unknown): void
  request<T>(
    operation: (context: RequestContext) => Promise<T>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T>
  isCurrent(generation: number): boolean
  canReclaim(): boolean
  reclaim(): Promise<boolean>
  transport(): SupervisorTransport | undefined
  health(): SupervisorHealth
  stderr(): StderrSnapshot
  /** 幂等；先禁用重启，再清理 timer/listener/队列/pending 并终止进程组。 */
  stop(): Promise<void>
}

function createDefaultClock(): SupervisorClock {
  return {
    now: () => Date.now(),
    setTimeout(callback, ms) {
      const timer = setTimeout(callback, ms)
      timer.unref()
      return { id: timer }
    },
    clearTimeout(handle) {
      clearTimeout(handle.id as ReturnType<typeof setTimeout>)
    },
  }
}

const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, [...args], {
  ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  ...(options.env === undefined ? {} : { env: options.env }),
  detached: options.detached,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: options.windowsHide,
})

function groupSignal(child: SupervisorChild, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // 进程组已不存在或不是 leader：退回直接 kill，仍以子进程为准。
    }
  }
  try { child.kill(signal) } catch { /* 已退出 */ }
}

export function createPosixTerminator(): Terminator {
  return {
    terminate: child => groupSignal(child, 'SIGTERM'),
    kill: child => groupSignal(child, 'SIGKILL'),
  }
}

export function createWindowsTerminator(taskkill: (pid: number) => void): Terminator {
  const run = (child: SupervisorChild): void => {
    const pid = child.pid
    if (pid === undefined) return
    try { taskkill(pid) } catch { /* best effort */ }
  }
  // taskkill /T /F 没有温和阶段；两次调用幂等，只是保证 stop/reclaim 路径一致。
  return { terminate: run, kill: run }
}

function defaultTaskkill(pid: number): void {
  try {
    const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => { /* taskkill 缺失时保持 best effort */ })
    child.unref()
  } catch {
    // 没有 taskkill 时不阻塞宿主；调用方仍可依赖子进程自身退出。
  }
}

function createDefaultTerminator(platform: NodeJS.Platform, taskkill: (pid: number) => void): Terminator {
  return platform === 'win32' ? createWindowsTerminator(taskkill) : createPosixTerminator()
}

/** 只保留末尾 limit 字节；`dropped` 记录被截掉的字节数。 */
class BoundedBuffer {
  private readonly chunks: Buffer[] = []
  private total = 0
  private dropped = 0

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) return
    if (chunk.length >= this.limit) {
      this.dropped += this.total + chunk.length - this.limit
      this.chunks.length = 0
      this.chunks.push(chunk.subarray(chunk.length - this.limit))
      this.total = this.limit
      return
    }
    this.chunks.push(chunk)
    this.total += chunk.length
    while (this.total > this.limit) {
      const first = this.chunks[0]
      if (first === undefined) break
      const over = this.total - this.limit
      if (first.length <= over) {
        this.chunks.shift()
        this.total -= first.length
        this.dropped += first.length
      } else {
        this.chunks[0] = first.subarray(over)
        this.total -= over
        this.dropped += over
      }
    }
  }

  snapshot(): { bytes: number; truncated: boolean; text: string } {
    return {
      bytes: this.total,
      truncated: this.dropped > 0,
      text: Buffer.concat(this.chunks).toString('utf8'),
    }
  }
}

interface PendingEntry {
  readonly generation: number
  readonly controller: AbortController
  readonly detach: () => void
  readonly reject: (error: unknown) => void
}

interface AttachedListeners {
  readonly proc: SupervisorChild
  readonly exit: (code: number | null, signal: NodeJS.Signals | null) => void
  readonly error: (error: Error) => void
  readonly data: (chunk: unknown) => void
}

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const clock = options.clock ?? createDefaultClock()
  const spawnFn = options.spawn ?? defaultSpawn
  const platform = options.platform ?? process.platform
  const terminator = options.terminator
    ?? createDefaultTerminator(platform, options.taskkill ?? defaultTaskkill)
  const classify = options.classify ?? (() => 'retryable')
  const stderrLimit = Math.max(1, options.stderrLimitBytes ?? SUPERVISOR_STDERR_LIMIT_BYTES)
  const killGraceMs = Math.max(0, options.killGraceMs ?? SUPERVISOR_KILL_GRACE_MS)
  const windowMs = Math.max(1, options.restartWindowMs ?? SUPERVISOR_RESTART_WINDOW_MS)
  const maxStarts = Math.max(1, options.maxStartsPerWindow ?? SUPERVISOR_MAX_STARTS)
  const retryAfterMs = Math.max(0, options.retryAfterMs ?? SUPERVISOR_RETRY_AFTER_MS)
  const launchArgs = options.args ?? []

  let state: SupervisorState = 'idle'
  let generation = 0
  let child: SupervisorChild | undefined
  let listeners: AttachedListeners | undefined
  let stopped = false
  let stopPromise: Promise<void> | undefined
  let restartTimer: TimerHandle | undefined
  let graceTimer: TimerHandle | undefined
  let nextRestartAt: number | undefined
  let restartIndex = 0
  let restartCount = 0
  let failureReason: UnavailableCause | undefined
  let retryAt: number | undefined
  let lastExit: SupervisorExitInfo | undefined
  let starts: number[] = []
  let stderrBuffer = new BoundedBuffer(stderrLimit)

  const pending = new Map<number, PendingEntry>()
  let nextPendingId = 1

  function clearRestartTimer(): void {
    if (restartTimer === undefined) return
    clock.clearTimeout(restartTimer)
    restartTimer = undefined
    nextRestartAt = undefined
  }

  function clearGraceTimer(): void {
    if (graceTimer === undefined) return
    clock.clearTimeout(graceTimer)
    graceTimer = undefined
  }

  function scheduleGraceKill(proc: SupervisorChild): void {
    clearGraceTimer()
    graceTimer = clock.setTimeout(() => {
      graceTimer = undefined
      try { terminator.kill(proc) } catch { /* best effort */ }
    }, killGraceMs)
  }

  function rejectPending(reason: SupervisorErrorCode): void {
    const entries = [...pending.values()]
    pending.clear()
    for (const entry of entries) {
      entry.detach()
      entry.controller.abort()
      entry.reject(new SupervisorError(reason, entry.generation))
    }
  }

  function detach(proc: SupervisorChild): void {
    const attached = listeners
    if (attached === undefined || attached.proc !== proc) return
    listeners = undefined
    try { proc.removeListener('exit', attached.exit) } catch { /* 已移除 */ }
    try { proc.removeListener('error', attached.error) } catch { /* 已移除 */ }
    try { proc.stderr?.removeListener('data', attached.data) } catch { /* 已移除 */ }
  }

  function teardown(gen: number, reason: SupervisorExitReason, rejectAs: SupervisorErrorCode): void {
    if (gen !== generation) return
    const proc = child
    child = undefined
    if (proc !== undefined) detach(proc)
    clearGraceTimer()
    rejectPending(rejectAs)
    options.onExit?.(gen, reason)
  }

  function enterFailed(reason: 'restart-exhausted' | 'terminal-failure' | 'config-invalid'): void {
    clearRestartTimer()
    state = 'failed'
    failureReason = { reason }
    // 只有重启风暴需要 5 分钟冷却；认证/配置错误要求显式恢复。
    retryAt = reason === 'restart-exhausted' ? clock.now() + retryAfterMs : undefined
  }

  function pruneStarts(now: number): void {
    starts = starts.filter(at => now - at < windowMs)
  }

  function scheduleRestart(): void {
    if (stopped || restartTimer !== undefined) return
    const index = Math.min(restartIndex, SUPERVISOR_BACKOFF_MS.length - 1)
    const delay = SUPERVISOR_BACKOFF_MS[index] ?? 30_000
    restartIndex += 1
    restartCount += 1
    state = 'backoff'
    nextRestartAt = clock.now() + delay
    restartTimer = clock.setTimeout(() => {
      restartTimer = undefined
      nextRestartAt = undefined
      attemptStart()
    }, delay)
  }

  function onProcessEnd(
    gen: number,
    code: number | null,
    signal: string | null,
    error?: Error,
  ): void {
    if (gen !== generation || child === undefined) return
    const reason: SupervisorExitReason = error === undefined ? 'exited' : 'spawn-failed'
    teardown(gen, reason, 'exited')
    lastExit = {
      generation: gen,
      reason,
      at: clock.now(),
      code,
      signal,
    }
    if (stopped) {
      state = 'stopped'
      return
    }
    const kind = error === undefined ? 'retryable' : classify(error)
    if (kind === 'retryable') {
      scheduleRestart()
    } else {
      enterFailed(kind === 'config' ? 'config-invalid' : 'terminal-failure')
    }
  }

  function attach(gen: number, proc: SupervisorChild): void {
    const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
      onProcessEnd(gen, code, signal)
    }
    const error = (spawnError: Error): void => {
      onProcessEnd(gen, null, null, spawnError)
    }
    const data = (chunk: unknown): void => {
      if (Buffer.isBuffer(chunk)) stderrBuffer.append(chunk)
      else if (typeof chunk === 'string') stderrBuffer.append(Buffer.from(chunk))
    }
    proc.on('exit', exit)
    proc.on('error', error)
    proc.stderr?.on('data', data)
    listeners = { proc, exit, error, data }
  }

  function attemptStart(): boolean {
    if (stopped || child !== undefined) return false
    const now = clock.now()
    pruneStarts(now)
    if (starts.length >= maxStarts) {
      enterFailed('restart-exhausted')
      return false
    }

    clearRestartTimer()
    starts.push(now)
    generation += 1
    const gen = generation
    stderrBuffer = new BoundedBuffer(stderrLimit)
    failureReason = undefined
    retryAt = undefined
    state = 'starting'

    let proc: SupervisorChild
    try {
      proc = spawnFn(options.command, launchArgs, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        detached: platform !== 'win32',
        windowsHide: true,
      })
    } catch (error) {
      lastExit = { generation: gen, reason: 'spawn-failed', at: now }
      options.onExit?.(gen, 'spawn-failed')
      const kind = classify(error)
      if (kind === 'retryable') scheduleRestart()
      else enterFailed(kind === 'config' ? 'config-invalid' : 'terminal-failure')
      return false
    }

    child = proc
    attach(gen, proc)
    return true
  }

  function isCurrent(gen: number): boolean {
    return !stopped
      && child !== undefined
      && gen === generation
      && (state === 'starting' || state === 'running')
  }

  function busyNow(): boolean {
    if (pending.size > 0) return true
    if (options.busy === undefined) return true
    try { return options.busy() !== false } catch { return true }
  }

  function terminateCurrent(): void {
    const proc = child
    if (proc === undefined) return
    child = undefined
    detach(proc)
    clearGraceTimer()
    try { terminator.terminate(proc) } catch { /* best effort */ }
    scheduleGraceKill(proc)
  }

  const canReclaim = (): boolean => !stopped && child !== undefined && !busyNow()

  return {
    get generation(): number { return generation },
    get state(): SupervisorState { return state },
    get pending(): number { return pending.size },

    start(): boolean {
      if (stopped || child !== undefined) return false
      if (state === 'starting' || state === 'running' || state === 'backoff') return false
      if (state === 'failed' && (retryAt === undefined || clock.now() < retryAt)) return false
      return attemptStart()
    },

    recover(): boolean {
      if (stopped || state !== 'failed' || child !== undefined) return false
      // 显式恢复被视为新一次监督窗口：清空历史启动计数，允许人工立即重试。
      starts = []
      restartIndex = 0
      failureReason = undefined
      retryAt = undefined
      state = 'idle'
      return attemptStart()
    },

    markReady(): void {
      if (child === undefined || stopped) return
      state = 'running'
      restartIndex = 0
      failureReason = undefined
      retryAt = undefined
    },

    fail(error: unknown): void {
      if (stopped) return
      const kind = classify(error)
      if (child !== undefined) {
        const gen = generation
        terminateCurrent()
        rejectPending('exited')
        options.onExit?.(gen, 'exited')
      }
      if (kind === 'retryable') {
        if (child === undefined) scheduleRestart()
      } else {
        enterFailed(kind === 'config' ? 'config-invalid' : 'terminal-failure')
      }
    },

    request<T>(
      operation: (context: RequestContext) => Promise<T>,
      requestOptions?: { readonly signal?: AbortSignal },
    ): Promise<T> {
      if (stopped || child === undefined || (state !== 'starting' && state !== 'running')) {
        return Promise.reject(new SupervisorError('not-running', generation))
      }
      const gen = generation
      const controller = new AbortController()
      const id = nextPendingId++
      const external = requestOptions?.signal

      return new Promise<T>((resolve, reject) => {
        let settled = false
        const detachExternal = (): void => {
          external?.removeEventListener('abort', onExternalAbort)
        }
        const entry: PendingEntry = {
          generation: gen,
          controller,
          detach: detachExternal,
          reject,
        }
        const settle = (): boolean => {
          if (settled) return false
          settled = true
          detachExternal()
          return pending.delete(id)
        }
        function onExternalAbort(): void {
          if (settled) return
          settled = true
          detachExternal()
          pending.delete(id)
          controller.abort()
          reject(new SupervisorError('aborted', gen))
        }

        pending.set(id, entry)
        external?.addEventListener('abort', onExternalAbort, { once: true })
        if (external?.aborted === true) {
          onExternalAbort()
          return
        }

        let running: Promise<T>
        try {
          running = operation({ generation: gen, signal: controller.signal })
        } catch (error) {
          if (settle()) reject(error)
          return
        }
        running.then(
          value => {
            if (!settle()) return // 迟到响应：该代次已被拒绝/移除，直接忽略
            if (!isCurrent(gen)) {
              reject(new SupervisorError('stale-generation', gen))
              return
            }
            resolve(value)
          },
          error => {
            if (!settle()) return
            reject(error)
          },
        )
      })
    },

    isCurrent,

    canReclaim,

    async reclaim(): Promise<boolean> {
      if (!canReclaim()) return false
      // 任何 await 之前再检查一次，避免 busy 在竞态中变为 true。
      if (busyNow()) return false
      const proc = child
      if (proc === undefined) return false
      const gen = generation
      terminateCurrent()
      rejectPending('stopped')
      options.onExit?.(gen, 'stopped')
      lastExit = { generation: gen, reason: 'stopped', at: clock.now() }
      state = 'stopped'
      failureReason = { reason: 'idle-reclaimed' }
      return true
    },

    transport(): SupervisorTransport | undefined {
      if (child === undefined) return undefined
      return { generation, stdin: child.stdin, stdout: child.stdout }
    },

    health(): SupervisorHealth {
      return {
        state,
        generation,
        pending: pending.size,
        restarts: restartCount,
        ...(failureReason === undefined ? {} : { reason: failureReason }),
        ...(retryAt === undefined ? {} : { retryAt }),
        ...(nextRestartAt === undefined ? {} : { nextRestartAt }),
        ...(lastExit === undefined ? {} : { lastExit }),
      }
    },

    stderr(): StderrSnapshot {
      const snapshot = stderrBuffer.snapshot()
      return { generation, ...snapshot }
    },

    stop(): Promise<void> {
      if (stopPromise !== undefined) return stopPromise
      // 先禁用重启，再做任何清理/信号，避免退出事件触发新启动。
      stopped = true
      clearRestartTimer()
      const proc = child
      if (proc !== undefined) {
        const gen = generation
        child = undefined
        detach(proc)
        clearGraceTimer()
        rejectPending('stopped')
        options.onExit?.(gen, 'stopped')
        lastExit = { generation: gen, reason: 'stopped', at: clock.now() }
        try { terminator.terminate(proc) } catch { /* best effort */ }
        scheduleGraceKill(proc)
      } else {
        rejectPending('stopped')
      }
      failureReason = undefined
      retryAt = undefined
      state = 'stopped'
      stopPromise = Promise.resolve()
      return stopPromise
    },
  }
}
