import { PreCallRejection, type Capability, type AnswerSink } from '../types.ts'
import type { EventFrame } from '../../wire/frames.ts'
import { toMarshalEvents } from './map.ts'
import type { DshSurface } from './surface.ts'

const CAPABILITY: Capability = {
  observe: 'stream',
  dispatch: 'prompt',
  reasoning: true,
  toolDetail: 'args+output',
  promptFidelity: 'native',
  tunables: [
    { id: 'model', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'v0 只认出字段；保存与回读顺延' },
    { id: 'reasoning', scope: 'next-turn', effect: 'immediate', direction: 'tighten-only', editable: false, reason: 'v0 只认出字段；保存与回读顺延' },
    { id: 'permission', scope: 'next-session', effect: 'next-session', direction: 'tighten-only', editable: false, reason: 'v0 只拒绝放宽；切换顺延' },
    { id: 'plan', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'v0 只认出字段；保存与回读顺延' },
    { id: 'goal', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'v0 只认出字段；保存与回读顺延' },
    { id: 'skill', scope: 'host', effect: 'needs-restart', editable: false, reason: '技能是宿主级配置，远端只能查看' },
    { id: 'plugin', scope: 'host', effect: 'needs-restart', editable: false, reason: '插件是宿主级配置，远端只能查看' },
  ],
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

  return {
    agent: 'dsh',
    capabilities(_sessionId: string): Capability { return CAPABILITY },
    frame,
    nextSeq,

    async snapshot(signal: AbortSignal): Promise<EventFrame[]> {
      const sessions = await surface.list(signal)
      return sessions.map(session => frame(session.sessionId, 'session.updated', {
        running: session.running,
        updatedAt: session.updatedAt,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      }))
    },

    async *follow(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame> {
      for await (const frame of surface.follow(sessionId, signal)) {
        yield* toMarshalEvents(frame, {
          deviceId: options.deviceId, agent: 'dsh', sessionId, nodeEpoch: options.nodeEpoch,
        }, () => nextSeq(sessionId))
      }
    },

    async execute(command: { op: string; target: { sessionId: string }; args?: unknown }): Promise<unknown> {
      const known = (await surface.list(new AbortController().signal)).map(item => item.sessionId)
      if (!known.includes(command.target.sessionId)) {
        // 不回传已知会话清单/路径；只给分类。
        throw new PreCallRejection('session-unknown')
      }
      const args = (command.args ?? {}) as { text?: string; requestId?: string }
      switch (command.op) {
        case 'prompt': {
          if (typeof args.text !== 'string' || args.text.trim() === '') {
            throw new PreCallRejection('invalid-args', 'text is required')
          }
          const requestId = args.requestId ?? crypto.randomUUID()
          return surface.prompt({ sessionId: command.target.sessionId, text: args.text, requestId })
        }
        case 'interrupt':
          return surface.cancel(command.target.sessionId)
        case 'answer': {
          const payload = (command.args ?? {}) as { requestId?: string; answers?: unknown }
          if (payload.requestId === undefined || payload.answers === undefined) {
            throw new PreCallRejection('invalid-args', 'requestId and answers are required')
          }
          // 线上 `answers` 是数组（设计 §7.2）；DSH 侧要的是 `{ answers }`，在这里包一层。
          const result = options.answers?.settle(
            command.target.sessionId,
            payload.requestId,
            { answers: payload.answers },
          ) ?? 'unknown'
          // 本地待答表拒绝时原生请求没有被回答：这是调用前的明确无副作用拒绝。
          if (result !== 'ok') throw new PreCallRejection(result)
          return { accepted: true }
        }
        case 'configure': {
          const payload = (command.args ?? {}) as { field?: string; value?: unknown }
          const tunable = CAPABILITY.tunables.find(item => item.id === payload.field)
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
