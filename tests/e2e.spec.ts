import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { MarshalContext, SessionControllerLike } from '../src/dsh-types.ts'
import { createTestWeb } from './support/web.ts'

const TOKEN = 't'.repeat(32)
const DASHBOARD_TOKEN = 'd'.repeat(32)
const POLL_INTERVAL_MS = 20
const POLL_TIMEOUT_MS = 2_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function fakeLogger() {
  const warns: unknown[] = []
  return { warns, logger: { info() {}, warn(message: unknown) { warns.push(message) }, error() {} } }
}

interface DeviceBody { devices: unknown[] }
interface SessionBody { sessions: unknown[] }

/** 轮询端点直到条目数达到预期：快照要经 websocket 与 relay，不能立刻断言。 */
async function waitForCount(read: () => Promise<unknown[]>, count: number, what: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    const items = await read()
    if (items.length === count) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} ${what}(s), got ${items.length}`)
    await sleep(POLL_INTERVAL_MS)
  }
}

describe('e2e', () => {
  it('浏览器经 hub 让 node 列出会话并执行 prompt', async () => {
    const { warns, logger } = fakeLogger()
    const cleanups: (() => void | Promise<void>)[] = []
    const prompts: unknown[] = []
    const follows: unknown[] = []
    const session = { sessionId: 's1', running: false, blank: false, updatedAt: 1 }
    const sessionController: SessionControllerLike = {
      list: async () => ({ items: [session] }),
      follow(request) {
        follows.push(request)
        return (async function* () {})()
      },
      prompt: async (request) => {
        prompts.push(request)
        return { accepted: true }
      },
      cancel: async () => ({}),
    }
    const web = createTestWeb()
    const dir = await mkdtemp(join(tmpdir(), 'marshal-e2e-'))
    try {
      const devicesFile = join(dir, 'devices.json')
      await writeFile(devicesFile, JSON.stringify({
        devices: [{ id: 'mac', name: 'Mac', token: TOKEN }],
      }))

      // 替身只实现插件用到的成员：其余字段由 DSH 运行时提供。
      const hubContext = {
        webServer: web.webServer,
        logger,
        effect(cleanup: () => void | Promise<void>) { cleanups.push(cleanup) },
      }
      apply(hubContext as unknown as MarshalContext, {
        role: 'hub', dashboardToken: DASHBOARD_TOKEN, devicesFile,
      })

      const port = await web.listen()
      const base = `http://127.0.0.1:${port}`

      const nodeContext = {
        logger,
        effect(cleanup: () => void | Promise<void>) { cleanups.push(cleanup) },
        sessionController,
      }
      apply(nodeContext as unknown as MarshalContext, {
        role: 'node', hubUrl: `ws://127.0.0.1:${port}/marshal/uplink`, token: TOKEN, deviceName: 'mac',
      })

      await waitForCount(async () => {
        const body = await (await fetch(`${base}/marshal/api/devices?token=${DASHBOARD_TOKEN}`)).json() as DeviceBody
        return body.devices
      }, 1, 'device')
      await waitForCount(async () => {
        const body = await (await fetch(`${base}/marshal/api/sessions?token=${DASHBOARD_TOKEN}`)).json() as SessionBody
        return body.sessions
      }, 1, 'session')

      const promptResponse = await fetch(`${base}/marshal/api/command?token=${DASHBOARD_TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'prompt', target: { device: 'mac', agent: 'dsh', sessionId: 's1' },
          args: { text: 'hi' }, idempotencyKey: 'e2e-1',
        }),
      })
      expect(promptResponse.status).toBe(200)
      const promptBody = await promptResponse.json() as { ok?: boolean; result?: unknown }
      expect(promptBody.ok).toBe(true)
      expect(promptBody.result).toEqual({ accepted: true })
      expect(prompts).toHaveLength(1)
      const recorded = prompts[0] as { content?: { text?: string }[] }
      expect(recorded.content?.[0]?.text).toBe('hi')

      const resumeResponse = await fetch(`${base}/marshal/api/command?token=${DASHBOARD_TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'resume', target: { device: 'mac', agent: 'dsh', sessionId: 's1' },
          args: {}, idempotencyKey: 'e2e-resume',
        }),
      })
      expect(resumeResponse.status).toBe(200)
      // follow 由跟随循环异步取用，ack 先到；轮询等它落到记录里。
      await waitForCount(async () => follows, 1, 'follow')
      expect(follows).toEqual([{ address: { kind: 'session', sessionId: 's1' } }])
    } finally {
      // 装配顺序是 hub → node，卸载按相反顺序。
      for (const cleanup of [...cleanups].reverse()) await cleanup()
      web.server.closeAllConnections?.()
      await new Promise<void>(resolve => web.server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
    // 卸载本身不应产生任何告警。
    expect(warns).toEqual([])
  })
})
