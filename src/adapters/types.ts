import type { EventFrame, WireErrorCode } from '../wire/frames.ts'

/**
 * 适配器在**发起原生调用之前**给出的明确拒绝：会话不存在、参数非法、
 * 能力不支持等。只有这种错误可以安全记为 `rejected`；调用之后的异常
 * 没有可靠证据，必须由 runner 记为 `outcome-unknown`。
 */
export class PreCallRejection extends Error {
  override readonly name: string = 'PreCallRejection'
  readonly code: WireErrorCode

  constructor(code: WireErrorCode, detail?: string) {
    super(detail === undefined ? `marshal: ${code}: ${code}` : `marshal: ${code}: ${detail}`)
    this.code = code
  }
}

export interface Tunable {
  readonly id: 'model' | 'reasoning' | 'permission' | 'plan' | 'goal' | 'skill' | 'plugin'
  readonly scope: 'next-turn' | 'next-session' | 'host'
  readonly effect: 'immediate' | 'needs-restart' | 'next-session'
  readonly values?: readonly { id: string; label: string }[]
  readonly current?: unknown
  readonly direction?: 'tighten-only'
  /** 只有 true 才在页面上渲染可改控件；v0 全部为 false。 */
  readonly editable: boolean
  /** editable 为 false 时给页面看的一句话。 */
  readonly reason?: string
}

/** 只读观察能力：history 与 follow 是两条独立通道，不能用一个枚举互相代替。 */
export interface ObserveCapability {
  readonly history: boolean
  readonly follow: 'stream' | 'poll' | 'none'
}

/** v0 只可能暴露这些写操作；create/fork/acquire 属于 v1。 */
export type Operation = 'prompt' | 'interrupt' | 'answer' | 'cancel' | 'configure' | 'create' | 'fork' | 'acquire'

/**
 * attached 表示已连接原生会话，可通过该运行时继续；不承诺跨进程排他。
 * ours 保留给本实例创建的受管会话；未知/运行中/未验证都不授予写入。
 */
export type Ownership = 'ours' | 'attached' | 'foreign-unknown' | 'foreign-running' | 'unverified'

export function hasWriteControl(ownership: Ownership): boolean {
  return ownership === 'ours' || ownership === 'attached'
}

/** 清单遍历是否被原生证据证明完整；`items.length` 不是证据。 */
export type SnapshotCompleteness = 'complete' | 'unconfirmed'

/** 会话级设置写请求的回读状态；不含请求值/时间/基线版本。 */
export interface CapabilityPending {
  readonly field: Tunable['id']
  readonly status: 'pending' | 'readback-timeout'
}

export interface Capability {
  readonly observe: ObserveCapability
  readonly operations: ReadonlySet<Operation>
  readonly ownership: Ownership
  readonly reasoning: boolean
  readonly toolDetail: 'args+output' | 'args' | 'none'
  readonly promptFidelity: 'native' | 'relay' | 'dom' | 'none'
  readonly tunables: readonly Tunable[]
  /** operation/field -> 稳定原因码；缺字段表示该能力没有被关闭。 */
  readonly unavailable?: Readonly<Record<string, string>>
  /** 已确认设置快照的修订号；缺失快照时为 0。 */
  readonly settingsRevision?: number
  /** 适配器实例代次；页面据此丢弃跨代次的旧回读。 */
  readonly runtimeEpoch?: string
  /** 正在等待回读的字段；绝不携带请求值。 */
  readonly pending?: CapabilityPending
}

/** `decision-invalid`：卡片因脱敏/超限被标为不可远答，答案必须拒绝；`expired`：期限已过。 */
export type SettleResult = 'ok' | 'unknown' | 'invalid' | 'session-mismatch' | 'decision-invalid' | 'expired'

/** 远端答案回到本机时走它；只有 `ok` 表示这次答案被采纳。 */
export interface AnswerSink {
  settle(sessionId: string, requestId: string, answers: unknown): SettleResult
  /**
   * 放弃一个待答请求（`cancel` op）。它是问题表操作，不是会话级 cancel；
   * 没有待答表时适配器必须拒绝，不能退化成原生会话取消。
   */
  cancel?(sessionId: string, requestId: string): SettleResult
}

/** 同步会话状态；可选标题须经节点内容授权与脱敏，不携带 cwd 或正文。 */
export interface SyncSessionRow {
  readonly sessionId: string
  readonly running: boolean
  readonly updatedAt: number
  readonly blank: boolean
  readonly title?: string
  readonly counts?: Readonly<Record<string, number>>
}

/** 每个 agent 一份完整能力文档；投影后仍不含本机路径或设置正文。 */
export interface SyncCapabilityDocument {
  readonly agent: string
  readonly capability: Record<string, unknown>
}

export interface SyncSnapshot {
  readonly rows: readonly SyncSessionRow[]
  readonly capabilities: readonly SyncCapabilityDocument[]
  readonly completeness: SnapshotCompleteness
}

export interface Adapter {
  controls?(sessionId: string, signal: AbortSignal): Promise<import('../agents/controls.ts').SessionControls>
  readonly agent: string
  /** Read-only native transcript; never creates or resumes a model run. */
  history?(request: { sessionId: string; cursor?: string; limit?: number }, signal: AbortSignal): Promise<{
    items: readonly EventFrame[]; completeness: SnapshotCompleteness; nextCursor?: string
  }>
  capabilities(sessionId: string): Capability
  /**
   * 最近一次清单遍历的完整性。`unconfirmed` 时同步方（T06）只能发布
   * “不完整”标记，不能把首个结果集当全量。
   */
  readonly snapshotCompleteness: SnapshotCompleteness
  /**
   * 完整分页清单 + 每 agent 能力文档。同步（T06）只接受 `complete`；
   * `unconfirmed` 时不得提交替换快照，否则会把未列出的会话误删。
   */
  syncSnapshot(signal: AbortSignal): Promise<SyncSnapshot>
  /** 当前会话清单，已转成 `session.updated`/`capability.changed` 事件。 */
  snapshot(signal: AbortSignal): Promise<readonly EventFrame[]>
  /** 跟随一个会话；这里的 seq 只是适配器内部序号，出站前会被公开序号覆盖。 */
  follow(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame>
  /**
   * 造一个走适配器内部序号的帧。公开 `seq` 只在投影/过滤之后由 node 层
   * 按 `(deviceId, agent, sessionId, nodeEpoch)` 重新分配。
   */
  frame(sessionId: string, kind: EventFrame['kind'], payload: unknown): EventFrame
  /** 投影层分片需要内部序号；公开序号不以它为准。 */
  nextSeq?(sessionId: string): number
  execute(command: { op: string; target: { sessionId: string }; args?: unknown }): Promise<unknown>
}
