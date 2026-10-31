import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { WebServerLike } from '../dsh-types.ts'
import {
  CLOSE_CODES, CONTRACT_REVISION, FrameError, decodeFrame, directionOf, encodeFrame,
  type Frame, type HelloAckFrame,
} from '../wire/frames.ts'
import { MAX_FRAME_BYTES } from '../wire/limits.ts'
import type { DeviceEntry } from './devices.ts'
import type { DeviceRegistry, Sender } from './registry.ts'

export const UPLINK_PATH = '/marshal/uplink'

/** 握手成功后多久之内必须收到合法 hello，否则断开（可被 options.helloTimeoutMs 覆盖）。 */
const HELLO_TIMEOUT_MS = 10_000

/** T02 会换成持久化的 operator 身份与授权修订；当前只作为显式占位值下发。 */
const PLACEHOLDER_OPERATOR_ID = 'operator-unbound'
const PLACEHOLDER_POLICY_REVISION = 0

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

export interface HubSocketOptions {
  readonly port: UpgradePort
  readonly registry: DeviceRegistry
  readonly devices: readonly DeviceEntry[]
  readonly now: () => number
  readonly heartbeatMs?: number
  /** 握手后等待合法 hello 的上限，默认 10_000ms。 */
  readonly helloTimeoutMs?: number
  /** T02 之前的显式占位值：当前安装的 owner 身份与授权修订。 */
  readonly operatorId?: string
  readonly policyRevision?: number
  readonly onFrame?: (deviceId: string, frame: Frame) => void
  /** hello 通过、设备进入注册表之后调用；会话索引据此按设备重建。 */
  readonly onAttach?: (deviceId: string) => void
  /** 设备连接真正被摘除后调用；用于立刻结束发给它的等待中指令。 */
  readonly onDetach?: (deviceId: string) => void
}

export interface HubSocketHandle {
  dispose(): void
  closeDevice(deviceId: string, code: number, reason: string): void
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

/** 设备 token 的唯一性在 mount 时检查一次，之后握手只比较定长摘要。 */
interface DeviceToken { readonly device: DeviceEntry; readonly digest: Buffer }

/** 常量时间比较：两边都是定长摘要，长度差异不落在时序上。 */
function digestEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 与 `devices.findByToken` 一致，取第一个匹配项。 */
function findDevice(tokens: readonly DeviceToken[], digest: Buffer): DeviceEntry | undefined {
  for (const entry of tokens) if (digestEquals(entry.digest, digest)) return entry.device
  return undefined
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

/** 只取 pathname；畸形 URL 视作不匹配。 */
function pathnameOf(req: IncomingMessage): string | undefined {
  try { return new URL(req.url ?? '', 'http://marshal.invalid').pathname } catch { return undefined }
}

/** 非 uplink 路径直接回 404 并断开，不进入握手，也不看 token。 */
function rejectUpgrade(socket: Duplex): void {
  if (socket.writable) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  } else {
    socket.destroy()
  }
}

export function mountHubSocket(options: HubSocketOptions): HubSocketHandle {
  const { registry, devices, now } = options
  const hubEpoch = randomUUID()
  const operatorId = options.operatorId ?? PLACEHOLDER_OPERATOR_ID
  const policyRevision = options.policyRevision ?? PLACEHOLDER_POLICY_REVISION

  const tokens: DeviceToken[] = devices.map(device => ({ device, digest: sha256(device.token) }))
  // 重复 token 会让 token→设备 的映射有歧义；只报 device id，不碰 token 本身。
  const owners = new Map<string, string>()
  for (const { device, digest } of tokens) {
    const key = digest.toString('hex')
    const first = owners.get(key)
    if (first !== undefined) {
      throw new Error(`marshal: devices "${first}" and "${device.id}" share the same token`)
    }
    owners.set(key, device.id)
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  const alive = new WeakMap<WebSocket, boolean>()
  const deviceOf = new WeakMap<WebSocket, string>()
  const agentsOf = new WeakMap<WebSocket, ReadonlySet<string>>()
  const helloTimers = new Set<ReturnType<typeof setTimeout>>()
  let disposed = false

  // close 之后再 send 会抛异常，所有出站帧都必须先看状态。
  const sendFrame = (ws: WebSocket, frame: Frame): void => {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(encodeFrame(frame))
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (disposed) { socket.destroy(); return }
    if (pathnameOf(req) !== UPLINK_PATH) { rejectUpgrade(socket); return }
    const digest = sha256(bearerToken(req))
    const device = findDevice(tokens, digest)
    // 握手失败只说原因码，不回显 token，也不进注册表。401 让客户端能区分「token 错」与网络故障。
    if (device === undefined) {
      if (socket.writable) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      } else {
        socket.destroy()
      }
      return
    }

    wss.handleUpgrade(req, socket, head, ws => {
      alive.set(ws, true)
      // 没有 error 监听器时，底层 socket 错误会变成 uncaught。
      ws.on('error', () => ws.terminate())
      ws.on('pong', () => alive.set(ws, true))

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
        const id = deviceOf.get(ws)
        // 同一设备重连后，旧连接迟到的 close 不能摘掉新连接的槽位。
        if (id !== undefined && registry.detachIf(id, sender)) options.onDetach?.(id)
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
        const id = deviceOf.get(ws)
        if (id === undefined) {
          // 未发 hello 的 socket 不进注册表；首帧必须既是 hello，又与握手时那个设备一致。
          if (frame.type !== 'hello') { ws.close(CLOSE_CODES.FRAME_INVALID, 'frame-invalid'); return }
          if (frame.deviceId !== device.id) {
            ws.close(CLOSE_CODES.DEVICE_MISMATCH, 'device-mismatch')
            return
          }
          if (frame.contractRevision !== CONTRACT_REVISION) {
            ws.close(CLOSE_CODES.VERSION_UNSUPPORTED, 'version-unsupported')
            return
          }
          const nodeEpoch = frame.nodeEpoch
          clearHelloTimer()
          deviceOf.set(ws, device.id)
          agentsOf.set(ws, new Set(frame.agents))
          registry.attach(
            { id: device.id, name: device.name, agents: frame.agents },
            sender,
            now(),
            { connectionId, nodeEpoch },
          )
          // 节点重连后会重发快照：先清掉该设备的旧索引，已删除的会话不会残留。
          options.onAttach?.(device.id)
          const ack: HelloAckFrame = {
            v: 2, type: 'hello.ack', connectionId, hubEpoch,
            contractRevision: CONTRACT_REVISION,
            features: [...frame.features],
            nodeEpoch,
            operatorId, policyRevision,
            deviceId: device.id,
            policies: {
              privacy: 'metadata',
              questionRelay: 'off',
              approvalRelay: 'off',
              allowContent: false,
              allowInteractions: false,
              allowDiscussion: false,
            },
            serverTime: now(),
          }
          sendFrame(ws, ack)
          return
        }
        // 同设备新连接已接管槽位：旧连接上的帧一律视为过期，不能修改索引或完成新命令。
        const slot = registry.get(id)
        if (slot === undefined || slot.sender !== sender) {
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
        if (frame.type === 'event') {
          const agents = agentsOf.get(ws)
          // 只信握手绑定的身份：帧里自报的 deviceId/agent 不能冒充别的设备或未声明的 agent。
          if (frame.deviceId !== id) {
            ws.close(CLOSE_CODES.DEVICE_MISMATCH, 'device-mismatch')
            return
          }
          if (agents !== undefined && !agents.has(frame.agent)) {
            ws.close(CLOSE_CODES.FRAME_INVALID, 'frame-invalid')
            return
          }
          registry.touch(id, now())
        }
        options.onFrame?.(id, frame)
      })
    })
  }
  const closePort = options.port.open(onUpgrade)

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (alive.get(ws) === false) { ws.terminate(); continue }
      alive.set(ws, false)
      ws.ping()
    }
  }, options.heartbeatMs ?? 30_000)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      for (const helloTimer of helloTimers) clearTimeout(helloTimer)
      helloTimers.clear()
      closePort()
      for (const ws of wss.clients) ws.terminate()
      wss.close()
    },
    closeDevice(deviceId, code, reason) {
      for (const ws of wss.clients) if (deviceOf.get(ws) === deviceId) ws.close(code, reason)
    },
  }
}
