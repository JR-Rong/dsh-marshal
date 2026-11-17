import { readFileSync } from 'node:fs'
import { attachmentText, type PromptExtras, type SessionControls } from '../controls.ts'
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

/** 等原生身份与认证握手的上限；超过即视为本次原生调用结果未知。 */
export const CLAUDE_RUNTIME_DEFAULT_INIT_TIMEOUT_MS = 30_000
/** 流式输入队列上限。适配器一次只允许一个受管回合，正常最多 1 条在队。 */
export const CLAUDE_RUNTIME_MAX_QUEUED_INPUTS = 16

export type ClaudeRuntimeErrorCode = 'closed' | 'busy' | 'timeout' | 'aborted' | 'sdk' | 'failed' | 'auth-required'

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

/** 控制握手后的路由身份；原生事件与 SDK 的原 ID 恢复契约分开标明。 */
export interface ClaudeRuntimeReady {
  readonly session_id: string
  readonly identitySource: 'native-event' | 'resume-contract'
  readonly claude_code_version?: string
}

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
 * 本适配器驱动 `Query` 的成员子集：迭代消息、初始化结果、`interrupt()`、`close()`。
 * 每个签名直接来自 SDK 的 `Query`，不是平行定义。
 */
export type ClaudeQueryHandle = Pick<Query, 'interrupt' | 'close' | 'initializationResult'> & Partial<Pick<Query, 'supportedModels' | 'setModel' | 'applyFlagSettings'>> & AsyncIterable<SDKMessage>

export interface ClaudeRuntimeOptions {
  readonly sdk: ClaudeSdk
  /** 适配器内部代次；插件重载/重建都会递增，旧回调不能污染新实例。 */
  readonly generation: number
  readonly runtimeEpoch: string
  readonly cwd?: string
  /** 显式 acquire/fork 可恢复指定 ID；只读发现/订阅不进入这条路径。 */
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
  /** 已握手的路由身份；恢复使用 SDK resume 契约，后续原生 init 必须匹配。 */
  sessionId(): string | undefined
  /** 首次 init 的原样快照（model/permissionMode/version 只留在本机）。 */
  init(): SDKSystemMessage | undefined
  /** 等到路由身份与认证握手；恢复身份来源见 identitySource，超时/关闭时拒绝。 */
  ready(): Promise<ClaudeRuntimeReady>
  /**
   * 推入一条用户消息。只有「确定没有写出」的情况才同步抛错（closed/busy），
   * 调用方可以安全转成调用前拒绝；成功返回表示已进入流式输入队列。
   */
  send(text: string, uuid: UUID, extras?: PromptExtras): void
  controls(): Promise<SessionControls>
  applyOptions(options: PromptExtras["options"]): Promise<void>
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
  let nativeSessionId: string | undefined
  let nativeVersion: string | undefined
  let accountChecked = false
  let timer: ReturnType<typeof setTimeout> | undefined

  let resolveReady: ((message: ClaudeRuntimeReady) => void) | undefined
  let rejectReady: ((error: unknown) => void) | undefined
  const readyPromise = new Promise<ClaudeRuntimeReady>((resolve, reject) => {
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
    inputClosed = true
    inputs.length = 0
    wakeInput()
    clearTimer()
    rejectReady?.(error instanceof ClaudeRuntimeError
      ? error
      : new ClaudeRuntimeError(reason === 'timeout' ? 'timeout' : 'failed'))
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

  // 恢复流在首条用户输入之前可以不发任何身份事件。SDK 的 resume 明确绑定
  // 已存在的原会话（适配器先查只读清单），不把它标为原生事件已确认的身份。
  const routingSessionId = (): string | undefined => nativeSessionId
    ?? (options.forkSession !== true ? options.resume : undefined)

  const resolveInitialized = (): void => {
    const sessionId = routingSessionId()
    if (closed || !accountChecked || !sessionId) return
    clearTimer()
    resolveReady?.({ session_id: sessionId, identitySource: nativeSessionId === undefined ? 'resume-contract' : 'native-event',
      ...(nativeVersion === undefined ? {} : { claude_code_version: nativeVersion }) })
    resolveReady = undefined
    rejectReady = undefined
  }

  // 空输入的 CLI 可能一直不发 system/init，但控制初始化已经明确知道登录状态。
  // 只拒绝 firstParty 显式报告的无凭据；第三方后端的认证由其自身负责。
  void query.initializationResult().then(result => {
    if (closed) return
    const account = result.account
    if (account.apiProvider === 'firstParty' && account.tokenSource === 'none'
      && (account.apiKeySource === undefined || account.apiKeySource === 'none')) {
      finish('error', new ClaudeRuntimeError('auth-required'))
      return
    }
    accountChecked = true
    nativeVersion = result.claude_code_version ?? nativeVersion
    resolveInitialized()
  }).catch(error => { finish('error', error) })

  const handleMessage = (message: SDKMessage): void => {
    if (message.type === 'system') {
      // 空输入的 CLI 会先发 SessionStart 生命周期帧，再等首条输入才发 init。
      // 帧身份与已绑定的恢复目标必须一致；不解析钩子 stdout。
      const identifiesSession = message.subtype === 'init'
        || ((message.subtype === 'hook_started' || message.subtype === 'hook_response')
          && message.hook_event === 'SessionStart')
      if (identifiesSession) {
        const expectedId = routingSessionId()
        if (!message.session_id || (expectedId !== undefined && expectedId !== message.session_id)) {
          finish('error', new ClaudeRuntimeError('failed'))
          return
        }
        nativeSessionId = message.session_id
      }
      if (message.subtype === 'init') {
        initMessage = message
        nativeVersion = message.claude_code_version
        state = 'idle'
      } else if (message.subtype === 'session_state_changed') {
        state = message.state
      }
      if (identifiesSession) resolveInitialized()
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

  const send = (text: string, uuid: UUID, extras: PromptExtras = {}): void => {
    if (closed) throw new ClaudeRuntimeError('closed')
    if (inputs.length >= maxQueuedInputs) throw new ClaudeRuntimeError('busy')
    const sessionId = routingSessionId()
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: extras.files?.length ? [
        { type: 'text', text: attachmentText(text, extras.files) },
        ...extras.files.filter(file => file.mime.startsWith('image/')).map(file => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: file.mime as 'image/png', data: readFileSync(file.path).toString('base64') } })),
      ] : text },
      parent_tool_use_id: null,
      uuid,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
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
    sessionId(): string | undefined { return accountChecked ? routingSessionId() : undefined },
    init(): SDKSystemMessage | undefined { return initMessage },
    ready(): Promise<ClaudeRuntimeReady> {
      return readyPromise
    },
    async controls() {
      if (!query.supportedModels) throw new ClaudeRuntimeError('closed')
      return { models: (await query.supportedModels()).slice(0, 100).map(model => ({
        id: model.value, label: model.displayName, efforts: model.supportedEffortLevels ?? [],
      })) }
    },
    async applyOptions(options) {
      if (options?.model) {
        if (!query.setModel) throw new ClaudeRuntimeError('closed')
        await query.setModel(options.model)
      }
      if (options?.reasoning) {
        if (!query.applyFlagSettings) throw new ClaudeRuntimeError('closed')
        await query.applyFlagSettings({ effortLevel: options.reasoning as import('@anthropic-ai/claude-agent-sdk').EffortLevel })
      }
    },
    send,
    interrupt,
    close(): void {
      finish('closed')
    },
  }
}
