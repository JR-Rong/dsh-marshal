import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TaskRoomKey } from './task-room-store.js';
import { taskError } from './pr-material.js';
import { stripAgentTrace } from './agent-trace.js';
import { syncResidentSessionToRoom } from './session-room-sync.js';
import { withTicketPrefix } from './ticket-numbers.js';
import { applyDevelopmentPatch } from './task-development.js';
import { parsePatchArtifactHeader, resolvePatchText, summarizePatch } from './patch-store.js';

const remoteChoice = z.object({ deviceId: TaskRoomKey, modelId: TaskRoomKey }).strict();
const ROOM_ID = z.uuid();
const textBody = z.string().trim().min(1).refine(text => Buffer.byteLength(text) <= 16_384);

function extractAgentTag(card) {
    for (const tag of Array.isArray(card?.tags) ? card.tags : []) {
        const name = typeof tag?.name === 'string' ? tag.name.trim() : '';
        if (name.startsWith('智能体:') && name.length > 4) return name.slice(4).trim();
        if (name.startsWith('@') && name.length > 1) return name.slice(1).trim();
    }
    return undefined;
}

export function parseRoomMentions(text) {
    const out = [];
    const re = /@([^\s@,，。！!？?：:;；()（）\[\]【】]{1,32})/g;
    let match;
    while ((match = re.exec(String(text ?? ''))) !== null) {
        const name = match[1].trim();
        if (name && !out.includes(name)) out.push(name);
    }
    return out;
}

export async function readOperatorNotes(rooms, roomId) {
    if (!rooms || !roomId) return '';
    try {
        const page = await rooms.page(roomId, { limit: 80 });
        const items = (page.records ?? []).filter(r => r.kind === 'user' && r.phase !== 'brief');
        if (items.length === 0) return '';
        return items.slice(-12).map(r => '- [' + new Date(r.at).toISOString() + '] ' + r.text.trim()).join('\n').slice(-6000);
    } catch {
        return '';
    }
}

export async function findLatestPatch(rooms, roomId, expectedDigest, patchStore, expectedSeq) {
    const page = await rooms.page(roomId, { limit: 100 });
    const patches = (page.records ?? []).filter(r => r.phase === 'development-patch' && typeof r.text === 'string' && r.text.trim() !== '');
    if (patches.length === 0) return undefined;
    let chosen;
    if (Number.isSafeInteger(expectedSeq) && expectedSeq > 0) {
        chosen = patches.find(r => r.seq === expectedSeq);
    }
    if (!chosen && expectedDigest) {
        chosen = [...patches].reverse().find(r => {
            if (r.ref === expectedDigest) return true;
            const parsed = parsePatchArtifactHeader(r.text);
            return parsed?.meta?.digest === expectedDigest;
        });
    }
    if (!chosen) chosen = patches.at(-1);
    const resolved = resolvePatchText(chosen.text, chosen.ref, patchStore);
    return {
        text: resolved.text,
        digest: resolved.digest,
        meta: resolved.meta ?? summarizePatch(resolved.text),
        seq: chosen.seq,
    };
}

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
    const runLabels = { start: '负责人 ', retry: '重试 · 负责人 ', reassign: '改派 · 负责人 ', revise: '按群内意见修正 · 负责人 ', 'auto-dispatch': '自动派单 · 负责人 ' };
    const prefix = runLabels[reason] ?? '负责人 ';
    return {
        actor: '工单操作者', reason, leader, remoteTarget, allowMember,
        begin: (runId, why, assignee) => rooms.begin(room.id, runId, 'Marshal', why ?? 'start',
            typeof assignee === 'string' ? prefix + assignee : '改派到 ' + assignee.deviceId + ' · ' + assignee.modelId),
        record: event => rooms.append(room.id, event),
        invokeRemote: (runId, target, text, phase) => rooms.remote(room.id, { runId, target, text, phase }),
        operatorNotes: () => readOperatorNotes(rooms, room.id),
    };
}

export function createTaskRoomRoutes({
    exact, write, readBody, authenticate, allowed, auth, rooms, orchestration, getBoard, boardSource, getInitiator,
    ticketNumbers, workspacePath, normalizeAttachments, resolveAttachments, surface, moveCardStatus,
    getEffectiveCard, saveCardPromptOverride, launchPlainCardWithOverrides, patchStore, steerResidentSession,
}) {
    const viewRoom = room => visibleTaskRoom(room, ticketNumbers);
    const operations = new Set();
    const chatOperations = new Set();
    const unavailable = () => taskError('task-rooms-unavailable', '工单群归档服务不可用。');
    const assertIdle = room => {
        if (operations.has(room.id)) throw taskError('task-room-busy', '群聊正在处理状态变更。');
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
        const raw = board?.snapshot().tasks?.find(task => task.id === id);
        if (!raw) throw taskError('task-not-found', '工单不存在。');
        return typeof getEffectiveCard === 'function' ? getEffectiveCard(boardSource(), raw) : raw;
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
        if (chatOperations.has(room.id)) throw taskError('task-room-busy', '正在等待上一条消息回复，请稍候。');
        chatOperations.add(room.id);
        try {
            const workflow = orchestration?.target(room.source, room.taskId);
            if (workflow && !allowed(access, workflow)) throw hidden();
            const target = safeTarget(body.remote) ?? workflow?.remoteTarget;
            const text = textBody.parse(body.text);
            let view = await rooms.page(room.id, { limit: 24 });
            if (view.room.closed) {
                if (body.autoReopen !== true) {
                    throw taskError('task-room-closed', '工单已归档，重开后可继续发言。');
                }
                await rooms.append(room.id, {
                    kind: 'reopened', runId: view.room.runId, actor: '工单操作者',
                    text: '工单因新发言自动重开讨论。',
                });
                const b = getBoard();
                const rawC = b?.snapshot().tasks?.find(t => t.id === room.taskId);
                if (b && rawC && rawC.status === 'done') {
                    try { await b.apply(randomUUID(), { kind: 'move', taskId: room.taskId, status: 'review' }, 'marshal:' + getInitiator()); } catch {}
                }
                view = await rooms.page(room.id, { limit: 24 });
            }
            if (target) await rooms.promote(room.id, target);
            const runId = view.room.runId ?? randomUUID();
            if (!view.room.runId) await rooms.begin(room.id, runId, 'Marshal', 'conversation', '群聊开始');
            const workflowView = orchestration?.view(room.source, room.taskId);
            const isRunning = workflowView?.state === 'running';
            await rooms.append(room.id, {
                kind: 'user', runId, actor: '工单操作者', text,
                ...(isRunning ? { phase: 'steering' } : {}),
            });
            const board = getBoard();
            const rawCard = board?.snapshot().tasks?.find(task => task.id === room.taskId);
            const card = rawCard && typeof getEffectiveCard === 'function' ? getEffectiveCard(room.source, rawCard) : rawCard;
            const mentions = parseRoomMentions(text);
            const mentionAll = mentions.some(m => m.toLowerCase() === 'all' || m === '所有人' || m === '全体');
            const cardExecSessionId = Array.isArray(card?.executions)
                ? [...card.executions].reverse().find(ex => typeof ex?.sessionId === 'string' && ex.sessionId !== '')?.sessionId
                : undefined;
            const residentSessionId = workflowView?.sessionId || (!workflowView ? (card?.sessionId || cardExecSessionId) : undefined);
            const residentOwnerName = workflowView?.leaderName || extractAgentTag(card) || '执行智能体';
            const targetsResident = Boolean(
                !target
                && residentSessionId
                && typeof steerResidentSession === 'function'
                && !mentionAll
                && (mentions.length === 0 || mentions.every(m => m === residentOwnerName))
            );
            if (targetsResident) {
                const steerText = '【工单群内机主最新消息，请直接使用你的工具执行并回复结果】\n' + text;
                const steered = await steerResidentSession(residentSessionId, steerText);
                if (steered) {
                    await rooms.append(room.id, {
                        kind: 'status', runId, actor: 'Marshal', phase: 'steering',
                        text: '已将您的消息转发至「' + residentOwnerName + '」的常驻会话（具备工具执行能力），执行结果将自动同步回本工单群。',
                    });
                    view = await rooms.page(room.id, { limit: 12 });
                    return { room: viewRoom(view.room), steeredResident: true };
                }
                await rooms.append(room.id, {
                    kind: 'status', runId, actor: 'Marshal', phase: 'conversation',
                    text: '提示：常驻会话当前无法接收消息，已切换为工单群文本讨论回复。',
                });
            }
            const messages = view.records
                .filter(record => record.kind === 'user' || record.kind === 'agent' || record.kind === 'status')
                .map(record => ({
                    actor: record.actor,
                    kind: record.kind,
                    ...(record.phase ? { phase: record.phase } : {}),
                    text: record.phase === 'development-patch'
                        ? '[固定开发补丁 SHA-256: ' + (record.ref ?? 'unknown') + '，共 ' + record.text.length + ' 字符]'
                        : stripAgentTrace(record.text),
                }));
            messages.push({ actor: '工单操作者', kind: 'user', text });
            while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages)) > 40 * 1024) messages.shift();
            const resolvedAttachments = Array.isArray(card?.attachments) && card.attachments.length > 0
                ? (typeof resolveAttachments === 'function'
                    ? await resolveAttachments(card)
                    : (typeof normalizeAttachments === 'function' ? (normalizeAttachments(card.attachments) ?? []) : card.attachments))
                : [];
            const contextPayload = {
                ticket: {
                    title: card?.title ?? room.title,
                    ...(card?.description ? { description: String(card.description).slice(0, 3000) } : {}),
                    status: card?.status,
                    ...(resolvedAttachments.length > 0 ? { attachments: resolvedAttachments } : {}),
                    ...(workflowView ? { workflowState: workflowView.state, workflowPhase: workflowView.phase, reviewSummary: workflowView.reviewSummary } : {}),
                },
                messages,
            };
            const context = JSON.stringify(contextPayload);
            try {
                if (target) {
                    await rooms.remote(room.id, { runId, target, phase: 'conversation',
                        text: '在授权工作区的工单群里回复最新发言。以下是工单背景与近期群消息。\n' + context });
                } else {
                    if (!orchestration) throw unavailable();
                    const result = await orchestration.respond(room.source, room.taskId, context, AbortSignal.timeout(125_000), {
                        leaderId: body.leaderId,
                        mentions,
                        workspaceId: room.workspaceId,
                        fallbackAgentName: extractAgentTag(card),
                        allowMember: member => allowed(access, member),
                    });
                    const replies = Array.isArray(result.replies) && result.replies.length > 0 ? result.replies : [{ actor: result.actor, text: result.text }];
                    for (const reply of replies) {
                        await rooms.append(room.id, { kind: 'agent', runId, actor: reply.actor, text: reply.text, phase: 'conversation' });
                    }
                }
            }
            catch (error) {
                if (!target) await rooms.append(room.id, { kind: 'status', runId, actor: 'Marshal',
                    text: 'Agent 未能完成本次回复（您的发言已记录在群内，后续编排仍会读取）。', phase: 'failed' });
                throw error;
            }
            view = await rooms.page(room.id, { limit: 12 });
            return { room: viewRoom(view.room) };
        }
        finally { chatOperations.delete(room.id); }
    };

    const confirmReview = async ({ room, card, body, access, initiatorTag }) => {
        const source = room?.source ?? boardSource();
        if (room) assertIdle(room);
        else orchestration?.assertIdle(source, card.id);
        if (room) operations.add(room.id);
        try {
            const workflow = orchestration?.target(source, card.id);
            let patchApplied = false;
            let patchAlreadyApplied = false;
            let committed = false;
            let commitHash;
            if (body?.applyPatch === true) {
                if (!room) throw taskError('development-no-changes', '未找到绑定工单群中的开发补丁。');
                if (typeof workspacePath !== 'function') throw taskError('development-workspace-unavailable', '工作区路径解析服务不可用。');
                const patch = await findLatestPatch(rooms, room.id, workflow?.development?.digest, patchStore);
                if (!patch) throw taskError('development-no-changes', '当前工单群中没有可应用的开发补丁。');
                const wsDir = await workspacePath(workflow?.workspaceId ?? room.workspaceId, AbortSignal.timeout(10_000));
                const commitMessage = typeof body?.commitMessage === 'string' && body.commitMessage.trim() !== '' ? body.commitMessage.trim() : undefined;
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
            const note = typeof body?.note === 'string' ? body.note.trim() : '';
            if (room) {
                let current = (await rooms.page(room.id, { limit: 1 })).room;
                if (note && !current.closed) {
                    await rooms.append(room.id, { kind: 'user', runId: current.runId, actor: '工单操作者', text: textBody.parse(note), phase: 'confirm' });
                    current = (await rooms.page(room.id, { limit: 1 })).room;
                }
                if (!current.closed) {
                    await rooms.append(room.id, {
                        kind: 'closed', runId: current.runId, actor: '工单操作者', phase: 'confirmed',
                        text: body?.applyPatch === true ? '已确认验收通过（补丁已落盘），工单归档完成。' : '已确认验收通过，工单归档完成。',
                    });
                }
            }
            const board = getBoard();
            let snapshot = board?.snapshot();
            if (board && card.status !== 'done') {
                snapshot = await board.apply(randomUUID(), { kind: 'move', taskId: card.id, status: 'done' }, initiatorTag ?? ('marshal:' + getInitiator()));
            }
            orchestration?.syncStatus?.(source, card.id, 'done');
            return {
                snapshot,
                patchApplied,
                patchAlreadyApplied,
                ...(committed ? { committed: true, commitHash } : {}),
                room: room ? viewRoom((await rooms.page(room.id, { limit: 1 })).room) : undefined,
            };
        }
        finally {
            if (room) operations.delete(room.id);
        }
    };

    const reviseTask = async ({ room: initialRoom, card, body, access, initiatorTag }) => {
        const source = initialRoom?.source ?? boardSource();
        const workflow = orchestration?.target(source, card.id);
        let room = initialRoom;
        if (!room && rooms && (workflow?.workspaceId || card.workspaceId)) {
            const wsId = workflow?.workspaceId ?? card.workspaceId;
            if (allowed(access, { workspaceId: wsId })) {
                const ticketNo = ticketNumbers?.ensure?.(card.id);
                room = rooms.ensure(source, ticketNo ? { ...card, title: withTicketPrefix(ticketNo, card.title) } : card, wsId, access.session.ownerId);
            }
        }
        if (room && operations.has(room.id)) throw taskError('task-room-busy', '群聊正在处理状态变更。');
        if (room) operations.add(room.id);
        try {
            const feedbackText = typeof body?.text === 'string' && body.text.trim() !== '' ? textBody.parse(body.text) : '';
            if (room) {
                let current = (await rooms.page(room.id, { limit: 1 })).room;
                if (current.closed) {
                    await rooms.append(room.id, {
                        kind: 'reopened', runId: current.runId, actor: '工单操作者',
                        text: '工单已重开，准备按最新讨论意见继续执行。',
                    });
                    current = (await rooms.page(room.id, { limit: 1 })).room;
                }
                if (feedbackText) {
                    const runId = current.runId ?? randomUUID();
                    if (!current.runId) await rooms.begin(room.id, runId, 'Marshal', 'conversation', '补充修正意见');
                    await rooms.append(room.id, { kind: 'user', runId, actor: '工单操作者', text: feedbackText, phase: 'revision' });
                }
            }
            const board = getBoard();
            let snapshot = board?.snapshot();
            if (workflow) {
                if (!orchestration) throw unavailable();
                orchestration.cancel?.(source, card.id);
                let seedPatch;
                if (room && !workflow.development?.appliedAt) {
                    try {
                        const prevPatch = await findLatestPatch(rooms, room.id, workflow.development?.digest, patchStore);
                        if (prevPatch?.text) seedPatch = prevPatch.text;
                    } catch { /* fallback to fresh HEAD if prior patch unavailable */ }
                }
                const audit = room ? taskRoomAudit(rooms, room, 'revise', undefined, workflow.remoteTarget, member => allowed(access, member)) : undefined;
                if (audit && seedPatch) audit.seedPatch = seedPatch;
                orchestration.start(source, card, audit);
                if (board && card.status !== 'running') {
                    try {
                        snapshot = await board.apply(randomUUID(), { kind: 'move', taskId: card.id, status: 'running' }, initiatorTag ?? ('marshal:' + getInitiator()));
                    } catch { snapshot = board.snapshot(); }
                }
            } else if (board) {
                const notes = room ? await readOperatorNotes(rooms, room.id) : (feedbackText ? '- ' + feedbackText : '');
                let nextPrompt;
                if (notes) {
                    const basePrompt = String(card.prompt || card.description || card.title || '').replace(/\n\n【机主补充修正意见】[\s\S]*$/, '');
                    nextPrompt = (basePrompt + '\n\n【机主补充修正意见】\n' + notes).slice(0, 15_000);
                    if (typeof saveCardPromptOverride === 'function') {
                        snapshot = await saveCardPromptOverride(source, card, nextPrompt, initiatorTag ?? ('marshal:' + getInitiator()));
                    } else {
                        snapshot = await board.apply(randomUUID(), { kind: 'update', taskId: card.id, patch: { prompt: nextPrompt } }, initiatorTag ?? ('marshal:' + getInitiator()));
                    }
                }
                if (room) {
                    await rooms.begin(room.id, randomUUID(), 'Marshal', 'revise', '按群内修正意见重新启动工单执行');
                }
                if (typeof launchPlainCardWithOverrides === 'function') {
                    snapshot = await launchPlainCardWithOverrides(source, card.id, initiatorTag ?? ('marshal:' + getInitiator()), nextPrompt);
                } else {
                    snapshot = await board.apply(randomUUID(), { kind: 'run', taskId: card.id }, initiatorTag ?? ('marshal:' + getInitiator()));
                }
            }
            return {
                snapshot,
                room: room ? viewRoom((await rooms.page(room.id, { limit: 1 })).room) : undefined,
            };
        }
        finally {
            if (room) operations.delete(room.id);
        }
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
            const cursorArgs = {
                workspaceId,
                ...(params.has('before') ? { before: z.coerce.number().int().positive().parse(params.get('before')) } : {}),
                ...(params.has('after') ? { after: z.coerce.number().int().nonnegative().parse(params.get('after')) } : {}),
            };
            let page = await rooms.page(id, cursorArgs);
            if (page.room.workspaceId !== workspaceId || !taskRoomAccess(access, page.room, allowed)) throw hidden();
            const origin = page.room.deviceId === getInitiator();
            let workflowView = origin ? orchestration?.view(page.room.source, page.room.taskId) : undefined;
            const rawCard = origin ? getBoard()?.snapshot().tasks?.find(task => task.id === page.room.taskId) : undefined;
            const card = rawCard && typeof getEffectiveCard === 'function' ? getEffectiveCard(page.room.source, rawCard) : rawCard;
            const liveBubbles = origin ? [...(orchestration?.live?.(page.room.source, page.room.taskId) ?? [])] : [];
            const cardExecSessionId = Array.isArray(card?.executions)
                ? [...card.executions].reverse().find(ex => typeof ex?.sessionId === 'string' && ex.sessionId !== '')?.sessionId
                : undefined;
            const residentSessionId = origin
                ? (workflowView?.sessionId || (!workflowView ? (card?.sessionId || cardExecSessionId) : undefined))
                : undefined;
            if (residentSessionId && surface && !page.room.closed) {
                const prevSeq = page.room.lastSeq;
                const residentLive = await syncResidentSessionToRoom({
                    surface,
                    rooms,
                    room: page.room,
                    sessionId: residentSessionId,
                    actor: workflowView?.leaderName || extractAgentTag(card) || '执行智能体',
                    runId: page.room.runId ?? workflowView?.runId,
                    workflowState: workflowView?.state,
                    onTurnCompleted: async (reason, lastText) => {
                        if (reason === 'completed') {
                            orchestration?.syncStatus?.(page.room.source, page.room.taskId, 'review', {
                                reviewReason: 'delivery-review',
                                reviewSummary: String(lastText || '').slice(0, 500),
                            });
                            await moveCardStatus?.(page.room.source, page.room.taskId, 'review');
                        }
                    },
                });
                if (residentLive) liveBubbles.push(residentLive);
                const refreshedRoom = rooms.local(id);
                if (refreshedRoom && refreshedRoom.lastSeq > prevSeq) {
                    page = await rooms.page(id, cursorArgs);
                }
                workflowView = origin ? orchestration?.view(page.room.source, page.room.taskId) : undefined;
            }
            const runState = workflowView?.state;
            const cardStatus = page.room.closed ? 'done'
                : !workflowView || workflowView.state === 'ready' ? (card?.status ?? 'todo')
                : workflowView.state === 'running' || workflowView.state === 'handed-off' ? 'running'
                : workflowView.state === 'permission-blocked' || workflowView.state === 'review-blocked' ? 'review'
                : workflowView.state === 'done' ? (card?.status === 'done' ? 'done' : 'review') : 'failed';
            const patchAvailable = Boolean(origin && !workflowView?.development?.appliedAt && (
                workflowView?.development?.digest
                || (page.records ?? []).some(r => r.phase === 'development-patch')
            ));
            const participants = origin
                ? (orchestration?.participants?.(page.room.source, page.room.taskId, page.room.workspaceId, extractAgentTag(card), member => allowed(access, member)) ?? [])
                : [];
            const cardAttachments = origin && Array.isArray(card?.attachments)
                ? ((typeof normalizeAttachments === 'function' ? normalizeAttachments(card.attachments) : card.attachments) ?? [])
                : [];
            return {
                ...page, room: viewRoom(page.room), origin, runState,
                busy: origin && (operations.has(id) || runState === 'running'),
                chatBusy: origin && chatOperations.has(id),
                cardStatus,
                taskId: page.room.taskId,
                attachments: cardAttachments,
                ...(workflowView ? { workflow: workflowView } : {}),
                patchAvailable,
                participants,
                liveBubbles,
            };
        }),
        route('GET', 'patch', async (req, access) => {
            const url = new URL(req.url, 'http://localhost');
            const id = url.searchParams.get('roomId');
            const digest = url.searchParams.get('digest') || undefined;
            const seqRaw = url.searchParams.get('seq');
            const seq = seqRaw ? Number(seqRaw) : undefined;
            const room = readLocal(id, access);
            const workflow = orchestration?.target(room.source, room.taskId);
            const found = await findLatestPatch(rooms, room.id, digest ?? workflow?.development?.digest, patchStore, Number.isSafeInteger(seq) ? seq : undefined);
            if (!found) throw taskError('development-no-changes', '当前工单群中没有可读取的开发补丁。');
            return {
                patch: found.text,
                digest: found.digest,
                seq: found.seq,
                ...(found.meta ? {
                    bytes: found.meta.bytes,
                    fileCount: found.meta.fileCount,
                    files: found.meta.files,
                    additions: found.meta.additions,
                    deletions: found.meta.deletions,
                } : {}),
            };
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
            if (card.status === 'done') {
                await rooms.append(room.id, { kind: 'closed', actor: 'Marshal', text: '工单已归档。' });
            }
            return { room: viewRoom(rooms.local(room.id)) };
        }),
        route('POST', 'action', async (req, access) => {
            const body = await readBody(req);
            const room = readLocal(body.roomId, access);
            if (body.action === 'send') return send(room, body, access);
            if (body.action === 'confirm') {
                const card = getCard(getBoard(), room.taskId);
                return confirmReview({ room, card, body, access });
            }
            if (body.action === 'revise') {
                const card = getCard(getBoard(), room.taskId);
                return reviseTask({ room, card, body, access });
            }
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
                const board = getBoard();
                if (board) {
                    const card = board.snapshot().tasks?.find(task => task.id === room.taskId);
                    if (closing && card && card.status !== 'done') {
                        try { await board.apply(randomUUID(), { kind: 'move', taskId: card.id, status: 'done' }, 'marshal:' + getInitiator()); } catch {}
                    } else if (!closing && card && card.status === 'done') {
                        try { await board.apply(randomUUID(), { kind: 'move', taskId: card.id, status: 'review' }, 'marshal:' + getInitiator()); } catch {}
                    }
                }
                return { room: viewRoom((await rooms.page(room.id, { limit: 1 })).room) };
            }
            finally { operations.delete(room.id); }
        }),
    ];
    return {
        routes,
        assertIdle,
        confirmReview,
        reviseTask,
        sendMessage: send,
        findPatch: (roomId, expectedDigest, expectedSeq) => findLatestPatch(rooms, roomId, expectedDigest, patchStore, expectedSeq),
    };
}
