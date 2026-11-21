/**
 * Wiring for the task-board superagent bridge.
 *
 * Two faces are exported: createSuperagentBridge() is framework-free and
 * testable with a fake board/tool/web seat, and mountSuperagent() connects it to
 * a Cordis context. Keeping the wiring separate is what lets the dispatch,
 * settlement and memory rules be tested without a running DSH host.
 */
import { randomUUID } from 'node:crypto';
import { findMember, readAgents } from './agents.js';
import { createDispatcher } from './dispatch.js';
import { createBoardExtension, SUPERAGENT_EXTENSION_ID } from './extension.js';
import { createMemoryBridge } from './memory.js';
import { createSettingsStore, resolveRoot } from './settings.js';
import { createStateStore } from './state.js';
import { controlPageHtml } from './control-page.js';
import { specToJsonSchema } from '../tools/schema.js';

const BODY_LIMIT = 64 * 1024;
const CONTROL_PATH = '/marshal-superagent';
const HUMAN_CREATE_PATH = '/marshal-superagent/api/human-create';
// The DSH desktop app serves the Web GUI from dsh-app://app/ and maps /api/* to
// the host HTTP server; the browser hook uses this alias so it also reaches the
// bridge from inside the desktop app.
const HUMAN_CREATE_API_PATH = '/api/marshal-superagent/human-create';
const CONFIG_PATH = '/marshal-superagent/api/config';
const DISPATCH_PATH = '/marshal-superagent/api/dispatch';
const AGENTS_PATH = '/marshal-superagent/api/agents';
const STATUS_PATH = '/marshal-superagent/api/status';
const HEALTH_PATH = '/marshal-superagent/health';

function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

function textOutput() { return { type: 'string' }; }

function render(args, value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return [{ type: 'text', text }];
}

function isLoopback(req) {
    const address = req.socket?.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostIsLoopback(value) {
    if (typeof value !== 'string' || value === '') return false;
    try {
        return LOOPBACK_HOSTS.has(new URL('http://' + value).hostname);
    }
    catch {
        return false;
    }
}

/**
 * Browser-shaped markers for the legacy route: same origin, same-origin fetch
 * metadata, and a loopback Host. These markers are only a tripwire; the signed
 * DSH connection admission is the authority and is checked separately.
 */
function hostProof(req) {
    return isLoopback(req) && hostIsLoopback(req.headers?.host);
}

function browserProof(req) {
    if (!hostProof(req)) return false;
    if (String(req.headers?.['sec-fetch-site'] ?? '') !== 'same-origin') return false;
    const origin = req.headers?.origin;
    if (typeof origin !== 'string' || origin === '') return false;
    let url;
    try { url = new URL(origin); }
    catch { return false; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username !== '' || url.password !== '') return false;
    if (url.pathname !== '/' && url.pathname !== '') return false;
    if (url.search !== '' || url.hash !== '') return false;
    if (url.host !== req.headers?.host) return false;
    if (!hostIsLoopback(url.host)) return false;
    return true;
}

/** Read-only routes: loopback + loopback Host, and not a cross-site browser request. */
function readTrusted(req) {
    if (req.headers?.['sec-fetch-site'] === 'cross-site') return false;
    return hostProof(req);
}

function write(res, status, value) {
    if (typeof res.writeHead !== 'function') return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > BODY_LIMIT) {
            const error = new Error('body-too-large');
            error.code = 'body-too-large';
            throw error;
        }
        chunks.push(chunk);
    }
    if (size === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeHtml(res, html) {
    if (typeof res.writeHead !== 'function') return;
    res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
    });
    res.end(html);
}

function exact(method, path, handler, guard = readTrusted) {
    return {
        kind: 'exact',
        path,
        async handler(req, res) {
            if (req.method !== method) {
                if (typeof res.writeHead === 'function') {
                    res.writeHead(405, { allow: method });
                    res.end();
                }
                return;
            }
            if (!guard(req)) {
                write(res, 403, { ok: false, code: 'forbidden' });
                return;
            }
            try {
                await handler(req, res);
            }
            catch (error) {
                const code = error?.code === 'body-too-large' ? 'body-too-large' : 'invalid-request';
                write(res, code === 'body-too-large' ? 413 : 400, { ok: false, code, message: messageOf(error) });
            }
        },
    };
}

/**
 * Create the bridge. No Cordis types cross this boundary: the caller supplies
 * the board getter, the memory service and the clock.
 */
export function createSuperagentBridge(options = {}) {
    const logger = options.logger ?? { warn: () => {}, info: () => {} };
    const trustedRequest = options.trustedRequest ?? (() => false);
    const now = options.now ?? Date.now;
    const uuid = options.uuid ?? (() => randomUUID());
    const root = options.root ?? resolveRoot();
    const settingsStore = createSettingsStore(root, { logger, now });
    const stateStore = createStateStore(root, { logger, now });
    const memory = createMemoryBridge(options.memory, { logger });
    let board;
    let extensionHost;
    let disposeExtension;
    let disposeSubscribe;
    let reconcileTimer;
    let closed = false;
    let reconcileError;
    const reconcileDelayMs = Number.isFinite(options.reconcileDelayMs) ? options.reconcileDelayMs : 400;

    const dispatcher = createDispatcher({
        getBoard: () => board,
        settingsStore,
        stateStore,
        memory,
        logger,
        now,
        uuid,
        readAgents: options.readAgents ?? readAgents,
        workflow: options.workflow,
    });

    const extension = createBoardExtension({
        dispatcher,
        logger,
        onStart: host => { extensionHost = host; void reconcile('board-extension-start', { autoDispatch: false }); },
        onStop: () => { extensionHost = undefined; },
    });

    const scheduleReconcile = (reason = 'board-change') => {
        if (closed || reconcileTimer !== undefined || reconcileDelayMs < 0) return;
        const opts = reason === 'board-mount' ? { autoDispatch: reconcileDelayMs > 0 } : { autoDispatch: true };
        if (reconcileDelayMs === 0) {
            void reconcile(reason, opts);
            return;
        }
        reconcileTimer = setTimeout(() => {
            reconcileTimer = undefined;
            void reconcile(reason, opts);
        }, reconcileDelayMs);
        if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref();
    };

    const reconcile = async (reason, filter = {}) => {
        if (closed) return { ok: false, code: 'closed' };
        try {
            const result = await dispatcher.reconcile(filter, extensionHost);
            reconcileError = undefined;
            return result;
        }
        catch (cause) {
            reconcileError = messageOf(cause);
            logger.warn?.('marshal-superagent: reconcile failed (' + reason + '): ' + reconcileError);
            return { ok: false, code: 'reconcile-failed', error: reconcileError };
        }
    };

    const clearBoard = () => {
        if (reconcileTimer !== undefined) {
            clearTimeout(reconcileTimer);
            reconcileTimer = undefined;
        }
        try { disposeSubscribe?.(); }
        catch { /* board may already be gone */ }
        try { disposeExtension?.(); }
        catch { /* board may already be gone */ }
        disposeSubscribe = undefined;
        disposeExtension = undefined;
        extensionHost = undefined;
        board = undefined;
    };

    const setBoard = next => {
        clearBoard();
        if (next === undefined || next === null) return;
        board = next;
        try {
            if (typeof next.registerExtension === 'function') disposeExtension = next.registerExtension(extension);
        }
        catch (cause) {
            logger.warn?.('marshal-superagent: board extension registration failed: ' + messageOf(cause));
        }
        try {
            if (typeof next.subscribe === 'function') disposeSubscribe = next.subscribe(() => scheduleReconcile('board-change'));
        }
        catch (cause) {
            logger.warn?.('marshal-superagent: board subscription failed: ' + messageOf(cause));
        }
        scheduleReconcile('board-mount');
    };

    const status = () => {
        const base = dispatcher.status();
        return {
            ...base,
            extension: { id: SUPERAGENT_EXTENSION_ID, active: extension.summary().ready, settled: extension.summary().settledCount },
            hook: { path: HUMAN_CREATE_API_PATH, legacyPath: HUMAN_CREATE_PATH, mode: 'browser-observer', version: 1 },
            reconcileError: reconcileError ?? null,
        };
    };

    const configure = patch => {
        const clean = patch !== null && typeof patch === 'object' ? { ...patch } : {};
        if (typeof clean.defaultAgent === 'string' && clean.defaultAgent.trim() !== '') {
            const members = (options.readAgents ?? readAgents)().members;
            if (findMember(members, clean.defaultAgent) === undefined) {
                throw new Error('default agent not found: ' + clean.defaultAgent);
            }
        }
        return dispatcher.configure(clean);
    };

    const admitted = req => {
        if (!hostProof(req)) return false;
        try { return trustedRequest(req) === true; }
        catch { return false; }
    };
    const humanProof = req => browserProof(req) && admitted(req);
    const desktopHumanProof = req => hostProof(req) && admitted(req);

    const humanCreate = async body => {
        const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : '';
        if (taskId === '') return { status: 400, body: { ok: false, code: 'invalid-task-id' } };
        if (taskId.length > 128) return { status: 400, body: { ok: false, code: 'invalid-task-id' } };
        if (body?.source !== 'board-ui') {
            return { status: 400, body: { ok: false, code: 'bad-source' } };
        }
        const result = await dispatcher.dispatch({ taskId, source: 'ui', requestId: body?.requestId });
        if (result.ok === true) return { status: 202, body: { ok: true, code: result.code, taskId, via: result.via } };
        const benign = new Set(['disabled', 'duplicate-dispatch', 'duplicate-target', 'subtask-suppressed', 'already-running', 'already-executed', 'task-archived', 'in-flight', 'awaiting-confirmation', 'workflow-done', 'workflow-permission-blocked']);
        return { status: benign.has(result.code) ? 200 : 409, body: { ok: false, code: result.code, taskId, error: result.error } };
    };

    const controlConfig = async body => {
        const patch = {};
        for (const key of ['enabled', 'autoDispatchTodo', 'rootOnly', 'injectMemory']) {
            if (typeof body?.[key] === 'boolean') patch[key] = body[key];
        }
        for (const key of ['defaultAgent', 'tagPrefix']) {
            if (typeof body?.[key] === 'string') patch[key] = body[key];
        }
        if (body?.memoryLimit !== undefined) patch.memoryLimit = body.memoryLimit;
        if (body?.staleRunMinutes !== undefined) patch.staleRunMinutes = body.staleRunMinutes;
        if (body?.aliases !== null && typeof body?.aliases === 'object' && !Array.isArray(body.aliases)) patch.aliases = body.aliases;
        try {
            configure(patch);
            return { status: 200, body: { ok: true, status: status() } };
        }
        catch (cause) {
            return { status: 400, body: { ok: false, code: 'config-refused', error: messageOf(cause) } };
        }
    };

    const controlDispatch = async body => {
        const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : '';
        if (taskId === '' || taskId.length > 128) {
            return { status: 400, body: { ok: false, code: 'invalid-task-id' } };
        }
        const result = await dispatcher.dispatch({ taskId, source: 'manual', force: true });
        const benign = new Set(['disabled', 'duplicate-dispatch', 'duplicate-target', 'subtask-suppressed', 'already-running', 'already-executed', 'task-archived', 'in-flight', 'workflow-done', 'workflow-permission-blocked']);
        return {
            status: result.ok === true ? 202 : benign.has(result.code) ? 200 : 409,
            body: result,
        };
    };

    const readJson = async req => {
        const contentType = String(req.headers?.['content-type'] ?? '');
        if (!contentType.toLowerCase().startsWith('application/json')) return { error: 'json-required' };
        try { return { body: await readBody(req) }; }
        catch (cause) { return { error: cause?.code === 'body-too-large' ? 'body-too-large' : 'invalid-json' }; }
    };

    const humanCreateHandler = async (req, res) => {
        const parsed = await readJson(req);
        if (parsed.error !== undefined) {
            write(res, parsed.error === 'body-too-large' ? 413 : 415, { ok: false, code: parsed.error });
            return;
        }
        const answer = await humanCreate(parsed.body);
        write(res, answer.status, answer.body);
    };

    const routes = () => [
        exact('GET', CONTROL_PATH, (req, res) => { writeHtml(res, controlPageHtml()); }),
        exact('POST', HUMAN_CREATE_PATH, humanCreateHandler, humanProof),
        // The desktop shell forwards the page request marker-less but attaches
        // the Host's signed dsh-auth-* browser cookie. The /api alias therefore
        // requires both a loopback Host and the Host connection's own admission
        // (signature + expiry + authority), not merely a loopback socket.
        exact('POST', HUMAN_CREATE_API_PATH, humanCreateHandler, desktopHumanProof),
        exact('POST', CONFIG_PATH, async (req, res) => {
            const parsed = await readJson(req);
            if (parsed.error !== undefined) {
                write(res, parsed.error === 'body-too-large' ? 413 : 415, { ok: false, code: parsed.error });
                return;
            }
            const answer = await controlConfig(parsed.body);
            write(res, answer.status, answer.body);
        }, humanProof),
        exact('POST', DISPATCH_PATH, async (req, res) => {
            const parsed = await readJson(req);
            if (parsed.error !== undefined) {
                write(res, parsed.error === 'body-too-large' ? 413 : 415, { ok: false, code: parsed.error });
                return;
            }
            const answer = await controlDispatch(parsed.body);
            write(res, answer.status, answer.body);
        }, humanProof),
        exact('GET', AGENTS_PATH, (req, res) => { write(res, 200, { ok: true, ...dispatcher.listAgentSummaries() }); }),
        exact('GET', STATUS_PATH, (req, res) => { write(res, 200, status()); }),
        exact('GET', HEALTH_PATH, (req, res) => {
            const value = status();
            write(res, 200, {
                ok: true,
                name: 'dsh-marshal-superagent',
                enabled: value.enabled,
                board: value.board,
                memory: value.memory,
                extension: value.extension,
                controlPage: CONTROL_PATH,
            });
        }),
    ];

    const toolDefinition = () => {
        const definition = {
            name: 'marshal_superagent',
            description: '任务看板 × Super-agent 自动派发桥的只读面：status 查看状态、agents 列出智能体、reconcile 对账与扫单。配置与人工补派只能由皇上在本机浏览器打开 /marshal-superagent 控制页操作；开启后任何来源进入「待办 (todo)」的未执行工单都会自动唤醒对应智能体处理。',
            parameters: {
                action: { type: 'string', required: true, enum: ['status', 'agents', 'reconcile'] },
            },
            output: { schema: textOutput(), render },
            async execute(args) {
                const action = typeof args?.action === 'string' ? args.action : '';
                if (action === 'status') return JSON.stringify(status(), null, 2);
                if (action === 'agents') return JSON.stringify(dispatcher.listAgentSummaries(), null, 2);
                if (action === 'reconcile') {
                    const result = await reconcile('tool');
                    return JSON.stringify(result ?? { ok: true }, null, 2);
                }
                throw new Error('unknown marshal_superagent action: ' + action);
            },
        };
        definition.parameters = specToJsonSchema(definition.parameters);
        return definition;
    };

    const close = () => {
        closed = true;
        clearBoard();
    };

    return {
        root,
        settingsStore,
        stateStore,
        memory,
        dispatcher,
        extension,
        setBoard,
        clearBoard,
        status,
        configure,
        humanCreate,
        routes,
        toolDefinition,
        reconcile,
        close,
    };
}

/**
 * Mount the bridge into a dsh-marshal node.
 *
 * The task board and tools are injected lazily, so a deployment without the
 * third-party board keeps every existing marshal feature and simply reports the
 * bridge as unavailable.
 */
export function mountSuperagent(ctx, config, options = {}) {
    if (!Array.isArray(config?.agents) || !config.agents.includes('dsh')) return undefined;
    const logger = options.logger ?? ctx.logger;
    // The Host connection service is the only authority that can verify the
    // signed dsh-auth-* cookie. Until it is injected, human routes fail closed.
    let trustedRequest = () => false;
    const adoptConnection = connection => {
        if (connection === undefined || connection === null) {
            trustedRequest = () => false;
            return;
        }
        trustedRequest = req => {
            try {
                if (typeof connection.requestRejection === 'function') {
                    return connection.requestRejection({ headers: req.headers }) === undefined;
                }
                if (typeof connection.admit === 'function') {
                    const admission = connection.admit({ headers: req.headers });
                    return admission !== undefined && admission.rejection === undefined && admission.peer !== undefined;
                }
                return false;
            }
            catch {
                return false;
            }
        };
    };
    const bridge = createSuperagentBridge({
        root: options.root ?? resolveRoot(),
        memory: options.memory,
        logger,
        now: options.now,
        uuid: options.uuid,
        readAgents: options.readAgents,
        reconcileDelayMs: options.reconcileDelayMs,
        trustedRequest: req => trustedRequest(req),
        workflow: options.workflow,
    });
    try {
        ctx.inject(['connection'], scoped => {
            scoped.effect(() => {
                adoptConnection(typeof scoped.get === 'function' ? scoped.get('connection') : scoped.connection);
                return () => adoptConnection(undefined);
            }, 'marshal: superagent connection trust');
        });
    }
    catch (cause) {
        logger.warn?.('marshal-superagent: connection trust unavailable; human routes fail closed: ' + messageOf(cause));
    }
    try {
        ctx.inject(['taskBoard'], scoped => {
            scoped.effect(() => {
                bridge.setBoard(scoped.taskBoard);
                return () => bridge.clearBoard();
            }, 'marshal: superagent board');
        });
    }
    catch (cause) {
        logger.warn?.('marshal-superagent: task board injection unavailable: ' + messageOf(cause));
    }
    try {
        ctx.inject(['webServer'], scoped => {
            scoped.effect(() => {
                const disposers = bridge.routes().map(route => scoped.webServer.register(route));
                return () => { for (const dispose of disposers) dispose(); };
            }, 'marshal: superagent routes');
        });
    }
    catch (cause) {
        logger.warn?.('marshal-superagent: web routes unavailable: ' + messageOf(cause));
    }
    try {
        ctx.inject(['tools'], scoped => {
            scoped.effect(() => scoped.tools.register(bridge.toolDefinition()), 'marshal: superagent tool');
        });
    }
    catch (cause) {
        logger.warn?.('marshal-superagent: tool registration unavailable: ' + messageOf(cause));
    }
    try {
        ctx.effect(() => () => bridge.close(), 'marshal: superagent lifetime');
    }
    catch { /* a capture-only context needs no lifetime effect */ }
    logger.info?.('marshal-superagent: bridge at ' + bridge.root + ' (default agent: ' + (bridge.settingsStore.get().defaultAgent ?? 'none') + ')');
    return bridge;
}

export const SUPERAGENT_PATHS = Object.freeze({
    control: CONTROL_PATH,
    humanCreate: HUMAN_CREATE_PATH,
    humanCreateApi: HUMAN_CREATE_API_PATH,
    config: CONFIG_PATH,
    dispatch: DISPATCH_PATH,
    agents: AGENTS_PATH,
    status: STATUS_PATH,
    health: HEALTH_PATH,
});
