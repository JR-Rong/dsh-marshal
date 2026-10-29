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
          for await (const event of options.adapter.follow(sessionId, abort.signal)) {
            // 单条事件超限只丢这一条；否则一次过大的 send 会终止整个跟随循环。
            try {
              options.send(event)
            } catch (error) {
              options.logger.warn('marshal: follow ' + sessionId + ' dropped event: ' + String(error))
            }
          }
        } catch (error) {
          if (!abort.signal.aborted) options.logger.warn('marshal: follow ' + sessionId + ' ended: ' + String(error))
        } finally {
          // 只清掉本循环自己登记的条目，避免把重启后的新循环踢出 map。
          if (active.get(sessionId) === abort) active.delete(sessionId)
        }
      })()
      return true
    },
    stopAll(): void {
      for (const abort of active.values()) abort.abort()
      active.clear()
    },
  }
}

/** 只允许 spec 定义的 wire 错误码过线；其余（`marshal: …`、`Error: …`）一律归为 adapter-crashed。 */
const WIRE_CODES: ReadonlySet<string> = new Set([
  'session-unknown', 'invalid-args', 'unsupported', 'device-mismatch', 'adapter-crashed', 'result-too-large',
  'unknown', 'invalid', 'session-mismatch', 'tighten-only', 'deadline-expired',
])

/** 错误前缀即 wire 错误码：`session-unknown: ...` → `session-unknown`。 */
function codeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = /^([a-z][a-z-]*):/.exec(message)?.[1]
  return code !== undefined && WIRE_CODES.has(code) ? code : 'adapter-crashed'
}

export function runCommand(
  link: NodeLink,
  adapter: Adapter,
  follower: ReturnType<typeof createFollower>,
  frame: Frame,
  device: string,
): void {
  if (frame.type !== 'command') return
  // ack 绝不能再抛：未处理的拒绝会直接打挂 DSH 宿主进程。
  const reply = (body: { ok: boolean; result?: unknown; code?: string; message?: string }): void => {
    try {
      link.sendRaw(encodeFrame({ v: 1, type: 'ack', id: frame.id, ...body }))
    } catch {
      // 结果或消息超过帧上限时，只回固定的小体积错误帧。
      link.sendRaw(encodeFrame({ v: 1, type: 'ack', id: frame.id, ok: false, code: 'result-too-large', message: 'marshal: result too large' }))
    }
  }
  if (frame.target.device !== device) { reply({ ok: false, code: 'device-mismatch' }); return }
  if (frame.target.agent !== adapter.agent) {
    reply({ ok: false, code: 'session-unknown', message: 'agent ' + frame.target.agent + ' unavailable' })
    return
  }
  // hub 已经超时并可能让用户重试过：迟到的指令再执行会跑两遍。
  if (Number.isFinite(frame.deadline) && frame.deadline < Date.now()) {
    reply({ ok: false, code: 'deadline-expired' })
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
