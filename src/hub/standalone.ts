import { createServer } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { parseConfig } from '../config.ts'
import type { LoggerLike, WebServerLike } from '../dsh-types.ts'
import { mountHub } from './runtime.ts'

export interface StandaloneOptions {
  readonly config: unknown
  readonly cert: string | Buffer
  readonly key: string | Buffer
  readonly host?: string
  readonly port?: number
  readonly logger?: LoggerLike
}

/** TLS is mandatory; this entry point never starts native agents or a desktop host. */
export async function startHubServer(options: StandaloneOptions) {
  const config = parseConfig(options.config, 'cloud-hub')
  if (config.role !== 'hub') throw new Error('marshal: standalone service requires role=hub')
  const logger = options.logger ?? console
  const routes = new Map<string, Parameters<WebServerLike['register']>[0]>()
  const upgrades = new Map<string, Parameters<WebServerLike['registerUpgrade']>[0]>()
  const pathname = (req: IncomingMessage): string | undefined => {
    try { return new URL(req.url ?? '/', 'https://marshal.invalid').pathname } catch { return undefined }
  }
  const request = (req: IncomingMessage, res: ServerResponse): void => {
    const path = pathname(req)
    if (path === undefined) { res.writeHead(400).end(); return }
    if (path === '/marshal/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"ok":true}')
      return
    }
    const route = routes.get(path) ?? [...routes.values()].find(item => item.kind === 'prefix' && path.startsWith(item.path))
    if (!route) { res.writeHead(404).end(); return }
    void Promise.resolve().then(() => route.handler(req, res)).catch(() => {
      logger.error('marshal: HTTP handler failed')
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  }
  const server = createServer({ cert: options.cert, key: options.key, minVersion: 'TLSv1.2', headersTimeout: 10_000, requestTimeout: 30_000 }, request)
  server.maxHeadersCount = 100
  // Track upgraded sockets too: server.closeAllConnections intentionally excludes them.
  const sockets = new Set<Duplex>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    const route = upgrades.get(pathname(req) ?? '')
    if (!route) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    void Promise.resolve().then(() => route.handler(req, socket, head)).catch(() => { socket.destroy() })
  })
  const web: WebServerLike = {
    register(route) {
      if (routes.has(route.path)) throw new Error('marshal: duplicate HTTP route')
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
    registerUpgrade(route) {
      if (upgrades.has(route.path)) throw new Error('marshal: duplicate upgrade route')
      upgrades.set(route.path, route)
      return () => { upgrades.delete(route.path) }
    },
    getOrigin: () => config.publicOrigin!,
  }
  const dispose = mountHub(web, config, logger)
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    dispose()
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })()
  try {
    await new Promise<void>((resolve, reject) => {
      const error = (cause: Error): void => { server.off('listening', ready); reject(cause) }
      const ready = (): void => { server.off('error', error); resolve() }
      server.once('error', error).once('listening', ready).listen(options.port ?? 48443, options.host ?? '0.0.0.0')
    })
  } catch (error) {
    await close()
    throw error
  }
  return { server, close }
}
