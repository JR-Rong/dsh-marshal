import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { HubRelay } from '../src/hub/relay.ts'
import { registerMarshalRoutes } from '../src/hub/api.ts'
import type { AckFrame, CommandStatusResultFrame } from '../src/wire/frames.ts'
import { createTestWeb, type TestWeb } from './support/web.ts'

const AUTH = { 'x-marshal-token': 'secret' }

let web: TestWeb | undefined
afterEach(async () => {
  const test = web
  if (test === undefined) return
  web = undefined
  await new Promise<void>(resolve => test.server.close(() => resolve()))
})

async function start() {
  const registry = new DeviceRegistry()
  const sent: string[] = []
  registry.attach(
    { id: 'mac', name: 'Mac', agents: ['dsh'] },
    { send: text => sent.push(text) },
    0,
    { connectionId: 'conn-1', nodeEpoch: 'epoch-1' },
  )
  const relay = new HubRelay({ registry, now: Date.now, timeoutMs: 50 })
  relay.publish({
    v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1',
    seq: 1, ts: 1, kind: 'session.updated', payload: { running: false, updatedAt: 1, cwd: '/secret-project' },
  })
  const test = createTestWeb()
  const routes = registerMarshalRoutes({ webServer: test.webServer, registry, relay, requireToken: 'secret' })
  web = test
  const port = await test.listen()
  return { port, routes, relay, sent }
}

const ORIGIN = { deviceId: 'mac', connectionId: 'conn-1', nodeEpoch: 'epoch-1' }

/** 等待 relay 写出指定类型的帧；HTTP handler 是异步启动的。 */
async function waitForFrame(sent: string[], type: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000
  for (;;) {
    for (const text of sent) {
      const frame = JSON.parse(text) as Record<string, unknown>
      if (frame.type === type) return frame
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('hub api', () => {
  it('无 token 的页面请求返回 401', async () => {
    const { port } = await start()
    expect((await fetch(`http://127.0.0.1:${port}/marshal`)).status).toBe(401)
  })

  it('带 token 头返回页面', async () => {
    const { port } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/marshal`, { headers: AUTH })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('marshal')
  })

  it('URL 查询参数 token 不再被接受', async () => {
    const { port } = await start()
    expect((await fetch(`http://127.0.0.1:${port}/marshal?token=secret`)).status).toBe(401)
  })

  it('设备列表', async () => {
    const { port } = await start()
    const body = await (await fetch(`http://127.0.0.1:${port}/marshal/api/devices`, { headers: AUTH }))
      .json() as { devices: { id: string }[] }
    expect(body.devices[0]?.id).toBe('mac')
  })

  it('会话索引按设备返回', async () => {
    const { port } = await start()
    const body = await (await fetch(`http://127.0.0.1:${port}/marshal/api/sessions?device=mac`, { headers: AUTH }))
      .json() as { sessions: unknown[] }
    expect(body.sessions).toEqual([
      { deviceId: 'mac', agent: 'dsh', sessionId: 's1', running: false, updatedAt: 1 },
    ])
  })

  it('空 device 参数等同全部会话', async () => {
    const { port } = await start()
    const body = await (await fetch(`http://127.0.0.1:${port}/marshal/api/sessions?device=`, { headers: AUTH }))
      .json() as { sessions: unknown[] }
    expect(body.sessions).toHaveLength(1)
  })

  it('GET 指令端点返回 405 并声明 allow', async () => {
    const { port } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/marshal/api/command`, { headers: AUTH })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('发给离线设备的指令返回 409', async () => {
    const { port } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/marshal/api/command`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'prompt', target: { deviceId: 'ghost', agent: 'dsh', sessionId: 's' }, args: { text: 'hi' }, idempotencyKey: 'k' }),
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'rejected', code: 'device-offline' })
  })

  it('未知 op 返回 400 invalid-args', async () => {
    const { port } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/marshal/api/command`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'explode', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, args: {}, idempotencyKey: 'k-unknown-op' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, code: 'invalid-args' })
  })

  it('非法 args 返回 400 且不进入中继', async () => {
    const { port, sent } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/marshal/api/command`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'prompt', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
        args: { text: 'hi', passthrough: true }, idempotencyKey: 'k-bad-args',
      }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, code: 'invalid-args' })
    expect(sent).toEqual([])
  })

  it('不接管其它路径', async () => {
    const { port } = await start()
    expect((await fetch(`http://127.0.0.1:${port}/other`, { headers: AUTH })).status).toBe(404)
  })

  it('同键不同载荷的第二个请求返回 409 idempotency-conflict', async () => {
    const { port, relay, sent } = await start()
    const body = (text: string): string => JSON.stringify({
      op: 'prompt', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, args: { text }, idempotencyKey: 'conflict',
    })
    const first = fetch(`http://127.0.0.1:${port}/marshal/api/command`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: body('a'),
    })
    const frame = await waitForFrame(sent, 'command')
    const second = await fetch(`http://127.0.0.1:${port}/marshal/api/command`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: body('b'),
    })
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ status: 'rejected', code: 'idempotency-conflict' })
    relay.settle({
      v: 2, type: 'ack', commandId: frame.commandId as string,
      connectionId: 'conn-1', nodeEpoch: 'epoch-1', status: 'accepted', result: { accepted: true },
    } satisfies AckFrame, ORIGIN)
    expect((await first).status).toBe(200)
  })

  it('设备断线后幂等缓存只留状态，不再回放结果正文', async () => {
    const { port, relay, sent } = await start()
    const body = JSON.stringify({
      op: 'prompt', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
      args: { text: 'hi' }, idempotencyKey: 'strip-bodies',
    })
    const first = fetch(`http://127.0.0.1:${port}/marshal/api/command`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body,
    })
    const frame = await waitForFrame(sent, 'command')
    relay.settle({
      v: 2, type: 'ack', commandId: frame.commandId as string,
      connectionId: 'conn-1', nodeEpoch: 'epoch-1', status: 'accepted',
      result: { accepted: true, cwd: '/home/secret' },
    } satisfies AckFrame, ORIGIN)
    const firstBody = await (await first).json() as { result?: unknown }
    // hub 出口只按显式白名单重建结果，未知字段（如 cwd）不透传。
    expect(firstBody.result).toEqual({ accepted: true })

    relay.deviceOffline('mac')
    const second = await fetch(`http://127.0.0.1:${port}/marshal/api/command`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body,
    })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true, status: 'accepted' })
    // 只发过一次指令：第二次命中缓存，且结果正文已被清掉。
    expect(sent.filter(text => (JSON.parse(text) as { type: string }).type === 'command')).toHaveLength(1)
  })

  it('内部失败只回分类，不回显 message', async () => {
    const { port, relay } = await start()
    relay.dispose()
    const response = await fetch(`http://127.0.0.1:${port}/marshal/api/command`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'prompt', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
        args: { text: 'sk-testtesttesttest' }, idempotencyKey: 'disposed',
      }),
    })
    expect(response.status).toBe(503)
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({ ok: false, status: 'outcome-unknown', code: 'disposed' })
    expect(JSON.stringify(body)).not.toContain('sk-testtesttesttest')
  })

  it('command-status 已知状态返回 200', async () => {
    const { port, relay, sent } = await start()
    const response = fetch(
      `http://127.0.0.1:${port}/marshal/api/command-status?deviceId=mac&agent=dsh&sessionId=s1&op=prompt&key=k1`,
      { headers: AUTH },
    )
    const frame = await waitForFrame(sent, 'command.status')
    relay.settleStatus({
      v: 2, type: 'command.status.result', requestId: frame.requestId as string, status: 'accepted',
    } satisfies CommandStatusResultFrame, ORIGIN)
    const result = await response
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ ok: true, status: 'accepted' })
  })

  it('command-status 等待/未知返回 202，无记录返回 404', async () => {
    const { port, relay, sent } = await start()
    const pending = fetch(
      `http://127.0.0.1:${port}/marshal/api/command-status?deviceId=mac&agent=dsh&sessionId=s1&op=prompt&key=pending`,
      { headers: AUTH },
    )
    const pendingFrame = await waitForFrame(sent, 'command.status')
    relay.settleStatus({
      v: 2, type: 'command.status.result', requestId: pendingFrame.requestId as string, status: 'outcome-unknown',
    } satisfies CommandStatusResultFrame, ORIGIN)
    expect((await pending).status).toBe(202)

    sent.length = 0
    const missing = fetch(
      `http://127.0.0.1:${port}/marshal/api/command-status?deviceId=mac&agent=dsh&sessionId=s1&op=prompt&key=missing`,
      { headers: AUTH },
    )
    const missingFrame = await waitForFrame(sent, 'command.status')
    relay.settleStatus({
      v: 2, type: 'command.status.result', requestId: missingFrame.requestId as string,
      status: 'outcome-unknown', code: 'record-unavailable',
    } satisfies CommandStatusResultFrame, ORIGIN)
    const result = await missing
    expect(result.status).toBe(404)
    expect(await result.json()).toEqual({ ok: false, status: 'outcome-unknown', code: 'record-unavailable' })
  })

  it('command-status 缺参数返回 400，非 GET 返回 405', async () => {
    const { port } = await start()
    expect((await fetch(`http://127.0.0.1:${port}/marshal/api/command-status?deviceId=mac`, { headers: AUTH })).status)
      .toBe(400)
    const response = await fetch(`http://127.0.0.1:${port}/marshal/api/command-status`, {
      method: 'POST', headers: AUTH,
    })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })
})
