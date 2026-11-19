import { randomUUID } from 'node:crypto';
import { TaskRoomBinding, TaskRoomEvent } from './task-room-store.js';
import { taskError } from './pr-material.js';

const pageBytes = 480 * 1024;
export function createTaskRooms({ store, deviceId, hub, now = Date.now }) {
    const moves = new Map();
    const request = input => {
        if (!hub) throw taskError('task-room-hub-unavailable', '此节点尚未连接可用的 Hub。');
        return hub(input);
    };
    const moved = async room => {
        const binding = TaskRoomBinding.parse({
            id: room.id, deviceId: room.deviceId, source: room.source, taskId: room.taskId,
            workspaceId: room.workspaceId, ownerId: room.ownerId, title: room.title, createdAt: room.createdAt,
        });
        const { room: copy } = await request({ action: 'prepare', binding, remoteDeviceId: room.remoteDeviceId });
        let after = copy.lastSeq;
        if (copy.storage !== 'hub') {
            while (after < room.lastSeq) {
                const { records } = store.page(room.id, { after, limit: 32 });
                const chunk = [];
                let bytes = 64;
                for (const record of records) {
                    bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
                    if (bytes > pageBytes) break;
                    chunk.push(record);
                }
                if (chunk.length === 0) throw taskError('task-room-gap', '原设备上的群聊记录不完整。');
                const imported = await request({ action: 'import', roomId: room.id, records: chunk });
                if (imported.lastSeq < chunk.at(-1).seq || imported.lastSeq > room.lastSeq) {
                    throw taskError('task-room-gap', 'Hub 转存游标不一致。');
                }
                after = imported.lastSeq;
            }
        }
        const committed = await request({ action: 'commit', roomId: room.id, lastSeq: room.lastSeq });
        if (committed.room.id !== room.id || committed.room.storage !== 'hub' || committed.room.lastSeq < room.lastSeq) {
            throw taskError('task-room-gap', 'Hub 尚未确认接管该工单群。');
        }
        store.confirmMove(room.id, room.lastSeq);
        store.refreshPointer(committed.room);
        return committed.room;
    };
    const recover = room => {
        let active = moves.get(room.id);
        if (!active) {
            active = moved(room).finally(() => moves.delete(room.id));
            moves.set(room.id, active);
        }
        return active;
    };
    const append = async (id, event) => {
        let room = store.get(id);
        if (!room) throw taskError('task-room-not-found', '此工单群由原设备管理。');
        const entry = TaskRoomEvent.parse({ id: randomUUID(), at: now(), ...event });
        if (room.storage === 'moving') room = await recover(room);
        if (room.storage === 'hub') {
            const result = await request({ action: 'append', roomId: id, event: entry });
            store.refreshPointer(result.room);
            return result.record;
        }
        return store.append(id, entry);
    };
    const begin = async (id, runId, actor, reason, text) => {
        await append(id, { id: 'batch:' + runId, kind: 'batch', runId, actor, text, phase: reason });
    };
    return {
        ensure(source, card, workspaceId, ownerId) {
            return store.ensure({ deviceId, source, taskId: String(card.id), workspaceId, ownerId,
                title: String(card.title || '未命名工单').slice(0, 512), createdAt: now() });
        },
        find: (source, taskId) => store.find(deviceId, source, taskId),
        local: id => store.get(id),
        async promote(id, target) {
            const room = store.get(id);
            if (!room) throw taskError('task-room-not-found', '跨设备转存由原设备发起。');
            if (room.storage === 'hub') return room;
            if (room.storage === 'moving') return recover(room);
            // Leave the local archive writable if the proposed peer is unavailable at admission.
            const { peers } = await request({ action: 'catalog', workspaceId: room.workspaceId });
            if (!peers.some(peer => peer.id === target.deviceId && peer.models.some(model => model.id === target.modelId))) {
                throw taskError('task-room-peer-unavailable', '目标设备或模型不具备该工作区的权限。');
            }
            const latest = store.get(id);
            if (latest.storage === 'hub') return latest;
            if (latest.storage === 'moving') return recover(latest);
            return recover(store.freeze(id, target.deviceId));
        },
        async list(workspaceId, ownerId) {
            const local = store.list(ownerId, workspaceId);
            const entries = new Map(local.map(room => [room.id, room]));
            let hubError = false;
            if (hub) {
                try {
                    const { rooms } = await request({ action: 'list', workspaceId });
                    for (const room of rooms) if (room.workspaceId === workspaceId && room.ownerId === ownerId) entries.set(room.id, room);
                }
                catch { hubError = true; }
            }
            return { rooms: [...entries.values()].sort((a, b) => b.createdAt - a.createdAt), hubError };
        },
        async page(id, { workspaceId, ...cursors }) {
            const room = store.get(id);
            if (room && room.storage !== 'hub') return store.page(id, cursors);
            const result = await request({ action: 'page', roomId: id, workspaceId: room?.workspaceId ?? workspaceId, ...cursors });
            if (room) store.refreshPointer(result.room);
            return result;
        },
        async peers(workspaceId) {
            return hub ? (await request({ action: 'catalog', workspaceId })).peers : [];
        },
        async remote(id, { runId, target, text, phase }) {
            const { record } = await request({ action: 'turn', roomId: id, runId, turnId: randomUUID(), target, phase, text });
            return record.text;
        },
        append,
        begin,
        close: () => store.close(),
    };
}
