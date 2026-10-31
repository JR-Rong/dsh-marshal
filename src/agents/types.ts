import type {
  Adapter, Capability, ObserveCapability, Operation, Ownership, SnapshotCompleteness,
  SyncCapabilityDocument, SyncSessionRow, SyncSnapshot, Tunable,
} from '../adapters/types.ts'
import type { EventFrame } from '../wire/frames.ts'

/**
 * v1 agent 公共边界。
 *
 * 这里只定义生命周期、逐功能端口与稳定的不可用原因；Codex/Claude 的真实协议
 * 不在此文件。`src/adapters/types.ts` 的 Capability/ObserveCapability/Operation/
 * Ownership/SnapshotCompleteness/SyncSnapshot 仍是唯一语义来源，本文件只做扩展，
 * 不另造一套能力枚举。
 *
 * T01 只交付类型：ownership / configure / readSettings / handleNativeInput 以独立
 * 端口类型留给 T02、T05 实现；本文件不提供任何空实现。AgentHost 也不绕过
 * node runner/journal/privacy 接受远端写命令（见 host.ts）。
 */

export type AgentName = string
/** 适配器实例代次；进程仍在但插件重载也必须换代，旧回调不能污染新实例。 */
export type RuntimeEpoch = string

/** 注册表与健康汇总使用的状态；`unavailable` 表示当前无法安全观察，不是“没有会话”。 */
export type AgentState = 'starting' | 'ready' | 'failed' | 'stopped' | 'unavailable'

/**
 * 稳定、可穷举的不可用原因码。页面/ACK 只应按码渲染，不能依赖自由文本。
 * 新增原因时同步更新页面与测试；细节放 `detail`，且不得包含凭据、路径或正文。
 */
export const UNAVAILABLE_REASONS = [
  'agent-missing',
  'not-installed',
  'version-unsupported',
  'protocol-unsupported',
  'probe-failed',
  'probe-timeout',
  'spawn-failed',
  'start-failed',
  'auth-required',
  'config-invalid',
  'terminal-failure',
  'restart-exhausted',
  'idle-reclaimed',
  'stopped',
  'disabled',
  'ownership-unverified',
  'capability-unavailable',
  'snapshot-failed',
  'health-failed',
  'disposed',
  'unknown',
] as const

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number]

export interface UnavailableCause {
  readonly reason: UnavailableReason
  /** 可选的无正文说明；只进入本机 health，不进入 wire 正文。 */
  readonly detail?: string
}

/**
 * 适配器可以抛出它给出比“snapshot-failed”更准确的原因；Host 会原样记录，
 * 不会把 Error.message 写进能力文档或日志。
 */
export class AgentUnavailableError extends Error {
  override readonly name = 'AgentUnavailableError'
  readonly unavailable: UnavailableCause

  constructor(unavailable: UnavailableCause) {
    super(`marshal: agent unavailable: ${unavailable.reason}`)
    this.unavailable = unavailable
  }
}

export interface ProbeResult {
  readonly ok: boolean
  readonly at: number
  readonly runtimeEpoch: RuntimeEpoch
  readonly version?: string
  readonly capability?: Capability
  readonly unavailable?: UnavailableCause
}

/** 只读清单：与 v0 SyncSessionRow 相同，不自造另一套行形状。 */
export interface AgentListResult {
  readonly rows: readonly SyncSessionRow[]
  readonly completeness: SnapshotCompleteness
}

export interface HistoryRequest {
  readonly sessionId: string
  readonly cursor?: string
  readonly limit?: number
}

export interface HistoryPage {
  readonly items: readonly EventFrame[]
  readonly completeness: SnapshotCompleteness
  readonly nextCursor?: string
}

/** 一次控制动作绑定的原生回合；旧 runtimeEpoch 的 steer/interrupt 必须拒绝。 */
export interface TurnBinding {
  readonly sessionId: string
  readonly turnId: string
  readonly runtimeEpoch: RuntimeEpoch
}

export interface PromptRequest {
  readonly sessionId: string
  readonly text: string
  readonly requestId: string
  /** 取得写权时的实例代次；与 adapter.runtimeEpoch 不一致即拒绝。 */
  readonly runtimeEpoch: RuntimeEpoch
}

export interface SteerRequest extends TurnBinding {
  readonly text: string
  readonly requestId: string
}

export interface InterruptRequest extends TurnBinding {
  readonly requestId: string
}

export interface ControlResult {
  readonly accepted: boolean
  readonly runtimeEpoch: RuntimeEpoch
  readonly turnId?: string
}

/**
 * T02 的写权端口占位。持续排他证据必须带机制、持有者与代次，不能只记 boolean。
 * T01 不实现、不挂到 host 路由。
 */
export interface OwnershipEvidence {
  readonly mechanism: string
  readonly holder: string
  readonly runtimeEpoch: RuntimeEpoch
  readonly acquiredAt: number
  readonly expiresAt?: number
}

export interface OwnershipPort {
  acquire(sessionId: string, signal: AbortSignal): Promise<OwnershipEvidence>
  release(sessionId: string): Promise<void>
  ownership(sessionId: string): Ownership
  evidence(sessionId: string): OwnershipEvidence | undefined
}

/**
 * T05/T07 的设置端口占位：current/confirmed 与 requested/pending 分离，
 * runtimeEpoch + settingsRevision 参与比较。T01 不实现回读。
 */
export interface SettingsReadRequest {
  readonly sessionId: string
  readonly runtimeEpoch: RuntimeEpoch
  readonly revision: number
}

export interface SettingsValue {
  readonly field: string
  readonly current: unknown
  readonly revision: number
  readonly confirmed: boolean
}

export interface SettingsReadResult {
  readonly values: readonly SettingsValue[]
  readonly runtimeEpoch: RuntimeEpoch
  readonly revision: number
}

export interface ConfigureRequest {
  readonly sessionId: string
  readonly field: string
  readonly value: unknown
  readonly expectedRevision: number
  readonly runtimeEpoch: RuntimeEpoch
}

export interface ConfigureResult {
  readonly status: 'confirmed' | 'pending-confirmation'
  readonly revision: number
  readonly runtimeEpoch: RuntimeEpoch
}

export interface SettingsPort {
  readSettings(request: SettingsReadRequest, signal: AbortSignal): Promise<SettingsReadResult>
  configure(request: ConfigureRequest, signal: AbortSignal): Promise<ConfigureResult>
}

/**
 * T05 的原生输入端口占位：两项中继策略、完整输入 schema、允许集合与
 * 原生 `nativeExpiresAt`（缺失为空）都由适配器在这里处理。
 */
export interface NativeInputRequest {
  readonly sessionId: string
  readonly requestId: string
  readonly runtimeEpoch: RuntimeEpoch
  readonly nativeExpiresAt?: number
  readonly schema: unknown
}

export interface NativeInputDecision {
  readonly decision: 'answer' | 'decline' | 'cancel'
  readonly value?: unknown
}

export interface NativeInputPort {
  handleNativeInput(request: NativeInputRequest, signal: AbortSignal): Promise<NativeInputDecision>
}

/** 上报的最近状态；Host 以 registry 记录为准，读取 health 不改变记录。 */
export interface AgentHealth {
  readonly agent: AgentName
  readonly runtimeEpoch: RuntimeEpoch
  readonly state: AgentState
  readonly capability?: Capability
  readonly unavailable?: UnavailableCause
  readonly lastProbe?: ProbeResult
  readonly restarts?: number
  readonly retryAt?: number
  readonly updatedAt: number
}

/** 单次 snapshotAll 的逐 agent 结果；失败项无行但仍携带可用性原因。 */
export interface AgentSnapshotReport {
  readonly agent: AgentName
  readonly state: AgentState
  readonly rows: readonly SyncSessionRow[]
  readonly capabilities: readonly SyncCapabilityDocument[]
  readonly completeness: SnapshotCompleteness
  readonly unavailable?: UnavailableCause
}

/**
 * 聚合快照。任一 adapter 失败时整体 `completeness='unconfirmed'`：
 * 调用方不能把“该 agent 本次没有行”当作会话被删除。
 */
export interface AgentHostSnapshot extends SyncSnapshot {
  readonly agents: readonly AgentSnapshotReport[]
}

/**
 * 生命周期 + 只读/控制端口。`Adapter` 仍是 v0 同步/跟随/执行端口的来源，
 * 这里只做 v1 的功能拆分，不重复定义 Capability 等语义。
 */
export interface AgentAdapter extends Adapter {
  readonly runtimeEpoch: RuntimeEpoch

  // probe / start / stop / health
  probe(signal: AbortSignal): Promise<ProbeResult>
  start(signal: AbortSignal): Promise<void>
  stop(): Promise<void>
  health(): AgentHealth

  // list / history / observe：只读，无 acquire/resume 副作用
  list(signal: AbortSignal): Promise<AgentListResult>
  history(request: HistoryRequest, signal: AbortSignal): Promise<HistoryPage>
  observe(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame>

  // prompt / steer / interrupt：无隐式队列，绑定 runtimeEpoch/activeTurnId
  prompt(request: PromptRequest, signal: AbortSignal): Promise<ControlResult>
  steer(request: SteerRequest, signal: AbortSignal): Promise<ControlResult>
  interrupt(request: InterruptRequest, signal: AbortSignal): Promise<ControlResult>

  // 以下端口由 T02/T05 实现；T01 只定义类型，不提供空实现。
  readonly ownershipPort?: OwnershipPort
  readonly settingsPort?: SettingsPort
  readonly nativeInputPort?: NativeInputPort
}

export type {
  Capability, ObserveCapability, Operation, Ownership, SnapshotCompleteness,
  SyncCapabilityDocument, SyncSessionRow, SyncSnapshot, Tunable,
}
