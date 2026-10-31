import {
  encodeFrame, type AckFrame, type CommandStatusResultFrame, type EventFrame, type Frame,
  type WireErrorCode,
} from '../wire/frames.ts'
import { parseCommandArgs, type ConfigureArgs, type ObserveArgs } from '../wire/commands.ts'
import { PreCallRejection, type Adapter } from '../adapters/types.ts'
import type {
  CreateSessionRequest, CreatedSession, ForkSessionRequest, SettingsPort,
} from '../agents/types.ts'
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
    /** 每会话卡片来源代次：结果帧用它标识返回的卡，而不是节点握手代次。 */
    runtimeEpoch(sessionId: string): string
    /** 每会话公开高水位：hub 用它作为该会话的回放/去重底价。 */
    highWatermark(sessionId: string): number
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
  // configure 的真实回读结论必须原样过线，不能被归成 timeout。
  'readback-timeout', 'readback-mismatch', 'settings-unsafe',
])

/** 超过这个偏差就不接受带副作用的命令：期限判断已经不可信。 */
const MAX_CLOCK_SKEW_MS = 60_000

/** v0 Adapter 尚未声明 create/fork；这里只做窄的结构检查，不伪造实现。 */
interface SessionFactoryPorts {
  readonly agent: string
  createSession?(request: CreateSessionRequest, signal: AbortSignal): Promise<CreatedSession>
  forkSession?(request: ForkSessionRequest, signal: AbortSignal): Promise<CreatedSession>
}

function sessionFactoryPorts(adapter: Adapter): SessionFactoryPorts {
  return adapter
}

/** configure 的期望版本串：`<runtimeEpoch>#<revision>`，epoch 自己可以含 `#`。 */
export function formatExpectedRevision(runtimeEpoch: string, revision: number): string {
  return `${runtimeEpoch}#${revision}`
}

/** 只按最后一个 `#` 切分；epoch/revision 都非空且 revision 必须是非负安全整数。 */
export function parseExpectedRevision(value: string): { runtimeEpoch: string; revision: number } | undefined {
  const index = value.lastIndexOf('#')
  if (index <= 0) return undefined
  const runtimeEpoch = value.slice(0, index)
  const rawRevision = value.slice(index + 1)
  if (rawRevision === '' || !/^\d+$/.test(rawRevision)) return undefined
  const revision = Number(rawRevision)
  if (!Number.isSafeInteger(revision) || revision < 0) return undefined
  return { runtimeEpoch, revision }
}

/**
 * v1 适配器的设置端口与实例代次不在 v0 `Adapter` 里；这里只做窄结构访问，
 * 不往基础接口上补可选字段，也不把缺失的端口伪造成可用。
 */
interface SettingsSurface {
  readonly settingsPort?: SettingsPort
  readonly runtimeEpoch?: string
}

function settingsSurface(adapter: Adapter): SettingsSurface {
  const candidate = adapter as unknown as {
    settingsPort?: { configure?: unknown }
    runtimeEpoch?: unknown
  }
  const port = candidate.settingsPort
  const usable = port !== undefined && typeof port.configure === 'function'
  return {
    ...(usable ? { settingsPort: port as SettingsPort } : {}),
    ...(typeof candidate.runtimeEpoch === 'string' && candidate.runtimeEpoch !== ''
      ? { runtimeEpoch: candidate.runtimeEpoch }
      : {}),
  }
}

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

/** 结果只接受普通对象；无 runtimeEpoch 字段的卡沿用结果代次，显式不同的卡必须丢弃。 */
function cardMatchesEpoch(card: unknown, runtimeEpoch: string): boolean {
  if (typeof card !== 'object' || card === null || Array.isArray(card)) return false
  const record = card as Record<string, unknown>
  return record['runtimeEpoch'] === undefined || record['runtimeEpoch'] === runtimeEpoch
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

  const reply = (cards: readonly unknown[], highWatermark: number, runtimeEpoch: string): void => {
    const body = {
      v: 2 as const,
      type: 'inputs.snapshot.result' as const,
      requestId: frame.requestId,
      runtimeEpoch,
      highWatermark,
      cards: [...cards],
    }
    link.sendRaw(encodeFrame(body))
  }

  // 结果代次必须标识卡片来源：v1 每个 agent 有自己的 runtime，不能报节点握手代次。
  const sourceEpoch = runtime?.inputs?.runtimeEpoch(sessionId)
  const runtimeEpoch = typeof sourceEpoch === 'string' && sourceEpoch !== '' ? sourceEpoch : binding.nodeEpoch

  let cards: readonly unknown[] = []
  let highWatermark = 0
  try {
    // 过滤在 reply 之前完成：混入其它 runtime 的卡会让 hub 接受过期内容。
    cards = (runtime?.inputs?.snapshot(sessionId) ?? []).filter(card => cardMatchesEpoch(card, runtimeEpoch))
    highWatermark = runtime?.inputs?.highWatermark(sessionId) ?? 0
  } catch {
    cards = []
    highWatermark = 0
  }
  try {
    reply(cards, highWatermark, runtimeEpoch)
  } catch {
    // 快照编码/发送失败（例如单帧过大）：退回最小结果，不能打挂宿主。
    try { reply([], 0, runtimeEpoch) } catch { /* 连接已断：调用方超时 */ }
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
  if (frame.op === 'create') {
    // create 是 agent 级操作：带具体会话的 create 无法安全解释。
    if (sessionId !== null) {
      reply({ status: 'rejected', code: 'invalid-args' })
      return
    }
  } else if (sessionId === null) {
    // create 之外的 op（含 fork/acquire）都必须指向具体会话。
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
    if (sessionId === null) {
      // 目标校验已经拦下；这里只帮助类型收窄，防御运行期构造。
      reply({ status: 'rejected', code: 'session-unknown' })
      return
    }
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
  // create/fork 没有原生端口时必须在登记 journal 之前拒绝，避免留下无调用证据的 admitted。
  const ports = sessionFactoryPorts(adapter)
  if (frame.op === 'create' && typeof ports.createSession !== 'function') {
    reply({ status: 'rejected', code: 'unsupported', result: { reason: 'capability-unavailable' } })
    return
  }
  if (frame.op === 'fork' && typeof ports.forkSession !== 'function') {
    reply({ status: 'rejected', code: 'unsupported', result: { reason: 'capability-unavailable' } })
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

  const signal = new AbortController().signal
  const invoke = (): Promise<unknown> => {
    if (frame.op === 'create') {
      const create = ports.createSession
      if (typeof create !== 'function') return Promise.reject(new PreCallRejection('unsupported'))
      const cwd = 'cwd' in args ? args.cwd : undefined
      return create({ requestId: frame.commandId, ...(cwd === undefined ? {} : { cwd }) }, signal)
    }
    if (frame.op === 'fork') {
      const fork = ports.forkSession
      if (typeof fork !== 'function') return Promise.reject(new PreCallRejection('unsupported'))
      if (sessionId === null) return Promise.reject(new PreCallRejection('session-unknown'))
      return fork({ requestId: frame.commandId, parentSessionId: sessionId }, signal)
    }
    if (sessionId === null) return Promise.reject(new PreCallRejection('session-unknown'))
    if (frame.op === 'configure') {
      // 设置只能经适配器的真实回读端口；wire args 不能提供可信的 contentAuthorized。
      const surface = settingsSurface(adapter)
      if (surface.settingsPort === undefined) {
        return Promise.reject(new PreCallRejection('unsupported', 'settings-readback-unavailable'))
      }
      const configureArgs = args as ConfigureArgs
      const expected = parseExpectedRevision(configureArgs.expectedRevision)
      if (expected === undefined) return Promise.reject(new PreCallRejection('invalid-args'))
      // DSH 适配器没有实例代次，只能沿用节点握手代次；epoch 不符说明页面看的是旧实例。
      const runtimeEpoch = surface.runtimeEpoch ?? frame.nodeEpoch
      if (expected.runtimeEpoch !== runtimeEpoch) {
        return Promise.reject(new PreCallRejection('stale-connection'))
      }
      return surface.settingsPort.configure({
        sessionId,
        field: configureArgs.field,
        value: configureArgs.value,
        expectedRevision: expected.revision,
        runtimeEpoch,
        contentAuthorized: (runtime?.projector() ?? fallback).content,
      }, signal)
    }
    return adapter.execute({ op: frame.op, target: { sessionId }, args })
  }

  void invoke()
    .then(result => {
      if (frame.op === 'create' || frame.op === 'fork') {
        // 新会话只回传 ID；runtimeEpoch 留在本机，不落 journal、不外发。
        const created = result as { readonly sessionId?: unknown } | null
        if (typeof created !== 'object' || created === null
          || typeof created.sessionId !== 'string' || created.sessionId === '') {
          // 原生调用可能已发生：没有可用新 ID 只能按 unknown 结算，绝不重试或伪造。
          throw new Error('marshal: created session id missing')
        }
        settleAndReply('accepted', undefined, { sessionId: created.sessionId })
        return
      }
      if (frame.op === 'configure') {
        const configured = result as { readonly status?: unknown; readonly code?: unknown } | null
        // 只有端口明确回报 confirmed 才能确认；其余一律留在 pending-confirmation。
        const status: SettledStatus = typeof configured === 'object' && configured !== null
          && configured.status === 'confirmed' ? 'confirmed' : 'pending-confirmation'
        // 回读失败原因必须到达页面；未知字符串不能冒充确定结果，按回读超时处理。
        const code = typeof configured === 'object' && configured !== null
          && typeof configured.code === 'string'
          ? asWireCode(configured.code, 'readback-timeout')
          : undefined
        settleAndReply(status, code, result)
        return
      }
      settleAndReply('accepted', undefined, result)
    })
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

/** 单个 agent 的命令出口：适配器、跟随循环与可选的运行时投影端口。 */
export interface AgentRoute {
  readonly adapter: Adapter
  readonly follower: ReturnType<typeof createFollower>
  readonly runtime?: CommandRuntime
}

/**
 * 按 target.agent 分派命令/状态/待答快照；未知 agent 不落 journal、不调用适配器，
 * 只用本帧的 agent 建一个 metadata 投影器回拒绝。任何发送失败都不得抛回宿主。
 */
export function runRoutedCommand(
  link: NodeLink,
  routes: ReadonlyMap<string, AgentRoute>,
  frame: Frame,
  deviceId: string,
  journal: Journal,
  now: () => number = Date.now,
): void {
  if (frame.type !== 'command' && frame.type !== 'command.status' && frame.type !== 'inputs.snapshot') return
  const route = routes.get(frame.target.agent)
  if (route !== undefined) {
    runCommand(link, route.adapter, route.follower, frame, deviceId, journal, now, route.runtime)
    return
  }
  // 待答快照对未知 agent 只能沉默：hub 超时后按 unknown 收尾。
  if (frame.type === 'inputs.snapshot') return
  const projector = createPrivacyProjector({
    privacy: 'metadata', allowContent: false, questionRelay: 'off', approvalRelay: 'off',
    allowInteractions: false, redaction: [], deviceId, agent: frame.target.agent,
  })
  if (frame.type === 'command.status') {
    const body: CommandStatusResultFrame = {
      v: 2, type: 'command.status.result', requestId: frame.requestId,
      status: 'rejected', code: 'session-unknown',
    }
    try { link.sendRaw(encodeFrame(projector.statusResult(body))) } catch { /* 回不去就等调用方超时 */ }
    return
  }
  const ack: AckFrame = {
    v: 2, type: 'ack', commandId: frame.commandId,
    connectionId: frame.connectionId, nodeEpoch: frame.nodeEpoch,
    status: 'rejected', code: 'session-unknown',
  }
  try { link.sendRaw(encodeFrame(projector.ack(ack))) } catch { /* 回不去就等调用方超时 */ }
}
