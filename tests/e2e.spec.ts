import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { apply } from '../src/index.ts'
import { ensureInstall } from '../src/hub/identity.ts'
import type {
  AskUserQuestionAnswerLike, AskUserQuestionRequestLike, MarshalContext,
  SessionControllerLike, SessionSummaryLike, UserQuestionLike,
} from '../src/dsh-types.ts'
import { CONTRACT_REVISION } from '../src/wire/frames.ts'
import { closeTestWeb, createTestWeb, type TestWeb } from './support/web.ts'

const DASHBOARD_TOKEN = 'e2e-dashboard-token-0123456789abcdef'
const POLL_INTERVAL_MS = 20
const POLL_TIMEOUT_MS = 2_000
// 重启用例会在同一端口关闭并重建服务器；普通 HTTP 请求不复用旧 socket。
const AUTH = { 'x-marshal-token': DASHBOARD_TOKEN, connection: 'close' }
/** 合成哨兵：所有出站字节、journal 与审计都不允许出现。 */
const PROMPT_SENTINEL = 'sk-e2e-sentinel-0123456789abcdef'
const CWD_SENTINEL = '/home/example/secret-project'
const ALIAS_SENTINEL = 'e2e-private-alias'

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
    const session = {
      sessionId: 's1', running: false, blank: false, updatedAt: 1,
      cwd: CWD_SENTINEL, publicAlias: ALIAS_SENTINEL,
    }
    const sessionController: SessionControllerLike = {
      list: async () => ({ items: [session] }),
      follow(request) {
        follows.push(request)
        return (async function* () {})()
      },
      prompt: async (request) => {
        prompts.push(request)
        // 额外字段必须在 ACK 投影里被丢弃。
        return { accepted: true, token: PROMPT_SENTINEL }
      },
      cancel: async () => ({}),
    }
    const web = createTestWeb({
      tls: {
        key: readFileSync(new URL('./fixtures/tls-key.pem', import.meta.url), 'utf8'),
        cert: readFileSync(new URL('./fixtures/tls-cert.pem', import.meta.url), 'utf8'),
      },
    })
    const dir = await mkdtemp(join(tmpdir(), 'marshal-e2e-'))
    // node 配置只接受 wss://；测试用自签证书，需要临时关闭校验。
    const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    const previousJournal = process.env.MARSHAL_JOURNAL_FILE
    const previousJournalKey = process.env.MARSHAL_JOURNAL_KEY_FILE
    const previousAudit = process.env.MARSHAL_AUDIT_FILE
    const journalFile = join(dir, 'journal.json')
    const auditFile = join(dir, 'audit.jsonl')
    // node 启动即打开 journal；测试必须用临时路径，不能碰真实 $HOME 状态。
    process.env.MARSHAL_JOURNAL_FILE = journalFile
    process.env.MARSHAL_JOURNAL_KEY_FILE = join(dir, 'journal.key')
    process.env.MARSHAL_AUDIT_FILE = auditFile
    try {
      const devicesFile = join(dir, 'devices.json')
      // 全新安装走与 hub/CLI 相同的初始化器；token 只在本次 add 返回值里出现。
      const token = ensureInstall(devicesFile).store.add('mac', 'Mac').token

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
        role: 'node', hubUrl: `wss://127.0.0.1:${port}/marshal/uplink`, token,
        deviceId: 'mac', deviceName: 'mac',
      })

      await waitForCount(async () => {
        const body = await (await fetch(`${base}/marshal/api/devices`, { headers: AUTH })).json() as DeviceBody
        return body.devices
      }, 1, 'device')
      await waitForCount(async () => {
        const body = await (await fetch(`${base}/marshal/api/sessions`, { headers: AUTH })).json() as SessionBody
        return body.sessions
      }, 1, 'session')
      const sessionsBody = await (await fetch(`${base}/marshal/api/sessions`, { headers: AUTH })).json() as SessionBody
      // metadata 快照不含 cwd/别名；HTTP 出口也不回显本机路径。
      expect(JSON.stringify(sessionsBody.sessions)).not.toContain('cwd')
      expect(JSON.stringify(sessionsBody.sessions)).not.toContain(CWD_SENTINEL)
      expect(JSON.stringify(sessionsBody.sessions)).not.toContain(ALIAS_SENTINEL)

      // 设备只有原子提交后才 online；能力来自同步提交且不含路径。
      const devicesBody = await (await fetch(`${base}/marshal/api/devices`, { headers: AUTH })).json() as {
        devices: Array<{ syncing?: boolean; stale?: boolean; capabilities?: Record<string, unknown> }>
      }
      expect(devicesBody.devices[0]).toMatchObject({ syncing: false, stale: false })
      expect(devicesBody.devices[0]?.capabilities?.dsh).toBeDefined()
      expect(JSON.stringify(devicesBody)).not.toContain(CWD_SENTINEL)

      const promptResponse = await fetch(`${base}/marshal/api/command`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'prompt', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
          args: { text: PROMPT_SENTINEL }, idempotencyKey: 'e2e-1',
        }),
      })
      expect(promptResponse.status).toBe(200)
      const promptBody = await promptResponse.json() as { ok?: boolean; result?: unknown }
      expect(promptBody.ok).toBe(true)
      // ACK 结果只保留白名单键，适配器返回的额外 token 字段必须消失。
      expect(promptBody.result).toEqual({ accepted: true })
      expect(JSON.stringify(promptBody)).not.toContain(PROMPT_SENTINEL)
      expect(prompts).toHaveLength(1)
      const recorded = prompts[0] as { content?: { text?: string }[] }
      expect(recorded.content?.[0]?.text).toBe(PROMPT_SENTINEL)

      // journal 只存幂等元数据，审计只存身份/操作/状态，均不得出现正文哨兵。
      expect(readFileSync(journalFile, 'utf8')).not.toContain(PROMPT_SENTINEL)
      const auditRaw = readFileSync(auditFile, 'utf8')
      expect(auditRaw).toContain('"op":"prompt"')
      expect(auditRaw).toContain('"status":"accepted"')
      expect(auditRaw).not.toContain(PROMPT_SENTINEL)

      // 已受理命令可通过只读查询恢复；查询本身不触发第二次 prompt。
      const statusResponse = await fetch(
        `${base}/marshal/api/command-status?deviceId=mac&agent=dsh&sessionId=s1&op=prompt&key=e2e-1`,
        { headers: AUTH },
      )
      expect(statusResponse.status).toBe(200)
      expect(await statusResponse.json()).toMatchObject({ ok: true, status: 'accepted' })
      expect(prompts).toHaveLength(1)

      const observeResponse = await fetch(`${base}/marshal/api/command`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'observe', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
          args: { kind: 'follow', action: 'subscribe' }, idempotencyKey: 'e2e-observe',
        }),
      })
      expect(observeResponse.status).toBe(200)
      // follow 由跟随循环异步取用，ack 先到；轮询等它落到记录里。
      await waitForCount(async () => follows, 1, 'follow')
      expect(follows).toEqual([{ address: { kind: 'session', sessionId: 's1' }, assistantStream: true }])
    } finally {
      // 装配顺序是 hub → node，卸载按相反顺序。
      for (const cleanup of [...cleanups].reverse()) await cleanup()
      web.server.closeAllConnections?.()
      await new Promise<void>(resolve => web.server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
      if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting
      if (previousJournal === undefined) delete process.env.MARSHAL_JOURNAL_FILE
      else process.env.MARSHAL_JOURNAL_FILE = previousJournal
      if (previousJournalKey === undefined) delete process.env.MARSHAL_JOURNAL_KEY_FILE
      else process.env.MARSHAL_JOURNAL_KEY_FILE = previousJournalKey
      if (previousAudit === undefined) delete process.env.MARSHAL_AUDIT_FILE
      else process.env.MARSHAL_AUDIT_FILE = previousAudit
    }
    // 卸载本身不应产生任何告警。
    expect(warns).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// V0-T09：正式装配级回归
//
// 所有场景都经 HTTP → hub → WSS → node → 原生契约替身 → ACK → HTTP，
// 不调用任何内部 settle helper。原生替身只有 SessionControllerLike 与
// `user-questions/request` waterfall handler 两部分。
// ---------------------------------------------------------------------------

type QuestionHandler = (
  request: AskUserQuestionRequestLike,
  next: () => Promise<AskUserQuestionAnswerLike>,
) => Promise<AskUserQuestionAnswerLike>

interface NativePrompt {
  readonly requestId?: string
  readonly sessionId?: string
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
}

interface DeviceRow {
  readonly id: string
  readonly syncing?: boolean
  readonly stale?: boolean
  readonly capabilities?: Record<string, unknown>
}

interface SessionIndexRow { readonly deviceId?: string; readonly sessionId: string }
interface CardOption { readonly id: string; readonly label: string }
interface CardQuestion { readonly id: string; readonly prompt?: string; readonly options?: readonly CardOption[] }
interface InputCard {
  readonly requestId: string
  readonly acceptOnceEligible?: boolean
  readonly reason?: string
  readonly waitKind?: string
  readonly questions?: readonly CardQuestion[]
}

interface HttpResult { readonly status: number; readonly body: Record<string, unknown> }

interface AssemblyOptions {
  readonly dir?: string
  readonly devicesFile?: string
  readonly token?: string
  readonly port?: number
  readonly deviceId?: string
  readonly questionRelay?: 'off' | 'notify' | 'remote'
  readonly allowInteractions?: boolean
  readonly sessions?: readonly SessionSummaryLike[]
  readonly promptImpl?: () => Promise<unknown>
  readonly followImpl?: (request: unknown, signal: AbortSignal) => AsyncIterable<unknown>
  readonly withHub?: boolean
  readonly withNode?: boolean
}

interface Assembly {
  readonly dir: string
  readonly devicesFile: string
  readonly token: string
  readonly deviceId: string
  readonly journalFile: string
  readonly auditFile: string
  readonly prompts: NativePrompt[]
  readonly follows: unknown[]
  readonly warns: unknown[]
  base(): string
  port(): number
  capturedHandler(): QuestionHandler | undefined
  startHub(): Promise<void>
  stopHub(): Promise<void>
  startNode(): Promise<void>
  stopNode(): Promise<void>
  dispose(): Promise<void>
}

interface SavedEnv {
  readonly journal: string | undefined
  readonly key: string | undefined
  readonly audit: string | undefined
}

/**
 * 用正式 apply() 装配 hub/node。hub 重启复用同一 devicesFile；node 重启复用
 * 同一 journal 路径。web server 的端口与目录由调用方决定，便于验证重启语义。
 */
async function startAssembly(options: AssemblyOptions = {}): Promise<Assembly> {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'marshal-e2e-assembly-'))
  const ownsDir = options.dir === undefined
  const devicesFile = options.devicesFile ?? join(dir, 'devices.json')
  const deviceId = options.deviceId ?? 'mac'
  const withHub = options.withHub ?? true
  const withNode = options.withNode ?? true
  const { warns, logger } = fakeLogger()

  // 首次创建才签发 token；重启装配必须显式携带原 token，不能从磁盘回读。
  let token = options.token ?? ''
  const install = ensureInstall(devicesFile)
  if (install.store.findById(deviceId) === undefined) {
    token = install.store.add(deviceId, 'Mac').token
    if (options.allowInteractions === true) install.store.setPolicy(deviceId, { allowInteractions: true })
  } else if (withNode && token === '') {
    throw new Error('startAssembly: an existing device requires the original token')
  }

  const journalFile = join(dir, 'journal.json')
  const keyFile = join(dir, 'journal.key')
  const auditFile = join(dir, 'audit.jsonl')
  const web: TestWeb = createTestWeb({
    tls: {
      key: readFileSync(new URL('./fixtures/tls-key.pem', import.meta.url), 'utf8'),
      cert: readFileSync(new URL('./fixtures/tls-cert.pem', import.meta.url), 'utf8'),
    },
  })
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const prompts: NativePrompt[] = []
  const follows: unknown[] = []
  const hubCleanups: (() => void | Promise<void>)[] = []
  const nodeCleanups: (() => void | Promise<void>)[] = []
  let handler: QuestionHandler | undefined
  let listeningPort = options.port ?? 0
  let hubStarted = false
  let nodeStarted = false
  let disposed = false
  let savedEnv: SavedEnv | undefined

  const assembleHub = (): void => {
    const hubContext = {
      webServer: web.webServer,
      logger,
      effect(setup: () => () => void | Promise<void>) { hubCleanups.push(setup()) },
        inject(services: readonly string[], callback: (ctx: MarshalContext) => void) {
          if (services.every(service => service in this)) callback(this as unknown as MarshalContext)
        },
    }
    apply(hubContext as unknown as MarshalContext, {
      role: 'hub',
      dashboardToken: DASHBOARD_TOKEN,
      publicOrigin: 'https://marshal.example',
      devicesFile,
    })
  }

  const sessionController: SessionControllerLike = {
    list: async () => ({ items: options.sessions ?? [{ sessionId: 's1', running: false, blank: false, updatedAt: 1 }] }),
    follow(request, signal) {
      follows.push(request)
      return options.followImpl?.(request, signal) ?? (async function* () {})()
    },
    prompt: async request => {
      prompts.push(request as NativePrompt)
      return await (options.promptImpl?.() ?? Promise.resolve({ accepted: true }))
    },
    cancel: async () => ({}),
  }

  const assembly: Assembly = {
    dir,
    devicesFile,
    token,
    deviceId,
    journalFile,
    auditFile,
    prompts,
    follows,
    warns,
    base: () => `https://127.0.0.1:${listeningPort}`,
    port: () => listeningPort,
    capturedHandler: () => handler,
    async startHub() {
      if (hubStarted) throw new Error('startAssembly: hub is already started')
      assembleHub()
      // 重启时复用已分配的端口；首次启动可以让系统分配。
      listeningPort = await web.listen(options.port ?? (listeningPort === 0 ? 0 : listeningPort))
      hubStarted = true
    },
    async stopHub() {
      const wasStarted = hubStarted
      hubStarted = false
      // 即使上一次 startHub 在 listen 阶段失败，也要先撤掉已注册的路由。
      for (const cleanup of [...hubCleanups].reverse()) await cleanup()
      hubCleanups.length = 0
      if (wasStarted) await closeTestWeb(web)
    },
    async startNode() {
      if (nodeStarted) throw new Error('startAssembly: node is already started')
      if (savedEnv === undefined) {
        // node 启动即打开 journal：必须用临时路径，不能碰真实 $HOME 状态。
        savedEnv = {
          journal: process.env.MARSHAL_JOURNAL_FILE,
          key: process.env.MARSHAL_JOURNAL_KEY_FILE,
          audit: process.env.MARSHAL_AUDIT_FILE,
        }
      }
      process.env.MARSHAL_JOURNAL_FILE = journalFile
      process.env.MARSHAL_JOURNAL_KEY_FILE = keyFile
      process.env.MARSHAL_AUDIT_FILE = auditFile
      const nodeContext = {
        logger,
        effect(setup: () => () => void | Promise<void>) { nodeCleanups.push(setup()) },
        inject(services: readonly string[], callback: (ctx: MarshalContext) => void) {
          if (services.every(service => service in this)) callback(this as unknown as MarshalContext)
        },
        sessionController,
        on(_event: 'user-questions/request', fn: QuestionHandler) {
          handler = fn
          return () => { if (handler === fn) handler = undefined }
        },
      }
      apply(nodeContext as unknown as MarshalContext, {
        role: 'node',
        hubUrl: `wss://127.0.0.1:${listeningPort}/marshal/uplink`,
        token,
        deviceId,
        deviceName: deviceId,
        ...(options.questionRelay === undefined ? {} : { questionRelay: options.questionRelay }),
      })
      nodeStarted = true
    },
    async stopNode() {
      if (!nodeStarted) return
      nodeStarted = false
      for (const cleanup of [...nodeCleanups].reverse()) await cleanup()
      nodeCleanups.length = 0
      handler = undefined
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await assembly.stopNode()
      await assembly.stopHub()
      if (savedEnv !== undefined) {
        const env = savedEnv
        savedEnv = undefined
        if (env.journal === undefined) delete process.env.MARSHAL_JOURNAL_FILE
        else process.env.MARSHAL_JOURNAL_FILE = env.journal
        if (env.key === undefined) delete process.env.MARSHAL_JOURNAL_KEY_FILE
        else process.env.MARSHAL_JOURNAL_KEY_FILE = env.key
        if (env.audit === undefined) delete process.env.MARSHAL_AUDIT_FILE
        else process.env.MARSHAL_AUDIT_FILE = env.audit
      }
      if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting
      if (ownsDir) await rm(dir, { recursive: true, force: true })
    },
  }

  try {
    if (withHub) await assembly.startHub()
    if (withNode) await assembly.startNode()
  } catch (error) {
    await assembly.dispose()
    throw error
  }
  return assembly
}

const ASSEMBLY_POLL_TIMEOUT_MS = 5_000

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = ASSEMBLY_POLL_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(POLL_INTERVAL_MS)
  }
}

async function getJson(url: string): Promise<HttpResult> {
  const response = await fetch(url, { headers: AUTH })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

async function postJson(url: string, body: unknown): Promise<HttpResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

async function devicesOf(assembly: Assembly): Promise<DeviceRow[]> {
  const result = await getJson(`${assembly.base()}/marshal/api/devices`)
  return Array.isArray(result.body.devices) ? result.body.devices as DeviceRow[] : []
}

async function sessionsOf(assembly: Assembly): Promise<SessionIndexRow[]> {
  const result = await getJson(`${assembly.base()}/marshal/api/sessions`)
  return Array.isArray(result.body.sessions) ? result.body.sessions as SessionIndexRow[] : []
}

async function inputsOf(assembly: Assembly, sessionId = 's1'): Promise<{ status: number; cards: InputCard[] }> {
  const result = await postJson(`${assembly.base()}/marshal/api/inputs`, {
    target: { deviceId: assembly.deviceId, agent: 'dsh', sessionId },
  })
  return {
    status: result.status,
    cards: Array.isArray(result.body.cards) ? result.body.cards as InputCard[] : [],
  }
}

async function statusOf(assembly: Assembly, key: string, sessionId = 's1'): Promise<HttpResult> {
  const query = new URLSearchParams({
    deviceId: assembly.deviceId, agent: 'dsh', sessionId, op: 'prompt', key,
  })
  return await getJson(`${assembly.base()}/marshal/api/command-status?${query.toString()}`)
}

async function postCommand(assembly: Assembly, body: unknown): Promise<HttpResult> {
  return await postJson(`${assembly.base()}/marshal/api/command`, body)
}

function promptCommand(text: string, key: string): Record<string, unknown> {
  return {
    op: 'prompt',
    target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
    args: { text },
    idempotencyKey: key,
  }
}

function answerCommand(requestId: string, questionId: string, optionId: string, key: string): Record<string, unknown> {
  return {
    op: 'answer',
    target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
    args: { requestId, answers: [{ id: questionId, selectedOptionIds: [optionId] }] },
    idempotencyKey: key,
  }
}

/** 直到设备完成原子同步且节点进入 online；问题认领要求 link.online。 */
async function waitForOnline(assembly: Assembly): Promise<void> {
  await waitUntil(async () => {
    const devices = await devicesOf(assembly)
    return devices.length === 1 && devices[0]?.syncing === false
  }, 'device online')
  await waitUntil(async () => (await sessionsOf(assembly)).length === 1, 'session index')
  // sync.ack 与 hub 侧提交之间还有一个本地 WebSocket 往返：让节点先进入 online。
  await sleep(50)
}

function requireHandler(assembly: Assembly): QuestionHandler {
  const captured = assembly.capturedHandler()
  if (captured === undefined) throw new Error('question relay did not subscribe to user-questions/request')
  return captured
}

function askQuestion(
  handler: QuestionHandler,
  questions: readonly UserQuestionLike[],
): Promise<AskUserQuestionAnswerLike> {
  return handler(
    { questions, agent: { session: { id: 's1' } } },
    async () => ({ answers: [] }),
  )
}

interface SseEvent { readonly event: string | undefined; readonly data: string | undefined }

interface SseReader {
  readonly events: SseEvent[]
  waitForEvent(predicate: (event: SseEvent) => boolean, what: string, timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

function parseSseBlock(block: string): SseEvent | undefined {
  let event: string | undefined
  let data: string | undefined
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) {
      const chunk = line.slice('data:'.length).trim()
      data = data === undefined ? chunk : `${data}\n${chunk}`
    }
  }
  return event === undefined && data === undefined ? undefined : { event, data }
}

/** fetch + ReadableStream 增量解析 SSE；不引入额外依赖。 */
function openSse(assembly: Assembly, path = '/marshal/api/stream'): SseReader {
  const controller = new AbortController()
  const events: SseEvent[] = []
  let buffer = ''
  const pump = (async () => {
    try {
      const response = await fetch(`${assembly.base()}${path}`, { headers: AUTH, signal: controller.signal })
      if (!response.ok || response.body === null) throw new Error(`sse http ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary < 0) break
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseSseBlock(block)
          if (parsed !== undefined) events.push(parsed)
        }
      }
    } catch {
      // abort 是正常关闭；真实错误统一由 waitForEvent 的超时消息报告。
    }
  })()
  return {
    events,
    async waitForEvent(predicate, what, timeoutMs = ASSEMBLY_POLL_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (events.some(predicate)) return
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await sleep(POLL_INTERVAL_MS)
      }
    },
    async close() {
      controller.abort()
      await pump
    },
  }
}

function frameDataOf(data: string): { type?: string; kind?: string; payload?: Record<string, unknown> } | undefined {
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed as { type?: string; kind?: string; payload?: Record<string, unknown> }
  } catch {
    return undefined
  }
}

/** 原始 ws 连接：用合法 token 升级，再发不匹配的 hello.deviceId。 */
async function forgedIdentityCloseCode(assembly: Assembly): Promise<number> {
  const ws = new WebSocket(`wss://127.0.0.1:${assembly.port()}/marshal/uplink`, {
    headers: { authorization: `Bearer ${assembly.token}` },
  })
  ws.on('error', () => {})
  const closed = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('forged connection did not close')), 3_000)
    timer.unref()
    ws.on('close', code => { clearTimeout(timer); resolve(code) })
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({
    v: 2, type: 'hello', contractRevision: CONTRACT_REVISION,
    deviceId: 'forged-device', deviceName: 'forged', nodeEpoch: 'forged-epoch',
    agents: ['dsh'], features: [],
  }))
  return await closed
}

/** 设备表不可确认时，新的升级应以 503 终止，而不是进入握手。 */
async function rejectedUpgradeStatus(assembly: Assembly): Promise<number> {
  const ws = new WebSocket(`wss://127.0.0.1:${assembly.port()}/marshal/uplink`, {
    headers: { authorization: `Bearer ${assembly.token}` },
  })
  let settled = false
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upgrade did not settle')), 3_000)
    timer.unref()
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    ws.on('error', () => finish(() => reject(new Error('upgrade socket failed before a response'))))
    ws.on('unexpected-response', (_request, response) => {
      response.resume()
      finish(() => resolve(response.statusCode ?? 0))
    })
  })
}

const DUPLICATE_PROMPT = 'e2e-idempotent-prompt-sentinel-3d5f'
const QUESTION_TEXT = 'e2e-question-sentinel-7c1 请选择'
const OPTION_ALPHA = 'e2e-option-alpha-9f3'
const OPTION_BETA = 'e2e-option-beta-2b8'

describe('e2e assembly regressions', () => {
  it('重复幂等键：同载荷只调用一次原生，异载荷 409，journal 不含正文', async () => {
    const assembly = await startAssembly()
    try {
      await waitForOnline(assembly)
      const first = await postCommand(assembly, promptCommand(DUPLICATE_PROMPT, 'e2e-dup-1'))
      expect(first.status).toBe(200)
      expect(first.body).toMatchObject({ ok: true, status: 'accepted' })
      expect(assembly.prompts).toHaveLength(1)

      // 同键同载荷：命中 hub 的完成缓存，不得再次下发。
      const cached = await postCommand(assembly, promptCommand(DUPLICATE_PROMPT, 'e2e-dup-1'))
      expect(cached.status).toBe(200)
      expect(cached.body).toMatchObject({ ok: true, status: 'accepted' })
      expect(assembly.prompts).toHaveLength(1)

      // 同键不同载荷：幂等域冲突，同样不能调用原生。
      const conflict = await postCommand(assembly, promptCommand(`${DUPLICATE_PROMPT}-changed`, 'e2e-dup-1'))
      expect(conflict.status).toBe(409)
      expect(conflict.body).toMatchObject({ ok: false, status: 'rejected', code: 'idempotency-conflict' })
      expect(assembly.prompts).toHaveLength(1)

      const recorded = assembly.prompts[0]?.content?.[0]?.text
      expect(recorded).toBe(DUPLICATE_PROMPT)
      // journal 只存身份/目标/操作/摘要，绝不落提示词正文。
      expect(readFileSync(assembly.journalFile, 'utf8')).not.toContain(DUPLICATE_PROMPT)
    } finally {
      await assembly.dispose()
    }
  })

  it('原生 prompt 失败：202 结果未知，重试不再调用原生，状态查询仍为 unknown', async () => {
    const assembly = await startAssembly({
      promptImpl: async () => { throw new Error('native prompt exploded') },
    })
    try {
      await waitForOnline(assembly)
      const failed = await postCommand(assembly, promptCommand('e2e-outcome-unknown-4a1', 'e2e-fail-1'))
      expect(failed.status).toBe(202)
      expect(failed.body).toMatchObject({ ok: false, status: 'outcome-unknown' })
      expect(assembly.prompts).toHaveLength(1)

      // 同键重试由 hub 未决缓存与 node journal 双重拦截，不能再碰原生。
      const retried = await postCommand(assembly, promptCommand('e2e-outcome-unknown-4a1', 'e2e-fail-1'))
      expect(retried.status).toBe(202)
      expect(retried.body.status).toBe('outcome-unknown')
      expect(assembly.prompts).toHaveLength(1)

      const status = await statusOf(assembly, 'e2e-fail-1')
      expect(status.status).toBe(202)
      expect(status.body).toMatchObject({ ok: false, status: 'outcome-unknown' })
      expect(status.body.status).not.toBe('accepted')
      expect(status.body.status).not.toBe('confirmed')
      expect(readFileSync(assembly.journalFile, 'utf8')).not.toContain('e2e-outcome-unknown-4a1')
    } finally {
      await assembly.dispose()
    }
  })

  it('hub 重启后节点重同步：索引恢复、无重复 prompt、在途命令保持 unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marshal-e2e-restart-'))
    // 开关在装配时就注入，第二次原生调用才会真正挂住。
    let hang = false
    const never = new Promise<unknown>(() => {})
    let second: Assembly | undefined
    const first = await startAssembly({
      dir,
      promptImpl: async () => await (hang ? never : Promise.resolve({ accepted: true })),
    })
    try {
      await waitForOnline(first)
      const doneKey = 'e2e-restart-done-1'
      const accepted = await postCommand(first, promptCommand('e2e-before-restart-5c9', doneKey))
      expect(accepted.status).toBe(200)
      expect(accepted.body).toMatchObject({ ok: true, status: 'accepted' })
      expect(first.prompts).toHaveLength(1)

      // 第二次原生调用永不返回：hub 停止时该命令仍停留在 admitted。
      hang = true
      const inflightKey = 'e2e-restart-inflight-2'
      const inFlight = postCommand(first, promptCommand('e2e-inflight-8e4', inflightKey))
      // hub 关闭会掐断这条 HTTP 连接；先消费结果，避免未处理拒绝。
      const inFlightSettled = inFlight.then(() => undefined, () => undefined)
      await waitUntil(() => first.prompts.length === 2, 'in-flight native prompt started')

      const port = first.port()
      await first.stopHub()

      // 新 hub 复用同一 devicesFile 与端口：operatorId 来自持久设备表，
      // 因此节点 journal 的幂等域在重启前后保持一致。
      second = await startAssembly({
        dir, devicesFile: first.devicesFile, token: first.token,
        port, withNode: false,
      })
      await waitForOnline(second)

      // 重同步只恢复索引，不得重放任何历史或未决命令。
      expect(first.prompts).toHaveLength(2)
      expect(await sessionsOf(second)).toHaveLength(1)

      const before = await statusOf(second, doneKey)
      expect(before.status).toBe(200)
      expect(before.body).toMatchObject({ ok: true, status: 'accepted' })

      // admitted 在查询侧只能呈现 outcome-unknown，不能伪装成已受理。
      const unknown = await statusOf(second, inflightKey)
      expect(unknown.status).toBe(202)
      expect(unknown.body).toMatchObject({ ok: false, status: 'outcome-unknown' })
      expect(unknown.body.status).not.toBe('accepted')
      expect(unknown.body.status).not.toBe('confirmed')

      // 重试同键：journal 拒绝二次调用，原生计数保持不变。
      const replay = await postCommand(second, promptCommand('e2e-inflight-8e4', inflightKey))
      expect(replay.status).toBe(202)
      expect(replay.body.status).not.toBe('accepted')
      expect(replay.body.status).not.toBe('confirmed')
      expect(first.prompts).toHaveLength(2)
      await inFlightSettled
    } finally {
      await second?.dispose()
      await first.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  }, 40_000)

  it('迟到的普通问题：HTTP 卡片可答、稳定选项 ID 回写原始 label、正文不进 journal/审计', async () => {
    const assembly = await startAssembly({ questionRelay: 'remote', allowInteractions: true })
    try {
      await waitForOnline(assembly)
      const handler = requireHandler(assembly)
      const pending = askQuestion(handler, [{
        id: 'q1', question: QUESTION_TEXT, options: [{ label: OPTION_ALPHA }, { label: OPTION_BETA }],
      }])

      // 问题先到 hub，再由 HTTP 客户端读取；不能先读再提问。
      await waitUntil(async () => (await inputsOf(assembly)).cards.length === 1, 'answerable question card')
      const card = (await inputsOf(assembly)).cards[0]
      expect(card).toBeDefined()
      expect(card?.acceptOnceEligible).toBe(true)
      const question = card?.questions?.[0]
      expect(question?.prompt).toBe(QUESTION_TEXT)
      const beta = question?.options?.find(option => option.label === OPTION_BETA)
      expect(beta?.id).toBeDefined()
      // 投影出的选项 ID 与显示 label 是两套值；回答只能携带稳定 ID。
      expect(beta?.id).not.toBe(OPTION_BETA)

      const answered = await postCommand(
        assembly,
        answerCommand(card!.requestId, question!.id, beta!.id, 'e2e-answer-1'),
      )
      expect(answered.status).toBe(200)
      expect(answered.body).toMatchObject({ ok: true, status: 'accepted' })
      expect(JSON.stringify(answered.body)).not.toContain(OPTION_BETA)

      // 原生 next() 必须拿到原始 label，而不是稳定 ID。
      await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [OPTION_BETA] }] })
      await waitUntil(async () => (await inputsOf(assembly)).cards.length === 0, 'card cleared after answer')

      const journalRaw = readFileSync(assembly.journalFile, 'utf8')
      const auditRaw = readFileSync(assembly.auditFile, 'utf8')
      for (const raw of [journalRaw, auditRaw]) {
        expect(raw).not.toContain(QUESTION_TEXT)
        expect(raw).not.toContain(OPTION_ALPHA)
        expect(raw).not.toContain(OPTION_BETA)
      }
      // answer 的审计只留身份/操作/状态。
      expect(auditRaw).toContain('"op":"answer"')
    } finally {
      await assembly.dispose()
    }
  })

  it('交互双授权组合：仅 remote + allowInteractions 产生可答卡', async () => {
    const combos: readonly {
      relay: 'off' | 'notify' | 'remote'
      allow: boolean
      outcome: 'local' | 'notify' | 'answerable' | 'blocked'
    }[] = [
      { relay: 'off', allow: false, outcome: 'local' },
      { relay: 'off', allow: true, outcome: 'local' },
      // notify 不受 hub allowInteractions 影响，两种开关都只发等待类别。
      { relay: 'notify', allow: false, outcome: 'notify' },
      { relay: 'notify', allow: true, outcome: 'notify' },
      // 契约 §8：remote 缺 hub allowInteractions 时按 off，不发送正文也不建可答卡。
      { relay: 'remote', allow: false, outcome: 'local' },
      { relay: 'remote', allow: true, outcome: 'answerable' },
      // 双授权齐全但卡片本身不可远答（secret）：只投影 acceptOnceEligible=false 的身份卡。
      { relay: 'remote', allow: true, outcome: 'blocked' },
    ]
    const plainQuestion: UserQuestionLike = {
      id: 'q1', question: QUESTION_TEXT, options: [{ label: OPTION_ALPHA }, { label: OPTION_BETA }],
    }
    const secretQuestion = {
      id: 'q1', question: QUESTION_TEXT, secret: true, options: [{ label: OPTION_ALPHA }, { label: OPTION_BETA }],
    }
    for (const combo of combos) {
      const assembly = await startAssembly({ questionRelay: combo.relay, allowInteractions: combo.allow })
      let reader: SseReader | undefined
      try {
        await waitForOnline(assembly)
        if (combo.relay === 'off') {
          // off 根本不注册 waterfall：本地 UI 语义完全不变。
          expect(assembly.capturedHandler()).toBeUndefined()
          expect((await inputsOf(assembly)).cards).toEqual([])
          continue
        }
        const handler = requireHandler(assembly)
        if (combo.outcome === 'notify' || combo.outcome === 'blocked') {
          // 通知/身份卡走 volatile 事件：必须在提问前订阅，断线不补发。
          reader = openSse(assembly)
          await reader.waitForEvent(event => event.event === 'reset', 'sse reset before interaction')
        }
        const pending = askQuestion(handler, [combo.outcome === 'blocked' ? secretQuestion : plainQuestion])

        if (combo.outcome === 'answerable') {
          await waitUntil(async () => (await inputsOf(assembly)).cards.length === 1, 'answerable card')
          const card = (await inputsOf(assembly)).cards[0]
          expect(card?.acceptOnceEligible).toBe(true)
          const option = card?.questions?.[0]?.options?.[0]
          const answered = await postCommand(
            assembly,
            answerCommand(card!.requestId, 'q1', option!.id, 'e2e-combo-answer'),
          )
          expect(answered.status).toBe(200)
          await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [OPTION_ALPHA] }] })
          continue
        }

        // 非可答路径必须立即 next()，不能等 answerTimeoutMs。
        await expect(pending).resolves.toEqual({ answers: [] })
        if (combo.outcome === 'blocked') {
          await reader!.waitForEvent(event => {
            const frame = event.data === undefined ? undefined : frameDataOf(event.data)
            return frame?.type === 'event'
              && frame.kind === 'input.requested'
              && frame.payload?.acceptOnceEligible === false
          }, 'unanswerable identity card')
          const cardEvent = reader!.events
            .flatMap(event => event.data === undefined ? [] : [frameDataOf(event.data)])
            .find(frame => frame?.kind === 'input.requested')
          expect(cardEvent?.payload?.acceptOnceEligible).toBe(false)
          expect(cardEvent?.payload?.reason).toBe('secret-local-only')
          expect(cardEvent?.payload?.questions).toBeUndefined()
          continue
        }

        expect((await inputsOf(assembly)).cards).toEqual([])
        if (combo.outcome === 'notify') {
          await reader!.waitForEvent(event => {
            const frame = event.data === undefined ? undefined : frameDataOf(event.data)
            return frame?.type === 'event'
              && frame.kind === 'session.updated'
              && frame.payload?.waitKind === 'input'
          }, 'waitKind notification')
          const notification = reader!.events
            .flatMap(event => event.data === undefined ? [] : [frameDataOf(event.data)])
            .find(frame => frame?.payload?.waitKind === 'input')
          expect(notification?.payload?.questions).toBeUndefined()
          expect(notification?.payload?.acceptOnceEligible).toBeUndefined()
        }
      } finally {
        await reader?.close()
        await assembly.dispose()
      }
    }
  }, 30_000)

  it('卸载与重载：重复 dispose 安全，重载后同键幂等命中且不再调用原生', async () => {
    const assembly = await startAssembly()
    try {
      await waitForOnline(assembly)
      const accepted = await postCommand(assembly, promptCommand('e2e-reload-prompt-a71', 'e2e-reload-1'))
      expect(accepted.status).toBe(200)
      expect(assembly.prompts).toHaveLength(1)

      const warningsBeforeDispose = assembly.warns.length
      await assembly.stopNode()
      // 第二次 dispose 必须是安全空操作。
      await assembly.stopNode()
      await waitUntil(async () => (await devicesOf(assembly)).length === 0, 'device detached')
      await waitUntil(async () => (await sessionsOf(assembly)).length === 0, 'session index cleared')
      await sleep(100)
      // 卸载后不得出现新的设备/会话活动（旧 node 不再重连）。
      expect(await devicesOf(assembly)).toEqual([])
      expect(await sessionsOf(assembly)).toEqual([])

      await assembly.stopHub()
      await assembly.stopHub()
      expect(assembly.warns.slice(warningsBeforeDispose)).toEqual([])

      // 同一 journal 路径重载：幂等记录仍在，但不能再调用原生。
      await assembly.startHub()
      await assembly.startNode()
      await waitUntil(async () => {
        const devices = await devicesOf(assembly)
        return devices.length === 1 && devices[0]?.syncing === false
      }, 'reloaded device online', 10_000)
      await waitUntil(async () => (await sessionsOf(assembly)).length === 1, 'reloaded session index')

      const reused = await postCommand(assembly, promptCommand('e2e-reload-prompt-a71', 'e2e-reload-1'))
      expect(reused.status).toBe(200)
      expect(reused.body).toMatchObject({ ok: true, status: 'accepted' })
      expect(assembly.prompts).toHaveLength(1)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it('UTF-8 多字节 prompt 经 HTTP→WSS→原生逐字节一致', async () => {
    const assembly = await startAssembly()
    try {
      await waitForOnline(assembly)
      // HTTP /api/command 的 JSON body 上限是 8192 字节（SMALL_BODY_LIMIT），
      // 所以这里用 ~7.2 KiB 的合法载荷覆盖多帧/多字节重组，
      // 而不是 200 KiB（那必须绕过 HTTP，违背装配级验证目标）。
      const text = `${'汉字'.repeat(1_200)}${'🙂'.repeat(10)}`
      const body = JSON.stringify(promptCommand(text, 'e2e-utf8-1'))
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(8_192)
      expect(Buffer.byteLength(text, 'utf8')).toBe(7_240)

      const response = await fetch(`${assembly.base()}/marshal/api/command`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true, status: 'accepted' })
      // 逐字节比较完整字符串：任何截断/替换字符都会失败。
      expect(assembly.prompts[0]?.content?.[0]?.text).toBe(text)
    } finally {
      await assembly.dispose()
    }
  })

  it('伪造身份被 4403 拒绝；设备表损坏时隔离连接并拒绝新连接，修复后恢复', async () => {
    const assembly = await startAssembly()
    try {
      await waitForOnline(assembly)

      // 合法 token + 不匹配的 hello.deviceId：不能冒充别的设备。
      const code = await forgedIdentityCloseCode(assembly)
      expect(code).toBe(4403)
      expect(await devicesOf(assembly)).toHaveLength(1)
      expect(await sessionsOf(assembly)).toHaveLength(1)

      const original = readFileSync(assembly.devicesFile, 'utf8')
      // 非法 reload 不能部分应用：现有连接立即隔离，新升级一律 503。
      writeFileSync(assembly.devicesFile, '{ "version": 2, "devices": [', 'utf8')
      await waitUntil(async () => (await devicesOf(assembly)).length === 0, 'existing device isolated', 10_000)
      expect(await rejectedUpgradeStatus(assembly)).toBe(503)
      expect(await sessionsOf(assembly)).toEqual([])

      // 修复文件后 hub 重新加载，节点重新握手并恢复同步。
      writeFileSync(assembly.devicesFile, original, 'utf8')
      await waitUntil(async () => (await devicesOf(assembly)).length === 1, 'device recovered', 20_000)
      await waitUntil(async () => (await sessionsOf(assembly)).length === 1, 'sessions recovered', 10_000)
    } finally {
      await assembly.dispose()
    }
  }, 40_000)

  it('静默会话：SSE reset complete 且无消息，待答快照仍可用', async () => {
    const assembly = await startAssembly()
    let reader: SseReader | undefined
    try {
      await waitForOnline(assembly)
      // follow() 启动但永不产出事件。
      const subscribed = await postCommand(assembly, {
        op: 'observe',
        target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
        args: { kind: 'follow', action: 'subscribe' },
        idempotencyKey: 'e2e-silent-observe',
      })
      expect(subscribed.status).toBe(200)
      await waitUntil(async () => assembly.follows.length === 1, 'follow registration')

      reader = openSse(assembly)
      await reader.waitForEvent(event => event.event === 'reset', 'sse reset')
      const reset = reader.events.find(event => event.event === 'reset')
      const payload = reset?.data === undefined ? undefined : JSON.parse(reset.data) as { complete?: boolean; required?: boolean }
      expect(payload?.required).toBe(true)
      expect(payload?.complete).toBe(true)

      // reset 之后静默会话不产生任何消息事件（只允许注释心跳）。
      await sleep(200)
      const messages = reader.events
        .filter(event => event.event !== 'reset' && event.data !== undefined)
        .map(event => frameDataOf(event.data!))
        .filter(frame => frame?.type === 'event')
      expect(messages).toEqual([])

      // 静默不影响只读待答快照。
      const inputs = await inputsOf(assembly)
      expect(inputs.status).toBe(200)
      expect(inputs.cards).toEqual([])
    } finally {
      await reader?.close()
      await assembly.dispose()
    }
  })

  it('hub 配置含未知键时装配直接失败（没有隐式本地特权传输）', () => {
    const context = { logger: fakeLogger().logger, effect() {} }
    expect(() => apply(context as unknown as MarshalContext, {
      role: 'hub',
      dashboardToken: DASHBOARD_TOKEN,
      publicOrigin: 'https://marshal.example',
      devicesFile: join(tmpdir(), 'marshal-e2e-unknown', 'devices.json'),
      // 未知的本地/受管捷径键必须让配置解析直接失败。
      managedLoopback: true,
    })).toThrow(/config\.managedLoopback is unknown/)
  })
})
