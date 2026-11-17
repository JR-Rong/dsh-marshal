import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { ensureInstall } from '../src/hub/identity.ts'
import type { MarshalContext, SessionControllerLike } from '../src/dsh-types.ts'
import { closeTestWeb, createTestWeb } from './support/web.ts'

const DASHBOARD_TOKEN = 'e2e-v1-dashboard-token-0123456789abcdef'
const DEVICE_ID = 'mac'
const POLL_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 20
const AUTH = { 'x-marshal-token': DASHBOARD_TOKEN }

/** 合成哨兵：能力文档/索引/HTTP 出口都不允许出现执行路径与正文。 */
const CODEX_SENTINEL = '/home/example/secret-project/codex-do-not-leak'
const PROMPT_SENTINEL = 'v1-e2e-prompt-sentinel-do-not-leak'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function fakeLogger(): { warns: unknown[]; logger: MarshalContext['logger'] } {
  const warns: unknown[] = []
  return {
    warns,
    logger: { info() {}, warn(message: unknown) { warns.push(message) }, error() {} },
  }
}

interface DeviceRow {
  readonly id: string
  readonly name: string
  readonly agents: readonly string[]
  readonly syncing?: boolean
  readonly stale?: boolean
  readonly capabilities?: Record<string, unknown>
}

interface DeviceBody { readonly devices: readonly DeviceRow[] }

interface SessionRow {
  readonly deviceId: string
  readonly agent: string
  readonly sessionId: string
  readonly running?: boolean
  readonly updatedAt?: number
  readonly capability?: unknown
}

interface SessionBody { readonly sessions: readonly SessionRow[] }

interface CommandOutcome {
  readonly ok?: unknown
  readonly status?: unknown
  readonly code?: unknown
}

interface CommandResponse {
  readonly status: number
  readonly body: CommandOutcome
}

interface UnavailableCapability {
  readonly unavailable?: { readonly adapter?: string }
  readonly stale?: boolean
}

/** 轮询到条件成立；node 的快照要经 WSS、同步屏障与中继，不能立刻断言。 */
async function waitUntil(predicate: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(POLL_INTERVAL_MS)
  }
}

async function getDevices(base: string): Promise<DeviceBody> {
  const response = await fetch(`${base}/marshal/api/devices`, { headers: AUTH })
  return (await response.json()) as DeviceBody
}

async function getSessions(base: string, deviceId: string): Promise<SessionBody> {
  const response = await fetch(`${base}/marshal/api/sessions?device=${encodeURIComponent(deviceId)}`, {
    headers: AUTH,
  })
  return (await response.json()) as SessionBody
}

async function postCommand(base: string, body: Record<string, unknown>): Promise<CommandResponse> {
  const response = await fetch(`${base}/marshal/api/command`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as CommandOutcome }
}

const ENV_KEYS = [
  'MARSHAL_JOURNAL_FILE', 'MARSHAL_JOURNAL_KEY_FILE', 'MARSHAL_AUDIT_FILE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
] as const
type EnvKey = typeof ENV_KEYS[number]
type SavedEnv = Readonly<Record<EnvKey, string | undefined>>

function saveEnv(): SavedEnv {
  return {
    MARSHAL_JOURNAL_FILE: process.env.MARSHAL_JOURNAL_FILE,
    MARSHAL_JOURNAL_KEY_FILE: process.env.MARSHAL_JOURNAL_KEY_FILE,
    MARSHAL_AUDIT_FILE: process.env.MARSHAL_AUDIT_FILE,
    NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
  }
}

function restoreEnv(saved: SavedEnv): void {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function pointEnvAtTempDir(dir: string): void {
  // node 启动即打开 journal；测试必须用临时路径，不能碰真实 $HOME 状态。
  process.env.MARSHAL_JOURNAL_FILE = join(dir, 'journal.json')
  process.env.MARSHAL_JOURNAL_KEY_FILE = join(dir, 'journal.key')
  process.env.MARSHAL_AUDIT_FILE = join(dir, 'audit.jsonl')
  // node 配置只接受 wss://；测试用自签证书，需要临时关闭校验。
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

describe('e2e v1 multi-agent assembly', () => {
  it('多 agent 同步：codex 不可用不阻塞 dsh，能力与索引按 agent 隔离', async () => {
    const { logger } = fakeLogger()
    const cleanups: (() => void | Promise<void>)[] = []
    const prompts: unknown[] = []
    // 替身只实现 DSH 适配器用到的成员；codex 是独立子进程，不依赖该控制器。
    const sessionController: SessionControllerLike = {
      list: async () => ({
        items: [{ sessionId: 's1', running: false, blank: false, updatedAt: 1 }],
      }),
      follow() {
        return (async function* (): AsyncIterable<unknown> { /* no events */ })()
      },
      prompt: async request => {
        prompts.push(request)
        return { accepted: true }
      },
      cancel: async () => ({}),
    }

    const dir = await mkdtemp(join(tmpdir(), 'marshal-e2e-v1-'))
    const web = createTestWeb({
      tls: {
        key: readFileSync(new URL('./fixtures/tls-key.pem', import.meta.url), 'utf8'),
        cert: readFileSync(new URL('./fixtures/tls-cert.pem', import.meta.url), 'utf8'),
      },
    })
    const savedEnv = saveEnv()
    pointEnvAtTempDir(dir)
    try {
      const devicesFile = join(dir, 'devices.json')
      // 全新安装走与 hub/CLI 相同的初始化器；token 只在本次 add 返回值里出现。
      const token = ensureInstall(devicesFile).store.add(DEVICE_ID, 'Mac').token

      // 替身只实现插件用到的成员：其余字段由 DSH 运行时提供。
      const hubContext = {
        webServer: web.webServer,
        logger,
        effect(setup: () => () => void | Promise<void>) { cleanups.push(setup()) },
        inject(services: readonly string[], callback: (ctx: MarshalContext) => void) {
          if (services.every(service => service in this)) callback(this as unknown as MarshalContext)
        },
      }
      apply(hubContext as unknown as MarshalContext, {
        role: 'hub', dashboardToken: DASHBOARD_TOKEN,
        publicOrigin: 'https://marshal.example', devicesFile,
      })

      const port = await web.listen()
      const base = `https://127.0.0.1:${port}`

      const nodeContext = {
        logger,
        effect(setup: () => () => void | Promise<void>) { cleanups.push(setup()) },
        inject(services: readonly string[], callback: (ctx: MarshalContext) => void) {
          if (services.every(service => service in this)) callback(this as unknown as MarshalContext)
        },
        sessionController,
      }
      apply(nodeContext as unknown as MarshalContext, {
        role: 'node',
        hubUrl: `wss://127.0.0.1:${port}/marshal/uplink`,
        token,
        deviceId: DEVICE_ID,
        deviceName: 'Mac',
        agents: ['dsh', 'codex'],
        // 显式指向不存在的位置：codex 必须以不可用能力占位，且不能阻塞 dsh。
        codexExecutable: CODEX_SENTINEL,
      })

      await waitUntil(async () => {
        const [devicesBody, sessionsBody] = await Promise.all([
          getDevices(base),
          getSessions(base, DEVICE_ID),
        ])
        const device = devicesBody.devices.find(row => row.id === DEVICE_ID)
        const codex = device?.capabilities?.codex as UnavailableCapability | undefined
        return device !== undefined
          && device.agents.includes('dsh') && device.agents.includes('codex')
          && device.capabilities?.dsh !== undefined
          && codex?.unavailable?.adapter === 'capability-unavailable'
          && sessionsBody.sessions.some(row => row.agent === 'dsh' && row.sessionId === 's1')
      }, 'codex unavailable capability and the dsh session row')

      const devicesBody = await getDevices(base)
      expect(devicesBody.devices).toHaveLength(1)
      const device = devicesBody.devices[0]!
      expect(device.id).toBe(DEVICE_ID)
      expect(device.agents).toEqual(expect.arrayContaining(['dsh', 'codex']))
      // DSH 正常同步，codex 只留下“当前不可观察”的占位能力。
      expect(typeof device.capabilities?.dsh).toBe('object')
      const codexCapability = device.capabilities?.codex as UnavailableCapability | undefined
      expect(codexCapability?.unavailable?.adapter).toBe('capability-unavailable')
      // 不可用文档允许同时带 stale 标记，但不能带任何执行路径。
      if (codexCapability?.stale !== undefined) expect(codexCapability.stale).toBe(true)

      // 索引按 agent 隔离：dsh 的会话行仍存在，且带上 hub 的会话级/文档回退能力。
      const sessionsBody = await getSessions(base, DEVICE_ID)
      const dshSession = sessionsBody.sessions.find(row => row.agent === 'dsh' && row.sessionId === 's1')
      expect(dshSession).toBeDefined()
      expect(dshSession?.deviceId).toBe(DEVICE_ID)
      expect(typeof dshSession?.capability).toBe('object')

      // codex 会话不可写：路由到 codex 适配器后失败，不能落到 dsh。
      const codexResponse = await postCommand(base, {
        op: 'prompt',
        target: { deviceId: DEVICE_ID, agent: 'codex', sessionId: 's1' },
        args: { text: PROMPT_SENTINEL },
        idempotencyKey: 'e2e-v1-codex-prompt',
      })
      expect(codexResponse.status).toBe(502)
      expect(codexResponse.body.status).toBe('rejected')
      expect(codexResponse.body.ok).not.toBe(true)
      expect(prompts).toHaveLength(0)

      // 未知 agent 由 node runner 直接拒绝，且不调用任何适配器。
      const ghostResponse = await postCommand(base, {
        op: 'prompt',
        target: { deviceId: DEVICE_ID, agent: 'ghost', sessionId: 's1' },
        args: { text: PROMPT_SENTINEL },
        idempotencyKey: 'e2e-v1-ghost-prompt',
      })
      expect(ghostResponse.body.status).toBe('rejected')
      expect(ghostResponse.body.code).toBe('session-unknown')
      expect(prompts).toHaveLength(0)

      // dsh 写入正常，并由 hub 幂等结算：同一个键不会触发第二次原生 prompt。
      const dshCommand = {
        op: 'prompt',
        target: { deviceId: DEVICE_ID, agent: 'dsh', sessionId: 's1' },
        args: { text: PROMPT_SENTINEL },
        idempotencyKey: 'e2e-v1-dsh-prompt',
      }
      const dshResponse = await postCommand(base, dshCommand)
      expect(dshResponse.status).toBe(200)
      expect(dshResponse.body.ok).toBe(true)
      expect(dshResponse.body.status).toBe('accepted')
      expect(prompts).toHaveLength(1)

      const replayResponse = await postCommand(base, dshCommand)
      expect(replayResponse.status).toBe(200)
      expect(replayResponse.body.ok).toBe(true)
      expect(prompts).toHaveLength(1)

      // 能力文档与索引都不得回显执行路径或正文。
      const finalDevices = await getDevices(base)
      const finalSessions = await getSessions(base, DEVICE_ID)
      const wire = JSON.stringify(finalDevices) + JSON.stringify(finalSessions)
      expect(wire).not.toContain(CODEX_SENTINEL)
      expect(wire).not.toContain(PROMPT_SENTINEL)
    } finally {
      // 装配顺序是 hub → node，卸载按相反顺序。
      for (const cleanup of [...cleanups].reverse()) await cleanup()
      await closeTestWeb(web)
      await rm(dir, { recursive: true, force: true })
      restoreEnv(savedEnv)
    }
  })

  it('未知 agent 在启动时直接拒绝', () => {
    const { logger } = fakeLogger()
    const cleanups: (() => void | Promise<void>)[] = []
    const ctx = {
      logger,
      effect(setup: () => () => void | Promise<void>) { cleanups.push(setup()) },
        inject(services: readonly string[], callback: (ctx: MarshalContext) => void) {
          if (services.every(service => service in this)) callback(this as unknown as MarshalContext)
        },
    }
    // 校验发生在 sessionController 与 journal 之前：既不需要主机服务，也不碰真实环境。
    expect(() => apply(ctx as unknown as MarshalContext, {
      role: 'node',
      hubUrl: 'wss://127.0.0.1:1/marshal/uplink',
      token: 't'.repeat(24),
      deviceId: DEVICE_ID,
      agents: ['ghost'],
    })).toThrow(/unsupported agent/)
    expect(cleanups).toHaveLength(0)
  })

  it('只有 codex 时不需要 sessionController', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marshal-e2e-v1-'))
    const cleanups: (() => void | Promise<void>)[] = []
    const savedEnv = saveEnv()
    pointEnvAtTempDir(dir)
    try {
      const { logger } = fakeLogger()
      const ctx = {
        logger,
        effect(setup: () => () => void | Promise<void>) { cleanups.push(setup()) },
        inject(services: readonly string[], callback: (ctx: MarshalContext) => void) {
          if (services.every(service => service in this)) callback(this as unknown as MarshalContext)
        },
      }
      // 不等待连接：拨号失败必须是异步告警，不能从 apply 同步抛出。
      expect(() => apply(ctx as unknown as MarshalContext, {
        role: 'node',
        hubUrl: 'wss://127.0.0.1:1/marshal/uplink',
        token: 'c'.repeat(24),
        deviceId: DEVICE_ID,
        agents: ['codex'],
        codexExecutable: CODEX_SENTINEL,
      })).not.toThrow()
    } finally {
      for (const cleanup of [...cleanups].reverse()) await cleanup()
      restoreEnv(savedEnv)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
