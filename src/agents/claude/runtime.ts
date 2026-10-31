import type { UUID } from 'node:crypto'
import type {
  GetSessionMessagesOptions, ListSessionsOptions, Options, PermissionMode, Query,
  SDKControlInterruptResponse, SDKMessage, SDKSessionInfo, SDKSystemMessage, SDKUserMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'

/**
 * Claude Agent SDK 0.3.316 的 Query 生命周期封装。
 *
 * 安全边界：
 * - SDK 自己 spawn `claude` 子进程，所以这里**不复用** `src/agents/supervisor.ts`：
 *   我们并不拥有那个子进程的 argv/退出语义，只有 `Query.close()` 与
 *   `AbortController`。用 supervisor 管一个不属于自己的进程会产生假的退出证据。
 * - 本文件只负责「一个 Query」：流式输入、消息泵、有界输入队列、状态
 *   `idle|running|requires_action`、初始化等待与错误分类；不做任何能力/所有权判断。
 * - 初始化超时/中止**不伪造 session_id**：`ready()` 用非 PreCallRejection 的错误
 *   结束，调用方据此记录 outcome-unknown。
 * - `close()` 幂等：取消输入队列、abort controller、结束 Query、清理监听。
 */

/** 等 `system/init` 的上限；超过即视为本次原生调用结果未知。 */
export const CLAUDE_RUNTIME_DEFAULT_INIT_TIMEOUT_MS = 30_000
/** 流式输入队列上限。适配器一次只允许一个受管回合，正常最多 1 条在队。 */
export const CLAUDE_RUNTIME_MAX_QUEUED_INPUTS = 16

export type ClaudeRuntimeErrorCode = 'closed' | 'busy' | 'timeout' | 'aborted' | 'sdk' | 'failed'

/** 稳定分类；消息不含会话内容、路径或凭据。 */
export class ClaudeRuntimeError extends Error {
  override readonly name = 'ClaudeRuntimeError'
  readonly code: ClaudeRuntimeErrorCode

  constructor(code: ClaudeRuntimeErrorCode) {
    super(`marshal: claude runtime ${code}`)
    this.code = code
  }
}

export type ClaudeRuntimeState = 'idle' | 'running' | 'requires_action'
export type ClaudeRuntimeExitReason = 'closed' | 'aborted' | 'error' | 'timeout'

/** 与 SDK 自己的 `query()` 参数形状一致；不另造协议。 */
export interface ClaudeSdkQueryParams {
  readonly prompt: string | AsyncIterable<SDKUserMessage>
  readonly options?: Options
}

/**
 * SDK 的三个入口：`query` 是控制动作（会 spawn CLI），`listSessions` /
 * `getSessionMessages` 是只读 JSONL 读取。测试注入假实现；
 * 生产走 `loadClaudeSdk()`，避免在本模块顶层求值 SDK bundle。
 */
export interface ClaudeSdk {
  query(params: ClaudeSdkQueryParams): Query
  listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>
  getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>
}

/** 延迟加载真实 SDK；`import type` 已经保证类型取自 0.3.316。 */
export async function loadClaudeSdk(): Promise<ClaudeSdk> {
  const module = await import('@anthropic-ai/claude-agent-sdk')
  return {
    query: params => module.query(params),
    listSessions: options => (options === undefined
      ? module.listSessions()
      : module.listSessions(options)),
    getSessionMessages: (sessionId, options) => (options === undefined
      ? module.getSessionMessages(sessionId)
      : module.getSessionMessages(sessionId, options)),
  }
}

/**
 * 本适配器驱动 `Query` 的成员子集：迭代消息、`interrupt()`、`close()`。
 * 每个签名直接来自 SDK 的 `Query`，不是平行定义。
 */
export type ClaudeQueryHandle = Pick<Query, 'interrupt' | 'close'> & AsyncIterable<SDKMessage>

export interface ClaudeRuntimeOptions {
  readonly sdk: ClaudeSdk
  /** 适配器内部代次；插件重载/重建都会递增，旧回调不能污染新实例。 */
  readonly generation: number
  readonly runtimeEpoch: string
  readonly cwd?: string
  /** 只有本适配器自己的生命周期才允许 resume；外部会话永不走这条路径。 */
  readonly resume?: string
  readonly forkSession?: boolean
  readonly pathToClaudeCodeExecutable?: string
  readonly permissionMode?: PermissionMode
  /** 原生工具审批/提问回调；由适配器分类后交给统一中继。 */
  readonly canUseTool?: Options['canUseTool']
  readonly includePartialMessages?: boolean
  readonly initTimeoutMs?: number
  readonly maxQueuedInputs?: number
  /** 每条 SDK 消息（含 init）在状态更新之后交给适配器做映射。 */
  readonly onMessage: (message: SDKMessage) => void
  /** 只调用一次：正常 close、abort、错误或初始化超时。 */
  readonly onExit: (reason: ClaudeRuntimeExitReason) => void
  /** 只调用一次，且只在异常/超时路径；正常 close 不触发。 */
  readonly onError?: (error: unknown) => void
}

export interface ClaudeRuntime {
  readonly generation: number
  readonly runtimeEpoch: string
  readonly closed: boolean
  readonly state: ClaudeRuntimeState
  /** 原生 `session_id`；`system/init` 之前为 undefined。 */
  sessionId(): string | undefined
  /** 首次 init 的原样快照（model/permissionMode/version 只留在本机）。 */
  init(): SDKSystemMessage | undefined
  /** 等到 `system/init`；超时/关闭时以 ClaudeRuntimeError 拒绝。 */
  ready(): Promise<SDKSystemMessage>
  /**
   * 推入一条用户消息。只有「确定没有写出」的情况才同步抛错（closed/busy），
   * 调用方可以安全转成调用前拒绝；成功返回表示已进入流式输入队列。
   */
  send(text: string, uuid: UUID): void
  /** `Query.interrupt()`；调用前已关闭则抛 `closed`（确定未送达）。 */
  interrupt(signal: AbortSignal): Promise<SDKControlInterruptResponse | undefined>
  close(): void
}

export function createClaudeRuntime(options: ClaudeRuntimeOptions): ClaudeRuntime {
  const maxQueuedInputs = Math.max(1, options.maxQueuedInputs ?? CLAUDE_RUNTIME_MAX_QUEUED_INPUTS)
  const initTimeoutMs = Math.max(1, options.initTimeoutMs ?? CLAUDE_RUNTIME_DEFAULT_INIT_TIMEOUT_MS)
  const controller = new AbortController()

  // 流式输入：Query 建立时是一条永不自己结束的 AsyncIterable，
  // 因此 createSession 不会注入任何用户回合；只有 send() 才产生输入。
  const inputs: SDKUserMessage[] = []
  let inputWaiter: (() => void) | undefined
  let inputClosed = false

  const wakeInput = (): void => {
    const waiter = inputWaiter
    inputWaiter = undefined
    waiter?.()
  }

  const input = (async function* (): AsyncIterable<SDKUserMessage> {
    while (true) {
      const next = inputs.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (inputClosed) return
      await new Promise<void>(resolve => { inputWaiter = resolve })
    }
  })()

  let state: ClaudeRuntimeState = 'idle'
  let closed = false
  let initMessage: SDKSystemMessage | undefined
  let exitReason: ClaudeRuntimeExitReason | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  let resolveReady: ((message: SDKSystemMessage) => void) | undefined
  let rejectReady: ((error: unknown) => void) | undefined
  const readyPromise = new Promise<SDKSystemMessage>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // 调用方可能只关心 onMessage；未消费的拒绝不能变成 unhandledRejection。
  readyPromise.catch(() => undefined)

  const sdkOptions: Options = {
    abortController: controller,
    includePartialMessages: options.includePartialMessages ?? true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.forkSession === true ? { forkSession: true } : {}),
    ...(options.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }),
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
    ...(options.canUseTool === undefined ? {} : { canUseTool: options.canUseTool }),
  }

  // SDK 在这里 spawn CLI；之后所有失败都属于「原生调用已经发生」。
  const query: ClaudeQueryHandle = options.sdk.query({ prompt: input, options: sdkOptions })

  const clearTimer = (): void => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const finish = (reason: ClaudeRuntimeExitReason, error?: unknown): void => {
    if (closed) return
    closed = true
    exitReason = reason
    inputClosed = true
    inputs.length = 0
    wakeInput()
    clearTimer()
    rejectReady?.(new ClaudeRuntimeError(reason === 'timeout' ? 'timeout' : 'failed'))
    try {
      query.close()
    } catch {
      // 关闭本身失败不改变已经结束的事实。
    }
    try {
      controller.abort()
    } catch {
      // AbortController.abort() 不会抛；防御性忽略。
    }
    if (reason === 'error' || reason === 'timeout') {
      options.onError?.(error ?? new ClaudeRuntimeError(reason === 'timeout' ? 'timeout' : 'failed'))
    } else if (reason === 'aborted') {
      options.onError?.(error ?? new ClaudeRuntimeError('aborted'))
    }
    options.onExit(reason)
  }

  timer = setTimeout(() => { finish('timeout') }, initTimeoutMs)
  timer.unref()

  const handleMessage = (message: SDKMessage): void => {
    if (message.type === 'system') {
      if (message.subtype === 'init') {
        initMessage = message
        state = 'idle'
        clearTimer()
        resolveReady?.(message)
        resolveReady = undefined
        rejectReady = undefined
      } else if (message.subtype === 'session_state_changed') {
        state = message.state
      }
    }
    options.onMessage(message)
  }

  // 消息泵只保留一个；错误归一为运行时错误并结束本 Query，不影响其它会话。
  const pump = (async (): Promise<void> => {
    try {
      for await (const message of query) {
        if (closed) return
        handleMessage(message)
      }
      finish('closed')
    } catch (error) {
      if (closed) return
      finish('error', error)
    }
  })()
  pump.catch(() => undefined)

  const send = (text: string, uuid: UUID): void => {
    if (closed) throw new ClaudeRuntimeError('closed')
    if (inputs.length >= maxQueuedInputs) throw new ClaudeRuntimeError('busy')
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid,
      ...(initMessage === undefined ? {} : { session_id: initMessage.session_id }),
    }
    inputs.push(message)
    wakeInput()
  }

  const interrupt = async (signal: AbortSignal): Promise<SDKControlInterruptResponse | undefined> => {
    // 调用前已关闭 = 确定没有送达，调用方可安全记为 rejected。
    if (closed) throw new ClaudeRuntimeError('closed')
    if (signal.aborted) throw new ClaudeRuntimeError('aborted')
    return await new Promise<SDKControlInterruptResponse | undefined>((resolve, reject) => {
      const onAbort = (): void => {
        reject(new ClaudeRuntimeError('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      query.interrupt().then(
        value => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          // 已发出的 interrupt 失败没有「未送达」证据，一律归为未知结果。
          reject(error instanceof ClaudeRuntimeError ? error : new ClaudeRuntimeError('sdk'))
        },
      )
    })
  }

  return {
    generation: options.generation,
    runtimeEpoch: options.runtimeEpoch,
    get closed(): boolean { return closed },
    get state(): ClaudeRuntimeState { return state },
    sessionId(): string | undefined { return initMessage?.session_id },
    init(): SDKSystemMessage | undefined { return initMessage },
    ready(): Promise<SDKSystemMessage> {
      if (initMessage !== undefined) return Promise.resolve(initMessage)
      if (closed) {
        return Promise.reject(new ClaudeRuntimeError(exitReason === 'timeout' ? 'timeout' : 'failed'))
      }
      return readyPromise
    },
    send,
    interrupt,
    close(): void {
      finish('closed')
    },
  }
}
