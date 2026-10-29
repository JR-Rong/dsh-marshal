import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServerLike } from '../dsh-types.ts'
import { COMMAND_OPS, MAX_FRAME_BYTES, type CommandFrame, type EventFrame } from '../wire/frames.ts'
import type { DeviceRegistry } from './registry.ts'
import type { HubRelay } from './relay.ts'
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

/** 只接受结构完整的 target；任一字段缺失或非字符串都按缺参处理。 */
function isTarget(value: unknown): value is CommandFrame['target'] {
  if (typeof value !== 'object' || value === null) return false
  const target = value as Record<string, unknown>
  return typeof target.device === 'string' && target.device.length > 0
    && typeof target.agent === 'string' && target.agent.length > 0
    && typeof target.sessionId === 'string' && target.sessionId.length > 0
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
  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers['x-marshal-token']
    const provided = url.searchParams.get('token') ?? (Array.isArray(header) ? header[0] : header)
    return typeof provided === 'string' && provided.length > 0
      && timingSafeEqual(digest(provided), expected)
  }

  // 异步失败统一收口：未发头回 500，已发头只结束响应，避免客户端一直挂着。
  const guard = (handler: Handler): Handler => async (req, res) => {
    // 畸形 URL 一律当未授权，避免抛错变成 500。
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://localhost') } catch { res.writeHead(401).end('unauthorized'); return }
    if (!authorized(req, url)) { res.writeHead(401).end('unauthorized'); return }
    try {
      await handler(req, res)
    } catch (error) {
      // 不把内部错误文本回显给客户端，只留在服务端日志。
      console.error('marshal: handler failed', error)
      if (!res.headersSent) {
        json(res, 500, { ok: false, code: 'internal', message: 'marshal: internal error' })
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
        // token 走 URL，禁止外链携带，也禁止浏览器猜内容类型。
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
      json(res, 200, { sessions: relay.sessions(device) })
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
        res.writeHead(400).end('missing op/target/idempotencyKey'); return
      }
      if (!(COMMAND_OPS as readonly string[]).includes(op)) { res.writeHead(400).end('unknown op'); return }
      const outcome = await relay.command({
        op: op as CommandFrame['op'], target, args: body.args, idempotencyKey,
      })
      if (!outcome.ok) {
        json(res, outcome.code === 'device-offline' ? 409 : 504, outcome)
        return
      }
      json(res, 200, outcome)
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
      } catch (error) {
        const message = error instanceof Error ? error.message : 'relay: too many subscribers'
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(message)
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
