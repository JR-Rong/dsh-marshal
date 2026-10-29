import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { NodeLink } from '../src/node/link.ts'
import type { EventFrame } from '../src/wire/frames.ts'

const TOKEN = 'z'.repeat(32)
const POLL_INTERVAL_MS = 20
const POLL_TIMEOUT_MS = 5_000

interface Harness {
  readonly wss: WebSocketServer
  readonly server: Server
  readonly port: number
  readonly received: string[]
}

let cleanups: Array<() => void> = []
afterEach(() => {
  // 后注册的先执行：先停 link，再收服务端。
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function listen(onConnection?: (wss: WebSocketServer) => void): Promise<Harness> {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const received: string[] = []
  wss.on('connection', ws => {
    ws.on('message', data => received.push(String(data)))
    onConnection?.(wss)
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

function event(seq: number): EventFrame {
  return {
    v: 1, type: 'event', device: 'mac', agent: 'dsh', sessionId: 's', seq, ts: 't',
    kind: 'turn.started', payload: {},
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

function createLink(port: number, bufferLimit?: number): NodeLink {
  const link = new NodeLink({
    url: `ws://127.0.0.1:${port}`,
    token: TOKEN,
    device: 'mac',
    agents: ['dsh'],
    ...(bufferLimit === undefined ? {} : { bufferLimit }),
  })
  cleanups.push(() => link.close())
  return link
}

describe('NodeLink', () => {
  it('连上后发送 hello', async () => {
    const { port, received } = await listen()

    const link = createLink(port, 10)
    link.start()
    await waitFor(() => received.some(text => typeOf(text) === 'hello'), 'hello frame')
    expect(received.some(text => typeOf(text) === 'hello')).toBe(true)
  })

  it('断线时缓冲事件并在上限后丢最旧', () => {
    const link = createLink(1, 2)
    link.sendEvent(event(1))
    link.sendEvent(event(2))
    link.sendEvent(event(3))
    expect(link.buffered).toBe(2)
    expect(link.dropped).toBe(1)
  })

  it('连接后先发 hello，再按序放行缓冲事件', async () => {
    const { port, received } = await listen()

    const link = createLink(port, 10)
    link.sendEvent(event(1))
    link.sendEvent(event(2))
    expect(link.buffered).toBe(2)

    link.start()
    await waitFor(() => received.length >= 3, 'hello and buffered events')
    expect(received.map(typeOf)).toEqual(['hello', 'event', 'event'])
    expect(received.slice(1).map(text => (JSON.parse(text) as { seq: number }).seq)).toEqual([1, 2])
    expect(link.buffered).toBe(0)
  })

  it('断线后按退避重连并重新发 hello', async () => {
    const { port, wss, received } = await listen()

    const link = createLink(port, 10)
    link.start()
    await waitFor(() => received.filter(text => typeOf(text) === 'hello').length === 1, 'first hello')
    for (const client of wss.clients) client.terminate()
    await waitFor(() => received.filter(text => typeOf(text) === 'hello').length >= 2, 'second hello')
  })

  it('close 幂等，关闭后不再重连且继续缓冲', async () => {
    let connections = 0
    const { port } = await listen(() => { connections += 1 })

    const link = createLink(port, 10)
    link.start()
    await waitFor(() => connections === 1, 'first connection')

    link.close()
    expect(() => link.close()).not.toThrow()
    expect(() => link.dispose()).not.toThrow()
    await new Promise<void>(resolve => { setTimeout(() => { resolve() }, 800) })
    expect(connections).toBe(1)

    link.sendEvent(event(1))
    expect(link.buffered).toBe(1)
  })
})
