import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServerLike } from '../dsh-types.ts'
import { COMMAND_OPS, type CommandFrame } from '../wire/frames.ts'
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
  const expected = digest(requireToken)

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

  const guard = (handler: Handler): Handler => (req, res) => {
    // 畸形 URL 一律当未授权，避免抛错变成 500。
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://localhost') } catch { res.writeHead(401).end('unauthorized'); return }
    if (!authorized(req, url)) { res.writeHead(401).end('unauthorized'); return }
    return handler(req, res)
  }

  disposers.push(webServer.register({
    kind: 'exact', path: '/marshal',
    handler: guard((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
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
      const device = new URL(req.url ?? '/', 'http://localhost').searchParams.get('device') ?? undefined
      json(res, 200, { sessions: relay.sessions(device) })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact', path: '/marshal/api/command',
    handler: guard(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
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
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      const unsubscribe = relay.subscribe(event => {
        // 客户端断开后 res 已不可写，写回会抛；这里直接跳过，清理交给 close 回调。
        if (res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      })
      const cleanup = (): void => { unsubscribe() }
      req.on('close', cleanup)
      res.on('close', cleanup)
      res.on('error', cleanup)
    }),
  }))

  return { dispose() { for (const dispose of disposers.reverse()) dispose() } }
}
