import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { WebServerLike } from '../dsh-types.ts'
import { MAX_FRAME_BYTES, decodeFrame, encodeFrame, type Frame } from '../wire/frames.ts'
import type { DeviceEntry } from './devices.ts'
import type { DeviceRegistry } from './registry.ts'

export const UPLINK_PATH = '/marshal/uplink'

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

/** 常量时间比较：先取定长摘要，长度差异不落在时序上。 */
function tokenEquals(candidate: string, expected: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(expected))
}

/** 与 `devices.findByToken` 等价，但不短路、不用 `===`，供握手校验用。 */
function findDevice(devices: readonly DeviceEntry[], token: string): DeviceEntry | undefined {
  let match: DeviceEntry | undefined
  for (const entry of devices) if (tokenEquals(entry.token, token)) match = entry
  return match
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

export function mountHubSocket(options: HubSocketOptions): HubSocketHandle {
  const { registry, devices, now } = options
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  const alive = new WeakMap<WebSocket, boolean>()
  const deviceOf = new WeakMap<WebSocket, string>()

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const token = bearerToken(req)
    const device = findDevice(devices, token)
    // 握手失败只说原因码，不回显 token，也不进注册表。
    if (device === undefined) { socket.destroy(); return }

    wss.handleUpgrade(req, socket, head, ws => {
      alive.set(ws, true)
      ws.on('pong', () => alive.set(ws, true))
      ws.on('message', data => {
        let frame: Frame
        try { frame = decodeFrame(String(data)) } catch { ws.close(4400, 'frame-invalid'); return }
        if (deviceOf.get(ws) === undefined) {
          // 未发 hello 的 socket 不进注册表；hello 里的 device/token 必须与握手时那个设备一致。
          if (frame.type !== 'hello') { ws.close(4401, 'auth-failed'); return }
          if (frame.device !== device.id || !tokenEquals(frame.token, token)) { ws.close(4401, 'auth-failed'); return }
          deviceOf.set(ws, device.id)
          registry.attach({ id: device.id, name: device.name, agents: frame.agents }, { send: text => ws.send(text) }, now())
          ws.on('close', () => registry.detach(device.id))
          ws.send(encodeFrame({ v: 1, type: 'ack', id: 'hello', ok: true }))
          return
        }
        if (frame.type === 'event') registry.touch(device.id, now())
        options.onFrame?.(device.id, frame)
      })
    })
  }
  const closePort = options.port.open(onUpgrade)

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) { ws.terminate(); continue }
      alive.set(ws, false)
      ws.ping()
    }
  }, options.heartbeatMs ?? 30_000)

  return {
    dispose() {
      clearInterval(timer)
      closePort()
      for (const ws of wss.clients) ws.terminate()
      wss.close()
    },
    closeDevice(deviceId, code, reason) {
      for (const ws of wss.clients) if (deviceOf.get(ws) === deviceId) ws.close(code, reason)
    },
  }
}
