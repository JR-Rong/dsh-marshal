import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { WebServerLike } from '../../src/dsh-types.ts'

export interface TestWeb {
  readonly webServer: WebServerLike
  readonly server: Server
  /** 端口 0 表示由系统分配；重启场景用同一端口重新监听。 */
  listen(port?: number): Promise<number>
}

export interface TestWebOptions {
  /** 需要 wss:// 时传入自签证书；测试里用 NODE_TLS_REJECT_UNAUTHORIZED=0 接受它。 */
  readonly tls?: { readonly key: string; readonly cert: string }
}

/** 把 route 注册接到真 http(s).Server；普通路由与升级路由都直接落到同一个 server 上。 */
export function createTestWeb(options: TestWebOptions = {}): TestWeb {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) { res.writeHead(404).end(); return }
    void Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500).end() })
  }
  const server = (options.tls === undefined
    ? createHttpServer(onRequest)
    : createHttpsServer(options.tls, onRequest)) as unknown as Server
  const webServer: WebServerLike = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
    registerUpgrade(route) {
      server.on('upgrade', route.handler)
      return () => { server.off('upgrade', route.handler) }
    },
    getOrigin() { return options.tls === undefined ? 'http://127.0.0.1' : 'https://127.0.0.1' },
  }
  return {
    webServer,
    server,
    listen: (port = 0) => new Promise<number>((resolve, reject) => {
      // 显式监听指定端口时，EADDRINUSE 要通过 reject 暴露，不能变成未处理的 error 事件。
      const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    }),
  }
}

/** 关闭测试 server；未监听时是安全空操作，供多装配/重启场景按序释放。 */
export async function closeTestWeb(web: TestWeb): Promise<void> {
  if (!web.server.listening) return
  web.server.closeAllConnections?.()
  await new Promise<void>((resolve, reject) => {
    web.server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })
}
