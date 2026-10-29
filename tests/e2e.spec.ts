import { describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { HubRelay } from '../src/hub/relay.ts'
import { mountHubSocket, nodeServerPort } from '../src/hub/server.ts'
import { registerMarshalRoutes } from '../src/hub/api.ts'
import { NodeLink } from '../src/node/link.ts'
import { createFollower, runCommand } from '../src/node/runner.ts'
import { createDshAdapter } from '../src/adapters/dsh/adapter.ts'
import { decodeFrame, type Frame } from '../src/wire/frames.ts'
import { createTestWeb } from './support/web.ts'

const TOKEN = 't'.repeat(32)
const POLL_INTERVAL_MS = 20
const POLL_TIMEOUT_MS = 2_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface SessionBody { sessions: unknown[] }

/** 轮询会话索引：node 的 snapshot 要经过 websocket 与 relay，不能立刻断言。 */
async function waitForSessions(port: number, count: number): Promise<SessionBody['sessions']> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    const body = await (await fetch(`http://127.0.0.1:${port}/marshal/api/sessions?token=owner`)).json() as SessionBody
    if (body.sessions.length === count) return body.sessions
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} session(s), got ${body.sessions.length}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

describe('e2e', () => {
  it('浏览器经 hub 让 node 列出会话并执行 prompt', async () => {
    const surface = {
      list: async () => [{ sessionId: 's1', running: false, blank: false, updatedAt: 1 }],
      follow: async function* () {
        yield { type: 'event', event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } }
      },
      prompt: async () => ({ accepted: true }),
      cancel: async () => ({}),
    }
    const adapter = createDshAdapter(surface, { device: 'mac' })
    const registry = new DeviceRegistry()
    const relay = new HubRelay({ registry, now: Date.now, timeoutMs: 2000 })
    // 一个 http.Server 同时承载页面路由与 /marshal/uplink 升级
    const web = createTestWeb()
    const socket = mountHubSocket({
      port: nodeServerPort(web.server),
      registry,
      devices: [{ id: 'mac', name: 'Mac', token: TOKEN }],
      now: Date.now,
      onFrame: (_device, frame) => {
        // 和 index.ts 一样：事件进索引，ack 回填 relay，否则指令一定超时。
        if (frame.type === 'event') relay.publish(frame)
        else if (frame.type === 'ack') relay.settle(frame)
      },
    })
    const routes = registerMarshalRoutes({ webServer: web.webServer, registry, relay, requireToken: 'owner' })
    const port = await web.listen()

    const link = new NodeLink({
      url: `ws://127.0.0.1:${port}/marshal/uplink`, token: TOKEN, device: 'mac', agents: ['dsh'],
      onFrame: text => {
        let frame: Frame
        try { frame = decodeFrame(text) } catch { return }
        runCommand(link, adapter, follower, frame, 'mac')
      },
    })
    // 所有指令共用一个 follower：每条 frame 新建一条跟随循环会让 stopAll 失效。
    const follower = createFollower({ adapter, send: event => link.sendEvent(event), logger: console })

    try {
      link.start()
      for (let i = 0; i < 100 && registry.get('mac') === undefined; i++) await sleep(POLL_INTERVAL_MS)
      expect(registry.get('mac')).toBeDefined()

      // 会话索引只来自事件：node 连上后必须先灌一次快照。
      for (const event of await adapter.snapshot(new AbortController().signal)) link.sendEvent(event)
      expect(await waitForSessions(port, 1)).toHaveLength(1)

      const devices = await (await fetch(`http://127.0.0.1:${port}/marshal/api/devices?token=owner`)).json() as { devices: unknown[] }
      expect(devices.devices).toHaveLength(1)

      const response = await fetch(`http://127.0.0.1:${port}/marshal/api/command?token=owner`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'prompt', target: { device: 'mac', agent: 'dsh', sessionId: 's1' },
          args: { text: 'hi' }, idempotencyKey: 'e2e-1',
        }),
      })
      expect(response.status).toBe(200)
      const body = await response.json() as { ok?: boolean; result?: unknown }
      expect(body.ok).toBe(true)
      expect(body.result).toEqual({ accepted: true })
    } finally {
      link.close()
      follower.stopAll()
      socket.dispose()
      routes.dispose()
      await new Promise<void>(resolve => web.server.close(() => resolve()))
    }
  })
})
