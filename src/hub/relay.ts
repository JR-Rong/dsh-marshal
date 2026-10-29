import { randomUUID } from 'node:crypto'
import { CommandLog } from '../wire/idempotency.ts'
import { encodeFrame, type AckFrame, type CommandFrame, type EventFrame } from '../wire/frames.ts'
import type { DeviceRegistry, Sender } from './registry.ts'

export interface CommandInput {
  readonly op: CommandFrame['op']
  readonly target: CommandFrame['target']
  readonly args?: unknown
  readonly idempotencyKey: string
}

export type CommandOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: 'device-offline' | 'timeout' | string; message?: string }

export interface SessionRow {
  readonly device: string
  readonly agent: string
  readonly sessionId: string
  readonly running: boolean
  readonly updatedAt: number
  readonly cwd?: string
}

/** 订阅者数量上限，避免单个 hub 被无限个监听者拖垮。 */
const MAX_SUBSCRIBERS = 200

/** dispose 之后所有未完成与新到的指令都以这个固定错误结束。 */
const DISPOSED_MESSAGE = 'relay: disposed'

function disposedOutcome(): CommandOutcome {
  return { ok: false, code: 'disposed', message: DISPOSED_MESSAGE }
}

interface Pending { resolve: (outcome: CommandOutcome) => void; timer: NodeJS.Timeout }

export class HubRelay {
  private readonly pending = new Map<string, Pending>()
  /** 幂等键 → 正在等待结果的指令；同键并发请求复用同一个 Promise。 */
  private readonly inflight = new Map<string, Promise<CommandOutcome>>()
  private readonly log = new CommandLog()
  private readonly consumers = new Set<(event: EventFrame) => void>()
  private readonly index = new Map<string, SessionRow>()
  private disposed = false

  constructor(private readonly options: {
    registry: DeviceRegistry
    now: () => number
    timeoutMs?: number
  }) {}

  async command(input: CommandInput): Promise<CommandOutcome> {
    if (this.disposed) return disposedOutcome()

    // 幂等范围按设备与 op 隔离：不同设备/不同 op 用同名 key 也各自下发。
    const cacheKey = `${input.target.device}:${input.op}:${input.idempotencyKey}`
    const cached = this.log.lookup(cacheKey)
    if (cached.hit) return { ok: true, result: cached.result }

    const running = this.inflight.get(cacheKey)
    if (running !== undefined) return running

    const slot = this.options.registry.get(input.target.device)
    if (slot === undefined) return { ok: false, code: 'device-offline' }

    const promise = this.dispatch(input, cacheKey, slot.sender)
    this.inflight.set(cacheKey, promise)
    try {
      return await promise
    } finally {
      if (this.inflight.get(cacheKey) === promise) this.inflight.delete(cacheKey)
    }
  }

  private async dispatch(
    input: CommandInput,
    cacheKey: string,
    sender: Sender,
  ): Promise<CommandOutcome> {
    const id = randomUUID()
    const timeoutMs = this.options.timeoutMs ?? 30_000
    const frame: CommandFrame = {
      v: 1, type: 'command', id, idempotencyKey: input.idempotencyKey,
      deadline: this.options.now() + timeoutMs,
      op: input.op, target: input.target,
      ...(input.args === undefined ? {} : { args: input.args }),
    }

    const outcome = await new Promise<CommandOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, code: 'timeout' })
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      let text: string
      try {
        text = encodeFrame(frame)
      } catch (error) {
        // 编码失败不能留下悬挂的 pending 与定时器。
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
        return
      }
      try {
        sender.send(text)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })

    if (outcome.ok) this.log.remember(cacheKey, outcome.result)
    return outcome
  }

  settle(ack: AckFrame): void {
    const entry = this.pending.get(ack.id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.pending.delete(ack.id)
    entry.resolve(ack.ok
      ? { ok: true, result: ack.result }
      : { ok: false, code: ack.code ?? 'error', ...(ack.message === undefined ? {} : { message: ack.message }) })
  }

  /** 停止接收新指令：清定时器、以固定错误结束所有等待中的指令。幂等。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const waiting = [...this.pending.values()]
    this.pending.clear()
    this.inflight.clear()
    for (const entry of waiting) {
      clearTimeout(entry.timer)
      entry.resolve(disposedOutcome())
    }
  }

  /** 记录会话索引并扇出；索引只存设备/agent/sessionId/运行态，不存标题或正文。 */
  publish(event: EventFrame): void {
    const key = `${event.device}\u0000${event.agent}\u0000${event.sessionId}`
    if (event.kind === 'session.removed') {
      this.index.delete(key)
    } else if (event.kind === 'session.updated') {
      const payload = (event.payload ?? {}) as { running?: unknown; updatedAt?: unknown; cwd?: unknown }
      this.index.set(key, {
        device: event.device, agent: event.agent, sessionId: event.sessionId,
        running: payload.running === true,
        updatedAt: typeof payload.updatedAt === 'number' ? payload.updatedAt : (Date.parse(event.ts) || 0),
        ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
      })
    }
    // 单个订阅者抛错不影响其它订阅者，也不影响调用方。
    for (const consumer of [...this.consumers]) {
      try { consumer(event) } catch { /* 忽略单个订阅者的失败 */ }
    }
  }

  /** 只返回注册表里仍存在设备的会话，设备断线后不再残留。 */
  sessions(device?: string): SessionRow[] {
    return [...this.index.values()].filter(row =>
      (device === undefined || row.device === device) && this.options.registry.get(row.device) !== undefined)
  }

  subscribe(consumer: (event: EventFrame) => void): () => void {
    if (!this.consumers.has(consumer) && this.consumers.size >= MAX_SUBSCRIBERS) {
      throw new Error('relay: too many subscribers')
    }
    this.consumers.add(consumer)
    return () => { this.consumers.delete(consumer) }
  }
}
