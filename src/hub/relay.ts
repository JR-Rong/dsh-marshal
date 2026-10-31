import { randomUUID } from 'node:crypto'
import {
  encodeFrame, type AckFrame, type CommandFrame, type CommandOp,
  type CommandStatusFrame, type CommandStatusResultFrame, type EventFrame,
} from '../wire/frames.ts'
import { COMMAND_TTL_MS } from '../wire/limits.ts'
import { commandPayloadDigest } from '../wire/commands.ts'
import { commandDomainKey } from '../wire/idempotency.ts'
import { HubIdempotency } from './idempotency.ts'
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

/**
 * `status` 是命令生命周期状态，HTTP 只按它决定 200/202/409，不靠错误字符串。
 * 传输层/前置失败（device-offline、idempotency-conflict、disposed）用 rejected 表示
 * “没有产生执行”；发送后结果不明一律 outcome-unknown。
 */
export type CommandOutcome =
  | { ok: true; status: 'accepted' | 'confirmed'; result: unknown }
  | {
    ok: false
    status: 'rejected' | 'pending-confirmation' | 'outcome-unknown'
    code: string
    message?: string
  }

/** 只读状态查询；op 仅用于 HTTP 形状校验，不属于幂等域。 */
export interface CommandStatusInput {
  readonly op: CommandOp
  readonly target: CommandFrame['target']
  readonly idempotencyKey: string
}

export interface CommandStatusOutcome {
  readonly status: AckFrame['status']
  readonly code?: string
  readonly result?: unknown
}

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
  return { ok: false, status: 'outcome-unknown', code: 'disposed', message: DISPOSED_MESSAGE }
}

interface Pending {
  resolve: (outcome: CommandOutcome) => void
  timer: NodeJS.Timeout
  readonly deviceId: string
  readonly connectionId: string
  readonly nodeEpoch: string
}

interface PendingStatus {
  resolve: (outcome: CommandStatusOutcome) => void
  timer: NodeJS.Timeout
  readonly deviceId: string
  readonly connectionId: string
  readonly nodeEpoch: string
}

export class HubRelay {
  private readonly pending = new Map<string, Pending>()
  private readonly statusPending = new Map<string, PendingStatus>()
  private readonly idempotency = new HubIdempotency<CommandOutcome>()
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

  private operatorId(): string {
    return this.options.operatorId ?? PLACEHOLDER_OPERATOR_ID
  }

  private domainKey(target: CommandFrame['target'], idempotencyKey: string): string {
    return commandDomainKey({
      operatorId: this.operatorId(),
      target,
      idempotencyKey,
    })
  }

  async command(input: CommandInput): Promise<CommandOutcome> {
    if (this.disposed) return disposedOutcome()

    // 先算载荷摘要：同域不同载荷必须 conflict，不能因为 key 相同就复用结果。
    const digest = commandPayloadDigest(input.op, input.target, input.args ?? {})
    const key = this.domainKey(input.target, input.idempotencyKey)
    const prior = this.idempotency.lookup(key, digest)
    if (prior !== undefined) {
      if (prior.kind === 'conflict') {
        return { ok: false, status: 'rejected', code: 'idempotency-conflict' }
      }
      if (prior.kind === 'inflight') return prior.promise
      return prior.value
    }

    const slot = this.options.registry.get(input.target.deviceId)
    if (slot === undefined) {
      return { ok: false, status: 'rejected', code: 'device-offline' }
    }

    // 登记必须发生在任何 await 之前；同一轮事件循环里的并发调用只能有一个赢家。
    const promise = this.dispatch(input, slot)
    this.idempotency.begin(key, digest, promise)
    try {
      const outcome = await promise
      if (outcome.ok || outcome.code !== 'disposed') {
        // accepted/confirmed/rejected 是终态；pending/unknown 只阻止重发，不算成功缓存。
        const resolved = outcome.ok || outcome.status === 'rejected'
        this.idempotency.complete(key, digest, outcome, resolved)
      }
      return outcome
    } finally {
      this.idempotency.end(key, promise)
    }
  }

  private async dispatch(
    input: CommandInput,
    slot: { readonly sender: Sender; readonly connectionId?: string; readonly nodeEpoch?: string },
  ): Promise<CommandOutcome> {
    const commandId = randomUUID()
    const timeoutMs = this.options.timeoutMs ?? COMMAND_TTL_MS
    const issuedAt = this.options.now()
    const connectionId = slot.connectionId ?? UNBOUND_CONNECTION_ID
    const nodeEpoch = slot.nodeEpoch ?? UNBOUND_NODE_EPOCH
    const frame: CommandFrame = {
      v: 2, type: 'command', commandId, idempotencyKey: input.idempotencyKey,
      operatorId: this.operatorId(),
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
        // 命令已经发出：没有 ACK 不能推断未执行，只能按结果未知处理。
        resolve({ ok: false, status: 'outcome-unknown', code: 'outcome-unknown' })
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
    if (!this.currentBinding(entry, origin)
      || ack.connectionId !== entry.connectionId
      || ack.nodeEpoch !== entry.nodeEpoch) {
      this.rejectAck()
      return
    }
    clearTimeout(entry.timer)
    this.pending.delete(ack.commandId)
    switch (ack.status) {
      case 'accepted':
        entry.resolve({ ok: true, status: 'accepted', result: ack.result })
        return
      case 'confirmed':
        entry.resolve({ ok: true, status: 'confirmed', result: ack.result })
        return
      case 'rejected':
        entry.resolve({ ok: false, status: 'rejected', code: ack.code ?? 'unsupported' })
        return
      case 'pending-confirmation':
        entry.resolve({ ok: false, status: 'pending-confirmation', code: ack.code ?? 'pending-confirmation' })
        return
      case 'outcome-unknown':
        // 状态保持 unknown，code 可以是 recovery-required 等细节；不折叠成失败。
        entry.resolve({ ok: false, status: 'outcome-unknown', code: ack.code ?? 'outcome-unknown' })
        return
    }
  }

  /** 只读状态查询：发送 command.status，绝不重放原命令。 */
  async commandStatus(input: CommandStatusInput): Promise<CommandStatusOutcome> {
    if (this.disposed) return { status: 'outcome-unknown', code: 'disposed' }
    const slot = this.options.registry.get(input.target.deviceId)
    if (slot === undefined) return { status: 'outcome-unknown', code: 'device-offline' }

    const requestId = randomUUID()
    const timeoutMs = this.options.timeoutMs ?? COMMAND_TTL_MS
    const connectionId = slot.connectionId ?? UNBOUND_CONNECTION_ID
    const nodeEpoch = slot.nodeEpoch ?? UNBOUND_NODE_EPOCH
    const frame: CommandStatusFrame = {
      v: 2, type: 'command.status', requestId,
      operatorId: this.operatorId(),
      target: input.target,
      idempotencyKey: input.idempotencyKey,
      connectionId,
      nodeEpoch,
    }

    return await new Promise<CommandStatusOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.statusPending.delete(requestId)
        resolve({ status: 'outcome-unknown', code: 'outcome-unknown' })
      }, timeoutMs)
      this.statusPending.set(requestId, {
        resolve, timer, deviceId: input.target.deviceId, connectionId, nodeEpoch,
      })
      try {
        slot.sender.send(encodeFrame(frame))
      } catch {
        clearTimeout(timer)
        this.statusPending.delete(requestId)
        // 查询没有发出去：没有执行任何命令，仍按结果未知返回，调用方可重查。
        resolve({ status: 'outcome-unknown', code: 'outcome-unknown' })
      }
    })
  }

  /** 状态查询结果必须来自当前绑定连接；旧连接不能冒充新确认。 */
  settleStatus(frame: CommandStatusResultFrame, origin: FrameIdentity): void {
    const entry = this.statusPending.get(frame.requestId)
    if (entry === undefined) {
      this.rejectAck()
      return
    }
    if (!this.currentBinding(entry, origin)) {
      this.rejectAck()
      return
    }
    clearTimeout(entry.timer)
    this.statusPending.delete(frame.requestId)
    entry.resolve({
      status: frame.status,
      ...(frame.code === undefined ? {} : { code: frame.code }),
      ...(frame.result === undefined ? {} : { result: frame.result }),
    })
  }

  private currentBinding(
    entry: { readonly deviceId: string; readonly connectionId: string; readonly nodeEpoch: string },
    origin: FrameIdentity,
  ): boolean {
    const slot = this.options.registry.get(entry.deviceId)
    return origin.deviceId === entry.deviceId
      && slot !== undefined
      && (slot.connectionId ?? UNBOUND_CONNECTION_ID) === origin.connectionId
      && (slot.nodeEpoch ?? UNBOUND_NODE_EPOCH) === origin.nodeEpoch
  }

  /** 设备掉线时立刻结束发给它的指令：已发送的命令只能记为结果未知。 */
  deviceOffline(deviceId: string): void {
    for (const [commandId, entry] of [...this.pending]) {
      if (entry.deviceId !== deviceId) continue
      clearTimeout(entry.timer)
      this.pending.delete(commandId)
      entry.resolve({ ok: false, status: 'outcome-unknown', code: 'device-offline' })
    }
    for (const [requestId, entry] of [...this.statusPending]) {
      if (entry.deviceId !== deviceId) continue
      clearTimeout(entry.timer)
      this.statusPending.delete(requestId)
      entry.resolve({ status: 'outcome-unknown', code: 'device-offline' })
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
    const waitingStatus = [...this.statusPending.values()]
    this.statusPending.clear()
    this.idempotency.clear()
    for (const entry of waiting) {
      clearTimeout(entry.timer)
      entry.resolve(disposedOutcome())
    }
    for (const entry of waitingStatus) {
      clearTimeout(entry.timer)
      entry.resolve({ status: 'outcome-unknown', code: 'disposed' })
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
