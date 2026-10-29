import { encodeFrame, type EventFrame, type Frame } from '../wire/frames.ts'
import type { Adapter } from '../adapters/types.ts'
import type { LoggerLike } from '../dsh-types.ts'
import type { NodeLink } from './link.ts'

/** 每会话一条跟随循环；`resume` 指令只启动一次。 */
export function createFollower(options: {
  adapter: Adapter
  send: (event: EventFrame) => void
  logger: Pick<LoggerLike, 'warn'>
}) {
  const active = new Map<string, AbortController>()
  return {
    start(sessionId: string): boolean {
      if (active.has(sessionId)) return false
      const abort = new AbortController()
      active.set(sessionId, abort)
      void (async () => {
        try {
          for await (const event of options.adapter.follow(sessionId, abort.signal)) options.send(event)
        } catch (error) {
          if (!abort.signal.aborted) options.logger.warn('marshal: follow ' + sessionId + ' ended: ' + String(error))
        } finally { active.delete(sessionId) }
      })()
      return true
    },
    stopAll(): void {
      for (const abort of active.values()) abort.abort()
      active.clear()
    },
  }
}

/** 错误前缀即 wire 错误码：`session-unknown: ...` → `session-unknown`。 */
function codeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /^([a-z][a-z-]*):/.exec(message)?.[1] ?? 'adapter-crashed'
}

export function runCommand(
  link: NodeLink,
  adapter: Adapter,
  follower: ReturnType<typeof createFollower>,
  frame: Frame,
  device: string,
): void {
  if (frame.type !== 'command') return
  const reply = (body: { ok: boolean; result?: unknown; code?: string; message?: string }): void => {
    link.sendRaw(encodeFrame({ v: 1, type: 'ack', id: frame.id, ...body }))
  }
  if (frame.target.device !== device) { reply({ ok: false, code: 'device-mismatch' }); return }
  if (frame.target.agent !== adapter.agent) {
    reply({ ok: false, code: 'session-unknown', message: 'agent ' + frame.target.agent + ' unavailable' })
    return
  }
  if (frame.op === 'resume') {
    follower.start(frame.target.sessionId)
    reply({ ok: true, result: { following: true } })
    return
  }
  void adapter.execute({ op: frame.op, target: { sessionId: frame.target.sessionId }, args: frame.args })
    .then(result => reply({ ok: true, result }))
    .catch((error: unknown) => reply({
      ok: false, code: codeOf(error),
      message: error instanceof Error ? error.message : String(error),
    }))
}
