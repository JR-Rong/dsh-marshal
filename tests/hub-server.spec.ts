import { createServer, request, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { DeviceStore, sha256Hex, serializeDevicesState, type DeviceRecord } from '../src/hub/devices.ts'
import { DeviceRegistry, type Sender } from '../src/hub/registry.ts'
import { HubRelay } from '../src/hub/relay.ts'
import { mountHubSocket, nodeServerPort, type HubSocketHandle } from '../src/hub/server.ts'
import { createHubSync, type HubSync } from '../src/hub/sync.ts'
import { CONTRACT_REVISION, type Frame } from '../src/wire/frames.ts'
import { buildSyncChunks, syncChecksum } from '../src/wire/sync.ts'

const TOKEN = 'y'.repeat(32)
const OPERATOR_ID = 'operator-test-0123456789abcdef0123456789abcdef'
const HUB_EPOCH = 'hub-epoch-test'
const DEVICE_ID = 'mac'

const DEVICE: DeviceRecord = {
  id: DEVICE_ID,
  name: 'Mac',
  tokenDigest: sha256Hex(TOKEN),
  revoked: false,
  allowContent: false,
  allowInteractions: false,
  allowDiscussion: false,
  policyRevision: 1,
}

const POLL_INTERVAL_MS = 30
const POLL_TIMEOUT_MS = 1_000

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** 轮询直到条件成立：不用固定 sleep，失败时报出等待的是什么。 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

interface Served {
  readonly port: number
  readonly mounted: HubSocketHandle
  readonly server: Server
  readonly store: DeviceStore
  readonly devicesPath: string
}

interface ServeOptions {
  readonly helloTimeoutMs?: number
  readonly heartbeatMs?: number
  readonly heartbeatTimeoutMs?: number
  readonly livenessCheckMs?: number
  readonly maxPendingHellos?: number
  readonly watchDevices?: boolean
  readonly pollMs?: number
  readonly sync?: HubSync
}

function writeStore(records: readonly DeviceRecord[] = [DEVICE]): { store: DeviceStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-hub-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'devices.json')
  writeFileSync(path, serializeDevicesState({ version: 2, devices: records }), { mode: 0o600 })
  return { store: new DeviceStore(path), path }
}

async function serve(
  registry: DeviceRegistry,
  frames: Frame[] = [],
  records: readonly DeviceRecord[] = [DEVICE],
  options: ServeOptions = {},
): Promise<Served> {
  const { store, path } = writeStore(records)
  // 卸载 upgrade handler 后，未匹配请求仍由宿主返回，而不是悬空等待。
  const server = createServer((_req, res) => { res.writeHead(404).end() })
  const mounted = mountHubSocket({
    port: nodeServerPort(server),
    registry,
    store,
    operatorId: OPERATOR_ID,
    hubEpoch: HUB_EPOCH,
    now: Date.now,
    watchDevices: false,
    onFrame: (_device, frame) => frames.push(frame),
    ...options,
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('server has no port')
    resolve(address.port)
  }))
  cleanups.push(() => {
    mounted.dispose()
    server.closeAllConnections?.()
    server.close()
  })
  return { port, mounted, server, store, devicesPath: path }
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
async function expectRejected(port: number, path: string, token: string | undefined): Promise<void> {
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

/** 裸 HTTP 请求观察 upgrade 响应状态码，用来区分 101 与 404/401/503。 */
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

/** 原始 socket 发请求行：http.request 会在客户端就拒绝带空格的 path，够不到服务端 parser。 */
function rawUpgrade(port: number, requestTarget: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${requestTarget} HTTP/1.1\r\n`
        + 'Host: 127.0.0.1\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + `Authorization: Bearer ${TOKEN}\r\n\r\n`,
      )
    })
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => { text += chunk })
    socket.on('end', () => resolve(text))
    socket.on('close', () => resolve(text))
    socket.on('error', reject)
  })
}

interface HelloOverrides {
  readonly deviceId?: string
  readonly contractRevision?: string
  readonly nodeEpoch?: string
  readonly agents?: readonly string[]
  readonly operatorId?: string
  readonly policyRevision?: number
  readonly privacy?: 'metadata' | 'content'
}

function helloText(overrides: HelloOverrides = {}): string {
  const previous = overrides.operatorId === undefined
    ? {}
    : { operatorId: overrides.operatorId, policyRevision: overrides.policyRevision ?? 1 }
  return JSON.stringify({
    v: 2, type: 'hello',
    contractRevision: overrides.contractRevision ?? CONTRACT_REVISION,
    deviceId: overrides.deviceId ?? DEVICE_ID,
    deviceName: 'Mac',
    nodeEpoch: overrides.nodeEpoch ?? 'epoch-1',
    agents: overrides.agents ?? ['dsh'],
    features: [],
    ...(overrides.privacy === undefined ? {} : { privacy: overrides.privacy }),
    ...previous,
  })
}

/** 建立连接、发 hello、等到 ack。 */
async function hello(
  registry: DeviceRegistry,
  port: number,
  overrides: HelloOverrides = {},
  path = '/marshal/uplink',
): Promise<WebSocket> {
  const { ws } = await helloWithAck(registry, port, overrides, path)
  return ws
}

async function helloWithAck(
  registry: DeviceRegistry,
  port: number,
  overrides: HelloOverrides = {},
  path = '/marshal/uplink',
): Promise<{ ws: WebSocket; ack: Frame }> {
  const ws = await connect(port, path)
  ws.on('error', () => {})
  const acked = new Promise<Frame>(resolve => {
    ws.once('message', data => resolve(JSON.parse(String(data)) as Frame))
  })
  ws.send(helloText(overrides))
  const ack = await acked
  expect(ack).toMatchObject({
    type: 'hello.ack', deviceId: DEVICE_ID, nodeEpoch: 'epoch-1',
    contractRevision: CONTRACT_REVISION, features: [],
  })
  await waitFor(() => registry.get(DEVICE_ID) !== undefined, 'device to enter registry')
  return { ws, ack }
}

function closeCode(ws: WebSocket): Promise<number> {
  ws.on('error', () => {})
  return new Promise<number>(resolve => ws.once('close', code => resolve(code)))
}

function closeReason(ws: WebSocket): Promise<string> {
  ws.on('error', () => {})
  return new Promise<string>(resolve => ws.once('close', (_code, reason) => resolve(reason.toString())))
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
    expect(await upgradeStatus(port, '/marshal/uplink')).toBe(401)
  })

  it('hello 后设备进入注册表，事件帧交给 onFrame', async () => {
    const registry = new DeviceRegistry()
    const frames: Frame[] = []
    const { port } = await serve(registry, frames)
    const ws = await hello(registry, port)
    expect(registry.get(DEVICE_ID)?.record.agents).toEqual(['dsh'])
    ws.send(JSON.stringify({
      v: 2, type: 'event', deviceId: DEVICE_ID, agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1',
      seq: 1, ts: 1, kind: 'turn.started', payload: {},
    }))
    await waitFor(() => frames.length === 1, 'event frame to reach onFrame')
    expect(frames.map(frame => frame.type)).toEqual(['event'])
    expect(registry.get(DEVICE_ID)?.record.lastSeen).toBeGreaterThan(0)
    ws.close()
  })

  it('sync 屏障：提交前事件被拒，重复丢弃，缺口以 4409 关闭', async () => {
    const registry = new DeviceRegistry()
    const frames: Frame[] = []
    const relay = new HubRelay({ registry, now: Date.now })
    const sync = createHubSync({ relay, now: Date.now })
    cleanups.push(() => { sync.dispose(); relay.dispose() })
    const { port } = await serve(registry, frames, [DEVICE], { sync })
    const { ws, ack } = await helloWithAck(registry, port)
    if (ack.type !== 'hello.ack') throw new Error('expected hello.ack')

    const syncId = 'sync-1'
    const rows = [{ sessionId: 's1', agent: 'dsh', running: false, updatedAt: 1 }]
    const chunks = buildSyncChunks(rows)
    const syncAck = new Promise<Frame>(resolve => {
      const onMessage = (data: unknown): void => {
        const frame = JSON.parse(String(data)) as Frame
        if (frame.type !== 'sync.ack') return
        ws.off('message', onMessage)
        resolve(frame)
      }
      ws.on('message', onMessage)
    })
    ws.send(JSON.stringify({
      v: 2, type: 'sync.begin', syncId, nodeEpoch: 'epoch-1', connectionId: ack.connectionId,
      scope: { agents: ['dsh'], sessions: ['s1'] }, version: 1,
      chunkCount: chunks.length, highWatermark: 5,
    }))
    chunks.forEach((chunk, index) => ws.send(JSON.stringify({
      v: 2, type: 'sync.chunk', syncId, nodeEpoch: 'epoch-1',
      connectionId: ack.connectionId, index, total: chunks.length, rows: chunk,
    })))
    ws.send(JSON.stringify({
      v: 2, type: 'sync.end', syncId, nodeEpoch: 'epoch-1',
      connectionId: ack.connectionId, checksum: syncChecksum(chunks),
    }))
    expect(await syncAck).toMatchObject({ type: 'sync.ack', syncId, accepted: true, version: 1 })

    const event = (seq: number): string => JSON.stringify({
      v: 2, type: 'event', deviceId: DEVICE_ID, agent: 'dsh', sessionId: 's1',
      nodeEpoch: 'epoch-1', seq, ts: 1, kind: 'turn.started', payload: {},
    })
    ws.send(event(1))
    await waitFor(() => frames.length === 1, 'accepted event')
    ws.send(event(1))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(frames).toHaveLength(1)

    const reason = closeReason(ws)
    const code = closeCode(ws)
    ws.send(event(3))
    expect(await code).toBe(4409)
    expect(await reason).toBe('sync-gap')
    expect(frames).toHaveLength(1)
  })

  it('hello.ack 绑定 operator、connection 与设备策略', async () => {
    const registry = new DeviceRegistry()
    const record: DeviceRecord = {
      ...DEVICE, allowContent: true, allowInteractions: true, allowDiscussion: true, policyRevision: 4,
    }
    const { port } = await serve(registry, [], [record])
    const { ws, ack } = await helloWithAck(registry, port, { privacy: 'content' })
    expect(ack).toMatchObject({
      type: 'hello.ack',
      operatorId: OPERATOR_ID,
      policyRevision: 4,
      hubEpoch: HUB_EPOCH,
      policies: {
        privacy: 'content',
        allowContent: true,
        allowInteractions: true,
        allowDiscussion: true,
      },
    })
    if (ack.type === 'hello.ack') expect(ack.connectionId).not.toBe('')
    ws.close()
  })

  it('错代次 ACK 不关闭连接，交给 relay 做绑定校验', async () => {
    const registry = new DeviceRegistry()
    const frames: Frame[] = []
    const { port } = await serve(registry, frames)
    const { ws, ack } = await helloWithAck(registry, port)
    if (ack.type !== 'hello.ack') throw new Error('expected hello.ack')
    ws.send(JSON.stringify({
      v: 2, type: 'ack', commandId: 'c1', connectionId: 'other-connection', nodeEpoch: 'epoch-1',
      status: 'accepted',
    }))
    await waitFor(() => frames.length === 1, 'mismatched ack to reach relay')
    // 连接仍可用；relay 依据传入的连接身份拒绝结算。
    expect(frames[0]?.type).toBe('ack')
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('HEARTBEAT.ack 必须匹配当前连接与未应答 nonce', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry, [], [DEVICE], { heartbeatMs: 20, heartbeatTimeoutMs: 90, livenessCheckMs: 10 })
    const { ws, ack } = await helloWithAck(registry, port)
    if (ack.type !== 'hello.ack') throw new Error('expected hello.ack')
    const hubHeartbeat = await new Promise<Frame>(resolve => {
      const onMessage = (data: unknown): void => {
        const frame = JSON.parse(String(data)) as Frame
        if (frame.type === 'heartbeat') { ws.off('message', onMessage); resolve(frame) }
      }
      ws.on('message', onMessage)
    })
    if (hubHeartbeat.type !== 'heartbeat') throw new Error('expected heartbeat')
    // 错误 nonce 不刷新，连接最终因无有效 ack 被断开。
    ws.send(JSON.stringify({
      v: 2, type: 'heartbeat.ack', nonce: 'wrong',
      connectionId: ack.connectionId, nodeEpoch: 'epoch-1', sentAt: hubHeartbeat.sentAt,
    }))
    const code = await closeCode(ws)
    expect(code).toBe(1006)
    await waitFor(() => registry.get(DEVICE_ID) === undefined, 'device removed after heartbeat timeout')
  })

  it('事件的 nodeEpoch 不是当前代次时以 4409 关闭', async () => {
    const registry = new DeviceRegistry()
    const frames: Frame[] = []
    const { port } = await serve(registry, frames)
    const ws = await hello(registry, port)
    const code = closeCode(ws)
    ws.send(JSON.stringify({
      v: 2, type: 'event', deviceId: DEVICE_ID, agent: 'dsh', sessionId: 's1', nodeEpoch: 'old-epoch',
      seq: 1, ts: 1, kind: 'turn.started', payload: {},
    }))
    expect(await code).toBe(4409)
    expect(frames).toEqual([])
  })

  it('heartbeat 回显 nonce/connectionId/nodeEpoch', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)
    const { ws, ack } = await helloWithAck(registry, port)
    if (ack.type !== 'hello.ack') throw new Error('expected hello.ack')
    const acked = new Promise<Frame>(resolve => {
      ws.once('message', data => resolve(JSON.parse(String(data)) as Frame))
    })
    ws.send(JSON.stringify({
      v: 2, type: 'heartbeat', nonce: 'n-1', connectionId: ack.connectionId,
      nodeEpoch: 'epoch-1', sentAt: 10,
    }))
    const heartbeatAck = await acked
    expect(heartbeatAck).toEqual({
      v: 2, type: 'heartbeat.ack', nonce: 'n-1',
      connectionId: ack.connectionId, nodeEpoch: 'epoch-1', sentAt: 10,
    })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('15s 内没有应用心跳即断开（测试缩短期限）', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry, [], [DEVICE], { heartbeatTimeoutMs: 80, livenessCheckMs: 20 })
    const ws = await hello(registry, port)
    const closed = new Promise<boolean>(resolve => ws.once('close', () => resolve(true)))
    expect(await closed).toBe(true)
    await waitFor(() => registry.get(DEVICE_ID) === undefined, 'device to leave registry')
  })

  it('设备表热加载撤销后 4401 关闭且新连接 401', async () => {
    const registry = new DeviceRegistry()
    const { port, store } = await serve(registry, [], [DEVICE], { watchDevices: true, pollMs: 20 })
    const ws = await hello(registry, port)
    const code = closeCode(ws)
    store.revoke(DEVICE_ID)
    expect(await code).toBe(4401)
    expect(await upgradeStatus(port, '/marshal/uplink', { authorization: `Bearer ${TOKEN}` })).toBe(401)
  })

  it('设备表热加载策略变更以 4409 要求重新握手', async () => {
    const registry = new DeviceRegistry()
    const { port, store } = await serve(registry, [], [DEVICE], { watchDevices: true, pollMs: 20 })
    const ws = await hello(registry, port)
    const code = closeCode(ws)
    store.setPolicy(DEVICE_ID, { allowContent: true })
    expect(await code).toBe(4409)
  })

  it('节点自报更高 policyRevision 只隔离该设备', async () => {
    const registry = new DeviceRegistry()
    const record: DeviceRecord = { ...DEVICE, policyRevision: 2 }
    const { port } = await serve(registry, [], [record])
    const ws = await connect(port)
    const reason = closeReason(ws)
    const code = closeCode(ws)
    ws.send(helloText({ operatorId: OPERATOR_ID, policyRevision: 3 }))
    expect(await reason).toBe('recovery-required')
    // 4409 可重试：节点修正后能重新握手，而不是被 4406 永久拒绝。
    expect(await code).toBe(4409)
    expect(registry.get(DEVICE_ID)).toBeUndefined()
  })

  it('事件里的 device 与握手身份不一致时以 4403 关闭', async () => {
    const registry = new DeviceRegistry()
    const frames: Frame[] = []
    const { port } = await serve(registry, frames)
    const ws = await hello(registry, port)
    const code = closeCode(ws)
    ws.send(JSON.stringify({
      v: 2, type: 'event', deviceId: 'other', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1',
      seq: 1, ts: 1, kind: 'turn.started', payload: {},
    }))
    expect(await code).toBe(4403)
    expect(frames).toEqual([])
  })

  it('事件里的 agent 未在 hello 中声明时以 4400 关闭', async () => {
    const registry = new DeviceRegistry()
    const frames: Frame[] = []
    const { port } = await serve(registry, frames)
    const ws = await hello(registry, port)
    const code = closeCode(ws)
    ws.send(JSON.stringify({
      v: 2, type: 'event', deviceId: DEVICE_ID, agent: 'codex', sessionId: 's1', nodeEpoch: 'epoch-1',
      seq: 1, ts: 1, kind: 'turn.started', payload: {},
    }))
    expect(await code).toBe(4400)
    expect(frames).toEqual([])
  })

  it('断线后设备被移除', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)
    const ws = await hello(registry, port)
    ws.terminate()
    await waitFor(() => registry.get(DEVICE_ID) === undefined, 'device to leave registry')
  })

  it('非 uplink 路径带有效 token 也被拒绝', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)
    expect(await upgradeStatus(port, '/not-marshal', { authorization: `Bearer ${TOKEN}` })).toBe(404)
    await expectRejected(port, '/not-marshal', TOKEN)
    expect(registry.get(DEVICE_ID)).toBeUndefined()
  })

  it('hello 与握手设备不一致时以 4403 关闭', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)

    const wrongDevice = await connect(port)
    const wrongDeviceCode = closeCode(wrongDevice)
    wrongDevice.send(helloText({ deviceId: 'other' }))
    expect(await wrongDeviceCode).toBe(4403)

    expect(registry.get(DEVICE_ID)).toBeUndefined()
    expect(registry.get('other')).toBeUndefined()
  })

  it('契约修订不匹配时以 4406 关闭', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)

    const stale = await connect(port)
    const code = closeCode(stale)
    stale.send(helloText({ contractRevision: 'p1-review-1' }))
    expect(await code).toBe(4406)
    expect(registry.get(DEVICE_ID)).toBeUndefined()
  })

  it('首帧不是 hello 时以 4400 关闭', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)
    const ws = await connect(port)
    const code = closeCode(ws)
    ws.send(JSON.stringify({
      v: 2, type: 'event', deviceId: DEVICE_ID, agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1',
      seq: 1, ts: 1, kind: 'turn.started', payload: {},
    }))
    expect(await code).toBe(4400)
    expect(registry.get(DEVICE_ID)).toBeUndefined()
  })

  it('同一设备重连后，旧连接迟到的 close 不移除新槽位', async () => {
    const registry = new SpyRegistry()
    const { port } = await serve(registry)
    const first = await hello(registry, port)
    const second = await hello(registry, port)
    // 重连已接管槽位；此时旧连接才关闭。
    first.terminate()
    await waitFor(() => registry.detaches.length === 1, 'stale close to be handled')
    expect(registry.detaches[0]).toEqual({ id: DEVICE_ID, removed: false })
    expect(registry.get(DEVICE_ID)).toBeDefined()
    expect(second.readyState).toBe(WebSocket.OPEN)
    second.close()
  })

  it('被替换连接上的帧以 4409 stale-connection 关闭', async () => {
    const registry = new DeviceRegistry()
    const frames: Frame[] = []
    const { port } = await serve(registry, frames)
    const first = await hello(registry, port)
    const second = await hello(registry, port)
    const code = closeCode(first)
    first.send(JSON.stringify({
      v: 2, type: 'event', deviceId: DEVICE_ID, agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1',
      seq: 1, ts: 1, kind: 'turn.started', payload: {},
    }))
    expect(await code).toBe(4409)
    expect(frames).toEqual([])
    expect(registry.get(DEVICE_ID)).toBeDefined()
    second.close()
  })

  it('dispose 后不再升级，且现有连接被终止', async () => {
    const registry = new DeviceRegistry()
    const { port, mounted } = await serve(registry)
    const ws = await hello(registry, port)
    mounted.dispose()
    await waitFor(() => ws.readyState === WebSocket.CLOSED, 'existing socket to be terminated')
    await waitFor(() => registry.get(DEVICE_ID) === undefined, 'slot to be removed on terminate')
    await expectRejected(port, '/marshal/uplink', TOKEN)
  })

  it('带查询串的合法路径仍能握手', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)
    const ws = await hello(registry, port, {}, '/marshal/uplink?x=1')
    expect(registry.get(DEVICE_ID)?.record.agents).toEqual(['dsh'])
    ws.close()
  })

  it('绝对 URL 目标只按 pathname 判定', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)
    const auth = { authorization: `Bearer ${TOKEN}` }
    // 同 host、不同 pathname：仍然 404。
    expect(await upgradeStatus(port, 'http://example.com/other', auth)).toBe(404)
    // 绝对 URL 但 pathname 恰好是 uplink：放行。
    expect(await upgradeStatus(port, 'http://example.com/marshal/uplink', auth)).toBe(101)
    await waitFor(() => registry.get(DEVICE_ID) === undefined, 'unauthenticated upgrade to stay out of registry')
  })

  it('畸形 req.url 不产生未捕获异常，也不升级', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry)
    const uncaught: unknown[] = []
    const onUncaught = (err: unknown): void => { uncaught.push(err) }
    process.on('uncaughtException', onUncaught)
    try {
      // 空格 path 在客户端就被 Node 拒绝，服务端收不到；原始请求行才能覆盖 parser 与 pathname 解析。
      const spaced = (): void => {
        request({ host: '127.0.0.1', port, path: 'not a url' }).on('error', () => {}).end()
      }
      expect(spaced).toThrow()
      // 请求行本身非法：parser 直接 400，不会进 upgrade。
      expect(await rawUpgrade(port, 'not a url')).not.toContain('101')
      // 请求行合法但不是合法 URL：pathnameOf 走 catch，回 404。
      expect(await rawUpgrade(port, 'http://')).toContain('404')
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    expect(uncaught).toEqual([])
    expect(registry.get(DEVICE_ID)).toBeUndefined()
  })

  it('未完成 hello 的 socket 超过上限时以 4408 立即关闭', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry, [], [DEVICE], { maxPendingHellos: 1 })
    const first = await connect(port)
    const second = await connect(port)
    const code = closeCode(second)
    expect(await code).toBe(4408)
    expect(registry.get(DEVICE_ID)).toBeUndefined()
    first.terminate()
  })

  it('hello 超时后以 4408 关闭', async () => {
    const registry = new DeviceRegistry()
    const { port } = await serve(registry, [], [DEVICE], { helloTimeoutMs: 50 })
    const started = Date.now()
    const ws = await connect(port)
    ws.on('error', () => {})
    const code = closeCode(ws)
    expect(await code).toBe(4408)
    expect(Date.now() - started).toBeLessThan(1_000)
    await waitFor(() => ws.readyState === WebSocket.CLOSED, 'socket to be closed after hello timeout')
    expect(registry.get(DEVICE_ID)).toBeUndefined()
  })
})
