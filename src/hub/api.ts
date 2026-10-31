import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServerLike } from '../dsh-types.ts'
import { COMMAND_OPS, type CommandFrame, type CommandOp, type EventFrame } from '../wire/frames.ts'
import { parseCommandArgs } from '../wire/commands.ts'
import { MAX_FRAME_BYTES } from '../wire/limits.ts'
import type { DeviceRegistry } from './registry.ts'
import type { CommandOutcome, CommandStatusOutcome, HubRelay } from './relay.ts'
import { PAGE_HTML } from './page.ts'

export interface ApiOptions {
  readonly webServer: WebServerLike
  readonly registry: DeviceRegistry
  readonly relay: HubRelay
  readonly requireToken: string
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface CommandBody {
  op?: unknown
  target?: unknown
  args?: unknown
  idempotencyKey?: unknown
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

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
function publicOutcome(outcome: CommandOutcome): Record<string, unknown> {
  if (outcome.ok) {
    return {
      ok: true,
      status: outcome.status,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
    }
  }
  return { ok: false, status: outcome.status, code: outcome.code }
}

/** 会话索引只暴露契约字段；cwd/标题等本机信息不经过 HTTP。 */
function publicSession(row: {
  deviceId: string; agent: string; sessionId: string;
  running: boolean; updatedAt: number
}): Record<string, unknown> {
  return {
    deviceId: row.deviceId,
    agent: row.agent,
    sessionId: row.sessionId,
    running: row.running,
    updatedAt: row.updatedAt,
  }
}

function isTarget(value: unknown): value is CommandFrame['target'] {
  if (typeof value !== 'object' || value === null) return false
  const target = value as Record<string, unknown>
  return typeof target.deviceId === 'string' && target.deviceId.length > 0
    && typeof target.agent === 'string' && target.agent.length > 0
    && (target.sessionId === null || (typeof target.sessionId === 'string' && target.sessionId.length > 0))
}

/**
 * 挂到 DSH 的 webServer 上，不自己监听端口。
 * 只登记 exact 路径：`/marshal` 与 `/marshal/api/*`，其余请求仍归 DSH。
 */
export function registerMarshalRoutes(options: ApiOptions): { dispose(): void } {
  const { webServer, registry, relay, requireToken } = options
  const disposers: (() => void)[] = []
  // 每条 SSE 流一个清理函数：取消订阅、清心跳，并把自己从集合里移除。
  const streams = new Set<() => void>()
  const expected = digest(requireToken)
  let disposed = false

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  // 401 不回显任何 token 片段；比较定长摘要，长度差异不落在时序上。
  // 契约 §3/§4：token 只走 Authorization 语义的请求头，禁止 URL 查询参数（浏览器登录由 T08 提供）。
  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers['x-marshal-token']
    const provided = Array.isArray(header) ? header[0] : header
    return typeof provided === 'string' && provided.length > 0
      && timingSafeEqual(digest(provided), expected)
  }

  // 异步失败统一收口：未发头回 500，已发头只结束响应，避免客户端一直挂着。
  const guard = (handler: Handler): Handler => async (req, res) => {
    // 畸形 URL 一律当未授权，避免抛错变成 500。
    try { new URL(req.url ?? '/', 'http://localhost') } catch { res.writeHead(401).end('unauthorized'); return }
    if (!authorized(req)) { res.writeHead(401).end('unauthorized'); return }
    try {
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

  disposers.push(webServer.register({
    kind: 'exact', path: '/marshal',
    handler: guard((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // 页面本身不含数据；禁止外链携带凭据，也禁止浏览器猜内容类型。
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      })
      res.end(PAGE_HTML)
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact', path: '/marshal/api/devices',
    handler: guard((_req, res) => { json(res, 200, { devices: registry.list(Date.now()) }) }),
  }))

  disposers.push(webServer.register({
    kind: 'exact', path: '/marshal/api/sessions',
    handler: guard((req, res) => {
      // 空串 `?device=` 与缺参等价。
      const device = new URL(req.url ?? '/', 'http://localhost').searchParams.get('device') || undefined
      json(res, 200, { sessions: relay.sessions(device).map(publicSession) })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact', path: '/marshal/api/command',
    handler: guard(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
      const chunks: Buffer[] = []
      let total = 0
      let tooLarge = false
      for await (const chunk of req) {
        const buffer = chunk as Buffer
        total += buffer.length
        if (total > MAX_FRAME_BYTES) { tooLarge = true; break }
        chunks.push(buffer)
      }
      if (tooLarge) {
        // 已发头就无法再改状态码；直接断开，不再继续读剩余字节。
        if (res.headersSent) { req.destroy(); return }
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' }).end('payload too large')
        // 立即 destroy 会让 413 可能到不了客户端：先让响应刷完再断开。
        res.once('finish', () => req.destroy())
        return
      }
      let parsed: unknown
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
        res.writeHead(400).end('bad json'); return
      }
      if (typeof parsed !== 'object' || parsed === null) { res.writeHead(400).end('bad json'); return }
      const body = parsed as CommandBody
      const { op, target, idempotencyKey } = body
      if (typeof op !== 'string' || !isTarget(target) || typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        json(res, 400, { ok: false, code: 'invalid-args' }); return
      }
      if (!(COMMAND_OPS as readonly string[]).includes(op)) {
        json(res, 400, { ok: false, code: 'invalid-args' }); return
      }
      // 参数在 hub 侧先按 op 校验；非法参数不进入中继，也不消耗幂等键。
      let args: ReturnType<typeof parseCommandArgs>
      try {
        args = parseCommandArgs(op as CommandOp, body.args)
      } catch {
        json(res, 400, { ok: false, code: 'invalid-args' }); return
      }
      const outcome = await relay.command({
        op: op as CommandFrame['op'], target, args, idempotencyKey,
      })
      json(res, commandHttpStatus(outcome), publicOutcome(outcome))
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact', path: '/marshal/api/command-status',
    handler: guard(async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams
      const deviceId = query.get('deviceId') ?? ''
      const agent = query.get('agent') ?? ''
      const op = query.get('op') ?? ''
      const key = query.get('key') ?? ''
      const sessionParam = query.get('sessionId')
      const sessionId = sessionParam === null || sessionParam === '' ? null : sessionParam
      if (deviceId === '' || agent === '' || key === ''
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
      json(res, commandStatusHttpStatus(outcome), {
        ok,
        status: outcome.status,
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
      })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact', path: '/marshal/api/stream',
    handler: guard((req, res) => {
      // 背压：tab 卡住时丢弃增量，轮询会重新对齐状态，避免无限缓冲。
      let blocked = false
      const send = (event: EventFrame): void => {
        // 客户端断开后 res 已不可写，写回会抛；这里直接跳过，清理交给 close 回调。
        if (blocked || res.writableEnded || res.destroyed) return
        blocked = res.write(`data: ${JSON.stringify(event)}\n\n`) === false
      }

      // 先订阅再写头：达到订阅上限时抛错还没冲刷响应头，可以干净地回 503。
      let unsubscribe: (() => void) | null = null
      try {
        unsubscribe = relay.subscribe(send)
      } catch {
        // 订阅者上限是内部容量问题，不回显异常文本。
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('unavailable')
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
        // dispose 时也要结束仍挂着的响应，否则客户端会一直等下去。
        if (!res.writableEnded) res.end()
      }
      streams.add(cleanup)
      req.on('close', cleanup)
      res.on('close', cleanup)
      res.on('error', cleanup)
    }),
  }))

  return {
    dispose() {
      if (disposed) return
      disposed = true
      // 先断开所有流，再摘掉路由；遍历副本，避免边删边迭代。
      for (const cleanup of [...streams]) cleanup()
      streams.clear()
      for (const dispose of [...disposers].reverse()) dispose()
      disposers.length = 0
    },
  }
}
