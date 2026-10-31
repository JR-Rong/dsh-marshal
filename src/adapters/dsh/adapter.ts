import {
  PreCallRejection, type Capability, type AnswerSink, type Operation, type SnapshotCompleteness,
  type SyncSnapshot,
} from '../types.ts'
import type { EventFrame } from '../../wire/frames.ts'
import { createEventDeduper, toMarshalEvents } from './map.ts'
import type { DshSurface } from './surface.ts'

/** 能力快照的版本；字段含义变化时递增，页面据此丢弃旧解读。 */
const CAPABILITY_REVISION = 1

const TURN_BINDING_MISSING = 'interrupt requires an atomic turn binding'

/**
 * DSH v0 的能力。`observe.history=false` 来自已验证的原生 surface：
 * `list`/`follow` 之外没有可用的只读历史入口，不是“没实现所以猜 false”。
 *
 * ownership 保持 `unverified`：`prompt` 之所以仍出现在 operations，是
 * 因为进程内原生 `prompt` 的“受理”本身就是控制边界；它只证明本适配器
 * 没有绕过原生受理，不证明外部写者不会并发写同一会话。
 */
function buildCapability(surface: DshSurface): Capability {
  const operations = new Set<Operation>(['prompt', 'answer', 'cancel'])
  const unavailable: Record<string, string> = {
    'observe.history': 'history-unavailable',
    create: 'not-exposed-in-v0',
    fork: 'not-exposed-in-v0',
    configure: 'read-only-in-v0',
    ownership: 'unverified-in-v0',
  }
  // interrupt 只在原生控制器给出 atomic turn binding 时开放；否则关闭并说明原因。
  if (surface.activeTurn !== undefined && surface.cancelTurn !== undefined) {
    operations.add('interrupt')
  } else {
    unavailable.interrupt = 'no-atomic-turn-binding'
  }
  return {
    observe: { history: false, follow: 'stream' },
    operations,
    ownership: 'unverified',
    reasoning: true,
    toolDetail: 'args+output',
    promptFidelity: 'native',
    // reason 只放稳定原因码，页面文案由页面按码渲染；不把自由文本当能力字段。
    tunables: [
      { id: 'model', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'v0-field-only' },
      { id: 'reasoning', scope: 'next-turn', effect: 'immediate', direction: 'tighten-only', editable: false, reason: 'v0-field-only' },
      { id: 'permission', scope: 'next-session', effect: 'next-session', direction: 'tighten-only', editable: false, reason: 'v0-tighten-only' },
      { id: 'plan', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'v0-field-only' },
      { id: 'goal', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'v0-field-only' },
      { id: 'skill', scope: 'host', effect: 'needs-restart', editable: false, reason: 'host-config' },
      { id: 'plugin', scope: 'host', effect: 'needs-restart', editable: false, reason: 'host-config' },
    ],
    unavailable,
  }
}

export interface DshAdapterOptions {
  readonly deviceId: string
  readonly nodeEpoch: string
  readonly answers?: AnswerSink
}

export function createDshAdapter(surface: DshSurface, options: DshAdapterOptions) {
  const seqs = new Map<string, number>()
  const nextSeq = (sessionId: string): number => {
    const next = (seqs.get(sessionId) ?? 0) + 1
    seqs.set(sessionId, next)
    return next
  }
  const frame = (sessionId: string, kind: EventFrame['kind'], payload: unknown): EventFrame => ({
    v: 2, type: 'event', deviceId: options.deviceId, agent: 'dsh', sessionId,
    nodeEpoch: options.nodeEpoch, seq: nextSeq(sessionId), ts: Date.now(), kind, payload,
  })

  const capability = buildCapability(surface)
  const dedupe = createEventDeduper()
  let completeness: SnapshotCompleteness = 'unconfirmed'

  const list = async (signal: AbortSignal) => {
    const result = await surface.list(signal)
    completeness = result.completeness
    return result
  }

  /**
   * 会话存在性只作为调用前校验；清单不完整时“没找到”不是否定的证据。
   * 只有遍历到终止页（complete）的清单才允许给出 `session-unknown`。
   */
  const verifySession = async (sessionId: string): Promise<void> => {
    const listed = await list(new AbortController().signal)
    if (listed.items.some(item => item.sessionId === sessionId)) return
    if (listed.completeness === 'complete') throw new PreCallRejection('session-unknown')
    // 完整性不可确认：交给原生调用裁定，不能凭一个残缺清单宣判会话不存在。
  }

  const capabilityPayload = (): Record<string, unknown> => {
    const current = capability
    return {
      observe: { history: current.observe.history, follow: current.observe.follow },
      operations: [...current.operations],
      ownership: current.ownership,
      reasoning: current.reasoning,
      toolDetail: current.toolDetail,
      promptFidelity: current.promptFidelity,
      tunables: current.tunables,
      ...(current.unavailable === undefined ? {} : { unavailable: current.unavailable }),
      revision: CAPABILITY_REVISION,
      readAt: Date.now(),
    }
  }

  const syncSnapshot = async (signal: AbortSignal): Promise<SyncSnapshot> => {
    const listed = await list(signal)
    return {
      rows: listed.items.map(session => ({
        sessionId: session.sessionId,
        running: session.running,
        updatedAt: session.updatedAt,
        blank: session.blank,
      })),
      capabilities: [{ agent: 'dsh', capability: capabilityPayload() }],
      completeness: listed.completeness,
    }
  }

  return {
    agent: 'dsh',
    capabilities(_sessionId: string): Capability { return capability },
    get snapshotCompleteness(): SnapshotCompleteness { return completeness },
    frame,
    nextSeq,

    async syncSnapshot(signal: AbortSignal): Promise<SyncSnapshot> {
      return await syncSnapshot(signal)
    },

    async snapshot(signal: AbortSignal): Promise<EventFrame[]> {
      const listed = await syncSnapshot(signal)
      const events: EventFrame[] = []
      const capability = listed.capabilities.find(item => item.agent === 'dsh')
      for (const session of listed.rows) {
        // 只发可公开状态：cwd/标题/正文一律不出适配器。
        events.push(frame(session.sessionId, 'session.updated', {
          running: session.running,
          updatedAt: session.updatedAt,
          blank: session.blank,
        }))
        if (capability !== undefined) {
          events.push(frame(session.sessionId, 'capability.changed', capability.capability))
        }
      }
      return events
    },

    async *follow(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame> {
      for await (const source of surface.follow(sessionId, signal)) {
        // 先用占位序号映射，去重通过后才分配公开 seq：重复帧不占序号。
        for (const event of toMarshalEvents(source, {
          deviceId: options.deviceId, agent: 'dsh', sessionId, nodeEpoch: options.nodeEpoch,
        }, () => 0)) {
          if (!dedupe.accept(sessionId, event)) continue
          yield { ...event, seq: nextSeq(sessionId) }
        }
      }
    },

    async execute(command: { op: string; target: { sessionId: string }; args?: unknown }): Promise<unknown> {
      const sessionId = command.target.sessionId
      switch (command.op) {
        case 'observe':
          // 跟随由 runner 的订阅表处理；适配器没有只读历史入口。
          throw new PreCallRejection('unsupported', 'history-unavailable')
        case 'prompt': {
          const args = (command.args ?? {}) as { text?: string; requestId?: string }
          if (typeof args.text !== 'string' || args.text.trim() === '') {
            throw new PreCallRejection('invalid-args', 'text is required')
          }
          // 调用前重新列一次会话：只把原生清单里的 running 当“可能忙”的
          // 保守/提示性证据；清单不完整且没找到会话时不作否定判断。
          const listed = await list(new AbortController().signal)
          const session = listed.items.find(item => item.sessionId === sessionId)
          if (session?.running === true) throw new PreCallRejection('writer-busy')
          if (session === undefined && listed.completeness === 'complete') {
            throw new PreCallRejection('session-unknown')
          }
          // 受理原子性完全依赖原生 prompt；调用之后的异常原样上抛，
          // 由 runner 记为 outcome-unknown（不伪造 writer-busy，也不重试）。
          const requestId = args.requestId ?? crypto.randomUUID()
          return await surface.prompt({ sessionId, text: args.text, requestId })
        }
        case 'interrupt': {
          if (surface.activeTurn === undefined || surface.cancelTurn === undefined) {
            // 没有 cancelTurn 时不退回 sessionId-only cancel：那会打断新回合。
            throw new PreCallRejection('unsupported', TURN_BINDING_MISSING)
          }
          const requested = (command.args ?? {}) as { turnId?: string; runtimeEpoch?: string }
          if (requested.runtimeEpoch !== options.nodeEpoch) {
            throw new PreCallRejection('stale-connection')
          }
          const active = await surface.activeTurn(sessionId)
          if (active === undefined) throw new PreCallRejection('conflict', 'no active turn')
          if (requested.turnId !== undefined && requested.turnId !== active.turnId) {
            throw new PreCallRejection('conflict', 'active turn changed')
          }
          // 回合 id、runtimeEpoch 与取消在同一次原生调用里给出；原生侧负责比较。
          return await surface.cancelTurn({
            sessionId, turnId: active.turnId, runtimeEpoch: requested.runtimeEpoch,
          })
        }
        case 'cancel': {
          const requestId = (command.args as { requestId?: string } | undefined)?.requestId
          if (requestId === undefined) {
            // 会话级 cancel 不属于普通提问；没有 requestId 就不能猜。
            throw new PreCallRejection('invalid-args', 'requestId is required')
          }
          const cancel = options.answers?.cancel
          if (cancel === undefined) {
            throw new PreCallRejection('unsupported', 'cancel requires a pending question table')
          }
          const result = cancel(sessionId, requestId)
          if (result !== 'ok') throw new PreCallRejection(result)
          return { cancelled: true }
        }
        case 'answer': {
          await verifySession(sessionId)
          const payload = (command.args ?? {}) as { requestId?: string; answers?: unknown }
          if (payload.requestId === undefined || payload.answers === undefined) {
            throw new PreCallRejection('invalid-args', 'requestId and answers are required')
          }
          // 待答表属于当前 runtime/instance：requestId 不在本表即 unknown，
          // 会话归属由 settle 再校验一次。
          const result = options.answers?.settle(
            sessionId,
            payload.requestId,
            { answers: payload.answers },
          ) ?? 'unknown'
          // 本地待答表拒绝时原生请求没有被回答：这是调用前的明确无副作用拒绝。
          if (result !== 'ok') throw new PreCallRejection(result)
          return { accepted: true }
        }
        case 'configure': {
          const payload = (command.args ?? {}) as { field?: string; value?: unknown }
          const tunable = capability.tunables.find(item => item.id === payload.field)
          if (tunable === undefined) throw new PreCallRejection('unsupported')
          if (tunable.direction === 'tighten-only' && payload.value === 'wide') {
            throw new PreCallRejection('tighten-only')
          }
          throw new PreCallRejection('unsupported', 'configure is not available in v0')
        }
        default:
          throw new PreCallRejection('unsupported')
      }
    },
  }
}
