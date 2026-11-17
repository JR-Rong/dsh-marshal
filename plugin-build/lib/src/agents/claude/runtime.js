import { readFileSync } from 'node:fs';
import { attachmentText } from "../controls.js";
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
export const CLAUDE_RUNTIME_DEFAULT_INIT_TIMEOUT_MS = 30_000;
/** 流式输入队列上限。适配器一次只允许一个受管回合，正常最多 1 条在队。 */
export const CLAUDE_RUNTIME_MAX_QUEUED_INPUTS = 16;
/** 稳定分类；消息不含会话内容、路径或凭据。 */
export class ClaudeRuntimeError extends Error {
    name = 'ClaudeRuntimeError';
    code;
    constructor(code) {
        super(`marshal: claude runtime ${code}`);
        this.code = code;
    }
}
/** 延迟加载真实 SDK；`import type` 已经保证类型取自 0.3.316。 */
export async function loadClaudeSdk() {
    const module = await import('@anthropic-ai/claude-agent-sdk');
    return {
        query: params => module.query(params),
        listSessions: options => (options === undefined
            ? module.listSessions()
            : module.listSessions(options)),
        getSessionMessages: (sessionId, options) => (options === undefined
            ? module.getSessionMessages(sessionId)
            : module.getSessionMessages(sessionId, options)),
    };
}
export function createClaudeRuntime(options) {
    const maxQueuedInputs = Math.max(1, options.maxQueuedInputs ?? CLAUDE_RUNTIME_MAX_QUEUED_INPUTS);
    const initTimeoutMs = Math.max(1, options.initTimeoutMs ?? CLAUDE_RUNTIME_DEFAULT_INIT_TIMEOUT_MS);
    const controller = new AbortController();
    // 流式输入：Query 建立时是一条永不自己结束的 AsyncIterable，
    // 因此 createSession 不会注入任何用户回合；只有 send() 才产生输入。
    const inputs = [];
    let inputWaiter;
    let inputClosed = false;
    const wakeInput = () => {
        const waiter = inputWaiter;
        inputWaiter = undefined;
        waiter?.();
    };
    const input = (async function* () {
        while (true) {
            const next = inputs.shift();
            if (next !== undefined) {
                yield next;
                continue;
            }
            if (inputClosed)
                return;
            await new Promise(resolve => { inputWaiter = resolve; });
        }
    })();
    let state = 'idle';
    let closed = false;
    let initMessage;
    let nativeSessionId;
    let nativeVersion;
    let accountChecked = false;
    let timer;
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    // 调用方可能只关心 onMessage；未消费的拒绝不能变成 unhandledRejection。
    readyPromise.catch(() => undefined);
    const sdkOptions = {
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
    };
    // SDK 在这里 spawn CLI；之后所有失败都属于「原生调用已经发生」。
    const query = options.sdk.query({ prompt: input, options: sdkOptions });
    const clearTimer = () => {
        if (timer === undefined)
            return;
        clearTimeout(timer);
        timer = undefined;
    };
    const finish = (reason, error) => {
        if (closed)
            return;
        closed = true;
        inputClosed = true;
        inputs.length = 0;
        wakeInput();
        clearTimer();
        rejectReady?.(error instanceof ClaudeRuntimeError
            ? error
            : new ClaudeRuntimeError(reason === 'timeout' ? 'timeout' : 'failed'));
        try {
            query.close();
        }
        catch {
            // 关闭本身失败不改变已经结束的事实。
        }
        try {
            controller.abort();
        }
        catch {
            // AbortController.abort() 不会抛；防御性忽略。
        }
        if (reason === 'error' || reason === 'timeout') {
            options.onError?.(error ?? new ClaudeRuntimeError(reason === 'timeout' ? 'timeout' : 'failed'));
        }
        else if (reason === 'aborted') {
            options.onError?.(error ?? new ClaudeRuntimeError('aborted'));
        }
        options.onExit(reason);
    };
    timer = setTimeout(() => { finish('timeout'); }, initTimeoutMs);
    timer.unref();
    // 恢复流在首条用户输入之前可以不发任何身份事件。SDK 的 resume 明确绑定
    // 已存在的原会话（适配器先查只读清单），不把它标为原生事件已确认的身份。
    const routingSessionId = () => nativeSessionId
        ?? (options.forkSession !== true ? options.resume : undefined);
    const resolveInitialized = () => {
        const sessionId = routingSessionId();
        if (closed || !accountChecked || !sessionId)
            return;
        clearTimer();
        resolveReady?.({ session_id: sessionId, identitySource: nativeSessionId === undefined ? 'resume-contract' : 'native-event',
            ...(nativeVersion === undefined ? {} : { claude_code_version: nativeVersion }) });
        resolveReady = undefined;
        rejectReady = undefined;
    };
    // 空输入的 CLI 可能一直不发 system/init，但控制初始化已经明确知道登录状态。
    // 只拒绝 firstParty 显式报告的无凭据；第三方后端的认证由其自身负责。
    void query.initializationResult().then(result => {
        if (closed)
            return;
        const account = result.account;
        if (account.apiProvider === 'firstParty' && account.tokenSource === 'none'
            && (account.apiKeySource === undefined || account.apiKeySource === 'none')) {
            finish('error', new ClaudeRuntimeError('auth-required'));
            return;
        }
        accountChecked = true;
        nativeVersion = result.claude_code_version ?? nativeVersion;
        resolveInitialized();
    }).catch(error => { finish('error', error); });
    const handleMessage = (message) => {
        if (message.type === 'system') {
            // 空输入的 CLI 会先发 SessionStart 生命周期帧，再等首条输入才发 init。
            // 帧身份与已绑定的恢复目标必须一致；不解析钩子 stdout。
            const identifiesSession = message.subtype === 'init'
                || ((message.subtype === 'hook_started' || message.subtype === 'hook_response')
                    && message.hook_event === 'SessionStart');
            if (identifiesSession) {
                const expectedId = routingSessionId();
                if (!message.session_id || (expectedId !== undefined && expectedId !== message.session_id)) {
                    finish('error', new ClaudeRuntimeError('failed'));
                    return;
                }
                nativeSessionId = message.session_id;
            }
            if (message.subtype === 'init') {
                initMessage = message;
                nativeVersion = message.claude_code_version;
                state = 'idle';
            }
            else if (message.subtype === 'session_state_changed') {
                state = message.state;
            }
            if (identifiesSession)
                resolveInitialized();
        }
        options.onMessage(message);
    };
    // 消息泵只保留一个；错误归一为运行时错误并结束本 Query，不影响其它会话。
    const pump = (async () => {
        try {
            for await (const message of query) {
                if (closed)
                    return;
                handleMessage(message);
            }
            finish('closed');
        }
        catch (error) {
            if (closed)
                return;
            finish('error', error);
        }
    })();
    pump.catch(() => undefined);
    const send = (text, uuid, extras = {}) => {
        if (closed)
            throw new ClaudeRuntimeError('closed');
        if (inputs.length >= maxQueuedInputs)
            throw new ClaudeRuntimeError('busy');
        const sessionId = routingSessionId();
        const message = {
            type: 'user',
            message: { role: 'user', content: extras.files?.length ? [
                    { type: 'text', text: attachmentText(text, extras.files) },
                    ...extras.files.filter(file => file.mime.startsWith('image/')).map(file => ({ type: 'image', source: { type: 'base64', media_type: file.mime, data: readFileSync(file.path).toString('base64') } })),
                ] : text },
            parent_tool_use_id: null,
            uuid,
            ...(sessionId === undefined ? {} : { session_id: sessionId }),
        };
        inputs.push(message);
        wakeInput();
    };
    const interrupt = async (signal) => {
        // 调用前已关闭 = 确定没有送达，调用方可安全记为 rejected。
        if (closed)
            throw new ClaudeRuntimeError('closed');
        if (signal.aborted)
            throw new ClaudeRuntimeError('aborted');
        return await new Promise((resolve, reject) => {
            const onAbort = () => {
                reject(new ClaudeRuntimeError('aborted'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            query.interrupt().then(value => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            }, (error) => {
                signal.removeEventListener('abort', onAbort);
                // 已发出的 interrupt 失败没有「未送达」证据，一律归为未知结果。
                reject(error instanceof ClaudeRuntimeError ? error : new ClaudeRuntimeError('sdk'));
            });
        });
    };
    return {
        generation: options.generation,
        runtimeEpoch: options.runtimeEpoch,
        get closed() { return closed; },
        get state() { return state; },
        sessionId() { return accountChecked ? routingSessionId() : undefined; },
        init() { return initMessage; },
        ready() {
            return readyPromise;
        },
        async controls() {
            if (!query.supportedModels)
                throw new ClaudeRuntimeError('closed');
            return { models: (await query.supportedModels()).slice(0, 100).map(model => ({
                    id: model.value, label: model.displayName, efforts: model.supportedEffortLevels ?? [],
                })) };
        },
        async applyOptions(options) {
            if (options?.model) {
                if (!query.setModel)
                    throw new ClaudeRuntimeError('closed');
                await query.setModel(options.model);
            }
            if (options?.reasoning) {
                if (!query.applyFlagSettings)
                    throw new ClaudeRuntimeError('closed');
                await query.applyFlagSettings({ effortLevel: options.reasoning });
            }
        },
        send,
        interrupt,
        close() {
            finish('closed');
        },
    };
}
