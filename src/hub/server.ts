import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { WebServerLike } from '../dsh-types.ts'
import { MAX_FRAME_BYTES, decodeFrame, encodeFrame, type Frame } from '../wire/frames.ts'
import type { DeviceEntry } from './devices.ts'
import type { DeviceRegistry, Sender } from './registry.ts'

export const UPLINK_PATH = '/marshal/uplink'

/** 握手成功后多久之内必须收到合法 hello，否则断开。 */
const HELLO_TIMEOUT_MS = 10_000

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
  readonly onFrame?: (deviceId: string, frame: Frame) => void
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
    // 握手失败只说原因码，不回显 token，也不进注册表。
    if (device === undefined) { socket.destroy(); return }

    wss.handleUpgrade(req, socket, head, ws => {
      alive.set(ws, true)
      // 没有 error 监听器时，底层 socket 错误会变成 uncaught。
      ws.on('error', () => ws.terminate())
      ws.on('pong', () => alive.set(ws, true))

      const helloTimer = setTimeout(() => { ws.terminate() }, HELLO_TIMEOUT_MS)
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
        if (id !== undefined) registry.detachIf(id, sender)
      })

      ws.on('message', data => {
        let frame: Frame
        try { frame = decodeFrame(String(data)) } catch { ws.close(4400, 'frame-invalid'); return }
        const id = deviceOf.get(ws)
        if (id === undefined) {
          // 未发 hello 的 socket 不进注册表；首帧必须既是 hello，又与握手时那个设备一致。
          if (frame.type !== 'hello') { ws.close(4400, 'hello-required'); return }
          if (frame.device !== device.id || !digestEquals(sha256(frame.token), digest)) {
            ws.close(4401, 'auth-failed')
            return
          }
          clearHelloTimer()
          deviceOf.set(ws, device.id)
          registry.attach({ id: device.id, name: device.name, agents: frame.agents }, sender, now())
          sendFrame(ws, { v: 1, type: 'ack', id: 'hello', ok: true })
          return
        }
        if (frame.type === 'event') registry.touch(id, now())
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
