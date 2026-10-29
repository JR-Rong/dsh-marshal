import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { mountHubSocket, nodeServerPort } from '../src/hub/server.ts'
import type { Frame } from '../src/wire/frames.ts'

const TOKEN = 'y'.repeat(32)
const DEVICES = [{ id: 'mac', name: 'Mac', token: TOKEN }]

let close: (() => void) | undefined
afterEach(() => { close?.(); close = undefined })

function serve(registry: DeviceRegistry, frames: Frame[] = []): Promise<number> {
  const server = createServer()
  const mounted = mountHubSocket({
    port: nodeServerPort(server),
    registry,
    devices: DEVICES,
    now: Date.now,
    onFrame: (_device, frame) => frames.push(frame),
  })
  return new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (typeof address === 'object' && address !== null) resolve(address.port)
  })).then(port => {
    close = () => { mounted.dispose(); server.close() }
    return port
  })
}

async function hello(port: number, token = TOKEN): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/marshal/uplink`, { headers: { authorization: `Bearer ${token}` } })
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  ws.send(JSON.stringify({ v: 1, type: 'hello', device: 'mac', token, agents: ['dsh'] }))
  await new Promise(resolve => setTimeout(resolve, 50))
  return ws
}

describe('hub socket', () => {
  it('拒绝没有 token 的连接', async () => {
    const port = await serve(new DeviceRegistry())
    const ws = new WebSocket(`ws://127.0.0.1:${port}/marshal/uplink`)
    await new Promise<void>(resolve => ws.once('close', () => resolve()))
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('hello 后设备进入注册表，事件帧交给 onFrame', async () => {
    const registry = new DeviceRegistry()
    const frames: Frame[] = []
    const port = await serve(registry, frames)
    const ws = await hello(port)
    expect(registry.get('mac')?.record.agents).toEqual(['dsh'])
    ws.send(JSON.stringify({
      v: 1, type: 'event', device: 'mac', agent: 'dsh', sessionId: 's1', seq: 1, ts: 't',
      kind: 'turn.started', payload: {},
    }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(frames.map(frame => frame.type)).toEqual(['event'])
    expect(registry.get('mac')?.record.lastSeen).toBeGreaterThan(0)
    ws.close()
  })

  it('断线后设备被移除', async () => {
    const registry = new DeviceRegistry()
    const port = await serve(registry)
    const ws = await hello(port)
    ws.terminate()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(registry.get('mac')).toBeUndefined()
  })
})
