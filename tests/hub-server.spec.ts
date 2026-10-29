import { createServer, request, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { DeviceRegistry, type Sender } from '../src/hub/registry.ts'
import { mountHubSocket, nodeServerPort, type HubSocketHandle } from '../src/hub/server.ts'
import type { Frame } from '../src/wire/frames.ts'

const TOKEN = 'y'.repeat(32)
const DEVICES = [{ id: 'mac', name: 'Mac', token: TOKEN }]

const POLL_INTERVAL_MS = 30
const POLL_TIMEOUT_MS = 1_000

let active: { mounted: HubSocketHandle; server: Server } | undefined
afterEach(() => {
  active?.mounted.dispose()
  active?.server.close()
  active = undefined
})

/** 轮询直到条件成立：不用固定 sleep，失败时报出等待的是什么。 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

interface Served { readonly port: number; readonly mounted: HubSocketHandle; readonly server: Server }

async function serve(registry: DeviceRegistry, frames: Frame[] = [], devices = DEVICES): Promise<Served> {
  const server = createServer()
  const mounted = mountHubSocket({
    port: nodeServerPort(server),
    registry,
    devices,
    now: Date.now,
    onFrame: (_device, frame) => frames.push(frame),
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('server has no port')
    resolve(address.port)
  }))
  active = { mounted, server }
  return { port, mounted, server }
}

function openSocket(port: number, path: string, token: string | undefined): WebSocket {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
}

async function connect(port: number, path = '/marshal/uplink', token: string | undefined = TOKEN): Promise<WebSocket> {
  const ws = openSocket(port, path, token)
  return new Promise<WebSocket>((resolve, reject) => {
    const onOpen = (): void => { ws.off('error', onError); resolve(ws) }
    const onError = (err: Error): void => { ws.off('open', onOpen); reject(err) }
    ws.once('open', onOpen)
    ws.once('error', onError)
  })
}

/** 断言这条握手最终没有建立：既可能握手失败，也可能握手后立刻被关掉。 */
async function expectRejected(port: number, path = '/marshal/uplink', token: string | undefined = TOKEN): Promise<void> {
  const ws = openSocket(port, path, token)
  ws.on('error', () => {})
  const opened = await new Promise<boolean>(resolve => {
    ws.once('open', () => resolve(true))
    ws.once('error', () => resolve(false))
    ws.once('close', () => resolve(false))
  })
  expect(opened).toBe(false)
  await waitFor(() => ws.readyState === WebSocket.CLOSED, 'rejected socket to be closed')
}

/** 裸 HTTP 请求观察 upgrade 响应状态码，用来区分 101 与 404。 */
function upgradeStatus(port: number, path: string, extra: Record<string, string> = {}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...extra,
      },
    })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0) })
    req.on('response', res => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end()
  })
}

interface HelloOverrides { readonly device?: string; readonly token?: string; readonly agents?: readonly string[] }

function helloText(overrides: HelloOverrides = {}): string {
  return JSON.stringify({
    v: 1, type: 'hello',
    device: overrides.device ?? 'mac',
    token: overrides.token ?? TOKEN,
    agents: overrides.agents ?? ['dsh'],
  })
}

/** 建立连接、发 hello、等到 ack。 */
async function hello(registry: DeviceRegistry, port: number, overrides: HelloOverrides = {}): Promise<WebSocket> {
  const ws = await connect(port)
  ws.on('error', () => {})
  const acked = new Promise<Frame>(resolve => {
    ws.once('message', data => resolve(JSON.parse(String(data)) as Frame))
  })
  ws.send(helloText(overrides))
  const ack = await acked
  expect(ack).toMatchObject({ type: 'ack', id: 'hello', ok: true })
  await waitFor(() => registry.get('mac') !== undefined, 'device to enter registry')
  return ws
}

function closeCode(ws: WebSocket): Promise<number> {
  ws.on('error', () => {})
  return new Promise<number>(resolve => ws.once('close', code => resolve(code)))
}

/** 记录 detachIf 的返回，用来验证迟到的 close 没有摘掉新连接。 */
class SpyRegistry extends DeviceRegistry {
  readonly detaches: Array<{ id: string; removed: boolean }> = []

  override detachIf(id: string, sender: Sender): boolean {
    const removed = super.detachIf(id, sender)
    this.detaches.push({ id, removed })
    return removed
  }
}

describe('hub socket', () => {
  it('拒绝没有 token 的连接', async () => {
    const { port } = await serve(new DeviceRegistry())
    await expectRejected(port, '/marshal/uplink', undefined)
  })

  it('hello 后设备进入注册表，事件帧交给 onFrame', async () => {
    const registry = new DeviceRegistry()
    const frames: Frame[] = []
    const { port } = await serve(registry, frames)
    const ws = await hello(registry, port)
    expect(registry.get('mac')?.record.agents).toEqual(['dsh'])
    ws.send(JSON.stringify({
      v: 1, type: 'event', device: 'mac', agent: 'dsh', sessionId: 's1', seq: 1, ts: 't',
      kind: 'turn.started', payload: {},
    }))
    await waitFor(() => frames.length === 1, 'event frame to reach onFrame')
    expect(frames.map(frame => frame.type)).toEqual(['event'])
    expect(registry.get('mac')?.record.lastSeen).toBeGreaterThan(0)
    ws.close()
  })

  it('断线后设备被移除', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)
    const ws = await hello(registry, port)
    ws.terminate()
    await waitFor(() => registry.get('mac') === undefined, 'device to leave registry')
  })

  it('非 uplink 路径带有效 token 也被拒绝', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)
    expect(await upgradeStatus(port, '/not-marshal', { authorization: `Bearer ${TOKEN}` })).toBe(404)
    await expectRejected(port, '/not-marshal', TOKEN)
    expect(registry.get('mac')).toBeUndefined()
  })

  it('hello 与握手设备不一致时以 4401 关闭', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)

    const wrongToken = await connect(port)
    const wrongTokenCode = closeCode(wrongToken)
    wrongToken.send(helloText({ token: 'z'.repeat(32) }))
    expect(await wrongTokenCode).toBe(4401)

    const wrongDevice = await connect(port)
    const wrongDeviceCode = closeCode(wrongDevice)
    wrongDevice.send(helloText({ device: 'other' }))
    expect(await wrongDeviceCode).toBe(4401)

    expect(registry.get('mac')).toBeUndefined()
    expect(registry.get('other')).toBeUndefined()
  })

  it('首帧不是 hello 时以 4400 关闭', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)
    const ws = await connect(port)
    const code = closeCode(ws)
    ws.send(JSON.stringify({
      v: 1, type: 'event', device: 'mac', agent: 'dsh', sessionId: 's1', seq: 1, ts: 't',
      kind: 'turn.started', payload: {},
    }))
    expect(await code).toBe(4400)
    expect(registry.get('mac')).toBeUndefined()
  })

  it('同一设备重连后，旧连接迟到的 close 不移除新槽位', async () => {
    const registry = new SpyRegistry()
    const { port } = await serve(registry)
    const first = await hello(registry, port)
    const second = await hello(registry, port)
    // 重连已接管槽位；此时旧连接才关闭。
    first.terminate()
    await waitFor(() => registry.detaches.length === 1, 'stale close to be handled')
    expect(registry.detaches[0]).toEqual({ id: 'mac', removed: false })
    expect(registry.get('mac')).toBeDefined()
    expect(second.readyState).toBe(WebSocket.OPEN)
    second.close()
  })

  it('dispose 后不再升级，且现有连接被终止', async () => {
    const registry = new DeviceRegistry()
    const { port, mounted } = await serve(registry)
    const ws = await hello(registry, port)
    mounted.dispose()
    await waitFor(() => ws.readyState === WebSocket.CLOSED, 'existing socket to be terminated')
    await waitFor(() => registry.get('mac') === undefined, 'slot to be removed on terminate')
    await expectRejected(port)
  })
})
