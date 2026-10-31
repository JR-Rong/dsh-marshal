import { randomUUID } from 'node:crypto'
import { encodeFrame, type AckFrame, type EventFrame, type Frame, type WireErrorCode } from '../wire/frames.ts'
import { parseCommandArgs, type ObserveArgs } from '../wire/commands.ts'
import type { Adapter } from '../adapters/types.ts'
import type { LoggerLike } from '../dsh-types.ts'
import type { NodeLink } from './link.ts'

/**
 * 每会话一条跟随循环；`observe` 指令只启动一次。
 * subscriptionId 由 runner 生成并随订阅绑定到当前连接（link 本身按连接隔离）。
 */
export function createFollower(options: {
  adapter: Adapter
  send: (event: EventFrame) => void
  logger: Pick<LoggerLike, 'warn'>
}) {
  const active = new Map<string, { subscriptionId: string; abort: AbortController }>()
  return {
    start(sessionId: string, subscriptionId: string): boolean {
      if (active.has(sessionId)) return false
      const abort = new AbortController()
      active.set(sessionId, { subscriptionId, abort })
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
          if (active.get(sessionId)?.abort === abort) active.delete(sessionId)
        }
      })()
      return true
    },
    stop(sessionId: string, subscriptionId: string): boolean {
      const entry = active.get(sessionId)
      if (entry === undefined || entry.subscriptionId !== subscriptionId) return false
      entry.abort.abort()
      active.delete(sessionId)
      return true
    },
    has(sessionId: string): boolean { return active.has(sessionId) },
    stopAll(): void {
      for (const entry of active.values()) entry.abort.abort()
      active.clear()
    },
  }
}

/** 只允许 spec 定义的 wire 错误码过线；其余（`marshal: …`、`Error: …`）一律归为 agent-crashed。 */
const WIRE_CODES: ReadonlySet<string> = new Set([
  'session-unknown', 'invalid-args', 'unsupported', 'device-mismatch', 'agent-crashed', 'result-too-large',
  'unknown', 'invalid', 'session-mismatch', 'tighten-only', 'deadline-expired',
])

/** 错误前缀即 wire 错误码：`session-unknown: ...` 或 `marshal: session-unknown: ...` → `session-unknown`。 */
function codeOf(error: unknown): WireErrorCode {
  const message = error instanceof Error ? error.message : String(error)
  const code = /^marshal: ([a-z][a-z-]*):/.exec(message)?.[1]
    ?? /^([a-z][a-z-]*):/.exec(message)?.[1]
  return code !== undefined && WIRE_CODES.has(code) ? code as WireErrorCode : 'agent-crashed'
}

/** subscriptionId 由 runner 生成，按会话存放；link 每连接一个，因此状态天然绑定连接。 */
const subscriptions = new WeakMap<ReturnType<typeof createFollower>, Map<string, string>>()

function subscriptionsOf(follower: ReturnType<typeof createFollower>): Map<string, string> {
  let map = subscriptions.get(follower)
  if (map === undefined) { map = new Map(); subscriptions.set(follower, map) }
  return map
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
  let args: ReturnType<typeof parseCommandArgs>
  try {
    args = parseCommandArgs(frame.op, frame.args)
  } catch {
    // 参数不合法就不执行；不能让未校验的 args 进入适配器。
    reply({ status: 'rejected', code: 'invalid-args' })
    return
  }
  if (frame.op === 'observe') {
    const observe = args as ObserveArgs
    if (observe.kind === 'history') {
      // 历史读取由适配器实现（T05）；当前适配器会明确返回 unsupported，不能静默改成跟随。
      void adapter.execute({ op: 'observe', target: { sessionId }, args: observe })
        .then(result => reply({ status: 'accepted', result }))
        .catch((error: unknown) => reply({ status: 'rejected', code: codeOf(error) }))
      return
    }
    const map = subscriptionsOf(follower)
    if (observe.action === 'subscribe') {
      const existing = map.get(sessionId)
      if (existing !== undefined && follower.has(sessionId)) {
        // 同一连接对同一会话重复订阅是幂等的：返回已有订阅，不启动第二条跟随循环。
        reply({ status: 'accepted', result: { following: true, subscriptionId: existing } })
        return
      }
      // 跟随循环已自然结束（例如会话终止）：旧 id 作废，重新签发。
      if (existing !== undefined) map.delete(sessionId)
      const subscriptionId = randomUUID()
      if (!follower.start(sessionId, subscriptionId)) {
        reply({ status: 'rejected', code: 'conflict' })
        return
      }
      map.set(sessionId, subscriptionId)
      reply({ status: 'accepted', result: { following: true, subscriptionId } })
      return
    }
    const subscriptionId = observe.subscriptionId
    if (subscriptionId === undefined
      || map.get(sessionId) !== subscriptionId
      || !follower.stop(sessionId, subscriptionId)) {
      reply({ status: 'rejected', code: 'conflict' })
      return
    }
    map.delete(sessionId)
    reply({ status: 'accepted', result: { following: false, subscriptionId } })
    return
  }
  void adapter.execute({ op: frame.op, target: { sessionId }, args })
    .then(result => reply({ status: 'accepted', result }))
    .catch((error: unknown) => reply({ status: 'rejected', code: codeOf(error) }))
}
