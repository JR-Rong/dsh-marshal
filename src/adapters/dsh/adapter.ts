import type { Capability, AnswerSink } from '../types.ts'
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
  readonly device: string
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
    v: 1, type: 'event', device: options.device, agent: 'dsh', sessionId,
    seq: nextSeq(sessionId), ts: new Date().toISOString(), kind, payload,
  })

  return {
    agent: 'dsh',
    capabilities(_sessionId: string): Capability { return CAPABILITY },
    frame,

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
        yield* toMarshalEvents(frame, { device: options.device, agent: 'dsh', sessionId }, () => nextSeq(sessionId))
      }
    },

    async execute(command: { op: string; target: { sessionId: string }; args?: unknown }): Promise<unknown> {
      const known = (await surface.list(new AbortController().signal)).map(item => item.sessionId)
      if (!known.includes(command.target.sessionId)) {
        throw new Error(`session-unknown: ${command.target.sessionId}, known ${known.join(',') || '(none)'}`)
      }
      const args = (command.args ?? {}) as { text?: string; requestId?: string }
      switch (command.op) {
        case 'prompt': {
          if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('invalid-args: text is required')
          const requestId = args.requestId ?? crypto.randomUUID()
          return surface.prompt({ sessionId: command.target.sessionId, text: args.text, requestId })
        }
        case 'interrupt':
          return surface.cancel(command.target.sessionId)
        case 'answer': {
          const payload = (command.args ?? {}) as { requestId?: string; answers?: unknown }
          if (payload.requestId === undefined || payload.answers === undefined) {
            throw new Error('invalid-args: requestId and answers are required')
          }
          const result = options.answers?.settle(command.target.sessionId, payload.requestId, payload.answers) ?? 'unknown'
          if (result !== 'ok') throw new Error(`${result}: ${payload.requestId}`)
          return { accepted: true }
        }
        case 'configure': {
          const payload = (command.args ?? {}) as { field?: string; value?: unknown }
          const tunable = CAPABILITY.tunables.find(item => item.id === payload.field)
          if (tunable === undefined) throw new Error(`unsupported: ${String(payload.field)}`)
          if (tunable.direction === 'tighten-only' && payload.value === 'wide') {
            throw new Error('tighten-only: remote callers may not widen permissions')
          }
          throw new Error(`unsupported: configure ${payload.field} in v0`)
        }
        default:
          throw new Error(`unsupported: ${command.op}`)
      }
    },
  }
}
