import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { NodeLink, type NodeLinkOptions } from '../src/node/link.ts'
import type { EventFrame } from '../src/wire/frames.ts'

const TOKEN = 'z'.repeat(32)
const POLL_INTERVAL_MS = 20
const POLL_TIMEOUT_MS = 5_000
const HELLO_ACK = JSON.stringify({
  v: 2, type: 'hello.ack', connectionId: 'conn-1', hubEpoch: 'hub-1',
  operatorId: 'op-1', policyRevision: 0, deviceId: 'mac',
  policies: {
    privacy: 'metadata', questionRelay: 'off', approvalRelay: 'off',
    allowContent: false, allowInteractions: false, allowDiscussion: false,
  },
  serverTime: 0,
})

interface Harness {
  readonly wss: WebSocketServer
  readonly server: Server
  readonly port: number
  readonly received: string[]
}

interface ListenOptions {
  /** 默认 true：像 hub 一样收到 hello 就回 hello.ack；false 时由用例自己回。 */
  readonly ack?: boolean
  /** hello.ack 之前先下发的下行帧。 */
  readonly beforeAck?: readonly string[]
  readonly onConnection?: () => void
  /** 每条连接收到 hello 时回调，便于用例自己接管握手。 */
  readonly onHello?: (ws: WebSocket) => void
}

let cleanups: Array<() => void> = []
afterEach(() => {
  // 后注册的先执行：先停 link，再收服务端。
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function listen(options: ListenOptions = {}): Promise<Harness> {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const received: string[] = []
  wss.on('connection', ws => {
    options.onConnection?.()
    ws.on('message', data => {
      const text = String(data)
      received.push(text)
      // 只在 hello 上做握手：事件帧照旧收下。
      if (typeOf(text) !== 'hello') return
      for (const frame of options.beforeAck ?? []) ws.send(frame)
      options.onHello?.(ws)
      if ((options.ack ?? true) && ws.readyState === WebSocket.OPEN) ws.send(HELLO_ACK)
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) { reject(new Error('server has no port')); return }
      resolve(address.port)
    })
  })
  cleanups.push(() => {
    for (const client of wss.clients) client.terminate()
    wss.close()
    server.closeAllConnections()
    server.close()
  })
  return { wss, server, port, received }
}

function typeOf(text: string): string {
  return (JSON.parse(text) as { type?: string }).type ?? ''
}

function seqOf(text: string): number {
  return (JSON.parse(text) as { seq?: number }).seq ?? -1
}

function event(seq: number): EventFrame {
  return {
    v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's', nodeEpoch: 'epoch-1',
    seq, ts: 1, kind: 'turn.started', payload: {},
  }
}

/** 轮询直到条件成立：不用固定 sleep 猜握手耗时。 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(() => { resolve() }, ms) })
}

function createLink(
  port: number,
  options: Partial<Omit<NodeLinkOptions, 'url' | 'token' | 'deviceId' | 'deviceName' | 'agents'>> = {},
): NodeLink {
  const link = new NodeLink({
    url: `ws://127.0.0.1:${port}`,
    token: TOKEN,
    deviceId: 'mac',
    deviceName: 'Mac',
    agents: ['dsh'],
    ...options,
  })
  cleanups.push(() => link.close())
  return link
}

/**
 * 让 ws.send 抛错，模拟 flush 期间连接已经不可写。
 * 只在用例明确置位后生效，服务端自身的发送不受影响。
 */
function breakSends(shouldFail: () => boolean): () => void {
  const original = WebSocket.prototype.send as unknown as
    (this: WebSocket, data: unknown, ...rest: unknown[]) => void
  const spy = vi.spyOn(WebSocket.prototype, 'send')
  const install = spy.mockImplementation as unknown as
    (fn: (this: WebSocket, data: unknown, ...rest: unknown[]) => void) => void
  install.call(spy, function (this: WebSocket, data: unknown, ...rest: unknown[]): void {
    if (shouldFail()) throw new Error('socket is gone')
    original.call(this, data, ...rest)
  })
  return () => { spy.mockRestore() }
}

describe('NodeLink', () => {
  it('连上后发送 hello', async () => {
    const { port, received } = await listen()

    const link = createLink(port, { bufferLimit: 10 })
    link.start()
    await waitFor(() => received.some(text => typeOf(text) === 'hello'), 'hello frame')
    expect(received.some(text => typeOf(text) === 'hello')).toBe(true)
  })

  it('断线时缓冲事件并在上限后丢最旧', () => {
    const link = createLink(1, { bufferLimit: 2 })
    link.sendEvent(event(1))
    link.sendEvent(event(2))
    link.sendEvent(event(3))
    expect(link.buffered).toBe(2)
    expect(link.dropped).toBe(1)
  })

  it('连接后先发 hello，再按序放行缓冲事件', async () => {
    const { port, received } = await listen()

    const link = createLink(port, { bufferLimit: 10 })
    link.sendEvent(event(1))
    link.sendEvent(event(2))
    expect(link.buffered).toBe(2)

    link.start()
    await waitFor(() => received.length >= 3, 'hello and buffered events')
    expect(received.map(typeOf)).toEqual(['hello', 'event', 'event'])
    expect(received.slice(1).map(seqOf)).toEqual([1, 2])
    expect(link.buffered).toBe(0)
  })

  it('hello.ack 之前发送的事件先排队，ack 后按序放行', async () => {
    let client: WebSocket | undefined
    const { port, received } = await listen({ ack: false, onHello: ws => { client = ws } })

    const link = createLink(port, { bufferLimit: 10 })
    link.start()
    await waitFor(() => received.some(text => typeOf(text) === 'hello'), 'hello frame')

    link.sendEvent(event(1))
    link.sendEvent(event(2))
    expect(link.buffered).toBe(2)
    await settle(100)
    // hub 还没确认握手，任何事件都不能越过 hello 先发出去。
    expect(received.map(typeOf)).toEqual(['hello'])

    client?.send(HELLO_ACK)
    await waitFor(() => received.length >= 3, 'events released after ack')
    expect(received.map(typeOf)).toEqual(['hello', 'event', 'event'])
    expect(received.slice(1).map(seqOf)).toEqual([1, 2])
    expect(link.buffered).toBe(0)
  })

  it('hello.ack 之前下发的帧先排队，ack 后按序交给 onFrame', async () => {
    const frames: string[] = []
    let client: WebSocket | undefined
    const { port } = await listen({
      ack: false,
      beforeAck: [JSON.stringify(event(1)), JSON.stringify(event(2))],
      onHello: ws => { client = ws },
    })

    const link = createLink(port, { onFrame: text => frames.push(text) })
    link.start()
    await waitFor(() => client !== undefined, 'server side socket')
    await settle(100)
    expect(frames).toHaveLength(0)

    client?.send(HELLO_ACK)
    await waitFor(() => frames.length === 2, 'frames delivered after ack')
    expect(frames.map(seqOf)).toEqual([1, 2])
  })

  it('flush 时发送失败，帧留在队首并在重连后补发', async () => {
    const clients: WebSocket[] = []
    const { port, received } = await listen({ ack: false, onHello: ws => { clients.push(ws) } })

    let failSends = false
    cleanups.push(breakSends(() => failSends))

    const link = createLink(port, { bufferLimit: 10, maxBackoffMs: 40 })
    link.start()
    await waitFor(() => received.some(text => typeOf(text) === 'hello'), 'hello frame')

    link.sendEvent(event(1))
    link.sendEvent(event(2))
    clients[0]?.send(HELLO_ACK)
    // ack 已在途，此刻让发送失败：模拟 flush 时 socket 已经不可写。
    failSends = true
    await settle(100)
    expect(link.buffered).toBe(2)
    expect(received.filter(text => typeOf(text) === 'event')).toHaveLength(0)

    failSends = false
    clients[0]?.terminate()
    await waitFor(() => clients.length >= 2, 'reconnected socket')
    clients[1]?.send(HELLO_ACK)
    await waitFor(() => received.filter(text => typeOf(text) === 'event').length === 2, 'replayed events')
    expect(received.filter(text => typeOf(text) === 'event').map(seqOf)).toEqual([1, 2])
    expect(link.buffered).toBe(0)
  })

  it('断线后按退避重连并重新发 hello', async () => {
    const { port, wss, received } = await listen()

    const link = createLink(port, { bufferLimit: 10 })
    link.start()
    await waitFor(() => received.filter(text => typeOf(text) === 'hello').length === 1, 'first hello')
    for (const client of wss.clients) client.terminate()
    await waitFor(() => received.filter(text => typeOf(text) === 'hello').length >= 2, 'second hello')
  })

  it('close 幂等，关闭后不再重连也不再缓冲', async () => {
    let connections = 0
    const { port } = await listen({ onConnection: () => { connections += 1 } })

    const link = createLink(port, { bufferLimit: 10 })
    link.start()
    await waitFor(() => connections === 1, 'first connection')

    link.close()
    expect(() => link.close()).not.toThrow()
    expect(() => link.dispose()).not.toThrow()
    await settle(800)
    expect(connections).toBe(1)

    link.sendEvent(event(1))
    expect(link.buffered).toBe(0)
  })

  it('dispose 后不再拨号', async () => {
    let connections = 0
    const { port } = await listen({ onConnection: () => { connections += 1 } })

    const link = createLink(port, { maxBackoffMs: 40 })
    link.start()
    await waitFor(() => connections === 1, 'first connection')

    link.dispose()
    // 远超退避上限（40ms）后仍然只能有一次连接。
    await settle(400)
    expect(connections).toBe(1)
  })

  it('4401 关闭后停止重连，start() 可重新启动', async () => {
    let connections = 0
    const { port, received } = await listen({
      ack: false,
      onConnection: () => { connections += 1 },
      onHello: ws => ws.close(4401, 'auth-failed'),
    })

    const link = createLink(port, { maxBackoffMs: 40 })
    link.start()
    await waitFor(() => connections === 1, 'first connection')
    await waitFor(() => received.filter(text => typeOf(text) === 'hello').length === 1, 'hello frame')

    // 鉴权失败不是暂时故障：不该退避重试。
    await settle(400)
    expect(connections).toBe(1)
    expect(received.filter(text => typeOf(text) === 'hello')).toHaveLength(1)

    link.start()
    await waitFor(() => connections === 2, 'second connection after explicit start')
    expect(received.filter(text => typeOf(text) === 'hello')).toHaveLength(2)
  })

  it('重复 start 只建立一个连接', async () => {
    let connections = 0
    const { port } = await listen({ onConnection: () => { connections += 1 } })

    const link = createLink(port, { maxBackoffMs: 40 })
    link.start()
    link.start()
    link.start()
    await waitFor(() => connections === 1, 'first connection')
    await settle(150)
    expect(connections).toBe(1)
  })
})
