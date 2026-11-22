import { randomUUID } from 'node:crypto';
import { taskError } from './pr-material.js';
import { applyDevelopmentPatch } from './task-development.js';
import { isPermissionBlockedError } from './task-orchestration.js';
import { GROUP_TEMPLATES, ROLE_LABELS, TEMPLATES } from './task-plans.js';
import { findLatestPatch, parseRoomMentions, readOperatorNotes, taskRoomAudit, visibleTaskRoom } from './task-room-routes.js';
import { syncResidentSessionToRoom } from './session-room-sync.js';
import { stripAgentTrace } from './agent-trace.js';
import { withTicketPrefix } from './ticket-numbers.js';

function normalizeTags(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const out = [];
    for (const item of raw) {
        const name = typeof item === 'string' ? item.trim() : (typeof item?.name === 'string' ? item.name.trim() : '');
        if (!name || out.some(t => t.name === name)) continue;
        out.push({ name: name.slice(0, 32) });
        if (out.length >= 8) break;
    }
    return out.length > 0 ? out : undefined;
}

function extractAgentTag(card) {
    for (const tag of Array.isArray(card?.tags) ? card.tags : []) {
        const name = typeof tag?.name === 'string' ? tag.name.trim() : '';
        if (name.startsWith('智能体:') && name.length > 4) return name.slice(4).trim();
        if (name.startsWith('@') && name.length > 1) return name.slice(1).trim();
    }
    return undefined;
}

function latestExecSessionId(card) {
    if (!Array.isArray(card?.executions)) return undefined;
    for (let i = card.executions.length - 1; i >= 0; i -= 1) {
        const sid = card.executions[i]?.sessionId;
        if (typeof sid === 'string' && sid !== '') return sid;
    }
    return undefined;
}

export function createTaskToolController({
    getBoard,
    boardSource,
    initiator,
    ownerId,
    resolveOwnerId,
    orchestration,
    rooms,
    patchStore,
    ticketNumbers,
    taskOverrides,
    workspacePath,
    readInventory,
    readWorkspaces,
    surface,
    moveCardStatus,
    steerResidentSession,
}) {
    const getOwnerId = async () => {
        if (typeof ownerId === 'string' && ownerId) return ownerId;
        if (typeof resolveOwnerId === 'function') return await resolveOwnerId();
        return 'local-owner';
    };
    const requireBoard = () => {
        const board = getBoard?.();
        if (!board) throw taskError('no-task-board', '当前任务看板不可用。');
        return board;
    };
    const effective = (source, raw) => (raw && taskOverrides ? taskOverrides.applyTo(source, raw) : raw);
    const findCard = (board, source, taskId) => {
        if (typeof taskId !== 'string' || !taskId.trim()) throw taskError('invalid-task', '需要有效的 taskId。');
        const raw = (board.snapshot().tasks ?? []).find(item => item.id === taskId.trim());
        if (!raw) throw taskError('task-not-found', '未找到对应工单：' + taskId);
        return { raw, card: effective(source, raw) };
    };
    const summarizeTask = (source, raw) => {
        const card = effective(source, raw);
        const ticketNo = ticketNumbers?.ensure?.(card.id);
        const wf = orchestration?.target(source, card.id) ? orchestration.view(source, card.id) : undefined;
        const room = rooms?.find(source, card.id);
        const patchAvailable = Boolean(wf?.development?.digest && !wf.development.appliedAt);
        return {
            id: card.id,
            ...(ticketNo ? { ticketNo } : {}),
            title: card.title,
            description: card.description,
            status: card.status,
            ...(card.workspaceId ? { workspaceId: card.workspaceId } : {}),
            ...(card.permission ? { permission: card.permission } : {}),
            ...(card.permissionConfirmedAt ? { permissionConfirmedAt: card.permissionConfirmedAt } : {}),
            ...(card.parentId ? { parentId: card.parentId } : {}),
            ...(Array.isArray(card.tags) && card.tags.length > 0 ? { tags: card.tags.map(t => t.name) } : {}),
            ...(room ? { roomId: room.id, roomClosed: room.closed } : {}),
            ...(wf ? { orchestration: wf } : {}),
            patchAvailable,
            createdAt: card.createdAt,
            updatedAt: card.updatedAt,
        };
    };
    const resolveRoom = async (source, args, { createIfMissing = false } = {}) => {
        if (!rooms) throw taskError('task-rooms-unavailable', '工单群归档服务不可用。');
        if (typeof args?.roomId === 'string' && args.roomId.trim()) {
            const local = rooms.local(args.roomId.trim());
            if (!local) throw taskError('task-room-not-found', '工单群不存在。');
            return local;
        }
        if (typeof args?.taskId === 'string' && args.taskId.trim()) {
            const existing = rooms.find(source, args.taskId.trim());
            if (existing) return existing;
            if (createIfMissing) {
                const board = requireBoard();
                const { card } = findCard(board, source, args.taskId);
                const wf = orchestration?.target(source, card.id);
                const wsId = wf?.workspaceId ?? card.workspaceId;
                if (!wsId) throw taskError('invalid-workspace', '该工单未绑定工作区，无法创建工单群。');
                const tNo = ticketNumbers?.ensure?.(card.id);
                return rooms.ensure(source, tNo ? { ...card, title: withTicketPrefix(tNo, card.title) } : card, wsId, await getOwnerId());
            }
        }
        throw taskError('task-room-not-found', '未找到工单对应的工单群（请传入 taskId 或 roomId）。');
    };

    return {
        async catalog() {
            const ledger = typeof readInventory === 'function' ? readInventory() : { teams: [] };
            const agents = [];
            for (const team of ledger?.teams ?? []) {
                const name = typeof team?.name === 'string' ? team.name : '';
                const global = name === '智能体库' || name.startsWith('marshal-agent:') || !team?.workspaceId;
                for (const m of team?.members ?? []) {
                    agents.push({
                        id: team.id + '/' + m.id,
                        teamId: team.id,
                        memberId: m.id,
                        name: m.name,
                        permission: m.permission,
                        model: m.model,
                        reasoningEffort: m.reasoningEffort,
                        global,
                        ...(team.workspaceId ? { workspaceId: team.workspaceId } : {}),
                    });
                }
            }
            const workspaces = typeof readWorkspaces === 'function' ? (await readWorkspaces()) : [];
            const board = getBoard?.();
            const snap = board?.snapshot?.();
            return {
                templates: TEMPLATES,
                groupTemplates: GROUP_TEMPLATES,
                roleLabels: ROLE_LABELS,
                ...(snap?.sessionDefaultPermission ? { sessionDefaultPermission: snap.sessionDefaultPermission } : {}),
                workspaces,
                agents,
            };
        },
        async list(args = {}) {
            const board = requireBoard();
            const source = boardSource();
            const snap = board.snapshot();
            let tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
            if (args.includeArchived !== true) tasks = tasks.filter(t => t.archivedAt === undefined);
            if (typeof args.status === 'string' && args.status) tasks = tasks.filter(t => t.status === args.status);
            if (typeof args.query === 'string' && args.query.trim()) {
                const q = args.query.trim().toLowerCase();
                tasks = tasks.filter(t => {
                    const eff = effective(source, t);
                    const haystack = [eff.title, eff.description, eff.prompt, ...(eff.tags ?? []).map(x => x.name)].filter(Boolean).join('\n').toLowerCase();
                    return haystack.includes(q);
                });
            }
            return {
                source,
                ...(snap.sessionDefaultPermission ? { sessionDefaultPermission: snap.sessionDefaultPermission } : {}),
                count: tasks.length,
                tasks: tasks.map(t => summarizeTask(source, t)),
            };
        },
        async get(args = {}) {
            const board = requireBoard();
            const source = boardSource();
            const { raw } = findCard(board, source, args.taskId);
            const task = summarizeTask(source, raw);
            const room = rooms?.find(source, raw.id);
            const report = orchestration?.target(source, raw.id) ? await orchestration.report(source, raw.id) : undefined;
            return {
                task,
                ...(room ? { room: visibleTaskRoom(room, ticketNumbers) } : {}),
                ...(report ? { report } : {}),
            };
        },
        async create(args = {}) {
            const board = requireBoard();
            const source = boardSource();
            const title = typeof args.title === 'string' ? args.title.trim() : '';
            if (!title) throw taskError('invalid-title', '工单标题不能为空。');
            const description = typeof args.description === 'string' ? args.description.trim() : '';
            const prompt = typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt.trim() : (description || title);
            let tags = normalizeTags(args.tags);
            const parentId = typeof args.parentId === 'string' && args.parentId.trim() ? args.parentId.trim() : undefined;
            const requestedWs = typeof args.workspaceId === 'string' && args.workspaceId.trim() ? args.workspaceId.trim() : undefined;
            const explicitPerm = ['read-only', 'workspace-write', 'danger-full-access'].includes(args.permission) ? args.permission : undefined;
            const permission = explicitPerm ?? ((requestedWs || args.orchestration) ? 'workspace-write' : undefined);
            let prepared;
            if (args.orchestration !== undefined) {
                if (!orchestration) throw taskError('orchestration-unavailable', '编排服务不可用。');
                prepared = orchestration.prepare({
                    ...args.orchestration,
                    ...(requestedWs ? { workspaceId: requestedWs } : {}),
                }, () => true);
                if (prepared.leaderName) {
                    const hasTag = Array.isArray(tags) && tags.some(t => t.name.startsWith('智能体:') || t.name.startsWith('@'));
                    if (!hasTag) {
                        const leaderTag = { name: ('智能体:' + prepared.leaderName).slice(0, 32) };
                        tags = Array.isArray(tags) ? [...tags, leaderTag].slice(0, 8) : [leaderTag];
                    }
                }
            }
            const workspaceId = prepared?.workspaceId ?? requestedWs;
            if (prepared && requestedWs && prepared.workspaceId !== requestedWs) {
                throw taskError('workspace-conflict', '编排工作区与指定工作区不一致。');
            }
            const id = randomUUID();
            const beforeIds = new Set((board.snapshot().tasks ?? []).map(t => t.id));
            let preAttached = false;
            if (prepared) {
                orchestration.attach(source, id, prepared);
                preAttached = true;
            }
            let snapshot;
            try {
                snapshot = await board.apply(randomUUID(), {
                    kind: 'create',
                    id,
                    input: {
                        title,
                        description,
                        prompt,
                        ...(workspaceId ? { workspaceId } : {}),
                        ...(tags ? { tags } : {}),
                        ...(parentId ? { parentId } : {}),
                        ...(permission ? { permission } : {}),
                    },
                }, initiator);
            } catch (err) {
                if (preAttached) {
                    try { orchestration.remove(source, id); } catch { /* ignore */ }
                }
                throw err;
            }
            const added = (snapshot.tasks ?? []).filter(t => !beforeIds.has(t.id));
            const created = (snapshot.tasks ?? []).find(t => t.id === id) ?? (added.length === 1 ? added[0] : undefined);
            if (!created) {
                if (preAttached) {
                    try { orchestration.remove(source, id); } catch { /* ignore */ }
                }
                throw taskError('task-create-not-observed', '未能观察到新建工单写入看板。');
            }
            if (prepared && created.id !== id) {
                try { orchestration.remove(source, id); } catch { /* ignore */ }
                orchestration.attach(source, created.id, prepared);
            }
            let room;
            if (rooms && workspaceId) {
                const tNo = ticketNumbers?.ensure?.(created.id);
                room = rooms.ensure(source, tNo ? { ...created, title: withTicketPrefix(tNo, created.title) } : created, workspaceId, await getOwnerId());
            }
            return {
                task: summarizeTask(source, created),
                ...(room ? { roomId: room.id } : {}),
            };
        },
        async plan(args = {}) {
            if (!orchestration) throw taskError('orchestration-unavailable', '编排服务不可用。');
            const board = requireBoard();
            const source = boardSource();
            const { raw, card } = findCard(board, source, args.taskId);
            const wf = orchestration.target(source, card.id);
            const orch = args.orchestration;
            if (!orch || typeof orch !== 'object') throw taskError('invalid-task-plan', '需要提供 orchestration 配置对象。');
            let configured;
            if (orch.choice !== undefined) {
                const prepared = orchestration.prepare({
                    ...orch,
                    workspaceId: args.workspaceId ?? orch.workspaceId ?? wf?.workspaceId ?? card.workspaceId,
                }, () => true);
                configured = orchestration.configure(source, card.id, prepared);
            } else {
                configured = orchestration.updateAgentConfigs(source, card.id, {
                    ...orch,
                    ...(args.workspaceId || card.workspaceId ? { workspaceId: args.workspaceId ?? wf?.workspaceId ?? card.workspaceId } : {}),
                }, () => true);
            }
            const notice = configured?._notice || '';
            const room = rooms?.find(source, card.id);
            if (notice && room && !room.closed) {
                try {
                    const current = (await rooms.page(room.id, { limit: 1 })).room;
                    await rooms.append(room.id, { kind: 'status', ...(current.runId ? { runId: current.runId } : {}), actor: 'Marshal', phase: 'config-change', text: notice });
                } catch { /* best-effort */ }
            }
            return { task: summarizeTask(source, raw), ...(notice ? { notice } : {}) };
        },
        async run(args = {}) {
            const board = requireBoard();
            const source = boardSource();
            const { raw, card } = findCard(board, source, args.taskId);
            const wf = orchestration?.target(source, card.id);
            if (wf) {
                const room = await resolveRoom(source, { taskId: card.id }, { createIfMissing: true });
                orchestration.assertIdle(source, card.id);
                const current = (await rooms.page(room.id, { limit: 1 })).room;
                if (current.closed) {
                    await rooms.append(room.id, { kind: 'reopened', runId: current.runId, actor: '工单操作者', text: '工单重新运行，自动重开工单群。' });
                }
                const reason = (wf.state === 'done' || wf.state === 'review-blocked' || wf.state === 'failed') ? 'retry' : 'start';
                orchestration.start(source, card, taskRoomAudit(rooms, room, reason, undefined, undefined, () => true));
                return {
                    task: summarizeTask(source, raw),
                    roomId: room.id,
                    state: orchestration.view(source, card.id)?.state,
                };
            }
            try {
                const snap = await board.apply(randomUUID(), { kind: 'run', taskId: card.id }, initiator);
                const updated = (snap.tasks ?? []).find(t => t.id === card.id) ?? raw;
                return { task: summarizeTask(source, updated) };
            } catch (error) {
                if (isPermissionBlockedError(error)) {
                    let movedToReview = false;
                    try {
                        await board.apply(randomUUID(), { kind: 'move', taskId: card.id, status: 'review' }, initiator);
                        movedToReview = true;
                    } catch { /* keep status if refused */ }
                    return {
                        permissionBlocked: true,
                        movedToReview,
                        message: '权限受阻：' + (error instanceof Error ? error.message : String(error)) + '，需要人工在看板确认权限。',
                    };
                }
                throw error;
            }
        },
        async roomRead(args = {}) {
            const source = boardSource();
            const room = await resolveRoom(source, args, { createIfMissing: true });
            const limit = Math.max(1, Math.min(100, Number(args.limit) || 40));
            const cursorArgs = {
                limit,
                ...(Number.isSafeInteger(args.after) && args.after >= 0 ? { after: args.after } : {}),
                ...(Number.isSafeInteger(args.before) && args.before > 0 ? { before: args.before } : {}),
            };
            let page = await rooms.page(room.id, cursorArgs);
            let wfView = orchestration?.target(room.source, room.taskId) ? orchestration.view(room.source, room.taskId) : undefined;
            const board = getBoard?.();
            const rawCard = board?.snapshot?.()?.tasks?.find(t => t.id === room.taskId);
            const card = rawCard ? effective(room.source, rawCard) : undefined;
            const liveBubbles = [...(orchestration?.live?.(room.source, room.taskId) ?? [])];
            const residentSessionId = wfView?.sessionId || (!wfView ? (card?.sessionId || latestExecSessionId(card)) : undefined);
            if (residentSessionId && surface && !page.room.closed) {
                const prevSeq = page.room.lastSeq;
                const residentLive = await syncResidentSessionToRoom({
                    surface,
                    rooms,
                    room: page.room,
                    sessionId: residentSessionId,
                    actor: wfView?.leaderName || extractAgentTag(card) || '执行智能体',
                    runId: page.room.runId ?? wfView?.runId,
                    workflowState: wfView?.state,
                    onTurnCompleted: async (reason, lastText) => {
                        if (reason === 'completed') {
                            orchestration?.syncStatus?.(room.source, room.taskId, 'review', {
                                reviewReason: 'delivery-review',
                                reviewSummary: String(lastText || '').slice(0, 500),
                            });
                            await moveCardStatus?.(room.source, room.taskId, 'review');
                        }
                    },
                });
                if (residentLive) liveBubbles.push(residentLive);
                const refreshed = rooms.local(room.id);
                if (refreshed && refreshed.lastSeq > prevSeq) {
                    page = await rooms.page(room.id, cursorArgs);
                }
                wfView = orchestration?.target(room.source, room.taskId) ? orchestration.view(room.source, room.taskId) : undefined;
            }
            const patchAvailable = Boolean(!wfView?.development?.appliedAt && (
                wfView?.development?.digest
                || (page.records ?? []).some(r => r.phase === 'development-patch')
            ));
            return {
                room: visibleTaskRoom(page.room, ticketNumbers),
                records: page.records,
                hasMore: page.hasMore,
                liveBubbles,
                ...(wfView ? { workflow: wfView } : {}),
                patchAvailable,
            };
        },
        async roomSend(args = {}) {
            const source = boardSource();
            const text = typeof args.text === 'string' ? args.text.trim() : '';
            if (!text) throw taskError('invalid-text', '发言内容不能为空。');
            const room = await resolveRoom(source, args, { createIfMissing: true });
            let view = await rooms.page(room.id, { limit: 24 });
            if (view.room.closed) {
                if (args.autoReopen !== true) throw taskError('task-room-closed', '工单已归档，请传入 autoReopen: true 或先重开。');
                await rooms.append(room.id, { kind: 'reopened', runId: view.room.runId, actor: '工单操作者', text: '工单因新发言自动重开讨论。' });
                view = await rooms.page(room.id, { limit: 24 });
            }
            const runId = view.room.runId ?? randomUUID();
            if (!view.room.runId) await rooms.begin(room.id, runId, 'Marshal', 'conversation', '群聊开始');
            const wfView = orchestration?.target(room.source, room.taskId) ? orchestration.view(room.source, room.taskId) : undefined;
            const isRunning = wfView?.state === 'running';
            await rooms.append(room.id, { kind: 'user', runId, actor: '工单操作者', text, ...(isRunning ? { phase: 'steering' } : {}) });
            const board = getBoard?.();
            const rawCard = board?.snapshot?.()?.tasks?.find(t => t.id === room.taskId);
            const card = rawCard ? effective(room.source, rawCard) : undefined;
            const mentions = parseRoomMentions(text);
            const mentionAll = mentions.some(m => m.toLowerCase() === 'all' || m === '所有人' || m === '全体');
            const residentSessionId = wfView?.sessionId || (!wfView ? (card?.sessionId || latestExecSessionId(card)) : undefined);
            const residentOwnerName = wfView?.leaderName || extractAgentTag(card) || '执行智能体';
            const targetsResident = Boolean(
                residentSessionId
                && typeof steerResidentSession === 'function'
                && !mentionAll
                && (mentions.length === 0 || mentions.every(m => m === residentOwnerName))
            );
            if (targetsResident) {
                const steered = await steerResidentSession(residentSessionId, '【工单群内机主最新消息，请直接使用你的工具执行并回复结果】\n' + text);
                if (steered) {
                    await rooms.append(room.id, {
                        kind: 'status', runId, actor: 'Marshal', phase: 'steering',
                        text: '已将您的消息转发至「' + residentOwnerName + '」的常驻会话（具备工具执行能力），执行结果将自动同步回本工单群。',
                    });
                    return { room: visibleTaskRoom(rooms.local(room.id), ticketNumbers), steeredResident: true };
                }
            }
            if (!orchestration) throw taskError('orchestration-unavailable', '编排服务不可用。');
            const messages = view.records
                .filter(r => r.kind === 'user' || r.kind === 'agent' || r.kind === 'status')
                .map(r => ({
                    actor: r.actor,
                    kind: r.kind,
                    ...(r.phase ? { phase: r.phase } : {}),
                    text: r.phase === 'development-patch' ? '[固定开发补丁 SHA-256: ' + (r.ref ?? 'unknown') + ']' : stripAgentTrace(r.text),
                }));
            messages.push({ actor: '工单操作者', kind: 'user', text });
            while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages)) > 40 * 1024) messages.shift();
            const context = JSON.stringify({
                ticket: {
                    title: card?.title ?? room.title,
                    ...(card?.description ? { description: String(card.description).slice(0, 3000) } : {}),
                    status: card?.status,
                    ...(wfView ? { workflowState: wfView.state, workflowPhase: wfView.phase } : {}),
                },
                messages,
            });
            const result = await orchestration.respond(room.source, room.taskId, context, AbortSignal.timeout(125_000), {
                mentions,
                workspaceId: room.workspaceId,
                fallbackAgentName: extractAgentTag(card),
                allowMember: () => true,
            });
            const replies = Array.isArray(result.replies) && result.replies.length > 0 ? result.replies : [{ actor: result.actor, text: result.text }];
            for (const reply of replies) {
                await rooms.append(room.id, { kind: 'agent', runId, actor: reply.actor, text: reply.text, phase: 'conversation' });
            }
            return {
                room: visibleTaskRoom(rooms.local(room.id), ticketNumbers),
                steeredResident: false,
                replies: replies.map(r => ({ actor: r.actor, text: stripAgentTrace(r.text) })),
            };
        },
        async patch(args = {}) {
            const source = boardSource();
            const room = await resolveRoom(source, args);
            const wf = orchestration?.target(room.source, room.taskId);
            const found = await findLatestPatch(rooms, room.id, args.digest ?? wf?.development?.digest, patchStore, args.seq);
            if (!found) throw taskError('development-no-changes', '当前工单群中没有可读取的开发补丁。');
            const maxChars = Math.max(1000, Math.min(200_000, Number(args.maxChars) || 32_000));
            const truncated = found.text.length > maxChars;
            return {
                digest: found.digest,
                seq: found.seq,
                ...(found.meta ? {
                    bytes: found.meta.bytes,
                    fileCount: found.meta.fileCount,
                    files: found.meta.files,
                    additions: found.meta.additions,
                    deletions: found.meta.deletions,
                } : {}),
                truncated,
                patch: truncated ? found.text.slice(0, maxChars) + '\n…（已按 maxChars 截断）' : found.text,
            };
        },
        async revise(args = {}) {
            const board = requireBoard();
            const source = boardSource();
            const room = await resolveRoom(source, args, { createIfMissing: true });
            const { raw, card } = findCard(board, source, args.taskId ?? room.taskId);
            const feedbackText = typeof args.text === 'string' ? args.text.trim() : '';
            let current = (await rooms.page(room.id, { limit: 1 })).room;
            if (current.closed) {
                await rooms.append(room.id, { kind: 'reopened', runId: current.runId, actor: '工单操作者', text: '工单已重开，准备按最新讨论意见继续执行。' });
                current = (await rooms.page(room.id, { limit: 1 })).room;
            }
            if (feedbackText) {
                const runId = current.runId ?? randomUUID();
                if (!current.runId) await rooms.begin(room.id, runId, 'Marshal', 'conversation', '补充修正意见');
                await rooms.append(room.id, { kind: 'user', runId, actor: '工单操作者', text: feedbackText, phase: 'revision' });
            }
            const wf = orchestration?.target(source, card.id);
            if (wf) {
                orchestration.cancel?.(source, card.id);
                let seedPatch;
                if (!wf.development?.appliedAt) {
                    try {
                        const prev = await findLatestPatch(rooms, room.id, wf.development?.digest, patchStore);
                        if (prev?.text) seedPatch = prev.text;
                    } catch { /* fallback to fresh HEAD */ }
                }
                const audit = taskRoomAudit(rooms, room, 'revise', undefined, wf.remoteTarget, () => true);
                if (seedPatch) audit.seedPatch = seedPatch;
                orchestration.start(source, card, audit);
                if (card.status !== 'running') {
                    try { await board.apply(randomUUID(), { kind: 'move', taskId: card.id, status: 'running' }, initiator); } catch { /* ignore */ }
                }
                return {
                    task: summarizeTask(source, (board.snapshot().tasks ?? []).find(t => t.id === card.id) ?? raw),
                    roomId: room.id,
                    seededPreviousPatch: Boolean(seedPatch),
                };
            }
            const notes = await readOperatorNotes(rooms, room.id);
            if (notes && taskOverrides) {
                const basePrompt = String(card.prompt || card.description || card.title || '').replace(/\n\n【机主补充修正意见】[\s\S]*$/, '');
                taskOverrides.set(source, card.id, { prompt: (basePrompt + '\n\n【机主补充修正意见】\n' + notes).slice(0, 15_000) });
            }
            await rooms.begin(room.id, randomUUID(), 'Marshal', 'revise', '按群内修正意见重新启动工单执行');
            const snap = await board.apply(randomUUID(), { kind: 'run', taskId: card.id }, initiator);
            return {
                task: summarizeTask(source, (snap.tasks ?? []).find(t => t.id === card.id) ?? raw),
                roomId: room.id,
                seededPreviousPatch: false,
            };
        },
        async confirm(args = {}) {
            const board = requireBoard();
            const source = boardSource();
            const room = rooms?.find(source, args.taskId) ?? (args.roomId ? await resolveRoom(source, args) : undefined);
            const taskId = args.taskId ?? room?.taskId;
            const { raw, card } = findCard(board, source, taskId);
            const wf = orchestration?.target(source, card.id);
            orchestration?.assertIdle(source, card.id);
            let patchApplied = false;
            let patchAlreadyApplied = false;
            let committed = false;
            let commitHash;
            if (args.applyPatch === true) {
                if (!room) throw taskError('development-no-changes', '未找到绑定工单群中的开发补丁。');
                if (typeof workspacePath !== 'function') throw taskError('development-workspace-unavailable', '工作区路径解析服务不可用。');
                const patch = await findLatestPatch(rooms, room.id, wf?.development?.digest, patchStore);
                if (!patch) throw taskError('development-no-changes', '当前工单群中没有可应用的开发补丁。');
                const wsDir = await workspacePath(wf?.workspaceId ?? room.workspaceId, AbortSignal.timeout(10_000));
                const commitMessage = typeof args.commitMessage === 'string' && args.commitMessage.trim() ? args.commitMessage.trim() : undefined;
                const applied = await applyDevelopmentPatch(wsDir, patch.text, AbortSignal.timeout(30_000), { commitMessage });
                patchApplied = applied.applied === true;
                patchAlreadyApplied = applied.alreadyApplied === true;
                committed = applied.committed === true;
                commitHash = applied.commitHash;
                orchestration?.markPatchApplied?.(source, card.id, Date.now());
                const latestRoom = (await rooms.page(room.id, { limit: 1 })).room;
                if (!latestRoom.closed) {
                    const commitNote = committed && commitHash ? '，并已自动提交（' + commitHash + '）' : (committed ? '，并已自动提交' : '');
                    await rooms.append(room.id, {
                        kind: 'status', runId: latestRoom.runId, actor: 'Marshal', phase: 'confirmed',
                        text: (patchAlreadyApplied ? '检查确认：本批次隔离开发补丁此前已在工作区生效' : '已将本批次隔离开发补丁应用到工作区目录') + commitNote + '。',
                    });
                }
            }
            const note = typeof args.note === 'string' ? args.note.trim() : '';
            if (room) {
                let current = (await rooms.page(room.id, { limit: 1 })).room;
                if (note && !current.closed) {
                    await rooms.append(room.id, { kind: 'user', runId: current.runId, actor: '工单操作者', text: note, phase: 'confirm' });
                    current = (await rooms.page(room.id, { limit: 1 })).room;
                }
                if (!current.closed) {
                    await rooms.append(room.id, {
                        kind: 'closed', runId: current.runId, actor: '工单操作者', phase: 'confirmed',
                        text: args.applyPatch === true ? '已确认验收通过（补丁已落盘），工单归档完成。' : '已确认验收通过，工单归档完成。',
                    });
                }
            }
            let snap = board.snapshot();
            if (card.status !== 'done') {
                snap = await board.apply(randomUUID(), { kind: 'move', taskId: card.id, status: 'done' }, initiator);
            }
            orchestration?.syncStatus?.(source, card.id, 'done');
            const updated = (snap.tasks ?? []).find(t => t.id === card.id) ?? raw;
            return {
                task: summarizeTask(source, updated),
                patchApplied,
                patchAlreadyApplied,
                ...(committed ? { committed: true, commitHash } : {}),
                ...(room ? { room: visibleTaskRoom(rooms.local(room.id), ticketNumbers) } : {}),
            };
        },
    };
}
