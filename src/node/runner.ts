import { encodeFrame, type AckFrame, type EventFrame, type Frame, type WireErrorCode } from '../wire/frames.ts'
import type { Adapter } from '../adapters/types.ts'
import type { LoggerLike } from '../dsh-types.ts'
import type { NodeLink } from './link.ts'

/** 每会话一条跟随循环；`observe` 指令只启动一次。 */
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
function codeOf(error: unknown): WireErrorCode {
  const message = error instanceof Error ? error.message : String(error)
  const code = /^([a-z][a-z-]*):/.exec(message)?.[1]
  return code !== undefined && WIRE_CODES.has(code) ? code as WireErrorCode : 'adapter-crashed'
}

export function runCommand(
  link: NodeLink,
  adapter: Adapter,
  follower: ReturnType<typeof createFollower>,
  frame: Frame,
  deviceId: string,
): void {
  if (frame.type !== 'command') return
  // ack 绝不能再抛：未处理的拒绝会直接打挂 DSH 宿主进程。
  const reply = (body: {
    status: AckFrame['status']
    code?: WireErrorCode
    result?: unknown
  }): void => {
    const ack: AckFrame = {
      v: 2, type: 'ack', commandId: frame.commandId,
      connectionId: frame.connectionId, nodeEpoch: frame.nodeEpoch,
      status: body.status,
      ...(body.code === undefined ? {} : { code: body.code }),
      ...(body.result === undefined ? {} : { result: body.result }),
    }
    try {
      link.sendRaw(encodeFrame(ack))
    } catch {
      // 结果超过帧上限时，只回固定的小体积错误帧。
      link.sendRaw(encodeFrame({
        v: 2, type: 'ack', commandId: frame.commandId,
        connectionId: frame.connectionId, nodeEpoch: frame.nodeEpoch,
        status: 'rejected', code: 'result-too-large',
      }))
    }
  }
  if (frame.target.deviceId !== deviceId) { reply({ status: 'rejected', code: 'device-mismatch' }); return }
  if (frame.target.agent !== adapter.agent) {
    reply({ status: 'rejected', code: 'session-unknown' })
    return
  }
  // hub 已经超时并可能让用户重试过：迟到的指令再执行会跑两遍。
  if (frame.deadline < Date.now()) {
    reply({ status: 'rejected', code: 'deadline-expired' })
    return
  }
  const sessionId = frame.target.sessionId
  if (sessionId === null) {
    // v0 的 op 都要求实际会话；create/fork 在 v1 才允许 sessionId: null。
    reply({ status: 'rejected', code: 'session-unknown' })
    return
  }
  if (frame.op === 'observe') {
    follower.start(sessionId)
    reply({ status: 'accepted', result: { following: true } })
    return
  }
  void adapter.execute({ op: frame.op, target: { sessionId }, args: frame.args })
    .then(result => reply({ status: 'accepted', result }))
    .catch((error: unknown) => reply({ status: 'rejected', code: codeOf(error) }))
}
