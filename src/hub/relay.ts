import { randomUUID } from 'node:crypto'
import { CommandLog } from '../wire/idempotency.ts'
import { encodeFrame, type AckFrame, type CommandFrame, type EventFrame } from '../wire/frames.ts'
import type { DeviceRegistry } from './registry.ts'

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

interface Pending { resolve: (outcome: CommandOutcome) => void; timer: NodeJS.Timeout }

export class HubRelay {
  private readonly pending = new Map<string, Pending>()
  private readonly log = new CommandLog()
  private readonly consumers = new Set<(event: EventFrame) => void>()
  private readonly index = new Map<string, SessionRow>()

  constructor(private readonly options: {
    registry: DeviceRegistry
    now: () => number
    timeoutMs?: number
  }) {}

  async command(input: CommandInput): Promise<CommandOutcome> {
    const cached = this.log.lookup(input.idempotencyKey)
    if (cached.hit) return { ok: true, result: cached.result }

    const slot = this.options.registry.get(input.target.device)
    if (slot === undefined) return { ok: false, code: 'device-offline' }

    const id = randomUUID()
    const frame: CommandFrame = {
      v: 1, type: 'command', id, idempotencyKey: input.idempotencyKey,
      deadline: this.options.now() + (this.options.timeoutMs ?? 30_000),
      op: input.op, target: input.target,
      ...(input.args === undefined ? {} : { args: input.args }),
    }

    const outcome = await new Promise<CommandOutcome>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, code: 'timeout' })
      }, this.options.timeoutMs ?? 30_000)
      this.pending.set(id, { resolve, timer })
      slot.sender.send(encodeFrame(frame))
    })

    if (outcome.ok) this.log.remember(input.idempotencyKey, outcome.result)
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
    for (const consumer of this.consumers) consumer(event)
  }

  sessions(device?: string): SessionRow[] {
    return [...this.index.values()].filter(row => device === undefined || row.device === device)
  }

  subscribe(consumer: (event: EventFrame) => void): () => void {
    this.consumers.add(consumer)
    return () => { this.consumers.delete(consumer) }
  }
}
