import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import type { IncomingMessage, Server } from 'node:http'
import { basename, dirname } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { WebServerLike } from '../dsh-types.ts'
import {
  CLOSE_CODES, CONTRACT_REVISION, FrameError, decodeFrame, directionOf, encodeFrame,
  type Frame, type HelloAckFrame,
} from '../wire/frames.ts'
import { MAX_FRAME_BYTES } from '../wire/limits.ts'
import {
  DeviceStateError, sha256Hex, type DeviceRecord, type DeviceStore,
} from './devices.ts'
import type { DeviceRegistry, Sender } from './registry.ts'

export const UPLINK_PATH = '/marshal/uplink'

/** 握手成功后多久之内必须收到合法 hello，否则断开（可被 options.helloTimeoutMs 覆盖）。 */
const HELLO_TIMEOUT_MS = 10_000
/** 契约 §11：应用心跳 5s，15s 无有效心跳即判定半开连接。 */
const HEARTBEAT_TIMEOUT_MS = 15_000
const LIVENESS_CHECK_MS = 1_000
/** ws ping 只作为传输层存活检查，应用心跳才是授权/半开判定依据。 */
const WS_PING_MS = 30_000
/** 原子 rename 会替换 inode，必须 watch 目录而不是文件本身。 */
const WATCH_POLL_MS = 2_000

/** 谁持有 HTTP upgrade 事件。hub 只依赖这个端口，不关心底下是 DSH 还是裸 node。 */
export interface UpgradePort {
  open(handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): () => void
}

export const nodeServerPort = (server: Server): UpgradePort => ({
  open(handler) {
    server.on('upgrade', handler)
    return () => { server.off('upgrade', handler) }
  },
})

/** 走 DSH 的 registerUpgrade：DSH 会销毁没匹配到路由的 upgrade 连接，因此这里只登记一条路径。 */
export const webServerPort = (webServer: WebServerLike): UpgradePort => ({
  open(handler) { return webServer.registerUpgrade({ path: UPLINK_PATH, handler }) },
})

export interface HubLogger {
  warn(message: unknown): void
  error(message: unknown): void
}

export interface HubSocketOptions {
  readonly port: UpgradePort
  readonly registry: DeviceRegistry
  /** 持久设备表的当前视图；鉴权与授权都从这里取。 */
  readonly store: DeviceStore
  readonly operatorId: string
  /** 默认每次 mount 生成；测试可固定。 */
  readonly hubEpoch?: string
  readonly now: () => number
  /** 握手后等待合法 hello 的上限，默认 10_000ms。 */
  readonly helloTimeoutMs?: number
  /** 应用心跳应答期限，默认 15_000ms。 */
  readonly heartbeatTimeoutMs?: number
  /** 心跳超时检查间隔，默认 1_000ms。 */
  readonly livenessCheckMs?: number
  /** 是否热加载设备表；默认开启。 */
  readonly watchDevices?: boolean
  /** 轮询兜底间隔，默认 2_000ms。 */
  readonly pollMs?: number
  readonly logger?: HubLogger
  readonly onFrame?: (deviceId: string, frame: Frame) => void
  /** hello 通过、设备进入注册表之后调用；会话索引据此按设备重建。 */
  readonly onAttach?: (deviceId: string) => void
  /** 设备连接真正被摘除后调用；用于立刻结束发给它的等待中指令。 */
  readonly onDetach?: (deviceId: string) => void
}

export interface HubSocketHandle {
  dispose(): void
  closeDevice(deviceId: string, code: number, reason: string): void
  /** 显式重读设备表；热加载失败时保留旧视图并关闭受影响连接。 */
  reload(): void
}

interface Connection {
  readonly deviceId: string
  readonly deviceName: string
  readonly connectionId: string
  readonly nodeEpoch: string
  readonly agents: ReadonlySet<string>
  readonly sender: Sender
  readonly ws: WebSocket
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

/** 只取 pathname；畸形 URL 视作不匹配。 */
function pathnameOf(req: IncomingMessage): string | undefined {
  try { return new URL(req.url ?? '', 'http://marshal.invalid').pathname } catch { return undefined }
}

function endHttp(socket: Duplex, status: string): void {
  if (socket.writable) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } else {
    socket.destroy()
  }
}

/** 非 uplink 路径直接回 404 并断开，不进入握手，也不看 token。 */
function rejectUpgrade(socket: Duplex): void {
  endHttp(socket, '404 Not Found')
}

/** 一次性检查重复摘要；持久表加载时已校验，这里是 mount 边界的最后防线。 */
function assertUniqueDigests(records: readonly DeviceRecord[]): void {
  const owners = new Map<string, string>()
  for (const record of records) {
    const first = owners.get(record.tokenDigest)
    if (first !== undefined) {
      // 只报 device id，不碰摘要本身。
      throw new Error(`marshal: devices "${first}" and "${record.id}" share the same token digest`)
    }
    owners.set(record.tokenDigest, record.id)
  }
}

function recordMap(records: readonly DeviceRecord[]): Map<string, DeviceRecord> {
  return new Map(records.map(record => [record.id, record]))
}

export function mountHubSocket(options: HubSocketOptions): HubSocketHandle {
  const { registry, store, now } = options
  const hubEpoch = options.hubEpoch ?? randomUUID()
  const operatorId = options.operatorId
  assertUniqueDigests(store.list())

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  const ponged = new WeakMap<WebSocket, boolean>()
  const connections = new WeakMap<WebSocket, Connection>()
  const socketOf = new Map<string, WebSocket>()
  const lastHeartbeat = new WeakMap<WebSocket, number>()
  /** 节点自报更高 revision 时只隔离该设备，不抬高全局修订。 */
  const recoveryFloor = new Map<string, number>()
  const helloTimers = new Set<ReturnType<typeof setTimeout>>()
  let records = recordMap(store.list())
  /** 非法 reload 后停止接受新连接，直到文件恢复为可解析的完整表。 */
  let stateUnconfirmed = false
  let disposed = false
  let watcher: FSWatcher | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let reloadTimer: ReturnType<typeof setTimeout> | undefined

  const sendFrame = (ws: WebSocket, frame: Frame): void => {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(encodeFrame(frame))
  }

  const isCurrent = (connection: Connection): boolean => {
    const slot = registry.get(connection.deviceId)
    return slot !== undefined
      && slot.sender === connection.sender
      && slot.connectionId === connection.connectionId
  }

  const closeDevice = (deviceId: string, code: number, reason: string): void => {
    const ws = socketOf.get(deviceId)
    if (ws !== undefined && ws.readyState === WebSocket.OPEN) ws.close(code, reason)
  }

  const failReload = (error: unknown): void => {
    stateUnconfirmed = true
    const code = error instanceof DeviceStateError ? error.code : 'invalid'
    options.logger?.error(`marshal: device-state-${code}: reload rejected; closing device connections`)
    for (const deviceId of [...socketOf.keys()]) closeDevice(deviceId, CLOSE_CODES.AUTH_FAILED, 'policy-unconfirmed')
  }

  const reload = (): void => {
    if (disposed) return
    try {
      store.reload()
    } catch (error) {
      failReload(error)
      return
    }
    const next = recordMap(store.list())
    for (const [deviceId, previous] of records) {
      const current = next.get(deviceId)
      if (current === undefined || current.revoked) {
        closeDevice(deviceId, CLOSE_CODES.AUTH_FAILED, 'device-revoked')
      } else if (current.policyRevision !== previous.policyRevision) {
        // 授权变化必须让节点重新握手拿到新 ack；4409 可重试且不更换 nodeEpoch。
        closeDevice(deviceId, CLOSE_CODES.STALE_CONNECTION, 'policy-changed')
      }
    }
    records = next
    stateUnconfirmed = false
    for (const [deviceId, floor] of [...recoveryFloor]) {
      const current = next.get(deviceId)
      if (current !== undefined && current.policyRevision >= floor) recoveryFloor.delete(deviceId)
    }
  }

  const scheduleReload = (): void => {
    if (disposed) return
    if (reloadTimer !== undefined) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined
      reload()
    }, 50)
    // 热加载不应阻止进程退出。
    reloadTimer.unref()
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (disposed) { socket.destroy(); return }
    if (pathnameOf(req) !== UPLINK_PATH) { rejectUpgrade(socket); return }
    if (stateUnconfirmed) { endHttp(socket, '503 Service Unavailable'); return }
    // token 只在 Authorization 头里；按摘要查找，绝不记录原值。
    const record = store.findByTokenDigest(sha256Hex(bearerToken(req)))
    if (record === undefined || record.revoked) {
      endHttp(socket, '401 Unauthorized')
      return
    }

    wss.handleUpgrade(req, socket, head, ws => {
      // 没有 error 监听器时，底层 socket 错误会变成 uncaught。
      ws.on('error', () => ws.terminate())
      ponged.set(ws, true)
      ws.on('pong', () => ponged.set(ws, true))

      const connectionId = randomUUID()
      const helloTimer = setTimeout(() => {
        // 先发 4408 关闭帧；对端不回应关闭握手时再强拆，避免半开连接常驻。
        ws.close(CLOSE_CODES.HANDSHAKE_TIMEOUT, 'handshake-timeout')
        const force = setTimeout(() => ws.terminate(), 1_000)
        force.unref()
        helloTimers.add(force)
      }, options.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
      helloTimers.add(helloTimer)
      const clearHelloTimer = (): void => {
        clearTimeout(helloTimer)
        helloTimers.delete(helloTimer)
      }

      const sender: Sender = {
        send: text => { if (ws.readyState === WebSocket.OPEN) ws.send(text) },
      }

      ws.on('close', () => {
        clearHelloTimer()
        lastHeartbeat.delete(ws)
        const connection = connections.get(ws)
        if (connection === undefined) return
        // 同一设备重连后，旧连接迟到的 close 不能摘掉新连接的槽位。
        if (registry.detachIf(connection.deviceId, sender)) {
          if (socketOf.get(connection.deviceId) === ws) socketOf.delete(connection.deviceId)
          options.onDetach?.(connection.deviceId)
        }
      })

      ws.on('message', data => {
        let frame: Frame
        try {
          frame = decodeFrame(String(data))
        } catch (error) {
          const code = error instanceof FrameError && error.code === 'version-unsupported'
            ? CLOSE_CODES.VERSION_UNSUPPORTED
            : CLOSE_CODES.FRAME_INVALID
          ws.close(code, error instanceof FrameError ? error.code : 'frame-invalid')
          return
        }

        const current = connections.get(ws)
        if (current === undefined) {
          // 未发 hello 的 socket 不进注册表；首帧必须既是 hello，又与握手时那个设备一致。
          if (frame.type !== 'hello') { ws.close(CLOSE_CODES.FRAME_INVALID, 'frame-invalid'); return }
          if (frame.deviceId !== record.id) {
            ws.close(CLOSE_CODES.DEVICE_MISMATCH, 'device-mismatch')
            return
          }
          if (frame.contractRevision !== CONTRACT_REVISION) {
            ws.close(CLOSE_CODES.VERSION_UNSUPPORTED, 'version-unsupported')
            return
          }
          // 热加载可能已在 upgrade 与 hello 之间撤销该设备。
          const latest = store.findById(record.id)
          if (latest === undefined || latest.revoked) {
            ws.close(CLOSE_CODES.AUTH_FAILED, 'device-revoked')
            return
          }
          const floor = recoveryFloor.get(latest.id)
          if (floor !== undefined && latest.policyRevision < floor) {
            // 隔离该设备：连现有连接一起关闭，避免旧连接继续写入。
            const existing = socketOf.get(latest.id)
            if (existing !== undefined && existing !== ws) {
              existing.close(CLOSE_CODES.VERSION_UNSUPPORTED, 'recovery-required')
            }
            ws.close(CLOSE_CODES.VERSION_UNSUPPORTED, 'recovery-required')
            return
          }
          if (floor !== undefined) recoveryFloor.delete(latest.id)
          if (frame.operatorId !== undefined
            && frame.operatorId === operatorId
            && frame.policyRevision !== undefined
            && frame.policyRevision > latest.policyRevision) {
            // 节点自报更高修订只隔离该设备，不降低也不抬高 hub 的持久值。
            recoveryFloor.set(latest.id, frame.policyRevision)
            options.logger?.error(
              `marshal: recovery-required: device ${latest.id} reported policyRevision ${frame.policyRevision} above hub ${latest.policyRevision}`,
            )
            const existing = socketOf.get(latest.id)
            if (existing !== undefined && existing !== ws) {
              existing.close(CLOSE_CODES.VERSION_UNSUPPORTED, 'recovery-required')
            }
            ws.close(CLOSE_CODES.VERSION_UNSUPPORTED, 'recovery-required')
            return
          }

          const previous = socketOf.get(latest.id)
          if (previous !== undefined && previous !== ws) {
            // 旧连接先收到 4409；它的迟到 close 由 detachIf 保护，不会摘掉新槽位。
            previous.close(CLOSE_CODES.STALE_CONNECTION, 'stale-connection')
          }

          const connection: Connection = {
            deviceId: latest.id,
            deviceName: latest.name,
            connectionId,
            nodeEpoch: frame.nodeEpoch,
            agents: new Set(frame.agents),
            sender,
            ws,
          }
          clearHelloTimer()
          connections.set(ws, connection)
          socketOf.set(latest.id, ws)
          lastHeartbeat.set(ws, now())
          registry.attach(
            { id: latest.id, name: latest.name, agents: frame.agents },
            sender,
            now(),
            { connectionId, nodeEpoch: frame.nodeEpoch },
          )
          // 节点重连后会重发快照：先清掉该设备的旧索引，已删除的会话不会残留。
          options.onAttach?.(latest.id)
          const ack: HelloAckFrame = {
            v: 2, type: 'hello.ack', connectionId, hubEpoch,
            contractRevision: CONTRACT_REVISION,
            features: [...frame.features],
            nodeEpoch: frame.nodeEpoch,
            operatorId, policyRevision: latest.policyRevision,
            deviceId: latest.id,
            policies: {
              // 内容策略始终以 hub 记录为准；privacy 先反映节点自报快照。
              privacy: frame.privacy ?? 'metadata',
              questionRelay: 'off',
              approvalRelay: 'off',
              allowContent: latest.allowContent,
              allowInteractions: latest.allowInteractions,
              allowDiscussion: latest.allowDiscussion,
            },
            serverTime: now(),
          }
          sendFrame(ws, ack)
          return
        }

        // 同设备新连接已接管槽位：旧连接上的帧一律视为过期，不能修改索引或完成新命令。
        if (!isCurrent(current)) {
          ws.close(CLOSE_CODES.STALE_CONNECTION, 'stale-connection')
          return
        }
        // 每条已认证连接只接受 node→hub 或双向帧；hub→node 帧从设备发来即协议错误。
        const direction = directionOf(frame)
        if (direction !== 'node-to-hub' && direction !== 'both') {
          ws.close(CLOSE_CODES.FRAME_INVALID, 'frame-invalid')
          return
        }
        if (frame.type === 'hello') { ws.close(CLOSE_CODES.FRAME_INVALID, 'frame-invalid'); return }

        const frameConnectionId = 'connectionId' in frame ? frame.connectionId : undefined
        if (frameConnectionId !== undefined && frameConnectionId !== current.connectionId) {
          // ACK 用错代次时静默丢弃，不能结算新命令；其它帧则说明 socket 已过期。
          if (frame.type === 'ack') return
          ws.close(CLOSE_CODES.STALE_CONNECTION, 'stale-connection')
          return
        }
        const frameNodeEpoch = 'nodeEpoch' in frame ? frame.nodeEpoch : undefined
        if (frameNodeEpoch !== undefined && frameNodeEpoch !== current.nodeEpoch) {
          if (frame.type === 'ack' || frame.type === 'heartbeat') return
          ws.close(CLOSE_CODES.STALE_CONNECTION, 'stale-connection')
          return
        }

        registry.touch(current.deviceId, now())
        if (frame.type === 'heartbeat') {
          lastHeartbeat.set(ws, now())
          sendFrame(ws, {
            v: 2, type: 'heartbeat.ack',
            nonce: frame.nonce,
            connectionId: current.connectionId,
            nodeEpoch: current.nodeEpoch,
            sentAt: frame.sentAt,
          })
          return
        }

        if (frame.type === 'event') {
          // 只信握手绑定的身份：帧里自报的 deviceId/agent 不能冒充别的设备或未声明的 agent。
          if (frame.deviceId !== current.deviceId) {
            ws.close(CLOSE_CODES.DEVICE_MISMATCH, 'device-mismatch')
            return
          }
          if (!current.agents.has(frame.agent)) {
            ws.close(CLOSE_CODES.FRAME_INVALID, 'frame-invalid')
            return
          }
        }
        options.onFrame?.(current.deviceId, frame)
      })
    })
  }
  const closePort = options.port.open(onUpgrade)

  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (ponged.get(ws) === false) { ws.terminate(); continue }
      ponged.set(ws, false)
      ws.ping()
    }
  }, WS_PING_MS)
  pingTimer.unref()

  const livenessTimer = setInterval(() => {
    const at = now()
    const timeout = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      const last = lastHeartbeat.get(ws)
      if (last !== undefined && at - last > timeout) ws.terminate()
    }
  }, options.livenessCheckMs ?? LIVENESS_CHECK_MS)
  livenessTimer.unref()

  if (options.watchDevices ?? true) {
    try {
      watcher = watch(dirname(store.file), { persistent: false }, (_event, filename) => {
        const changed = filename === null ? undefined : filename.toString()
        if (changed === undefined || changed === basename(store.file)) scheduleReload()
      })
      watcher.on('error', () => { /* 轮询兜底仍会生效 */ })
    } catch {
      // 目录不可 watch 时依赖轮询；不影响启动。
    }
    pollTimer = setInterval(reload, options.pollMs ?? WATCH_POLL_MS)
    pollTimer.unref()
  }

  return {
    dispose() {
      if (disposed) return
      disposed = true
      if (watcher !== undefined) watcher.close()
      if (pollTimer !== undefined) clearInterval(pollTimer)
      if (reloadTimer !== undefined) clearTimeout(reloadTimer)
      clearInterval(livenessTimer)
      clearInterval(pingTimer)
      for (const helloTimer of helloTimers) clearTimeout(helloTimer)
      helloTimers.clear()
      closePort()
      for (const ws of wss.clients) ws.terminate()
      wss.close()
    },
    closeDevice,
    reload,
  }
}
