import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServerLike } from '../../src/dsh-types.ts'

export interface MemoryRequestOptions {
  readonly method?: string
  readonly body?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly remoteAddress?: string
}

/** 不经过真实端口的最小请求：只实现 marshal 路由实际用到的成员。 */
export class MemoryRequest extends Readable {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly socket: { remoteAddress: string }

  constructor(url: string, options: MemoryRequestOptions = {}) {
    super()
    this.url = url
    this.method = options.method ?? 'GET'
    this.headers = { ...(options.headers ?? {}) }
    this.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' }
    const body = options.body
    if (body !== undefined && body !== '') this.push(body)
    this.push(null)
  }
}

export class MemoryResponse extends EventEmitter {
  statusCode = 0
  headersSent = false
  writableEnded = false
  destroyed = false
  readonly headers: Record<string, string | string[]> = {}
  readonly chunks: string[] = []

  constructor(private readonly writeResult = true) { super() }

  writeHead(status: number, headers?: Record<string, string | string[]>): this {
    this.statusCode = status
    this.headersSent = true
    for (const [key, value] of Object.entries(headers ?? {})) this.headers[key.toLowerCase()] = value
    return this
  }

  setHeader(name: string, value: string | string[]): this {
    this.headers[name.toLowerCase()] = value
    return this
  }

  write(chunk: unknown): boolean {
    if (this.writableEnded || this.destroyed) return false
    this.chunks.push(String(chunk))
    return this.writeResult
  }

  end(chunk?: unknown): this {
    if (chunk !== undefined) this.chunks.push(String(chunk))
    if (!this.writableEnded) {
      this.writableEnded = true
      this.emit('finish')
    }
    return this
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      this.emit('close')
    }
    return this
  }

  get body(): string { return this.chunks.join('') }

  json<T = unknown>(): T { return JSON.parse(this.body) as T }

  header(name: string): string | undefined {
    const value = this.headers[name.toLowerCase()]
    return Array.isArray(value) ? value.join(', ') : value
  }

  cookies(): string[] {
    const value = this.headers['set-cookie']
    if (value === undefined) return []
    return Array.isArray(value) ? value : [value]
  }

  cookie(name: string): string | undefined {
    for (const cookie of this.cookies()) {
      const first = cookie.split(';')[0] ?? ''
      const index = first.indexOf('=')
      if (index < 0) continue
      if (first.slice(0, index) === name) return first.slice(index + 1)
    }
    return undefined
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export interface MemoryWeb {
  readonly webServer: WebServerLike
  readonly routes: Map<string, Handler>
  /** 运行到处理完（含异步屏障）；SSE 会在屏障结束前就返回。 */
  request(path: string, options?: MemoryRequestOptions): Promise<MemoryResponse>
  /** 立即返回响应对象，用于观察 SSE 增量。 */
  start(path: string, options?: MemoryRequestOptions): { res: MemoryResponse; done: Promise<void> }
}

export function createMemoryWeb(options: { writeResult?: boolean } = {}): MemoryWeb {
  const routes = new Map<string, Handler>()
  const webServer: WebServerLike = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
    registerUpgrade() { return () => {} },
    getOrigin() { return 'https://marshal.example' },
  }

  const start = (path: string, requestOptions: MemoryRequestOptions = {}): { res: MemoryResponse; done: Promise<void> } => {
    const res = new MemoryResponse(options.writeResult ?? true)
    const req = new MemoryRequest(path, requestOptions)
    const pathname = new URL(path, 'https://marshal.example').pathname
    const handler = routes.get(pathname)
    const done = handler === undefined
      ? Promise.resolve().then(() => { res.writeHead(404).end() })
      : Promise.resolve(handler(req as unknown as IncomingMessage, res as unknown as ServerResponse))
        .then(() => {})
    return { res, done }
  }

  return {
    webServer,
    routes,
    start,
    async request(path, requestOptions) {
      const { res, done } = start(path, requestOptions)
      await done
      return res
    },
  }
}
