import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServerLike } from '../dsh-types.ts'
import { COMMAND_OPS, type CommandFrame, type CommandOp, type EventFrame } from '../wire/frames.ts'
import { parseCommandArgs } from '../wire/commands.ts'
import { MAX_FRAME_BYTES } from '../wire/limits.ts'
import type { BufferReadResult } from './buffer.ts'
import type { DeviceRegistry } from './registry.ts'
import type { CommandOutcome, CommandStatusOutcome, HubRelay } from './relay.ts'
import type { HubSync } from './sync.ts'
import { PAGE_HTML } from './page.ts'

export interface ApiOptions {
  readonly webServer: WebServerLike
  readonly registry: DeviceRegistry
  readonly relay: HubRelay
  readonly sync?: Pick<HubSync, 'status'>
  readonly requireToken: string
  /** 浏览器访问的唯一 origin；缺失时任何带 Origin 的请求都按不匹配拒绝。 */
  readonly publicOrigin?: string
  /** 会话绑定的持久 owner 身份；不接收浏览器自报值。 */
  readonly operatorId?: string
  readonly now?: () => number
  /** 测试可缩短；生产固定 8h 绝对 / 30min 空闲。 */
  readonly sessionAbsoluteMs?: number
  readonly sessionIdleMs?: number
  readonly loginFailureDelayMs?: number
  readonly sessionSweepMs?: number
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface CommandBody {
  op?: unknown
  target?: unknown
  args?: unknown
  idempotencyKey?: unknown
}

interface ServerSession {
  readonly id: string
  readonly csrf: string
  readonly operatorId: string
  readonly createdAt: number
  lastSeenAt: number
}

type AuthContext = { readonly kind: 'session'; readonly session: ServerSession } | { readonly kind: 'token' }

interface AuthOptions {
  readonly allowToken: boolean
  /** 普通 API 请求刷新空闲期；session/SSE 不续期。 */
  readonly refresh: boolean
  /** 浏览器写操作额外要求精确 Origin 与匹配服务端会话值的 CSRF。 */
  readonly write: boolean
}

export const SESSION_COOKIE = '__Host-marshal-session'
export const CSRF_COOKIE = '__Host-marshal-csrf'
const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000
const SESSION_IDLE_MS = 30 * 60 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_SOURCE_LIMIT = 5
const LOGIN_BACKOFF_BASE_MS = 1_000
const LOGIN_BACKOFF_MAX_MS = 60_000
const LOGIN_GLOBAL_WINDOW_MS = 60_000
const LOGIN_GLOBAL_LIMIT = 20
const LOGIN_GLOBAL_BLOCK_MS = 30_000
const MAX_SESSIONS = 1_000
const MAX_STAGED_EVENTS = 1_024
const MAX_STAGED_CHARS = 1_000_000
const LOGIN_BODY_LIMIT = 2_048
const SMALL_BODY_LIMIT = 8_192
const HISTORY_CURSOR_MAX = 512
const MAX_TARGET_ID = 256

/** URL 里出现任何凭据类参数都直接拒绝；值本身不进日志。 */
const URL_TOKEN_KEYS = new Set(['token', 'dashboardtoken', 'access_token', 'x-marshal-token', 'marshal-token'])

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

const randomToken = (): string => randomBytes(32).toString('base64url')

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers[name]
  // 重复头无法判断哪个是“真”的，按缺失拒绝。
  return Array.isArray(header) ? undefined : header
}

/** undefined = 没带；null = 带了但重复/格式非法。 */
function readCookie(req: IncomingMessage, name: string): string | undefined | null {
  const header = req.headers.cookie
  if (header === undefined) return undefined
  const raw = Array.isArray(header) ? header.join('; ') : header
  let found: string | undefined
  let count = 0
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    count += 1
    found = part.slice(index + 1).trim()
  }
  if (count === 0) return undefined
  // 会话/CSRF 都是 base64url；不接受引号、分号等额外编码。
  if (count > 1 || found === undefined || !/^[A-Za-z0-9_-]{16,128}$/.test(found)) return null
  return found
}

function exactOrigin(req: IncomingMessage, publicOrigin: string): boolean {
  const origin = headerValue(req, 'origin')
  return origin !== undefined && publicOrigin !== '' && origin === publicOrigin
}

function originAcceptable(req: IncomingMessage, publicOrigin: string): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (Array.isArray(origin)) return false
  // `Origin: null` 与任何不匹配都不能放行。
  return publicOrigin !== '' && origin === publicOrigin
}

function urlHasToken(req: IncomingMessage): boolean {
  try {
    const query = new URL(req.url ?? '/', 'http://marshal.invalid').searchParams
    for (const key of query.keys()) {
      if (URL_TOKEN_KEYS.has(key.toLowerCase())) return true
    }
    return false
  } catch {
    return false
  }
}

/** 按来源与全局两个维度限速；延迟不泄露 token 长度/前缀。 */
class LoginLimiter {
  private readonly sources = new Map<string, { failures: number[]; blockedUntil: number }>()
  private globalFailures: number[] = []
  private globalBlockedUntil = 0

  constructor(private readonly now: () => number) {}

  private prune(list: number[], at: number, windowMs: number): number[] {
    return list.filter(stamp => at - stamp < windowMs)
  }

  blocked(source: string): number {
    const at = this.now()
    if (this.globalBlockedUntil > at) return this.globalBlockedUntil - at
    const entry = this.sources.get(source)
    if (entry === undefined) return 0
    entry.failures = this.prune(entry.failures, at, LOGIN_WINDOW_MS)
    if (entry.failures.length === 0) { this.sources.delete(source); return 0 }
    return entry.blockedUntil > at ? entry.blockedUntil - at : 0
  }

  fail(source: string): void {
    const at = this.now()
    this.globalFailures = this.prune(this.globalFailures, at, LOGIN_GLOBAL_WINDOW_MS)
    this.globalFailures.push(at)
    if (this.globalFailures.length >= LOGIN_GLOBAL_LIMIT) {
      this.globalBlockedUntil = Math.max(this.globalBlockedUntil, at + LOGIN_GLOBAL_BLOCK_MS)
    }

    const entry = this.sources.get(source) ?? { failures: [], blockedUntil: 0 }
    entry.failures = this.prune(entry.failures, at, LOGIN_WINDOW_MS)
    entry.failures.push(at)
    if (entry.failures.length >= LOGIN_SOURCE_LIMIT) {
      const step = Math.min(entry.failures.length - LOGIN_SOURCE_LIMIT, 16)
      entry.blockedUntil = at + Math.min(LOGIN_BACKOFF_MAX_MS, LOGIN_BACKOFF_BASE_MS * 2 ** step)
    }
    this.sources.set(source, entry)
    // 来源表有界，避免被海量随机地址拖垮。
    if (this.sources.size > 10_000) {
      const oldest = this.sources.keys().next().value
      if (oldest !== undefined) this.sources.delete(oldest)
    }
  }

  success(source: string): void {
    this.sources.delete(source)
  }
}

/** 契约 §6：先按命令生命周期状态，再用 code 细分前置失败。 */
function commandHttpStatus(outcome: CommandOutcome): number {
  if (outcome.ok) return 200
  if (outcome.status === 'pending-confirmation' || outcome.status === 'outcome-unknown') return 202
  switch (outcome.code) {
    case 'device-offline':
    case 'disposed':
    case 'recovery-required':
      return 503
    case 'size-limit':
      return 413
    case 'deadline-expired':
      return 410
    case 'invalid-args':
    case 'unsupported':
    case 'tighten-only':
    case 'device-mismatch':
      return 400
    case 'session-unknown':
      return 404
    case 'idempotency-conflict':
    case 'conflict':
    case 'revision-conflict':
    case 'session-mismatch':
    case 'invalid':
    case 'unknown':
      return 409
    default:
      return 502
  }
}

/**
 * 只读状态查询的 HTTP 语义：200 已知、202 等待/未知、404 无记录。
 * 离线/恢复不可信是 503；这里绝不触发执行。
 */
function commandStatusHttpStatus(outcome: CommandStatusOutcome): number {
  if (outcome.code === 'device-offline' || outcome.code === 'disposed') return 503
  if (outcome.code === 'record-unavailable') return 404
  if (outcome.status === 'pending-confirmation' || outcome.status === 'outcome-unknown') return 202
  return 200
}

/** 出口只给分类/结果白名单字段；内部 message 与原始异常绝不回显。 */
const RESULT_KEYS = new Set([
  'accepted', 'cancelled', 'following', 'subscriptionId', 'created',
  'sessionId', 'status', 'state', 'count', 'bytes', 'chars',
])

/** 结果对象按显式白名单重建，绝不透传节点 payload。 */
function publicResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (!RESULT_KEYS.has(key)) continue
    if (typeof value === 'boolean') { out[key] = value; continue }
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) { out[key] = value; continue }
    if (typeof value === 'string' && value !== '') out[key] = value.slice(0, 128)
  }
  return Object.keys(out).length === 0 ? undefined : out
}

function publicOutcome(outcome: CommandOutcome): Record<string, unknown> {
  if (outcome.ok) {
    const result = publicResult(outcome.result)
    return {
      ok: true,
      status: outcome.status,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      ...(result === undefined ? {} : { result }),
    }
  }
  return { ok: false, status: outcome.status, code: outcome.code }
}

/** 会话索引只暴露契约字段；cwd/标题等本机信息不经过 HTTP。 */
function publicSession(row: {
  deviceId: string; agent: string; sessionId: string;
  running: boolean; updatedAt: number; blank?: boolean;
  ownership?: string; counts?: Readonly<Record<string, number>>
}): Record<string, unknown> {
  return {
    deviceId: row.deviceId,
    agent: row.agent,
    sessionId: row.sessionId,
    running: row.running,
    updatedAt: row.updatedAt,
    ...(row.blank === undefined ? {} : { blank: row.blank }),
    ...(row.ownership === undefined ? {} : { ownership: row.ownership }),
    ...(row.counts === undefined ? {} : { counts: row.counts }),
  }
}

/** 设备列表也显式重建，避免把内部字段（token 摘要等）透传出去。 */
function publicDevice(row: {
  id: string; name: string; agents: readonly string[];
  connectedAt: number; lastSeen: number
}, relay: HubRelay, sync: Pick<HubSync, 'status'> | undefined): Record<string, unknown> {
  const status = sync?.status(row.id)
  return {
    id: row.id,
    name: row.name,
    agents: [...row.agents],
    connectedAt: row.connectedAt,
    lastSeen: row.lastSeen,
    ...(status === undefined ? {} : { syncing: status.syncing, stale: status.stale }),
    capabilities: relay.capabilities(row.id),
  }
}

function isTarget(value: unknown): value is CommandFrame['target'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const target = value as Record<string, unknown>
  return typeof target.deviceId === 'string' && target.deviceId.length > 0 && target.deviceId.length <= MAX_TARGET_ID
    && typeof target.agent === 'string' && target.agent.length > 0 && target.agent.length <= MAX_TARGET_ID
    && (target.sessionId === null
      || (typeof target.sessionId === 'string' && target.sessionId.length > 0 && target.sessionId.length <= MAX_TARGET_ID))
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function shortText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined
}

/** 待答卡按显式白名单重建，避免 hub 成为任意 payload 的透传口。 */
function publicInputCard(value: unknown): Record<string, unknown> | undefined {
  const card = asRecord(value)
  if (card === undefined) return undefined
  const out: Record<string, unknown> = {}
  for (const key of ['requestId', 'sessionId', 'runtimeEpoch', 'kind', 'waitKind', 'reason'] as const) {
    const text = shortText(card[key], 256)
    if (text !== undefined) out[key] = text
  }
  for (const key of ['expiresAt', 'highWatermark'] as const) {
    const number = card[key]
    if (typeof number === 'number' && Number.isInteger(number) && number >= 0) out[key] = number
  }
  for (const key of ['acceptOnceEligible', 'ambiguous', 'truncated', 'secret'] as const) {
    if (typeof card[key] === 'boolean') out[key] = card[key]
  }
  if (Array.isArray(card.questionIds)) {
    out.questionIds = card.questionIds
      .filter((id): id is string => typeof id === 'string' && id !== '')
      .slice(0, 64)
      .map(id => id.slice(0, 128))
  }
  if (Array.isArray(card.questions)) {
    out.questions = card.questions.slice(0, 32).flatMap(raw => {
      const question = asRecord(raw)
      if (question === undefined) return []
      const entry: Record<string, unknown> = {}
      const id = shortText(question.id, 128)
      if (id !== undefined) entry.id = id
      const prompt = shortText(question.prompt, 4_096)
      if (prompt !== undefined) entry.prompt = prompt
      for (const key of ['required', 'multi', 'custom', 'secret', 'ambiguous'] as const) {
        if (typeof question[key] === 'boolean') entry[key] = question[key]
      }
      if (Array.isArray(question.options)) {
        entry.options = question.options.slice(0, 128).flatMap(rawOption => {
          const option = asRecord(rawOption)
          if (option === undefined) return []
          const optionId = shortText(option.id, 128)
          const label = shortText(option.label, 1_024)
          if (optionId === undefined || label === undefined) return []
          return [{
            id: optionId,
            label,
            ...(typeof option.description === 'string' ? { description: option.description.slice(0, 4_096) } : {}),
            ...(option.ambiguous === true ? { ambiguous: true } : {}),
          }]
        })
      }
      return Object.keys(entry).length === 0 ? [] : [entry]
    })
  }
  const approval = asRecord(card.approval)
  if (approval !== undefined) {
    const action = shortText(approval.action, 1_024)
    const decisions = Array.isArray(approval.decisions)
      ? approval.decisions.slice(0, 64).flatMap(raw => {
        const decision = asRecord(raw)
        if (decision === undefined) return []
        const id = shortText(decision.id, 128)
        const label = shortText(decision.label, 1_024)
        if (id === undefined || label === undefined) return []
        return [{ id, label, ...(decision.ambiguous === true ? { ambiguous: true } : {}) }]
      })
      : []
    if (action !== undefined) {
      out.approval = {
        action,
        ...(typeof approval.title === 'string' ? { title: approval.title.slice(0, 1_024) } : {}),
        ...(typeof approval.detail === 'string' ? { detail: approval.detail.slice(0, 4_096) } : {}),
        decisions,
      }
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

function publicCards(cards: readonly unknown[]): Record<string, unknown>[] {
  return cards.flatMap(card => {
    const clean = publicInputCard(card)
    return clean === undefined ? [] : [clean]
  })
}

function cookiePair(name: string, value: string, httpOnly: boolean, maxAge?: number): string {
  // __Host- 要求 Secure、Path=/、无 Domain；CSRF 需要页面可读，故只有它不带 HttpOnly。
  return `${name}=${value}; Path=/; Secure; SameSite=Strict${httpOnly ? '; HttpOnly' : ''}`
    + (maxAge === undefined ? '' : `; Max-Age=${maxAge}`)
}

/**
 * 挂到 DSH 的 webServer 上，不自己监听端口。
 * 只登记 exact 路径：`/marshal` 与 `/marshal/api/*`，其余请求仍归 DSH。
 */
export function registerMarshalRoutes(options: ApiOptions): { dispose(): void } {
  const { webServer, registry, relay, sync, requireToken } = options
  const now = options.now ?? Date.now
  const publicOrigin = options.publicOrigin ?? ''
  const operatorId = options.operatorId ?? 'operator-unbound'
  // 游标 epoch 以中继历史缓冲为准，保证 hello.ack、reset 与 id 行走同一个代次。
  const hubEpoch = relay.historyEpoch()
  const absoluteMs = options.sessionAbsoluteMs ?? SESSION_ABSOLUTE_MS
  const idleMs = options.sessionIdleMs ?? SESSION_IDLE_MS
  const failureDelayMs = options.loginFailureDelayMs ?? 250
  const disposers: (() => void)[] = []
  // 每条 SSE 流一个清理函数：取消订阅、清心跳，并把自己从集合里移除。
  const streams = new Set<() => void>()
  const sessionStreams = new Map<string, Set<() => void>>()
  const sessions = new Map<string, ServerSession>()
  const limiter = new LoginLimiter(now)
  const expected = digest(requireToken)
  let disposed = false

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const deny = (res: ServerResponse, status: number, body: string): void => {
    res.writeHead(status, { 'cache-control': 'no-store' }).end(body)
  }

  const methodNotAllowed = (res: ServerResponse, allow: string): void => {
    res.writeHead(405, { allow, 'cache-control': 'no-store' }).end()
  }

  const tokenMatches = (provided: string): boolean =>
    provided.length > 0 && timingSafeEqual(digest(provided), expected)

  const sessionAlive = (session: ServerSession, at: number): boolean =>
    at - session.createdAt < absoluteMs && at - session.lastSeenAt < idleMs

  const expireSession = (id: string): void => {
    sessions.delete(id)
    const set = sessionStreams.get(id)
    if (set === undefined) return
    sessionStreams.delete(id)
    // logout/到期都必须在 5s 内断开关联 SSE；这里同步关闭。
    for (const cleanup of [...set]) cleanup()
  }

  const pruneSessions = (): void => {
    const at = now()
    for (const [id, session] of [...sessions]) {
      if (sessionAlive(session, at)) continue
      expireSession(id)
    }
  }

  /**
   * 浏览器会话与 x-marshal-token 是两个独立分支：
   * 混用或无效头都直接失败，绝不回退到另一分支。
   */
  const authenticate = (req: IncomingMessage, auth: AuthOptions): AuthContext | undefined => {
    const at = now()
    const sessionCookie = readCookie(req, SESSION_COOKIE)
    const tokenHeader = headerValue(req, 'x-marshal-token')
    if (sessionCookie !== undefined) {
      // 非法/重复 cookie 不能再拿 header 兜底。
      if (sessionCookie === null || tokenHeader !== undefined) return undefined
      const session = sessions.get(sessionCookie)
      if (session === undefined || !sessionAlive(session, at)) {
        if (session !== undefined) expireSession(session.id)
        return undefined
      }
      if (auth.refresh) session.lastSeenAt = at
      return { kind: 'session', session }
    }
    if (tokenHeader === undefined || tokenHeader === '') return undefined
    if (!auth.allowToken) return undefined
    if (!tokenMatches(tokenHeader)) return undefined
    return { kind: 'token' }
  }

  const csrfMatches = (req: IncomingMessage, session: ServerSession): boolean => {
    const cookie = readCookie(req, CSRF_COOKIE)
    const header = headerValue(req, 'x-marshal-csrf')
    if (cookie === undefined || cookie === null || header === undefined || header === '') return false
    const expectedCsrf = Buffer.from(session.csrf, 'utf8')
    const fromCookie = Buffer.from(cookie, 'utf8')
    const fromHeader = Buffer.from(header, 'utf8')
    // 两边都必须与服务端该会话保存的随机值相等，header/cookie 互相相等不够。
    return fromCookie.length === expectedCsrf.length
      && fromHeader.length === expectedCsrf.length
      && timingSafeEqual(fromCookie, expectedCsrf)
      && timingSafeEqual(fromHeader, expectedCsrf)
  }

  const authorize = (req: IncomingMessage, res: ServerResponse, auth: AuthOptions): AuthContext | undefined => {
    if (urlHasToken(req)) { deny(res, 401, 'unauthorized'); return undefined }
    if (!originAcceptable(req, publicOrigin)) { deny(res, 403, 'forbidden'); return undefined }
    const context = authenticate(req, auth)
    if (context === undefined) { deny(res, 401, 'unauthorized'); return undefined }
    if (auth.write && context.kind === 'session') {
      // 浏览器写操作必须同时满足精确 Origin 与服务端会话绑定的 CSRF。
      if (!exactOrigin(req, publicOrigin) || !csrfMatches(req, context.session)) {
        deny(res, 403, 'forbidden')
        return undefined
      }
    }
    return context
  }

  /** 读取有界 JSON body；失败时已写好响应，调用方直接返回。 */
  const readJsonBody = async (
    req: IncomingMessage,
    res: ServerResponse,
    limit: number,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> => {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      total += buffer.length
      if (total > limit) {
        // 已发头就无法再改状态码；直接断开，不再继续读剩余字节。
        if (res.headersSent) { req.destroy(); return { ok: false } }
        json(res, 413, { ok: false, code: 'size-limit' })
        res.once('finish', () => req.destroy())
        return { ok: false }
      }
      chunks.push(buffer)
    }
    try {
      return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    } catch {
      json(res, 400, { ok: false, code: 'invalid-args' })
      return { ok: false }
    }
  }

  const register = (path: string, handler: Handler): void => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
  }

  // 异步失败统一收口：未发头回 500，已发头只结束响应，避免客户端一直挂着。
  const guard = (handler: Handler): Handler => async (req, res) => {
    try {
      // 畸形 URL 一律当未授权，避免抛错变成 500。
      try { new URL(req.url ?? '/', 'http://localhost') } catch { deny(res, 401, 'unauthorized'); return }
      await handler(req, res)
    } catch {
      // 不把内部错误文本回显给客户端，也不把原始异常写进日志。
      console.error('marshal: handler failed: internal')
      if (!res.headersSent) {
        json(res, 500, { ok: false, code: 'internal' })
      } else {
        res.end()
      }
    }
  }

  // 登录页公开且不含数据；其余页面/API/SSE 都经过上面的鉴权。
  register('/marshal', guard((req, res) => {
    // 页面也不接受 URL 里的 token；凭据只能走登录请求体。
    if (urlHasToken(req)) { deny(res, 401, 'unauthorized'); return }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
    res.end(PAGE_HTML)
  }))

  register('/marshal/login', guard(async (req, res) => {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    if (urlHasToken(req)) { deny(res, 401, 'unauthorized'); return }
    const source = req.socket.remoteAddress ?? 'unknown'
    const blocked = limiter.blocked(source)
    if (blocked > 0) {
      res.writeHead(429, { 'retry-after': String(Math.ceil(blocked / 1_000)), 'cache-control': 'no-store' })
        .end('rate-limited')
      return
    }
    const body = await readJsonBody(req, res, LOGIN_BODY_LIMIT)
    if (!body.ok) return
    const record = asRecord(body.value)
    const provided = record?.token
    const extraKeys = record === undefined
      ? 0
      : Object.keys(record).filter(key => key !== 'token').length
    const fail = (status: number, reason: string): void => {
      limiter.fail(source)
      // 统一失败延迟，长度/前缀差异不落在响应时序上。
      const respond = (): void => { deny(res, status, reason) }
      if (failureDelayMs > 0) setTimeout(respond, failureDelayMs)
      else respond()
    }
    // 登录必须精确匹配配置 Origin；缺失、null、不匹配都拒绝。
    if (!exactOrigin(req, publicOrigin)) { fail(403, 'forbidden'); return }
    if (typeof provided !== 'string' || provided === '' || extraKeys > 0) { fail(400, 'bad request'); return }
    if (!tokenMatches(provided)) { fail(401, 'unauthorized'); return }

    pruneSessions()
    if (sessions.size >= MAX_SESSIONS) {
      json(res, 503, { ok: false, code: 'unavailable' })
      return
    }
    const at = now()
    const session: ServerSession = {
      id: randomToken(),
      csrf: randomToken(),
      operatorId,
      createdAt: at,
      lastSeenAt: at,
    }
    sessions.set(session.id, session)
    limiter.success(source)
    res.setHeader('set-cookie', [
      cookiePair(SESSION_COOKIE, session.id, true),
      cookiePair(CSRF_COOKIE, session.csrf, false),
    ])
    json(res, 200, {
      ok: true,
      operatorId: session.operatorId,
      csrf: session.csrf,
      expiresAt: session.createdAt + absoluteMs,
    })
  }))

  register('/marshal/logout', guard((req, res) => {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    // logout 仅限浏览器会话，不接受 x-marshal-token。
    const auth = authorize(req, res, { allowToken: false, refresh: false, write: true })
    if (auth === undefined || auth.kind !== 'session') return
    expireSession(auth.session.id)
    res.setHeader('set-cookie', [
      cookiePair(SESSION_COOKIE, '', true, 0),
      cookiePair(CSRF_COOKIE, '', false, 0),
    ])
    json(res, 200, { ok: true })
  }))

  register('/marshal/api/session', guard((req, res) => {
    if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
    // 恢复会话不续期、也不新建；token 分支没有 CSRF 可返回。
    const auth = authorize(req, res, { allowToken: false, refresh: false, write: false })
    if (auth === undefined || auth.kind !== 'session') return
    json(res, 200, {
      ok: true,
      operatorId: auth.session.operatorId,
      csrf: auth.session.csrf,
      expiresAt: auth.session.createdAt + absoluteMs,
    })
  }))

  const readAccess: AuthOptions = { allowToken: true, refresh: true, write: false }

  register('/marshal/api/devices', guard((req, res) => {
    if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
    if (authorize(req, res, readAccess) === undefined) return
    json(res, 200, { devices: registry.list(now()).map(row => publicDevice(row, relay, sync)) })
  }))

  register('/marshal/api/sessions', guard((req, res) => {
    if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
    if (authorize(req, res, readAccess) === undefined) return
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    // 空串 `?device=` 与缺参等价。
    const device = query.get('device') || undefined
    json(res, 200, { sessions: relay.sessions(device).map(publicSession) })
  }))

  register('/marshal/api/command', guard(async (req, res) => {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    if (authorize(req, res, { allowToken: true, refresh: true, write: true }) === undefined) return
    const read = await readJsonBody(req, res, SMALL_BODY_LIMIT)
    if (!read.ok) return
    const body = asRecord(read.value) as CommandBody | undefined
    if (body === undefined) { json(res, 400, { ok: false, code: 'invalid-args' }); return }
    const { op, target, idempotencyKey } = body
    if (typeof op !== 'string' || !isTarget(target) || typeof idempotencyKey !== 'string'
      || idempotencyKey.length === 0 || idempotencyKey.length > 256) {
      json(res, 400, { ok: false, code: 'invalid-args' }); return
    }
    if (!(COMMAND_OPS as readonly string[]).includes(op)) {
      json(res, 400, { ok: false, code: 'invalid-args' }); return
    }
    // 每次 subscribe 都由 hub 签发新的不透明 id；页面在 HTTP 结果里取回并按 tab
    // 保存，unsubscribe 必须带同一个 id（缺 id/未知 id 由校验与节点拒绝）。
    const rawArgs: unknown = (() => {
      const candidate = body.args
      if (op !== 'observe' || typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        return candidate
      }
      const record = candidate as Record<string, unknown>
      if (record.kind !== 'follow' || record.action !== 'subscribe') return candidate
      return { ...record, subscriptionId: randomUUID() }
    })()
    // 参数在 hub 侧先按 op 校验；非法参数不进入中继，也不消耗幂等键。
    let args: ReturnType<typeof parseCommandArgs>
    try {
      args = parseCommandArgs(op as CommandOp, rawArgs)
    } catch {
      json(res, 400, { ok: false, code: 'invalid-args' }); return
    }
    const outcome = await relay.command({
      op: op as CommandFrame['op'], target, args, idempotencyKey,
    })
    json(res, commandHttpStatus(outcome), publicOutcome(outcome))
  }))

  register('/marshal/api/command-status', guard(async (req, res) => {
    if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
    if (authorize(req, res, readAccess) === undefined) return
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    const deviceId = query.get('deviceId') ?? ''
    const agent = query.get('agent') ?? ''
    const op = query.get('op') ?? ''
    const key = query.get('key') ?? ''
    const sessionParam = query.get('sessionId')
    const sessionId = sessionParam === null || sessionParam === '' ? null : sessionParam
    if (deviceId === '' || agent === '' || key === ''
      || deviceId.length > MAX_TARGET_ID || agent.length > MAX_TARGET_ID
      || (sessionId !== null && sessionId.length > MAX_TARGET_ID)
      || key.length > 256
      || !(COMMAND_OPS as readonly string[]).includes(op)) {
      json(res, 400, { ok: false, code: 'invalid-args' })
      return
    }
    const outcome = await relay.commandStatus({
      op: op as CommandOp,
      target: { deviceId, agent, sessionId },
      idempotencyKey: key,
    })
    const ok = outcome.status === 'accepted' || outcome.status === 'confirmed'
    const result = publicResult(outcome.result)
    json(res, commandStatusHttpStatus(outcome), {
      ok,
      status: outcome.status,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      ...(result === undefined ? {} : { result }),
    })
  }))

  register('/marshal/api/inputs', guard(async (req, res) => {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    if (authorize(req, res, { allowToken: true, refresh: true, write: true }) === undefined) return
    const read = await readJsonBody(req, res, SMALL_BODY_LIMIT)
    if (!read.ok) return
    const body = asRecord(read.value)
    const target = body?.target
    if (body === undefined || Object.keys(body).some(key => key !== 'target')
      || !isTarget(target) || target.sessionId === null) {
      json(res, 400, { ok: false, code: 'invalid-args' }); return
    }
    // 只读快照，不写 journal；device-offline/disposed 是 503，未知结果 202。
    const outcome = await relay.requestInputs(target, target.sessionId)
    if (!outcome.ok) {
      if (outcome.code === 'device-offline' || outcome.code === 'disposed') {
        json(res, 503, { ok: false, code: outcome.code })
      } else {
        json(res, 202, { ok: false, code: 'outcome-unknown' })
      }
      return
    }
    json(res, 200, {
      ok: true,
      runtimeEpoch: outcome.runtimeEpoch,
      highWatermark: outcome.highWatermark,
      cards: publicCards(outcome.cards),
    })
  }))

  // 历史补看用不透明 cursor 与有界 limit；每次随机幂等键，node 对 observe 不落 journal。
  register('/marshal/api/history', guard(async (req, res) => {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    if (authorize(req, res, { allowToken: true, refresh: true, write: true }) === undefined) return
    const read = await readJsonBody(req, res, SMALL_BODY_LIMIT)
    if (!read.ok) return
    const body = asRecord(read.value)
    const target = body?.target
    const cursor = body?.cursor
    const limit = body?.limit
    if (body === undefined || Object.keys(body).some(key => key !== 'target' && key !== 'cursor' && key !== 'limit')
      || !isTarget(target) || target.sessionId === null
      || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > HISTORY_CURSOR_MAX))
      || (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200))) {
      json(res, 400, { ok: false, code: 'invalid-args' }); return
    }
    const args = {
      kind: 'history' as const,
      ...(cursor === undefined ? {} : { cursor }),
      limit: limit === undefined ? 50 : limit,
    }
    let parsed: ReturnType<typeof parseCommandArgs>
    try {
      parsed = parseCommandArgs('observe', args)
    } catch {
      json(res, 400, { ok: false, code: 'invalid-args' }); return
    }
    const outcome = await relay.command({
      op: 'observe', target, args: parsed, idempotencyKey: randomUUID(),
    })
    // 结果只按 publicResult 白名单重建，任意历史 payload 不透传。
    json(res, commandHttpStatus(outcome), publicOutcome(outcome))
  }))

  register('/marshal/api/stream', guard(async (req, res) => {
    if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
    // SSE 心跳不刷新空闲期，登录态只由普通 API 请求续期。
    const auth = authorize(req, res, { allowToken: true, refresh: false, write: false })
    if (auth === undefined) return
    const sessionId = auth.kind === 'session' ? auth.session.id : undefined

    // 游标解析：query 优先于 Last-Event-ID；空串视为没带。超长游标不报 400，
    // 统一按未知游标产生 gap，避免客户端被一个坏 id 永久钉死在错误码上。
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    const queryCursor = query.get('cursor')?.trim()
    const headerCursor = headerValue(req, 'last-event-id')?.trim()
    const requestedRaw = queryCursor !== undefined && queryCursor !== ''
      ? queryCursor
      : headerCursor !== undefined && headerCursor !== '' ? headerCursor : undefined
    const replayRequested = requestedRaw !== undefined
    const requestedCursor = requestedRaw !== undefined && requestedRaw.length <= HISTORY_CURSOR_MAX
      ? requestedRaw
      : undefined

    // 背压：tab 卡住时丢弃增量，轮询会重新对齐状态，避免无限缓冲。
    let blocked = false
    const writeRaw = (text: string): void => {
      if (res.writableEnded || res.destroyed) return
      blocked = res.write(text) === false
    }
    const sendEvent = (event: EventFrame, cursor: string | undefined): void => {
      if (blocked) return
      // 只有被历史缓冲接纳的事件才有可回放 id；input.* 等交互帧不带 id。
      const id = cursor === undefined ? '' : `id: ${cursor}\n`
      writeRaw(`${id}data: ${JSON.stringify(event)}\n\n`)
    }
    const sendReset = (reset: {
      degraded: readonly string[]
      complete: boolean
      capabilities?: Record<string, Record<string, Record<string, unknown>>>
      cursor: string
      replay?: { gap: boolean; dropped: number; truncated: boolean; cursor: string }
    }): void => {
      writeRaw(`event: reset\ndata: ${JSON.stringify({
        required: true, hubEpoch, degradedDevices: [...reset.degraded], complete: reset.complete,
        cursor: reset.cursor,
        ...(reset.capabilities === undefined ? {} : { capabilities: reset.capabilities }),
        ...(reset.replay === undefined ? {} : { replay: reset.replay }),
      })}\n\n`)
    }

    // 先订阅再有界暂存：订阅回调本身就是屏障完成前的队列，不做正文回放。
    let phase: 'buffer' | 'live' = 'buffer'
    let overflow = false
    const staged: Array<{ event: EventFrame; cursor: string | undefined; purge: number }> = []
    let stagedChars = 0
    const floors = new Map<string, number>()
    /** 设备 -> 订阅时观测到的清理代次；之后发生 purge 的旧帧即使已暂存也不能发出。 */
    const purgeBase = new Map<string, number>()
    /** 设备 -> 快照时观测到的 runtimeEpoch；换代说明屏障已过期。 */
    const epochs = new Map<string, string | undefined>()
    const degraded = new Set<string>()

    const deliver = (event: EventFrame, cursor: string | undefined): void => {
      // 观测后发生过内容清理：暂存/回放中的旧帧一律不再发出。
      if (purgeBase.get(event.deviceId) !== relay.purgeGeneration(event.deviceId)) return
      // 权威代次来自中继：快照后已换代的事件（含回放）一律丢弃，不能污染新时间线。
      const authoritative = relay.nodeEpoch(event.deviceId)
      if (authoritative !== undefined && authoritative !== event.nodeEpoch) {
        const firstSeen = !degraded.has(event.deviceId)
        degraded.add(event.deviceId)
        if (firstSeen) {
          const prefix = `${event.deviceId}\u0000`
          for (const key of [...floors.keys()]) if (key.startsWith(prefix)) floors.delete(key)
          sendReset({ degraded: [...degraded], complete: false, cursor: relay.historyCursor() })
        }
        return
      }
      const key = `${event.deviceId}\u0000${event.agent}\u0000${event.sessionId}`
      const floor = floors.get(key)
      // hub 派生通知（session.updated/removed、capability.changed）带 seq 0，不参与底价去重。
      if (event.seq > 0 && floor !== undefined && event.seq <= floor) return
      if (event.seq > 0) floors.set(key, event.seq)
      // 会话已删除，长连接不再为它保留底价条目。
      if (event.kind === 'session.removed') floors.delete(key)
      sendEvent(event, cursor)
    }

    let unsubscribe: (() => void) | null = null
    try {
      unsubscribe = relay.subscribe((event, cursor) => {
        // 记录观察时的清理代次；purge 之后这张流不再发出更早观测的帧。
        const purge = relay.purgeGeneration(event.deviceId)
        purgeBase.set(event.deviceId, purge)
        if (phase === 'buffer') {
          const size = JSON.stringify(event).length
          if (staged.length >= MAX_STAGED_EVENTS || stagedChars + size > MAX_STAGED_CHARS) {
            overflow = true
            return
          }
          staged.push({ event, cursor, purge })
          stagedChars += size
          return
        }
        deliver(event, cursor)
      })
    } catch {
      // 订阅者上限是内部容量问题，不回显异常文本。
      deny(res, 503, 'unavailable')
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    res.on('drain', () => { blocked = false })

    const heartbeat = setInterval(() => {
      // 背压时跳过：缓冲还没排空，继续写只会无限堆内存；轮询会重新对齐状态。
      if (blocked || res.writableEnded || res.destroyed) return
      res.write(': ping\n\n')
    }, 15_000)

    let cleaned = false
    const cleanup = (): void => {
      // close/error/dispose 可能同时触发；重复调用必须是安全的空操作。
      if (cleaned) return
      cleaned = true
      if (unsubscribe !== null) { unsubscribe(); unsubscribe = null }
      clearInterval(heartbeat)
      streams.delete(cleanup)
      if (sessionId !== undefined) {
        const set = sessionStreams.get(sessionId)
        set?.delete(cleanup)
        if (set !== undefined && set.size === 0) sessionStreams.delete(sessionId)
      }
      // dispose 时也要结束仍挂着的响应，否则客户端会一直等下去。
      if (!res.writableEnded) res.end()
    }
    streams.add(cleanup)
    if (sessionId !== undefined) {
      let set = sessionStreams.get(sessionId)
      if (set === undefined) { set = new Set(); sessionStreams.set(sessionId, set) }
      set.add(cleanup)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)

    // 快照屏障：索引/能力可同步读，待答快照按会话异步取，期间事件留在 staged。
    const rows = relay.sessions()
    const byDevice = new Map<string, { agent: string; sessionId: string }[]>()
    for (const row of rows) {
      const list = byDevice.get(row.deviceId) ?? []
      list.push({ agent: row.agent, sessionId: row.sessionId })
      byDevice.set(row.deviceId, list)
    }
    await Promise.all([...byDevice].map(async ([deviceId, list]) => {
      await Promise.all(list.map(async item => {
        const outcome = await relay.requestInputs(
          { deviceId, agent: item.agent, sessionId: item.sessionId }, item.sessionId,
        )
        if (!outcome.ok) {
          degraded.add(deviceId)
          return
        }
        const previous = epochs.get(deviceId)
        if (previous !== undefined && previous !== outcome.runtimeEpoch) {
          // 同一设备的不同会话返回不同 runtimeEpoch：快照不可拼接。
          degraded.add(deviceId)
          return
        }
        epochs.set(deviceId, outcome.runtimeEpoch)
        floors.set(`${deviceId}\u0000${item.agent}\u0000${item.sessionId}`, outcome.highWatermark)
      }))
    }))
    if (cleaned) return

    const complete = !overflow && degraded.size === 0
    // 能力文档与索引在同一屏障内读取；页面以 reset 后的这份快照为准。
    const barrierCapabilities: Record<string, Record<string, Record<string, unknown>>> = {}
    for (const deviceId of byDevice.keys()) barrierCapabilities[deviceId] = relay.capabilities(deviceId)
    // 快照高水位：客户端拿它作为下一次 live 对齐点；历史缺口另行报告。
    const snapshotCursor = relay.historyCursor()
    let replay: BufferReadResult | undefined
    if (replayRequested) {
      replay = requestedCursor === undefined
        ? { events: [], cursor: snapshotCursor, gap: true, dropped: 0, truncated: false }
        : relay.historyRead(requestedCursor)
    }
    // v0 每次建连都要求 reset：先让客户端清空时间线/卡片，再补高水位之后的增量。
    // 屏障不完整时什么都没回放，不能报告 gap:false（否则会谎称历史已恢复）。
    sendReset({
      degraded: [...degraded], complete, capabilities: barrierCapabilities, cursor: snapshotCursor,
      ...(replay === undefined
        ? {}
        : {
            replay: {
              gap: !complete || replay.gap,
              dropped: replay.dropped,
              truncated: replay.truncated,
              // 最后一条实际回放事件；被截断时客户端可从这里继续。
              cursor: replay.cursor,
            },
          }),
    })
    // 暂存超限时整段丢弃：不知道缺了哪条，就不能放行半快照。
    if (complete) {
      // 先按接收顺序补历史，再放行屏障期间的增量；重复项由每会话 seq 底价去重。
      // 回放快照只含注册设备，已消失设备的事件不能复活幽灵会话。
      if (replay !== undefined) {
        for (const item of replay.events) {
          if (degraded.has(item.event.deviceId)) continue
          if (!relay.isDeviceKnown(item.event.deviceId)) continue
          // 回放事件在本轮读取时观测；与 purge 同期读取的帧按当前代次判断。
          purgeBase.set(item.event.deviceId, relay.purgeGeneration(item.event.deviceId))
          deliver(item.event, item.cursor)
        }
      }
      for (const item of staged) {
        if (degraded.has(item.event.deviceId)) continue
        if (!relay.isDeviceKnown(item.event.deviceId)) continue
        // 用暂存时的代次判断：purge 之前观测到的旧帧即使还在队列里也不能放行。
        purgeBase.set(item.event.deviceId, item.purge)
        deliver(item.event, item.cursor)
      }
    }
    staged.length = 0
    stagedChars = 0
    phase = 'live'
  }))

  const sweep = setInterval(pruneSessions, options.sessionSweepMs ?? 1_000)
  sweep.unref()

  return {
    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(sweep)
      // 先断开所有流，再摘掉路由；遍历副本，避免边删边迭代。
      for (const cleanup of [...streams]) cleanup()
      streams.clear()
      sessionStreams.clear()
      sessions.clear()
      for (const dispose of [...disposers].reverse()) dispose()
      disposers.length = 0
    },
  }
}
