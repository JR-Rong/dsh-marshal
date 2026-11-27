import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pluginPackage from '../../../package.json' with { type: 'json' };
import { createGroupService } from './service.js';
import { agentsLedgerPath, readAgentsLedger } from './inventory.js';
import { createAgentDrafter } from './draft.js';
import { createCrossClient } from './cross-client.js';
import { createLocalBoard } from './local-board.js';
import { createMarshalEventBus } from './event-bus.js';
import { createTaskRooms } from './task-rooms.js';
import { createTaskRoomStore, TaskRoomKey } from './task-room-store.js';
import { createTaskRoomRoutes, taskRoomAccess, taskRoomAudit, visibleTaskRoom } from './task-room-routes.js';
import { createTaskOrchestration, isPermissionBlockedError } from './task-orchestration.js';
import { createPatchStore, extractPatchTouchedFiles } from './patch-store.js';
import { agentKeyMatches, createAgentTaskStore, parseAgentKey, ticketStatus } from './agent-tasks-store.js';
import { guidanceSessionUnavailable, prioritizeGuidance, syncGuidanceToAgent } from './guidance-sync.js';
import { getTaskDagNodeDetail, projectTaskDag } from './dag-projector.js';
import { buildIncidentsSummary } from './incident-monitor.js';
import { taskError } from './pr-material.js';
import { createTaskToolController } from './task-tool-controller.js';
import { persistResidentIncidents, residentIncidentRecords, syncResidentSessionToRoom } from './session-room-sync.js';
import { createTaskOverrides, describeContentSteeringMessage, describePlainConfigChanges, extractAssignedAgentName } from './task-overrides.js';
import { createWorkspaceRosters } from './workspace-rosters.js';
import { createTicketNumbers, withTicketPrefix } from './ticket-numbers.js';
import { createSessionTitles, readProjcacheSession, readWorkspaceRegistry, summarizeFirstMessage } from './session-titles.js';
import { createVoiceEngine } from './voice-engine.js';
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

async function readBody(req, limit = BODY_LIMIT) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) {
            const error = new Error('marshal: groups body-too-large');
            error.code = 'body-too-large';
            error.status = 413;
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
                const explicitStatus = typeof error?.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : undefined;
                const status = explicitStatus ?? (['group-not-found', 'task-room-not-found', 'task-not-found', 'direct-session-not-found', 'not-found'].includes(code) ? 404
                    : code === 'unauthorized' ? 401 : ['forbidden', 'workspace-forbidden'].includes(code) ? 403 : 400);
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

const ATTACHMENT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ATTACHMENT_MEDIA_TYPE_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const ATTACHMENT_SHA256_RE = /^[0-9a-f]{64}$/;
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_TOTAL_MAX_BYTES = 32 * 1024 * 1024;

export function canonicalAttachmentName(raw) {
    const cleaned = String(raw ?? '')
        .replace(/[\u0000-\u001f\u007f/\\]+/g, '_')
        .trim()
        .slice(0, 180);
    return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'attachment' : cleaned;
}

export function normalizeAttachmentsPayload(raw) {
    if (!Array.isArray(raw)) return undefined;
    const out = [];
    const seen = new Set();
    let totalBytes = 0;
    for (const item of raw) {
        if (out.length >= 8) break;
        if (!item || typeof item !== 'object') continue;
        if (item.kind !== 'image' && item.kind !== 'file') continue;
        if (typeof item.attachmentId !== 'string') continue;
        const attachmentId = item.attachmentId.trim();
        if (!attachmentId || attachmentId.length > 128 || attachmentId.includes('/') || attachmentId.includes('\\') || attachmentId.includes('..') || seen.has(attachmentId)) continue;
        if (typeof item.bytes !== 'number' || !Number.isInteger(item.bytes) || item.bytes < 0 || item.bytes > ATTACHMENT_MAX_BYTES) continue;
        if (totalBytes + item.bytes > ATTACHMENT_TOTAL_MAX_BYTES) continue;
        const mediaType = typeof item.mediaType === 'string' ? item.mediaType.trim().toLowerCase() : '';
        if (!mediaType || mediaType.length > 128 || !ATTACHMENT_MEDIA_TYPE_RE.test(mediaType)) continue;
        const sha256 = typeof item.sha256 === 'string' ? item.sha256.trim().toLowerCase() : '';
        if (!ATTACHMENT_SHA256_RE.test(sha256)) continue;
        const name = canonicalAttachmentName(item.name);
        if (item.kind === 'image') {
            if (!ATTACHMENT_IMAGE_TYPES.has(mediaType)) continue;
            if (typeof item.width !== 'number' || !Number.isInteger(item.width) || item.width < 1 || item.width > 32768) continue;
            if (typeof item.height !== 'number' || !Number.isInteger(item.height) || item.height < 1 || item.height > 32768) continue;
            seen.add(attachmentId);
            totalBytes += item.bytes;
            out.push({ kind: 'image', attachmentId, name, bytes: item.bytes, mediaType, sha256, width: item.width, height: item.height });
        }
        else {
            seen.add(attachmentId);
            totalBytes += item.bytes;
            out.push({ kind: 'file', attachmentId, name, bytes: item.bytes, mediaType, sha256 });
        }
    }
    return out.length > 0 ? out : undefined;
}

function normalizeTicketMetadata(body) {
    const clean = (value, max) => typeof value === 'string' && value.trim() !== '' &&
        value.trim().length <= max && !/[\u0000-\u001f\u007f]/.test(value);
    const result = {};
    if (Object.hasOwn(body, 'cascadePath')) {
        if (!Array.isArray(body.cascadePath) || body.cascadePath.length !== 3 || !body.cascadePath.every(item => clean(item, 128))) {
            throw taskError('invalid-cascade-path', '分类路径必须包含三个有效层级。');
        }
        result.cascadePath = body.cascadePath.map(item => item.trim());
    }
    if (Object.hasOwn(body, 'links')) {
        const raw = body.links;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw taskError('invalid-links', '关联资料格式无效。');
        result.links = {};
        for (const [key, items] of Object.entries(raw)) {
            if (!['sessionIds', 'proposalIds', 'docPaths'].includes(key) || !Array.isArray(items) || items.length > 32 ||
                !items.every(item => clean(item, 256) && (key === 'docPaths'
                    ? !/[:\\%]/.test(item) && item.trim().split('/').every(part => part && part !== '..' && part !== '.')
                    : !/[\\/]/.test(item)))) {
                throw taskError('invalid-links', '关联资料必须是有效标识或工作区相对文档路径。');
            }
            result.links[key] = [...new Set(items.map(item => item.trim()))];
        }
    }
    return result;
}

function actionCarriesAttachments(action) {
    if (!action || typeof action !== 'object') return false;
    if (action.kind === 'create') return Array.isArray(action.input?.attachments) && action.input.attachments.length > 0;
    if (action.kind === 'update') return Array.isArray(action.patch?.attachments) && action.patch.attachments.length > 0;
    return false;
}

export function postVerifiedBoardAction(origin, req, requestId, action, initiator) {
    const url = new URL('/api/task-board/action', origin);
    const body = JSON.stringify({
        requestId,
        action,
        ...(typeof initiator === 'string' && initiator.trim() !== '' ? { initiator } : {}),
    });
    const headers = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        connection: 'close',
        origin: url.origin,
        'sec-fetch-site': 'same-origin',
        ...(typeof req?.headers?.cookie === 'string' && req.headers.cookie !== '' ? { cookie: req.headers.cookie } : {}),
        ...(typeof req?.headers?.authorization === 'string' && req.headers.authorization !== '' ? { authorization: req.headers.authorization } : {}),
    };
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
        const upstream = transport(url, { method: 'POST', headers, timeout: 15_000 }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let parsed;
                try { parsed = raw ? JSON.parse(raw) : {}; }
                catch { parsed = {}; }
                const status = response.statusCode ?? 500;
                if (status >= 200 && status < 300 && parsed && typeof parsed === 'object') {
                    resolve(parsed);
                    return;
                }
                const err = new Error(typeof parsed?.error === 'string' && parsed.error
                    ? parsed.error
                    : '任务看板拒绝了附件操作（HTTP ' + status + '）');
                err.code = typeof parsed?.code === 'string' && parsed.code ? parsed.code : 'attachment-action-failed';
                err.status = status >= 400 && status < 600 ? status : 400;
                reject(err);
            });
        });
        upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('附件校验请求超时'), { code: 'attachment-timeout', status: 504 })));
        upstream.on('error', err => reject(err));
        upstream.end(body);
    });
}

function taskView(task, workflow, room, ticketNumbers) {
    const executions = Array.isArray(task.executions) ? task.executions : [];
    const latest = executions.length > 0 ? executions[executions.length - 1] : undefined;
    const openExecution = executions.some(item => item && item.endedAt === undefined);
    const tags = normalizeCardTags(task.tags);
    const attachments = normalizeAttachmentsPayload(task.attachments);
    const ticketNo = ticketNumbers?.get?.(task.id) ?? ticketNumbers?.ensure?.(task.id);
    const patchAvailable = Boolean(workflow?.development?.digest && !workflow?.development?.appliedAt);
    return {
        id: task.id,
        ...(ticketNo ? { ticketNo } : {}),
        title: task.title,
        status: room?.closed ? 'done' : workflow === undefined || workflow.state === 'ready' ? task.status
            : workflow.state === 'running' || workflow.state === 'handed-off' ? 'running'
            : workflow.state === 'permission-blocked' || workflow.state === 'review-blocked' ? 'review'
            : workflow.state === 'done' ? (task.status === 'done' ? 'done' : (room ? 'review' : 'done')) : 'failed',
        ...(workflow === undefined ? {} : { workflow }),
        ...(patchAvailable ? { patchAvailable: true } : {}),
        ...(workflow?.reviewReason ? { reviewReason: workflow.reviewReason } : {}),
        ...(workflow?.reviewSummary ? { reviewSummary: workflow.reviewSummary } : {}),
        ...(room === undefined ? {} : { taskRoom: visibleTaskRoom(room, ticketNumbers) }),
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
        ...(task.cascadePath === undefined ? {} : { cascadePath: task.cascadePath }),
        ...(task.links === undefined ? {} : { links: task.links }),
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
    const {
        root: groupsRootDir, rosters, ticketNumbers, sessionTitles, sessionController, config, llm, readDefaultModel,
        workspacePath, webOrigin, getAttachmentStore, resolveAttachments, surface: dshSurface, moveCardStatus,
        taskOverrides: injectedTaskOverrides, patchStore: injectedPatchStore, eventBus, eventStreams, collectPlainIncidents,
        workspaceRegistry, getSpeechToText, getLlm, voiceEngine: injectedVoiceEngine,
    } = extras;
    const writeMutation = (res, value, ...topics) => {
        write(res, 200, value);
        for (const topic of topics) eventBus.emit(topic);
    };
    const writeTaskMutation = (res, value) => writeMutation(res, value, 'tasks.changed', 'incidents.changed');
    const patchStore = injectedPatchStore ?? (groupsRootDir ? createPatchStore(join(groupsRootDir, 'patches')) : undefined);
    const taskOverrides = injectedTaskOverrides ?? createTaskOverrides(groupsRootDir ? join(groupsRootDir, 'task-overrides.json') : undefined);
    const effectiveCard = (source, task) => task ? taskOverrides.applyTo(source, task) : undefined;
    const applyBoardAction = async (req, board, source, action, actionInitiator = initiator) => {
        const requestId = randomUUID();
        if (source === 'host' && actionCarriesAttachments(action)) {
            if (typeof board.applyVerified === 'function') {
                return board.applyVerified(requestId, action, actionInitiator);
            }
            const origin = typeof webOrigin === 'function' ? webOrigin() : undefined;
            if (typeof origin === 'string' && origin !== '') {
                return postVerifiedBoardAction(origin, req, requestId, action, actionInitiator);
            }
        }
        return board.apply(requestId, action, actionInitiator);
    };
    const authenticate = (req, write = false, { touch = true } = {}) =>
        auth.authenticate(req, { write, origins: allowedOrigins(), touch });
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
    const latestSessionIdOf = (rawTask, workflow) => {
        if (typeof workflow?.sessionId === 'string' && workflow.sessionId !== '') return workflow.sessionId;
        const execs = Array.isArray(rawTask?.executions) ? rawTask.executions : [];
        for (let i = execs.length - 1; i >= 0; i -= 1) {
            if (typeof execs[i]?.sessionId === 'string' && execs[i].sessionId !== '') return execs[i].sessionId;
        }
        return typeof rawTask?.sessionId === 'string' && rawTask.sessionId !== '' ? rawTask.sessionId : undefined;
    };
    const selectResidentSessionModel = async (sessionId, modelSpec, effortSpec) => {
        if (!sessionId || typeof sessionController?.selectModel !== 'function') return false;
        let route = typeof modelSpec === 'string' ? modelSpec.trim() : '';
        if (!route) {
            try {
                const ctrl = await dshSurface?.controls?.(sessionId, AbortSignal.timeout(3000));
                if (typeof ctrl?.current?.model === 'string' && ctrl.current.model !== '') route = ctrl.current.model;
            } catch { /* fallback to defaultModel */ }
        }
        if (!route && typeof readDefaultModel === 'function') {
            try {
                const dm = readDefaultModel();
                if (dm?.provider && dm?.model) route = `${dm.provider}/${dm.model}`;
                else if (typeof dm?.model === 'string') route = dm.model;
            } catch { /* ignore */ }
        }
        if (!route) return false;
        const slash = route.indexOf('/');
        const provider = slash > 0 ? route.slice(0, slash) : undefined;
        const model = slash > 0 ? route.slice(slash + 1) : route;
        if (!model) return false;
        const rawEffort = typeof effortSpec === 'string' ? effortSpec.trim() : '';
        const effort = rawEffort && rawEffort !== 'off' && rawEffort !== 'none' ? rawEffort : undefined;
        try {
            await sessionController.selectModel({
                sessionId,
                ...(provider ? { provider } : {}),
                model,
                ...(effort ? { reasoningEffort: effort } : {}),
            });
            return true;
        } catch {
            if (effort) {
                try {
                    await sessionController.selectModel({ sessionId, ...(provider ? { provider } : {}), model });
                    return true;
                } catch { /* ignore */ }
            }
            return false;
        }
    };
    const queueResidentPrompt = (sessionId, text, signal, prefix = 'marshal-steer-') => sessionController.prompt({
        requestId: prefix + randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }],
    }, signal);
    const steerResidentSession = async (sessionId, text) => {
        if (!sessionId || !text || typeof sessionController?.prompt !== 'function') return false;
        try {
            await queueResidentPrompt(sessionId, text, AbortSignal.timeout(10_000));
            return true;
        } catch {
            return false;
        }
    };
    const ensureRoomForNotice = (source, card, workflow, access, ledger) => {
        if (!rooms || !card?.id) return undefined;
        const existing = rooms.find(source, card.id);
        if (existing) return existing;
        const wsId = workflow?.workspaceId ?? card?.workspaceId;
        if (!wsId || !access?.ok) return undefined;
        if (!allowed(access, { workspaceId: wsId }, ledger)) return undefined;
        try {
            const tNo = ticketNumbers?.ensure?.(card.id);
            return rooms.ensure(source, tNo ? { ...card, title: withTicketPrefix(tNo, card.title) } : card, wsId, access.session.ownerId);
        } catch {
            return undefined;
        }
    };
    const appendRoomEventSafe = async ({ source, card, workflow, access, ledger, kind, phase, actor = 'Marshal', text, reopenIfClosed = false }) => {
        if (!text) return false;
        const room = ensureRoomForNotice(source, card, workflow, access, ledger);
        if (!room) return false;
        try {
            let current = (await rooms.page(room.id, { limit: 1 })).room;
            if (reopenIfClosed && current.closed) {
                await rooms.append(room.id, {
                    kind: 'reopened', runId: current.runId, actor: '工单操作者',
                    text: '工单因内容修订自动重开。',
                });
                current = (await rooms.page(room.id, { limit: 1 })).room;
            }
            let runId = current.runId;
            if (kind === 'user' && !runId) {
                runId = randomUUID();
                await rooms.begin(room.id, runId, 'Marshal', 'conversation', '工单实时插话');
            }
            await rooms.append(room.id, {
                kind,
                ...(runId ? { runId } : {}),
                actor,
                text,
                ...(phase ? { phase } : {}),
            });
            return true;
        } catch {
            return false;
        }
    };
    const saveCardPromptOverride = async (source, card, nextPrompt, actionInitiator = initiator) => {
        const board = getBoard();
        if (!board) return undefined;
        const raw = (board.snapshot().tasks ?? []).find(item => item.id === card.id) ?? card;
        const canNativeEdit = raw.archivedAt === undefined && (Array.isArray(raw.executions) ? raw.executions.length : 0) === 0;
        if (canNativeEdit) {
            try {
                const snap = await board.apply(randomUUID(), { kind: 'update', taskId: card.id, patch: { prompt: nextPrompt } }, actionInitiator);
                taskOverrides.set(source, card.id, { prompt: nextPrompt });
                return snap;
            } catch { /* fall through to Marshal override */ }
        }
        taskOverrides.set(source, card.id, { prompt: nextPrompt });
        return board.snapshot();
    };
    const executionAfter = (board, taskId, before) => {
        const key = run => JSON.stringify([run.id, run.startedAt]);
        const previous = new Set((before ?? []).filter(Boolean).map(key));
        let observedKey;
        let observedSession;
        return () => {
            const runs = board.snapshot().tasks?.find(item => item.id === taskId)?.executions ?? [];
            const fresh = runs.filter(run => run && (run.id != null || run.startedAt != null) && !previous.has(key(run)));
            const run = fresh[0];
            if (fresh.length > 1 || (observedKey !== undefined && (!run || key(run) !== observedKey)) ||
                (run && (run !== runs.at(-1) || (observedSession && run.sessionId !== observedSession)))) {
                return { replaced: true };
            }
            if (run) {
                observedKey = key(run);
                if (run.sessionId) observedSession = run.sessionId;
            }
            return { run };
        };
    };
    const guidanceExecutionState = run => {
        const states = [run.result, run.status, run.state, run.error?.code, run.error?.name]
            .filter(state => typeof state === 'string').map(state => state.toLowerCase());
        if (states.some(state => ['cancelled', 'canceled', 'aborted', 'interrupted', 'abort_err', 'aborterror',
            'timeout', 'timed-out', 'timed_out', 'etimedout', 'timeouterror'].includes(state))) return 'unconfirmed';
        if (states.includes('failed') || run.error) return 'failed';
        if (run.endedAt != null || states.includes('succeeded')) return states.includes('succeeded') ? 'completed' : 'unconfirmed';
        return 'active';
    };
    const waitForGuidanceExecution = async (readExecution, acceptCompleted) => {
        const deadline = performance.now() + 4000;
        let attachedAt;
        while (performance.now() < deadline) {
            const { run, replaced } = readExecution();
            if (replaced) return {};
            if (run) {
                const state = guidanceExecutionState(run);
                if (state === 'failed') return { failed: true };
                if (state !== 'active') return { completed: acceptCompleted && state === 'completed' };
                if (typeof run.sessionId === 'string' && run.sessionId) {
                    const liveTurn = typeof dshSurface?.activeTurn === 'function'
                        ? Boolean(await Promise.resolve(dshSurface.activeTurn(run.sessionId)).catch(() => false))
                        : false;
                    const historyPage = !liveTurn && typeof dshSurface?.history === 'function'
                        ? await dshSurface.history({ sessionId: run.sessionId, limit: 5 }, AbortSignal.timeout(800)).catch(() => null)
                        : null;
                    const hasFreshHistory = Array.isArray(historyPage?.events) && historyPage.events.some(ev =>
                        !Number.isFinite(run.startedAt) || !Number.isFinite(ev?.time) || ev.time >= run.startedAt);
                    if (liveTurn || hasFreshHistory) {
                        const latest = readExecution();
                        if (latest.replaced) return {};
                        if (latest.run) {
                            const latestState = guidanceExecutionState(latest.run);
                            if (latestState === 'failed') return { failed: true };
                            if (latestState !== 'active') return { completed: acceptCompleted && latestState === 'completed' };
                            if (latest.run.sessionId === run.sessionId) return { sessionId: run.sessionId };
                        }
                    }
                    attachedAt ??= performance.now();
                    // Attaching an ID is not a startup acknowledgement: the host
                    // can still reject the launch after several polling intervals.
                    if (performance.now() - attachedAt >= 1200) return { sessionId: run.sessionId };
                }
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return {};
    };
    const clearPermissionBlock = (source, taskId) => taskOverrides.setPermissionBlocked(source, taskId, undefined);
    const recordPermissionBlock = (source, taskId, error) => {
        const summary = [error?.code, error?.message ?? String(error)].filter(Boolean).join('：')
            .replace(/\s+/g, ' ').slice(0, 600);
        taskOverrides.setPermissionBlocked(source, taskId, { taskId, at: Date.now(), summary });
        return summary;
    };
    const handlePermissionBlocked = async (res, req, source, taskId, room, error) => {
        recordPermissionBlock(source, taskId, error);
        if (room) {
            const current = rooms.find(source, taskId);
            try {
                await rooms.append(room.id, { kind: 'status', phase: 'permission-blocked', actor: 'Marshal',
                    text: '权限或沙箱受阻', ...(current?.runId ? { runId: current.runId } : {}) });
            } catch { /* Keep the legacy permission-blocked response if the room is unavailable. */ }
        }
        const board = getBoard();
        let snapshot = board.snapshot();
        let movedToReview = false;
        try {
            snapshot = await board.apply(randomUUID(), { kind: 'move', taskId, status: 'review' }, initiator);
            movedToReview = true;
        } catch { /* keep snapshot if move refused */ }
        writeTaskMutation(res, {
            ok: true,
            permissionBlocked: true,
            movedToReview,
            message: '权限受阻：' + (error instanceof Error ? error.message : String(error)) + '，工单已转入「待确认」等待确认。',
            tasks: taskList(snapshot, req, source),
        });
    };
    const launchPlainCardWithOverrides = async (source, taskId, actionInitiator = initiator, explicitPrompt = undefined, guidance = undefined) => {
        const board = getBoard();
        const raw = (board.snapshot().tasks ?? []).find(item => item.id === taskId);
        const hasOverride = taskOverrides.hasExecutionOverride(source, taskId);
        try {
            if (raw && (Array.isArray(raw.executions) && raw.executions.length > 0) && (hasOverride || explicitPrompt !== undefined)) {
                const eff = effectiveCard(source, raw);
                const finalPrompt = explicitPrompt ?? eff?.prompt ?? eff?.description ?? eff?.title ?? '';
                const instructions = [
                    '【工单最新修订内容（请严格以此最新版本执行）】',
                    eff?.title ? '标题：' + eff.title : '',
                    eff?.description ? '描述：\n' + eff.description : '',
                    finalPrompt ? '执行指令：\n' + finalPrompt : '',
                ].filter(Boolean).join('\n\n');
                const executionText = prioritizeGuidance(instructions, guidance, guidance ? 4000 : 15_000);
                const settledSession = [...raw.executions].reverse().find(ex => ex?.endedAt !== undefined && typeof ex?.sessionId === 'string' && ex.sessionId !== '');
                if (settledSession) {
                    const readRework = executionAfter(board, taskId, raw.executions);
                    let accepted = false;
                    try {
                        const snapshot = await board.apply(randomUUID(), { kind: 'rework', taskId, instructions: executionText }, actionInitiator);
                        clearPermissionBlock(source, taskId);
                        if (!guidance) return snapshot;
                        accepted = true;
                    } catch (error) {
                        if (isPermissionBlockedError(error)) throw error;
                        /* fall back to standard run + session queue */
                    }
                    if (accepted) {
                        const execution = await waitForGuidanceExecution(readRework, true);
                        if (execution.sessionId || execution.completed) return board.snapshot();
                        // Don't restart a cancelled run or race a rework that might still be starting.
                        if (!execution.failed) throw guidanceSessionUnavailable();
                    }
                }
                if (guidance) {
                    // Capture the baseline again so a failed rework cannot satisfy the fallback.
                    const beforeRun = board.snapshot().tasks?.find(item => item.id === taskId)?.executions;
                    const readRun = executionAfter(board, taskId, beforeRun);
                    try {
                        await board.apply(randomUUID(), { kind: 'run', taskId }, actionInitiator);
                        clearPermissionBlock(source, taskId);
                        const { sessionId } = await waitForGuidanceExecution(readRun, false);
                        if (sessionId) {
                            await runGuidancePrompt(sessionId, executionText);
                            const { run, replaced } = readRun();
                            if (!replaced && run?.sessionId === sessionId &&
                                ['active', 'completed'].includes(guidanceExecutionState(run))) return board.snapshot();
                        }
                    } catch (error) {
                        if (isPermissionBlockedError(error)) recordPermissionBlock(source, taskId, error);
                        throw Object.assign(guidanceSessionUnavailable(), { cause: error });
                    }
                    throw guidanceSessionUnavailable();
                }
                const snap = await board.apply(randomUUID(), { kind: 'run', taskId }, actionInitiator);
                clearPermissionBlock(source, taskId);
                void (async () => {
                    for (let attempt = 0; attempt < 15; attempt += 1) {
                        const cur = (board.snapshot().tasks ?? []).find(item => item.id === taskId);
                        const openEx = Array.isArray(cur?.executions) ? [...cur.executions].reverse().find(ex => ex?.endedAt === undefined && ex?.sessionId) : undefined;
                        if (openEx?.sessionId) {
                            await steerResidentSession(openEx.sessionId, executionText);
                            return;
                        }
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                })();
                return snap;
            }
            if (guidance) {
                // A first run uses the native card prompt, not the Marshal sidecar.
                // Verify the host persisted it and then observe the execution of that prompt.
                if (!raw?.prompt?.includes(guidance)) {
                    throw taskError('guidance-prompt-not-saved', '宿主看板未确认保存含指导的执行指令。');
                }
                const readRun = executionAfter(board, taskId, raw.executions);
                try {
                    await board.apply(randomUUID(), { kind: 'run', taskId }, actionInitiator);
                    clearPermissionBlock(source, taskId);
                    const execution = await waitForGuidanceExecution(readRun, true);
                    if (execution.sessionId || execution.completed) return board.snapshot();
                } catch (error) {
                    if (isPermissionBlockedError(error)) recordPermissionBlock(source, taskId, error);
                    throw Object.assign(guidanceSessionUnavailable(), { cause: error });
                }
                throw guidanceSessionUnavailable();
            }
            const snap = await board.apply(randomUUID(), { kind: 'run', taskId }, actionInitiator);
            clearPermissionBlock(source, taskId);
            return snap;
        } catch (error) {
            if (isPermissionBlockedError(error)) recordPermissionBlock(source, taskId, error);
            throw error;
        }
    };
    const taskList = (snapshot, req, source) => {
        const access = authenticate(req);
        const ledger = access.ok ? auth.loadLedger() : undefined;
        const rawTasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
        ticketNumbers?.ensureAll?.(rawTasks);
        return rawTasks.flatMap(task => {
            const target = orchestration?.target(source, task.id);
            const room = rooms?.find(source, task.id);
            if (room && !taskRoomAccess(access, room, allowed, ledger)) return [];
            if (target && !allowed(access, { workspaceId: target.workspaceId }, ledger)) return [];
            const eff = effectiveCard(source, task);
            const view = taskView(eff, target ? orchestration.view(source, task.id) : undefined, room, ticketNumbers);
            // The legacy board can list unscoped cards without a desktop session,
            // but must not disclose the new desktop-only references in that view.
            if ((view.cascadePath || view.links) && !allowed(access, { workspaceId: target?.workspaceId ?? room?.workspaceId ?? task.workspaceId }, ledger)) {
                delete view.cascadePath;
                delete view.links;
            }
            return [view];
        });
    };
    const roomRoutes = createTaskRoomRoutes({
        exact, write, readBody, authenticate, allowed, auth, rooms,
        orchestration, getBoard, boardSource, getInitiator: () => initiator.replace(/^marshal:/, ''),
        ticketNumbers, workspacePath, normalizeAttachments: normalizeAttachmentsPayload, resolveAttachments,
        surface: dshSurface, moveCardStatus,
        getEffectiveCard: effectiveCard, saveCardPromptOverride, launchPlainCardWithOverrides,
        patchStore, steerResidentSession, eventBus, clearPermissionBlock,
    });
    const agentTasks = createAgentTaskStore({ dataDir: groupsRootDir });
    const deviceId = config.deviceId;
    const queryOf = req => new URL(req.url ?? '/', 'http://marshal.local').searchParams;
    const domain = (method, path, handler) => exact(method, '/marshal/' + path, async (req, res) => {
        const access = authenticate(req, method === 'POST');
        if (!access.ok) { write(res, 403, { ok: false, code: access.code }); return; }
        await handler(req, res, access, auth.loadLedger());
    }, true);
    const agentDirectory = ledger => (ledger.teams ?? []).flatMap(team => (Array.isArray(team?.members) ? team.members : []).flatMap(member => {
        if (typeof team.id !== 'string' || !team.id || typeof member?.id !== 'string' || !member.id) return [];
        return [{ agentKey: `${deviceId}/${team.id}/${member.id}`, teamId: team.id, agentId: member.id,
            workspaceId: team.workspaceId, name: member.name }];
    }));
    const resolveAgentKey = (key, directory) => {
        const matches = directory.filter(agent => agentKeyMatches(agent.agentKey, key));
        return matches.length === 1 ? matches[0] : undefined;
    };
    const agentAllowed = (access, agent, ledger) => {
        const team = ledger.teams.find(team => team?.id === agent.teamId);
        const member = team?.members.find(member => member?.id === agent.agentId);
        if (!member || !allowed(access, agent, ledger)) return false;
        // Scope the member check to this squad even if an older ledger reused a member ID.
        return allowed(access, { agentId: agent.agentId }, { teams: [{ ...team, members: [member] }] });
    };
    const requireAgent = (value, access, ledger, directory = agentDirectory(ledger)) => {
        const agent = resolveAgentKey(parseAgentKey(value), directory);
        if (!agent) throw taskError('not-found', '智能体不存在或标识不唯一。');
        if (!agentAllowed(access, agent, ledger)) throw taskError('workspace-forbidden', '当前账号无权操作该智能体。');
        return agent;
    };
    const scopedTickets = (access, ledger) => {
        const source = boardSource();
        return (getBoard()?.snapshot()?.tasks ?? []).flatMap(raw => {
            const workflow = orchestration?.view(source, raw.id);
            const room = rooms?.find(source, raw.id);
            if (room && !taskRoomAccess(access, room, allowed, ledger)) return [];
            if (!allowed(access, { workspaceId: workflow?.workspaceId ?? room?.workspaceId ?? raw.workspaceId }, ledger)) return [];
            return [{ ...effectiveCard(source, raw), workflow, taskRoom: room,
                permissionBlock: taskOverrides.get(source, raw.id)?.permissionBlock }];
        });
    };
    const requireTicket = (tickets, value) => {
        const id = TaskRoomKey.parse(value);
        const ticket = tickets.find(task => task.id === id);
        if (!ticket) throw taskError('task-not-found', '工单不存在。');
        return ticket;
    };
    const agentRuns = (agent, ledger) => (Array.isArray(ledger.runs) ? ledger.runs : [])
        .filter(run => run?.teamId === agent.teamId && run.memberId === agent.agentId && typeof run.sessionId === 'string' && run.sessionId)
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const listAgentTasks = (agent, ledger, tickets, directory = agentDirectory(ledger)) => {
        const matches = key => resolveAgentKey(key, directory)?.agentKey === agent.agentKey;
        return agentTasks.listTasks(agent.agentKey, { tickets, sessionIds: agentRuns(agent, ledger).map(run => run.sessionId),
            matchesStored: task => matches(task.agentKey),
            assignedTo: task => [task.agentKey, task.agentId, task.workflow?.leaderId, task.workflow?.agentId,
                ...Object.values(task.workflow?.plan?.members ?? {})].some(matches) || Boolean(agent.name &&
                extractAssignedAgentName(task) === agent.name && (!task.workspaceId || task.workspaceId === agent.workspaceId) &&
                directory.filter(other => other.name === agent.name && (!task.workspaceId || other.workspaceId === task.workspaceId)).length === 1),
        });
    };
    const readRoomRecords = async ticket => {
        const room = ticket.taskRoom;
        if (!room) return [];
        const records = [];
        const first = await rooms.page(room.id, { after: 0, limit: 100 });
        const through = first.room.lastSeq;
        let page = first;
        for (;;) {
            records.push(...page.records.filter(record => record.seq <= through));
            const after = page.records.at(-1)?.seq;
            if (!page.hasNewer || after == null || after >= through) return records;
            page = await rooms.page(room.id, { after, limit: 100 });
            if (page.records.length && page.records[0].seq <= after) throw taskError('task-room-gap', '群消息分页未推进。');
        }
    };
    const proposalsFor = access => access.session.owner ? (memory?.listProposals?.() ?? []) : [];
    const incidentsFor = async (tickets, proposals) => {
        const roomRecordsByTask = new Map();
        // Read the same host history as the background collector, so the first
        // overview after a tool failure need not wait for the next tick. This read does not append.
        for (let offset = 0; offset < tickets.length; offset += 8) {
            await Promise.all(tickets.slice(offset, offset + 8).map(async task => {
                const records = await collectPlainIncidents?.(task);
                if (records?.length) roomRecordsByTask.set(task.id, records);
            }));
        }
        for (const task of tickets) {
            if (task.taskRoom && !task.taskRoom.closed && task.archivedAt == null && task.status !== 'done') {
                const pending = [];
                let before;
                for (;;) {
                    const page = await rooms.page(task.taskRoom.id, { before, limit: 100 });
                    const batch = page.records.findLastIndex(record => record.kind === 'batch');
                    pending.push(page.records.slice(Math.max(0, batch)));
                    const next = page.records[0]?.seq;
                    if (batch >= 0 || !page.hasOlder || next == null) break;
                    if (before !== undefined && next >= before) throw taskError('task-room-gap', '群消息分页未推进。');
                    before = next;
                }
                roomRecordsByTask.set(task.id, [...pending.reverse().flat(), ...(roomRecordsByTask.get(task.id) ?? [])]);
            }
        }
        return buildIncidentsSummary({ tasksState: tickets, roomRecordsByTask, memorySummary: { proposals } });
    };
    const domainTimeout = async (fn, ms, timeoutCode) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(taskError(timeoutCode, '宿主会话接口响应超时。')), ms);
        const expired = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
        try { return await Promise.race([expired, fn(controller.signal)]); }
        finally { clearTimeout(timer); }
    };
    const directSessions = async (agent, ledger) => {
        // A host that runs the standalone agents plugin cannot record `purpose` on a
        // run, so every row is bare there. The board scan below still separates the
        // 1:1 sessions from ticket and orchestration runs in that build.
        const recordsPurpose = (ledger.runs ?? []).some(run => run && run.purpose !== undefined);
        const isDirect = run => run?.purpose === 'direct' || (!recordsPurpose && run?.purpose === undefined);
        // Bare runs in a purpose-aware ledger only prove ownership, not 1:1 intent.
        const excluded = new Set((ledger.runs ?? []).filter(run => !isDirect(run) || run.status === 'failed').map(run => run?.sessionId));
        for (const card of getBoard()?.snapshot()?.tasks ?? []) {
            const workflow = orchestration?.view(boardSource(), card.id);
            for (const id of [workflow?.sessionId, card.sessionId, ...(card.executions ?? []).map(run => run?.sessionId)]) excluded.add(id);
        }
        const runs = agentRuns(agent, ledger).filter(run => isDirect(run) && run.status !== 'failed' && !excluded.has(run.sessionId));
        const sessions = new Map();
        let complete = false;
        if (runs.length && typeof sessionController?.list === 'function') {
            try {
                await domainTimeout(async signal => {
                    let cursor;
                    const seen = new Set();
                    for (let page = 0; page < 20; page += 1) {
                        signal.throwIfAborted();
                        const result = await sessionController.list(cursor === undefined ? {} : { cursor }, signal);
                        signal.throwIfAborted();
                        for (const row of (Array.isArray(result) ? result : result?.items ?? result?.sessions ?? [])) {
                            const id = row.sessionId ?? row.id;
                            if (typeof id === 'string' && id) sessions.set(id, row);
                        }
                        cursor = result?.nextCursor;
                        if (!cursor) { complete = true; break; }
                        if (seen.has(cursor)) break;
                        seen.add(cursor);
                    }
                }, 5000, 'direct-sessions-timeout');
            } catch { /* Ledger still proves ownership of the resident sessions. */ }
        }
        const roots = new Set(runs.filter(run => !complete || sessions.has(run.sessionId)).map(run => run.sessionId));
        // A session that belongs to no Workspace leaves the Host composer inert until
        // the operator picks one, so a legacy unbound run is no 1:1 home: prefer a
        // bound run, and report none so the caller starts one in the agent Workspace.
        let hosted;
        if (workspaceRegistry && typeof workspaceRegistry.list === 'function') {
            try {
                hosted = new Set();
                for (const workspace of workspaceRegistry.list() ?? []) {
                    for (const id of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) hosted.add(id);
                }
            } catch { hosted = undefined; }
        }
        const latest = runs.find(run => roots.has(run.sessionId) && (hosted === undefined || hosted.has(run.sessionId)));
        const children = new Map();
        for (const [id, row] of sessions) {
            const values = row.projections?.values;
            const parentSessionId = row.parentSessionId ?? row.forkedFromId ?? values?.parentSessionId ?? values?.forkedFromId;
            if (typeof parentSessionId !== 'string' || id === parentSessionId || roots.has(id) || excluded.has(id)) continue;
            if (!children.has(parentSessionId)) children.set(parentSessionId, []);
            children.get(parentSessionId).push({ id, parentSessionId, role: row.role ?? (row.forkedFromId || values?.forkedFromId ? 'fork' : 'subagent'),
                status: row.status?.kind ?? row.status ?? '', title: row.title ?? values?.title ?? '' });
        }
        const descendants = rootIds => {
            const owned = new Set(rootIds);
            const subSessions = [];
            for (const id of owned) {
                for (const child of children.get(id) ?? []) {
                    if (owned.has(child.id)) continue;
                    owned.add(child.id);
                    subSessions.push(child);
                }
            }
            return { owned, subSessions };
        };
        const row = sessions.get(latest?.sessionId);
        const mainSession = latest ? { id: latest.sessionId, sessionId: latest.sessionId, status: row?.status?.kind ?? row?.status ?? latest.status,
            title: row?.title ?? row?.projections?.values?.title ?? latest.title ?? '' } : null;
        return { mainSession, subSessions: descendants(latest ? [latest.sessionId] : []).subSessions,
            owned: descendants(roots).owned, complete };
    };
    const runGuidancePrompt = async (sessionId, text) => {
        if (typeof sessionController?.prompt !== 'function') {
            throw Object.assign(taskError('direct-session-unavailable', '宿主会话驱动不可用。'), { status: 503 });
        }
        try {
            const result = await domainTimeout(signal => queueResidentPrompt(sessionId, text, signal, 'marshal-guidance-'),
                10_000, 'direct-guidance-timeout');
            if (result?.ok === false) throw taskError('direct-guidance-rejected', '宿主拒绝直连指导。');
        } catch (error) {
            if (error?.code === 'direct-guidance-timeout') throw Object.assign(error, { status: 504 });
            throw Object.assign(taskError('direct-guidance-rejected', '宿主未确认接收直连指导。'), { status: 502 });
        }
    };
    const agentMutation = (action) => async (req, res, access, ledger) => {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw taskError('invalid-agent-task', '个人任务格式无效。');
        if (action === 'create') {
            const agent = requireAgent(body.agentKey, access, ledger);
            if (body.linkedTicketId != null) requireTicket(scopedTickets(access, ledger), body.linkedTicketId);
            const task = agentTasks.createTask({ ...body, agentKey: agent.agentKey });
            writeMutation(res, { ok: true, task }, 'tasks.changed', 'agents.changed');
            return;
        }
        const id = TaskRoomKey.parse(body.id);
        const prior = agentTasks.getTask(id);
        if (!prior || id.startsWith('ticket:')) throw taskError('not-found', '可编辑的个人任务不存在。');
        const agent = requireAgent(prior.agentKey, access, ledger);
        if (body.agentKey !== undefined && requireAgent(body.agentKey, access, ledger).agentKey !== agent.agentKey) {
            throw taskError('workspace-forbidden', '不能将个人任务移动到其他智能体。');
        }
        if (action === 'delete') {
            agentTasks.deleteTask(id);
            writeMutation(res, { ok: true, id }, 'tasks.changed', 'agents.changed');
            return;
        }
        const { id: ignored, agentKey: ignoredKey, ...flat } = body;
        const patch = body.patch ?? flat;
        if (patch?.linkedTicketId != null) requireTicket(scopedTickets(access, ledger), patch.linkedTicketId);
        const task = agentTasks.updateTask(id, patch);
        writeMutation(res, { ok: true, task }, 'tasks.changed', 'agents.changed');
    };
    const desktopRoutes = [
        domain('GET', 'desktop/overview', async (_req, res, access, ledger) => {
            const tickets = scopedTickets(access, ledger);
            const proposals = await proposalsFor(access);
            const countsByStatus = { running: 0, review: 0, queued: 0, done: 0, failed: 0 };
            for (const ticket of tickets) if (ticket.archivedAt == null) countsByStatus[ticketStatus(ticket)] += 1;
            const agents = agentDirectory(ledger).filter(agent => agentAllowed(access, agent, ledger)).map(agent => {
                const run = agentRuns(agent, ledger)[0];
                return { ...agent, sessionId: run?.sessionId, status: run?.status };
            });
            const incidents = await incidentsFor(tickets, proposals);
            write(res, 200, { ok: true, host: { deviceId, deviceName: config.deviceName, role: config.role,
                version: pluginPackage.version, taskBoardSource: boardSource() },
                tasks: { totalCount: Object.values(countsByStatus).reduce((a, b) => a + b, 0), countsByStatus },
                incidents, agents: { totalCount: agents.length, items: agents }, memory: { pendingProposalCount: incidents.countsByKind['memory-proposal'] } });
        }),
        domain('GET', 'agent-tasks', async (req, res, access, ledger) => {
            const agent = requireAgent(queryOf(req).get('agentKey'), access, ledger);
            write(res, 200, { ok: true, tasks: listAgentTasks(agent, ledger, scopedTickets(access, ledger)) });
        }),
        domain('POST', 'agent-tasks/create', agentMutation('create')),
        domain('POST', 'agent-tasks/update', agentMutation('update')),
        domain('POST', 'agent-tasks/delete', agentMutation('delete')),
        domain('GET', 'agent-direct-sessions', async (req, res, access, ledger) => {
            const agent = requireAgent(queryOf(req).get('agentKey'), access, ledger);
            const { mainSession, subSessions, complete } = await directSessions(agent, ledger);
            write(res, 200, { ok: true, agentKey: agent.agentKey, mainSession, subSessions, complete });
        }),
        domain('POST', 'agents/guidance-sync', async (req, res, access, ledger) => {
            const body = await readBody(req);
            const agent = requireAgent(body?.agentKey, access, ledger);
            if ((body.taskIds !== undefined && (!Array.isArray(body.taskIds) || body.taskIds.length > 32 ||
                !body.taskIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 1024))) ||
                (body.wakeTicket !== undefined && typeof body.wakeTicket !== 'boolean')) throw taskError('invalid-guidance-target', '任务选择或唤醒选项无效。');
            const tickets = scopedTickets(access, ledger);
            const selected = new Map(listAgentTasks(agent, ledger, tickets).map(task => [task.id, task]));
            const tasks = [...new Set(body.taskIds ?? [])].map(id => {
                if (!selected.has(id)) throw taskError('not-found', '所选个人任务不可用。');
                return selected.get(id);
            });
            const resolveTicket = value => {
                const ticket = requireTicket(tickets, value);
                if (ticket.archivedAt != null) throw taskError('invalid-guidance-target', '归档工单不能接收指导。');
                if (!rooms || !(ticket.taskRoom || ticket.workflow?.workspaceId || ticket.workspaceId)) {
                    throw taskError('task-room-not-found', '目标工单未绑定工作区工单群。');
                }
                if (body.wakeTicket !== false && ticket.workflow && !allowed(access, ticket.workflow, ledger)) {
                    throw taskError('workspace-forbidden', '当前账号无权唤醒该编排。');
                }
                return ticket;
            };
            let sessionList;
            const result = await syncGuidanceToAgent({ tasks, targetTicketId: body.targetTicketId === undefined ? undefined : TaskRoomKey.parse(body.targetTicketId),
                guidanceText: body.guidanceText, wakeTicket: body.wakeTicket, resolveTicket,
                ensureRoom: ticket => ticket.taskRoom ?? rooms.ensure(boardSource(), ticket, ticket.workflow?.workspaceId ?? ticket.workspaceId, access.session.ownerId),
                reviseTicket: (ticket, guidance) => roomRoutes.reviseTask({ room: rooms.find(boardSource(), ticket.id), card: ticket, guidance, access, initiatorTag: initiator }),
                rooms, store: agentTasks, eventBus, steerResidentSession: runGuidancePrompt,
                resolveSession: async task => {
                    const { mainSession, owned } = await (sessionList ??= directSessions(agent, ledger));
                    const id = task.sessionId ?? mainSession?.id;
                    if (!id) throw taskError('direct-session-not-found', '智能体尚无直连会话。');
                    if (!owned.has(id)) throw taskError('workspace-forbidden', '无法确认直连会话属于该智能体。');
                    return id;
                },
            });
            const failed = result.deliveries.find(item => item.code);
            write(res, failed?.status ?? 200, { ok: !failed, ...(failed ? { code: failed.code } : {}), ...result });
        }),
        domain('GET', 'tasks/dag', async (req, res, access, ledger) => {
            const ticket = requireTicket(scopedTickets(access, ledger), queryOf(req).get('taskId'));
            write(res, 200, { ok: true, ...projectTaskDag(ticket, await readRoomRecords(ticket)) });
        }),
        domain('GET', 'tasks/dag/node', async (req, res, access, ledger) => {
            const query = queryOf(req);
            const ticket = requireTicket(scopedTickets(access, ledger), query.get('taskId'));
            const node = getTaskDagNodeDetail(ticket, await readRoomRecords(ticket), query.get('nodeId'));
            if (!node) throw taskError('not-found', '编排节点不存在。');
            const stored = patchStore?.read(node.patchDigest);
            if (stored) {
                node.diff = stored;
                node.diffFiles = extractPatchTouchedFiles(stored);
            }
            write(res, 200, { ok: true, taskId: ticket.id, node });
        }),
        domain('GET', 'incidents/summary', async (_req, res, access, ledger) => {
            write(res, 200, { ok: true, ...await incidentsFor(scopedTickets(access, ledger), await proposalsFor(access)) });
        }),
    ];
    const voice = injectedVoiceEngine ?? createVoiceEngine({
        getSpeechToText,
        llm,
        getLlm,
        readDefaultModel,
        memory,
    });
    const lookupMember = (agent, ledger) => (ledger.teams ?? [])
        .find(team => team?.id === agent.teamId)?.members
        ?.find(member => member?.id === agent.agentId);
    const voiceRoutes = [
        domain('GET', 'voice/capabilities', async (_req, res) => {
            write(res, 200, voice.capabilities());
        }),
        domain('POST', 'voice/prepare', async (req, res, access) => {
            if (!access.session.owner) {
                write(res, 403, { ok: false, code: 'owner-only', message: '仅机主账号可准备宿主机语音识别模型。' });
                return;
            }
            const body = await readBody(req);
            const source = typeof body?.downloadSource === 'string'
                ? body.downloadSource
                : (typeof body?.source === 'string' ? body.source : undefined);
            const result = voice.prepareStt({
                providerId: typeof body?.providerId === 'string' ? body.providerId : undefined,
                downloadSource: source,
            });
            write(res, result.ok ? 200 : 503, result);
        }),
        domain('POST', 'voice/transcribe', async (req, res) => {
            const body = await readBody(req, 6 * 1024 * 1024);
            const abort = new AbortController();
            const onAbort = () => abort.abort();
            const onResClose = () => { if (!res.writableEnded) abort.abort(); };
            req.on?.('aborted', onAbort);
            res.on?.('close', onResClose);
            try {
                const result = await voice.transcribe({
                    audioBase64: body?.audioBase64,
                    language: body?.language,
                    providerId: body?.providerId,
                }, abort.signal);
                if (abort.signal.aborted || res.destroyed || res.writableEnded) return;
                write(res, 200, result);
            } finally {
                req.off?.('aborted', onAbort);
                res.off?.('close', onResClose);
            }
        }),
        domain('POST', 'voice/turn', async (req, res, access, ledger) => {
            const body = await readBody(req);
            const agent = requireAgent(body?.agentKey, access, ledger);
            const utterance = typeof body?.text === 'string' ? body.text.trim() : '';
            if (!utterance) {
                write(res, 400, { ok: false, code: 'invalid-text', error: 'invalid-text', message: '语音输入内容不能为空。' });
                return;
            }
            const member = lookupMember(agent, ledger);
            let ticketContext = '';
            if (typeof body?.targetTicketId === 'string' && body.targetTicketId.trim()) {
                try {
                    const ticket = requireTicket(scopedTickets(access, ledger), body.targetTicketId.trim());
                    ticketContext = `工单：${ticket.title || ticket.id}（状态：${ticket.status || 'unknown'}）\n${String(ticket.description || '').slice(0, 500)}`;
                } catch { /* ignore inaccessible or stale ticket context */ }
            }
            const abort = new AbortController();
            let closed = false;
            const onAbort = () => {
                closed = true;
                abort.abort();
            };
            const onResClose = () => { if (!res.writableEnded) onAbort(); };
            req.on?.('aborted', onAbort);
            res.on?.('close', onResClose);
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-transform',
                'connection': 'keep-alive',
                'x-accel-buffering': 'no',
            });
            const sendEvent = (event, payload) => {
                if (closed || res.destroyed || res.writableEnded) return;
                try {
                    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
                } catch {
                    onAbort();
                }
            };
            try {
                for await (const item of voice.streamVoiceTurn({
                    agent,
                    member,
                    text: utterance,
                    history: body?.history,
                    ticketContext,
                    allowGlobalMemory: access.session.owner === true,
                    signal: abort.signal,
                })) {
                    if (closed || abort.signal.aborted) break;
                    sendEvent(item.type, item);
                }
            } catch (error) {
                if (!abort.signal.aborted) {
                    sendEvent('error', {
                        code: errorCode(error),
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            } finally {
                req.off?.('aborted', onAbort);
                res.off?.('close', onResClose);
                if (!res.destroyed && !res.writableEnded) {
                    try { res.end(); } catch { /* ignore */ }
                }
            }
        }),
        domain('POST', 'voice/tts', async (req, res) => {
            const body = await readBody(req);
            const abort = new AbortController();
            const onAbort = () => abort.abort();
            const onResClose = () => { if (!res.writableEnded) abort.abort(); };
            req.on?.('aborted', onAbort);
            res.on?.('close', onResClose);
            try {
                const result = await voice.synthesizeTts({
                    provider: typeof body?.provider === 'string' ? body.provider : undefined,
                    text: body?.text,
                    voice: typeof body?.voice === 'string' ? body.voice : undefined,
                    rate: body?.rate,
                    signal: abort.signal,
                });
                if (abort.signal.aborted || res.destroyed || res.writableEnded) return;
                res.writeHead(200, {
                    'content-type': result.mime,
                    'cache-control': 'no-store',
                    'x-marshal-tts-provider': result.provider,
                    'x-marshal-tts-voice': encodeURIComponent(String(result.voice ?? '').slice(0, 128)),
                    ...(result.fallbackFrom ? { 'x-marshal-tts-fallback': result.fallbackFrom } : {}),
                });
                res.end(result.audio);
            } finally {
                req.off?.('aborted', onAbort);
                res.off?.('close', onResClose);
            }
        }),
        domain('POST', 'voice/summarize', async (req, res, access, ledger) => {
            const body = await readBody(req, 256 * 1024);
            const agent = requireAgent(body?.agentKey, access, ledger);
            const member = lookupMember(agent, ledger);
            let ticketTitle = '';
            if (typeof body?.targetTicketId === 'string' && body.targetTicketId.trim()) {
                try {
                    ticketTitle = requireTicket(scopedTickets(access, ledger), body.targetTicketId.trim()).title ?? '';
                } catch { /* ignore */ }
            }
            const abort = new AbortController();
            const onAbort = () => abort.abort();
            const onResClose = () => { if (!res.writableEnded) abort.abort(); };
            req.on?.('aborted', onAbort);
            res.on?.('close', onResClose);
            try {
                const result = await voice.summarizeCall({
                    agent,
                    member,
                    transcript: body?.transcript,
                    notes: body?.notes,
                    ticketTitle,
                    signal: abort.signal,
                });
                if (abort.signal.aborted || res.destroyed || res.writableEnded) return;
                write(res, 200, result);
            } finally {
                req.off?.('aborted', onAbort);
                res.off?.('close', onResClose);
            }
        }),
    ];
    return [
        ...roomRoutes.routes,
        ...desktopRoutes,
        ...voiceRoutes,
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
        exact('GET', '/marshal/events', (req, res) => {
            const initialAccess = authenticate(req, false);
            if (initialAccess.ok !== true) { write(res, 403, { ok: false, code: initialAccess.code }); return; }
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-transform',
                'connection': 'keep-alive',
                'x-accel-buffering': 'no',
            });
            let timer;
            let unsubscribe;
            let closed = false;
            const cleanup = () => {
                if (closed) return false;
                closed = true;
                clearInterval(timer);
                unsubscribe?.();
                req.off('close', stop);
                res.off('close', stop);
                eventStreams.delete(stop);
                return true;
            };
            const stop = () => {
                if (cleanup() && !res.destroyed) res.destroy?.();
            };
            const reauthenticate = () => {
                if (closed) return;
                // Outbound traffic is not session activity.
                const access = authenticate(req, false, { touch: false });
                if (access.ok === true) return access;
                stop();
            };
            const safeWrite = chunk => {
                if (closed) return;
                // Reconnect a slow client rather than queueing an unbounded event stream.
                if (res.destroyed || res.writableEnded || res.write(chunk) === false) stop();
            };
            req.on('close', stop);
            res.on('close', stop);
            eventStreams.add(stop);
            unsubscribe = eventBus.subscribe((topic, payload) => {
                const access = reauthenticate();
                if (!access) return;
                if (typeof topic !== 'string' || /[\r\n]/.test(topic)) return;
                if (topic === 'room.message' && (typeof payload?.roomId !== 'string'
                    || !taskRoomAccess(access, rooms?.local(payload.roomId), allowed))) return;
                const json = JSON.stringify(payload);
                if (json !== undefined) safeWrite(`event: ${topic}\ndata: ${json}\n\n`);
            });
            timer = setInterval(() => {
                if (reauthenticate()) safeWrite(': ping\n\n');
            }, 25_000);
            timer.unref?.();
            safeWrite('event: ready\ndata: {}\n\n');
        }, true),
        ...createMemoryRoutes({ memory, auth, allowedOrigins, eventBus }).map(route => exact(route.method, route.path, route.handler, true)),
        exact('GET', '/marshal/tasks/orchestration', async (req, res) => {
            const access = authenticate(req);
            if (!access.ok) { write(res, access.status, { ok: false, code: access.code }); return; }
            const catalog = orchestration?.catalog() ?? { templates: [], groupTemplates: [], leaders: [], memoryAvailable: false };
            const codexModels = orchestration?.codexCatalog ? await orchestration.codexCatalog().catch(() => []) : [];
            const ledger = auth.loadLedger();
            write(res, 200, { ok: true, ...catalog, codexModels, leaders: catalog.leaders.filter(leader => allowed(access, leader, ledger)) });
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
            const board = getBoard();
            if (!board) { write(res, 503, { ok: false, code: 'no-task-board' }); return; }
            const body = await readBody(req);
            const source = boardSource();
            const rawCard = (board.snapshot().tasks ?? []).find(item => item.id === body.taskId);
            const card = effectiveCard(source, rawCard);
            const room = rooms?.find(source, body.taskId);
            const workflow = orchestration.target(source, body.taskId);
            const ledger = auth.loadLedger();
            if (!workflow && !card) {
                write(res, 404, { ok: false, code: 'task-not-found' });
                return;
            }
            if (room && !taskRoomAccess(access, room, allowed, ledger)) {
                write(res, 403, { ok: false, code: 'workspace-forbidden' });
                return;
            }
            if (workflow && !room && !allowed(access, workflow, ledger)) {
                write(res, 403, { ok: false, code: 'workspace-forbidden' });
                return;
            }
            const prepared = orchestration.prepare({
                ...body.orchestration,
                workspaceId: body.orchestration?.workspaceId ?? workflow?.workspaceId ?? room?.workspaceId ?? card?.workspaceId,
            }, member => allowed(access, member, ledger));
            if ((workflow && prepared.workspaceId !== workflow.workspaceId) || (room && prepared.workspaceId !== room.workspaceId)) {
                write(res, 403, { ok: false, code: 'workspace-forbidden' });
                return;
            }
            if (!allowed(access, prepared, ledger)) {
                write(res, 403, { ok: false, code: 'workspace-forbidden' });
                return;
            }
            const configured = orchestration.configure(source, body.taskId, prepared);
            const noticeText = configured?._notice || '';
            if (noticeText && card) {
                await appendRoomEventSafe({
                    source, card, workflow: configured, access, ledger,
                    kind: 'status', phase: 'config-change', actor: 'Marshal', text: noticeText,
                });
            }
            const sid = latestSessionIdOf(rawCard, configured);
            if (sid) {
                const lCfg = configured?.agentConfigs?.leader ?? configured?.plan?.agentConfigs?.leader;
                await selectResidentSessionModel(sid, lCfg?.model, lCfg?.reasoningEffort);
            }
            write(res, 200, {
                ok: true,
                ...(noticeText ? { notice: noticeText } : {}),
                tasks: taskList(board.snapshot(), req, source),
            });
        }),
        exact('POST', '/marshal/tasks/agent-configs', async (req, res) => {
            const access = authenticate(req, true);
            if (!access.ok) { write(res, access.status, { ok: false, code: access.code }); return; }
            if (!orchestration) { write(res, 503, { ok: false, code: 'orchestration-unavailable' }); return; }
            const board = getBoard();
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') {
                write(res, 400, { ok: false, code: 'invalid-task' });
                return;
            }
            const source = boardSource();
            const rawCard = (board?.snapshot().tasks ?? []).find(item => item.id === body.taskId);
            const card = effectiveCard(source, rawCard);
            const room = rooms?.find(source, body.taskId);
            const workflow = orchestration.target(source, body.taskId);
            const ledger = auth.loadLedger();
            if (!workflow && !card) {
                write(res, 404, { ok: false, code: 'task-not-found' });
                return;
            }
            if (room && !taskRoomAccess(access, room, allowed, ledger)) {
                write(res, 403, { ok: false, code: 'workspace-forbidden' });
                return;
            }
            if (workflow && !room && !allowed(access, workflow, ledger)) {
                write(res, 403, { ok: false, code: 'workspace-forbidden' });
                return;
            }
            const updatedWf = orchestration.updateAgentConfigs(source, body.taskId, {
                ...body,
                ...(!workflow && !body.workspaceId && (room?.workspaceId || card?.workspaceId) ? { workspaceId: room?.workspaceId ?? card?.workspaceId } : {}),
            }, member => allowed(access, member, ledger));
            const noticeText = updatedWf?._notice || '';
            if (noticeText && card) {
                await appendRoomEventSafe({
                    source, card, workflow: updatedWf, access, ledger,
                    kind: 'status', phase: 'config-change', actor: 'Marshal', text: noticeText,
                });
            }
            const sid = latestSessionIdOf(rawCard, updatedWf);
            if (sid && (body.agentConfigs?.leader || body.leaderId)) {
                const lCfg = updatedWf?.agentConfigs?.leader ?? updatedWf?.plan?.agentConfigs?.leader;
                await selectResidentSessionModel(sid, lCfg?.model, lCfg?.reasoningEffort);
            }
            write(res, 200, {
                ok: true,
                ...(noticeText ? { notice: noticeText } : {}),
                tasks: taskList(board ? board.snapshot() : { tasks: [] }, req, source),
            });
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
            const report = await orchestration.report(source, id);
            if (report === undefined) {
                write(res, 404, { ok: false, code: 'report-not-found' });
                return;
            }
            write(res, 200, { ok: true, report });
        }),
        exact('GET', '/marshal/tasks/attachment', async (req, res) => {
            const board = getBoard();
            if (board === undefined) {
                write(res, 503, { ok: false, code: 'no-task-board' });
                return;
            }
            const params = new URL(req.url ?? '', 'http://localhost').searchParams;
            const taskId = params.get('taskId') ?? '';
            const attachmentId = params.get('id') ?? '';
            if (!taskId || !attachmentId) {
                write(res, 400, { ok: false, code: 'invalid-attachment-query' });
                return;
            }
            const source = boardSource();
            const task = (board.snapshot().tasks ?? []).find(item => item.id === taskId);
            if (!task) {
                write(res, 404, { ok: false, code: 'task-not-found' });
                return;
            }
            const access = authenticate(req);
            const ledger = access.ok ? auth.loadLedger() : undefined;
            const room = rooms?.find(source, taskId);
            const target = orchestration?.target(source, taskId);
            if (room && !taskRoomAccess(access, room, allowed, ledger)) {
                write(res, access.ok ? 403 : access.status, { ok: false, code: access.ok ? 'workspace-forbidden' : access.code });
                return;
            }
            if (target && !allowed(access, { workspaceId: target.workspaceId }, ledger)) {
                write(res, access.ok ? 403 : access.status, { ok: false, code: access.ok ? 'workspace-forbidden' : access.code });
                return;
            }
            const effTask = effectiveCard(source, task);
            const att = (normalizeAttachmentsPayload(effTask?.attachments) ?? []).find(item => item.attachmentId === attachmentId);
            if (!att) {
                write(res, 404, { ok: false, code: 'not-found', message: '未在该工单上找到对应附件。' });
                return;
            }
            const store = typeof getAttachmentStore === 'function' ? getAttachmentStore() : undefined;
            if (!store) {
                write(res, 503, { ok: false, code: 'storage-unavailable', message: '当前环境未挂载附件存储服务。' });
                return;
            }
            if (att.kind === 'image') {
                const stored = await store.readImage({
                    attachmentId: att.attachmentId, mediaType: att.mediaType, bytes: att.bytes,
                    width: att.width, height: att.height, name: att.name,
                });
                const buf = Buffer.from(stored.data);
                res.writeHead(200, {
                    'content-type': stored.ref.mediaType,
                    'content-length': String(buf.byteLength),
                    'content-disposition': "inline; filename*=UTF-8''" + encodeURIComponent(att.name),
                    'x-content-type-options': 'nosniff',
                    'cache-control': 'no-store',
                });
                res.end(buf);
                return;
            }
            res.writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-length': String(att.bytes),
                'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(att.name),
                'x-content-type-options': 'nosniff',
                'cache-control': 'no-store',
            });
            for await (const chunk of store.readFileStream({ attachmentId: att.attachmentId, name: att.name, bytes: att.bytes })) {
                res.write(Buffer.from(chunk));
            }
            res.end();
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
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw taskError('invalid-request', '工单格式无效。');
            // Legacy unscoped board creates retain their original loopback contract.
            // The new desktop metadata always requires the desktop session and CSRF proof.
            const enhanced = Object.hasOwn(body, 'cascadePath') || Object.hasOwn(body, 'links');
            const metadataAccess = enhanced ? authenticate(req, true) : undefined;
            if (metadataAccess && (!metadataAccess.ok || (body.workspaceId === undefined && body.orchestration === undefined && !metadataAccess.session.owner))) {
                write(res, 403, { ok: false, code: metadataAccess.ok ? 'workspace-forbidden' : metadataAccess.code });
                return;
            }
            const metadata = normalizeTicketMetadata(body);
            const title = typeof body.title === 'string' ? body.title.trim() : '';
            if (title === '') {
                write(res, 400, { ok: false, code: 'invalid-title' });
                return;
            }
            const description = typeof body.description === 'string' ? body.description.trim() : '';
            const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
            const tags = normalizeCardTags(body.tags);
            const attachments = normalizeAttachmentsPayload(body.attachments);
            if (Array.isArray(body.attachments) && body.attachments.length > 0 && attachments === undefined) {
                write(res, 400, { ok: false, code: 'invalid-attachments', message: '附件元数据无效或超过限制（最多 8 个，单文件 ≤ 10MB）。' });
                return;
            }
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
                const access = metadataAccess ?? authenticate(req, true);
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
            const cardWorkspaceId = scope?.workspaceId ?? (typeof body.workspaceId === 'string' && body.workspaceId.trim() !== '' ? body.workspaceId.trim() : undefined);
            let cardTags = tags;
            if (prepared?.leaderName) {
                const hasAgentTag = Array.isArray(cardTags) && cardTags.some(t => typeof t?.name === 'string' && (t.name.startsWith('智能体:') || t.name.startsWith('@')));
                if (!hasAgentTag) {
                    const leaderTag = { name: ('智能体:' + prepared.leaderName).slice(0, 32) };
                    cardTags = Array.isArray(cardTags) ? [...cardTags, leaderTag].slice(0, 8) : [leaderTag];
                }
            }
            const input = {
                title, description, prompt: prompt || description || title,
                ...(cardWorkspaceId === undefined ? {} : { workspaceId: cardWorkspaceId }),
                ...(cardTags === undefined ? {} : { tags: cardTags }),
                ...(attachments === undefined ? {} : { attachments }),
                ...(parentId === undefined ? {} : { parentId }),
                ...(permission === undefined ? {} : { permission }),
                ...(model === undefined ? {} : { model }),
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                ...(reuseSession === undefined ? {} : { reuseSession }),
            };
            const beforeIds = existing ?? new Set((board.snapshot().tasks ?? []).map(task => task.id));
            // Attach orchestration BEFORE board.apply('create') so other
            // synchronous board-change listeners immediately observe the workflow instead
            // of racing and falling back to a plain un-orchestrated dispatch.
            let preAttached = false;
            if (scope && prepared) {
                try {
                    orchestration.attach(source, id, prepared);
                    preAttached = true;
                } catch {
                    write(res, 500, { ok: false, code: 'task-orchestration-not-saved', message: '无法保存任务编排。' });
                    return;
                }
            }
            let snapshot;
            try {
                snapshot = await applyBoardAction(req, board, source, { kind: 'create', id, input }, initiator);
            } catch (createError) {
                if (preAttached) {
                    try { orchestration.remove(source, id); } catch { /* preserve original error */ }
                }
                throw createError;
            }
            const added = (snapshot.tasks ?? []).filter(task => !beforeIds.has(task.id));
            const created = (snapshot.tasks ?? []).find(task => task.id === id) ?? (added.length === 1 ? added[0] : undefined);
            if (scope) {
                if (!created) {
                    if (preAttached) {
                        try { orchestration.remove(source, id); } catch { /* ignore */ }
                    }
                    write(res, 409, { ok: false, code: 'task-create-not-observed' });
                    return;
                }
                try {
                    if (prepared && created.id !== id) {
                        if (preAttached) {
                            try { orchestration.remove(source, id); } catch { /* ignore */ }
                        }
                        orchestration.attach(source, created.id, prepared);
                    }
                    const ticketNo = ticketNumbers?.ensure?.(created.id);
                    rooms.ensure(source, ticketNo ? { ...created, title: withTicketPrefix(ticketNo, created.title) } : created, scope.workspaceId, scope.ownerId);
                }
                catch {
                    if (prepared) {
                        try { orchestration.remove(source, created.id); } catch { /* preserve original error */ }
                        if (preAttached && created.id !== id) {
                            try { orchestration.remove(source, id); } catch { /* preserve original error */ }
                        }
                    }
                    try { await board.apply(randomUUID(), { kind: 'delete', taskId: created.id }, initiator); }
                    catch { /* A host without rollback can leave an unconfigured card. */ }
                    write(res, 500, { ok: false, code: 'task-orchestration-not-saved', message: '无法保存任务编排。' });
                    return;
                }
            }
            if (enhanced) {
                if (!created) { write(res, 409, { ok: false, code: 'task-create-not-observed' }); return; }
                try { taskOverrides.setMetadata(source, created.id, metadata); }
                catch {
                    // Unlike the sidecar, the host board may already have committed.
                    write(res, 500, { ok: false, code: 'task-metadata-not-saved', taskId: created.id });
                    eventBus.emit('tasks.changed');
                    eventBus.emit('incidents.changed');
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
            writeTaskMutation(res, {
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
                const rawTask = (snapshot.tasks ?? []).find(item => item.id === body.taskId);
                if (!rawTask) {
                    write(res, 404, { ok: false, code: 'task-not-found' });
                    return;
                }
                const task = effectiveCard(source, rawTask);
                const access = authenticate(req, true);
                const runTicketNo = ticketNumbers?.ensure?.(task.id);
                const room = boundRoom ?? rooms?.ensure(source, runTicketNo ? { ...task, title: withTicketPrefix(runTicketNo, task.title) } : task, workflow.workspaceId, access.session.ownerId);
                if (!room || !taskRoomAccess(access, room, allowed)) {
                    write(res, 403, { ok: false, code: 'workspace-forbidden' });
                    return;
                }
                roomRoutes.assertIdle(room);
                if (room.closed) {
                    await rooms.append(room.id, { kind: 'reopened', runId: room.runId, actor: '工单操作者', text: '工单重新运行，自动重开工单群。' });
                }
                clearPermissionBlock(source, body.taskId);
                orchestration.start(source, task, taskRoomAudit(rooms, room, workflow.state === 'done' || workflow.state === 'review-blocked' ? 'retry' : undefined, undefined, undefined,
                    member => allowed(access, member)));
                writeTaskMutation(res, { ok: true, tasks: taskList(snapshot, req, source) });
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
                    await rooms.append(boundRoom.id, { kind: 'reopened', runId: current.room.runId, actor: '工单操作者', text: '工单重新运行，自动重开工单群。' });
                }
            }
            try {
                const snapshot = await launchPlainCardWithOverrides(source, body.taskId, initiator);
                writeTaskMutation(res, { ok: true, tasks: taskList(snapshot, req, source) });
            }
            catch (error) {
                if (isPermissionBlockedError(error)) {
                    await handlePermissionBlocked(res, req, source, body.taskId, boundRoom, error);
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
            if (body.status === 'done') clearPermissionBlock(source, body.taskId);
            if (workflow) {
                let recoveredDev;
                if (body.status === 'review' && !workflow.development && boundRoom) {
                    try {
                        const page = await rooms.page(boundRoom.id, { limit: 100 });
                        const latestPatch = [...(page.records ?? [])].reverse().find(r => r.phase === 'development-patch' && r.ref);
                        if (latestPatch) recoveredDev = { development: { base: 'HEAD', digest: latestPatch.ref }, reviewReason: workflow.reviewReason ?? 'review-blocked' };
                    } catch { /* ignore */ }
                }
                orchestration.syncStatus?.(source, body.taskId, body.status, recoveredDev);
            }
            if (boundRoom) {
                try {
                    const current = (await rooms.page(boundRoom.id, { limit: 1 })).room;
                    if (body.status === 'done' && !current.closed) {
                        await rooms.append(boundRoom.id, { kind: 'closed', runId: current.runId, actor: '工单操作者', phase: 'confirmed', text: '工单已在看板确认完成并归档。' });
                    } else if (body.status !== 'done' && current.closed) {
                        await rooms.append(boundRoom.id, { kind: 'reopened', runId: current.runId, actor: '工单操作者', text: '工单已从看板移回「' + body.status + '」并重开。' });
                    }
                } catch { /* room sync is best-effort */ }
            }
            writeTaskMutation(res, { ok: true, tasks: taskList(snapshot, req, source) });
        }),
        exact('POST', '/marshal/tasks/confirm-review', async (req, res) => {
            const board = getBoard();
            if (board === undefined) { write(res, 503, { ok: false, code: 'no-task-board' }); return; }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') { write(res, 400, { ok: false, code: 'invalid-task' }); return; }
            const source = boardSource();
            const rawCard = (board.snapshot().tasks ?? []).find(item => item.id === body.taskId);
            if (!rawCard) { write(res, 404, { ok: false, code: 'task-not-found' }); return; }
            const card = effectiveCard(source, rawCard);
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            const access = authenticate(req, true);
            if (boundRoom) {
                if (!taskRoomAccess(access, boundRoom, allowed)) { write(res, 403, { ok: false, code: 'workspace-forbidden' }); return; }
            }
            if (workflow && !authorize(req, res, workflow)) return;
            const result = await roomRoutes.confirmReview({ room: boundRoom, card, body, access, initiatorTag: initiator });
            writeTaskMutation(res, {
                ok: true,
                patchApplied: result.patchApplied,
                patchAlreadyApplied: result.patchAlreadyApplied,
                ...(result.committed ? { committed: true, commitHash: result.commitHash } : {}),
                tasks: taskList(result.snapshot ?? board.snapshot(), req, source),
            });
        }),
        exact('POST', '/marshal/tasks/revise', async (req, res) => {
            const board = getBoard();
            if (board === undefined) { write(res, 503, { ok: false, code: 'no-task-board' }); return; }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') { write(res, 400, { ok: false, code: 'invalid-task' }); return; }
            const source = boardSource();
            const rawCard = (board.snapshot().tasks ?? []).find(item => item.id === body.taskId);
            if (!rawCard) { write(res, 404, { ok: false, code: 'task-not-found' }); return; }
            const card = effectiveCard(source, rawCard);
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            const access = authenticate(req, true);
            if (boundRoom) {
                if (!taskRoomAccess(access, boundRoom, allowed)) { write(res, 403, { ok: false, code: 'workspace-forbidden' }); return; }
            } else if (workflow || card.workspaceId) {
                if (!access.ok || !allowed(access, workflow ?? { workspaceId: card.workspaceId })) {
                    write(res, access.ok ? 403 : access.status, { ok: false, code: access.ok ? 'workspace-forbidden' : access.code });
                    return;
                }
            }
            if (workflow && !authorize(req, res, workflow)) return;
            try {
                const result = await roomRoutes.reviseTask({ room: boundRoom, card, body, access, initiatorTag: initiator });
                writeTaskMutation(res, { ok: true, tasks: taskList(result.snapshot ?? board.snapshot(), req, source) });
            } catch (error) {
                if (isPermissionBlockedError(error)) {
                    await handlePermissionBlocked(res, req, source, body.taskId, rooms?.find(source, body.taskId) ?? boundRoom, error);
                    return;
                }
                throw error;
            }
        }),
        exact('POST', '/marshal/tasks/update', async (req, res) => {
            const board = getBoard();
            if (board === undefined) { write(res, 503, { ok: false, code: 'no-task-board' }); return; }
            const body = await readBody(req);
            if (typeof body.taskId !== 'string' || body.taskId === '') { write(res, 400, { ok: false, code: 'invalid-task' }); return; }
            const source = boardSource();
            const rawBefore = (board.snapshot().tasks ?? []).find(item => item.id === body.taskId);
            if (!rawBefore) { write(res, 404, { ok: false, code: 'task-not-found' }); return; }
            const prevCard = effectiveCard(source, rawBefore);
            const workflow = orchestration?.target(source, body.taskId);
            const boundRoom = rooms?.find(source, body.taskId);
            const access = authenticate(req, Boolean(boundRoom || workflow));
            const ledger = access.ok ? auth.loadLedger() : undefined;
            if (boundRoom) {
                if (!taskRoomAccess(access, boundRoom, allowed, ledger)) { write(res, 403, { ok: false, code: 'workspace-forbidden' }); return; }
            }
            if (workflow && !authorize(req, res, workflow)) return;

            const contentPatch = {};
            const metaPatch = {};
            if (typeof body.title === 'string') {
                if (body.title.trim() === '') { write(res, 400, { ok: false, code: 'invalid-title', message: '标题不能为空。' }); return; }
                contentPatch.title = body.title.trim();
            }
            if (typeof body.description === 'string') contentPatch.description = body.description;
            if (typeof body.prompt === 'string') contentPatch.prompt = body.prompt;
            if (body.attachments === null || (Array.isArray(body.attachments) && body.attachments.length === 0)) {
                contentPatch.attachments = null;
            }
            else if (Array.isArray(body.attachments)) {
                const normalized = normalizeAttachmentsPayload(body.attachments);
                if (normalized === undefined) {
                    write(res, 400, { ok: false, code: 'invalid-attachments', message: '附件元数据无效或超过限制（最多 8 个，单文件 ≤ 10MB）。' });
                    return;
                }
                contentPatch.attachments = normalized;
            }

            if (['read-only', 'workspace-write', 'danger-full-access'].includes(body.permission)) metaPatch.permission = body.permission;
            if (typeof body.model === 'string') metaPatch.model = body.model.trim();
            if (typeof body.reasoningEffort === 'string') metaPatch.reasoningEffort = body.reasoningEffort.trim();
            if (body.reuseSession === null || typeof body.reuseSession === 'boolean') metaPatch.reuseSession = body.reuseSession;
            if (typeof body.workspaceId === 'string') metaPatch.workspaceId = body.workspaceId.trim();
            if (body.freeze === null) metaPatch.freeze = null;
            else if (body.freeze && typeof body.freeze === 'object' && typeof body.freeze.goal === 'string') {
                metaPatch.freeze = body.freeze.goal.trim() !== '' ? { goal: body.freeze.goal.trim() } : null;
            }
            if (body.tags === null) metaPatch.tags = null;
            else if (Array.isArray(body.tags)) {
                const tags = normalizeCardTags(body.tags);
                metaPatch.tags = tags ?? null;
            }

            if (Object.keys(contentPatch).length === 0 && Object.keys(metaPatch).length === 0) {
                write(res, 400, { ok: false, code: 'empty-patch' });
                return;
            }

            let snapshot = board.snapshot();
            const canNativeContentEdit = rawBefore.archivedAt === undefined && (Array.isArray(rawBefore.executions) ? rawBefore.executions.length : 0) === 0;
            if (canNativeContentEdit && rawBefore.archivedAt === undefined) {
                const combinedPatch = { ...metaPatch, ...contentPatch };
                try {
                    snapshot = await applyBoardAction(req, board, source, { kind: 'update', taskId: body.taskId, patch: combinedPatch }, initiator);
                    if (Object.keys(contentPatch).length > 0 && taskOverrides.hasExecutionOverride(source, body.taskId)) {
                        taskOverrides.set(source, body.taskId, contentPatch);
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (!/already been executed|read-only/i.test(msg)) throw err;
                    if (Object.keys(metaPatch).length > 0) {
                        snapshot = await applyBoardAction(req, board, source, { kind: 'update', taskId: body.taskId, patch: metaPatch }, initiator);
                    }
                    if (Object.keys(contentPatch).length > 0) {
                        taskOverrides.set(source, body.taskId, contentPatch);
                    }
                }
            } else {
                if (Object.keys(metaPatch).length > 0 && rawBefore.archivedAt === undefined) {
                    snapshot = await applyBoardAction(req, board, source, { kind: 'update', taskId: body.taskId, patch: metaPatch }, initiator);
                }
                if (Object.keys(contentPatch).length > 0) {
                    taskOverrides.set(source, body.taskId, contentPatch);
                }
            }

            const rawAfter = (snapshot.tasks ?? []).find(item => item.id === body.taskId) ?? rawBefore;
            const nextCard = effectiveCard(source, rawAfter);
            const writeAccess = access.ok ? access : authenticate(req, true);
            const writeLedger = writeAccess.ok ? (ledger ?? auth.loadLedger()) : undefined;

            // 1) Plain-card model / thinking mode / assigned agent change -> notify room + update resident session for next turn
            const { summary: plainConfigNotice } = describePlainConfigChanges(prevCard, nextCard);
            if (plainConfigNotice) {
                await appendRoomEventSafe({
                    source, card: nextCard, workflow, access: writeAccess, ledger: writeLedger,
                    kind: 'status', phase: 'config-change', actor: 'Marshal', text: plainConfigNotice,
                });
                const sid = latestSessionIdOf(rawAfter, workflow);
                if (sid && ('model' in metaPatch || 'reasoningEffort' in metaPatch)) {
                    await selectResidentSessionModel(sid, nextCard.model, nextCard.reasoningEffort);
                }
            }

            // 2) Content change -> live steering injection if running (and steerNow !== false), or room update record if idle
            const openExecution = Array.isArray(rawAfter?.executions) && rawAfter.executions.some(ex => ex && ex.endedAt === undefined);
            const isTicketRunning = Boolean(
                orchestration?.isRunning?.(source, body.taskId)
                || workflow?.state === 'running'
                || workflow?.state === 'handed-off'
                || openExecution
                || rawAfter?.status === 'running'
            );
            const shouldSteer = body.steerNow === true || (isTicketRunning && body.steerNow !== false);
            const steerMessage = Object.keys(contentPatch).length > 0
                ? describeContentSteeringMessage(prevCard, nextCard, contentPatch)
                : '';
            let steered = false;
            if (steerMessage) {
                if (shouldSteer) {
                    const roomWrote = await appendRoomEventSafe({
                        source, card: nextCard, workflow, access: writeAccess, ledger: writeLedger,
                        kind: 'user', phase: 'steering', actor: '工单操作者', text: steerMessage, reopenIfClosed: true,
                    });
                    const sid = latestSessionIdOf(rawAfter, workflow);
                    const sessionSteered = sid ? await steerResidentSession(sid, steerMessage) : false;
                    steered = Boolean(roomWrote || sessionSteered || orchestration?.isRunning?.(source, body.taskId));
                } else if (boundRoom) {
                    await appendRoomEventSafe({
                        source, card: nextCard, workflow, access: writeAccess, ledger: writeLedger,
                        kind: 'status', phase: 'content-updated', actor: 'Marshal',
                        text: '📝 工单内容已修改，将在下次运行或继续执行时生效。',
                    });
                }
            }

            writeTaskMutation(res, {
                ok: true,
                ...(steered ? { steered: true } : {}),
                ...(plainConfigNotice ? { configNotice: plainConfigNotice } : {}),
                tasks: taskList(snapshot, req, source),
            });
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
            const snapshot = await board.apply(randomUUID(), { kind: 'set-parent', taskId: body.taskId, parentId }, initiator);
            writeTaskMutation(res, { ok: true, tasks: taskList(snapshot, req, source) });
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
            writeTaskMutation(res, { ok: true, tasks: taskList(snapshot, req, source) });
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
            writeTaskMutation(res, { ok: true, tasks: taskList(snapshot, req, source) });
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
            writeTaskMutation(res, { ok: true, tasks: taskList(snapshot, req, source) });
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
            writeTaskMutation(res, { ok: true, tasks: taskList(snapshot, req, source) });
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
            clearPermissionBlock(source, body.taskId);
            writeTaskMutation(res, { ok: true, tasks: taskList(snapshot, req, source) });
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
            if (!(snapshot.tasks ?? []).some(task => task.id === body.taskId)) {
                if (workflow) orchestration.remove(source, body.taskId);
                taskOverrides.remove(source, body.taskId);
            }
            writeTaskMutation(res, { ok: true, tasks: taskList(snapshot, req, source) });
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
            writeMutation(res, { ok: true, roster: saved, rosters: rosters.list() }, 'agents.changed');
        }),
        exact('GET', '/marshal/agents/sessions', async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const filterAgentId = url.searchParams.get('agentId') || '';
            const filterTeamId = url.searchParams.get('teamId') || '';
            let rawRuns = [];
            const teamsById = new Map();
            const agentByName = new Map();
            const agentByWorkspace = new Map();
            try {
                const parsed = JSON.parse(readFileSync(agentsLedgerPath(), 'utf8'));
                if (Array.isArray(parsed?.runs)) rawRuns = parsed.runs;
                for (const t of Array.isArray(parsed?.teams) ? parsed.teams : []) {
                    if (!t?.id) continue;
                    teamsById.set(t.id, t);
                    for (const m of Array.isArray(t.members) ? t.members : []) {
                        if (m?.name && !agentByName.has(m.name)) agentByName.set(m.name, { team: t, member: m });
                        if (t.workspaceId && !agentByWorkspace.has(t.workspaceId)) agentByWorkspace.set(t.workspaceId, { team: t, member: m });
                    }
                }
            } catch { /* empty ledger */ }
            const sessionMeta = new Map();
            try {
                if (typeof sessionController?.list === 'function') {
                    let cursor;
                    for (let page = 0; page < 20; page++) {
                        const listed = await sessionController.list(cursor === undefined ? {} : { cursor });
                        const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : Array.isArray(listed?.sessions) ? listed.sessions : [];
                        for (const s of rows) {
                            const sid = s?.sessionId ?? s?.id;
                            if (typeof sid === 'string' && sid) {
                                sessionMeta.set(sid, {
                                    title: typeof s.title === 'string' ? s.title : (typeof s?.projections?.values?.title === 'string' ? s.projections.values.title : ''),
                                    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : undefined,
                                    cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
                                });
                            }
                        }
                        if (!listed?.nextCursor || listed.nextCursor === cursor) break;
                        cursor = listed.nextCursor;
                    }
                }
            } catch { /* session listing optional */ }
            const seen = new Set();
            const sessions = [];
            const pushSession = ({ sessionId, teamId, memberId, agentName, workspaceId, createdAt, status, fallbackTitle, archived = false }) => {
                if (!sessionId || seen.has(sessionId)) return;
                if (filterAgentId && memberId !== filterAgentId) return;
                if (filterTeamId && teamId !== filterTeamId) return;
                seen.add(sessionId);
                const meta = sessionMeta.get(sessionId);
                const pc = readProjcacheSession(sessionId);
                const effectiveCreated = createdAt || pc?.createdAt || 0;
                const effectiveUpdated = meta?.updatedAt ?? effectiveCreated;
                const resolved = sessionTitles
                    ? sessionTitles.resolve({
                        sessionId,
                        dshTitle: pc?.title || meta?.title || '',
                        firstText: pc?.firstText || '',
                        agentName,
                        fallbackTitle,
                        createdAt: effectiveCreated,
                    })
                    : { title: pc?.title || meta?.title || fallbackTitle || (agentName ? agentName + ' · 闲聊' : '历史会话'), titleSource: 'dsh' };
                const sessionCwd = pc?.cwd || meta?.cwd || '';
                const legacyReadOnly = Boolean(sessionCwd && /\/\.dsh-marshal\/agents\/Agent\s*·\s*/.test(sessionCwd) && !existsSync(sessionCwd));
                sessions.push({
                    sessionId,
                    teamId: teamId || '',
                    memberId: memberId || '',
                    agentName: agentName || '',
                    workspaceId: workspaceId || '',
                    title: resolved.title,
                    titleSource: resolved.titleSource,
                    hasPreview: Boolean(pc?.firstText),
                    archived,
                    legacyReadOnly,
                    createdAt: effectiveCreated,
                    updatedAt: effectiveUpdated,
                    status: status || '',
                });
            };
            for (const run of rawRuns) {
                if (!run || typeof run.sessionId !== 'string' || !run.sessionId) continue;
                const team = teamsById.get(run.teamId);
                const member = (team?.members ?? []).find(m => m.id === run.memberId);
                pushSession({
                    sessionId: run.sessionId,
                    teamId: run.teamId,
                    memberId: run.memberId,
                    agentName: member?.name ?? run.memberName ?? '',
                    workspaceId: team?.workspaceId ?? '',
                    createdAt: typeof run.createdAt === 'number' ? run.createdAt : 0,
                    status: run.status ?? '',
                    fallbackTitle: run.title,
                });
            }
            // Merge preserved legacy session archive (survives after legacy "Agent · *" workspaces are cleaned)
            try {
                const legacyFile = join(groupsRootDir ?? join(homedir(), '.dsh-marshal', 'groups'), 'legacy-agent-sessions.json');
                const legacyData = JSON.parse(readFileSync(legacyFile, 'utf8'));
                for (const item of Array.isArray(legacyData?.sessions) ? legacyData.sessions : []) {
                    if (!item?.sessionId) continue;
                    const owner = (item.agentName && agentByName.get(item.agentName)) || undefined;
                    pushSession({
                        sessionId: item.sessionId,
                        teamId: owner?.team?.id || item.teamId || '',
                        memberId: owner?.member?.id || item.memberId || '',
                        agentName: owner?.member?.name || item.agentName || '',
                        workspaceId: item.workspaceId || '',
                        createdAt: Number(item.createdAt) || 0,
                        archived: item.archived === true,
                    });
                }
            } catch { /* no legacy archive file */ }
            // Merge historical sessions stored under legacy "Agent · <name>" workspaces so zero casual chats are lost
            const wsReg = readWorkspaceRegistry();
            for (const ws of wsReg.workspaces) {
                const match = /^Agent\s*·\s*(.+)$/.exec(ws.title.trim());
                const owner = agentByWorkspace.get(ws.id) ?? (match ? agentByName.get(match[1].trim()) : undefined);
                if (!owner) continue;
                for (const sid of ws.sessionIds) {
                    pushSession({
                        sessionId: sid,
                        teamId: owner.team.id,
                        memberId: owner.member.id,
                        agentName: owner.member.name,
                        workspaceId: ws.id,
                        createdAt: 0,
                        archived: wsReg.archived.has(sid),
                    });
                }
            }
            sessions.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
            write(res, 200, { ok: true, sessions });
        }),
        exact('POST', '/marshal/agents/sessions/rename', async (req, res) => {
            if (!sessionTitles) { write(res, 503, { ok: false, code: 'titles-unavailable' }); return; }
            const body = await readBody(req);
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
            if (!sessionId) { write(res, 400, { ok: false, code: 'invalid-session' }); return; }
            const title = typeof body.title === 'string' ? body.title.trim() : '';
            const saved = sessionTitles.setCustom(sessionId, title);
            write(res, 200, { ok: true, sessionId, title: saved.custom ?? saved.auto ?? '', titleSource: saved.custom ? 'custom' : 'auto' });
        }),
        exact('POST', '/marshal/agents/agent-workspace', async (req, res) => {
            // Each resident agent owns ~/.dsh-marshal/agents/<name>. Make sure that
            // directory exists and is a Host Workspace, so the client can pin it on the
            // agent's squad and every new 1:1 session starts bound (no picker).
            const body = await readBody(req);
            const name = typeof body?.name === 'string' ? body.name.trim() : '';
            if (!name || name.length > 120) { write(res, 400, { ok: false, code: 'invalid-name' }); return; }
            const registry = workspaceRegistry;
            if (!registry || typeof registry.list !== 'function' || typeof registry.create !== 'function') {
                write(res, 200, { ok: true, workspaceId: null, reason: 'workspace-registry-unavailable' });
                return;
            }
            const path = agentWorkspacePath(name);
            try {
                mkdirSync(path, { recursive: true });
                const canonical = realpathSync(path);
                const known = (registry.list() ?? []).find(workspace => workspace?.path === canonical || workspace?.path === path);
                const workspace = known ?? await registry.create(path);
                write(res, 200, { ok: true, workspaceId: workspace?.id ?? workspace?.workspaceId ?? null, path: canonical, created: !known });
            } catch (error) {
                // The reason travels in the body; the client falls back to the picker.
                write(res, 200, { ok: true, workspaceId: null, reason: error instanceof Error ? error.message : String(error) });
            }
        }),
        exact('POST', '/marshal/agents/sessions/summarize', async (req, res) => {
            if (!sessionTitles) { write(res, 503, { ok: false, code: 'titles-unavailable' }); return; }
            const body = await readBody(req);
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
            if (!sessionId) { write(res, 400, { ok: false, code: 'invalid-session' }); return; }
            const pc = readProjcacheSession(sessionId);
            let sourceText = pc?.firstText || '';
            if (!sourceText && typeof sessionController?.follow === 'function') {
                try {
                    const it = sessionController.follow({ address: { kind: 'session', sessionId }, maxMessages: 8 }, AbortSignal.timeout(3000))[Symbol.asyncIterator]();
                    const snap = await it.next();
                    await it.return?.();
                    const records = Array.isArray(snap?.value?.records) ? snap.value.records : [];
                    for (const rec of records) {
                        const ev = rec?.event;
                        if (ev?.type === 'user/message') {
                            const content = ev?.data?.content ?? ev?.data?.message?.content;
                            if (typeof content === 'string' && content.trim()) { sourceText = content; break; }
                            if (Array.isArray(content)) {
                                const joined = content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join(' ').trim();
                                if (joined) { sourceText = joined; break; }
                            }
                        }
                    }
                } catch { /* fallback below */ }
            }
            let generated = '';
            if (sourceText && llm && typeof llm.prepareCall === 'function') {
                try {
                    const sel = typeof readDefaultModel === 'function' ? readDefaultModel() : undefined;
                    if (sel?.provider && sel?.model) {
                        const call = await llm.prepareCall({
                            provider: sel.provider,
                            model: sel.model,
                            system: '你是会话标题助手。根据用户首句需求，总结一个 8~18 字的简洁中文标题，只输出标题本身，不要引号、编号或解释。',
                            messages: [{ role: 'user', content: sourceText.slice(0, 1200) }],
                            maxTokens: 48,
                        }, AbortSignal.timeout(12000));
                        const text = typeof call?.text === 'string' ? call.text.trim() : '';
                        if (text) generated = text.replace(/^["'「『【]+|["'」』】]+$/g, '').replace(/\s+/g, ' ').slice(0, 40);
                    }
                } catch { /* fallback to deterministic summarizer */ }
            }
            if (!generated) generated = summarizeFirstMessage(sourceText || pc?.title || '');
            if (!generated) {
                write(res, 200, { ok: true, sessionId, title: pc?.title || '未命名会话', titleSource: 'fallback' });
                return;
            }
            sessionTitles.setAuto(sessionId, generated);
            if (body.clearCustom === true) sessionTitles.setCustom(sessionId, '');
            write(res, 200, { ok: true, sessionId, title: generated, titleSource: 'auto' });
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
            try { writeMutation(res, { ok: true, ...(await cross.create(await readBody(req))) }, 'groups.changed'); }
            catch (error) { write(res, 502, { ok: false, code: 'hub-unavailable', message: error instanceof Error ? error.message : String(error) }); }
        }),
        exact('POST', '/marshal/cross-groups/send', async (req, res) => {
            if (cross === undefined) { write(res, 503, { ok: false, code: 'cross-groups-unavailable' }); return; }
            try { writeMutation(res, { ok: true, ...(await cross.send(await readBody(req))) }, 'groups.changed'); }
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
            writeMutation(res, { ok: true, group: service.create(body) }, 'groups.changed');
        }),
        exact('POST', '/marshal/groups/update', async (req, res) => {
            const body = await readBody(req);
            writeMutation(res, { ok: true, group: service.update(body.id, body.patch ?? {}) }, 'groups.changed');
        }),
        exact('POST', '/marshal/groups/remove', async (req, res) => {
            const body = await readBody(req);
            writeMutation(res, { ok: true, removed: service.remove(body.id) }, 'groups.changed');
        }),
        exact('POST', '/marshal/groups/members', async (req, res) => {
            const body = await readBody(req);
            if (body.action === 'add') {
                writeMutation(res, { ok: true, group: service.addMember(body.id, body.member ?? {}) }, 'groups.changed', 'agents.changed');
                return;
            }
            if (body.action === 'remove') {
                writeMutation(res, { ok: true, group: service.removeMember(body.id, body.key) }, 'groups.changed', 'agents.changed');
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
            writeMutation(res, { ok: true, task: taskView(created) }, 'groups.changed', 'tasks.changed', 'incidents.changed');
        }),
    ];
}

/**
 * The stable directory a resident agent owns. The display name is sanitised and
 * bounded so it can never escape ~/.dsh-marshal/agents.
 */
export function agentWorkspacePath(name) {
    const safe = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^\.+/, '').trim().slice(0, 60) || 'agent';
    return join(homedir(), '.dsh-marshal', 'agents', safe);
}
const lookupWorkspaceRegistry = (ctx) => {
    try { return ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry; } catch { return undefined; }
};
export function mountGroups(ctx, config, options = {}) {
    const eventBus = options.eventBus ?? createMarshalEventBus();
    const eventStreams = new Set();
    const closeEventStreams = () => { for (const stop of eventStreams) stop(); };
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
        eventBus,
        prompt: ({ sessionId, text, requestId }) => ctx.sessionController.prompt({
            requestId,
            sessionId,
            content: [{ type: 'text', text }],
        }, promptAbort.signal),
        reader: createReplyReader(surface),
        logger: options.logger ?? ctx.logger,
    });
    const resolveWebOrigin = () => {
        try {
            if (typeof webServer?.getOrigin === 'function') {
                const origin = webServer.getOrigin();
                if (typeof origin === 'string' && origin !== '') return origin;
            }
        }
        catch { /* fall back to port */ }
        if (typeof webServer?.port === 'number') return 'http://127.0.0.1:' + webServer.port;
        return undefined;
    };
    const getAttachmentStore = () => {
        if (options.attachments !== undefined) return typeof options.attachments === 'function' ? options.attachments() : options.attachments;
        if (typeof ctx.get !== 'function') return undefined;
        try {
            const store = ctx.get('attachments');
            return store !== undefined && store !== null && typeof store.saveImage === 'function' ? store : undefined;
        }
        catch { return undefined; }
    };
    const taskOverrides = createTaskOverrides(join(root, 'task-overrides.json'));
    const attachmentCacheDir = join(root, 'ticket-attachments');
    const resolveTicketAttachments = async card => {
        const effCard = card?.id ? taskOverrides.applyTo(taskBoard === undefined ? 'local' : 'host', card) : card;
        const list = normalizeAttachmentsPayload(effCard?.attachments);
        if (!list || list.length === 0) return [];
        const store = getAttachmentStore();
        const resolved = [];
        for (const att of list) {
            const summary = {
                kind: att.kind,
                attachmentId: att.attachmentId,
                name: att.name,
                bytes: att.bytes,
                mediaType: att.mediaType,
                ...(att.kind === 'image' ? { width: att.width, height: att.height } : {}),
            };
            if (store) {
                try {
                    if (att.kind === 'file' && typeof store.fileHostPath === 'function') {
                        const filePath = store.fileHostPath({ attachmentId: att.attachmentId, name: att.name, bytes: att.bytes });
                        if (typeof filePath === 'string' && filePath !== '') summary.path = filePath;
                    }
                    else if (att.kind === 'image' && typeof store.readImage === 'function') {
                        await mkdir(attachmentCacheDir, { recursive: true });
                        const safeId = att.attachmentId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
                        const imagePath = join(attachmentCacheDir, safeId + '-' + att.name);
                        if (!existsSync(imagePath)) {
                            const stored = await store.readImage({
                                attachmentId: att.attachmentId, mediaType: att.mediaType, bytes: att.bytes,
                                width: att.width, height: att.height, name: att.name,
                            });
                            await writeFile(imagePath, Buffer.from(stored.data), { mode: 0o600 });
                        }
                        summary.path = imagePath;
                    }
                }
                catch { /* keep metadata even if file projection is unavailable */ }
            }
            resolved.push(summary);
        }
        return resolved;
    };
    const agents = createAgentsHttpClient({
        baseUrl: () => {
            const origin = resolveWebOrigin();
            if (origin) return origin;
            throw new Error('marshal: agents no-web-server');
        },
    });
    let rooms;
    try {
        rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'task-rooms.sqlite')),
            deviceId: config.deviceId, hub: crossClient?.taskRoom, eventBus });
    } catch { options.logger?.warn?.('marshal: local task room archive unavailable'); }
    const rosters = createWorkspaceRosters(join(root, 'workspace-rosters.json'));
    const ticketNumbers = createTicketNumbers(join(root, 'ticket-numbers.json'));
    const sessionTitles = createSessionTitles(join(root, 'session-titles.json'));
    const patchStore = createPatchStore(join(root, 'patches'));
    const boardSourceOf = () => taskBoard === undefined ? 'local' : 'host';
    // A workflow owns its card's execution, so it also owns the card's column.
    // Writing the column here keeps the desktop board, the mobile node and the
    // task tool in step instead of letting the view derive a status the ledger
    // never received.
    const moveCardStatus = async (source, taskId, status) => {
        if (source !== boardSourceOf()) return false;
        const board = getBoard();
        if (board === undefined) return false;
        let task;
        try { task = (board.snapshot().tasks ?? []).find(item => item.id === taskId); }
        catch { return false; }
        if (!task || task.status === status) return false;
        try {
            await board.apply(randomUUID(), { kind: 'move', taskId, status }, `marshal:${config.deviceId}`);
            eventBus.emit('tasks.changed');
            eventBus.emit('incidents.changed');
            return true;
        }
        catch (error) {
            options.logger?.warn?.('marshal: task board move to ' + status + ' refused: ' + (error instanceof Error ? error.message : String(error)));
            return false;
        }
    };
    let orchestration;
    try {
        orchestration = createTaskOrchestration({
            file: join(root, 'task-orchestration.json'), inventory: readAgentsLedger, memory: options.memory,
            port: createDiscussionPort({ agents: config.agents, llm, codexExecutable: config.codexExecutable, maxModels: 256, maxPerProvider: 64 }),
            defaultModel: readDefaultModel, logger: options.logger, workspacePath: agents.workspace,
            resolveAttachments: resolveTicketAttachments,
            patchStore, eventBus,
            readCard: (src, id) => {
                const raw = (getBoard()?.snapshot()?.tasks ?? []).find(item => item.id === id);
                return raw ? taskOverrides.applyTo(src, raw) : undefined;
            },
            leaderAutoReview: true,
            onState: moveCardStatus,
            onPermissionBlocked: async (_source, taskId) => {
                const board = getBoard();
                if (!board) return;
                await board.apply(randomUUID(), { kind: 'move', taskId, status: 'review' }, `marshal:${config.deviceId}`);
            },
            startLeader: async (leader, text, signal, slotOverride) => {
                const { sessionId } = await agents.chatMember(leader.teamId, leader.memberId, signal, 'ticket') ?? {};
                if (typeof sessionId !== 'string' || sessionId === '') throw new Error('Leader session unavailable');
                signal.throwIfAborted();
                const desiredModel = (typeof slotOverride?.model === 'string' && slotOverride.model.trim() !== '')
                    ? slotOverride.model.trim()
                    : (typeof leader?.model === 'string' && leader.model.trim() !== '' ? leader.model.trim() : '');
                const rawEffort = (typeof slotOverride?.reasoningEffort === 'string' && slotOverride.reasoningEffort.trim() !== '')
                    ? slotOverride.reasoningEffort.trim()
                    : (typeof leader?.reasoning === 'string' && leader.reasoning.trim() !== '' ? leader.reasoning.trim() : '');
                if (desiredModel && desiredModel.includes('/') && typeof ctx.sessionController?.selectModel === 'function') {
                    const slash = desiredModel.indexOf('/');
                    const provider = desiredModel.slice(0, slash);
                    const modelId = desiredModel.slice(slash + 1);
                    const effort = rawEffort && rawEffort !== 'off' && rawEffort !== 'none' ? rawEffort : undefined;
                    try {
                        await ctx.sessionController.selectModel({
                            sessionId, provider, model: modelId,
                            ...(effort ? { reasoningEffort: effort } : {}),
                        });
                    } catch {
                        if (effort) {
                            try { await ctx.sessionController.selectModel({ sessionId, provider, model: modelId }); } catch { /* ignore */ }
                        }
                    }
                }
                await ctx.sessionController.prompt({
                    requestId: randomUUID(), sessionId, content: [{ type: 'text', text }],
                }, signal);
                return sessionId;
            },
        });
    }
    catch { options.logger?.warn?.('marshal: task orchestration unavailable'); }
    const resolveDesktopOwnerId = async () => {
        const owner = await desktopOwner();
        if (typeof owner === 'string' && owner.trim() !== '') return owner.trim();
        if (typeof owner?.caller === 'string' && owner.caller.trim() !== '') return owner.caller.trim();
        if (typeof owner?.install === 'string' && owner.install.trim() !== '') return owner.install.trim();
        if (typeof config.deviceId === 'string' && config.deviceId.trim() !== '') return 'device:' + config.deviceId.trim();
        return 'local-owner';
    };
    let cachedDesktopOwnerId = typeof config.deviceId === 'string' && config.deviceId.trim() !== ''
        ? 'device:' + config.deviceId.trim()
        : 'local-owner';
    void resolveDesktopOwnerId().then(id => { if (id) cachedDesktopOwnerId = id; }).catch(() => {});
    const ensureRuntimeRoom = (source, taskId, card) => {
        if (!rooms) return undefined;
        const existing = rooms.find(source, taskId);
        if (existing) return existing;
        const wf = orchestration?.target(source, taskId);
        const wsId = wf?.workspaceId ?? card?.workspaceId;
        if (!wsId) return undefined;
        const resolvedCard = card ?? (getBoard()?.snapshot()?.tasks ?? []).find(item => item.id === taskId);
        if (!resolvedCard) return undefined;
        try {
            const tNo = ticketNumbers?.ensure?.(taskId);
            return rooms.ensure(
                source,
                tNo ? { ...resolvedCard, title: withTicketPrefix(tNo, resolvedCard.title) } : resolvedCard,
                wsId,
                cachedDesktopOwnerId,
            );
        } catch (error) {
            options.logger?.warn?.('marshal: runtime room ensure failed: ' + (error instanceof Error ? error.message : String(error)));
            return undefined;
        }
    };
    const runtime = options.runtime;
    if (runtime !== undefined && runtime !== null && typeof runtime === 'object') {
        Object.assign(runtime, {
            available: () => orchestration !== undefined && rooms !== undefined,
            source: boardSourceOf,
            target: taskId => orchestration?.target(boardSourceOf(), taskId),
            view(taskId) {
                const source = boardSourceOf();
                return orchestration?.target(source, taskId) === undefined ? undefined : orchestration.view(source, taskId);
            },
            async begin(taskId, runId, text) {
                const source = boardSourceOf();
                const ownerId = await resolveDesktopOwnerId().catch(() => cachedDesktopOwnerId);
                if (ownerId) cachedDesktopOwnerId = ownerId;
                const room = ensureRuntimeRoom(source, taskId);
                if (!room || room.closed) return undefined;
                try { return await rooms.begin(room.id, runId, 'Marshal', 'auto-dispatch', text); }
                catch { return undefined; }
            },
            async note(taskId, event) {
                const room = ensureRuntimeRoom(boardSourceOf(), taskId);
                if (!room || room.closed) return undefined;
                try { return await rooms.append(room.id, event); }
                catch (error) {
                    options.logger?.warn?.('marshal: task room message write failed: ' + (error instanceof Error ? error.message : String(error)));
                    return undefined;
                }
            },
            start(taskId, card, settings = {}) {
                const source = boardSourceOf();
                if (!orchestration) return { ok: false, code: 'orchestration-unavailable' };
                if (orchestration.target(source, taskId) === undefined) return { ok: false, code: 'no-workflow' };
                const room = ensureRuntimeRoom(source, taskId, card);
                const audit = room ? taskRoomAudit(rooms, room, settings.reason ?? 'auto-dispatch', undefined, undefined, () => true) : undefined;
                // A caller that already opened the room batch can skip opening another.
                if (audit && settings.skipBegin === true) audit.begin = async () => {};
                const started = orchestration.start(source, taskOverrides.applyTo(source, card), audit);
                return { ok: true, started, state: orchestration.view(source, taskId)?.state };
            },
            move: moveCardStatus,
            ticketNo: taskId => ticketNumbers?.ensure?.(taskId),
        });
    }
    const steerHostResidentSession = async (sessionId, text) => {
        if (!sessionId || !text || typeof ctx.sessionController?.prompt !== 'function') return false;
        try {
            await ctx.sessionController.prompt({
                requestId: 'marshal-steer-' + randomUUID(),
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text }],
            }, AbortSignal.timeout(10_000));
            return true;
        } catch {
            return false;
        }
    };
    const tasksController = createTaskToolController({
        getBoard,
        boardSource: boardSourceOf,
        initiator: `marshal:${config.deviceId}`,
        resolveOwnerId: resolveDesktopOwnerId,
        orchestration,
        rooms,
        patchStore,
        ticketNumbers,
        taskOverrides,
        workspacePath: agents.workspace,
        readInventory: readAgentsLedger,
        readWorkspaces: () => readWorkspaceRegistry().workspaces.map(w => ({ id: w.id, title: w.title, path: w.path })),
        surface,
        moveCardStatus,
        steerResidentSession: steerHostResidentSession,
    });
    const incidentReads = new Map();
    const executionTarget = card => {
        const execution = card?.executions?.at(-1);
        const sessionId = execution?.sessionId ?? (!execution ? card?.sessionId : undefined);
        return { execution, sessionId };
    };
    const collectPlainIncidents = async card => {
        const { execution, sessionId } = executionTarget(card);
        const room = card.taskRoom;
        const source = boardSourceOf();
        if (!surface?.history || !sessionId || card.archivedAt != null || room?.closed || card.status === 'done'
            || (card.workflow && card.workflow.state !== 'ready')) return [];
        const key = JSON.stringify([source, card.id, execution?.id, execution?.startedAt, sessionId, room?.runId]);
        if (!incidentReads.has(key)) {
            const collect = async () => {
                const signal = AbortSignal.any([promptAbort.signal, AbortSignal.timeout(3500)]);
                const { events } = await surface.history({ sessionId, limit: 80 }, signal);
                signal.throwIfAborted();
                const latest = getBoard()?.snapshot()?.tasks?.find(task => task.id === card.id);
                const current = executionTarget(latest);
                const currentRoom = rooms?.find(source, card.id);
                if (!latest || latest.archivedAt != null || latest.status === 'done' || currentRoom?.closed
                    || source !== boardSourceOf() || currentRoom?.runId !== room?.runId
                    || current.sessionId !== sessionId || current.execution?.id !== execution?.id
                    || current.execution?.startedAt !== execution?.startedAt) return [];
                const records = residentIncidentRecords(events ?? [], { sessionId, runId: room?.runId,
                    actor: extractAssignedAgentName(card), startedAt: execution?.startedAt, endedAt: current.execution?.endedAt });
                return records;
            };
            incidentReads.set(key, collect().catch(() => []).finally(() => incidentReads.delete(key)));
        }
        return incidentReads.get(key);
    };
    // Collect plain execution signals and settle handed-off turns even when no
    // browser tab is actively polling a room.
    let residentSyncRunning = false;
    const reconcileResidentSessions = () => {
        if (promptAbort.signal.aborted || residentSyncRunning || !rooms || !surface.history) return;
        const source = boardSourceOf();
        const activeHandedOff = orchestration?.handedOffTasks?.(source) ?? [];
        residentSyncRunning = true;
        void (async () => {
            try {
                for (const card of getBoard()?.snapshot()?.tasks ?? []) {
                    const room = rooms.find(source, card.id);
                    // Unbound legacy cards remain unbound; their history is read on demand.
                    if (!room || room.closed) continue;
                    const records = await collectPlainIncidents({ ...card, taskRoom: room, workflow: orchestration?.view(source, card.id) });
                    const current = rooms.find(source, card.id);
                    if (!promptAbort.signal.aborted && current?.runId === room.runId) await persistResidentIncidents(rooms, current, records);
                }
                for (const item of activeHandedOff) {
                    const room = rooms.find(item.source, item.taskId);
                    if (!room || room.closed) continue;
                    await syncResidentSessionToRoom({
                        surface,
                        rooms,
                        room,
                        sessionId: item.sessionId,
                        actor: item.leaderName || '执行智能体',
                        runId: room.runId ?? item.runId,
                        workflowState: 'handed-off',
                        onTurnCompleted: async (reason, lastText) => {
                            if (reason === 'completed') {
                                orchestration.syncStatus?.(item.source, item.taskId, 'review', {
                                    reviewReason: 'delivery-review',
                                    reviewSummary: String(lastText || '').slice(0, 500),
                                });
                                await moveCardStatus(item.source, item.taskId, 'review');
                            }
                        },
                    });
                }
            } catch { /* best-effort background sync */ }
            finally { residentSyncRunning = false; }
        })();
    };
    const residentSyncTimer = setInterval(reconcileResidentSessions, 15_000);
    residentSyncTimer.unref?.();
    queueMicrotask(reconcileResidentSessions);
    if (typeof ctx.effect === 'function') ctx.effect(() => () => {
        closeEventStreams();
        if (options.eventBus == null) eventBus.dispose();
        clearInterval(residentSyncTimer);
        orchestration?.dispose();
        rooms?.close();
        promptAbort.abort();
        service.dispose();
    }, 'marshal: groups prompt lifetime');
    ctx.inject(['tools'], (scoped) => {
        scoped.effect(() => {
            const disposers = agentToolDefinitions({ agents, service, tasks: tasksController })
                .map((definition) => scoped.tools.register(definition));
            return () => {
                for (const dispose of disposers) dispose();
            };
        }, 'marshal: agent tools');
    });
    ctx.inject(['taskBoard'], (scoped) => {
        scoped.effect(() => {
            const board = scoped.taskBoard;
            taskBoard = board;
            const unsubscribe = board?.subscribe?.(() => {
                eventBus.emit('tasks.changed', {});
                eventBus.emit('incidents.changed', {});
            });
            return () => {
                if (taskBoard === board) taskBoard = undefined;
                unsubscribe?.();
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
            }, orchestration, rooms, {
                root, rosters, ticketNumbers, sessionTitles, sessionController: ctx.sessionController,
                config, llm, readDefaultModel, workspacePath: agents.workspace,
                webOrigin: resolveWebOrigin, getAttachmentStore, resolveAttachments: resolveTicketAttachments,
                surface, moveCardStatus, taskOverrides, patchStore, eventBus, eventStreams, collectPlainIncidents,
                workspaceRegistry: lookupWorkspaceRegistry(ctx),
                getSpeechToText: () => { try { return ctx.get?.('speechToText') ?? ctx.speechToText; } catch { return undefined; } },
                getLlm: () => { try { return ctx.get?.('llm') ?? ctx.llm; } catch { return llm; } },
            }).map((route) => scoped.webServer.register(route));
            return () => {
                closeEventStreams();
                for (const dispose of disposers) dispose();
            };
        }, 'marshal: groups routes');
    });
    return service;
}
