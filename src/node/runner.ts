import {
  encodeFrame, type AckFrame, type CommandStatusResultFrame, type EventFrame, type Frame,
  type WireErrorCode,
} from '../wire/frames.ts'
import { parseCommandArgs, type ObserveArgs } from '../wire/commands.ts'
import { PreCallRejection, type Adapter } from '../adapters/types.ts'
import type { LoggerLike } from '../dsh-types.ts'
import type { HandshakeBinding, NodeLink } from './link.ts'
import { JournalError, type Journal, type JournalDomain, type JournalEntry, type SettledStatus } from './journal.ts'
import { createPrivacyProjector, type PrivacyProjector } from './privacy.ts'
import type { AuditSink } from './audit.ts'

/** 命令出口的投影端口与审计：每次调用都现取，握手收紧后立即生效。 */
export interface CommandRuntime {
  projector(): PrivacyProjector
  audit?: AuditSink
  /** 当前待答快照；只读，不写 journal，也不进入命令分派。 */
  inputs?: {
    snapshot(sessionId: string): readonly unknown[]
    highWatermark(): number
  }
}

/** 日志只留错误类型：原始 message 可能夹带会话正文或密钥。 */
function errorClass(error: unknown): string {
  return error instanceof Error && error.name !== '' ? error.name : 'error'
}

/**
 * 每会话一条原生跟随循环，严格按 hub 签发的 subscriptionId 引用计数。
 * subscriptionId 是唯一计数键；operator/connection 只用于判断“同一调用者”。
 * 同一 id 同调用者重复订阅返回同一订阅；不同调用者复用同一 id 是 conflict。
 * 最后一个订阅移除时才释放原生 follower。
 */
export function createFollower(options: {
  adapter: Adapter
  send: (event: EventFrame) => void
  logger: Pick<LoggerLike, 'warn'>
}) {
  interface SessionFollow {
    readonly abort: AbortController
    /** subscriptionId -> caller；调用者身份不参与计数。 */
    readonly refs: Map<string, string>
  }
  const sessions = new Map<string, SessionFollow>()

  const run = (sessionId: string, entry: SessionFollow): void => {
    void (async () => {
      try {
        for await (const event of options.adapter.follow(sessionId, entry.abort.signal)) {
          // 单条事件超限只丢这一条；否则一次过大的 send 会终止整个跟随循环。
          try {
            options.send(event)
          } catch (error) {
            options.logger.warn('marshal: follow ' + sessionId + ' dropped event: ' + errorClass(error))
          }
        }
      } catch (error) {
        if (!entry.abort.signal.aborted) options.logger.warn('marshal: follow ' + sessionId + ' ended: ' + errorClass(error))
      } finally {
        // 只清掉本循环自己登记的条目，避免把重启后的新循环踢出 map。
        if (sessions.get(sessionId) === entry) sessions.delete(sessionId)
      }
    })()
  }

  const release = (sessionId: string, entry: SessionFollow): void => {
    if (entry.refs.size > 0) return
    entry.abort.abort()
    if (sessions.get(sessionId) === entry) sessions.delete(sessionId)
  }

  return {
    /**
     * 同 id 同调用者幂等返回现有订阅；同 id 不同调用者返回 conflict。
     * 同一调用者持多个不同 id（例如同一连接下的两个 tab）是允许的。
     */
    subscribe(sessionId: string, subscriptionId: string, caller: string): 'ok' | 'conflict' {
      const existing = sessions.get(sessionId)
      const owner = existing?.refs.get(subscriptionId)
      if (owner !== undefined) return owner === caller ? 'ok' : 'conflict'
      const entry: SessionFollow = existing ?? { abort: new AbortController(), refs: new Map() }
      if (existing === undefined) {
        sessions.set(sessionId, entry)
        run(sessionId, entry)
      }
      entry.refs.set(subscriptionId, caller)
      return 'ok'
    },
    /** 只按 id 删除，且调用者必须是该 id 的登记人；未知 id 一律拒绝。 */
    unsubscribe(sessionId: string, subscriptionId: string, caller: string): boolean {
      const entry = sessions.get(sessionId)
      if (entry === undefined || entry.refs.get(subscriptionId) !== caller) return false
      entry.refs.delete(subscriptionId)
      release(sessionId, entry)
      return true
    },
    /** 断线时清掉该调用者的全部订阅 id；只有归零的会话才停止原生跟随。 */
    unsubscribeCaller(caller: string): void {
      for (const [sessionId, entry] of [...sessions]) {
        for (const [subscriptionId, owner] of [...entry.refs]) {
          if (owner === caller) entry.refs.delete(subscriptionId)
        }
        release(sessionId, entry)
      }
    },
    has(sessionId: string): boolean { return sessions.has(sessionId) },
    stopAll(): void {
      for (const entry of sessions.values()) entry.abort.abort()
      sessions.clear()
    },
  }
}

/** 只允许 spec 定义的 wire 错误码过线；其余（`marshal: …`、`Error: …`）一律归为 agent-crashed。 */
const WIRE_CODES: ReadonlySet<string> = new Set([
  'session-unknown', 'invalid-args', 'unsupported', 'device-mismatch', 'agent-crashed', 'result-too-large',
  'unknown', 'invalid', 'session-mismatch', 'tighten-only', 'deadline-expired',
  'stale-connection', 'clock-skew', 'writer-busy', 'conflict',
])

/** 超过这个偏差就不接受带副作用的命令：期限判断已经不可信。 */
const MAX_CLOCK_SKEW_MS = 60_000

/** 只允许已声明的 wire 错误码过线；journal 里的 code 可能来自旧版本。 */
function asWireCode(code: string | undefined, fallback: WireErrorCode): WireErrorCode {
  return code !== undefined && WIRE_CODES.has(code) ? code as WireErrorCode : fallback
}

function entryStatus(entry: JournalEntry): AckFrame['status'] {
  // admitted 表示已持久登记、尚未拿到结果；对查询方只能诚实回答 unknown。
  return entry.status === 'admitted' ? 'outcome-unknown' : entry.status
}

/** 观察者身份：认证 operatorId + 当前连接；重连后旧连接引用全部失效。 */
function observerKey(frame: { operatorId: string; connectionId: string }): string {
  return `${frame.operatorId}\u0000${frame.connectionId}`
}

/** 只读状态查询：不占 journal、不触发执行。 */
function runStatusQuery(
  link: NodeLink,
  adapter: Adapter,
  journal: Journal,
  frame: Extract<Frame, { type: 'command.status' }>,
  deviceId: string,
  runtime?: CommandRuntime,
): void {
  const fallbackProjector = createPrivacyProjector({
    privacy: 'metadata', allowContent: false, questionRelay: 'off', approvalRelay: 'off',
    allowInteractions: false, redaction: [], deviceId, agent: adapter.agent,
  })
  const project = (): PrivacyProjector => runtime?.projector() ?? fallbackProjector
  const reply = (status: AckFrame['status'], code?: WireErrorCode, result?: unknown): void => {
    const body: CommandStatusResultFrame = {
      v: 2, type: 'command.status.result', requestId: frame.requestId, status,
      ...(code === undefined ? {} : { code }),
      ...(result === undefined ? {} : { result }),
    }
    try { link.sendRaw(encodeFrame(project().statusResult(body))) } catch { /* 回不去就保持未知，调用方超时 */ }
  }
  const binding = link.handshake
  if (binding === undefined
    || frame.connectionId !== binding.connectionId
    || frame.nodeEpoch !== binding.nodeEpoch) {
    // 握手未完成或帧来自旧连接/旧实例：不能读，更不能据此执行。
    reply('rejected', 'stale-connection')
    return
  }
  if (frame.target.deviceId !== deviceId) { reply('rejected', 'device-mismatch'); return }
  if (frame.target.agent !== adapter.agent) { reply('rejected', 'session-unknown'); return }
  const domain: JournalDomain = {
    operatorId: frame.operatorId,
    target: frame.target,
    idempotencyKey: frame.idempotencyKey,
  }
  let entry: JournalEntry | undefined
  try {
    entry = journal.lookup(domain)
  } catch {
    // 读取失败无法证明“没有记录”，只能按不可用处理。
    reply('outcome-unknown', 'record-unavailable')
    return
  }
  if (entry === undefined) {
    // 无记录（包括已过保留期）不能推断未执行，只报 record-unavailable。
    reply('outcome-unknown', 'record-unavailable')
    return
  }
  const status = entryStatus(entry)
  const fallbackCode: WireErrorCode = status === 'rejected' ? 'unsupported' : 'outcome-unknown'
  reply(
    status,
    entry.code === undefined ? undefined : asWireCode(entry.code, fallbackCode),
    entry.result,
  )
}

/** 命令帧必须落在当前握手上；没有绑定证据时同样按过期连接处理。 */
function bindingFor(link: NodeLink, frame: { connectionId: string; nodeEpoch: string }): HandshakeBinding | undefined {
  const binding = link.handshake
  if (binding === undefined
    || binding.connectionId !== frame.connectionId
    || binding.nodeEpoch !== frame.nodeEpoch) return undefined
  return binding
}

/**
 * 待答快照是只读查询：不占 journal、不触发执行。
 * 身份/会话不匹配就静默忽略，由调用方超时按 unknown 处理。
 */
function runInputsSnapshot(
  link: NodeLink,
  adapter: Adapter,
  frame: Extract<Frame, { type: 'inputs.snapshot' }>,
  deviceId: string,
  runtime?: CommandRuntime,
): void {
  const binding = bindingFor(link, frame)
  if (binding === undefined) return
  if (frame.target.deviceId !== deviceId) return
  if (frame.target.agent !== adapter.agent) return
  const sessionId = frame.target.sessionId
  // schema 已保证非空字符串；这里再防一手运行期构造。
  if (typeof sessionId !== 'string' || sessionId === '') return

  const reply = (cards: readonly unknown[], highWatermark: number): void => {
    const body = {
      v: 2 as const,
      type: 'inputs.snapshot.result' as const,
      requestId: frame.requestId,
      runtimeEpoch: binding.nodeEpoch,
      highWatermark,
      cards: [...cards],
    }
    link.sendRaw(encodeFrame(body))
  }

  let cards: readonly unknown[] = []
  let highWatermark = 0
  try {
    cards = runtime?.inputs?.snapshot(sessionId) ?? []
    highWatermark = runtime?.inputs?.highWatermark() ?? 0
  } catch {
    cards = []
    highWatermark = 0
  }
  try {
    reply(cards, highWatermark)
  } catch {
    // 快照编码/发送失败（例如单帧过大）：退回最小结果，不能打挂宿主。
    try { reply([], 0) } catch { /* 连接已断：调用方超时 */ }
  }
}

export function runCommand(
  link: NodeLink,
  adapter: Adapter,
  follower: ReturnType<typeof createFollower>,
  frame: Frame,
  deviceId: string,
  journal: Journal,
  now: () => number = Date.now,
  runtime?: CommandRuntime,
): void {
  const fallback = createPrivacyProjector({
    privacy: 'metadata', allowContent: false, questionRelay: 'off', approvalRelay: 'off',
    allowInteractions: false, redaction: [], deviceId, agent: adapter.agent,
  })
  const project = (): PrivacyProjector => runtime?.projector() ?? fallback
  if (frame.type === 'command.status') {
    runStatusQuery(link, adapter, journal, frame, deviceId, runtime)
    return
  }
  // 待答快照是只读控制帧，不是命令，也不能落 journal。
  if (frame.type === 'inputs.snapshot') {
    runInputsSnapshot(link, adapter, frame, deviceId, runtime)
    return
  }
  if (frame.type !== 'command') return
  /** 审计只带身份/操作/状态/错误分类；命令正文与答案不在白名单里。 */
  const audit = (body: { status: AckFrame['status']; code?: WireErrorCode }): void => {
    if (runtime?.audit === undefined) return
    try {
      runtime.audit.write(project().auditFields({
        operatorId: frame.operatorId,
        deviceId,
        agent: adapter.agent,
        ...(frame.target.sessionId === null ? {} : { sessionId: frame.target.sessionId }),
        op: frame.op,
        requestId: frame.commandId,
        decision: body.status,
        status: body.status,
        ...(body.code === undefined ? {} : { errorClass: body.code }),
      }))
    } catch { /* 审计失败绝不能影响命令结果 */ }
  }
  // ack 绝不能再抛：未处理的拒绝会直接打挂 DSH 宿主进程。
  const reply = (body: {
    status: AckFrame['status']
    code?: WireErrorCode
    result?: unknown
  }): void => {
    const ack: AckFrame = {
      v: 2, type: 'ack', commandId: frame.commandId,
      connectionId: frame.connectionId, nodeEpoch: frame.nodeEpoch,
      status: body.status,
      ...(body.code === undefined ? {} : { code: body.code }),
      ...(body.result === undefined ? {} : { result: body.result }),
    }
    audit(body)
    try {
      link.sendRaw(encodeFrame(project().ack(ack)))
    } catch {
      // 结果超过帧上限：保留真实生命周期状态，只去掉 result 并标注原因。
      // 绝不改写成 rejected——副作用可能已经发生。
      const fallbackAck: AckFrame = {
        v: 2, type: 'ack', commandId: frame.commandId,
        connectionId: frame.connectionId, nodeEpoch: frame.nodeEpoch,
        status: body.status, code: 'result-too-large',
      }
      link.sendRaw(encodeFrame(project().ack(fallbackAck)))
    }
  }
  /** 结果与 journal 共用同一白名单：超限只留分类，绝不落盘正文。 */
  const safeResult = (result: unknown): { result?: unknown; code?: WireErrorCode } => {
    if (result === undefined) return {}
    const projected = project().ack({
      v: 2, type: 'ack', commandId: frame.commandId,
      connectionId: frame.connectionId, nodeEpoch: frame.nodeEpoch,
      status: 'accepted', result,
    })
    return {
      ...(projected.result === undefined ? {} : { result: projected.result }),
      ...(projected.code === undefined ? {} : { code: projected.code }),
    }
  }
  const binding = bindingFor(link, frame)
  if (binding === undefined) {
    // 旧连接/旧实例的帧：执行会重复副作用，必须丢弃。
    reply({ status: 'rejected', code: 'stale-connection' })
    return
  }
  // 期限由 hub 用服务端时钟填写；本地判断必须先做偏移校正。
  const deadlineNow = (): number => now() + binding.serverTimeOffset
  if (frame.target.deviceId !== deviceId) { reply({ status: 'rejected', code: 'device-mismatch' }); return }
  if (frame.target.agent !== adapter.agent) {
    reply({ status: 'rejected', code: 'session-unknown' })
    return
  }
  // hub 已经超时并可能让用户重试过：迟到的指令再执行会跑两遍。
  if (frame.deadline < deadlineNow()) {
    reply({ status: 'rejected', code: 'deadline-expired' })
    return
  }
  const sessionId = frame.target.sessionId
  if (sessionId === null) {
    // v0 的 op 都要求实际会话；create/fork 在 v1 才允许 sessionId: null。
    reply({ status: 'rejected', code: 'session-unknown' })
    return
  }
  let args: ReturnType<typeof parseCommandArgs>
  try {
    args = parseCommandArgs(frame.op, frame.args)
  } catch {
    // 参数不合法就不执行；不能让未校验的 args 进入适配器，也不占用幂等域。
    reply({ status: 'rejected', code: 'invalid-args' })
    return
  }
  if (frame.op === 'observe') {
    const observe = args as ObserveArgs
    if (observe.kind === 'history') {
      // 已验证的 DSH surface 没有只读历史入口；明确拒绝，不能让调用方自己猜。
      reply({ status: 'rejected', code: 'unsupported', result: { reason: 'history-unavailable' } })
      return
    }
    const observer = observerKey(frame)
    if (observe.action === 'subscribe') {
      const subscriptionId = observe.subscriptionId
      if (follower.subscribe(sessionId, subscriptionId, observer) === 'conflict') {
        // 同一 id 已被另一调用者持有：不能把别人的订阅交给当前调用者。
        reply({ status: 'rejected', code: 'conflict' })
        return
      }
      reply({ status: 'accepted', result: { following: true, subscriptionId } })
      return
    }
    const subscriptionId = observe.subscriptionId
    if (!follower.unsubscribe(sessionId, subscriptionId, observer)) {
      // 缺 id 已在参数校验阶段拒绝；未知 id 或非本人持有都按 conflict。
      reply({ status: 'rejected', code: 'conflict' })
      return
    }
    reply({ status: 'accepted', result: { following: false, subscriptionId } })
    return
  }

  // 副作用操作：validate → clock → deadline → journal → 调用 → settle。
  // journal 是硬依赖：没有持久登记就不能产生副作用（也不再有 journal-less 回退）。
  if (Math.abs(binding.serverTimeOffset) > MAX_CLOCK_SKEW_MS) {
    // 偏差过大时期限判断不可信；必须在任何 journal 写入与 agent 调用之前拒绝。
    reply({ status: 'rejected', code: 'clock-skew' })
    return
  }

  const domain: JournalDomain = {
    operatorId: frame.operatorId,
    target: frame.target,
    idempotencyKey: frame.idempotencyKey,
  }
  let digest: string
  let existing: JournalEntry | undefined
  try {
    digest = journal.digestPayload(frame.op, frame.target, args)
    existing = journal.lookup(domain)
  } catch {
    // journal 不可读/已关闭时绝不调用 agent；这不是参数问题，必须转人工恢复。
    reply({ status: 'rejected', code: 'recovery-required' })
    return
  }
  if (existing !== undefined) {
    if (existing.payloadDigest !== digest) {
      reply({ status: 'rejected', code: 'idempotency-conflict' })
      return
    }
    replyExisting(existing)
    return
  }

  // lookup→admit 是同步临界区（无 await），并发同键只可能有一个 admitted 赢家。
  if (frame.deadline < deadlineNow()) {
    reply({ status: 'rejected', code: 'deadline-expired' })
    return
  }
  try {
    journal.admit({ domain, op: frame.op, args })
  } catch (error) {
    // journal 不可写时绝不调用 agent；容量满用 size-limit，其它写失败转人工恢复。
    const code: WireErrorCode = error instanceof JournalError && error.code === 'size-limit'
      ? 'size-limit'
      : 'recovery-required'
    reply({ status: 'rejected', code })
    return
  }
  // 持久化本身也消耗时间：调用前再检查一次，过期命令零调用。
  if (frame.deadline < deadlineNow()) {
    settleAndReply('rejected', 'deadline-expired')
    return
  }

  void adapter.execute({ op: frame.op, target: { sessionId }, args })
    .then(result => settleAndReply(
      // configure 没有已验证的回读时只能是 pending-confirmation（回读由 T06/T07 提供）。
      frame.op === 'configure' ? 'pending-confirmation' : 'accepted',
      undefined,
      result,
    ))
    .catch((error: unknown) => {
      if (error instanceof PreCallRejection) {
        settleAndReply('rejected', error.code)
        return
      }
      // 调用可能已经发生：没有受理/未执行证据时只记 outcome-unknown，绝不报 rejected。
      settleAndReply('outcome-unknown', 'outcome-unknown')
    })

  function replyExisting(entry: JournalEntry): void {
    switch (entry.status) {
      case 'admitted':
        // 同键传输重试：已登记但尚未有结果，等待即可，不能二次调用。
        reply({ status: 'pending-confirmation' })
        return
      case 'accepted':
      case 'confirmed':
        reply({
          status: entry.status,
          ...(entry.code === undefined ? {} : { code: asWireCode(entry.code, 'unsupported') }),
          ...(entry.result === undefined ? {} : { result: entry.result }),
        })
        return
      case 'rejected':
        reply({ status: 'rejected', code: asWireCode(entry.code, 'unsupported') })
        return
      case 'pending-confirmation':
        reply({ status: 'pending-confirmation' })
        return
      case 'outcome-unknown':
        reply({ status: 'outcome-unknown', code: asWireCode(entry.code, 'outcome-unknown') })
        return
    }
  }

  function settleAndReply(status: SettledStatus, code?: WireErrorCode, result?: unknown): void {
    const safe = safeResult(result)
    const settleCode = code ?? safe.code
    try {
      journal.settle(domain, status, settleCode, safe.result)
    } catch {
      // 调用已发生但结果无法持久化：仍必须是 unknown，不能让调用方以为失败可重试。
      reply({ status: 'outcome-unknown', code: 'recovery-required' })
      return
    }
    if (status === 'accepted' || status === 'confirmed') {
      reply({ status, ...(settleCode === undefined ? {} : { code: settleCode }), ...(safe.result === undefined ? {} : { result: safe.result }) })
      return
    }
    reply({ status, ...(code === undefined ? {} : { code }) })
  }
}
