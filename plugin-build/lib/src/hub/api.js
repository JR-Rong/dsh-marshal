import { ControlsSchema } from "../agents/controls.js";
import { AccountLoginError } from "./account.js";
import { controllerCommandAllowed, createPhoneHub, onceDecisionIds, parseBearer } from "./phone.js";
import { DeviceStateError } from "./devices.js";
import { DiscussionError } from "../discussions/types.js";
import { handleMemorySyncMigrate, handleMemorySyncPull, handleMemorySyncPush } from "./memory-sync.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { COMMAND_OPS } from "../wire/frames.js";
import { parseCommandArgs } from "../wire/commands.js";
import { MAX_FRAME_BYTES } from "../wire/limits.js";
import { PAGE_HTML, DESKTOP_PAGE_HTML } from "./page.js";
export const SESSION_COOKIE = '__Host-marshal-session';
export const CSRF_COOKIE = '__Host-marshal-csrf';
export const DESKTOP_SESSION_COOKIE = '__Host-marshal-desktop-session';
export const DESKTOP_CSRF_COOKIE = '__Host-marshal-desktop-csrf';
const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_SOURCE_LIMIT = 5;
const LOGIN_BACKOFF_BASE_MS = 1_000;
const LOGIN_BACKOFF_MAX_MS = 60_000;
const LOGIN_GLOBAL_WINDOW_MS = 60_000;
const LOGIN_GLOBAL_LIMIT = 20;
const LOGIN_GLOBAL_BLOCK_MS = 30_000;
const MAX_SESSIONS = 1_000;
const MAX_STAGED_EVENTS = 1_024;
const MAX_STAGED_CHARS = 1_000_000;
const LOGIN_BODY_LIMIT = 2_048;
const SMALL_BODY_LIMIT = 8_192;
const HISTORY_CURSOR_MAX = 512;
const MAX_TARGET_ID = 256;
/** URL 里出现任何凭据类参数都直接拒绝；值本身不进日志。 */
const URL_TOKEN_KEYS = new Set(['token', 'dashboardtoken', 'access_token', 'x-marshal-token', 'marshal-token']);
const digest = (value) => createHash('sha256').update(value, 'utf8').digest();
const randomToken = () => randomBytes(32).toString('base64url');
function headerValue(req, name) {
    const header = req.headers[name];
    // 重复头无法判断哪个是“真”的，按缺失拒绝。
    return Array.isArray(header) ? undefined : header;
}
/** undefined = 没带；null = 带了但重复/格式非法。 */
function readCookie(req, name) {
    const header = req.headers.cookie;
    if (header === undefined)
        return undefined;
    const raw = Array.isArray(header) ? header.join('; ') : header;
    let found;
    let count = 0;
    for (const part of raw.split(';')) {
        const index = part.indexOf('=');
        if (index < 0)
            continue;
        if (part.slice(0, index).trim() !== name)
            continue;
        count += 1;
        found = part.slice(index + 1).trim();
    }
    if (count === 0)
        return undefined;
    // 会话/CSRF 都是 base64url；不接受引号、分号等额外编码。
    if (count > 1 || found === undefined || !/^[A-Za-z0-9_-]{16,128}$/.test(found))
        return null;
    return found;
}
function exactOrigin(req, publicOrigin) {
    const origin = headerValue(req, 'origin');
    return origin !== undefined && publicOrigin !== '' && origin === publicOrigin;
}
function originAcceptable(req, publicOrigin) {
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    if (Array.isArray(origin))
        return false;
    // `Origin: null` 与任何不匹配都不能放行。
    return publicOrigin !== '' && origin === publicOrigin;
}
function urlHasToken(req) {
    try {
        const query = new URL(req.url ?? '/', 'http://marshal.invalid').searchParams;
        for (const key of query.keys()) {
            if (URL_TOKEN_KEYS.has(key.toLowerCase()))
                return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
/** 按来源与全局两个维度限速；延迟不泄露 token 长度/前缀。 */
class LoginLimiter {
    now;
    sources = new Map();
    globalFailures = [];
    globalBlockedUntil = 0;
    constructor(now) {
        this.now = now;
    }
    prune(list, at, windowMs) {
        return list.filter(stamp => at - stamp < windowMs);
    }
    blocked(source) {
        const at = this.now();
        if (this.globalBlockedUntil > at)
            return this.globalBlockedUntil - at;
        const entry = this.sources.get(source);
        if (entry === undefined)
            return 0;
        entry.failures = this.prune(entry.failures, at, LOGIN_WINDOW_MS);
        if (entry.failures.length === 0) {
            this.sources.delete(source);
            return 0;
        }
        return entry.blockedUntil > at ? entry.blockedUntil - at : 0;
    }
    fail(source) {
        const at = this.now();
        this.globalFailures = this.prune(this.globalFailures, at, LOGIN_GLOBAL_WINDOW_MS);
        this.globalFailures.push(at);
        if (this.globalFailures.length >= LOGIN_GLOBAL_LIMIT) {
            this.globalBlockedUntil = Math.max(this.globalBlockedUntil, at + LOGIN_GLOBAL_BLOCK_MS);
        }
        const entry = this.sources.get(source) ?? { failures: [], blockedUntil: 0 };
        entry.failures = this.prune(entry.failures, at, LOGIN_WINDOW_MS);
        entry.failures.push(at);
        if (entry.failures.length >= LOGIN_SOURCE_LIMIT) {
            const step = Math.min(entry.failures.length - LOGIN_SOURCE_LIMIT, 16);
            entry.blockedUntil = at + Math.min(LOGIN_BACKOFF_MAX_MS, LOGIN_BACKOFF_BASE_MS * 2 ** step);
        }
        this.sources.set(source, entry);
        // 来源表有界，避免被海量随机地址拖垮。
        if (this.sources.size > 10_000) {
            const oldest = this.sources.keys().next().value;
            if (oldest !== undefined)
                this.sources.delete(oldest);
        }
    }
    success(source) {
        this.sources.delete(source);
    }
}
/** 契约 §6：先按命令生命周期状态，再用 code 细分前置失败。 */
function commandHttpStatus(outcome) {
    if (outcome.ok)
        return 200;
    if (outcome.status === 'pending-confirmation' || outcome.status === 'outcome-unknown')
        return 202;
    switch (outcome.code) {
        case 'device-offline':
        case 'disposed':
        case 'recovery-required':
            return 503;
        case 'size-limit':
            return 413;
        case 'deadline-expired':
            return 410;
        case 'invalid-args':
        case 'unsupported':
        case 'tighten-only':
        case 'device-mismatch':
            return 400;
        case 'session-unknown':
            return 404;
        case 'idempotency-conflict':
        case 'conflict':
        case 'revision-conflict':
        case 'session-mismatch':
        case 'invalid':
        case 'unknown':
            return 409;
        default:
            return 502;
    }
}
/**
 * 只读状态查询的 HTTP 语义：200 已知、202 等待/未知、404 无记录。
 * 离线/恢复不可信是 503；这里绝不触发执行。
 */
function commandStatusHttpStatus(outcome) {
    if (outcome.code === 'device-offline' || outcome.code === 'disposed')
        return 503;
    if (outcome.code === 'record-unavailable')
        return 404;
    if (outcome.status === 'pending-confirmation' || outcome.status === 'outcome-unknown')
        return 202;
    return 200;
}
/** 出口只给分类/结果白名单字段；内部 message 与原始异常绝不回显。 */
const RESULT_KEYS = new Set([
    'attachmentId', 'complete', 'accepted', 'cancelled', 'following', 'subscriptionId', 'created',
    'sessionId', 'status', 'state', 'count', 'bytes', 'chars',
]);
/** 结果对象按显式白名单重建，绝不透传节点 payload。 */
function publicResult(result) {
    if (typeof result !== 'object' || result === null || Array.isArray(result))
        return undefined;
    const out = {};
    const catalog = ControlsSchema.safeParse(result.controls);
    if (catalog.success)
        out.controls = catalog.data;
    for (const [key, value] of Object.entries(result)) {
        if (!RESULT_KEYS.has(key))
            continue;
        if (typeof value === 'boolean') {
            out[key] = value;
            continue;
        }
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            out[key] = value;
            continue;
        }
        if (typeof value === 'string' && value !== '')
            out[key] = value.slice(0, 128);
    }
    return Object.keys(out).length === 0 ? undefined : out;
}
function publicOutcome(outcome) {
    if (outcome.ok) {
        const result = publicResult(outcome.result);
        return {
            ok: true,
            status: outcome.status,
            ...(outcome.code === undefined ? {} : { code: outcome.code }),
            ...(result === undefined ? {} : { result }),
        };
    }
    return { ok: false, status: outcome.status, code: outcome.code };
}
/** 会话索引只暴露契约字段；标题已通过内容授权与脱敏，不暴露 cwd。 */
function publicSession(row, relay) {
    const capability = relay.sessionCapability(row.deviceId, row.agent, row.sessionId);
    return {
        deviceId: row.deviceId,
        agent: row.agent,
        sessionId: row.sessionId,
        running: row.running,
        updatedAt: row.updatedAt,
        ...(row.title === undefined ? {} : { title: row.title }),
        ...(row.blank === undefined ? {} : { blank: row.blank }),
        ...(row.ownership === undefined ? {} : { ownership: row.ownership }),
        ...(row.counts === undefined ? {} : { counts: row.counts }),
        ...(capability === undefined ? {} : { capability }),
    };
}
/** 设备列表也显式重建，避免把内部字段（token 摘要等）透传出去。 */
function publicDevice(row, relay, sync, inventory) {
    const status = sync?.status(row.id);
    return {
        id: row.id,
        name: row.name,
        agents: [...row.agents],
        connectedAt: row.connectedAt,
        lastSeen: row.lastSeen,
        ...(status === undefined ? {} : { syncing: status.syncing, stale: status.stale }),
        capabilities: relay.capabilities(row.id),
        ...(inventory === undefined ? {} : { inventory }),
    };
}
function isTarget(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const target = value;
    return typeof target.deviceId === 'string' && target.deviceId.length > 0 && target.deviceId.length <= MAX_TARGET_ID
        && typeof target.agent === 'string' && target.agent.length > 0 && target.agent.length <= MAX_TARGET_ID
        && (target.sessionId === null
            || (typeof target.sessionId === 'string' && target.sessionId.length > 0 && target.sessionId.length <= MAX_TARGET_ID));
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function shortText(value, max) {
    return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;
}
/** 待答卡按显式白名单重建，避免 hub 成为任意 payload 的透传口。 */
function publicInputCard(value) {
    const card = asRecord(value);
    if (card === undefined)
        return undefined;
    const out = {};
    for (const key of ['requestId', 'sessionId', 'runtimeEpoch', 'kind', 'waitKind', 'reason']) {
        const text = shortText(card[key], 256);
        if (text !== undefined)
            out[key] = text;
    }
    for (const key of ['expiresAt', 'highWatermark']) {
        const number = card[key];
        if (typeof number === 'number' && Number.isInteger(number) && number >= 0)
            out[key] = number;
    }
    for (const key of ['acceptOnceEligible', 'ambiguous', 'truncated', 'secret']) {
        if (typeof card[key] === 'boolean')
            out[key] = card[key];
    }
    if (Array.isArray(card.questionIds)) {
        out.questionIds = card.questionIds
            .filter((id) => typeof id === 'string' && id !== '')
            .slice(0, 64)
            .map(id => id.slice(0, 128));
    }
    if (Array.isArray(card.questions)) {
        out.questions = card.questions.slice(0, 32).flatMap(raw => {
            const question = asRecord(raw);
            if (question === undefined)
                return [];
            const entry = {};
            const id = shortText(question.id, 128);
            if (id !== undefined)
                entry.id = id;
            const prompt = shortText(question.prompt, 4_096);
            if (prompt !== undefined)
                entry.prompt = prompt;
            for (const key of ['required', 'multi', 'custom', 'secret', 'ambiguous']) {
                if (typeof question[key] === 'boolean')
                    entry[key] = question[key];
            }
            if (Array.isArray(question.options)) {
                entry.options = question.options.slice(0, 128).flatMap(rawOption => {
                    const option = asRecord(rawOption);
                    if (option === undefined)
                        return [];
                    const optionId = shortText(option.id, 128);
                    const label = shortText(option.label, 1_024);
                    if (optionId === undefined || label === undefined)
                        return [];
                    return [{
                            id: optionId,
                            label,
                            ...(typeof option.description === 'string' ? { description: option.description.slice(0, 4_096) } : {}),
                            ...(option.ambiguous === true ? { ambiguous: true } : {}),
                        }];
                });
            }
            return Object.keys(entry).length === 0 ? [] : [entry];
        });
    }
    const approval = asRecord(card.approval);
    if (approval !== undefined) {
        const action = shortText(approval.action, 1_024);
        const decisions = Array.isArray(approval.decisions)
            ? approval.decisions.slice(0, 64).flatMap(raw => {
                const decision = asRecord(raw);
                if (decision === undefined)
                    return [];
                const id = shortText(decision.id, 128);
                const label = shortText(decision.label, 1_024);
                if (id === undefined || label === undefined)
                    return [];
                return [{ id, label, ...(decision.ambiguous === true ? { ambiguous: true } : {}) }];
            })
            : [];
        if (action !== undefined) {
            out.approval = {
                action,
                ...(typeof approval.title === 'string' ? { title: approval.title.slice(0, 1_024) } : {}),
                ...(typeof approval.detail === 'string' ? { detail: approval.detail.slice(0, 4_096) } : {}),
                decisions,
            };
        }
    }
    return Object.keys(out).length === 0 ? undefined : out;
}
function publicCards(cards) {
    return cards.flatMap(card => {
        const clean = publicInputCard(card);
        return clean === undefined ? [] : [clean];
    });
}
function cookiePair(name, value, httpOnly, maxAge, partitioned = false) {
    // __Host- 要求 Secure、Path=/、无 Domain；CSRF 需要页面可读，故只有它不带 HttpOnly。
    return `${name}=${value}; Path=/; Secure; ${partitioned ? 'SameSite=None; Partitioned' : 'SameSite=Strict'}${httpOnly ? '; HttpOnly' : ''}`
        + (maxAge === undefined ? '' : `; Max-Age=${maxAge}`);
}
/**
 * 挂到 DSH 的 webServer 上，不自己监听端口。
 * 只登记 exact 路径：`/marshal` 与 `/marshal/api/*`，其余请求仍归 DSH。
 */
export function registerMarshalRoutes(options) {
    const { webServer, registry, relay, sync, requireToken, memorySync } = options;
    const desktopEmbed = options.desktopEmbed === true;
    const sessionCookieName = desktopEmbed ? DESKTOP_SESSION_COOKIE : SESSION_COOKIE;
    const csrfCookieName = desktopEmbed ? DESKTOP_CSRF_COOKIE : CSRF_COOKIE;
    const now = options.now ?? Date.now;
    const publicOrigin = options.publicOrigin ?? '';
    const phone = options.phone ?? (options.deviceStore
        ? createPhoneHub({
            now,
            store: options.deviceStore,
            findNode: (tokenDigest) => {
                const row = options.deviceStore?.findByTokenDigest(tokenDigest);
                return row !== undefined && row.role !== 'phone' ? row : undefined;
            },
        })
        : undefined);
    const phoneFrom = (req) => {
        if (phone === undefined)
            return undefined;
        const parsed = parseBearer(headerValue(req, 'authorization'));
        if (parsed?.kind !== 'phone')
            return undefined;
        const auth = phone.authenticate(parsed.token);
        return auth.ok ? auth : undefined;
    };
    const operatorId = options.operatorId ?? 'operator-unbound';
    // 游标 epoch 以中继历史缓冲为准，保证 hello.ack、reset 与 id 行走同一个代次。
    const hubEpoch = relay.historyEpoch();
    const absoluteMs = options.sessionAbsoluteMs ?? SESSION_ABSOLUTE_MS;
    const idleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;
    const failureDelayMs = options.loginFailureDelayMs ?? 250;
    const disposers = [];
    disposers.push(relay.subscribe((event) => {
        if (phone === undefined) return;
        const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload : {};
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
        if (!requestId) return;
        if (event.kind === 'input.resolved') phone.forgetCard(requestId);
        if (event.kind === 'input.requested') {
            const card = onceDecisionIds(payload);
            if (card) phone.rememberCard(requestId, card);
        }
    }));
    // 每条 SSE 流一个清理函数：取消订阅、清心跳，并把自己从集合里移除。
    const streams = new Set();
    const sessionStreams = new Map();
    const sessions = new Map();
    const limiter = new LoginLimiter(now);
    const expected = digest(requireToken);
    let disposed = false;
    const json = (res, status, body) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    };
    const deny = (res, status, body) => {
        res.writeHead(status, { 'cache-control': 'no-store' }).end(body);
    };
    const methodNotAllowed = (res, allow) => {
        res.writeHead(405, { allow, 'cache-control': 'no-store' }).end();
    };
    const tokenMatches = (provided) => provided.length > 0 && timingSafeEqual(digest(provided), expected);
    /** Device bearer auth: the node proxy uses its enrollment token, never the operator cookie. */
    const deviceFromBearer = (req) => {
        const header = req.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
        const token = header.slice(7).trim();
        if (token === '' || options.deviceStore === undefined) return undefined;
        const device = options.deviceStore.findByTokenDigest(digest(token).toString('hex'));
        if (device === undefined || device.revoked || device.role === 'phone') return undefined;
        return device;
    };
    const sessionAlive = (session, at) => at - session.createdAt < absoluteMs && at - session.lastSeenAt < idleMs;
    const expireSession = (id) => {
        sessions.delete(id);
        const set = sessionStreams.get(id);
        if (set === undefined)
            return;
        sessionStreams.delete(id);
        // logout/到期都必须在 5s 内断开关联 SSE；这里同步关闭。
        for (const cleanup of [...set])
            cleanup();
    };
    const pruneSessions = () => {
        const at = now();
        for (const [id, session] of [...sessions]) {
            if (sessionAlive(session, at))
                continue;
            expireSession(id);
        }
    };
    /**
     * 浏览器会话与 x-marshal-token 是两个独立分支：
     * 混用或无效头都直接失败，绝不回退到另一分支。
     */
    const authenticate = (req, auth) => {
        const at = now();
        const sessionCookie = readCookie(req, sessionCookieName);
        const tokenHeader = headerValue(req, 'x-marshal-token');
        if (sessionCookie !== undefined) {
            // 非法/重复 cookie 不能再拿 header 兜底。
            if (sessionCookie === null || tokenHeader !== undefined)
                return undefined;
            const session = sessions.get(sessionCookie);
            if (session === undefined || !sessionAlive(session, at)) {
                if (session !== undefined)
                    expireSession(session.id);
                return undefined;
            }
            if (auth.refresh)
                session.lastSeenAt = at;
            return { kind: 'session', session };
        }
        if (tokenHeader === undefined || tokenHeader === '')
            return undefined;
        if (!auth.allowToken)
            return undefined;
        if (!tokenMatches(tokenHeader))
            return undefined;
        return { kind: 'token' };
    };
    const csrfMatches = (req, session) => {
        const cookie = readCookie(req, csrfCookieName);
        const header = headerValue(req, 'x-marshal-csrf');
        if (cookie === undefined || cookie === null || header === undefined || header === '')
            return false;
        const expectedCsrf = Buffer.from(session.csrf, 'utf8');
        const fromCookie = Buffer.from(cookie, 'utf8');
        const fromHeader = Buffer.from(header, 'utf8');
        // 两边都必须与服务端该会话保存的随机值相等，header/cookie 互相相等不够。
        return fromCookie.length === expectedCsrf.length
            && fromHeader.length === expectedCsrf.length
            && timingSafeEqual(fromCookie, expectedCsrf)
            && timingSafeEqual(fromHeader, expectedCsrf);
    };
    const authorize = (req, res, auth) => {
        if (urlHasToken(req)) {
            deny(res, 401, 'unauthorized');
            return undefined;
        }
        if (!originAcceptable(req, publicOrigin)) {
            deny(res, 403, 'forbidden');
            return undefined;
        }
        const context = authenticate(req, auth);
        if (context === undefined) {
            deny(res, 401, 'unauthorized');
            return undefined;
        }
        if (auth.write && context.kind === 'session') {
            // 浏览器写操作必须同时满足精确 Origin 与服务端会话绑定的 CSRF。
            if (!exactOrigin(req, publicOrigin) || !csrfMatches(req, context.session)) {
                deny(res, 403, 'forbidden');
                return undefined;
            }
        }
        return context;
    };
    /** 读取有界 JSON body；失败时已写好响应，调用方直接返回。 */
    const readJsonBody = async (req, res, limit) => {
        const chunks = [];
        let total = 0;
        for await (const chunk of req) {
            const buffer = chunk;
            total += buffer.length;
            if (total > limit) {
                // 已发头就无法再改状态码；直接断开，不再继续读剩余字节。
                if (res.headersSent) {
                    req.destroy();
                    return { ok: false };
                }
                json(res, 413, { ok: false, code: 'size-limit' });
                res.once('finish', () => req.destroy());
                return { ok: false };
            }
            chunks.push(buffer);
        }
        try {
            return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
        }
        catch {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return { ok: false };
        }
    };
    const register = (path, handler) => {
        const mountedPath = desktopEmbed ? path.replace('/marshal', '/marshal/desktop') : path;
        disposers.push(webServer.register({ kind: 'exact', path: mountedPath, handler }));
    };
    // 异步失败统一收口：未发头回 500，已发头只结束响应，避免客户端一直挂着。
    const guard = (handler) => async (req, res) => {
        try {
            // 畸形 URL 一律当未授权，避免抛错变成 500。
            try {
                new URL(req.url ?? '/', 'http://localhost');
            }
            catch {
                deny(res, 401, 'unauthorized');
                return;
            }
            await handler(req, res);
        }
        catch {
            // 不把内部错误文本回显给客户端，也不把原始异常写进日志。
            console.error('marshal: handler failed: internal');
            if (!res.headersSent) {
                json(res, 500, { ok: false, code: 'internal' });
            }
            else {
                res.end();
            }
        }
    };
    // 登录页公开且不含数据；其余页面/API/SSE 都经过上面的鉴权。
    register('/marshal', guard((req, res) => {
        // 页面也不接受 URL 里的 token；凭据只能走登录请求体。
        if (urlHasToken(req)) {
            deny(res, 401, 'unauthorized');
            return;
        }
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            ...(desktopEmbed
                ? { 'content-security-policy': 'frame-ancestors dsh-app://app' }
                : { 'x-frame-options': 'DENY' }),
        });
        const html = desktopEmbed ? DESKTOP_PAGE_HTML : PAGE_HTML;
        res.end(options.accountLogin ? html.replace('var accountMode = false;', 'var accountMode = true;') : html);
    }));
    // Only a native Host sends the Platform grant. It never passes through the renderer,
    // logs, node journal or persistent Hub state. The result is a short single-use ticket.
    register('/marshal/account/exchange', guard(async (req, res) => {
        if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST');
            return;
        }
        if (!options.accountLogin) {
            json(res, 404, { code: 'unsupported' });
            return;
        }
        if (req.headers.origin !== undefined || urlHasToken(req)) {
            deny(res, 403, 'forbidden');
            return;
        }
        const source = req.socket.remoteAddress ?? 'unknown';
        if (limiter.blocked(source) > 0) {
            json(res, 429, { code: 'rate-limited' });
            return;
        }
        const body = await readJsonBody(req, res, 16_384);
        if (!body.ok)
            return;
        const data = asRecord(body.value);
        if (!data || Object.keys(data).length !== 1 || typeof data.grant !== 'string') {
            json(res, 400, { code: 'invalid-args' });
            return;
        }
        try {
            const result = await options.accountLogin.exchange(data.grant);
            limiter.success(source);
            json(res, 200, { ok: true, ...result });
        }
        catch (error) {
            limiter.fail(source);
            const code = error instanceof AccountLoginError ? error.code : 'account-unavailable';
            json(res, code === 'rate-limited' ? 429 : code === 'account-unavailable' ? 503 : 403, { ok: false, code });
        }
    }));
    register('/marshal/account/enroll', guard(async (req, res) => {
        if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST');
            return;
        }
        if (!options.accountLogin || !options.deviceStore) {
            json(res, 404, { code: 'unsupported' });
            return;
        }
        if (req.headers.origin !== undefined || urlHasToken(req)) {
            deny(res, 403, 'forbidden');
            return;
        }
        const source = req.socket.remoteAddress ?? 'unknown';
        if (limiter.blocked(source) > 0) {
            json(res, 429, { code: 'rate-limited' });
            return;
        }
        const body = await readJsonBody(req, res, 16_384);
        if (!body.ok)
            return;
        const data = asRecord(body.value);
        if (!data || Object.keys(data).some(key => !['grant', 'installationId', 'tokenDigest', 'name', 'shareContent'].includes(key))
            || typeof data.grant !== 'string' || typeof data.installationId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.installationId)
            || typeof data.tokenDigest !== 'string' || !/^[a-f0-9]{64}$/.test(data.tokenDigest)
            || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80 || /[\x00-\x1f\x7f]/.test(data.name)
            || typeof data.shareContent !== 'boolean') {
            json(res, 400, { code: 'invalid-args' });
            return;
        }
        try {
            const verified = await options.accountLogin.exchange(data.grant);
            const identity = options.accountLogin.consume(verified.ticket);
            if (!identity)
                throw new AccountLoginError('account-unavailable');
            const id = 'account-' + createHash('sha256').update(identity.accountHash + '|' + data.installationId).digest('hex').slice(0, 32);
            const device = options.deviceStore.enroll(id, data.name, data.tokenDigest, data.shareContent, identity.accountHash);
            limiter.success(source);
            json(res, 200, { ok: true, deviceId: device.id, accountHash: identity.accountHash, operatorId,
                allowContent: device.allowContent, allowDiscussion: device.allowDiscussion });
        }
        catch (error) {
            limiter.fail(source);
            const code = error instanceof AccountLoginError || error instanceof DeviceStateError ? error.code : 'account-unavailable';
            json(res, code === 'account-unavailable' ? 503 : code === 'rate-limited' ? 429 : 403, { ok: false, code });
        }
    }));
    register('/marshal/login', guard(async (req, res) => {
        if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST');
            return;
        }
        if (urlHasToken(req)) {
            deny(res, 401, 'unauthorized');
            return;
        }
        const source = req.socket.remoteAddress ?? 'unknown';
        const blocked = limiter.blocked(source);
        if (blocked > 0) {
            res.writeHead(429, { 'retry-after': String(Math.ceil(blocked / 1_000)), 'cache-control': 'no-store' })
                .end('rate-limited');
            return;
        }
        const body = await readJsonBody(req, res, LOGIN_BODY_LIMIT);
        if (!body.ok)
            return;
        const record = asRecord(body.value);
        const field = options.accountLogin ? 'ticket' : 'token';
        const provided = record?.[field];
        const extraKeys = record === undefined
            ? 0
            : Object.keys(record).filter(key => key !== field).length;
        const fail = (status, reason) => {
            limiter.fail(source);
            // 统一失败延迟，长度/前缀差异不落在响应时序上。
            const respond = () => { deny(res, status, reason); };
            if (failureDelayMs > 0)
                setTimeout(respond, failureDelayMs);
            else
                respond();
        };
        // 登录必须精确匹配配置 Origin；缺失、null、不匹配都拒绝。
        if (!exactOrigin(req, publicOrigin)) {
            fail(403, 'forbidden');
            return;
        }
        if (typeof provided !== 'string' || provided === '' || extraKeys > 0) {
            fail(400, 'bad request');
            return;
        }
        const account = options.accountLogin?.consume(provided);
        if (options.accountLogin ? !account : !tokenMatches(provided)) {
            fail(401, 'unauthorized');
            return;
        }
        pruneSessions();
        const previous = readCookie(req, sessionCookieName);
        if (typeof previous === 'string')
            expireSession(previous);
        if (sessions.size >= MAX_SESSIONS) {
            json(res, 503, { ok: false, code: 'unavailable' });
            return;
        }
        const at = now();
        const session = {
            id: randomToken(),
            csrf: randomToken(),
            operatorId,
            createdAt: at,
            lastSeenAt: at,
            ...(account === undefined ? {} : { account }),
        };
        sessions.set(session.id, session);
        limiter.success(source);
        res.setHeader('set-cookie', [
            cookiePair(sessionCookieName, session.id, true, undefined, desktopEmbed),
            cookiePair(csrfCookieName, session.csrf, false, undefined, desktopEmbed),
        ]);
        json(res, 200, {
            ok: true,
            operatorId: session.operatorId,
            csrf: session.csrf,
            expiresAt: session.createdAt + absoluteMs,
            ...(session.account === undefined ? {} : { account: session.account, workspaceName: '我的调度空间' }),
        });
    }));
    register('/marshal/logout', guard((req, res) => {
        if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST');
            return;
        }
        // logout 仅限浏览器会话，不接受 x-marshal-token。
        const auth = authorize(req, res, { allowToken: false, refresh: false, write: true });
        if (auth === undefined || auth.kind !== 'session')
            return;
        expireSession(auth.session.id);
        res.setHeader('set-cookie', [
            cookiePair(sessionCookieName, '', true, 0, desktopEmbed),
            cookiePair(csrfCookieName, '', false, 0, desktopEmbed),
        ]);
        json(res, 200, { ok: true });
    }));
    register('/marshal/api/session', guard((req, res) => {
        if (req.method !== 'GET') {
            methodNotAllowed(res, 'GET');
            return;
        }
        // 恢复会话不续期、也不新建；token 分支没有 CSRF 可返回。
        const auth = authorize(req, res, { allowToken: false, refresh: false, write: false });
        if (auth === undefined || auth.kind !== 'session')
            return;
        json(res, 200, {
            ok: true,
            operatorId: auth.session.operatorId,
            csrf: auth.session.csrf,
            expiresAt: auth.session.createdAt + absoluteMs,
            ...(auth.session.account === undefined ? {} : { account: auth.session.account, workspaceName: '我的调度空间' }),
        });
    }));
    const readAccess = { allowToken: true, refresh: true, write: false };
    register('/marshal/api/devices', guard((req, res) => {
        if (req.method !== 'GET') {
            methodNotAllowed(res, 'GET');
            return;
        }
        if (parseBearer(headerValue(req, 'authorization'))?.kind === 'node') {
            deny(res, 401, 'unauthorized');
            return;
        }
        if (phoneFrom(req) === undefined && authorize(req, res, readAccess) === undefined)
            return;
        const phones = phone?.listPhones() ?? [];
        json(res, 200, { devices: registry.list(now()).map(row => publicDevice({ ...row, name: options.deviceStore?.findById(row.id)?.name ?? row.name }, relay, sync, options.inventories?.get(row.id))), phones });
    }));
    const crossGroups = options.crossGroups;
    const crossAuth = (req, res, write) => {
        if (deviceFromBearer(req) !== undefined) return true;
        return authorize(req, res, { allowToken: true, refresh: false, write }) !== undefined;
    };
    const crossUnavailable = (res) => {
        json(res, 503, { ok: false, code: 'cross-groups-unavailable' });
    };
    register('/marshal/api/cross-groups/state', guard((req, res) => {
        if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return; }
        if (crossGroups === undefined) { crossUnavailable(res); return; }
        if (!crossAuth(req, res, false)) return;
        json(res, 200, { ok: true, ...crossGroups.state() });
    }));
    register('/marshal/api/cross-groups/catalog', guard((req, res) => {
        if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return; }
        if (!crossAuth(req, res, false)) return;
        const devices = registry.list(now()).map(row => {
            const inventory = options.inventories?.get(row.id);
            const members = [];
            for (const squad of inventory?.squads ?? []) {
                for (const member of squad.members ?? []) members.push({ ...member, squadId: squad.id, squadName: squad.name });
            }
            return { id: row.id, name: options.deviceStore?.findById(row.id)?.name ?? row.name, online: true, agents: inventory?.agents ?? [], members };
        });
        json(res, 200, { ok: true, devices });
    }));
    register('/marshal/api/cross-groups/create', guard(async (req, res) => {
        if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return; }
        if (crossGroups === undefined) { crossUnavailable(res); return; }
        if (!crossAuth(req, res, true)) return;
        const read = await readJsonBody(req, res, SMALL_BODY_LIMIT);
        if (!read.ok) return;
        try {
            const group = crossGroups.create(asRecord(read.value));
            json(res, 200, { ok: true, group });
        }
        catch (error) {
            json(res, 400, { ok: false, code: error instanceof Error ? error.message : 'invalid-args' });
        }
    }));
    register('/marshal/api/cross-groups/send', guard(async (req, res) => {
        if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return; }
        if (crossGroups === undefined) { crossUnavailable(res); return; }
        if (!crossAuth(req, res, true)) return;
        const read = await readJsonBody(req, res, SMALL_BODY_LIMIT);
        if (!read.ok) return;
        const body = asRecord(read.value);
        if (body === undefined || typeof body.id !== 'string') { json(res, 400, { ok: false, code: 'invalid-args' }); return; }
        try {
            const result = await crossGroups.send(body.id, { text: body.text, mentions: body.mentions });
            json(res, 200, { ok: true, ...result });
        }
        catch (error) {
            json(res, 400, { ok: false, code: error instanceof Error ? error.message : 'send-failed' });
        }
    }));
    register('/marshal/api/memory-sync/push', guard(async (req, res) => {
        await handleMemorySyncPush(req, res, { memorySync, deviceFromRequest: deviceFromBearer, operatorId });
    }));
    register('/marshal/api/memory-sync/pull', guard((req, res) => {
        handleMemorySyncPull(req, res, { memorySync, deviceFromRequest: deviceFromBearer, operatorId });
    }));
    register('/marshal/api/memory-sync/migrate', guard(async (req, res) => {
        await handleMemorySyncMigrate(req, res, { memorySync, deviceFromRequest: deviceFromBearer });
    }));
    register('/marshal/api/device-name', guard(async (req, res) => {
        if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST');
            return;
        }
        if (authorize(req, res, { allowToken: true, refresh: true, write: true }) === undefined)
            return;
        const read = await readJsonBody(req, res, SMALL_BODY_LIMIT);
        if (!read.ok)
            return;
        const body = asRecord(read.value);
        if (!body || typeof body.deviceId !== 'string' || typeof body.name !== 'string' || !options.deviceStore) {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        try {
            const device = options.deviceStore.rename(body.deviceId, body.name);
            json(res, 200, { ok: true, device: { id: device.id, name: device.name } });
        }
        catch (error) {
            json(res, error instanceof DeviceStateError && error.code === 'unknown-device' ? 404 : 400, { ok: false, code: 'invalid-args' });
        }
    }));
    register('/marshal/pair', guard((req, res) => {
        if (req.method !== 'GET' || phone === undefined) {
            methodNotAllowed(res, 'GET');
            return;
        }
        const auth = authorize(req, res, { allowToken: false, refresh: false, write: false });
        if (auth?.kind !== 'session' || auth.session.account === undefined) {
            json(res, 403, { ok: false, code: 'account-required' });
            return;
        }
        const issued = phone.issuePairing(auth.session.account.accountHash, publicOrigin || 'https://hub.local');
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-frame-options': 'DENY',
            'content-security-policy': "frame-ancestors 'none'",
            'referrer-policy': 'no-referrer',
        });
        res.end(pairingPage(issued.url, issued.code, issued.expiresAt, csrfCookieName));
    }));
    register('/marshal/api/pairing', guard(async (req, res) => {
        if (req.method !== 'POST' || phone === undefined) {
            methodNotAllowed(res, 'POST');
            return;
        }
        if (parseBearer(headerValue(req, 'authorization'))) {
            deny(res, 403, 'forbidden');
            return;
        }
        const auth = authorize(req, res, { allowToken: false, refresh: true, write: true });
        if (auth?.kind !== 'session' || auth.session.account === undefined) {
            json(res, 403, { ok: false, code: 'account-required' });
            return;
        }
        const accountHash = auth.session.account.accountHash;
        const read = await readJsonBody(req, res, SMALL_BODY_LIMIT);
        if (!read.ok)
            return;
        const body = asRecord(read.value) ?? {};
        const replace = typeof body.replace === 'string' && body.replace !== '' ? body.replace : undefined;
        json(res, 200, { ok: true, ...phone.issuePairing(accountHash, publicOrigin || 'https://hub.local', replace) });
    }));
    register('/marshal/api/pairing/redeem', guard(async (req, res) => {
        if (req.method !== 'POST' || phone === undefined) {
            methodNotAllowed(res, 'POST');
            return;
        }
        const read = await readJsonBody(req, res, SMALL_BODY_LIMIT);
        if (!read.ok)
            return;
        const body = asRecord(read.value);
        if (!body || typeof body.code !== 'string' || typeof body.name !== 'string' || typeof body.installationId !== 'string') {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        try {
            const created = phone.redeem(body.code, body.name, body.installationId);
            json(res, 200, { ok: true, deviceId: created.record.id, credential: created.credential });
        }
        catch {
            json(res, 410, { ok: false, code: 'unknown' });
        }
    }));
    register('/marshal/api/phones/revoke', guard(async (req, res) => {
        if (req.method !== 'POST' || phone === undefined) {
            methodNotAllowed(res, 'POST');
            return;
        }
        if (authorize(req, res, { allowToken: false, refresh: true, write: true }) === undefined)
            return;
        const read = await readJsonBody(req, res, SMALL_BODY_LIMIT);
        if (!read.ok)
            return;
        const body = asRecord(read.value);
        if (!body || typeof body.deviceId !== 'string') {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        try {
            phone.revoke(body.deviceId);
            json(res, 200, { ok: true });
        }
        catch {
            json(res, 404, { ok: false, code: 'unknown-device' });
        }
    }));
    register('/marshal/api/board', guard(async (req, res) => {
        if (phone === undefined) {
            json(res, 503, { ok: false, code: 'unsupported' });
            return;
        }
        const parsed = parseBearer(headerValue(req, 'authorization'));
        if (parsed === undefined) {
            deny(res, 401, 'unauthorized');
            return;
        }
        if (req.method === 'GET') {
            const auth = parsed.kind === 'phone' ? phone.authenticate(parsed.token) : { ok: false, code: 'unauthorized' };
            if (!auth.ok) {
                deny(res, 401, 'unauthorized');
                return;
            }
            json(res, 200, { ok: true, tasks: phone.tasksFor(), revisions: phone.revisions() });
            return;
        }
        if (req.method !== 'POST') {
            methodNotAllowed(res, 'GET, POST');
            return;
        }
        const read = await readJsonBody(req, res, 65_536);
        if (!read.ok)
            return;
        const body = asRecord(read.value) ?? {};
        if (parsed.kind === 'node') {
            const auth = phone.authenticateNode(parsed.token);
            if (!auth.ok) {
                deny(res, 401, 'unauthorized');
                return;
            }
            const result = phone.writeTasks(auth, body);
            json(res, 200, { ok: true, tasks: result.tasks, commands: phone.commandsFor(auth.device.id) });
            return;
        }
        const auth = phone.authenticate(parsed.token);
        if (!auth.ok) {
            deny(res, 401, 'unauthorized');
            return;
        }
        const result = phone.writeTasks(auth, body);
        json(res, result.conflict ? 409 : 202, { ok: !result.conflict, code: result.conflict ? 'conflict' : 'queued', tasks: result.tasks });
    }));
    register('/marshal/api/memory', guard(async (req, res) => {
        if (phone === undefined) {
            json(res, 503, { ok: false, code: 'unsupported' });
            return;
        }
        const parsed = parseBearer(headerValue(req, 'authorization'));
        if (parsed === undefined) {
            deny(res, 401, 'unauthorized');
            return;
        }
        if (req.method === 'GET') {
            if (parsed.kind !== 'phone' || !phone.authenticate(parsed.token).ok) {
                deny(res, 401, 'unauthorized');
                return;
            }
            json(res, 200, { ok: true, entries: phone.readMemory() });
            return;
        }
        if (req.method !== 'POST' || parsed.kind !== 'node') {
            deny(res, 403, 'forbidden');
            return;
        }
        const auth = phone.authenticateNode(parsed.token);
        if (!auth.ok) {
            deny(res, 401, 'unauthorized');
            return;
        }
        const read = await readJsonBody(req, res, 65_536);
        if (!read.ok)
            return;
        json(res, 200, { ok: true, entries: phone.writeMemory(auth, asRecord(read.value)?.entries) });
    }));
    register('/marshal/api/roster', guard(async (req, res) => {
        if (phone === undefined) {
            json(res, 503, { ok: false, code: 'unsupported' });
            return;
        }
        const parsed = parseBearer(headerValue(req, 'authorization'));
        if (parsed === undefined) {
            deny(res, 401, 'unauthorized');
            return;
        }
        if (req.method === 'GET') {
            if (parsed.kind !== 'phone' || !phone.authenticate(parsed.token).ok) {
                deny(res, 401, 'unauthorized');
                return;
            }
            json(res, 200, { ok: true, agents: phone.readRoster() });
            return;
        }
        if (req.method !== 'POST' || parsed.kind !== 'node') {
            deny(res, 403, 'forbidden');
            return;
        }
        const auth = phone.authenticateNode(parsed.token);
        if (!auth.ok) {
            deny(res, 401, 'unauthorized');
            return;
        }
        const read = await readJsonBody(req, res, 65_536);
        if (!read.ok)
            return;
        json(res, 200, { ok: true, agents: phone.writeRoster(auth, asRecord(read.value)?.agents) });
    }));
    register('/marshal/api/push-token', guard(async (req, res) => {
        if (req.method !== 'POST' || phone === undefined) {
            methodNotAllowed(res, 'POST');
            return;
        }
        const parsed = parseBearer(headerValue(req, 'authorization'));
        const auth = parsed?.kind === 'phone' ? phone.authenticate(parsed.token) : undefined;
        if (auth === undefined || !auth.ok) {
            deny(res, 401, 'unauthorized');
            return;
        }
        const read = await readJsonBody(req, res, SMALL_BODY_LIMIT);
        if (!read.ok)
            return;
        const body = asRecord(read.value);
        const provider = body?.provider;
        if (!body || (provider !== 'apns' && provider !== 'fcm' && provider !== 'huawei') || typeof body.token !== 'string' || body.token === '') {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        phone.registerPush(auth, {
            provider,
            token: body.token,
            ...(typeof body.liveToken === 'string' ? { liveToken: body.liveToken } : {}),
        });
        json(res, 200, { ok: true });
    }));
    register('/marshal/api/watch', guard(async (req, res) => {
        if (req.method !== 'POST' || phone === undefined) {
            methodNotAllowed(res, 'POST');
            return;
        }
        const parsed = parseBearer(headerValue(req, 'authorization'));
        const auth = parsed?.kind === 'phone' ? phone.authenticate(parsed.token) : undefined;
        if (auth === undefined || !auth.ok) {
            deny(res, 401, 'unauthorized');
            return;
        }
        const read = await readJsonBody(req, res, SMALL_BODY_LIMIT);
        if (!read.ok)
            return;
        const body = asRecord(read.value);
        if (!body || typeof body.deviceId !== 'string' || typeof body.agent !== 'string' || typeof body.sessionId !== 'string') {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        phone.watch(auth, body.deviceId + '|' + body.agent + '|' + body.sessionId);
        json(res, 200, { ok: true });
    }));
    register('/marshal/api/unwatch', guard(async (req, res) => {
        if (req.method !== 'POST' || phone === undefined) { methodNotAllowed(res, 'POST'); return; }
        const parsed = parseBearer(headerValue(req, 'authorization'));
        const auth = parsed?.kind === 'phone' ? phone.authenticate(parsed.token) : undefined;
        if (auth === undefined || !auth.ok) { deny(res, 401, 'unauthorized'); return; }
        const read = await readJsonBody(req, res, SMALL_BODY_LIMIT);
        if (!read.ok) return;
        const body = asRecord(read.value);
        if (!body || typeof body.deviceId !== 'string' || typeof body.agent !== 'string' || typeof body.sessionId !== 'string') {
            json(res, 400, { ok: false, code: 'invalid-args' }); return;
        }
        phone.unwatch(auth, body.deviceId + '|' + body.agent + '|' + body.sessionId);
        json(res, 200, { ok: true });
    }));
    register('/marshal/api/sessions', guard((req, res) => {
        if (req.method !== 'GET') {
            methodNotAllowed(res, 'GET');
            return;
        }
        if (parseBearer(headerValue(req, 'authorization'))?.kind === 'node') {
            deny(res, 401, 'unauthorized');
            return;
        }
        if (phoneFrom(req) === undefined && authorize(req, res, readAccess) === undefined)
            return;
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
        // 空串 `?device=` 与缺参等价。
        const device = query.get('device') || undefined;
        json(res, 200, { sessions: relay.sessions(device).map(row => publicSession(row, relay)) });
    }));
    register('/marshal/api/discussions', guard(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
            methodNotAllowed(res, 'GET, POST');
            return;
        }
        const asPhone = phoneFrom(req);
        const auth = asPhone === undefined
            ? authorize(req, res, { allowToken: false, refresh: true, write: req.method === 'POST' })
            : undefined;
        if (asPhone === undefined && auth?.kind !== 'session')
            return;
        const groups = options.discussions;
        if (!groups) {
            json(res, 503, { ok: false, code: 'unsupported' });
            return;
        }
        try {
            if (req.method === 'GET') {
                const roomId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('room');
                json(res, 200, roomId ? { room: groups.read(roomId) } : { rooms: groups.list(), catalog: groups.catalog(), presets: groups.presets() });
                return;
            }
            const body = await readJsonBody(req, res, 32768);
            if (!body.ok)
                return;
            const data = asRecord(body.value);
        if (!data || typeof data.action !== 'string') {
            json(res, 400, { code: 'invalid-args' });
            return;
        }
        if (asPhone !== undefined && (data.action === 'configure' || data.action === 'preset')) {
            json(res, 403, { ok: false, code: 'forbidden' });
            return;
        }
        let value;
            if (data.action === 'preview')
                value = { preview: groups.preview(data.input) };
            else if (data.action === 'preset')
                value = { presets: groups.savePreset(data.input) };
            else if (data.action === 'create' && typeof data.digest === 'string' && typeof data.key === 'string')
                value = { room: groups.create(data.digest, data.key) };
            else if (data.action === 'send' && typeof data.roomId === 'string' && typeof data.text === 'string'
                && data.text.trim() && typeof data.recipient === 'string' && typeof data.key === 'string')
                value = { room: groups.send(data.roomId, data.text, data.recipient, data.key) };
            else if (data.action === 'stop' && typeof data.roomId === 'string')
                value = { room: await groups.stop(data.roomId) };
            else if (data.action === 'reconcile' && typeof data.roomId === 'string')
                value = { room: await groups.reconcile(data.roomId) };
            else if (data.action === 'configure' && typeof data.roomId === 'string' && typeof data.revision === 'number' && Number.isSafeInteger(data.revision))
                value = { room: groups.configure(data.roomId, data.revision, data.profiles) };
            else {
                json(res, 400, { code: 'invalid-args' });
                return;
            }
            json(res, 200, value);
        }
        catch (error) {
            json(res, 409, { code: error instanceof DiscussionError ? error.code : 'invalid-args' });
        }
    }));
    register('/marshal/api/discussions/stream', guard((req, res) => {
        if (req.method !== 'GET') {
            methodNotAllowed(res, 'GET');
            return;
        }
        const asPhone = phoneFrom(req);
        const auth = asPhone === undefined
            ? authorize(req, res, { allowToken: false, refresh: false, write: false })
            : undefined;
        if (asPhone === undefined && auth?.kind !== 'session')
            return;
        const groups = options.discussions;
        if (!groups) {
            json(res, 503, { code: 'unsupported' });
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        let closed = false;
        const send = () => { if (!closed && !res.write('data: {"changed":true}\n\n'))
            cleanup(); };
        const unsubscribe = groups.subscribe(send);
        const timer = setInterval(() => {
            const still = asPhone === undefined
                ? authenticate(req, { allowToken: false, refresh: false, write: false }) !== undefined
                : phoneFrom(req) !== undefined;
            if (!still || !res.write(': keepalive\n\n'))
                cleanup();
        }, 5000);
        timer.unref();
        const cleanup = () => {
            if (closed)
                return;
            closed = true;
            clearInterval(timer);
            unsubscribe();
            streams.delete(cleanup);
            if (auth?.kind === 'session')
                sessionStreams.get(auth.session.id)?.delete(cleanup);
            res.end();
        };
        streams.add(cleanup);
        if (auth?.kind === 'session') {
        let set = sessionStreams.get(auth.session.id);
        if (!set) {
            set = new Set();
            sessionStreams.set(auth.session.id, set);
        }
        set.add(cleanup);
        }
        res.on('close', cleanup);
        res.on('error', cleanup);
        send();
    }));
    register('/marshal/api/command', guard(async (req, res) => {
        if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST');
            return;
        }
        const asPhone = phoneFrom(req);
        if (asPhone === undefined && authorize(req, res, { allowToken: true, refresh: true, write: true }) === undefined)
            return;
        const read = await readJsonBody(req, res, MAX_FRAME_BYTES - 4096);
        if (!read.ok)
            return;
        const body = asRecord(read.value);
        if (body === undefined) {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        const { op, target, idempotencyKey } = body;
        if (typeof op !== 'string' || !isTarget(target) || typeof idempotencyKey !== 'string'
            || idempotencyKey.length === 0 || idempotencyKey.length > 256) {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        if (op.startsWith('discussion.') || !COMMAND_OPS.includes(op)) {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        const requestId = typeof body.args === 'object' && body.args !== null ? body.args.requestId : undefined;
        const pending = phone !== undefined && typeof requestId === 'string' ? phone.cardFor(requestId) : undefined;
        if (asPhone !== undefined && !controllerCommandAllowed(op, body.args, pending)) {
            json(res, 403, { ok: false, code: 'forbidden' });
            return;
        }
        // 每次 subscribe 都由 hub 签发新的不透明 id；页面在 HTTP 结果里取回并按 tab
        // 保存，unsubscribe 必须带同一个 id（缺 id/未知 id 由校验与节点拒绝）。
        const rawArgs = (() => {
            const candidate = body.args;
            if (op !== 'observe' || typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
                return candidate;
            }
            const record = candidate;
            if (record.kind !== 'follow' || record.action !== 'subscribe')
                return candidate;
            return { ...record, subscriptionId: randomUUID() };
        })();
        // 参数在 hub 侧先按 op 校验；非法参数不进入中继，也不消耗幂等键。
        let args;
        try {
            args = parseCommandArgs(op, rawArgs);
        }
        catch {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        const outcome = await relay.command({
            op: op, target, args, idempotencyKey,
        });
        json(res, commandHttpStatus(outcome), publicOutcome(outcome));
    }));
    register('/marshal/api/command-status', guard(async (req, res) => {
        if (req.method !== 'GET') {
            methodNotAllowed(res, 'GET');
            return;
        }
        if (parseBearer(headerValue(req, 'authorization'))?.kind === 'node') {
            deny(res, 401, 'unauthorized');
            return;
        }
        if (phoneFrom(req) === undefined && authorize(req, res, readAccess) === undefined)
            return;
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
        const deviceId = query.get('deviceId') ?? '';
        const agent = query.get('agent') ?? '';
        const op = query.get('op') ?? '';
        const key = query.get('key') ?? '';
        const sessionParam = query.get('sessionId');
        const sessionId = sessionParam === null || sessionParam === '' ? null : sessionParam;
        if (deviceId === '' || agent === '' || key === ''
            || deviceId.length > MAX_TARGET_ID || agent.length > MAX_TARGET_ID
            || (sessionId !== null && sessionId.length > MAX_TARGET_ID)
            || key.length > 256
            || !COMMAND_OPS.includes(op)) {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        const outcome = await relay.commandStatus({
            op: op,
            target: { deviceId, agent, sessionId },
            idempotencyKey: key,
        });
        const ok = outcome.status === 'accepted' || outcome.status === 'confirmed';
        const result = publicResult(outcome.result);
        json(res, commandStatusHttpStatus(outcome), {
            ok,
            status: outcome.status,
            ...(outcome.code === undefined ? {} : { code: outcome.code }),
            ...(result === undefined ? {} : { result }),
        });
    }));
    register('/marshal/api/inputs', guard(async (req, res) => {
        if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST');
            return;
        }
        if (authorize(req, res, { allowToken: true, refresh: true, write: true }) === undefined)
            return;
        const read = await readJsonBody(req, res, SMALL_BODY_LIMIT);
        if (!read.ok)
            return;
        const body = asRecord(read.value);
        const target = body?.target;
        if (body === undefined || Object.keys(body).some(key => key !== 'target')
            || !isTarget(target) || target.sessionId === null) {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        // 只读快照，不写 journal；device-offline/disposed 是 503，未知结果 202。
        const outcome = await relay.requestInputs(target, target.sessionId);
        if (!outcome.ok) {
            if (outcome.code === 'device-offline' || outcome.code === 'disposed') {
                json(res, 503, { ok: false, code: outcome.code });
            }
            else {
                json(res, 202, { ok: false, code: 'outcome-unknown' });
            }
            return;
        }
        json(res, 200, {
            ok: true,
            runtimeEpoch: outcome.runtimeEpoch,
            highWatermark: outcome.highWatermark,
            cards: publicCards(outcome.cards),
        });
    }));
    // 历史补看用不透明 cursor 与有界 limit；每次随机幂等键，node 对 observe 不落 journal。
    register('/marshal/api/history', guard(async (req, res) => {
        if (parseBearer(headerValue(req, 'authorization'))?.kind === 'node') {
            deny(res, 401, 'unauthorized');
            return;
        }
        if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST');
            return;
        }
        if (phoneFrom(req) === undefined && authorize(req, res, { allowToken: true, refresh: true, write: true }) === undefined)
            return;
        const read = await readJsonBody(req, res, SMALL_BODY_LIMIT);
        if (!read.ok)
            return;
        const body = asRecord(read.value);
        const target = body?.target;
        const cursor = body?.cursor;
        const limit = body?.limit;
        if (body === undefined || Object.keys(body).some(key => key !== 'target' && key !== 'cursor' && key !== 'limit')
            || !isTarget(target) || target.sessionId === null
            || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > HISTORY_CURSOR_MAX))
            || (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200))) {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        const args = {
            kind: 'history',
            ...(cursor === undefined ? {} : { cursor }),
            limit: limit === undefined ? 50 : limit,
        };
        let parsed;
        try {
            parsed = parseCommandArgs('observe', args);
        }
        catch {
            json(res, 400, { ok: false, code: 'invalid-args' });
            return;
        }
        const outcome = await relay.command({
            op: 'observe', target, args: parsed, idempotencyKey: randomUUID(),
        });
        // Only the separately correlated, source-projected history channel can carry
        // transcript bodies. Ordinary ACK/status/command responses stay metadata-only.
        const result = outcome.ok ? outcome.history : undefined;
        json(res, commandHttpStatus(outcome), result !== undefined && Array.isArray(result.items)
            ? { ok: true, status: outcome.status, result: { items: result.items,
                    completeness: result.completeness, ...(typeof result.nextCursor === 'string' ? { nextCursor: result.nextCursor } : {}) } }
            : publicOutcome(outcome));
    }));
    register('/marshal/api/stream', guard(async (req, res) => {
        if (req.method !== 'GET') {
            methodNotAllowed(res, 'GET');
            return;
        }
        if (parseBearer(headerValue(req, 'authorization'))?.kind === 'node') {
            deny(res, 401, 'unauthorized');
            return;
        }
        const asPhone = phoneFrom(req);
        // SSE 心跳不刷新空闲期，登录态只由普通 API 请求续期。
        const auth = asPhone === undefined ? authorize(req, res, { allowToken: true, refresh: false, write: false }) : undefined;
        if (asPhone === undefined && auth === undefined)
            return;
        const sessionId = auth?.kind === 'session' ? auth.session.id : undefined;
        const detachPhone = asPhone === undefined || phone === undefined ? undefined : phone.attachStream(asPhone.phone.id, () => cleanup());
        // 游标解析：query 优先于 Last-Event-ID；空串视为没带。超长游标不报 400，
        // 统一按未知游标产生 gap，避免客户端被一个坏 id 永久钉死在错误码上。
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
        const queryCursor = query.get('cursor')?.trim();
        const headerCursor = headerValue(req, 'last-event-id')?.trim();
        const requestedRaw = queryCursor !== undefined && queryCursor !== ''
            ? queryCursor
            : headerCursor !== undefined && headerCursor !== '' ? headerCursor : undefined;
        const replayRequested = requestedRaw !== undefined;
        const requestedCursor = requestedRaw !== undefined && requestedRaw.length <= HISTORY_CURSOR_MAX
            ? requestedRaw
            : undefined;
        // 背压：tab 卡住时丢弃增量，轮询会重新对齐状态，避免无限缓冲。
        let blocked = false;
        const writeRaw = (text) => {
            if (res.writableEnded || res.destroyed)
                return;
            blocked = res.write(text) === false;
        };
        const sendEvent = (event, cursor) => {
            if (blocked)
                return;
            // 只有被历史缓冲接纳的事件才有可回放 id；input.* 等交互帧不带 id。
            const id = cursor === undefined ? '' : `id: ${cursor}\n`;
            writeRaw(`${id}data: ${JSON.stringify(event)}\n\n`);
        };
        const sendReset = (reset) => {
            writeRaw(`event: reset\ndata: ${JSON.stringify({
                required: true, hubEpoch, degradedDevices: [...reset.degraded], complete: reset.complete,
                cursor: reset.cursor,
                continuity: Object.fromEntries(registry.list(now()).map(device => [device.id, {
                        nodeEpoch: relay.nodeEpoch(device.id) ?? null, purge: relay.purgeGeneration(device.id),
                    }])),
                ...(reset.capabilities === undefined ? {} : { capabilities: reset.capabilities }),
                ...(reset.replay === undefined ? {} : { replay: reset.replay }),
            })}\n\n`);
        };
        // 先订阅再有界暂存：订阅回调本身就是屏障完成前的队列，不做正文回放。
        let phase = 'buffer';
        let overflow = false;
        const staged = [];
        let stagedChars = 0;
        const floors = new Map();
        /** 设备 -> 订阅时观测到的清理代次；之后发生 purge 的旧帧即使已暂存也不能发出。 */
        const purgeBase = new Map();
        const degraded = new Set();
        const deliver = (event, cursor) => {
            // 观测后发生过内容清理：暂存/回放中的旧帧一律不再发出。
            if (purgeBase.get(event.deviceId) !== relay.purgeGeneration(event.deviceId))
                return;
            // 权威代次来自中继：快照后已换代的事件（含回放）一律丢弃，不能污染新时间线。
            const authoritative = relay.nodeEpoch(event.deviceId);
            if (authoritative !== undefined && authoritative !== event.nodeEpoch) {
                const firstSeen = !degraded.has(event.deviceId);
                degraded.add(event.deviceId);
                if (firstSeen) {
                    const prefix = `${event.deviceId}\u0000`;
                    for (const key of [...floors.keys()])
                        if (key.startsWith(prefix))
                            floors.delete(key);
                    sendReset({ degraded: [...degraded], complete: false, cursor: relay.historyCursor() });
                }
                return;
            }
            const key = `${event.deviceId}\u0000${event.agent}\u0000${event.sessionId}`;
            const floor = floors.get(key);
            // hub 派生通知（session.updated/removed、capability.changed）带 seq 0，不参与底价去重。
            if (event.seq > 0 && floor !== undefined && event.seq <= floor)
                return;
            if (event.seq > 0)
                floors.set(key, event.seq);
            // 会话已删除，长连接不再为它保留底价条目。
            if (event.kind === 'session.removed')
                floors.delete(key);
            sendEvent(event, cursor);
        };
        let unsubscribe = null;
        try {
            unsubscribe = relay.subscribe((event, cursor) => {
                // 记录观察时的清理代次；purge 之后这张流不再发出更早观测的帧。
                const purge = relay.purgeGeneration(event.deviceId);
                purgeBase.set(event.deviceId, purge);
                if (phase === 'buffer') {
                    const size = JSON.stringify(event).length;
                    if (staged.length >= MAX_STAGED_EVENTS || stagedChars + size > MAX_STAGED_CHARS) {
                        overflow = true;
                        return;
                    }
                    staged.push({ event, cursor, purge });
                    stagedChars += size;
                    return;
                }
                deliver(event, cursor);
            });
        }
        catch {
            // 订阅者上限是内部容量问题，不回显异常文本。
            deny(res, 503, 'unavailable');
            return;
        }
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-store',
            connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        res.on('drain', () => { blocked = false; });
        const heartbeat = setInterval(() => {
            // 背压时跳过：缓冲还没排空，继续写只会无限堆内存；轮询会重新对齐状态。
            if (blocked || res.writableEnded || res.destroyed)
                return;
            if (asPhone !== undefined && phoneFrom(req) === undefined) {
                cleanup();
                return;
            }
            if (asPhone !== undefined)
                phone?.seen(asPhone.phone.id);
            res.write(': ping\n\n');
        }, 15_000);
        let cleaned = false;
        const cleanup = () => {
            // close/error/dispose 可能同时触发；重复调用必须是安全的空操作。
            if (cleaned)
                return;
            cleaned = true;
            if (unsubscribe !== null) {
                unsubscribe();
                unsubscribe = null;
            }
            clearInterval(heartbeat);
            streams.delete(cleanup);
            detachPhone?.();
            if (sessionId !== undefined) {
                const set = sessionStreams.get(sessionId);
                set?.delete(cleanup);
                if (set !== undefined && set.size === 0)
                    sessionStreams.delete(sessionId);
            }
            // dispose 时也要结束仍挂着的响应，否则客户端会一直等下去。
            if (!res.writableEnded)
                res.end();
        };
        streams.add(cleanup);
        if (sessionId !== undefined) {
            let set = sessionStreams.get(sessionId);
            if (set === undefined) {
                set = new Set();
                sessionStreams.set(sessionId, set);
            }
            set.add(cleanup);
        }
        req.on('close', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);
        // 快照屏障：索引/能力可同步读，待答快照按会话异步取，期间事件留在 staged。
        const rows = relay.sessions();
        const byDevice = new Map();
        for (const row of rows) {
            const list = byDevice.get(row.deviceId) ?? [];
            list.push({ agent: row.agent, sessionId: row.sessionId });
            byDevice.set(row.deviceId, list);
        }
        await Promise.all([...byDevice].map(async ([deviceId, list]) => {
            await Promise.all(list.map(async (item) => {
                const outcome = await relay.requestInputs({ deviceId, agent: item.agent, sessionId: item.sessionId }, item.sessionId);
                if (!outcome.ok) {
                    degraded.add(deviceId);
                    return;
                }
                // 高水位按会话记账（同设备不同 agent 各有计数），低序事件不得盖过快照。
                floors.set(`${deviceId}\u0000${item.agent}\u0000${item.sessionId}`, outcome.highWatermark);
            }));
        }));
        if (cleaned)
            return;
        const complete = !overflow && degraded.size === 0;
        // 能力文档与索引在同一屏障内读取；页面以 reset 后的这份快照为准。
        const barrierCapabilities = {};
        for (const deviceId of byDevice.keys())
            barrierCapabilities[deviceId] = relay.capabilities(deviceId);
        // 快照高水位：客户端拿它作为下一次 live 对齐点；历史缺口另行报告。
        const snapshotCursor = relay.historyCursor();
        let replay;
        if (replayRequested) {
            replay = requestedCursor === undefined
                ? { events: [], cursor: snapshotCursor, gap: true, dropped: 0, truncated: false }
                : relay.historyRead(requestedCursor);
        }
        // v0 每次建连都要求 reset：先让客户端清空时间线/卡片，再补高水位之后的增量。
        // 屏障不完整时什么都没回放，不能报告 gap:false（否则会谎称历史已恢复）。
        sendReset({
            degraded: [...degraded], complete, capabilities: barrierCapabilities, cursor: snapshotCursor,
            ...(replay === undefined
                ? {}
                : {
                    replay: {
                        gap: !complete || replay.gap,
                        dropped: replay.dropped,
                        truncated: replay.truncated,
                        // 最后一条实际回放事件；被截断时客户端可从这里继续。
                        cursor: replay.cursor,
                    },
                }),
        });
        // 暂存超限时整段丢弃：不知道缺了哪条，就不能放行半快照。
        if (complete) {
            // 先按接收顺序补历史，再放行屏障期间的增量；重复项由每会话 seq 底价去重。
            // 回放快照只含注册设备，已消失设备的事件不能复活幽灵会话。
            if (replay !== undefined) {
                for (const item of replay.events) {
                    if (degraded.has(item.event.deviceId))
                        continue;
                    if (!relay.isDeviceKnown(item.event.deviceId))
                        continue;
                    // 回放事件在本轮读取时观测；与 purge 同期读取的帧按当前代次判断。
                    purgeBase.set(item.event.deviceId, relay.purgeGeneration(item.event.deviceId));
                    deliver(item.event, item.cursor);
                }
            }
            for (const item of staged) {
                if (degraded.has(item.event.deviceId))
                    continue;
                if (!relay.isDeviceKnown(item.event.deviceId))
                    continue;
                // 用暂存时的代次判断：purge 之前观测到的旧帧即使还在队列里也不能放行。
                purgeBase.set(item.event.deviceId, item.purge);
                deliver(item.event, item.cursor);
            }
        }
        staged.length = 0;
        stagedChars = 0;
        phase = 'live';
    }));
    const sweep = setInterval(pruneSessions, options.sessionSweepMs ?? 1_000);
    sweep.unref();
    return {
        dispose() {
            if (disposed)
                return;
            disposed = true;
            clearInterval(sweep);
            // 先断开所有流，再摘掉路由；遍历副本，避免边删边迭代。
            for (const cleanup of [...streams])
                cleanup();
            streams.clear();
            sessionStreams.clear();
            sessions.clear();
            for (const dispose of [...disposers].reverse())
                dispose();
            disposers.length = 0;
        },
    };
}
