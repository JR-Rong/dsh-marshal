import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DISCUSSION_INPUT_BYTES, DISCUSSION_TURN_MS } from '../discussions/types.js';
import { TaskRoomBinding, TaskRoomEvent, TaskRoomKey, TaskRoomRecord } from '../groups/task-room-store.js';
import { taskError } from '../groups/pr-material.js';

const roomId = z.uuid();
const cursor = z.number().int().nonnegative().optional();
const target = z.object({ deviceId: TaskRoomKey, modelId: TaskRoomKey }).strict();
const schema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('catalog'), workspaceId: TaskRoomKey }).strict(),
    z.object({ action: z.literal('list'), workspaceId: TaskRoomKey }).strict(),
    z.object({ action: z.literal('prepare'), binding: TaskRoomBinding, remoteDeviceId: TaskRoomKey }).strict(),
    z.object({ action: z.literal('import'), roomId, records: z.array(TaskRoomRecord).min(1).max(32) }).strict(),
    z.object({ action: z.literal('commit'), roomId, lastSeq: z.number().int().nonnegative() }).strict(),
    z.object({ action: z.literal('page'), roomId, workspaceId: TaskRoomKey, after: cursor, before: cursor, limit: z.number().int().optional() }).strict(),
    z.object({ action: z.literal('append'), roomId, event: TaskRoomEvent }).strict(),
    z.object({ action: z.literal('turn'), roomId, runId: z.uuid(), turnId: z.uuid(), target,
        phase: z.string().max(64), text: z.string().min(1).refine(value => Buffer.byteLength(value) <= DISCUSSION_INPUT_BYTES) }).strict(),
]);

/** Hub archive and read-only calls use the verified device enrollment and workspace inventory. */
export function createHubTaskRooms({ store, registry, deviceStore, inventories, relay, now = Date.now }) {
    const catalogs = new Map();
    const pending = new Map();
    const active = id => {
        const device = deviceStore.findById(id);
        const connection = registry.get(id);
        const inventory = inventories.get(id);
        if (!device || device.revoked || device.role === 'phone' || !device.ownerId ||
            !connection?.connectionId || inventory?.connectionId !== connection.connectionId ||
            inventory?.nodeEpoch !== connection.nodeEpoch || inventory?.policyRevision !== device.policyRevision) return undefined;
        return { device, inventory, connection };
    };
    const belongs = (info, workspaceId, ownerId) => info?.device.ownerId === ownerId &&
        info.inventory.squads.some(squad => squad.workspaceId === workspaceId);
    const current = (deviceId, workspaceId, ownerId) => {
        const info = active(deviceId);
        if (!belongs(info, workspaceId, ownerId)) throw taskError('workspace-forbidden', '该设备没有此工作区权限。');
        return info;
    };
    const modelsFor = info => {
        const catalog = catalogs.get(info.device.id);
        return info.device.allowDiscussion && catalog?.connectionId === info.connection.connectionId &&
            catalog?.nodeEpoch === info.connection.nodeEpoch ? catalog.models : [];
    };
    const remote = (deviceId, room, modelId) => {
        if (deviceId === room.deviceId) throw taskError('invalid-remote-device', '请选择工作区中的另一台设备。');
        const info = current(deviceId, room.workspaceId, room.ownerId);
        const model = modelsFor(info).find(item => modelId === undefined || item.id === modelId);
        if (!model) throw taskError('task-room-peer-unavailable', '远端设备当前没有授权的讨论模型。');
        return { ...info, model };
    };
    const authorize = (device, room, origin = false) => {
        if (!room || room.ownerId !== device.ownerId || (origin && room.deviceId !== device.id)) {
            throw taskError('task-room-not-found', '工单群不存在。');
        }
        current(device.id, room.workspaceId, room.ownerId);
        return room;
    };
    const finish = (job, state, text) => {
        if (pending.get(job.turnId) !== job) return;
        pending.delete(job.turnId);
        clearTimeout(job.timer);
        try {
            const record = store.append(job.room.id, {
                id: job.turnId, kind: state === 'completed' ? 'agent' : 'status', runId: job.runId,
                actor: job.actor, text, at: now(), phase: job.phase,
                requestId: job.turnId, deviceId: job.deviceId,
            });
            if (state === 'completed') job.resolve(record);
            else job.reject(taskError('task-room-peer-failed', text));
        }
        catch (error) { job.reject(error); }
    };
    const turn = (room, input) => {
        if (room.closed || room.runId !== input.runId) throw taskError('task-room-run-conflict', '当前批次不可派发。');
        const { device, connection, model } = remote(input.target.deviceId, room, input.target.modelId);
        const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const existing = store.event(room.id, input.turnId);
        const started = store.event(room.id, 'turn:' + input.turnId);
        if (started && started.ref !== digest) throw taskError('task-room-conflict', '远端调用内容已变化。');
        if (existing?.kind === 'agent') return existing;
        const inFlight = pending.get(input.turnId);
        if (inFlight?.room.id === room.id && inFlight.digest === digest) return inFlight.promise;
        if (started || inFlight) throw taskError('task-room-peer-unknown', '上一笔远端调用的结果需要核对。');
        store.append(room.id, {
            id: 'turn:' + input.turnId, kind: 'status', runId: input.runId, actor: 'Marshal',
            text: '已登记远端调用', phase: input.phase, at: now(),
            deviceId: device.id, requestId: input.turnId, ref: digest,
        });
        const actor = (model.agent === 'dsh' ? 'DSH' : 'Codex') + ' · ' + model.model;
        const expiresAt = now() + DISCUSSION_TURN_MS;
        const promiseState = Promise.withResolvers();
        const job = { ...promiseState, digest, room, actor, turnId: input.turnId, runId: input.runId, phase: input.phase,
            memberId: input.turnId, deviceId: device.id, connectionId: connection.connectionId,
            nodeEpoch: connection.nodeEpoch, policyRevision: device.policyRevision };
        pending.set(job.turnId, job);
        job.timer = setTimeout(() => finish(job, 'unknown', '远端调用超时，结果待核对。'), DISCUSSION_TURN_MS + 2_000);
        job.timer.unref?.();
        // Existing discussion calls are isolated and returned with an authenticated room/member/turn triple.
        void Promise.resolve().then(() => relay.command({
            op: 'discussion.turn', target: { deviceId: device.id, agent: model.agent, sessionId: room.id },
            args: { roomId: room.id, memberId: job.memberId, turnId: job.turnId, modelId: model.id, text: input.text,
                expiresAt, policyRevision: device.policyRevision, taskWorkspaceId: room.workspaceId },
            idempotencyKey: 'task-room:' + job.turnId,
        })).then(result => {
            if (!result?.ok) finish(job, 'failed', result?.status === 'unknown' ? '远端调用结果待核对。' : '远端设备拒绝了此调用。');
        }, () => finish(job, 'unknown', '远端调用结果待核对。'));
        return job.promise;
    };
    return {
        async handle(device, body) {
            const input = schema.parse(body);
            if (!device?.ownerId) throw taskError('workspace-forbidden', '节点未绑定工作区所属账号。');
            if (input.action === 'catalog' || input.action === 'list') {
                current(device.id, input.workspaceId, device.ownerId);
                if (input.action === 'list') {
                    return { rooms: store.list(device.ownerId, input.workspaceId).filter(room => room.storage === 'hub') };
                }
                const peers = registry.list(now()).filter(row => row.id !== device.id).flatMap(row => {
                    const info = active(row.id);
                    if (!belongs(info, input.workspaceId, device.ownerId)) return [];
                    const models = modelsFor(info).filter(model => model.agent === 'dsh' || model.agent === 'codex');
                    return models.length ? [{ id: row.id, name: info.device.name, models }] : [];
                });
                return { peers };
            }
            if (input.action === 'prepare') {
                if (input.binding.deviceId !== device.id || input.binding.ownerId !== device.ownerId) {
                    throw taskError('workspace-forbidden', '工单转存需要原节点授权。');
                }
                current(device.id, input.binding.workspaceId, device.ownerId);
                const existing = store.get(input.binding.id);
                if (!existing) remote(input.remoteDeviceId, input.binding);
                const copy = store.ensure(input.binding, 'uploading', input.remoteDeviceId);
                if (copy.remoteDeviceId !== input.remoteDeviceId) throw taskError('task-room-conflict', '群聊转存目标已变化。');
                return { room: copy };
            }
            const room = authorize(device, store.get(input.roomId), input.action !== 'page');
            if (input.action === 'import') return { lastSeq: store.importPage(room.id, input.records) };
            if (input.action === 'commit') return { room: store.commitImport(room.id, input.lastSeq) };
            if (room.storage !== 'hub') throw taskError('task-room-moving', '群聊正在转存。');
            if (input.action === 'page') {
                if (input.workspaceId !== room.workspaceId) throw taskError('task-room-not-found', '工单群不存在。');
                return store.page(room.id, input);
            }
            if (input.action === 'append') {
                const record = store.append(room.id, input.event);
                return { record, room: store.get(room.id) };
            }
            return { record: await turn(room, input) };
        },
        catalog(identity, frame) {
            catalogs.set(identity.deviceId, { connectionId: frame.connectionId, nodeEpoch: frame.nodeEpoch, models: frame.models });
        },
        result(identity, frame) {
            const job = pending.get(frame.turnId);
            if (!job || frame.roomId !== job.room.id || frame.memberId !== job.memberId ||
                identity.deviceId !== job.deviceId || frame.connectionId !== job.connectionId ||
                frame.nodeEpoch !== job.nodeEpoch) return;
            const info = active(job.deviceId);
            if (!belongs(info, job.room.workspaceId, job.room.ownerId) || !info.device.allowDiscussion ||
                info.device.policyRevision !== job.policyRevision) {
                finish(job, 'failed', '工作区或设备授权已变更。');
                return;
            }
            if (frame.state === 'completed' && typeof frame.text === 'string' && frame.text.trim() &&
                frame.checksum === createHash('sha256').update(frame.text).digest('hex')) {
                finish(job, 'completed', frame.text);
            } else {
                finish(job, 'failed', frame.state === 'cancelled' ? '远端调用已取消。' : '远端调用失败。');
            }
        },
        dispose() {
            for (const job of [...pending.values()]) finish(job, 'unknown', 'Hub 已停止，远端结果待核对。');
            catalogs.clear();
        },
    };
}
