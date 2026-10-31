import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type {
  Options, PermissionResult, SDKMessage, SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk'
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
import { claudeRow, listAllSessions, listSessionMessagesPage } from './discover.ts'
import {
  createClaudeStreamTracker, historyToEvents, toClaudeEvents,
  type ClaudeEventMeta, type ClaudeStreamTracker,
} from './map.ts'
import { classifyClaudeTool, claudePermissionResult } from './permissions.ts'
import {
  ClaudeRuntimeError, createClaudeRuntime, loadClaudeSdk,
  type ClaudeRuntime, type ClaudeSdk,
} from './runtime.ts'
import { createClaudeSessionRegistry } from './session.ts'

/**
 * Claude 基础适配器（`@anthropic-ai/claude-agent-sdk@0.3.316`）。
 *
 * 安全边界：
 * - `list`/`history`/`probe` 只走 `listSessions`/`getSessionMessages`，不创建
 *   Query、不 spawn CLI（spike §2 的类型证据：两者只读 JSONL transcript）。
 * - 外部会话一律 `foreign-unknown`：`SDKSessionInfo` 没有 running/status，
 *   Claude 也没有原生排他/liveness 证据，因此绝不 resume 冒领。
 * - 只有本实例 create/fork 出来的会话进入 managed 集合，才可能 `acquire`。
 * - steer 无原生证据，保持关闭；interrupt 必须带当前 runtimeEpoch + 已绑定回合。
 * - 任何副作用只发一次；Query 失败不会被新 Query 静默重跑。
 */

const CAPABILITY_REVISION = 1
const DEFAULT_INIT_TIMEOUT_MS = 30_000
const DEFAULT_PROBE_TIMEOUT_MS = 10_000
const DEFAULT_HISTORY_PAGE_SIZE = 100
/** fork 前校验父会话存在性的分页上限：读不到全量就不据此拒绝。 */
const FORK_DISCOVERY_MAX_PAGES = 20

const CLAUDE_TUNABLES: readonly Tunable[] = [
  { id: 'model', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
  { id: 'reasoning', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
  { id: 'permission', scope: 'next-session', effect: 'next-session', direction: 'tighten-only', editable: false, reason: 'settings-readback-unavailable' },
  { id: 'plan', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
  { id: 'goal', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
  // skill/plugin 目录不扫描、不写入任何未约定的配置路径：只显示原因。
  { id: 'skill', scope: 'host', effect: 'needs-restart', editable: false, reason: 'host-config' },
  { id: 'plugin', scope: 'host', effect: 'needs-restart', editable: false, reason: 'host-config' },
]

export interface ClaudeAdapterOptions {
  readonly deviceId: string
  readonly nodeEpoch: string
  readonly runtimeEpoch?: string
  /** 必须显式给出；适配器不默认 remote。 */
  readonly questionRelay: RelayPolicy
  readonly approvalRelay: RelayPolicy
  /** node 统一中继；缺失时原生请求只能本地拒绝。 */
  readonly inputRelay?: NativeInputPort
  /** 测试/装配注入；不提供时延迟 import 真实 SDK。 */
  readonly sdk?: ClaudeSdk
  /** 新建会话的默认工作目录（必须是绝对路径）。 */
  readonly cwd?: string
  /** 只读发现限定的项目目录；不传表示所有项目。 */
  readonly dir?: string
  /** 显式可执行文件路径；不猜机器路径。 */
  readonly pathToClaudeCodeExecutable?: string
  readonly now?: () => number
  readonly initTimeoutMs?: number
  readonly probeTimeoutMs?: number
  readonly maxQueuedInputs?: number
}

interface RuntimeEntry {
  readonly generation: number
  readonly sessionId: string
  readonly runtime: ClaudeRuntime
}

/** 回调在 init 之后才需要会话身份；entry 在此之前为空，早到的帧直接丢弃。 */
interface RuntimeHolder {
  entry?: RuntimeEntry
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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

export function createClaudeAdapter(options: ClaudeAdapterOptions): AgentAdapter {
  const now = options.now ?? Date.now
  const runtimeEpoch = options.runtimeEpoch ?? `${options.nodeEpoch}:claude:${randomUUID()}`
  const initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  const sessions = createClaudeSessionRegistry()
  const coordinator: OwnershipCoordinator = createOwnershipCoordinator({
    runtimeEpoch,
    holder: runtimeEpoch,
    now,
  })
  const seqs = new Map<string, number>()
  const runtimes = new Map<string, RuntimeEntry>()
  const trackers = new Map<string, ClaudeStreamTracker>()
  /** Query 已经死亡的受管会话：身份仍保留，但不再声称可写。 */
  const failed = new Set<string>()
  let completeness: SnapshotCompleteness = 'unconfirmed'
  let phase: AgentState = 'starting'
  let lastProbe: ProbeResult | undefined
  let lastVersion: string | undefined
  let sdkPromise: Promise<ClaudeSdk> | undefined
  let generation = 0
  let stopping = false

  const nextSeq = (sessionId: string): number => {
    const next = (seqs.get(sessionId) ?? 0) + 1
    seqs.set(sessionId, next)
    return next
  }

  const frame = (sessionId: string, kind: EventFrame['kind'], payload: unknown): EventFrame => ({
    v: 2, type: 'event', deviceId: options.deviceId, agent: 'claude', sessionId,
    nodeEpoch: options.nodeEpoch, seq: nextSeq(sessionId), ts: now(), kind, payload,
  })

  /**
   * 真实 SDK 只在需要时求值；类型来自 0.3.316 的 `sdk.d.ts`。
   * 加载失败对控制路径是「调用前就不可用」，可以安全转成 PreCallRejection。
   */
  const ensureSdk = async (signal: AbortSignal): Promise<ClaudeSdk> => {
    if (stopping) throw new AgentUnavailableError({ reason: 'stopped' })
    if (signal.aborted) throw signal.reason
    if (options.sdk !== undefined) return options.sdk
    if (sdkPromise === undefined) sdkPromise = loadClaudeSdk()
    const pending = sdkPromise
    try {
      return await withSignal(pending, signal)
    } catch (error) {
      if (signal.aborted) throw signal.reason
      // 不缓存失败的 import：下次探测可以重试；本次按未安装处理。
      if (sdkPromise === pending) sdkPromise = undefined
      phase = 'failed'
      throw new AgentUnavailableError({ reason: 'not-installed' })
    }
  }

  const ensureSdkForControl = async (signal: AbortSignal): Promise<ClaudeSdk> => {
    try {
      return await ensureSdk(signal)
    } catch (error) {
      if (error instanceof AgentUnavailableError) throw new PreCallRejection('agent-crashed')
      throw error
    }
  }

  const failSession = (sessionId: string): void => {
    failed.add(sessionId)
    trackers.delete(sessionId)
    // 撤销写权但不伪造 idle：之后回落到 foreign-unknown，外部事实由观察值决定。
    coordinator.revoke(sessionId)
    sessions.publish(sessionId, frame(sessionId, 'error', {
      code: 'agent-crashed',
      severity: 'error',
      relatedKind: 'session.updated',
    }))
    sessions.publish(sessionId, frame(sessionId, 'session.updated', {
      running: false,
      ownership: coordinator.ownership(sessionId),
    }))
    // 结束该会话的所有观察者：调用方应从历史重新同步，而不是等一条死流。
    sessions.closeSession(sessionId)
  }

  const handleMessage = (sessionId: string, message: SDKMessage): void => {
    const tracker = trackers.get(sessionId) ?? createClaudeStreamTracker()
    trackers.set(sessionId, tracker)
    // 回合身份必须在 result 之前捕获：result 到达后会立刻清掉绑定。
    const boundTurn = coordinator.turn(sessionId)

    if (message.type === 'system' && message.subtype === 'session_state_changed') {
      coordinator.noteObserved(sessionId, message.state !== 'idle')
      if (message.state === 'idle' && boundTurn !== undefined) {
        coordinator.endTurn(sessionId, boundTurn)
      }
    }
    if (message.type === 'result') {
      if (boundTurn !== undefined) coordinator.endTurn(sessionId, boundTurn)
      tracker.clear()
    }

    const meta: ClaudeEventMeta = {
      deviceId: options.deviceId,
      agent: 'claude',
      nodeEpoch: options.nodeEpoch,
      sessionId,
    }
    const events = toClaudeEvents(message, meta, () => nextSeq(sessionId), {
      runtimeEpoch,
      ownership: coordinator.ownership(sessionId),
      ...(boundTurn === undefined ? {} : { turnId: boundTurn }),
      stream: tracker,
    })
    for (const event of events) sessions.publish(sessionId, event)
  }

  interface OpenRuntimeParams {
    readonly cwd?: string
    readonly resume?: string
    readonly forkSession?: boolean
  }

  type CanUseToolOptions = Parameters<NonNullable<Options['canUseTool']>>[2]

  const DENIED_TOOL: PermissionResult = { behavior: 'deny', message: '已在 marshal 拒绝此操作' }

  /** canUseTool 不能抛也不能挂起：任何异常/不可中继都返回显式 deny。 */
  const handleCanUseTool = async (
    holder: RuntimeHolder,
    toolName: string,
    input: Record<string, unknown>,
    toolOptions: CanUseToolOptions,
  ): Promise<PermissionResult> => {
    try {
      const entry = holder.entry
      if (entry === undefined || stopping) return DENIED_TOOL
      const relay = options.inputRelay
      if (relay === undefined) return DENIED_TOOL
      // 外部（非本实例受管）会话或失去写权时不建卡；只允许当前 runtime 结算的请求。
      if (!sessions.isManaged(entry.sessionId)
        || coordinator.ownership(entry.sessionId) !== 'ours') return DENIED_TOOL
      const classification = classifyClaudeTool(toolName, input)
      if (classification.kind === 'deny') {
        return claudePermissionResult(classification, { decision: 'decline' })
      }
      const decision = await relay.claim({
        kind: classification.kind,
        sessionId: entry.sessionId,
        runtimeEpoch,
        ...(classification.kind === 'question'
          ? { questions: classification.questions }
          : { approval: classification.approval }),
      }, toolOptions.signal)
      return claudePermissionResult(classification, decision)
    } catch {
      return DENIED_TOOL
    }
  }

  const openRuntime = async (
    sdk: ClaudeSdk,
    params: OpenRuntimeParams,
  ): Promise<{ runtime: ClaudeRuntime; init: SDKSystemMessage; holder: RuntimeHolder }> => {
    generation += 1
    const holder: RuntimeHolder = {}

    const runtime = createClaudeRuntime({
      sdk,
      generation,
      runtimeEpoch,
      initTimeoutMs,
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      ...(params.resume === undefined ? {} : { resume: params.resume }),
      ...(params.forkSession === true ? { forkSession: true } : {}),
      ...(options.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }),
      onMessage: message => {
        const entry = holder.entry
        if (entry === undefined) return
        handleMessage(entry.sessionId, message)
      },
      canUseTool: (toolName, input, toolOptions) =>
        handleCanUseTool(holder, toolName, input, toolOptions),
      onExit: () => {
        const entry = holder.entry
        if (entry === undefined || stopping) return
        if (runtimes.get(entry.sessionId) === entry) runtimes.delete(entry.sessionId)
        failSession(entry.sessionId)
      },
    })

    // init 超时/中止不伪造 ID：以非 PreCallRejection 的错误上抛，runner 记 outcome-unknown。
    let init: SDKSystemMessage
    try {
      init = await runtime.ready()
    } catch (error) {
      runtime.close()
      throw error
    }
    if (init.session_id === '') {
      runtime.close()
      throw new Error('marshal: claude session id missing')
    }
    return { runtime, init, holder }
  }

  const adopt = (holder: RuntimeHolder, runtime: ClaudeRuntime, sessionId: string): void => {
    const entry: RuntimeEntry = { generation: runtime.generation, sessionId, runtime }
    holder.entry = entry
    runtimes.set(sessionId, entry)
    sessions.markManaged(sessionId)
    failed.delete(sessionId)
    lastVersion = runtime.init()?.claude_code_version ?? lastVersion
    if (runtime.closed) {
      // init 后立即退出：onExit 发生时 entry 尚未登记，这里补上失败身份，
      // 不能让一个已死的 Query 被能力文档描述成可订阅。
      failed.add(sessionId)
      sessions.closeSession(sessionId)
      return
    }
    phase = 'ready'
  }

  const relayEnabled = (): boolean => options.inputRelay !== undefined
    && (options.questionRelay === 'remote' || options.approvalRelay === 'remote')

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
      tunables: CLAUDE_TUNABLES,
      unavailable,
    }
  }

  const buildSessionCapability = (sessionId: string): Capability => {
    const ownership = coordinator.ownership(sessionId)
    const owns = ownership === 'ours'
    const managed = sessions.isManaged(sessionId)
    const dead = failed.has(sessionId)
    const operations = new Set<Operation>(['create', 'fork'])
    const unavailable: Record<string, string> = {
      configure: 'settings-readback-unavailable',
    }
    // 外部/未管理的会话永远没有可答卡，能力里也不能暴露 answer/cancel。
    if (relayEnabled() && owns && managed) {
      operations.add('answer')
      operations.add('cancel')
    } else {
      unavailable.answer = 'interaction-relay-unavailable'
      unavailable.cancel = 'interaction-relay-unavailable'
    }
    if (dead) {
      unavailable.prompt = 'terminal-failure'
      unavailable.interrupt = 'terminal-failure'
      unavailable.acquire = 'terminal-failure'
      unavailable.follow = 'terminal-failure'
    } else if (owns) {
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
    return {
      // 外部会话没有可订阅的原生通道：只有受管会话才会在我们自己的 Query 上产生事件。
      observe: { history: true, follow: managed && !dead ? 'stream' : 'none' },
      operations,
      ownership,
      reasoning: true,
      toolDetail: 'args+output',
      promptFidelity: 'native',
      tunables: CLAUDE_TUNABLES,
      unavailable,
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
    revision: CAPABILITY_REVISION,
    readAt: now(),
  })

  /**
   * `SDKSessionInfo` 没有运行态；但我们自己的 Query 有。受管会话用本地状态
   * 覆盖发现结果，避免同步行说 idle、事件流却说 running 的自相矛盾。
   */
  const observedRunning = (sessionId: string, fallback: boolean): boolean => {
    const entry = runtimes.get(sessionId)
    if (entry === undefined) return fallback
    if (failed.has(sessionId)) return false
    if (entry.runtime.state !== 'idle') return true
    return coordinator.state(sessionId) === 'ours-running'
  }

  const list = async (signal: AbortSignal): Promise<AgentListResult> => {
    const sdk = await ensureSdk(signal)
    const discovery = await listAllSessions(sdk, signal, {
      ...(options.dir === undefined ? {} : { dir: options.dir }),
    })
    completeness = discovery.complete ? 'complete' : 'unconfirmed'
    return {
      rows: discovery.sessions.map(info => {
        const row = claudeRow(info)
        return { ...row, running: observedRunning(row.sessionId, row.running) }
      }),
      completeness,
    }
  }

  const syncSnapshot = async (signal: AbortSignal): Promise<SyncSnapshot> => {
    const listed = await list(signal)
    return {
      rows: listed.rows,
      capabilities: [{ agent: 'claude', capability: capabilityPayload(buildAgentCapability()) }],
      completeness: listed.completeness,
    }
  }

  /**
   * 普通 prompt：只有受管 + ours-idle 才接受。没有隐式队列：重复提交由
   * `beginPrompt` 立即以 writer-busy 拒绝，去重交给 runner 的 journal。
   */
  const promptSession = (
    sessionId: string,
    text: string,
    signal: AbortSignal,
  ): ControlResult => {
    if (signal.aborted) throw signal.reason
    if (!sessions.isManaged(sessionId)) throw new OwnershipError('ownership-unverified')
    if (failed.has(sessionId)) throw new PreCallRejection('agent-crashed')
    if (text.trim() === '') throw new PreCallRejection('invalid-args', 'text is required')
    // beginPrompt 在第一次输入之前置 busy：并发第二次写入立即被拒。
    coordinator.beginPrompt(sessionId)
    const entry = runtimes.get(sessionId)
    if (entry === undefined) {
      coordinator.endTurn(sessionId)
      throw new PreCallRejection('agent-crashed')
    }
    const turnUuid = randomUUID()
    const turnId = `claude-turn:${turnUuid}`
    try {
      // 同步入队：抛错只发生在 closed/busy，即确定没有写出。
      entry.runtime.send(text, turnUuid)
    } catch (error) {
      coordinator.endTurn(sessionId)
      if (error instanceof ClaudeRuntimeError) {
        throw new PreCallRejection(error.code === 'busy' ? 'conflict' : 'agent-crashed')
      }
      throw error
    }
    try {
      coordinator.bindTurn(sessionId, turnId)
    } catch (error) {
      coordinator.endTurn(sessionId)
      throw error
    }
    return { accepted: true, runtimeEpoch, turnId }
  }

  const interruptSession = async (
    sessionId: string,
    requestedTurnId: string | undefined,
    requestedEpoch: string,
    signal: AbortSignal,
  ): Promise<ControlResult> => {
    if (requestedEpoch !== runtimeEpoch) throw new PreCallRejection('stale-connection')
    if (!sessions.isManaged(sessionId)) throw new OwnershipError('ownership-unverified')
    const turnId = requestedTurnId ?? coordinator.turn(sessionId)
    if (turnId === undefined) throw new PreCallRejection('stale-connection', 'turn-unbound')
    // 只允许当前 runtimeEpoch 绑定的活动回合。
    coordinator.authorizeControl(sessionId, turnId)
    const entry = runtimes.get(sessionId)
    if (entry === undefined) throw new PreCallRejection('agent-crashed')
    try {
      await entry.runtime.interrupt(signal)
    } catch (error) {
      // 调用前就确定未送达的只有 closed/aborted；其它情况保持未知结果，不自动重试。
      if (error instanceof ClaudeRuntimeError
        && (error.code === 'closed' || error.code === 'aborted')) {
        throw new PreCallRejection('agent-crashed')
      }
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
      return await coordinator.acquire(sessionId, async () => {
        if (signal.aborted) throw signal.reason
        const entry = runtimes.get(sessionId)
        if (entry === undefined || entry.runtime.closed) return undefined
        if (entry.runtime.sessionId() !== sessionId) return undefined
        // 正在跑的会话不接受新写入者，也不冒充 idle。
        if (entry.runtime.state !== 'idle') return undefined
        return {
          sessionId,
          mechanism: 'managed-query',
          holder: coordinator.holder,
          runtimeEpoch,
          acquiredAt: now(),
          invalidatesOn: ['query-close', 'process-exit', 'plugin-reload', 'journal-recovery'],
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
      // Claude 没有独立的原生订阅面：只有受管会话的事件来自我们自己的 Query。
      if (!sessions.isManaged(sessionId)) return
      yield* sessions.observe(sessionId, signal)
    })()
  }

  const adapter: AgentAdapter = {
    agent: 'claude',
    runtimeEpoch,

    capabilities(sessionId: string): Capability {
      return buildSessionCapability(sessionId)
    },

    get snapshotCompleteness(): SnapshotCompleteness {
      return completeness
    },

    async probe(signal: AbortSignal): Promise<ProbeResult> {
      const at = now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), probeTimeoutMs)
      timer.unref()
      const combined = AbortSignal.any([signal, controller.signal])
      try {
        const sdk = await ensureSdk(combined)
        // 只读探活：列一页即证明 JSONL API 可用；绝不创建 Query。
        await withSignal(sdk.listSessions({ limit: 1 }), combined)
        const result: ProbeResult = {
          ok: true,
          at,
          runtimeEpoch,
          ...(lastVersion === undefined ? {} : { version: lastVersion }),
          capability: buildAgentCapability(),
        }
        lastProbe = result
        phase = 'ready'
        return result
      } catch (error) {
        const reason: UnavailableCause['reason'] = error instanceof AgentUnavailableError
          ? error.unavailable.reason
          : controller.signal.aborted ? 'probe-timeout'
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
      const sdk = await ensureSdk(signal)
      await withSignal(sdk.listSessions({ limit: 1 }), signal)
      phase = 'ready'
    },

    async stop(): Promise<void> {
      if (stopping) return
      stopping = true
      for (const entry of [...runtimes.values()]) {
        try {
          entry.runtime.close()
        } catch {
          // 关闭失败不影响清理其余会话。
        }
      }
      runtimes.clear()
      trackers.clear()
      failed.clear()
      sessions.clear()
      coordinator.clear()
      seqs.clear()
      phase = 'stopped'
    },

    health(): AgentHealth {
      const state: AgentState = stopping ? 'stopped'
        : phase === 'failed' ? 'failed'
        : phase === 'ready' ? 'ready'
        : phase === 'stopped' ? 'stopped'
        : phase === 'starting' ? 'starting'
        : 'unavailable'
      return {
        agent: 'claude',
        runtimeEpoch,
        state,
        updatedAt: now(),
        ...(lastProbe === undefined ? {} : { lastProbe }),
      }
    },

    list,

    async history(historyRequest: HistoryRequest, signal: AbortSignal): Promise<HistoryPage> {
      const sdk = await ensureSdk(signal)
      const page = await listSessionMessagesPage(sdk, {
        sessionId: historyRequest.sessionId,
        ...(historyRequest.cursor === undefined ? {} : { cursor: historyRequest.cursor }),
        ...(historyRequest.limit === undefined
          ? { limit: DEFAULT_HISTORY_PAGE_SIZE }
          : { limit: historyRequest.limit }),
        ...(options.dir === undefined ? {} : { dir: options.dir }),
      }, signal)
      const meta: ClaudeEventMeta = {
        deviceId: options.deviceId,
        agent: 'claude',
        nodeEpoch: options.nodeEpoch,
        sessionId: historyRequest.sessionId,
      }
      const items = historyToEvents(page.messages, meta, () => nextSeq(historyRequest.sessionId), {
        runtimeEpoch,
        ownership: coordinator.ownership(historyRequest.sessionId),
      })
      return {
        items,
        completeness: page.complete ? 'complete' : 'unconfirmed',
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      }
    },

    observe,

    follow(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame> {
      return observe(sessionId, signal)
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
        // 会话级能力必须带该会话自己的所有权/观察通道，不能复用 agent 级文档。
        events.push(frame(
          row.sessionId,
          'capability.changed',
          capabilityPayload(buildSessionCapability(row.sessionId)),
        ))
      }
      return events
    },

    async prompt(promptRequest: PromptRequest, signal: AbortSignal): Promise<ControlResult> {
      if (promptRequest.runtimeEpoch !== runtimeEpoch) {
        throw new PreCallRejection('stale-connection')
      }
      return promptSession(promptRequest.sessionId, promptRequest.text, signal)
    },

    async steer(_steerRequest: SteerRequest, _signal: AbortSignal): Promise<ControlResult> {
      // SDK 没有「推入即 steer」的原生保证；流式输入只是排队下一回合。
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
      const cwd = createRequest.cwd ?? options.cwd
      if (cwd !== undefined && !isAbsolute(cwd)) throw new PreCallRejection('invalid-args')
      const sdk = await ensureSdkForControl(signal)
      // 流式输入不会注入用户回合：只等 system/init 拿到原生 session_id。
      const opened = await openRuntime(sdk, { ...(cwd === undefined ? {} : { cwd }) })
      adopt(opened.holder, opened.runtime, opened.init.session_id)
      return { sessionId: opened.init.session_id, runtimeEpoch }
    },

    async forkSession(forkRequest: ForkSessionRequest, signal: AbortSignal): Promise<CreatedSession> {
      const parentSessionId = forkRequest.parentSessionId
      if (parentSessionId === '') throw new PreCallRejection('session-unknown')
      const sdk = await ensureSdkForControl(signal)
      // 父会话存在性是调用前校验；清单不完整时交给原生 fork 裁定。
      const discovery = await listAllSessions(sdk, signal, {
        maxPages: FORK_DISCOVERY_MAX_PAGES,
        ...(options.dir === undefined ? {} : { dir: options.dir }),
      })
      if (discovery.complete && !discovery.sessions.some(info => info.sessionId === parentSessionId)) {
        throw new PreCallRejection('session-unknown')
      }
      const opened = await openRuntime(sdk, { resume: parentSessionId, forkSession: true })
      const sessionId = opened.init.session_id
      if (sessionId === '' || sessionId === parentSessionId) {
        // 原生调用已经发生，且新身份缺失/未变化：不能伪装成 rejected。
        opened.runtime.close()
        throw new Error('marshal: claude fork identity missing')
      }
      adopt(opened.holder, opened.runtime, sessionId)
      return { sessionId, runtimeEpoch, parentSessionId }
    },

    ownershipPort,

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
          return promptSession(sessionId, text, new AbortController().signal)
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
          throw new PreCallRejection('unsupported', 'settings-readback-unavailable')
        default:
          throw new PreCallRejection('unsupported')
      }
    },
  }

  return adapter
}
