import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { HubRelay } from '../src/hub/relay.ts'
import { registerMarshalRoutes, SESSION_COOKIE, CSRF_COOKIE } from '../src/hub/api.ts'
import type { AckFrame, CommandStatusResultFrame, InputsSnapshotResultFrame } from '../src/wire/frames.ts'
import { createMemoryWeb, type MemoryResponse, type MemoryWeb } from './support/memory.ts'

const TOKEN = 'test-dashboard-token-0123456789abcdef'
const ORIGIN = 'https://marshal.example'
const AUTH = { 'x-marshal-token': TOKEN }

let web: MemoryWeb | undefined
let routes: { dispose(): void } | undefined
afterEach(() => {
  routes?.dispose()
  routes = undefined
  web = undefined
})

async function start(options: {
  sessionIdleMs?: number
  sessionAbsoluteMs?: number
  sessionSweepMs?: number
  now?: () => number
} = {}) {
  const registry = new DeviceRegistry()
  const sent: string[] = []
  registry.attach(
    { id: 'mac', name: 'Mac', agents: ['dsh'] },
    { send: text => sent.push(text) },
    0,
    { connectionId: 'conn-1', nodeEpoch: 'epoch-1' },
  )
  const relay = new HubRelay({ registry, now: options.now ?? Date.now, timeoutMs: 50 })
  relay.publish({
    v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1',
    seq: 1, ts: 1, kind: 'session.updated', payload: { running: false, updatedAt: 1, cwd: '/secret-project' },
  })
  const test = createMemoryWeb()
  routes = registerMarshalRoutes({
    webServer: test.webServer,
    registry,
    relay,
    requireToken: TOKEN,
    publicOrigin: ORIGIN,
    operatorId: 'operator-test',
    hubEpoch: 'hub-test',
    loginFailureDelayMs: 0,
    ...(options.sessionIdleMs === undefined ? {} : { sessionIdleMs: options.sessionIdleMs }),
    ...(options.sessionAbsoluteMs === undefined ? {} : { sessionAbsoluteMs: options.sessionAbsoluteMs }),
    ...(options.sessionSweepMs === undefined ? {} : { sessionSweepMs: options.sessionSweepMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  web = test
  return { web: test, relay, sent }
}

const ORIGIN_FRAME = { deviceId: 'mac', connectionId: 'conn-1', nodeEpoch: 'epoch-1' }

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

async function login(target: MemoryWeb): Promise<{ response: MemoryResponse; session: string; csrf: string }> {
  const response = await target.request('/marshal/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  })
  return { response, session: response.cookie(SESSION_COOKIE) ?? '', csrf: response.cookie(CSRF_COOKIE) ?? '' }
}

function sessionHeaders(session: string, csrf: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`,
    origin: ORIGIN,
    'x-marshal-csrf': csrf,
    'content-type': 'application/json',
    ...extra,
  }
}

describe('hub api auth', () => {
  it('登录页公开，URL token 被拒绝', async () => {
    const { web: target } = await start()
    const page = await target.request('/marshal')
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('marshal')
    expect((await target.request('/marshal?token=' + TOKEN)).statusCode).toBe(401)
    expect((await target.request('/marshal/api/devices?x-marshal-token=' + TOKEN)).statusCode).toBe(401)
  })

  it('登录必须精确 Origin，成功签发 __Host- cookie', async () => {
    const { web: target } = await start()
    expect((await target.request('/marshal/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
    })).statusCode).toBe(403)
    expect((await target.request('/marshal/login', {
      method: 'POST', headers: { origin: 'null', 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
    })).statusCode).toBe(403)

    const { response, session, csrf } = await login(target)
    expect(response.statusCode).toBe(200)
    expect(response.header('cache-control')).toBe('no-store')
    const body = response.json<{ ok: boolean; operatorId: string; csrf: string; expiresAt: number }>()
    expect(body.operatorId).toBe('operator-test')
    expect(body.csrf).toBe(csrf)
    expect(body.expiresAt).toBeGreaterThan(Date.now())
    const cookies = response.cookies()
    expect(cookies.find(value => value.startsWith(`${SESSION_COOKIE}=`))).toContain('HttpOnly')
    expect(cookies.find(value => value.startsWith(`${SESSION_COOKIE}=`))).toContain('Secure')
    expect(cookies.find(value => value.startsWith(`${SESSION_COOKIE}=`))).toContain('SameSite=Strict')
    expect(cookies.find(value => value.startsWith(`${SESSION_COOKIE}=`))).not.toContain('Domain')
    expect(cookies.find(value => value.startsWith(`${CSRF_COOKIE}=`))).not.toContain('HttpOnly')
    expect(session).not.toBe(csrf)
  })

  it('会话恢复返回同样信息且不续期', async () => {
    let clock = 1_000
    const { web: target } = await start({ sessionIdleMs: 100, now: () => clock })
    const { session, csrf } = await login(target)
    clock = 1_080
    const restored = await target.request('/marshal/api/session', { headers: { cookie: `${SESSION_COOKIE}=${session}` } })
    expect(restored.statusCode).toBe(200)
    expect(restored.json<{ csrf: string }>().csrf).toBe(csrf)
    expect(restored.header('cache-control')).toBe('no-store')
    // session 端点不刷新 lastSeenAt：再过 50ms 超过 30min 空闲上限的缩小版。
    clock = 1_130
    const expired = await target.request('/marshal/api/session', { headers: { cookie: `${SESSION_COOKIE}=${session}` } })
    expect(expired.statusCode).toBe(401)
  })

  it('无效 header 不回退 cookie，混合凭据拒绝', async () => {
    const { web: target } = await start()
    const { session, csrf } = await login(target)
    const cookie = `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`
    expect((await target.request('/marshal/api/devices', {
      headers: { cookie, 'x-marshal-token': 'wrong' },
    })).statusCode).toBe(401)
    expect((await target.request('/marshal/api/devices', {
      headers: { cookie, 'x-marshal-token': TOKEN },
    })).statusCode).toBe(401)
    expect((await target.request('/marshal/api/devices', { headers: AUTH })).statusCode).toBe(200)
    expect((await target.request('/marshal/api/devices', {
      headers: { 'x-marshal-token': 'wrong' },
    })).statusCode).toBe(401)
    expect((await target.request('/marshal/api/devices')).statusCode).toBe(401)
  })

  it('token 分支写操作免 CSRF；有 Origin 时必须精确匹配', async () => {
    const { web: target } = await start()
    const body = JSON.stringify({
      op: 'prompt', target: { deviceId: 'ghost', agent: 'dsh', sessionId: 's' },
      args: { text: 'hi' }, idempotencyKey: 'k-token',
    })
    const offline = await target.request('/marshal/api/command', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body,
    })
    expect(offline.statusCode).toBe(503)
    const badOrigin = await target.request('/marshal/api/command', {
      method: 'POST', headers: { ...AUTH, origin: 'https://evil.example', 'content-type': 'application/json' }, body,
    })
    expect(badOrigin.statusCode).toBe(403)
    const goodOrigin = await target.request('/marshal/api/command', {
      method: 'POST', headers: { ...AUTH, origin: ORIGIN, 'content-type': 'application/json' }, body,
    })
    expect(goodOrigin.statusCode).toBe(503)
  })

  it('浏览器写操作要求 Origin 与服务端会话 CSRF', async () => {
    const { web: target } = await start()
    const { session, csrf } = await login(target)
    const body = JSON.stringify({
      op: 'prompt', target: { deviceId: 'ghost', agent: 'dsh', sessionId: 's' },
      args: { text: 'hi' }, idempotencyKey: 'k-csrf',
    })
    const noCsrf = await target.request('/marshal/api/command', {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, 'content-type': 'application/json' }, body,
    })
    expect(noCsrf.statusCode).toBe(403)
    const wrongCsrf = await target.request('/marshal/api/command', {
      method: 'POST',
      headers: sessionHeaders(session, csrf, { 'x-marshal-csrf': 'A'.repeat(43) }),
      body,
    })
    expect(wrongCsrf.statusCode).toBe(403)
    const noOrigin = await target.request('/marshal/api/command', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`, 'x-marshal-csrf': csrf, 'content-type': 'application/json' },
      body,
    })
    expect(noOrigin.statusCode).toBe(403)
    const ok = await target.request('/marshal/api/command', {
      method: 'POST', headers: sessionHeaders(session, csrf), body,
    })
    expect(ok.statusCode).toBe(503)
  })

  it('logout 撤销会话、清 cookie 并关闭关联 SSE', async () => {
    const { web: target } = await start()
    const { session, csrf } = await login(target)
    const stream = target.start('/marshal/api/stream', {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(stream.res.statusCode).toBe(200)
    const logout = await target.request('/marshal/logout', {
      method: 'POST', headers: sessionHeaders(session, csrf), body: '{}',
    })
    expect(logout.statusCode).toBe(200)
    expect(logout.cookies().every(value => value.includes('Max-Age=0'))).toBe(true)
    expect(stream.res.writableEnded).toBe(true)
    expect((await target.request('/marshal/api/session', {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    })).statusCode).toBe(401)
    await stream.done
  })

  it('会话到期后旧 SSE 在扫描周期内关闭', async () => {
    let clock = 1_000
    const { web: target } = await start({ sessionIdleMs: 50, sessionSweepMs: 10, now: () => clock })
    const { session } = await login(target)
    const stream = target.start('/marshal/api/stream', { headers: { cookie: `${SESSION_COOKIE}=${session}` } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(stream.res.writableEnded).toBe(false)
    clock = 1_100
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(stream.res.writableEnded).toBe(true)
    await stream.done
  })

  it('登录失败按来源限速', async () => {
    const { web: target } = await start()
    const attempt = () => target.request('/marshal/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' }),
      remoteAddress: '192.0.2.10',
    })
    for (let index = 0; index < 5; index += 1) expect((await attempt()).statusCode).toBe(401)
    const blocked = await attempt()
    expect(blocked.statusCode).toBe(429)
    expect(Number(blocked.header('retry-after'))).toBeGreaterThan(0)
  })

  it('方法不符返回 405 并声明 allow', async () => {
    const { web: target } = await start()
    const { session, csrf } = await login(target)
    const headers = sessionHeaders(session, csrf)
    const cases: [string, string, string][] = [
      ['/marshal/login', 'GET', 'POST'],
      ['/marshal/logout', 'GET', 'POST'],
      ['/marshal/api/session', 'POST', 'GET'],
      ['/marshal/api/command', 'GET', 'POST'],
      ['/marshal/api/command-status', 'POST', 'GET'],
      ['/marshal/api/inputs', 'GET', 'POST'],
      ['/marshal/api/history', 'GET', 'POST'],
      ['/marshal/api/stream', 'POST', 'GET'],
    ]
    for (const [path, method, allow] of cases) {
      const response = await target.request(path, { method, headers })
      expect(response.statusCode).toBe(405)
      expect(response.header('allow')).toBe(allow)
    }
  })
})

describe('hub api endpoints', () => {
  it('设备列表与会话索引', async () => {
    const { web: target } = await start()
    const devices = await target.request('/marshal/api/devices', { headers: AUTH })
    expect(devices.json<{ devices: { id: string }[] }>().devices[0]?.id).toBe('mac')
    const sessions = await target.request('/marshal/api/sessions?device=mac', { headers: AUTH })
    expect(sessions.json()).toEqual({
      sessions: [{ deviceId: 'mac', agent: 'dsh', sessionId: 's1', running: false, updatedAt: 1 }],
    })
    const all = await target.request('/marshal/api/sessions?device=', { headers: AUTH })
    expect(all.json<{ sessions: unknown[] }>().sessions).toHaveLength(1)
  })

  it('未知 op / 非法 args / 超大 body 被拒绝', async () => {
    const { web: target, sent } = await start()
    const call = (body: unknown) => target.request('/marshal/api/command', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect((await call({
      op: 'explode', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, args: {}, idempotencyKey: 'k1',
    })).statusCode).toBe(400)
    expect((await call({
      op: 'prompt', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
      args: { text: 'hi', passthrough: true }, idempotencyKey: 'k2',
    })).statusCode).toBe(400)
    expect(sent).toEqual([])
    const huge = await target.request('/marshal/api/command', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: 'x'.repeat(9_000),
    })
    expect(huge.statusCode).toBe(413)
  })

  it('同键不同载荷返回 409，断线后不回放正文', async () => {
    const { web: target, relay, sent } = await start()
    const body = (text: string): string => JSON.stringify({
      op: 'prompt', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, args: { text }, idempotencyKey: 'conflict',
    })
    const first = target.start('/marshal/api/command', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: body('a'),
    })
    const frame = await waitForFrame(sent, 'command')
    const second = await target.request('/marshal/api/command', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: body('b'),
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ status: 'rejected', code: 'idempotency-conflict' })
    relay.settle({
      v: 2, type: 'ack', commandId: frame.commandId as string,
      connectionId: 'conn-1', nodeEpoch: 'epoch-1', status: 'accepted',
      result: { accepted: true, cwd: '/home/secret' },
    } satisfies AckFrame, ORIGIN_FRAME)
    await first.done
    expect(first.res.json<{ result: unknown }>().result).toEqual({ accepted: true })

    relay.deviceOffline('mac')
    const cached = await target.request('/marshal/api/command', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: body('a'),
    })
    expect(cached.statusCode).toBe(200)
    expect(cached.json()).toEqual({ ok: true, status: 'accepted' })
  })

  it('command-status 200/202/404 与 400', async () => {
    const { web: target, relay, sent } = await start()
    const pending = target.start('/marshal/api/command-status?deviceId=mac&agent=dsh&sessionId=s1&op=prompt&key=pending', { headers: AUTH })
    const frame = await waitForFrame(sent, 'command.status')
    relay.settleStatus({
      v: 2, type: 'command.status.result', requestId: frame.requestId as string,
      status: 'outcome-unknown', code: 'record-unavailable',
    } satisfies CommandStatusResultFrame, ORIGIN_FRAME)
    await pending.done
    expect(pending.res.statusCode).toBe(404)

    sent.length = 0
    const known = target.start('/marshal/api/command-status?deviceId=mac&agent=dsh&sessionId=s1&op=prompt&key=known', { headers: AUTH })
    const knownFrame = await waitForFrame(sent, 'command.status')
    relay.settleStatus({
      v: 2, type: 'command.status.result', requestId: knownFrame.requestId as string, status: 'accepted',
    } satisfies CommandStatusResultFrame, ORIGIN_FRAME)
    await known.done
    expect(known.res.statusCode).toBe(200)
    expect(known.res.json()).toEqual({ ok: true, status: 'accepted' })

    expect((await target.request('/marshal/api/command-status?deviceId=mac', { headers: AUTH })).statusCode).toBe(400)
  })

  it('inputs 端点：200 卡片、离线 503、未知 202', async () => {
    const { web: target, relay, sent } = await start()
    const pending = target.start('/marshal/api/inputs', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' } }),
    })
    const frame = await waitForFrame(sent, 'inputs.snapshot')
    relay.settleInputs({
      v: 2, type: 'inputs.snapshot.result', requestId: frame.requestId as string,
      runtimeEpoch: 'epoch-1', highWatermark: 7,
      cards: [{
        requestId: 'r1', sessionId: 's1', runtimeEpoch: 'epoch-1', kind: 'question', expiresAt: 10,
        acceptOnceEligible: true, questions: [{ id: 'q1', prompt: 'Pick', required: true, multi: false, custom: false, secret: false }],
        hidden: 'must-not-pass',
      }],
    } satisfies InputsSnapshotResultFrame, ORIGIN_FRAME)
    await pending.done
    expect(pending.res.statusCode).toBe(200)
    const body = pending.res.json<{ ok: boolean; runtimeEpoch: string; highWatermark: number; cards: Record<string, unknown>[] }>()
    expect(body).toMatchObject({ ok: true, runtimeEpoch: 'epoch-1', highWatermark: 7 })
    expect(body.cards[0]).toMatchObject({ requestId: 'r1', acceptOnceEligible: true })
    expect(body.cards[0]).not.toHaveProperty('hidden')

    const offline = await target.request('/marshal/api/inputs', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ target: { deviceId: 'ghost', agent: 'dsh', sessionId: 's1' } }),
    })
    expect(offline.statusCode).toBe(503)

    const unknown = await target.request('/marshal/api/inputs', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' } }),
    })
    expect(unknown.statusCode).toBe(202)
  })

  it('history 用不透明 cursor 与有界 limit', async () => {
    const { web: target, relay, sent } = await start()
    const invalid = [
      { target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, limit: 0 },
      { target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, limit: 201 },
      { target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, limit: 1.5 },
      { target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, cursor: 'x'.repeat(513) },
      { target: { deviceId: 'mac', agent: 'dsh', sessionId: null }, limit: 10 },
      { target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, extra: true },
    ]
    for (const body of invalid) {
      expect((await target.request('/marshal/api/history', {
        method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })).statusCode).toBe(400)
    }

    const pending = target.start('/marshal/api/history', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, cursor: 'opaque-1', limit: 5,
      }),
    })
    const frame = await waitForFrame(sent, 'command')
    expect(frame).toMatchObject({
      op: 'observe',
      args: { kind: 'history', cursor: 'opaque-1', limit: 5 },
    })
    expect(typeof frame.idempotencyKey).toBe('string')
    relay.settle({
      v: 2, type: 'ack', commandId: frame.commandId as string,
      connectionId: 'conn-1', nodeEpoch: 'epoch-1', status: 'accepted',
      result: { count: 2, payload: [{ secret: true }] },
    } satisfies AckFrame, ORIGIN_FRAME)
    await pending.done
    expect(pending.res.statusCode).toBe(200)
    expect(pending.res.json()).toEqual({ ok: true, status: 'accepted', result: { count: 2 } })
  })

  it('内部失败只回分类', async () => {
    const { web: target, relay } = await start()
    relay.dispose()
    const response = await target.request('/marshal/api/command', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'prompt', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
        args: { text: 'sk-testtesttesttest' }, idempotencyKey: 'disposed',
      }),
    })
    expect(response.statusCode).toBe(503)
    expect(response.body).not.toContain('sk-testtesttesttest')
  })
})
