import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { NodeLink } from '../src/node/link.ts'
import {
  CONTRACT_REVISION, type EventFrame, type Frame,
} from '../src/wire/frames.ts'

const POLL_INTERVAL_MS = 10
const POLL_TIMEOUT_MS = 2_000
const NODE_EPOCH = 'epoch-reconnect'
const DEVICE_ID = 'mac'
const TOKEN = 't'.repeat(32)

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

function settle(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

interface Connection {
  readonly ws: WebSocket
  readonly frames: Frame[]
  readonly closeCodes: number[]
}

class LinkHub {
  readonly server: Server
  readonly wss: WebSocketServer
  readonly connections: Connection[] = []
  port = 0

  private constructor(server: Server) {
    this.server = server
    this.wss = new WebSocketServer({ server })
    this.wss.on('connection', ws => this.accept(ws))
  }

  static async start(): Promise<LinkHub> {
    const server = createServer()
    const hub = new LinkHub(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('server has no port')
    hub.port = address.port
    return hub
  }

  private accept(ws: WebSocket): void {
    const connection: Connection = { ws, frames: [], closeCodes: [] }
    this.connections.push(connection)
    ws.on('error', () => {})
    ws.on('close', code => connection.closeCodes.push(code))
    ws.on('message', data => {
      const text = String(data)
      const frame = JSON.parse(text) as Frame
      connection.frames.push(frame)
      if (frame.type === 'heartbeat') {
        ws.send(JSON.stringify({
          v: 2, type: 'heartbeat.ack', nonce: frame.nonce,
          connectionId: frame.connectionId, nodeEpoch: frame.nodeEpoch, sentAt: frame.sentAt,
        }))
        return
      }
      if (frame.type !== 'hello') return
      ws.send(JSON.stringify({
        v: 2, type: 'hello.ack',
        connectionId: `conn-${this.connections.length}`,
        hubEpoch: 'hub-reconnect',
        contractRevision: CONTRACT_REVISION,
        features: [],
        operatorId: 'op-reconnect',
        policyRevision: 1,
        deviceId: DEVICE_ID,
        nodeEpoch: frame.nodeEpoch,
        policies: {
          privacy: 'metadata', questionRelay: 'off', approvalRelay: 'off',
          allowContent: false, allowInteractions: false, allowDiscussion: false,
        },
        serverTime: 0,
      }))
    })
  }

  events(index: number): EventFrame[] {
    const connection = this.connections[index]
    if (connection === undefined) return []
    return connection.frames.filter((frame): frame is EventFrame => frame.type === 'event')
  }

  send(index: number, text: string): void {
    const connection = this.connections[index]
    if (connection !== undefined && connection.ws.readyState === WebSocket.OPEN) connection.ws.send(text)
  }

  dispose(): void {
    for (const client of this.wss.clients) client.terminate()
    this.wss.close()
    this.server.closeAllConnections()
    this.server.close()
  }
}

interface LinkHarness {
  readonly link: NodeLink
  readonly state: { syncNeeded: number; offline: number }
}

function startLink(port: number): LinkHarness {
  const state = { syncNeeded: 0, offline: 0 }
  const link = new NodeLink({
    url: `ws://127.0.0.1:${port}/marshal/uplink`,
    token: TOKEN,
    deviceId: DEVICE_ID,
    deviceName: 'Mac',
    agents: ['dsh'],
    nodeEpoch: NODE_EPOCH,
    heartbeatMs: 50,
    heartbeatTimeoutMs: 400,
    maxBackoffMs: 20,
    stableMs: 50,
    onSyncNeeded: () => { state.syncNeeded += 1 },
    onOffline: () => { state.offline += 1 },
    onError: () => {},
  })
  cleanups.push(() => link.close())
  link.start()
  return { link, state }
}

function event(seq: number): EventFrame {
  return {
    v: 2, type: 'event', deviceId: DEVICE_ID, agent: 'dsh', sessionId: 's1',
    nodeEpoch: NODE_EPOCH, seq, ts: 1, kind: 'turn.started', payload: {},
  }
}

async function online(harness: LinkHarness, syncId: string): Promise<void> {
  await waitFor(() => harness.link.state === 'syncing', 'link to enter syncing')
  expect(harness.link.beginSync(syncId)).toBe(true)
  expect(harness.link.confirmSync(syncId)).toBe(true)
  expect(harness.link.state).toBe('online')
}

describe('sync barrier across reconnect', () => {
  it('hello.ack 后只到 syncing：普通事件排队，sync.ack 前不冲刷', async () => {
    const hub = await LinkHub.start()
    cleanups.push(() => hub.dispose())
    const harness = startLink(hub.port)

    await waitFor(() => harness.link.state === 'syncing', 'syncing')
    expect(harness.state.syncNeeded).toBe(1)
    harness.link.sendEvent(event(1))
    expect(harness.link.buffered).toBe(1)

    await settle(80)
    expect(hub.events(0)).toEqual([])
    expect(harness.link.state).toBe('syncing')

    await online(harness, 'sync-1')
    await waitFor(() => hub.events(0).length === 1, 'queued event after sync.ack')
    expect(hub.events(0)[0]?.seq).toBe(1)
    expect(harness.link.buffered).toBe(0)
  })

  it('断线重连重新进入 syncing，事件继续排队直到新 sync.ack', async () => {
    const hub = await LinkHub.start()
    cleanups.push(() => hub.dispose())
    const harness = startLink(hub.port)

    await online(harness, 'sync-1')
    harness.link.sendEvent(event(1))
    await waitFor(() => hub.events(0).length === 1, 'first event')

    hub.connections[0]?.ws.close(4409, 'reconnect')
    await waitFor(() => harness.state.syncNeeded === 2 && harness.link.state === 'syncing', 'second sync')
    expect(harness.link.online).toBe(false)

    harness.link.sendEvent(event(2))
    expect(harness.link.buffered).toBe(1)
    await settle(80)
    expect(hub.events(1)).toEqual([])

    await online(harness, 'sync-2')
    await waitFor(() => hub.events(1).length === 1, 'queued event after second sync')
    expect(hub.events(1)[0]?.seq).toBe(2)
    expect(harness.link.buffered).toBe(0)
  })

  it('畸形 sync.ack 以 4409 关闭并重新握手，不进入 online', async () => {
    const hub = await LinkHub.start()
    cleanups.push(() => hub.dispose())
    const harness = startLink(hub.port)

    await waitFor(() => harness.link.state === 'syncing', 'syncing')
    // 缺 connectionId/nodeEpoch/accepted：结构不合法，必须关闭重试。
    hub.send(0, JSON.stringify({ v: 2, type: 'sync.ack', syncId: 'broken' }))
    await waitFor(() => hub.connections[0]?.closeCodes.includes(4409) ?? false, '4409 close')
    expect(harness.link.online).toBe(false)
    // 关闭后仍会重新握手并等待新的同步屏障。
    await waitFor(() => harness.state.syncNeeded >= 2, 'retry handshake')
  })
})
