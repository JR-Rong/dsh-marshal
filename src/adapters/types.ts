import type { EventFrame, WireErrorCode } from '../wire/frames.ts'

/**
 * 适配器在**发起原生调用之前**给出的明确拒绝：会话不存在、参数非法、
 * 能力不支持等。只有这种错误可以安全记为 `rejected`；调用之后的异常
 * 没有可靠证据，必须由 runner 记为 `outcome-unknown`。
 */
export class PreCallRejection extends Error {
  override readonly name = 'PreCallRejection'
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

export interface Capability {
  readonly observe: 'stream' | 'poll' | 'none'
  readonly dispatch: 'resume' | 'prompt' | 'new' | 'none'
  readonly reasoning: boolean
  readonly toolDetail: 'args+output' | 'args' | 'none'
  readonly promptFidelity: 'native' | 'relay' | 'dom' | 'none'
  readonly tunables: readonly Tunable[]
}

/** `decision-invalid`：卡片因脱敏/超限被标为不可远答，答案必须拒绝。 */
export type SettleResult = 'ok' | 'unknown' | 'invalid' | 'session-mismatch' | 'decision-invalid'

/** 远端答案回到本机时走它；只有 `ok` 表示这次答案被采纳。 */
export interface AnswerSink {
  settle(sessionId: string, requestId: string, answers: unknown): SettleResult
}

export interface Adapter {
  readonly agent: string
  capabilities(sessionId: string): Capability
  /** 当前会话清单，已转成 `session.updated` 事件。 */
  snapshot(signal: AbortSignal): Promise<readonly EventFrame[]>
  /** 跟随一个会话；seq 由适配器按 sessionId 单调分配。 */
  follow(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame>
  /**
   * 造一个走同一 seq 计数器的帧。快照、跟随、提问三类事件共用一条序列，
   * 别处（如 `node/questions.ts`）发事件也必须走它，否则 seq 会撞。
   */
  frame(sessionId: string, kind: EventFrame['kind'], payload: unknown): EventFrame
  /** 投影层分片需要从同一计数器取 seq，避免多个分片共用信封序号。 */
  nextSeq?(sessionId: string): number
  execute(command: { op: string; target: { sessionId: string }; args?: unknown }): Promise<unknown>
}
