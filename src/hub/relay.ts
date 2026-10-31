import { randomUUID } from 'node:crypto'
import { CommandLog } from '../wire/idempotency.ts'
import {
  encodeFrame, type AckFrame, type CommandFrame, type CommandOp, type EventFrame,
} from '../wire/frames.ts'
import { COMMAND_TTL_MS } from '../wire/limits.ts'
import type { DeviceRegistry, Sender } from './registry.ts'

/** T02 会换成持久化 owner 身份；当前显式占位，不能当作安全声明。 */
const PLACEHOLDER_OPERATOR_ID = 'operator-unbound'
const UNBOUND_CONNECTION_ID = 'unbound'
const UNBOUND_NODE_EPOCH = 'unbound'

export interface CommandInput {
  readonly op: CommandOp
  readonly target: CommandFrame['target']
  readonly args?: unknown
  readonly idempotencyKey: string
}

export type CommandOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: 'device-offline' | 'timeout' | string; message?: string }

export interface SessionRow {
  readonly deviceId: string
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

/** 被拒绝 ACK 的计数上限：只用于观测，不能被对端无限推高。 */
const MAX_REJECTED_ACKS = 1_000

/** 帧到达时的连接身份；ACK 必须与命令绑定及当前连接同时匹配。 */
export interface FrameIdentity {
  readonly deviceId: string
  readonly connectionId: string
  readonly nodeEpoch: string
}

function disposedOutcome(): CommandOutcome {
  return { ok: false, code: 'disposed', message: DISPOSED_MESSAGE }
}

interface Pending {
  resolve: (outcome: CommandOutcome) => void
  timer: NodeJS.Timeout
  readonly deviceId: string
  readonly connectionId: string
  readonly nodeEpoch: string
}

export class HubRelay {
  private readonly pending = new Map<string, Pending>()
  /** 幂等键 → 正在等待结果的指令；同键并发请求复用同一个 Promise。 */
  private readonly inflight = new Map<string, Promise<CommandOutcome>>()
  private readonly log = new CommandLog()
  private readonly consumers = new Set<(event: EventFrame) => void>()
  private readonly index = new Map<string, SessionRow>()
  private readonly epochs = new Map<string, string>()
  private disposed = false
  private rejectedAckTotal = 0

  constructor(private readonly options: {
    registry: DeviceRegistry
    now: () => number
    timeoutMs?: number
    operatorId?: string
  }) {}

  /** 身份不匹配或已超时的 ACK 计数，饱和在上限内。 */
  get rejectedAcks(): number { return this.rejectedAckTotal }

  get rejectedAckCount(): number { return this.rejectedAckTotal }

  private rejectAck(): void {
    if (this.rejectedAckTotal < MAX_REJECTED_ACKS) this.rejectedAckTotal += 1
  }

  async command(input: CommandInput): Promise<CommandOutcome> {
    if (this.disposed) return disposedOutcome()

    // 幂等范围按设备与 op 隔离：不同设备/不同 op 用同名 key 也各自下发。
    const cacheKey = `${input.target.deviceId}:${input.op}:${input.idempotencyKey}`
    const cached = this.log.lookup(cacheKey)
    if (cached.hit) return { ok: true, result: cached.result }

    const running = this.inflight.get(cacheKey)
    if (running !== undefined) return running

    const slot = this.options.registry.get(input.target.deviceId)
    if (slot === undefined) return { ok: false, code: 'device-offline' }

    const promise = this.dispatch(input, cacheKey, slot)
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
    slot: { readonly sender: Sender; readonly connectionId?: string; readonly nodeEpoch?: string },
  ): Promise<CommandOutcome> {
    const commandId = randomUUID()
    const timeoutMs = this.options.timeoutMs ?? COMMAND_TTL_MS
    const issuedAt = this.options.now()
    const connectionId = slot.connectionId ?? UNBOUND_CONNECTION_ID
    const nodeEpoch = slot.nodeEpoch ?? UNBOUND_NODE_EPOCH
    const frame: CommandFrame = {
      v: 2, type: 'command', commandId, idempotencyKey: input.idempotencyKey,
      operatorId: this.options.operatorId ?? PLACEHOLDER_OPERATOR_ID,
      target: input.target,
      op: input.op,
      args: input.args ?? {},
      issuedAt,
      deadline: issuedAt + timeoutMs,
      connectionId,
      nodeEpoch,
    }

    const outcome = await new Promise<CommandOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId)
        resolve({ ok: false, code: 'timeout' })
      }, timeoutMs)
      this.pending.set(commandId, {
        resolve, timer, deviceId: input.target.deviceId, connectionId, nodeEpoch,
      })
      let text: string
      try {
        text = encodeFrame(frame)
      } catch (error) {
        // 编码失败不能留下悬挂的 pending 与定时器。
        clearTimeout(timer)
        this.pending.delete(commandId)
        reject(error)
        return
      }
      try {
        slot.sender.send(text)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(commandId)
        reject(error)
      }
    })

    if (outcome.ok) this.log.remember(cacheKey, outcome.result)
    return outcome
  }

  /**
   * 只有 commandId、绑定连接身份与当前注册槽位全部匹配的 ACK 才能结算；
   * 旧连接/旧代次的 ACK 一律忽略并计入有界拒绝计数（契约 §4.6）。
   */
  settle(ack: AckFrame, origin: FrameIdentity): void {
    const entry = this.pending.get(ack.commandId)
    if (entry === undefined) {
      this.rejectAck()
      return
    }
    const slot = this.options.registry.get(entry.deviceId)
    const currentConnection = slot !== undefined
      && (slot.connectionId ?? UNBOUND_CONNECTION_ID) === origin.connectionId
      && (slot.nodeEpoch ?? UNBOUND_NODE_EPOCH) === origin.nodeEpoch
    if (origin.deviceId !== entry.deviceId
      || !currentConnection
      || ack.connectionId !== entry.connectionId
      || ack.nodeEpoch !== entry.nodeEpoch) {
      this.rejectAck()
      return
    }
    clearTimeout(entry.timer)
    this.pending.delete(ack.commandId)
    switch (ack.status) {
      case 'accepted':
      case 'confirmed':
        entry.resolve({ ok: true, result: ack.result })
        return
      case 'rejected':
        entry.resolve({ ok: false, code: ack.code ?? 'unsupported' })
        return
      case 'pending-confirmation':
      case 'outcome-unknown':
        // 两种状态都不是失败重试信号：保留各自的机器可读 code，不能折叠成 unknown。
        entry.resolve({ ok: false, code: ack.status })
        return
    }
  }

  /** 设备掉线时立刻结束发给它的指令，不让调用方干等到超时。 */
  deviceOffline(deviceId: string): void {
    for (const [commandId, entry] of [...this.pending]) {
      if (entry.deviceId !== deviceId) continue
      clearTimeout(entry.timer)
      this.pending.delete(commandId)
      entry.resolve({ ok: false, code: 'device-offline' })
    }
  }

  /** 节点重连后以快照为准：先清掉该设备的旧索引，并把移除通知给订阅者。 */
  clearDevice(deviceId: string): void {
    for (const [key, row] of [...this.index]) {
      if (row.deviceId !== deviceId) continue
      this.index.delete(key)
      this.publish({
        v: 2, type: 'event', deviceId: row.deviceId, agent: row.agent, sessionId: row.sessionId,
        nodeEpoch: this.epochs.get(deviceId) ?? UNBOUND_NODE_EPOCH,
        seq: 0, ts: this.options.now(), kind: 'session.removed', payload: {},
      })
    }
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
    const key = `${event.deviceId}\u0000${event.agent}\u0000${event.sessionId}`
    this.epochs.set(event.deviceId, event.nodeEpoch)
    if (event.kind === 'session.removed') {
      this.index.delete(key)
    } else if (event.kind === 'session.updated') {
      const payload = (event.payload ?? {}) as { running?: unknown; updatedAt?: unknown; cwd?: unknown }
      this.index.set(key, {
        deviceId: event.deviceId, agent: event.agent, sessionId: event.sessionId,
        running: payload.running === true,
        updatedAt: typeof payload.updatedAt === 'number' ? payload.updatedAt : event.ts,
        ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
      })
    }
    // 单个订阅者抛错不影响其它订阅者，也不影响调用方。
    for (const consumer of [...this.consumers]) {
      try { consumer(event) } catch { /* 忽略单个订阅者的失败 */ }
    }
  }

  /** 只返回注册表里仍存在设备的会话，设备断线后不再残留。 */
  sessions(deviceId?: string): SessionRow[] {
    return [...this.index.values()].filter(row =>
      (deviceId === undefined || row.deviceId === deviceId) && this.options.registry.get(row.deviceId) !== undefined)
  }

  subscribe(consumer: (event: EventFrame) => void): () => void {
    if (!this.consumers.has(consumer) && this.consumers.size >= MAX_SUBSCRIBERS) {
      throw new Error('relay: too many subscribers')
    }
    this.consumers.add(consumer)
    return () => { this.consumers.delete(consumer) }
  }
}
