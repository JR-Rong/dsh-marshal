import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGroupService } from './service.js';
import { readAgentsLedger } from './inventory.js';
import { createAgentDrafter } from './draft.js';
import { createCrossClient } from './cross-client.js';
import { createLocalBoard } from './local-board.js';
import { createAgentsHttpClient, agentToolDefinitions } from './agent-tools.js';
import { createDshSurface } from '../adapters/dsh/surface.js';

const BODY_LIMIT = 64 * 1024;

function assistantText(event) {
    const data = event !== null && typeof event === 'object' ? event.data : undefined;
    const message = data !== null && typeof data === 'object' ? data.message : undefined;
    const content = message !== null && typeof message === 'object' ? message.content : undefined;
    if (!Array.isArray(content)) return '';
    return content
        .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
}

function createReplyReader(surface) {
    if (surface === undefined || typeof surface.history !== 'function') return undefined;
    return {
        async latest(sessionId) {
            const page = await surface.history({ sessionId, limit: 5 }, AbortSignal.timeout(8000));
            let max = 0;
            for (const event of page.events ?? []) {
                if (Number.isSafeInteger(event.seq)) max = Math.max(max, event.seq);
            }
            return max;
        },
        async since(sessionId, seq) {
            const page = await surface.history({ sessionId, limit: 20 }, AbortSignal.timeout(8000));
            const replies = [];
            for (const event of page.events ?? []) {
                if (!Number.isSafeInteger(event.seq) || event.seq <= seq) continue;
                if (event.type !== 'assistant/message' || event.surfaceOp !== 'append') continue;
                const text = assistantText(event);
                if (text.trim() !== '') replies.push({ seq: event.seq, text });
            }
            return replies;
        },
    };
}

function isLoopback(req) {
    const address = req.socket?.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function trusted(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    return isLoopback(req);
}

function write(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
}

function errorCode(error) {
    return error !== null && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : 'invalid-request';
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > BODY_LIMIT) {
            const error = new Error('marshal: groups body-too-large');
            error.code = 'body-too-large';
            throw error;
        }
        chunks.push(chunk);
    }
    if (size === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        const error = new Error('marshal: groups invalid-json');
        error.code = 'invalid-json';
        throw error;
    }
}

function exact(method, path, handler, open = false) {
    return {
        kind: 'exact',
        path,
        async handler(req, res) {
            if (req.method !== method) {
                res.writeHead(405, { allow: method });
                res.end();
                return;
            }
            if (!open && !trusted(req)) {
                write(res, 403, { ok: false, code: 'forbidden' });
                return;
            }
            try {
                await handler(req, res);
            }
            catch (error) {
                const code = errorCode(error);
                write(res, code === 'group-not-found' ? 404 : 400, {
                    ok: false,
                    code,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        },
    };
}

function taskView(task) {
    const executions = Array.isArray(task.executions) ? task.executions : [];
    const latest = executions.length > 0 ? executions[executions.length - 1] : undefined;
    return {
        id: task.id,
        title: task.title,
        status: task.status,
        ...(task.description === undefined ? {} : { description: task.description }),
        ...(task.parentId === undefined ? {} : { parentId: task.parentId }),
        ...(task.permission === undefined ? {} : { permission: task.permission }),
        ...(task.mode === undefined ? {} : { mode: task.mode }),
        ...(latest === undefined || latest.sessionId === undefined ? {} : { sessionId: latest.sessionId }),
        ...(latest === undefined || latest.result === undefined ? {} : { result: latest.result }),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
    };
}

function makeRoutes(service, drafter, getBoard, initiator, cross, boardSource = () => 'local') {
    return [
        exact('GET', '/marshal/health', async (req, res) => {
            const ledger = readAgentsLedger();
            write(res, 200, {
                ok: true,
                name: 'dsh-marshal',
                version: '0.2.0-agent-groups.2',
                deviceId: initiator.replace(/^marshal:/, ''),
                capabilities: {
                    groups: true,
                    agents: ledger.available,
                    agentsCode: ledger.code ?? null,
                    taskBoard: true,
                    taskBoardSource: boardSource(),
                    crossGroups: cross !== undefined,
                },
            });
        }, true),
        exact('GET', '/marshal/tasks/state', async (req, res) => {
            const board = getBoard();
            if (board === undefined) {
                write(res, 503, { ok: false, code: 'no-task-board' });
                return;
            }
            const snapshot = board.snapshot();
            write(res, 200, {
                ok: true,
                tasks: (Array.isArray(snapshot.tasks) ? snapshot.tasks : []).map(taskView),
                ...(snapshot.sessionDefaultPermission === undefined ? {} : { sessionDefaultPermission: snapshot.sessionDefaultPermission }),
            });
        }),
        exact('POST', '/marshal/tasks/create', async (req, res) => {
            const board = getBoard();
            if (board === undefined) {
                write(res, 503, { ok: false, code: 'no-task-board' });
                return;
            }
            const body = await readBody(req);
            const title = typeof body.title === 'string' ? body.title.trim() : '';
            if (title === '') {
                write(res, 400, { ok: false, code: 'invalid-title' });
                return;
            }
            const description = typeof body.description === 'string' ? body.description.trim() : '';
            const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
            const input = { title, description, prompt: prompt || description || title };
            const snapshot = await board.apply(randomUUID(), { kind: 'create', id: randomUUID(), input }, initiator);
            write(res, 200, { ok: true, tasks: (Array.isArray(snapshot.tasks) ? snapshot.tasks : []).map(taskView) });
        }),
        exact('POST', '/marshal/tasks/run', async (req, res) => {
            const board = getBoard();
            if (board === undefined) {
                write(res, 503, { ok: false, code: 'no-task-board' });
                return;
            }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') {
                write(res, 400, { ok: false, code: 'invalid-task' });
                return;
            }
            const snapshot = await board.apply(randomUUID(), { kind: 'run', taskId: body.taskId }, initiator);
            write(res, 200, { ok: true, tasks: (Array.isArray(snapshot.tasks) ? snapshot.tasks : []).map(taskView) });
        }),
        exact('POST', '/marshal/tasks/delete', async (req, res) => {
            const board = getBoard();
            if (board === undefined) {
                write(res, 503, { ok: false, code: 'no-task-board' });
                return;
            }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') {
                write(res, 400, { ok: false, code: 'invalid-task' });
                return;
            }
            const snapshot = await board.apply(randomUUID(), { kind: 'delete', taskId: body.taskId }, initiator);
            write(res, 200, { ok: true, tasks: (Array.isArray(snapshot.tasks) ? snapshot.tasks : []).map(taskView) });
        }),
        exact('POST', '/marshal/workspaces/agent', async (req, res) => {
            const body = await readBody(req);
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (name === '') {
                write(res, 400, { ok: false, code: 'invalid-name' });
                return;
            }
            const requested = typeof body.path === 'string' ? body.path.trim() : '';
            let path;
            if (requested !== '') {
                if (!requested.startsWith('/') || requested.includes('\0')) {
                    write(res, 400, { ok: false, code: 'invalid-path' });
                    return;
                }
                path = requested;
            }
            else {
                const safe = name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
                path = join(homedir(), '.dsh-marshal', 'agents', 'Agent · ' + safe);
            }
            try {
                await mkdir(path, { recursive: true });
                write(res, 200, { ok: true, path });
            }
            catch (error) {
                write(res, 500, { ok: false, code: 'mkdir-failed', message: error instanceof Error ? error.message : String(error) });
            }
        }),
        exact('POST', '/marshal/workspaces/prepare', async (req, res) => {
            const body = await readBody(req);
            const path = typeof body.path === 'string' ? body.path.trim() : '';
            if (path === '' || !path.startsWith('/') || path.includes('\0')) {
                write(res, 400, { ok: false, code: 'invalid-path' });
                return;
            }
            try {
                await mkdir(path, { recursive: true });
                write(res, 200, { ok: true, path });
            }
            catch (error) {
                write(res, 500, { ok: false, code: 'mkdir-failed', message: error instanceof Error ? error.message : String(error) });
            }
        }),
        exact('GET', '/marshal/cross-groups/state', async (req, res) => {
            if (cross === undefined) { write(res, 503, { ok: false, code: 'cross-groups-unavailable' }); return; }
            try { write(res, 200, { ok: true, ...(await cross.state()) }); }
            catch (error) { write(res, 502, { ok: false, code: 'hub-unavailable', message: error instanceof Error ? error.message : String(error) }); }
        }),
        exact('GET', '/marshal/cross-groups/catalog', async (req, res) => {
            if (cross === undefined) { write(res, 503, { ok: false, code: 'cross-groups-unavailable' }); return; }
            try { write(res, 200, { ok: true, ...(await cross.catalog()) }); }
            catch (error) { write(res, 502, { ok: false, code: 'hub-unavailable', message: error instanceof Error ? error.message : String(error) }); }
        }),
        exact('POST', '/marshal/cross-groups/create', async (req, res) => {
            if (cross === undefined) { write(res, 503, { ok: false, code: 'cross-groups-unavailable' }); return; }
            try { write(res, 200, { ok: true, ...(await cross.create(await readBody(req))) }); }
            catch (error) { write(res, 502, { ok: false, code: 'hub-unavailable', message: error instanceof Error ? error.message : String(error) }); }
        }),
        exact('POST', '/marshal/cross-groups/send', async (req, res) => {
            if (cross === undefined) { write(res, 503, { ok: false, code: 'cross-groups-unavailable' }); return; }
            try { write(res, 200, { ok: true, ...(await cross.send(await readBody(req))) }); }
            catch (error) { write(res, 502, { ok: false, code: 'hub-unavailable', message: error instanceof Error ? error.message : String(error) }); }
        }),
        exact('GET', '/marshal/groups/state', async (req, res) => {
            write(res, 200, { ok: true, ...service.state() });
        }),
        exact('GET', '/marshal/groups/get', async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const id = url.searchParams.get('id') ?? '';
            write(res, 200, { ok: true, group: service.get(id) });
        }),
        exact('POST', '/marshal/agents/draft', async (req, res) => {
            if (drafter === undefined) {
                write(res, 503, { ok: false, code: 'no-llm' });
                return;
            }
            const body = await readBody(req);
            const text = typeof body.text === 'string' ? body.text.trim() : '';
            if (text === '' || text.length > 500) {
                write(res, 400, { ok: false, code: 'invalid-text' });
                return;
            }
            const preferred = typeof body.provider === 'string' && body.provider !== ''
                && typeof body.model === 'string' && body.model !== ''
                ? { provider: body.provider, model: body.model }
                : undefined;
            const draft = await drafter(text, preferred);
            write(res, 200, { ok: true, draft });
        }),
        exact('POST', '/marshal/groups/create', async (req, res) => {
            const body = await readBody(req);
            write(res, 200, { ok: true, group: service.create(body) });
        }),
        exact('POST', '/marshal/groups/update', async (req, res) => {
            const body = await readBody(req);
            write(res, 200, { ok: true, group: service.update(body.id, body.patch ?? {}) });
        }),
        exact('POST', '/marshal/groups/remove', async (req, res) => {
            const body = await readBody(req);
            write(res, 200, { ok: true, removed: service.remove(body.id) });
        }),
        exact('POST', '/marshal/groups/members', async (req, res) => {
            const body = await readBody(req);
            if (body.action === 'add') {
                write(res, 200, { ok: true, group: service.addMember(body.id, body.member ?? {}) });
                return;
            }
            if (body.action === 'remove') {
                write(res, 200, { ok: true, group: service.removeMember(body.id, body.key) });
                return;
            }
            write(res, 400, { ok: false, code: 'invalid-action' });
        }),
        exact('POST', '/marshal/groups/bind', async (req, res) => {
            const body = await readBody(req);
            write(res, 200, { ok: true, member: service.bind(body.id, body.key, body.sessionId) });
        }),
        exact('POST', '/marshal/groups/send', async (req, res) => {
            const body = await readBody(req);
            write(res, 200, { ok: true, ...(await service.send(body.id, { text: body.text })) });
        }),
        exact('POST', '/marshal/groups/task', async (req, res) => {
            const board = getBoard();
            if (board === undefined) {
                write(res, 503, { ok: false, code: 'no-task-board' });
                return;
            }
            const body = await readBody(req);
            if (typeof body.id !== 'string' || typeof body.messageId !== 'string') {
                write(res, 400, { ok: false, code: 'invalid-request' });
                return;
            }
            const group = service.get(body.id);
            const message = (group.messages || []).find(item => item.id === body.messageId);
            if (message === undefined) {
                write(res, 404, { ok: false, code: 'message-not-found' });
                return;
            }
            const title = (message.text.split('\n')[0] || '').trim().slice(0, 80) || '群聊任务';
            const description = '来自群聊「' + group.name + '」\n\n' + message.text;
            const before = board.snapshot();
            const beforeIds = new Set((before.tasks || []).map(task => task.id));
            const snapshot = await board.apply(randomUUID(), { kind: 'create', id: randomUUID(), input: { title, description, prompt: message.text } }, initiator);
            const created = (snapshot.tasks || []).find(task => !beforeIds.has(task.id));
            if (created === undefined) throw new Error('task-create-not-observed');
            service.setMessageTask(body.id, body.messageId, { taskId: created.id, deviceId: initiator.replace('marshal:', '') });
            write(res, 200, { ok: true, task: taskView(created) });
        }),
    ];
}

export function mountGroups(ctx, config, options = {}) {
    const root = config.groupsRoot ?? join(homedir(), '.dsh-marshal', 'groups');
    const localBoard = createLocalBoard(join(root, 'tasks.json'));
    const getBoard = () => taskBoard ?? localBoard;
    let taskBoard;
    let webServer;
    const crossClient = createCrossClient({ hubUrl: config.hubUrl, token: config.token });
    const inventory = () => {
        const ledger = readAgentsLedger();
        const result = {
            deviceId: config.deviceId,
            agents: config.agents,
            agentsHome: {
                available: ledger.available,
                ...(ledger.code === undefined ? {} : { code: ledger.code }),
                file: ledger.file,
            },
            squads: ledger.teams,
            codex: { available: config.agents.includes('codex') },
        };
        if (taskBoard !== undefined) {
            try {
                const snapshot = taskBoard.snapshot();
                result.taskBoard = {
                    available: true,
                    ...(snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.tasks)
                        ? { taskCount: snapshot.tasks.length }
                        : {}),
                };
            }
            catch {
                result.taskBoard = { available: false, code: 'snapshot-failed' };
            }
        }
        return result;
    };
    const surface = createDshSurface(ctx.sessionController);
    let defaultModel;
    ctx.inject(['agentDefaultModel'], (scoped) => {
        scoped.effect(() => {
            defaultModel = scoped.agentDefaultModel;
            return () => {
                defaultModel = undefined;
            };
        }, 'marshal: groups default model');
    });
    const readDefaultModel = () => {
        const service = defaultModel !== undefined
            ? defaultModel
            : (typeof ctx.get === 'function' ? (() => {
                try { return ctx.get('agentDefaultModel'); }
                catch { return undefined; }
            })() : undefined);
        if (service === undefined || service === null || typeof service.currentSelection !== 'function') return undefined;
        try { return service.currentSelection(); }
        catch { return undefined; }
    };
    const llm = typeof ctx.get === 'function'
        ? (() => { try { return ctx.get('llm'); } catch { return undefined; } })()
        : ctx.llm;
    const drafter = createAgentDrafter({ llm, defaultModel: readDefaultModel });
    const promptAbort = new AbortController();
    if (typeof ctx.effect === 'function') ctx.effect(() => () => promptAbort.abort(), 'marshal: groups prompt lifetime');
    const service = createGroupService({
        root,
        deviceId: config.deviceId,
        inventory,
        prompt: ({ sessionId, text, requestId }) => ctx.sessionController.prompt({
            requestId,
            sessionId,
            content: [{ type: 'text', text }],
        }, promptAbort.signal),
        reader: createReplyReader(surface),
        logger: options.logger ?? ctx.logger,
    });
    ctx.inject(['tools'], (scoped) => {
        scoped.effect(() => {
            const agents = createAgentsHttpClient({
                baseUrl: () => {
                    const server = webServer;
                    if (server !== undefined && typeof server.getOrigin === 'function') return server.getOrigin();
                    if (server !== undefined && typeof server.port === 'number') return 'http://127.0.0.1:' + server.port;
                    throw new Error('marshal: agents no-web-server');
                },
            });
            const disposers = agentToolDefinitions({ agents, service })
                .map((definition) => scoped.tools.register(definition));
            return () => {
                for (const dispose of disposers) dispose();
            };
        }, 'marshal: agent tools');
    });
    ctx.inject(['taskBoard'], (scoped) => {
        scoped.effect(() => {
            taskBoard = scoped.taskBoard;
            return () => {
                taskBoard = undefined;
            };
        }, 'marshal: groups task board');
    });
    ctx.inject(['webServer'], (scoped) => {
        scoped.effect(() => {
            webServer = scoped.webServer;
            const disposers = makeRoutes(service, drafter, getBoard, `marshal:${config.deviceId}`, crossClient, () => taskBoard === undefined ? 'local' : 'host').map((route) => scoped.webServer.register(route));
            return () => {
                for (const dispose of disposers) dispose();
            };
        }, 'marshal: groups routes');
    });
    return service;
}
