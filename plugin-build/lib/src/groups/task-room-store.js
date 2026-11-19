import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { taskError } from './pr-material.js';

const key = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
export const TaskRoomKey = key;
export const TaskRoomBinding = z.object({
    id: z.uuid(), deviceId: key, source: z.enum(['host', 'local']), taskId: key, workspaceId: key,
    ownerId: key, title: z.string().min(1).max(512), createdAt: z.number().int().nonnegative(),
}).strict();
export const TaskRoomEvent = z.object({
    id: key, kind: z.enum(['batch', 'user', 'agent', 'status', 'closed', 'reopened']),
    runId: z.uuid().optional(), actor: z.string().min(1).max(512),
    text: z.string().refine(value => Buffer.byteLength(value) <= 64 * 1024),
    at: z.number().int().nonnegative(),
    phase: z.string().max(64).optional(), ref: z.string().max(256).optional(),
    deviceId: key.optional(), requestId: z.uuid().optional(),
}).strict();
export const TaskRoomRecord = TaskRoomEvent.extend({ seq: z.number().int().positive() });
const DEFAULT_PAGE = 40;

function rowView(row) {
    if (!row) return undefined;
    return { ...JSON.parse(row.binding), storage: row.storage, lastSeq: row.last_seq,
        closed: row.closed === 1, runId: row.run_id ?? undefined, remoteDeviceId: row.remote_device ?? undefined };
}

/** Each side uses the same message representation. only the current authority accepts new events. */
export function createTaskRoomStore(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA secure_delete=ON;
        PRAGMA busy_timeout=3000;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS task_rooms (
            id TEXT PRIMARY KEY, device_id TEXT NOT NULL, source TEXT NOT NULL, task_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, binding TEXT NOT NULL,
            storage TEXT NOT NULL, remote_device TEXT, last_seq INTEGER NOT NULL DEFAULT 0,
            closed INTEGER NOT NULL DEFAULT 0, run_id TEXT,
            UNIQUE(device_id, source, task_id)
        );
        CREATE INDEX IF NOT EXISTS task_rooms_workspace ON task_rooms(owner_id, workspace_id, storage, id);
        CREATE TABLE IF NOT EXISTS task_room_events (
            room_id TEXT NOT NULL REFERENCES task_rooms(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL,
            PRIMARY KEY(room_id,seq), UNIQUE(room_id,event_id)
        );
    `);
    const byId = db.prepare('SELECT * FROM task_rooms WHERE id=?');
    const byTask = db.prepare('SELECT * FROM task_rooms WHERE device_id=? AND source=? AND task_id=?');
    const insertRoom = db.prepare(`
        INSERT INTO task_rooms(id,device_id,source,task_id,workspace_id,owner_id,binding,storage,remote_device)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,source,task_id) DO NOTHING
    `);
    const byEvent = db.prepare('SELECT seq,payload FROM task_room_events WHERE room_id=? AND event_id=?');
    const insertEvent = db.prepare('INSERT INTO task_room_events(room_id,seq,event_id,payload) VALUES(?,?,?,?)');
    const advance = db.prepare('UPDATE task_rooms SET last_seq=?, closed=?, run_id=? WHERE id=?');
    const setStorage = db.prepare('UPDATE task_rooms SET storage=?,remote_device=? WHERE id=?');

    const tx = fn => {
        db.exec('BEGIN IMMEDIATE');
        try {
            const value = fn();
            db.exec('COMMIT');
            return value;
        }
        catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    const requireRoom = id => {
        const room = rowView(byId.get(id));
        if (!room) throw taskError('task-room-not-found', '工单群不存在。');
        return room;
    };
    const setLocation = (id, storage, remoteDeviceId) => {
        setStorage.run(storage, remoteDeviceId ?? null, id);
        return requireRoom(id);
    };
    const add = (room, event, seq = undefined) => {
        const value = TaskRoomEvent.parse(event);
        if (value.kind === 'batch' && !value.runId) throw taskError('invalid-task-room', '批次记录需要运行标识。');
        const encoded = JSON.stringify(value);
        const existing = byEvent.get(room.id, value.id);
        if (existing) {
            if (existing.payload !== encoded || (seq !== undefined && existing.seq !== seq)) {
                throw taskError('task-room-conflict', '群消息已存在，内容或序号冲突。');
            }
            return { ...value, seq: existing.seq };
        }
        const nextSeq = room.lastSeq + 1;
        if (seq !== undefined && seq !== nextSeq) throw taskError('task-room-gap', '群消息序号不连续。');
        const closed = value.kind === 'closed' ? true : value.kind === 'reopened' || value.kind === 'batch' ? false : room.closed;
        const runId = value.kind === 'batch' ? value.runId : room.runId;
        insertEvent.run(room.id, nextSeq, value.id, encoded);
        advance.run(nextSeq, Number(closed), runId ?? null, room.id);
        return { ...value, seq: nextSeq };
    };
    const page = (id, { after, before, limit = DEFAULT_PAGE } = {}) => {
        const room = requireRoom(id);
        const cap = Math.max(1, Math.min(100, Math.floor(Number(limit)) || DEFAULT_PAGE));
        let rows;
        if (Number.isSafeInteger(after) && after >= 0) {
            rows = db.prepare('SELECT seq,payload FROM task_room_events WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, cap);
        } else {
            const cursor = Number.isSafeInteger(before) && before > 0 ? before : room.lastSeq + 1;
            rows = db.prepare('SELECT seq,payload FROM task_room_events WHERE room_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id, cursor, cap).reverse();
        }
        const records = rows.map(row => ({ ...JSON.parse(row.payload), seq: row.seq }));
        return { room, records, hasOlder: (records[0]?.seq ?? 1) > 1, hasNewer: (records.at(-1)?.seq ?? after ?? 0) < room.lastSeq };
    };

    return {
        ensure(input, storage = 'local', remoteDeviceId) {
            if (!['local', 'uploading'].includes(storage)) throw new Error('invalid initial storage');
            const binding = TaskRoomBinding.parse({ id: randomUUID(), ...input });
            return tx(() => {
                insertRoom.run(binding.id, binding.deviceId, binding.source, binding.taskId, binding.workspaceId,
                    binding.ownerId, JSON.stringify(binding), storage, remoteDeviceId ?? null);
                const room = rowView(byTask.get(binding.deviceId, binding.source, binding.taskId));
                if (room.workspaceId !== binding.workspaceId || room.ownerId !== binding.ownerId ||
                    (storage === 'uploading' && room.id !== binding.id)) throw taskError('task-room-conflict', '工单群绑定已存在。');
                return room;
            });
        },
        find: (deviceId, source, taskId) => rowView(byTask.get(deviceId, source, taskId)),
        get: id => rowView(byId.get(id)),
        event(id, eventId) {
            const row = byEvent.get(id, eventId);
            return row ? { ...JSON.parse(row.payload), seq: row.seq } : undefined;
        },
        list(ownerId, workspaceId) {
            return db.prepare('SELECT * FROM task_rooms WHERE owner_id=? AND workspace_id=? ORDER BY rowid DESC').all(ownerId, workspaceId).map(rowView);
        },
        page,
        append(id, event) {
            return tx(() => {
                const room = requireRoom(id);
                if (room.storage !== 'local' && room.storage !== 'hub') throw taskError('task-room-moving', '群聊正在转存，请稍后重试。');
                return add(room, event);
            });
        },
        freeze(id, remoteDeviceId) {
            TaskRoomKey.parse(remoteDeviceId);
            return tx(() => {
                const room = requireRoom(id);
                if (room.storage === 'moving' && room.remoteDeviceId === remoteDeviceId) return room;
                if (room.storage !== 'local') throw taskError('task-room-conflict', '已有群聊转存位置。');
                return setLocation(id, 'moving', remoteDeviceId);
            });
        },
        importPage(id, records) {
            return tx(() => {
                let room = requireRoom(id);
                if (room.storage !== 'uploading') throw taskError('task-room-conflict', '群聊转存已完成。');
                for (const { seq, ...event } of z.array(TaskRoomRecord).max(32).parse(records)) {
                    add(room, event, seq);
                    room = requireRoom(id);
                }
                return room.lastSeq;
            });
        },
        commitImport(id, lastSeq) {
            return tx(() => {
                const room = requireRoom(id);
                if (room.storage === 'hub' && room.lastSeq >= lastSeq) return room;
                if (room.storage !== 'uploading' || room.lastSeq !== lastSeq) throw taskError('task-room-gap', 'Hub 尚未收到全部群消息。');
                return setLocation(id, 'hub', room.remoteDeviceId);
            });
        },
        confirmMove(id, lastSeq) {
            const room = tx(() => {
                const room = requireRoom(id);
                if (room.storage === 'hub') return room;
                if (room.storage !== 'moving' || room.lastSeq !== lastSeq) throw taskError('task-room-conflict', '群聊转存确认与原始记录不符。');
                db.prepare('DELETE FROM task_room_events WHERE room_id=?').run(id);
                return setLocation(id, 'hub', room.remoteDeviceId);
            });
            try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* logical move already committed */ }
            return room;
        },
        refreshPointer(remote) {
            const local = rowView(byId.get(remote.id));
            if (local?.storage === 'hub' && local.workspaceId === remote.workspaceId && local.ownerId === remote.ownerId &&
                local.deviceId === remote.deviceId && remote.lastSeq >= local.lastSeq) {
                advance.run(remote.lastSeq, Number(remote.closed), remote.runId ?? null, remote.id);
            }
        },
        close: () => db.close(),
    };
}
