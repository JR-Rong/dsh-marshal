/** 只声明 marshal 用到的 DSH 服务成员，避免依赖 DSH 包的类型。 */
export interface SessionSummaryLike {
  readonly sessionId: string
  readonly running: boolean
  readonly blank: boolean
  readonly updatedAt: number
  readonly cwd?: string
  /** 只有源端显式标记为可公开的短别名才允许过线；原生标题不在此列。 */
  readonly publicAlias?: string
}

export interface ActiveTurnLike { readonly turnId: string }

export interface SessionControllerLike {
  list(
    request: { cursor?: string },
    signal: AbortSignal,
  ): Promise<{ items: readonly SessionSummaryLike[]; nextCursor?: string | undefined }>
  follow(request: unknown, signal: AbortSignal): AsyncIterable<unknown>
  prompt(request: unknown, signal: AbortSignal): Promise<unknown>
  cancel(request: unknown): unknown
  /**
   * 可选的原生回合绑定。只有控制器的实际实现（不是类型声明）提供这两个
   * 方法时，适配器才开放 interrupt；否则按 unsupported 关闭。
   */
  activeTurn?(sessionId: string): Promise<ActiveTurnLike | undefined> | ActiveTurnLike | undefined
  cancelTurn?(request: { sessionId: string; turnId: string }): Promise<unknown> | unknown
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

export interface UserQuestionOptionLike { readonly label: string; readonly description?: string }

export interface UserQuestionLike {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly UserQuestionOptionLike[]
  readonly multiSelect?: boolean
}

export interface AskUserQuestionRequestLike {
  readonly questions: readonly UserQuestionLike[]
  /** 提问的根 Agent；只有它带有 session 时才可能属于本次转发。 */
  readonly agent?: { readonly session: { readonly id: string } }
  readonly signal?: AbortSignal
}

export interface AskUserQuestionAnswerLike {
  readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
}

export interface MarshalContext {
  readonly webServer?: WebServerLike
  readonly sessionController?: SessionControllerLike
  readonly logger: LoggerLike
  effect(cleanup: () => void | Promise<void>, label?: string): void
  on(
    event: 'user-questions/request',
    handler: (request: AskUserQuestionRequestLike, next: () => Promise<AskUserQuestionAnswerLike>) => Promise<AskUserQuestionAnswerLike>,
  ): () => void
}
