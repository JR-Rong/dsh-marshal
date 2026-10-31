import { randomUUID } from 'node:crypto'
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
}

/** 日志只留错误类型：原始 message 可能夹带会话正文或密钥。 */
function errorClass(error: unknown): string {
  return error instanceof Error && error.name !== '' ? error.name : 'error'
}

/**
 * 每会话一条跟随循环；`observe` 指令只启动一次。
 * subscriptionId 由 runner 生成并随订阅绑定到当前连接（link 本身按连接隔离）。
 */
export function createFollower(options: {
  adapter: Adapter
  send: (event: EventFrame) => void
  logger: Pick<LoggerLike, 'warn'>
}) {
  const active = new Map<string, { subscriptionId: string; abort: AbortController }>()
  return {
    start(sessionId: string, subscriptionId: string): boolean {
      if (active.has(sessionId)) return false
      const abort = new AbortController()
      active.set(sessionId, { subscriptionId, abort })
      void (async () => {
        try {
          for await (const event of options.adapter.follow(sessionId, abort.signal)) {
            // 单条事件超限只丢这一条；否则一次过大的 send 会终止整个跟随循环。
            try {
              options.send(event)
            } catch (error) {
              options.logger.warn('marshal: follow ' + sessionId + ' dropped event: ' + errorClass(error))
            }
          }
        } catch (error) {
          if (!abort.signal.aborted) options.logger.warn('marshal: follow ' + sessionId + ' ended: ' + errorClass(error))
        } finally {
          // 只清掉本循环自己登记的条目，避免把重启后的新循环踢出 map。
          if (active.get(sessionId)?.abort === abort) active.delete(sessionId)
        }
      })()
      return true
    },
    stop(sessionId: string, subscriptionId: string): boolean {
      const entry = active.get(sessionId)
      if (entry === undefined || entry.subscriptionId !== subscriptionId) return false
      entry.abort.abort()
      active.delete(sessionId)
      return true
    },
    has(sessionId: string): boolean { return active.has(sessionId) },
    stopAll(): void {
      for (const entry of active.values()) entry.abort.abort()
      active.clear()
    },
  }
}

/** 只允许 spec 定义的 wire 错误码过线；其余（`marshal: …`、`Error: …`）一律归为 agent-crashed。 */
const WIRE_CODES: ReadonlySet<string> = new Set([
  'session-unknown', 'invalid-args', 'unsupported', 'device-mismatch', 'agent-crashed', 'result-too-large',
  'unknown', 'invalid', 'session-mismatch', 'tighten-only', 'deadline-expired',
  'stale-connection', 'clock-skew',
])

/** 超过这个偏差就不接受带副作用的命令：期限判断已经不可信。 */
const MAX_CLOCK_SKEW_MS = 60_000

/** 错误前缀即 wire 错误码：`session-unknown: ...` 或 `marshal: session-unknown: ...` → `session-unknown`。 */
function codeOf(error: unknown): WireErrorCode {
  const message = error instanceof Error ? error.message : String(error)
  const code = /^marshal: ([a-z][a-z-]*):/.exec(message)?.[1]
    ?? /^([a-z][a-z-]*):/.exec(message)?.[1]
  return code !== undefined && WIRE_CODES.has(code) ? code as WireErrorCode : 'agent-crashed'
}

/** 只允许已声明的 wire 错误码过线；journal 里的 code 可能来自旧版本。 */
function asWireCode(code: string | undefined, fallback: WireErrorCode): WireErrorCode {
  return code !== undefined && WIRE_CODES.has(code) ? code as WireErrorCode : fallback
}

function entryStatus(entry: JournalEntry): AckFrame['status'] {
  // admitted 表示已持久登记、尚未拿到结果；对查询方只能诚实回答 unknown。
  return entry.status === 'admitted' ? 'outcome-unknown' : entry.status
}

/** subscriptionId 由 runner 生成，按会话存放；link 每连接一个，因此状态天然绑定连接。 */
const subscriptions = new WeakMap<ReturnType<typeof createFollower>, Map<string, string>>()

function subscriptionsOf(follower: ReturnType<typeof createFollower>): Map<string, string> {
  let map = subscriptions.get(follower)
  if (map === undefined) { map = new Map(); subscriptions.set(follower, map) }
  return map
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
      // 历史读取由适配器实现（T05）；当前适配器会明确返回 unsupported，不能静默改成跟随。
      void adapter.execute({ op: 'observe', target: { sessionId }, args: observe })
        .then(result => reply({ status: 'accepted', result }))
        .catch((error: unknown) => reply({ status: 'rejected', code: codeOf(error) }))
      return
    }
    const map = subscriptionsOf(follower)
    if (observe.action === 'subscribe') {
      const existing = map.get(sessionId)
      if (existing !== undefined && follower.has(sessionId)) {
        // 同一连接对同一会话重复订阅是幂等的：返回已有订阅，不启动第二条跟随循环。
        reply({ status: 'accepted', result: { following: true, subscriptionId: existing } })
        return
      }
      // 跟随循环已自然结束（例如会话终止）：旧 id 作废，重新签发。
      if (existing !== undefined) map.delete(sessionId)
      const subscriptionId = randomUUID()
      if (!follower.start(sessionId, subscriptionId)) {
        reply({ status: 'rejected', code: 'conflict' })
        return
      }
      map.set(sessionId, subscriptionId)
      reply({ status: 'accepted', result: { following: true, subscriptionId } })
      return
    }
    const subscriptionId = observe.subscriptionId
    if (subscriptionId === undefined
      || map.get(sessionId) !== subscriptionId
      || !follower.stop(sessionId, subscriptionId)) {
      reply({ status: 'rejected', code: 'conflict' })
      return
    }
    map.delete(sessionId)
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
