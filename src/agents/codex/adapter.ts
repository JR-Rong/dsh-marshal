import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  PreCallRejection,
  type Capability, type Operation, type SnapshotCompleteness,
  type SyncSnapshot, type Tunable,
} from '../../adapters/types.ts'
import type { EventFrame } from '../../wire/frames.ts'
import {
  AgentUnavailableError,
  type AgentAdapter, type AgentHealth, type AgentListResult, type AgentState,
  type ControlResult, type CreatedSession, type CreateSessionRequest, type ForkSessionRequest,
  type HistoryPage, type HistoryRequest, type InterruptRequest, type NativeInputPort,
  type OwnershipPort, type ProbeResult, type PromptRequest, type RelayPolicy,
  type SteerRequest, type UnavailableCause,
} from '../types.ts'
import { createOwnershipCoordinator, OwnershipError, type OwnershipCoordinator } from '../ownership.ts'
import { createSupervisor, type SpawnFn, type Supervisor, type SupervisorExitReason } from '../supervisor.ts'
import { classifyCodexServerRequest, codexResponseFor } from './approvals.ts'
import { resolveCodexBinary, type CodexBinaryResolution } from './binary.ts'
import { listAllThreads, listTurnsPage, threadRow, type CodexRequest } from './discover.ts'
import {
  notificationThreadId, toCodexEvents, turnToEvents, type CodexEventMeta,
} from './map.ts'
import {
  CodexPeerError, createCodexPeer, type CodexPeer, type CodexServerResponse,
} from './peer.ts'
import {
  CODEX_CLIENT_INFO, CODEX_KNOWN_NOTIFICATIONS,
  parseInitializeResponse, parseThread, parseThreadListResponse, parseThreadRefResponse,
  parseThreadStatus, parseTurn, parseTurnStartResponse, parseVersionFromUserAgent,
  supportsVersion, threadRunning,
} from './protocol.ts'
import { createCodexSessionRegistry } from './session.ts'
import { CODEX_SETTINGS_CATALOG, createCodexSettingsPort } from './settings.ts'
import { buildTunables } from '../../tunables/catalog.ts'

/**
 * Codex 基础适配器（app-server over stdio）。
 *
 * 安全边界：
 * - 外部会话只读；`acquire` 对未受管会话返回 ownership-unverified，绝不 resume 冒领。
 * - 只有本实例 create/fork 出来的会话才进入 managed 集合；取得写权后再 turn/start。
 * - steer 未经验证，保持关闭；interrupt 必须带 runtimeEpoch + 已绑定 turnId。
 * - 所有副作用调用只发一次；超时/断连不做任何自动重发。
 */

const CAPABILITY_REVISION = 1
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000
const DEFAULT_PROBE_TIMEOUT_MS = 10_000

const CODEX_TUNABLES: readonly Tunable[] = [
  { id: 'model', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
  { id: 'reasoning', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
  { id: 'permission', scope: 'next-session', effect: 'next-session', direction: 'tighten-only', editable: false, reason: 'settings-readback-unavailable' },
  { id: 'plan', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
  { id: 'goal', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
  { id: 'skill', scope: 'host', effect: 'needs-restart', editable: false, reason: 'host-config' },
  { id: 'plugin', scope: 'host', effect: 'needs-restart', editable: false, reason: 'host-config' },
]

export interface CodexAdapterOptions {
  readonly deviceId: string
  readonly nodeEpoch: string
  /** 必须显式给出；适配器不默认 remote。 */
  readonly questionRelay: RelayPolicy
  readonly approvalRelay: RelayPolicy
  /** node 统一中继；缺失时审批只能本地拒绝。 */
  readonly inputRelay?: NativeInputPort
  /** 覆盖入口解析（测试/装配注入）；不提供时按显式路径或 PATH 解析。 */
  readonly binary?: CodexBinaryResolution
  readonly explicitPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly runtimeEpoch?: string
  readonly now?: () => number
  readonly spawn?: SpawnFn
  readonly platform?: NodeJS.Platform
  readonly requestTimeoutMs?: number
  readonly handshakeTimeoutMs?: number
  readonly probeTimeoutMs?: number
  /** node privacy=content 且 hub allowContent 同时成立时才允许展示设置内容。 */
  readonly contentAuthorized?: () => boolean
}

interface PeerEntry {
  readonly generation: number
  readonly peer: CodexPeer
  readonly detach: () => void
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 原生请求所属会话；缺失/非法时不能交给中继，只能按协议拒绝。 */
function requestThreadId(params: unknown): string | undefined {
  const threadId = asRecord(params)?.threadId
  return typeof threadId === 'string' && threadId !== '' ? threadId : undefined
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** JSON-RPC 错误意味着原生调用没有被受理；映射成无副作用的调用前拒绝。 */
function rpcRejection(error: CodexPeerError): PreCallRejection {
  switch (error.rpcCode) {
    case -32602: return new PreCallRejection('invalid-args')
    case -32601: return new PreCallRejection('unsupported')
    default: return new PreCallRejection('conflict')
  }
}

function parseEmptyResponse(value: unknown): true | undefined {
  // turn/interrupt 的合法响应可能是 `{}`/`null`；只有缺失结果才算协议错误。
  return value === undefined ? undefined : true
}

export function createCodexAdapter(options: CodexAdapterOptions): AgentAdapter {
  const now = options.now ?? Date.now
  const runtimeEpoch = options.runtimeEpoch ?? `${options.nodeEpoch}:codex:${randomUUID()}`
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const binary = options.binary ?? resolveCodexBinary({
    ...(options.explicitPath === undefined ? {} : { explicitPath: options.explicitPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  })

  const sessions = createCodexSessionRegistry()
  const coordinator: OwnershipCoordinator = createOwnershipCoordinator({
    runtimeEpoch,
    holder: runtimeEpoch,
    now,
  })
  const seqs = new Map<string, number>()
  let completeness: SnapshotCompleteness = 'unconfirmed'
  let phase: AgentState = 'starting'
  let lastProbe: ProbeResult | undefined
  let lastVersion: string | undefined
  let peerEntry: PeerEntry | undefined
  let startup: Promise<CodexPeer> | undefined
  let stopping = false
  /** 正在等待中继决定的原生审批；连接关闭/停止时一次性 abort，留下原生等待会挂死 agent。 */
  const pendingApprovals = new Set<AbortController>()

  const abortPendingApprovals = (): void => {
    for (const controller of pendingApprovals) controller.abort()
    pendingApprovals.clear()
  }

  const nextSeq = (sessionId: string): number => {
    const next = (seqs.get(sessionId) ?? 0) + 1
    seqs.set(sessionId, next)
    return next
  }

  const frame = (sessionId: string, kind: EventFrame['kind'], payload: unknown): EventFrame => ({
    v: 2, type: 'event', deviceId: options.deviceId, agent: 'codex', sessionId,
    nodeEpoch: options.nodeEpoch, seq: nextSeq(sessionId), ts: now(), kind, payload,
  })

  const closePeer = (): void => {
    abortPendingApprovals()
    const entry = peerEntry
    if (entry === undefined) return
    peerEntry = undefined
    entry.detach()
    entry.peer.close()
  }

  const supervisor: Supervisor = createSupervisor({
    command: binary.entry?.command ?? 'codex',
    args: binary.entry?.args ?? [],
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    classify: (error: unknown) => {
      if (error instanceof AgentUnavailableError) {
        if (error.unavailable.reason === 'version-unsupported'
          || error.unavailable.reason === 'protocol-unsupported') return 'terminal'
        if (error.unavailable.reason === 'auth-required'
          || error.unavailable.reason === 'config-invalid'
          || error.unavailable.reason === 'not-installed') return 'config'
      }
      return 'retryable'
    },
    onExit: (_generation: number, reason: SupervisorExitReason) => {
      closePeer()
      // 进程退出/重启即丢失受管身份与写权证据；重启不会恢复控制。
      sessions.clear()
      coordinator.clear()
      // peer 断开后旧回读不再可信；端口本身保持可用，等新连接重建。
      settings.reset()
      lastVersion = undefined
      if (!stopping && reason !== 'stopped') phase = 'unavailable'
    },
    // 有受管会话时保守地不允许 idle 回收；活跃回合由 coordinator 另行阻止。
    busy: () => sessions.managedIds().length > 0,
  })

  const request: CodexRequest = async (method, params, signal, parse) => {
    const peer = await ensurePeer(signal)
    return await peer.request(method, params, signal, parse)
  }

  /**
   * 设置回读变化后重新发布会话能力。回调只会在初始化完成后触发，
   * 因此可以引用后面声明的 buildSessionCapability。
   */
  const publishCapability = (sessionId: string): void => {
    sessions.publish(sessionId, frame(
      sessionId, 'capability.changed',
      capabilityPayload(buildSessionCapability(sessionId)),
    ))
  }

  const settings = createCodexSettingsPort({
    request,
    runtimeEpoch,
    writable: id => sessions.isManaged(id) && coordinator.ownership(id) === 'ours',
    idle: id => coordinator.state(id) === 'ours-idle',
    beginConfigure: id => coordinator.beginConfigure(id),
    endConfigure: id => coordinator.endConfigure(id),
    onChanged: publishCapability,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const relayEnabled = (): boolean => options.inputRelay !== undefined
    && (options.questionRelay === 'remote' || options.approvalRelay === 'remote')

  /** 只有本实例受管且当前持有写权的会话才能把原生等待交给中继。 */
  const relayable = (sessionId: string): boolean => !stopping
    && options.inputRelay !== undefined
    && sessions.isManaged(sessionId)
    && coordinator.ownership(sessionId) === 'ours'

  const handleServerRequest = async (request: {
    readonly method: string
    readonly params: unknown
  }): Promise<CodexServerResponse> => {
    const classification = classifyCodexServerRequest(request.method, request.params)
    if (classification.kind === 'response') return classification.response

    const threadId = requestThreadId(request.params)
    const relay = options.inputRelay
    if (threadId === undefined || relay === undefined || !relayable(threadId)) {
      return codexResponseFor(request.method, request.params, { decision: 'decline' })
    }

    const controller = new AbortController()
    pendingApprovals.add(controller)
    try {
      // 0.166.0 审批不带原生期限，不传 nativeExpiry。
      const decision = await relay.claim({
        kind: 'approval',
        sessionId: threadId,
        runtimeEpoch,
        approval: classification.approval,
      }, controller.signal)
      return codexResponseFor(request.method, request.params, decision)
    } catch {
      // 中继异常只影响本次决定；原生端必须收到明确的拒绝而不是被挂起。
      return codexResponseFor(request.method, request.params, { decision: 'decline' })
    } finally {
      pendingApprovals.delete(controller)
    }
  }

  const bindTurnFromNotification = (sessionId: string, params: unknown): void => {
    const record = asRecord(params)
    const turn = parseTurn(record?.turn)
    if (turn === undefined) return
    const state = coordinator.state(sessionId)
    if (state !== 'ours-running') return
    if (coordinator.turn(sessionId) !== undefined) return
    try {
      coordinator.bindTurn(sessionId, turn.id)
    } catch {
      // 晚到/冲突的绑定不能覆盖当前回合；后续 turn/start 响应会自行核对。
    }
  }

  const handleNotification = (method: string, params: unknown): void => {
    const sessionId = notificationThreadId(method, params)
    if (sessionId === undefined) return
    const record = asRecord(params)

    if (method === 'thread/started') {
      const thread = parseThread(record?.thread)
      if (thread !== undefined) {
        coordinator.noteObserved(thread.id, threadRunning(thread))
      }
    } else if (method === 'thread/status/changed') {
      const status = parseThreadStatus(record?.status)
      if (status !== undefined) coordinator.noteObserved(sessionId, status.type === 'active')
    } else if (method === 'turn/started') {
      coordinator.noteObserved(sessionId, true)
      bindTurnFromNotification(sessionId, params)
    } else if (method === 'turn/completed') {
      const turn = parseTurn(asRecord(params)?.turn)
      if (turn !== undefined) coordinator.endTurn(sessionId, turn.id)
      coordinator.noteObserved(sessionId, false)
    }

    // 设置/goal 通知只更新长期 current，没有版次也不是 pending 的确认来源。
    if (method === 'thread/settings/updated'
      || method === 'thread/goal/updated'
      || method === 'thread/goal/cleared') {
      settings.observeNotification(method, params)
    }

    const meta: CodexEventMeta = {
      deviceId: options.deviceId,
      agent: 'codex',
      nodeEpoch: options.nodeEpoch,
      sessionId,
    }
    for (const event of toCodexEvents(method, params, meta, () => nextSeq(sessionId), {
      runtimeEpoch,
      ownership: coordinator.ownership(sessionId),
    })) {
      sessions.publish(sessionId, event)
    }
  }

  const openPeer = async (generation: number): Promise<CodexPeer> => {
    const transport = supervisor.transport()
    if (transport === undefined || transport.generation !== generation
      || transport.stdin === null || transport.stdout === null) {
      throw new AgentUnavailableError({ reason: 'start-failed' })
    }
    const stdin = transport.stdin
    const stdout = transport.stdout
    const peer = createCodexPeer({
      write: line => {
        if (!stdin.writable) throw new Error('codex stdin closed')
        stdin.write(line + '\n')
      },
      knownNotifications: CODEX_KNOWN_NOTIFICATIONS,
      requestTimeoutMs,
      onNotification: handleNotification,
      onServerRequest: handleServerRequest,
    })
    const onData = (chunk: unknown): void => {
      if (typeof chunk === 'string') peer.handle(chunk)
      else if (chunk instanceof Uint8Array) peer.handle(Buffer.from(chunk))
    }
    stdout.on('data', onData)
    const entry: PeerEntry = {
      generation,
      peer,
      detach: () => { stdout.removeListener('data', onData) },
    }
    peerEntry = entry

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), handshakeTimeoutMs)
    timer.unref()
    try {
      const initialized = await peer.request(
        'initialize',
        { clientInfo: CODEX_CLIENT_INFO },
        controller.signal,
        parseInitializeResponse,
      )
      const version = parseVersionFromUserAgent(initialized.userAgent)
      if (!supportsVersion(version)) {
        throw new AgentUnavailableError({ reason: 'version-unsupported' })
      }
      peer.notify('initialized')
      // 能力自检：能列出一页即证明 thread/list 可用；不是全量快照。
      await peer.request('thread/list', { limit: 1 }, controller.signal, parseThreadListResponse)
      if (!supervisor.isCurrent(generation)) {
        throw new AgentUnavailableError({ reason: 'start-failed' })
      }
      lastVersion = version
      supervisor.markReady()
      phase = 'ready'
      return peer
    } catch (error) {
      if (peerEntry?.peer === peer) {
        peerEntry = undefined
        entry.detach()
      }
      peer.close()
      if (error instanceof AgentUnavailableError) {
        // 版本/协议错误不循环重启，交由监督器进入 failed。
        supervisor.fail(error)
        throw error
      }
      if (controller.signal.aborted) {
        throw new AgentUnavailableError({ reason: 'start-failed' })
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function ensurePeer(signal: AbortSignal): Promise<CodexPeer> {
    if (stopping) throw new AgentUnavailableError({ reason: 'stopped' })
    if (signal.aborted) throw signal.reason
    const existing = peerEntry
    if (existing !== undefined && !existing.peer.closed && supervisor.isCurrent(existing.generation)) {
      return existing.peer
    }
    if (startup !== undefined) return await withSignal(startup, signal)
    if (!binary.ok) {
      throw new AgentUnavailableError({ reason: binary.reason ?? 'not-installed' })
    }
    const health = supervisor.health()
    if (health.state === 'failed' || health.state === 'stopped') {
      throw new AgentUnavailableError({ reason: health.reason?.reason ?? 'start-failed' })
    }
    if (supervisor.transport() === undefined) {
      if (!supervisor.start()) {
        const after = supervisor.health()
        throw new AgentUnavailableError({ reason: after.reason?.reason ?? 'start-failed' })
      }
    }
    const generation = supervisor.generation
    startup = openPeer(generation).finally(() => { startup = undefined })
    return await withSignal(startup, signal)
  }

  /** 控制路径在发送前失败没有副作用；转换为 agent-crashed 而不是伪造 rejected 副作用。 */
  async function ensurePeerForControl(signal: AbortSignal): Promise<CodexPeer> {
    try {
      return await ensurePeer(signal)
    } catch (error) {
      if (error instanceof AgentUnavailableError) throw new PreCallRejection('agent-crashed')
      throw error
    }
  }

  const buildAgentCapability = (): Capability => {
    const operations = new Set<Operation>(['create', 'fork'])
    const unavailable: Record<string, string> = {
      prompt: 'ownership-unverified',
      interrupt: 'ownership-unverified',
      acquire: 'ownership-unverified',
      configure: 'settings-readback-unavailable',
    }
    if (relayEnabled()) {
      operations.add('answer')
      operations.add('cancel')
    } else {
      unavailable.answer = 'interaction-relay-unavailable'
      unavailable.cancel = 'interaction-relay-unavailable'
    }
    return {
      observe: { history: true, follow: 'stream' },
      operations,
      ownership: 'foreign-unknown',
      reasoning: true,
      toolDetail: 'args+output',
      promptFidelity: 'native',
      tunables: CODEX_TUNABLES,
      unavailable,
      settingsRevision: 0,
      runtimeEpoch,
    }
  }

  const buildSessionCapability = (sessionId: string): Capability => {
    const ownership = coordinator.ownership(sessionId)
    const owns = ownership === 'ours'
    const managed = sessions.isManaged(sessionId)
    const snapshot = settings.snapshot(sessionId)
    const operations = new Set<Operation>(['create', 'fork'])
    const unavailable: Record<string, string> = {}
    // 外部/未管理的会话永远没有可答卡，能力里也不能暴露 answer/cancel。
    if (relayEnabled() && owns && managed) {
      operations.add('answer')
      operations.add('cancel')
    } else {
      unavailable.answer = 'interaction-relay-unavailable'
      unavailable.cancel = 'interaction-relay-unavailable'
    }
    if (owns) {
      operations.add('prompt')
      if (coordinator.turn(sessionId) === undefined) {
        unavailable.interrupt = 'no-atomic-turn-binding'
      } else {
        operations.add('interrupt')
      }
    } else if (managed) {
      unavailable.prompt = 'session-not-owned'
      unavailable.interrupt = 'session-not-owned'
    } else {
      unavailable.prompt = 'ownership-unverified'
      unavailable.interrupt = 'ownership-unverified'
      unavailable.acquire = 'ownership-unverified'
    }
    // Codex 的 acquire 只对受管会话有效；未受管会话保持 ownership-unverified。
    if (managed) {
      operations.add('acquire')
      delete unavailable.acquire
    }
    // 只有受管、写权属于本实例且回读未闩锁时才宣传 configure。
    if (managed && owns && snapshot?.unsafe !== true) {
      operations.add('configure')
      delete unavailable.configure
    } else if (snapshot?.unsafe === true) {
      unavailable.configure = 'settings-unsafe'
    } else if (managed && !owns) {
      unavailable.configure = 'session-not-owned'
    } else {
      unavailable.configure = 'ownership-unverified'
    }
    const pending = snapshot?.pending
    return {
      observe: { history: true, follow: 'stream' },
      operations,
      ownership,
      reasoning: true,
      toolDetail: 'args+output',
      promptFidelity: 'native',
      tunables: buildTunables(CODEX_SETTINGS_CATALOG, snapshot?.current, {
        contentAuthorized: options.contentAuthorized?.() === true,
      }),
      unavailable,
      settingsRevision: snapshot?.current.revision ?? 0,
      runtimeEpoch,
      ...(pending === undefined
        ? {}
        : {
            pending: {
              field: pending.field,
              status: pending.status === 'pending' ? 'pending' as const : 'readback-timeout' as const,
            },
          }),
    }
  }

  const capabilityPayload = (capability: Capability): Record<string, unknown> => ({
    observe: { history: capability.observe.history, follow: capability.observe.follow },
    operations: [...capability.operations],
    ownership: capability.ownership,
    reasoning: capability.reasoning,
    toolDetail: capability.toolDetail,
    promptFidelity: capability.promptFidelity,
    tunables: capability.tunables,
    ...(capability.unavailable === undefined ? {} : { unavailable: capability.unavailable }),
    settingsRevision: capability.settingsRevision ?? 0,
    runtimeEpoch: capability.runtimeEpoch ?? runtimeEpoch,
    ...(capability.pending === undefined
      ? {}
      : { pending: { field: capability.pending.field, status: capability.pending.status } }),
    revision: CAPABILITY_REVISION,
    readAt: now(),
  })

  const list = async (signal: AbortSignal): Promise<AgentListResult> => {
    const discovery = await listAllThreads(request, signal)
    for (const thread of discovery.threads) {
      coordinator.noteObserved(thread.id, threadRunning(thread))
    }
    completeness = discovery.complete ? 'complete' : 'unconfirmed'
    return { rows: discovery.threads.map(threadRow), completeness }
  }

  const syncSnapshot = async (signal: AbortSignal): Promise<SyncSnapshot> => {
    const listed = await list(signal)
    return {
      rows: listed.rows,
      capabilities: [{ agent: 'codex', capability: capabilityPayload(buildAgentCapability()) }],
      completeness: listed.completeness,
    }
  }

  const promptSession = async (
    sessionId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<ControlResult> => {
    // beginPrompt 在第一个 await 之前置 busy：并发第二次写入立即被拒。
    coordinator.beginPrompt(sessionId)
    let peer: CodexPeer
    try {
      peer = await ensurePeerForControl(signal)
    } catch (error) {
      coordinator.endTurn(sessionId)
      throw error
    }
    try {
      const response = await peer.request('turn/start', {
        threadId: sessionId,
        input: [{ type: 'text', text }],
      }, signal, parseTurnStartResponse)
      const turnId = response.turn.id
      if (turnId === '') {
        coordinator.endTurn(sessionId)
        throw new Error('marshal: codex turn id missing')
      }
      coordinator.bindTurn(sessionId, turnId)
      return { accepted: true, runtimeEpoch, turnId }
    } catch (error) {
      if (error instanceof CodexPeerError) {
        if (error.code === 'rpc') {
          // 原生明确拒绝：没有受理证据，可以安全清除 busy。
          coordinator.endTurn(sessionId)
          throw rpcRejection(error)
        }
        if (error.code === 'busy') {
          // pending 已满：请求尚未写出，不可能产生回合。
          coordinator.endTurn(sessionId)
          throw error
        }
      }
      // write/closed/timeout/aborted/协议错误：无法证明未写出或未受理，保持 busy 直到事件结算。
      throw error
    }
  }

  const interruptSession = async (
    sessionId: string,
    requestedTurnId: string | undefined,
    requestedEpoch: string,
    signal: AbortSignal,
  ): Promise<ControlResult> => {
    if (requestedEpoch !== runtimeEpoch) throw new PreCallRejection('stale-connection')
    const turnId = requestedTurnId ?? coordinator.turn(sessionId)
    if (turnId === undefined) throw new PreCallRejection('stale-connection', 'turn-unbound')
    // authorizeControl 只允许当前 runtimeEpoch 绑定的活动回合。
    coordinator.authorizeControl(sessionId, turnId)
    const peer = await ensurePeerForControl(signal)
    try {
      await peer.request('turn/interrupt', { threadId: sessionId, turnId }, signal, parseEmptyResponse)
    } catch (error) {
      if (error instanceof CodexPeerError && error.code === 'rpc') throw rpcRejection(error)
      throw error
    }
    return { accepted: true, runtimeEpoch, turnId }
  }

  const ownershipPort: OwnershipPort = {
    async acquire(sessionId, signal) {
      if (!sessions.isManaged(sessionId)) {
        // 外部会话没有排他证据：resume 成功也不等于取得写权。
        throw new OwnershipError('ownership-unverified')
      }
      return await coordinator.acquire(sessionId, async context => {
        const peer = await ensurePeer(context.signal)
        const response = await peer.request('thread/resume', {
          threadId: sessionId,
          excludeTurns: true,
        }, context.signal, parseThreadRefResponse)
        if (response.thread.id !== sessionId) return undefined
        return {
          sessionId,
          mechanism: 'managed-thread',
          holder: coordinator.holder,
          runtimeEpoch,
          acquiredAt: now(),
          invalidatesOn: ['process-exit', 'peer-close', 'plugin-reload', 'journal-recovery'],
        }
      }, { signal })
    },
    async release(sessionId) {
      coordinator.release(sessionId)
    },
    ownership(sessionId) {
      return coordinator.ownership(sessionId)
    },
    evidence(sessionId) {
      return coordinator.evidence(sessionId)
    },
    controlReason(sessionId) {
      return coordinator.controlReason(sessionId)
    },
  }

  const observe = (sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame> => {
    return (async function* (): AsyncIterable<EventFrame> {
      // 观察同样需要 app-server 运行；启动它不产生会话副作用。
      await ensurePeer(signal)
      yield* sessions.observe(sessionId, signal)
    })()
  }

  const adapter: AgentAdapter = {
    agent: 'codex',
    runtimeEpoch,

    capabilities(sessionId: string): Capability {
      return buildSessionCapability(sessionId)
    },

    get snapshotCompleteness(): SnapshotCompleteness {
      return completeness
    },

    async probe(signal: AbortSignal): Promise<ProbeResult> {
      const at = now()
      if (!binary.ok) {
        const result: ProbeResult = {
          ok: false,
          at,
          runtimeEpoch,
          unavailable: { reason: binary.reason ?? 'not-installed' },
        }
        lastProbe = result
        return result
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), probeTimeoutMs)
      timer.unref()
      const combined = AbortSignal.any([signal, controller.signal])
      try {
        await ensurePeer(combined)
        await request('thread/list', { limit: 1 }, combined, parseThreadListResponse)
        const result: ProbeResult = {
          ok: true,
          at,
          runtimeEpoch,
          ...(lastVersion === undefined ? {} : { version: lastVersion }),
          capability: buildAgentCapability(),
        }
        lastProbe = result
        return result
      } catch (error) {
        const reason: UnavailableCause['reason'] = error instanceof AgentUnavailableError
          ? error.unavailable.reason
          : controller.signal.aborted ? 'probe-timeout'
          : error instanceof CodexPeerError && error.code === 'timeout' ? 'probe-timeout'
          : 'probe-failed'
        const result: ProbeResult = {
          ok: false,
          at,
          runtimeEpoch,
          ...(lastVersion === undefined ? {} : { version: lastVersion }),
          unavailable: { reason },
        }
        lastProbe = result
        return result
      } finally {
        clearTimeout(timer)
      }
    },

    async start(signal: AbortSignal): Promise<void> {
      await ensurePeer(signal)
    },

    async stop(): Promise<void> {
      stopping = true
      closePeer()
      abortPendingApprovals()
      sessions.clear()
      coordinator.clear()
      // 停止后不再提供设置端口；onExit 的 reset 在 dispose 之后是幂等的。
      settings.dispose()
      await supervisor.stop()
      phase = 'stopped'
    },

    health(): AgentHealth {
      const supervisorHealth = supervisor.health()
      const state: AgentState = stopping || supervisorHealth.state === 'stopped'
        ? 'stopped'
        : supervisorHealth.state === 'failed' ? 'failed'
        : phase === 'ready' && supervisorHealth.state === 'running' ? 'ready'
        : 'unavailable'
      return {
        agent: 'codex',
        runtimeEpoch,
        state,
        updatedAt: now(),
        ...(supervisorHealth.reason === undefined ? {} : { unavailable: supervisorHealth.reason }),
        ...(lastProbe === undefined ? {} : { lastProbe }),
        restarts: supervisorHealth.restarts,
      }
    },

    list,

    async history(historyRequest: HistoryRequest, signal: AbortSignal): Promise<HistoryPage> {
      const page = await listTurnsPage(request, {
        threadId: historyRequest.sessionId,
        ...(historyRequest.cursor === undefined ? {} : { cursor: historyRequest.cursor }),
        ...(historyRequest.limit === undefined ? {} : { limit: historyRequest.limit }),
      }, signal)
      const meta: CodexEventMeta = {
        deviceId: options.deviceId,
        agent: 'codex',
        nodeEpoch: options.nodeEpoch,
        sessionId: historyRequest.sessionId,
      }
      const items: EventFrame[] = []
      for (const turn of page.turns) {
        items.push(...turnToEvents(turn, meta, () => nextSeq(historyRequest.sessionId), {
          runtimeEpoch,
          ownership: coordinator.ownership(historyRequest.sessionId),
        }))
      }
      return {
        items,
        completeness: page.complete ? 'complete' : 'unconfirmed',
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      }
    },

    observe,

    follow(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame> {
      return (async function* (): AsyncIterable<EventFrame> {
        await ensurePeer(signal)
        // 先给订阅者一份当前能力（含 settingsRevision/runtimeEpoch/pending），
        // 再流式转发后续事件；observe 本身保持只读语义不变。
        yield frame(sessionId, 'capability.changed', capabilityPayload(buildSessionCapability(sessionId)))
        yield* sessions.observe(sessionId, signal)
      })()
    },

    frame,
    nextSeq,

    async syncSnapshot(signal: AbortSignal): Promise<SyncSnapshot> {
      return await syncSnapshot(signal)
    },

    async snapshot(signal: AbortSignal): Promise<EventFrame[]> {
      const listed = await syncSnapshot(signal)
      const events: EventFrame[] = []
      for (const row of listed.rows) {
        events.push(frame(row.sessionId, 'session.updated', {
          running: row.running,
          updatedAt: row.updatedAt,
          blank: row.blank,
          ownership: coordinator.ownership(row.sessionId),
        }))
        // 会话级能力必须带该会话自己的所有权，不能复用 agent 级文档。
        events.push(frame(
          row.sessionId,
          'capability.changed',
          capabilityPayload(buildSessionCapability(row.sessionId)),
        ))
      }
      return events
    },

    async prompt(promptRequest: PromptRequest, signal: AbortSignal): Promise<ControlResult> {
      if (promptRequest.runtimeEpoch !== runtimeEpoch) throw new PreCallRejection('stale-connection')
      return await promptSession(promptRequest.sessionId, promptRequest.text, signal)
    },

    async steer(_steerRequest: SteerRequest, _signal: AbortSignal): Promise<ControlResult> {
      // 运行时 steer 的 expectedTurnId 语义尚未在目标机验证；保持关闭而不是悄悄入队。
      throw new PreCallRejection('unsupported', 'native-steer-unverified')
    },

    async interrupt(interruptRequest: InterruptRequest, signal: AbortSignal): Promise<ControlResult> {
      return await interruptSession(
        interruptRequest.sessionId,
        interruptRequest.turnId,
        interruptRequest.runtimeEpoch,
        signal,
      )
    },

    async createSession(createRequest: CreateSessionRequest, signal: AbortSignal): Promise<CreatedSession> {
      const cwd = createRequest.cwd
      if (cwd !== undefined && !isAbsolute(cwd)) throw new PreCallRejection('invalid-args')
      const peer = await ensurePeerForControl(signal)
      try {
        const response = await peer.request('thread/start', {
          ...(cwd === undefined ? {} : { cwd }),
        }, signal, parseThreadRefResponse)
        const sessionId = response.thread.id
        if (sessionId === '') throw new Error('marshal: codex thread id missing')
        sessions.markManaged(sessionId)
        return { sessionId, runtimeEpoch }
      } catch (error) {
        if (error instanceof CodexPeerError && error.code === 'rpc') throw rpcRejection(error)
        throw error
      }
    },

    async forkSession(forkRequest: ForkSessionRequest, signal: AbortSignal): Promise<CreatedSession> {
      const parentSessionId = forkRequest.parentSessionId
      if (parentSessionId === '') throw new PreCallRejection('session-unknown')
      const peer = await ensurePeerForControl(signal)
      // 父会话存在性是调用前校验；清单不完整时交给原生 fork 裁定。
      const discovery = await listAllThreads(request, signal)
      if (discovery.complete && !discovery.threads.some(thread => thread.id === parentSessionId)) {
        throw new PreCallRejection('session-unknown')
      }
      try {
        const response = await peer.request('thread/fork', {
          threadId: parentSessionId,
          excludeTurns: true,
        }, signal, parseThreadRefResponse)
        const sessionId = response.thread.id
        if (sessionId === '' || sessionId === parentSessionId) {
          // 新身份缺失/未变化：原生调用已经发生，不能伪装成 rejected。
          throw new Error('marshal: codex fork identity missing')
        }
        sessions.markManaged(sessionId)
        return { sessionId, runtimeEpoch, parentSessionId }
      } catch (error) {
        if (error instanceof CodexPeerError && error.code === 'rpc') throw rpcRejection(error)
        throw error
      }
    },

    ownershipPort,
    settingsPort: settings,

    ...(options.inputRelay === undefined ? {} : { nativeInputPort: options.inputRelay }),

    async execute(command: { op: string; target: { sessionId: string }; args?: unknown }): Promise<unknown> {
      const sessionId = command.target.sessionId
      const args = asRecord(command.args) ?? {}
      switch (command.op) {
        case 'observe':
          // 历史由 AgentAdapter.history 提供；跟随由 node runner 的订阅表处理。
          throw new PreCallRejection('unsupported', 'observe is served by runner subscriptions')
        case 'prompt': {
          const text = typeof args.text === 'string' ? args.text : ''
          if (text.trim() === '') throw new PreCallRejection('invalid-args', 'text is required')
          return await promptSession(sessionId, text, new AbortController().signal)
        }
        case 'interrupt': {
          const requestedEpoch = typeof args.runtimeEpoch === 'string' ? args.runtimeEpoch : ''
          const turnId = typeof args.turnId === 'string' ? args.turnId : undefined
          return await interruptSession(sessionId, turnId, requestedEpoch, new AbortController().signal)
        }
        case 'steer':
          throw new PreCallRejection('unsupported', 'native-steer-unverified')
        case 'acquire': {
          const snapshot = await ownershipPort.acquire(sessionId, new AbortController().signal)
          // 写权状态已改变（ours）：立即广播新的会话能力，页面不必等下一次同步。
          publishCapability(sessionId)
          return { ownership: snapshot.wire, state: snapshot.state }
        }
        case 'answer': {
          const relay = options.inputRelay
          if (relay === undefined) {
            throw new PreCallRejection('unsupported', 'interaction-relay-unavailable')
          }
          const requestId = typeof args.requestId === 'string' ? args.requestId : ''
          if (requestId === '') throw new PreCallRejection('invalid-args', 'requestId is required')
          const answers = args.answers
          if (!Array.isArray(answers)) throw new PreCallRejection('invalid-args', 'answers is required')
          const result = relay.answer(sessionId, requestId, { answers })
          if (result !== 'ok') throw new PreCallRejection(result)
          return { accepted: true }
        }
        case 'cancel': {
          const relay = options.inputRelay
          if (relay === undefined) {
            throw new PreCallRejection('unsupported', 'interaction-relay-unavailable')
          }
          const requestId = typeof args.requestId === 'string' ? args.requestId : ''
          if (requestId === '') throw new PreCallRejection('invalid-args', 'requestId is required')
          const result = relay.cancel(sessionId, requestId)
          if (result !== 'ok') throw new PreCallRejection(result)
          return { cancelled: true }
        }
        case 'configure':
          // wire args 不能提供可信的 contentAuthorized；T09 由 node runner 直接调用 settingsPort。
          throw new PreCallRejection('unsupported', 'settings-readback-unavailable')
        default:
          throw new PreCallRejection('unsupported')
      }
    },
  }

  return adapter
}
