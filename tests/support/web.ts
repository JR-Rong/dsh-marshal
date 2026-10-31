import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { WebServerLike } from '../../src/dsh-types.ts'

export interface TestWeb {
  readonly webServer: WebServerLike
  readonly server: Server
  listen(): Promise<number>
}

/** 把 route 注册接到真 http.Server；普通路由与升级路由都直接落到同一个 server 上。 */
export function createTestWeb(): TestWeb {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) { res.writeHead(404).end(); return }
    void Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500).end() })
  })
  const webServer: WebServerLike = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
    registerUpgrade(route) {
      server.on('upgrade', route.handler)
      return () => { server.off('upgrade', route.handler) }
    },
    getOrigin() { return 'http://127.0.0.1' },
  }
  return {
    webServer,
    server,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })),
  }
}
