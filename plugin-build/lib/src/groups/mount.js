import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pluginPackage from '../../../package.json' with { type: 'json' };
import { createGroupService } from './service.js';
import { agentsLedgerPath, readAgentsLedger } from './inventory.js';
import { createAgentDrafter } from './draft.js';
import { createCrossClient } from './cross-client.js';
import { createLocalBoard } from './local-board.js';
import { createTaskRooms } from './task-rooms.js';
import { createTaskRoomStore, TaskRoomKey } from './task-room-store.js';
import { createTaskRoomRoutes, taskRoomAccess, taskRoomAudit, visibleTaskRoom } from './task-room-routes.js';
import { createTaskOrchestration, isPermissionBlockedError } from './task-orchestration.js';
import { createWorkspaceRosters } from './workspace-rosters.js';
import { dashboardAddress } from '../sidebar.js';
import { createDiscussionPort } from '../discussions/ports.js';
import { createAgentsHttpClient, agentToolDefinitions } from './agent-tools.js';
import { createDshSurface } from '../adapters/dsh/surface.js';
import { createMemoryRoutes } from '../memory/http.js';
import { createMemoryHttpAuth, hostIsLoopback, resolveDesktopOwner } from '../memory/http-auth.js';
import { dshAccountHash, DSH_ACCOUNT_ORIGIN } from '../hub/account.js';

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
    if (req.headers?.host !== undefined && !hostIsLoopback(req.headers.host)) return false;
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
                const status = ['group-not-found', 'task-room-not-found', 'task-not-found'].includes(code) ? 404
                    : code === 'unauthorized' ? 401 : ['forbidden', 'workspace-forbidden'].includes(code) ? 403 : 400;
                write(res, status, {
                    ok: false,
                    code,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        },
    };
}

export function buildHealthBody(req, info) {
    return {
        ok: true,
        name: 'dsh-marshal',
        version: pluginPackage.version,
        deviceId: info.deviceId,
        capabilities: {
            groups: true,
            agents: info.agents,
            agentsCode: info.agentsCode ?? null,
            taskBoard: true,
            taskBoardSource: info.taskBoardSource,
            crossGroups: info.crossGroups,
            ...(isLoopback(req) ? { agentMemory: info.agentMemory } : {}),
        },
    };
}

function normalizeCardTags(raw) {
    if (!Array.isArray(raw)) return undefined;
    const seen = new Set();
    const out = [];
    for (const item of raw) {
        const name = (typeof item === 'string' ? item : typeof item?.name === 'string' ? item.name : '').trim().slice(0, 32);
        if (name === '' || seen.has(name)) continue;
        seen.add(name);
        const promptPrefix = typeof item === 'object' && item !== null && typeof item.promptPrefix === 'string' && item.promptPrefix.trim() !== ''
            ? item.promptPrefix.trim() : undefined;
        out.push(promptPrefix === undefined ? { name } : { name, promptPrefix });
        if (out.length >= 16) break;
    }
    return out.length > 0 ? out : undefined;
}

const VAGUE_TASK_PATTERNS = [
    /(?:^|[\s，,。！？!?])(帮我|请)?(看下|看看|弄一下|搞一下|处理一下|优化一下|改一下|修一下|研究一下|完善一下|整理一下|查一下|调整一下|跟进一下|想想办法)(?:$|[\s，,。！？!?])/,
    /(看着办|随便|待定|待确认|不确定|再议|模糊|\bTBD\b|\bTODO\b|\?{2,}|？{2,})/i,
];
const SPECIFIC_TASK_SIGNAL = /(https?:\/\/|#[0-9]+|PR\s*#?[0-9]+|\/[\w.-]+\/|\.[a-z]{1,5}\b|验收|步骤|目标|需求|修复|实现|新增|删除|接口|测试|指标|≥|<=|->|→)/i;

export function detectAmbiguousTask({ title = '', description = '', prompt = '', hasAttachments = false, hasPr = false } = {}) {
    const cleanTitle = String(title).trim();
    const cleanDesc = String(description).trim();
    const cleanPrompt = String(prompt).trim();
    const body = cleanDesc || (cleanPrompt !== cleanTitle ? cleanPrompt : '');
    const combined = (cleanTitle + ' ' + body).trim();
    if (hasAttachments || hasPr) return undefined;
    if (VAGUE_TASK_PATTERNS[1].test(combined)) {
        return '任务描述包含「待定/不确定/看着办」等未明确内容';
    }
    if (body.length === 0 && cleanTitle.replace(/\s+/g, '').length < 14 && !SPECIFIC_TASK_SIGNAL.test(cleanTitle)) {
        return '缺少任务描述且标题较简略，目标与验收标准尚不明确';
    }
    if (body.length < 16 && VAGUE_TASK_PATTERNS[0].test(combined) && !SPECIFIC_TASK_SIGNAL.test(combined)) {
        return '任务描述偏向宽泛指令，缺少具体对象或验收标准';
    }
    return undefined;
}

function normalizeAttachmentsPayload(raw) {
    if (!Array.isArray(raw)) return undefined;
    const out = [];
    for (const item of raw.slice(0, 8)) {
        if (!item || typeof item !== 'object') continue;
        if (item.kind !== 'image' && item.kind !== 'file') continue;
        if (typeof item.attachmentId !== 'string' || !item.attachmentId) continue;
        if (typeof item.name !== 'string' || !item.name) continue;
        if (typeof item.mediaType !== 'string' || !item.mediaType) continue;
        if (typeof item.sha256 !== 'string' || !item.sha256) continue;
        if (typeof item.bytes !== 'number' || !Number.isInteger(item.bytes) || item.bytes < 0) continue;
        const entry = {
            kind: item.kind,
            attachmentId: item.attachmentId,
            name: item.name,
            bytes: item.bytes,
            mediaType: item.mediaType,
            sha256: item.sha256,
            ...(item.kind === 'image' && typeof item.width === 'number' && typeof item.height === 'number'
                ? { width: item.width, height: item.height } : {}),
        };
        out.push(entry);
    }
    return out.length > 0 ? out : undefined;
}

function taskView(task, workflow, room) {
    const executions = Array.isArray(task.executions) ? task.executions : [];
    const latest = executions.length > 0 ? executions[executions.length - 1] : undefined;
    const openExecution = executions.some(item => item && item.endedAt === undefined);
    const tags = normalizeCardTags(task.tags);
    const attachments = normalizeAttachmentsPayload(task.attachments);
    return {
        id: task.id,
        title: task.title,
        status: room?.closed ? 'done' : workflow === undefined || workflow.state === 'ready' ? task.status
            : workflow.state === 'running' || workflow.state === 'handed-off' ? 'running'
            : workflow.state === 'permission-blocked' ? 'review'
            : workflow.state === 'done' ? (room ? 'review' : 'done') : 'failed',
        ...(workflow === undefined ? {} : { workflow }),
        ...(room === undefined ? {} : { taskRoom: visibleTaskRoom(room) }),
        ...(task.description === undefined ? {} : { description: task.description }),
        ...(task.prompt === undefined ? {} : { prompt: task.prompt }),
        ...(task.parentId === undefined ? {} : { parentId: task.parentId }),
        ...(task.permission === undefined ? {} : { permission: task.permission }),
        ...(task.permissionConfirmedAt === undefined ? {} : { permissionConfirmedAt: task.permissionConfirmedAt }),
        ...(task.mode === undefined ? {} : { mode: task.mode }),
        ...(typeof task.model === 'string' && task.model !== '' ? { model: task.model } : {}),
        ...(typeof task.reasoningEffort === 'string' && task.reasoningEffort !== '' ? { reasoningEffort: task.reasoningEffort } : {}),
        ...(typeof task.reuseSession === 'boolean' ? { reuseSession: task.reuseSession } : {}),
        ...(tags === undefined ? {} : { tags }),
        ...(attachments === undefined ? {} : { attachments }),
        ...(executions.length > 0 ? {
            runCount: executions.length,
            executions: executions.slice(-10).map(item => ({
                id: item.id,
                ...(item.sessionId ? { sessionId: item.sessionId } : {}),
                ...(typeof item.startedAt === 'number' ? { startedAt: item.startedAt } : {}),
                ...(typeof item.endedAt === 'number' ? { endedAt: item.endedAt } : {}),
                ...(item.result ? { result: item.result } : {}),
                ...(item.error ? { error: String(item.error).slice(0, 400) } : {}),
                ...(item.external ? { external: true } : {}),
                ...(item.initiatedBy ? { initiatedBy: item.initiatedBy } : {}),
            })),
        } : {}),
        ...(openExecution ? { openExecution: true } : {}),
        ...(latest?.startedAt === undefined ? {} : { startedAt: latest.startedAt }),
        ...(latest?.endedAt === undefined ? {} : { endedAt: latest.endedAt }),
        ...(task.schedule !== undefined ? { schedule: { enabled: task.schedule.enabled === true, mode: task.schedule.mode, ...(typeof task.schedule.cron === 'string' ? { cron: task.schedule.cron } : {}), ...(typeof task.schedule.at === 'number' ? { at: task.schedule.at } : {}), ...(task.schedule.nextRunAt === undefined ? {} : { nextRunAt: task.schedule.nextRunAt }) } } : {}),
        ...(task.freeze !== undefined ? { freeze: { goal: typeof task.freeze.goal === 'string' ? task.freeze.goal : '' } } : {}),
        ...(task.archivedAt === undefined ? {} : { archivedAt: task.archivedAt }),
        ...(latest === undefined || latest.sessionId === undefined ? {} : { sessionId: latest.sessionId }),
        ...(latest === undefined || latest.result === undefined ? {} : { result: latest.result }),
        ...(workflow?.sessionId === undefined ? {} : { sessionId: workflow.sessionId }),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
    };
}

function makeRoutes(service, drafter, getBoard, initiator, cross, boardSource, memory, auth, allowedOrigins, orchestration, rooms, extras = {}) {
    const { rosters, sessionController, config } = extras;
    const authenticate = (req, write = false) => auth.authenticate(req, { write, origins: allowedOrigins() });
    const allowed = (access, target, ledger) => access.ok && auth.allows(access.session, {
        agentId: target.agentId, workspaceId: target.workspaceId,
    }, ledger);
    const authorize = (req, res, target) => {
        const access = authenticate(req, true);
        if (allowed(access, target)) return true;
        write(res, access.ok ? 403 : access.status, {
            ok: false, code: access.ok ? 'workspace-forbidden' : access.code, message: '当前桌面会话无权操作该工作区的编排。',
        });
        return false;
    };
    const taskList = (snapshot, req, source) => {
        const access = authenticate(req);
        const ledger = access.ok ? auth.loadLedger() : undefined;
        return (Array.isArray(snapshot.tasks) ? snapshot.tasks : []).flatMap(task => {
            const target = orchestration?.target(source, task.id);
            const room = rooms?.find(source, task.id);
            if (room && !taskRoomAccess(access, room, allowed, ledger)) return [];
            if (target && !allowed(access, { workspaceId: target.workspaceId }, ledger)) return [];
            return [taskView(task, target ? orchestration.view(source, task.id) : undefined, room)];
        });
    };
    const roomRoutes = createTaskRoomRoutes({ exact, write, readBody, authenticate, allowed, auth, rooms,
        orchestration, getBoard, boardSource, getInitiator: () => initiator.replace(/^marshal:/, '') });
    return [
        ...roomRoutes.routes,
        exact('GET', '/marshal/health', async (req, res) => {
            const ledger = readAgentsLedger();
            write(res, 200, buildHealthBody(req, {
                deviceId: initiator.replace(/^marshal:/, ''),
                agents: ledger.available,
                agentsCode: ledger.code ?? null,
                taskBoardSource: boardSource(),
                crossGroups: cross !== undefined,
                agentMemory: memory !== undefined,
            }));
        }, true),
        ...createMemoryRoutes({ memory, auth, allowedOrigins }).map(route => exact(route.method, route.path, route.handler, true)),
        exact('GET', '/marshal/tasks/orchestration', async (req, res) => {
            const access = authenticate(req);
            if (!access.ok) { write(res, access.status, { ok: false, code: access.code }); return; }
            const catalog = orchestration?.catalog() ?? { templates: [], groupTemplates: [], leaders: [], memoryAvailable: false };
            const ledger = auth.loadLedger();
            write(res, 200, { ok: true, ...catalog, leaders: catalog.leaders.filter(leader => allowed(access, leader, ledger)) });
        }),
        exact('POST', '/marshal/tasks/preview', async (req, res) => {
            const access = authenticate(req, true);
            if (!access.ok) { write(res, access.status, { ok: false, code: access.code }); return; }
            if (!orchestration) { write(res, 503, { ok: false, code: 'orchestration-unavailable' }); return; }
            const body = await readBody(req);
            const title = typeof body.title === 'string' ? body.title.trim() : '';
            if (!title) throw taskError('invalid-title', '请填写工单标题。');
            const ledger = auth.loadLedger();
            const canUse = member => allowed(access, member, ledger);
            const result = await orchestration.recommend(body.orchestration, { title, description: body.description }, canUse);
            write(res, 200, { ok: true, ...result });
        }),
        exact('POST', '/marshal/tasks/plan', async (req, res) => {
            const access = authenticate(req, true);
            if (!access.ok) { write(res, access.status, { ok: false, code: access.code }); return; }
            if (!orchestration) { write(res, 503, { ok: false, code: 'orchestration-unavailable' }); return; }
            const body = await readBody(req);
            const source = boardSource();
            const room = rooms?.find(source, body.taskId);
            const workflow = orchestration.target(source, body.taskId);
            const ledger = auth.loadLedger();
            if (!workflow || !taskRoomAccess(access, room, allowed, ledger)) {
                write(res, 404, { ok: false, code: 'task-not-found' });
                return;
            }
            roomRoutes.assertIdle(room);
            const prepared = orchestration.prepare(body.orchestration, member => allowed(access, member, ledger));
            if (prepared.workspaceId !== room.workspaceId) {
                write(res, 403, { ok: false, code: 'workspace-forbidden' });
                return;
            }
            orchestration.configure(source, body.taskId, prepared);
            write(res, 200, { ok: true, tasks: taskList(getBoard().snapshot(), req, source) });
        }),
        exact('GET', '/marshal/tasks/report', async (req, res) => {
            const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('taskId');
            const source = boardSource();
            const access = authenticate(req);
            const target = orchestration?.target(source, id);
            if (!target || !allowed(access, { workspaceId: target.workspaceId })) {
                write(res, access.ok ? 404 : access.status, { ok: false, code: access.ok ? 'report-not-found' : access.code });
                return;
            }
            const report = orchestration.report(source, id);
            if (report === undefined) {
                write(res, 404, { ok: false, code: 'report-not-found' });
                return;
            }
            write(res, 200, { ok: true, report });
        }),
        exact('GET', '/marshal/tasks/state', async (req, res) => {
            const board = getBoard();
            if (board === undefined) {
                write(res, 503, { ok: false, code: 'no-task-board' });
                return;
            }
            const snapshot = board.snapshot();
            write(res, 200, {
                ok: true,
                tasks: taskList(snapshot, req, boardSource()),
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
            const tags = normalizeCardTags(body.tags);
            const attachments = normalizeAttachmentsPayload(body.attachments);
            const parentId = typeof body.parentId === 'string' && body.parentId.trim() !== '' ? body.parentId.trim() : undefined;
            const explicitPermission = ['read-only', 'workspace-write', 'danger-full-access'].includes(body.permission) ? body.permission : undefined;
            const permission = explicitPermission ?? ((body.workspaceId || body.orchestration) ? 'workspace-write' : undefined);
            const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : undefined;
            const reasoningEffort = typeof body.reasoningEffort === 'string' && body.reasoningEffort.trim() !== '' ? body.reasoningEffort.trim() : undefined;
            const reuseSession = typeof body.reuseSession === 'boolean' ? body.reuseSession : undefined;
            const ambiguityReason = body.skipAmbiguityCheck === true ? undefined : detectAmbiguousTask({
                title, description, prompt,
                hasAttachments: attachments !== undefined,
                hasPr: typeof body.orchestration?.prUrl === 'string' && body.orchestration.prUrl.trim() !== '',
            });
            const input = {
                title, description, prompt: prompt || description || title,
                ...(tags === undefined ? {} : { tags }),
                ...(attachments === undefined ? {} : { attachments }),
                ...(parentId === undefined ? {} : { parentId }),
                ...(permission === undefined ? {} : { permission }),
                ...(model === undefined ? {} : { model }),
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                ...(reuseSession === undefined ? {} : { reuseSession }),
            };
            const source = boardSource();
            const id = randomUUID();
            let prepared;
            let existing;
            let scope;
            if (body.orchestration !== undefined || body.workspaceId !== undefined) {
                if (body.orchestration !== undefined && !orchestration) {
                    write(res, 503, { ok: false, code: 'orchestration-unavailable' });
                    return;
                }
                // Authorize before looking up the requested leader, then check the bound workspace.
                const access = authenticate(req, true);
                if (!access.ok) { write(res, access.status, { ok: false, code: access.code }); return; }
                const ledger = auth.loadLedger();
                prepared = body.orchestration === undefined ? undefined :
                    orchestration.prepare({
                        ...body.orchestration,
                        ...(typeof body.workspaceId === 'string' && body.workspaceId.trim() !== '' ? { workspaceId: body.workspaceId.trim() } : {}),
                    }, member => allowed(access, member, ledger));
                const workspaceId = TaskRoomKey.parse(prepared?.workspaceId ?? body.workspaceId);
                if (body.workspaceId !== undefined && body.workspaceId !== workspaceId) {
                    write(res, 400, { ok: false, code: 'workspace-conflict' });
                    return;
                }
                if (!allowed(access, prepared ?? { workspaceId })) {
                    write(res, 403, { ok: false, code: 'workspace-forbidden' });
                    return;
                }
                if (!rooms) {
                    write(res, 503, { ok: false, code: 'task-rooms-unavailable' });
                    return;
                }
                scope = { workspaceId, ownerId: access.session.ownerId };
                existing = new Set((board.snapshot().tasks ?? []).map(task => task.id));
            }
            const beforeIds = existing ?? new Set((board.snapshot().tasks ?? []).map(task => task.id));
            let snapshot = await board.apply(randomUUID(), { kind: 'create', id, input }, initiator);
            const added = (snapshot.tasks ?? []).filter(task => !beforeIds.has(task.id));
            const created = (snapshot.tasks ?? []).find(task => task.id === id) ?? (added.length === 1 ? added[0] : undefined);
            if (scope) {
                if (!created) {
                    write(res, 409, { ok: false, code: 'task-create-not-observed' });
                    return;
                }
                try {
                    if (prepared) orchestration.attach(source, created.id, prepared);
                    rooms.ensure(source, created, scope.workspaceId, scope.ownerId);
                }
                catch {
                    if (prepared) {
                        try { orchestration.remove(source, created.id); } catch { /* preserve original error */ }
                    }
                    try { await board.apply(randomUUID(), { kind: 'delete', taskId: created.id }, initiator); }
                    catch { /* A host without rollback can leave an unconfigured card. */ }
                    write(res, 500, { ok: false, code: 'task-orchestration-not-saved', message: '无法保存任务编排。' });
                    return;
                }
            }
            let movedToReview = false;
            if (ambiguityReason !== undefined && created && created.status !== 'review' && created.status !== 'running') {
                try {
                    snapshot = await board.apply(randomUUID(), { kind: 'move', taskId: created.id, status: 'review' }, initiator);
                    movedToReview = true;
                } catch { /* keep created status if board refuses move */ }
            }
            write(res, 200, {
                ok: true,
                tasks: taskList(snapshot, req, source),
                ...(movedToReview ? { movedToReview: true, ambiguityReason } : {}),
            });
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
            const source = boardSource();
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            if (workflow) {
                if (!authorize(req, res, workflow)) return;
                const snapshot = board.snapshot();
                const task = (snapshot.tasks ?? []).find(item => item.id === body.taskId);
                if (!task) {
                    write(res, 404, { ok: false, code: 'task-not-found' });
                    return;
                }
                const access = authenticate(req, true);
                const room = boundRoom ?? rooms?.ensure(source, task, workflow.workspaceId, access.session.ownerId);
                if (!room || !taskRoomAccess(access, room, allowed)) {
                    write(res, 403, { ok: false, code: 'workspace-forbidden' });
                    return;
                }
                roomRoutes.assertIdle(room);
                if (room.closed) {
                    write(res, 409, { ok: false, code: 'task-room-closed', message: '工单已归档，请从工单群重开或重试。' });
                    return;
                }
                orchestration.start(source, task, taskRoomAudit(rooms, room, undefined, undefined, undefined,
                    member => allowed(access, member)));
                write(res, 200, { ok: true, tasks: taskList(snapshot, req, source) });
                return;
            }
            if (boundRoom) {
                const access = authenticate(req, true);
                if (!taskRoomAccess(access, boundRoom, allowed)) {
                    write(res, 403, { ok: false, code: 'workspace-forbidden' });
                    return;
                }
                roomRoutes.assertIdle(boundRoom);
                const current = await rooms.page(boundRoom.id, { limit: 1 });
                if (current.room.closed) {
                    write(res, 409, { ok: false, code: 'task-room-closed' });
                    return;
                }
                write(res, 409, { ok: false, code: 'invalid-leader', message: '请打开工单群，选择该工作区的 Leader 后运行。' });
                return;
            }
            try {
                const snapshot = await board.apply(randomUUID(), { kind: 'run', taskId: body.taskId }, initiator);
                write(res, 200, { ok: true, tasks: taskList(snapshot, req, source) });
            }
            catch (error) {
                if (isPermissionBlockedError(error)) {
                    let snapshot = board.snapshot();
                    let movedToReview = false;
                    try {
                        snapshot = await board.apply(randomUUID(), { kind: 'move', taskId: body.taskId, status: 'review' }, initiator);
                        movedToReview = true;
                    } catch { /* keep snapshot if move refused */ }
                    write(res, 200, {
                        ok: true,
                        permissionBlocked: true,
                        movedToReview,
                        message: '权限受阻：' + (error instanceof Error ? error.message : String(error)) + '，工单已转入「待确认」等待确认。',
                        tasks: taskList(snapshot, req, source),
                    });
                    return;
                }
                throw error;
            }
        }),
        exact('POST', '/marshal/tasks/move', async (req, res) => {
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
            if (!['backlog', 'todo', 'running', 'review', 'done', 'failed'].includes(body.status)) {
                write(res, 400, { ok: false, code: 'invalid-status' });
                return;
            }
            const source = boardSource();
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            if (boundRoom) {
                const access = authenticate(req, true);
                if (!taskRoomAccess(access, boundRoom, allowed)) {
                    write(res, 403, { ok: false, code: 'workspace-forbidden' });
                    return;
                }
            }
            if (workflow && !authorize(req, res, workflow)) return;
            orchestration?.assertIdle(source, body.taskId);
            const snapshot = await board.apply(randomUUID(), { kind: 'move', taskId: body.taskId, status: body.status }, initiator);
            write(res, 200, { ok: true, tasks: taskList(snapshot, req, source) });
        }),
        exact('POST', '/marshal/tasks/update', async (req, res) => {
            const board = getBoard();
            if (board === undefined) { write(res, 503, { ok: false, code: 'no-task-board' }); return; }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') { write(res, 400, { ok: false, code: 'invalid-task' }); return; }
            const source = boardSource();
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            if (boundRoom) {
                const access = authenticate(req, true);
                if (!taskRoomAccess(access, boundRoom, allowed)) { write(res, 403, { ok: false, code: 'workspace-forbidden' }); return; }
            }
            if (workflow && !authorize(req, res, workflow)) return;
            orchestration?.assertIdle(source, body.taskId);
            const patch = {};
            if (typeof body.title === 'string' && body.title.trim() !== '') patch.title = body.title.trim();
            if (typeof body.description === 'string') patch.description = body.description;
            if (typeof body.prompt === 'string') patch.prompt = body.prompt;
            if (['read-only', 'workspace-write', 'danger-full-access'].includes(body.permission)) patch.permission = body.permission;
            if (body.tags === null) patch.tags = null;
            else if (Array.isArray(body.tags)) {
                const tags = normalizeCardTags(body.tags);
                patch.tags = tags ?? null;
            }
            if (Object.keys(patch).length === 0) { write(res, 400, { ok: false, code: 'empty-patch' }); return; }
            const snapshot = await board.apply(randomUUID(), { kind: 'update', taskId: body.taskId, patch }, initiator);
            write(res, 200, { ok: true, tasks: taskList(snapshot, req, source) });
        }),
        exact('POST', '/marshal/tasks/set-parent', async (req, res) => {
            const board = getBoard();
            if (board === undefined) { write(res, 503, { ok: false, code: 'no-task-board' }); return; }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') { write(res, 400, { ok: false, code: 'invalid-task' }); return; }
            const parentId = body.parentId === null || body.parentId === '' || body.parentId === undefined ? null
                : typeof body.parentId === 'string' ? body.parentId.trim() : undefined;
            if (parentId === undefined || parentId === body.taskId) { write(res, 400, { ok: false, code: 'invalid-parent' }); return; }
            const source = boardSource();
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            if (boundRoom) {
                const access = authenticate(req, true);
                if (!taskRoomAccess(access, boundRoom, allowed)) { write(res, 403, { ok: false, code: 'workspace-forbidden' }); return; }
            }
            if (workflow && !authorize(req, res, workflow)) return;
            orchestration?.assertIdle(source, body.taskId);
            const snapshot = await board.apply(randomUUID(), { kind: 'set-parent', taskId: body.taskId, parentId }, initiator);
            write(res, 200, { ok: true, tasks: taskList(snapshot, req, source) });
        }),
        exact('POST', '/marshal/tasks/archive', async (req, res) => {
            const board = getBoard();
            if (board === undefined) { write(res, 503, { ok: false, code: 'no-task-board' }); return; }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') { write(res, 400, { ok: false, code: 'invalid-task' }); return; }
            const source = boardSource();
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            if (boundRoom) {
                const access = authenticate(req, true);
                if (!taskRoomAccess(access, boundRoom, allowed)) { write(res, 403, { ok: false, code: 'workspace-forbidden' }); return; }
            }
            if (workflow && !authorize(req, res, workflow)) return;
            orchestration?.assertIdle(source, body.taskId);
            const snapshot = await board.apply(randomUUID(), { kind: 'archive', taskId: body.taskId }, initiator);
            write(res, 200, { ok: true, tasks: taskList(snapshot, req, source) });
        }),
        exact('POST', '/marshal/tasks/restore', async (req, res) => {
            const board = getBoard();
            if (board === undefined) { write(res, 503, { ok: false, code: 'no-task-board' }); return; }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') { write(res, 400, { ok: false, code: 'invalid-task' }); return; }
            const source = boardSource();
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            if (boundRoom) {
                const access = authenticate(req, true);
                if (!taskRoomAccess(access, boundRoom, allowed)) { write(res, 403, { ok: false, code: 'workspace-forbidden' }); return; }
            }
            if (workflow && !authorize(req, res, workflow)) return;
            const snapshot = await board.apply(randomUUID(), { kind: 'restore', taskId: body.taskId }, initiator);
            write(res, 200, { ok: true, tasks: taskList(snapshot, req, source) });
        }),
        exact('POST', '/marshal/tasks/schedule', async (req, res) => {
            const board = getBoard();
            if (board === undefined) { write(res, 503, { ok: false, code: 'no-task-board' }); return; }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') { write(res, 400, { ok: false, code: 'invalid-task' }); return; }
            const source = boardSource();
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            if (boundRoom) {
                const access = authenticate(req, true);
                if (!taskRoomAccess(access, boundRoom, allowed)) { write(res, 403, { ok: false, code: 'workspace-forbidden' }); return; }
            }
            if (workflow && !authorize(req, res, workflow)) return;
            const patch = {};
            if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
            if (body.mode === 'cron' || body.mode === 'once') patch.mode = body.mode;
            if (typeof body.cron === 'string') patch.cron = body.cron.trim();
            if (typeof body.at === 'number' && Number.isInteger(body.at)) patch.at = body.at;
            if (Object.keys(patch).length === 0) { write(res, 400, { ok: false, code: 'invalid-schedule' }); return; }
            const snapshot = await board.apply(randomUUID(), { kind: 'set-schedule', taskId: body.taskId, patch }, initiator);
            write(res, 200, { ok: true, tasks: taskList(snapshot, req, source) });
        }),
        exact('POST', '/marshal/tasks/settle', async (req, res) => {
            const board = getBoard();
            if (board === undefined) { write(res, 503, { ok: false, code: 'no-task-board' }); return; }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') { write(res, 400, { ok: false, code: 'invalid-task' }); return; }
            const source = boardSource();
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            if (boundRoom) {
                const access = authenticate(req, true);
                if (!taskRoomAccess(access, boundRoom, allowed)) { write(res, 403, { ok: false, code: 'workspace-forbidden' }); return; }
            }
            if (workflow && !authorize(req, res, workflow)) return;
            const snapshot = await board.apply(randomUUID(), { kind: 'settle', taskId: body.taskId }, initiator);
            write(res, 200, { ok: true, tasks: taskList(snapshot, req, source) });
        }),
        exact('POST', '/marshal/tasks/confirm-permission', async (req, res) => {
            const board = getBoard();
            if (board === undefined) { write(res, 503, { ok: false, code: 'no-task-board' }); return; }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') { write(res, 400, { ok: false, code: 'invalid-task' }); return; }
            const source = boardSource();
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            if (boundRoom) {
                const access = authenticate(req, true);
                if (!taskRoomAccess(access, boundRoom, allowed)) { write(res, 403, { ok: false, code: 'workspace-forbidden' }); return; }
            }
            if (workflow && !authorize(req, res, workflow)) return;
            const snapshot = await board.apply(randomUUID(), { kind: 'confirm-permission', taskId: body.taskId }, initiator);
            write(res, 200, { ok: true, tasks: taskList(snapshot, req, source) });
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
            const source = boardSource();
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            if (boundRoom) {
                const access = authenticate(req, true);
                if (!taskRoomAccess(access, boundRoom, allowed)) {
                    write(res, 403, { ok: false, code: 'workspace-forbidden' });
                    return;
                }
                write(res, 409, { ok: false, code: 'task-room-archive', message: '此工单已有群聊。请在工单群里关单归档。' });
                return;
            }
            if (workflow && !authorize(req, res, workflow)) return;
            orchestration?.assertIdle(source, body.taskId);
            const snapshot = await board.apply(randomUUID(), { kind: 'delete', taskId: body.taskId }, initiator);
            if (workflow && !(snapshot.tasks ?? []).some(task => task.id === body.taskId)) {
                orchestration.remove(source, body.taskId);
            }
            write(res, 200, { ok: true, tasks: taskList(snapshot, req, source) });
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
        exact('GET', '/marshal/rosters/state', async (req, res) => {
            write(res, 200, { ok: true, rosters: rosters?.list() ?? {} });
        }),
        exact('POST', '/marshal/rosters/save', async (req, res) => {
            if (!rosters) { write(res, 503, { ok: false, code: 'rosters-unavailable' }); return; }
            const body = await readBody(req);
            const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
            if (!workspaceId) { write(res, 400, { ok: false, code: 'invalid-workspace' }); return; }
            const saved = rosters.set(workspaceId, body);
            write(res, 200, { ok: true, roster: saved, rosters: rosters.list() });
        }),
        exact('GET', '/marshal/agents/sessions', async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const filterAgentId = url.searchParams.get('agentId') || '';
            const filterTeamId = url.searchParams.get('teamId') || '';
            let rawRuns = [];
            let teamsById = new Map();
            try {
                const parsed = JSON.parse(readFileSync(agentsLedgerPath(), 'utf8'));
                if (Array.isArray(parsed?.runs)) rawRuns = parsed.runs;
                for (const t of Array.isArray(parsed?.teams) ? parsed.teams : []) {
                    if (t?.id) teamsById.set(t.id, t);
                }
            } catch { /* empty ledger */ }
            const sessionMeta = new Map();
            try {
                const listed = typeof sessionController?.list === 'function' ? await sessionController.list() : undefined;
                const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.sessions) ? listed.sessions : [];
                for (const s of rows) {
                    const sid = s?.id ?? s?.sessionId;
                    if (typeof sid === 'string' && sid) {
                        sessionMeta.set(sid, {
                            title: typeof s.title === 'string' ? s.title : '',
                            updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : undefined,
                            cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
                        });
                    }
                }
            } catch { /* session listing optional */ }
            const seen = new Set();
            const sessions = [];
            for (const run of rawRuns) {
                if (!run || typeof run.sessionId !== 'string' || !run.sessionId) continue;
                if (filterAgentId && run.memberId !== filterAgentId) continue;
                if (filterTeamId && run.teamId !== filterTeamId) continue;
                if (seen.has(run.sessionId)) continue;
                seen.add(run.sessionId);
                const team = teamsById.get(run.teamId);
                const member = (team?.members ?? []).find(m => m.id === run.memberId);
                const meta = sessionMeta.get(run.sessionId);
                sessions.push({
                    sessionId: run.sessionId,
                    teamId: run.teamId,
                    memberId: run.memberId,
                    agentName: member?.name ?? run.memberName ?? '',
                    workspaceId: team?.workspaceId ?? '',
                    title: meta?.title || run.title || (member?.name ? member.name + ' 的闲聊会话' : '历史会话'),
                    createdAt: typeof run.createdAt === 'number' ? run.createdAt : 0,
                    updatedAt: meta?.updatedAt ?? (typeof run.updatedAt === 'number' ? run.updatedAt : (typeof run.createdAt === 'number' ? run.createdAt : 0)),
                    status: run.status ?? '',
                });
            }
            sessions.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
            write(res, 200, { ok: true, sessions });
        }),
        exact('GET', '/marshal/devices/status', async (req, res) => {
            const deviceId = initiator.replace(/^marshal:/, '');
            let dashUrl = '';
            try { if (config) dashUrl = dashboardAddress(config); } catch {}
            if (cross === undefined) {
                write(res, 200, { ok: true, deviceId, hubConfigured: false, hubOnline: false, dashboardUrl: dashUrl, devices: [] });
                return;
            }
            try {
                const cat = await cross.catalog();
                const devices = Array.isArray(cat?.devices) ? cat.devices : [];
                write(res, 200, { ok: true, deviceId, hubConfigured: true, hubOnline: true, dashboardUrl: dashUrl, devices });
            }
            catch (error) {
                write(res, 200, { ok: true, deviceId, hubConfigured: true, hubOnline: false, dashboardUrl: dashUrl, error: error instanceof Error ? error.message : String(error), devices: [] });
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
    let hubCa;
    try { hubCa = config.hubCaFile === undefined ? undefined : readFileSync(config.hubCaFile); }
    catch { options.logger?.warn?.('marshal: groups hubCaFile unreadable'); }
    const crossClient = createCrossClient({ hubUrl: config.hubUrl, token: config.token, ...(hubCa === undefined ? {} : { ca: hubCa }) });
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
    const platformHash = async () => {
        try {
            const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined;
            const session = await account?.getPlatformSession?.();
            if (session?.userId && session.origin === DSH_ACCOUNT_ORIGIN) return dshAccountHash(session.userId);
        }
        catch { /* no signed-in platform account */ }
        return undefined;
    };
    const ownerFile = join(config.memoryRoot ?? join(homedir(), '.dsh-marshal', 'memory'), 'owner.json');
    const desktopOwner = async () => resolveDesktopOwner({ config, platformHash: await platformHash(), ownerFile });
    // Require signed DSH connection admission for originless desktop memory sessions.
    let trustedConnection = () => false;
    const adoptConnection = connection => {
        if (connection === undefined || connection === null) {
            trustedConnection = () => false;
            return;
        }
        trustedConnection = req => {
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
    try {
        ctx.inject?.(['connection'], scoped => {
            scoped.effect(() => {
                adoptConnection(typeof scoped.get === 'function' ? scoped.get('connection') : scoped.connection);
                return () => adoptConnection(undefined);
            }, 'marshal: memory connection trust');
        });
    }
    catch { /* connection trust fails closed until injected */ }
    const memoryAuth = createMemoryHttpAuth({
        resolveOwner: async () => {
            const owner = await desktopOwner();
            if (typeof owner.caller === 'string' && owner.caller !== '') return owner.caller;
            if (typeof config.deviceId === 'string' && config.deviceId !== '') return 'device:' + config.deviceId;
            return '';
        },
        // Unknown install owner stays non-owner. After the first signed-in owner is
        // persisted, a later logged-out local session can present that same hash.
        installOwner: async () => (await desktopOwner()).install,
        trustedRequest: req => trustedConnection(req),
    });
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
    const agents = createAgentsHttpClient({
        baseUrl: () => {
            if (typeof webServer?.getOrigin === 'function') return webServer.getOrigin();
            if (typeof webServer?.port === 'number') return 'http://127.0.0.1:' + webServer.port;
            throw new Error('marshal: agents no-web-server');
        },
    });
    let rooms;
    try {
        rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'task-rooms.sqlite')),
            deviceId: config.deviceId, hub: crossClient?.taskRoom });
    } catch { options.logger?.warn?.('marshal: local task room archive unavailable'); }
    const rosters = createWorkspaceRosters(join(root, 'workspace-rosters.json'));
    let orchestration;
    try {
        orchestration = createTaskOrchestration({
            file: join(root, 'task-orchestration.json'), inventory: readAgentsLedger, memory: options.memory,
            port: createDiscussionPort({ agents: config.agents, llm, codexExecutable: config.codexExecutable }),
            defaultModel: readDefaultModel, logger: options.logger, workspacePath: agents.workspace,
            leaderAutoReview: true,
            onPermissionBlocked: async (_source, taskId) => {
                const board = getBoard();
                if (!board) return;
                await board.apply(randomUUID(), { kind: 'move', taskId, status: 'review' }, `marshal:${config.deviceId}`);
            },
            startLeader: async (leader, text, signal) => {
                const { sessionId } = await agents.chatMember(leader.teamId, leader.memberId, signal) ?? {};
                if (typeof sessionId !== 'string' || sessionId === '') throw new Error('Leader session unavailable');
                signal.throwIfAborted();
                await ctx.sessionController.prompt({
                    requestId: randomUUID(), sessionId, content: [{ type: 'text', text }],
                }, signal);
                return sessionId;
            },
        });
    }
    catch { options.logger?.warn?.('marshal: task orchestration unavailable'); }
    if (typeof ctx.effect === 'function') ctx.effect(() => () => {
        orchestration?.dispose();
        rooms?.close();
        promptAbort.abort();
        service.dispose();
    }, 'marshal: groups prompt lifetime');
    ctx.inject(['tools'], (scoped) => {
        scoped.effect(() => {
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
            const disposers = makeRoutes(service, drafter, getBoard, `marshal:${config.deviceId}`, crossClient, () => taskBoard === undefined ? 'local' : 'host', options.memory, memoryAuth, () => {
                const origins = ['dsh-app://app'];
                try {
                    const origin = scoped.webServer.getOrigin?.();
                    if (typeof origin === 'string' && origin !== '') origins.push(origin);
                }
                catch { /* desktop origin is enough when the host has no public origin */ }
                return origins;
            }, orchestration, rooms, { rosters, sessionController: ctx.sessionController, config }).map((route) => scoped.webServer.register(route));
            return () => {
                for (const dispose of disposers) dispose();
            };
        }, 'marshal: groups routes');
    });
    return service;
}
