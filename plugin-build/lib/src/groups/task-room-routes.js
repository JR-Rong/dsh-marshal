import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TaskRoomKey } from './task-room-store.js';
import { taskError } from './pr-material.js';
import { withTicketPrefix } from './ticket-numbers.js';

const remoteChoice = z.object({ deviceId: TaskRoomKey, modelId: TaskRoomKey }).strict();
const ROOM_ID = z.uuid();
const textBody = z.string().trim().min(1).refine(text => Buffer.byteLength(text) <= 16_384);

export function visibleTaskRoom(room, ticketNumbers) {
    if (!room) return undefined;
    const { ownerId: _owner, ...view } = room;
    const ticketNo = ticketNumbers?.get?.(view.taskId) ?? ticketNumbers?.ensure?.(view.taskId);
    return {
        ...view,
        ...(ticketNo ? { ticketNo, title: withTicketPrefix(ticketNo, view.title) } : {}),
    };
}

export function taskRoomAccess(access, room, allowed, ledger) {
    return room && access.ok && access.session.ownerId === room.ownerId && allowed(access, { workspaceId: room.workspaceId }, ledger);
}

export function taskRoomAudit(rooms, room, reason, leader, remoteTarget, allowMember) {
    return {
        actor: '工单操作者', reason, leader, remoteTarget, allowMember,
        begin: (runId, why, assignee) => rooms.begin(room.id, runId, 'Marshal', why ?? 'start',
            typeof assignee === 'string' ? '负责人 ' + assignee : '改派到 ' + assignee.deviceId + ' · ' + assignee.modelId),
        record: event => rooms.append(room.id, event),
        invokeRemote: (runId, target, text, phase) => rooms.remote(room.id, { runId, target, text, phase }),
    };
}

export function createTaskRoomRoutes({
    exact, write, readBody, authenticate, allowed, auth, rooms, orchestration, getBoard, boardSource, getInitiator, ticketNumbers,
}) {
    const viewRoom = room => visibleTaskRoom(room, ticketNumbers);
    const operations = new Set();
    const unavailable = () => taskError('task-rooms-unavailable', '工单群归档服务不可用。');
    const assertIdle = room => {
        if (operations.has(room.id)) throw taskError('task-room-busy', '群聊正在处理消息或状态变更。');
        orchestration?.assertIdle(room.source, room.taskId);
    };
    const workspaceCheck = (access, workspaceId, ledger) => {
        if (!access.ok || !allowed(access, { workspaceId }, ledger)) throw taskError('workspace-forbidden', '当前账号无权访问该工作区。');
        return workspaceId;
    };
    const hidden = () => taskError('task-room-not-found', '工单群不存在。');
    const route = (method, path, callback) => exact(method, '/marshal/task-rooms/' + path, async (req, res) => {
        if (!rooms) throw unavailable();
        const access = authenticate(req, method === 'POST');
        if (!access.ok) { write(res, access.status, { ok: false, code: access.code }); return; }
        const value = await callback(req, access);
        write(res, 200, { ok: true, ...value });
    });
    const readLocal = (id, access) => {
        const room = rooms.local(ROOM_ID.parse(id));
        if (!taskRoomAccess(access, room, allowed)) throw hidden();
        return room;
    };
    const getCard = (board, id) => {
        const card = board?.snapshot().tasks?.find(task => task.id === id);
        if (!card) throw taskError('task-not-found', '工单不存在。');
        return card;
    };
    const safeTarget = input => input === undefined ? undefined : remoteChoice.parse(input);
    const activeWorkflow = async (room, body, access, action) => {
        assertIdle(room);
        operations.add(room.id);
        try {
            if (boardSource() !== room.source) throw taskError('task-board-source', '请使用该工单所属的任务看板。');
            const card = getCard(getBoard(), room.taskId);
            let workflow = orchestration?.target(room.source, room.taskId);
            if (!orchestration) throw unavailable();
            const target = action === 'reassign' ? safeTarget(body.remote) : workflow?.remoteTarget;
            let leader;
            if (body.leaderId !== undefined) {
                leader = orchestration.prepare({ choice: 'none', leaderId: body.leaderId, workspaceId: room.workspaceId });
                if (leader.workspaceId !== room.workspaceId || !allowed(access, leader)) throw hidden();
            }
            if (!workflow && !leader) throw taskError('invalid-leader', '为这张工单指定工作区中的 Leader。');
            if (workflow && (workflow.workspaceId !== room.workspaceId || (!leader && !allowed(access, workflow)))) throw hidden();
            if (target) await rooms.promote(room.id, target);
            orchestration.assertIdle(room.source, room.taskId);
            if (!workflow) orchestration.attach(room.source, room.taskId, leader);
            orchestration.start(room.source, card, taskRoomAudit(rooms, room, action,
                leader ? { id: leader.leaderId, leaderName: leader.leaderName, agentId: leader.agentId, workspaceId: leader.workspaceId } : undefined,
                target, member => allowed(access, member)));
            return { room: viewRoom(rooms.local(room.id)) };
        }
        finally { operations.delete(room.id); }
    };
    const send = async (room, body, access) => {
        assertIdle(room);
        operations.add(room.id);
        try {
            const workflow = orchestration?.target(room.source, room.taskId);
            if (workflow && !allowed(access, workflow)) throw hidden();
            const target = safeTarget(body.remote) ?? workflow?.remoteTarget;
            const text = textBody.parse(body.text);
            let view = await rooms.page(room.id, { limit: 12 });
            if (view.room.closed) throw taskError('task-room-closed', '工单已归档，重开后可继续发言。');
            if (target) await rooms.promote(room.id, target);
            const runId = view.room.runId ?? randomUUID();
            if (!view.room.runId) await rooms.begin(room.id, runId, 'Marshal', 'conversation', '群聊开始');
            await rooms.append(room.id, { kind: 'user', runId, actor: '工单操作者', text });
            const messages = view.records.filter(record => record.kind === 'user' || record.kind === 'agent')
                .map(({ actor, text }) => ({ actor, text }));
            messages.push({ actor: '工单操作者', text });
            // Bound the context for this turn. The archive retains each full message.
            while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages)) > 44 * 1024) messages.shift();
            const context = JSON.stringify(messages);
            try {
                if (target) {
                    await rooms.remote(room.id, { runId, target, phase: 'conversation',
                        text: '在授权工作区的工单群里回复最新发言。以下是近期群消息。\n' + context });
                } else {
                    if (!orchestration) throw unavailable();
                    const result = await orchestration.respond(room.source, room.taskId, context, AbortSignal.timeout(125_000));
                    await rooms.append(room.id, { kind: 'agent', runId, ...result, phase: 'conversation' });
                }
            }
            catch (error) {
                if (!target) await rooms.append(room.id, { kind: 'status', runId, actor: 'Marshal',
                    text: 'Agent 未能完成本次回复。', phase: 'failed' });
                throw error;
            }
            view = await rooms.page(room.id, { limit: 12 });
            return { room: viewRoom(view.room) };
        }
        finally { operations.delete(room.id); }
    };
    const routes = [
        route('GET', 'workspaces', async (_req, access) => {
            const ledger = auth.loadLedger();
            const workspaces = new Map();
            const registered = typeof auth.loadWorkspaces === 'function' ? auth.loadWorkspaces() : [];
            for (const ws of registered) {
                if (!ws?.id) continue;
                const titleStr = String(ws.title || '').trim();
                const pathStr = String(ws.path || '').trim();
                if (/^Agent\s*·\s*/.test(titleStr) || /\/\.dsh-marshal\/agents\/Agent\s*·\s*/.test(pathStr)) continue;
                if (allowed(access, { workspaceId: ws.id }, ledger)) {
                    const label = ws.title || (ws.path ? String(ws.path).split('/').pop() : ws.id);
                    workspaces.set(ws.id, { id: ws.id, name: label, title: ws.title || label, path: ws.path || '' });
                }
            }
            for (const team of ledger.teams ?? []) {
                const id = team?.workspaceId;
                if (typeof id === 'string' && id && allowed(access, { workspaceId: id }, ledger)) {
                    if (!workspaces.has(id)) workspaces.set(id, { id, name: String(team.name || id) });
                }
            }
            return { workspaces: [...workspaces.values()] };
        }),
        route('GET', 'list', async (req, access) => {
            const workspaceId = workspaceCheck(access, TaskRoomKey.parse(new URL(req.url, 'http://localhost').searchParams.get('workspaceId')));
            const result = await rooms.list(workspaceId, access.session.ownerId);
            return { rooms: result.rooms.map(visibleTaskRoom), hubError: result.hubError, deviceId: getInitiator() };
        }),
        route('GET', 'page', async (req, access) => {
            const params = new URL(req.url, 'http://localhost').searchParams;
            const id = ROOM_ID.parse(params.get('roomId'));
            const workspaceId = workspaceCheck(access, TaskRoomKey.parse(params.get('workspaceId')));
            const local = rooms.local(id);
            if (local && (!taskRoomAccess(access, local, allowed) || local.workspaceId !== workspaceId)) throw hidden();
            const page = await rooms.page(id, {
                workspaceId,
                ...(params.has('before') ? { before: z.coerce.number().int().positive().parse(params.get('before')) } : {}),
                ...(params.has('after') ? { after: z.coerce.number().int().nonnegative().parse(params.get('after')) } : {}),
            });
            if (page.room.workspaceId !== workspaceId || !taskRoomAccess(access, page.room, allowed)) throw hidden();
            const origin = page.room.deviceId === getInitiator();
            const runState = origin ? orchestration?.view(page.room.source, page.room.taskId)?.state : undefined;
            return { ...page, room: viewRoom(page.room), origin, runState,
                busy: origin && (operations.has(id) || runState === 'running') };
        }),
        route('GET', 'peers', async (req, access) => {
            const id = new URL(req.url, 'http://localhost').searchParams.get('roomId');
            const room = readLocal(id, access);
            return { peers: await rooms.peers(room.workspaceId) };
        }),
        route('POST', 'open', async (req, access) => {
            const input = await readBody(req);
            const taskId = TaskRoomKey.parse(input.taskId);
            const source = boardSource();
            const card = getCard(getBoard(), taskId);
            const workflow = orchestration?.target(source, taskId);
            const existing = rooms.find(source, taskId);
            if (existing) {
                if (!taskRoomAccess(access, existing, allowed)) throw hidden();
                return { room: viewRoom(existing) };
            }
            if (!workflow && !card.workspaceId && !access.session.owner) throw hidden();
            const workspaceId = workspaceCheck(access, workflow?.workspaceId ?? card.workspaceId ?? TaskRoomKey.parse(input.workspaceId));
            const ticketNo = ticketNumbers?.ensure?.(card.id);
            const room = rooms.ensure(source, ticketNo ? { ...card, title: withTicketPrefix(ticketNo, card.title) } : card, workspaceId, access.session.ownerId);
            if (card.status === 'done' || workflow?.state === 'done') {
                await rooms.append(room.id, { kind: 'closed', actor: 'Marshal', text: '工单已归档。' });
            }
            return { room: viewRoom(rooms.local(room.id)) };
        }),
        route('POST', 'action', async (req, access) => {
            const body = await readBody(req);
            const room = readLocal(body.roomId, access);
            if (body.action === 'send') return send(room, body, access);
            if (body.action === 'retry' || body.action === 'reassign') return activeWorkflow(room, body, access, body.action);
            if (!['close', 'reopen'].includes(body.action)) throw taskError('invalid-task-room', '工单群操作无效。');
            assertIdle(room);
            operations.add(room.id);
            try {
                const current = (await rooms.page(room.id, { limit: 1 })).room;
                const closing = body.action === 'close';
                if (current.closed !== closing) {
                    await rooms.append(room.id, {
                        kind: closing ? 'closed' : 'reopened', runId: current.runId, actor: '工单操作者',
                        text: closing ? '工单已关闭。群聊记录已归档。' : '工单已重开。',
                    });
                }
                return { room: viewRoom((await rooms.page(room.id, { limit: 1 })).room) };
            }
            finally { operations.delete(room.id); }
        }),
    ];
    return { routes, assertIdle };
}
