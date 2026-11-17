/**
 * Codex app-server 的 JSON-RPC 2.0 / NDJSON 传输层。
 *
 * 这里只负责分片重组、请求关联、超时/中止、原生服务端请求应答与有界计数，
 * 不包含任何业务语义。未结束行超过上限、非法 JSON 或无法解析的响应都视为
 * 协议错误并关闭整条连接；超时只拒绝该请求，绝不自动重发。
 */
export const CODEX_PEER_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const CODEX_PEER_MAX_PENDING = 128;
export const CODEX_PEER_DEFAULT_TIMEOUT_MS = 30_000;
/** 未知通知名称只保留有界样例，避免对端噪声无限增长。 */
const MAX_UNKNOWN_NAMES = 64;
export class CodexPeerError extends Error {
    name = 'CodexPeerError';
    code;
    /** JSON-RPC 错误响应里的 code；只用于稳定分类，不携带对端 message。 */
    rpcCode;
    constructor(code, rpcCode) {
        super(`marshal: codex peer ${code}`);
        this.code = code;
        this.rpcCode = rpcCode;
    }
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function defaultTimers() {
    return {
        setTimeout(callback, ms) {
            const timer = setTimeout(callback, ms);
            timer.unref();
            return timer;
        },
        clearTimeout(handle) {
            clearTimeout(handle);
        },
    };
}
export function createCodexPeer(options) {
    const timers = options.timers ?? defaultTimers();
    const timeoutMs = Math.max(1, options.requestTimeoutMs ?? CODEX_PEER_DEFAULT_TIMEOUT_MS);
    const maxLineBytes = Math.max(1024, options.maxLineBytes ?? CODEX_PEER_MAX_LINE_BYTES);
    const maxPending = Math.max(1, options.maxPending ?? CODEX_PEER_MAX_PENDING);
    // 回调的泛型在入表时被擦除；每个 entry 只在自身请求的闭包里被调用。
    const pending = new Map();
    const unknownNames = new Set();
    let unknownNotificationCount = 0;
    let unknownResponseCount = 0;
    let serverRequestCount = 0;
    let protocolErrorCount = 0;
    let nextId = 1;
    let carry;
    let closed = false;
    const writeLine = (value) => {
        if (closed)
            throw new CodexPeerError('closed');
        try {
            options.write(JSON.stringify(value));
        }
        catch {
            throw new CodexPeerError('write');
        }
    };
    const rejectAll = (error) => {
        const entries = [...pending.values()];
        pending.clear();
        for (const entry of entries) {
            entry.detach();
            entry.clearTimer();
            entry.reject(error);
        }
    };
    const close = () => {
        if (closed)
            return;
        closed = true;
        carry = undefined;
        rejectAll(new CodexPeerError('closed'));
    };
    const failProtocol = () => {
        protocolErrorCount += 1;
        close();
        options.onFatal?.();
    };
    const noteUnknownNotification = (method) => {
        unknownNotificationCount += 1;
        if (unknownNames.size < MAX_UNKNOWN_NAMES)
            unknownNames.add(method);
    };
    const handleServerRequest = (id, method, params) => {
        serverRequestCount += 1;
        const respond = (response) => {
            if (closed)
                return;
            try {
                const body = 'result' in response
                    ? { jsonrpc: '2.0', id, result: response.result }
                    : { jsonrpc: '2.0', id, error: response.error };
                writeLine(body);
            }
            catch {
                close();
            }
        };
        const handler = options.onServerRequest;
        if (handler === undefined) {
            respond({ error: { code: -32601, message: 'method not found' } });
            return;
        }
        void (async () => {
            try {
                respond(await handler({ method, params }));
            }
            catch {
                // 处理失败只回稳定内部错误；不把异常文本或请求正文回传给原生端。
                respond({ error: { code: -32603, message: 'internal error' } });
            }
        })();
    };
    const handleResponse = (record) => {
        const id = record.id;
        if (typeof id !== 'number' || !Number.isInteger(id)) {
            unknownResponseCount += 1;
            return;
        }
        const entry = pending.get(id);
        if (entry === undefined) {
            unknownResponseCount += 1;
            return;
        }
        pending.delete(id);
        entry.detach();
        entry.clearTimer();
        if (record.error !== undefined) {
            const error = asRecord(record.error);
            const rpcCode = typeof error?.code === 'number' && Number.isInteger(error.code)
                ? error.code
                : undefined;
            entry.reject(new CodexPeerError('rpc', rpcCode));
            return;
        }
        let parsed;
        try {
            parsed = entry.parse(record.result);
        }
        catch {
            parsed = undefined;
        }
        if (parsed === undefined) {
            entry.reject(new CodexPeerError('protocol'));
            failProtocol();
            return;
        }
        entry.resolve(parsed);
    };
    const processLine = (line) => {
        if (line === '')
            return;
        let json;
        try {
            json = JSON.parse(line);
        }
        catch {
            failProtocol();
            return;
        }
        const record = asRecord(json);
        if (record === undefined) {
            failProtocol();
            return;
        }
        if (typeof record.method === 'string') {
            const id = record.id;
            if (id === undefined || id === null) {
                // 未知通知不路由给适配器，只做有界计数；已知通知原样上抛。
                if (options.knownNotifications !== undefined
                    && !options.knownNotifications.has(record.method)) {
                    noteUnknownNotification(record.method);
                    return;
                }
                options.onNotification?.(record.method, record.params);
                return;
            }
            handleServerRequest(id, record.method, record.params);
            return;
        }
        if (record.id === undefined) {
            failProtocol();
            return;
        }
        handleResponse(record);
    };
    const handle = (chunk) => {
        if (closed)
            return;
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        if (buffer.length === 0)
            return;
        const combined = carry === undefined || carry.length === 0
            ? buffer
            : Buffer.concat([carry, buffer]);
        let start = 0;
        while (true) {
            const newline = combined.indexOf(0x0a, start);
            if (newline === -1)
                break;
            // 容忍 CRLF，但只去掉一个行尾 \r。
            const end = newline > start && combined[newline - 1] === 0x0d ? newline - 1 : newline;
            if (end - start > maxLineBytes) {
                failProtocol();
                return;
            }
            processLine(combined.toString('utf8', start, end));
            start = newline + 1;
            if (closed)
                return;
        }
        const rest = start === 0 ? combined : combined.subarray(start);
        if (rest.length > maxLineBytes) {
            failProtocol();
            return;
        }
        carry = rest.length === 0 ? undefined : rest;
    };
    const request = (method, params, signal, parse) => {
        if (closed)
            return Promise.reject(new CodexPeerError('closed'));
        if (signal.aborted)
            return Promise.reject(new CodexPeerError('aborted'));
        if (pending.size >= maxPending)
            return Promise.reject(new CodexPeerError('busy'));
        const id = nextId;
        nextId += 1;
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const cleanup = () => {
                if (timer !== undefined)
                    timers.clearTimeout(timer);
                timer = undefined;
                signal.removeEventListener('abort', onAbort);
            };
            const settle = () => {
                if (settled)
                    return false;
                settled = true;
                cleanup();
                return true;
            };
            const onAbort = () => {
                if (!settle())
                    return;
                pending.delete(id);
                reject(new CodexPeerError('aborted'));
            };
            const entry = {
                parse,
                resolve: value => { if (settle())
                    resolve(value); },
                reject: error => { if (settle())
                    reject(error); },
                detach: () => signal.removeEventListener('abort', onAbort),
                clearTimer: () => {
                    if (timer === undefined)
                        return;
                    timers.clearTimeout(timer);
                    timer = undefined;
                },
            };
            timer = timers.setTimeout(() => {
                if (!settle())
                    return;
                pending.delete(id);
                reject(new CodexPeerError('timeout'));
            }, timeoutMs);
            signal.addEventListener('abort', onAbort, { once: true });
            pending.set(id, entry);
            try {
                writeLine({ jsonrpc: '2.0', id, method, params });
            }
            catch (error) {
                if (!settle())
                    return;
                pending.delete(id);
                reject(error);
                close();
                options.onFatal?.();
            }
        });
    };
    const notify = (method, params) => {
        try {
            writeLine(params === undefined
                ? { jsonrpc: '2.0', method }
                : { jsonrpc: '2.0', method, params });
        }
        catch {
            close();
        }
    };
    return {
        get closed() { return closed; },
        handle,
        request,
        notify,
        close,
        stats() {
            return {
                unknownNotifications: unknownNotificationCount,
                unknownResponses: unknownResponseCount,
                serverRequests: serverRequestCount,
                protocolErrors: protocolErrorCount,
            };
        },
    };
}
