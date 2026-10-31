import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { HubRelay } from '../src/hub/relay.ts'
import { registerMarshalRoutes } from '../src/hub/api.ts'
import { createTestWeb, type TestWeb } from './support/web.ts'

let web: TestWeb | undefined
afterEach(async () => {
  const test = web
  if (test === undefined) return
  web = undefined
  await new Promise<void>(resolve => test.server.close(() => resolve()))
})

async function start() {
  const registry = new DeviceRegistry()
  registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, { send: () => {} }, 0)
  const relay = new HubRelay({ registry, now: Date.now, timeoutMs: 50 })
  relay.publish({
    v: 1, type: 'event', device: 'mac', agent: 'dsh', sessionId: 's1', seq: 1,
    ts: new Date().toISOString(), kind: 'session.updated', payload: { running: false, updatedAt: 1 },
  })
  const test = createTestWeb()
  const routes = registerMarshalRoutes({ webServer: test.webServer, registry, relay, requireToken: 'secret' })
  web = test
  const port = await test.listen()
  return { port, routes }
}

describe('hub api', () => {
  it('无 token 的页面请求返回 401', async () => {
    const { port } = await start()
    expect((await fetch(`http://127.0.0.1:${port}/marshal`)).status).toBe(401)
  })

  it('带 token 返回页面', async () => {
    const { port } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/marshal?token=secret`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('marshal')
  })

  it('x-marshal-token 头也能认证', async () => {
    const { port } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/marshal`, { headers: { 'x-marshal-token': 'secret' } })
    expect(response.status).toBe(200)
  })

  it('设备列表', async () => {
    const { port } = await start()
    const body = await (await fetch(`http://127.0.0.1:${port}/marshal/api/devices?token=secret`)).json() as { devices: { id: string }[] }
    expect(body.devices[0]?.id).toBe('mac')
  })

  it('会话索引按设备返回', async () => {
    const { port } = await start()
    const body = await (await fetch(`http://127.0.0.1:${port}/marshal/api/sessions?device=mac&token=secret`)).json() as { sessions: unknown[] }
    expect(body.sessions).toEqual([
      { device: 'mac', agent: 'dsh', sessionId: 's1', running: false, updatedAt: 1 },
    ])
  })

  it('空 device 参数等同全部会话', async () => {
    const { port } = await start()
    const body = await (await fetch(`http://127.0.0.1:${port}/marshal/api/sessions?device=&token=secret`)).json() as { sessions: unknown[] }
    expect(body.sessions).toHaveLength(1)
  })

  it('GET 指令端点返回 405 并声明 allow', async () => {
    const { port } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/marshal/api/command?token=secret`)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('发给离线设备的指令返回 409', async () => {
    const { port } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/marshal/api/command?token=secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'prompt', target: { device: 'ghost', agent: 'dsh', sessionId: 's' }, args: {}, idempotencyKey: 'k' }),
    })
    expect(response.status).toBe(409)
  })

  it('未知 op 返回 400', async () => {
    const { port } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/marshal/api/command?token=secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'explode', target: { device: 'mac', agent: 'dsh', sessionId: 's1' }, args: {}, idempotencyKey: 'k-unknown-op' }),
    })
    expect(response.status).toBe(400)
  })

  it('不接管其它路径', async () => {
    const { port } = await start()
    expect((await fetch(`http://127.0.0.1:${port}/other?token=secret`)).status).toBe(404)
  })
})
