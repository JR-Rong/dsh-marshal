/** 只声明 marshal 用到的 DSH 服务成员，避免依赖 DSH 包的类型。 */
export interface SessionSummaryLike {
  readonly sessionId: string
  readonly running: boolean
  readonly blank: boolean
  readonly updatedAt: number
  readonly cwd?: string
}

export interface SessionControllerLike {
  list(request: { cursor?: string }, signal: AbortSignal): Promise<{ items: readonly SessionSummaryLike[] }>
  follow(request: unknown, signal: AbortSignal): AsyncIterable<unknown>
  prompt(request: unknown, signal: AbortSignal): Promise<unknown>
  cancel(request: unknown): unknown
}

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): () => void
  registerUpgrade(route: {
    path: string
    handler: (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void | Promise<void>
  }): () => void
  getOrigin(): string
}

/** DSH 的 `ctx.logger` 是对象，不是工厂。 */
export interface LoggerLike {
  info(message: unknown): void
  warn(message: unknown): void
  error(message: unknown): void
}

export interface MarshalContext {
  readonly webServer?: WebServerLike
  readonly sessionController?: SessionControllerLike
  readonly logger: LoggerLike
  effect(cleanup: () => void | Promise<void>, label?: string): void
}
