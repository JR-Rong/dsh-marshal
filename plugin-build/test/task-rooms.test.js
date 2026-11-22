import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTaskRoomStore } from '../lib/src/groups/task-room-store.js';
import { createTaskRooms } from '../lib/src/groups/task-rooms.js';
import { createHubTaskRooms } from '../lib/src/hub/task-rooms.js';

const owner = 'account-owner';
const workspace = 'workspace-shared';
const peer = { deviceId: 'peer-device', modelId: 'dsh:provider:verified' };
const model = { id: peer.modelId, agent: 'dsh', provider: 'provider', model: 'verified' };

function fixtures(t) {
    const dir = mkdtempSync(join(tmpdir(), 'marshal-workorder-test-'));
    const stores = [];
    const open = name => {
        const store = createTaskRoomStore(join(dir, name + '.sqlite'));
        stores.push(store);
        return store;
    };
    const devices = new Map([
        ['origin-device', { id: 'origin-device', name: '创建节点', ownerId: owner, allowDiscussion: true, policyRevision: 2 }],
        ['peer-device', { id: 'peer-device', name: '执行节点', ownerId: owner, allowDiscussion: true, policyRevision: 4 }],
        ['wrong-workspace', { id: 'wrong-workspace', name: '另一个项目', ownerId: owner, allowDiscussion: true, policyRevision: 4 }],
        ['wrong-account', { id: 'wrong-account', ownerId: 'separate-owner', allowDiscussion: true, policyRevision: 4 }],
    ]);
    const connections = new Map([...devices.keys()].map(id => [id, { connectionId: id + ':conn', nodeEpoch: id + ':epoch' }]));
    const inventories = new Map([...devices.entries()].map(([id, device]) => [id, {
        ...connections.get(id), policyRevision: device.policyRevision,
        squads: [{ workspaceId: id === 'wrong-workspace' ? 'elsewhere' : workspace }],
    }]));
    const delivered = [];
    const newHub = store => {
        const hub = createHubTaskRooms({
            store, inventories, registry: { get: id => connections.get(id), list: () => [...connections.keys()].map(id => ({ id })) },
            deviceStore: { findById: id => devices.get(id) },
            relay: { async command(input) { delivered.push(input); return { ok: true }; } },
        });
        for (const [id, connection] of connections) hub.catalog({ deviceId: id }, { ...connection, models: [model] });
        t.after(() => hub.dispose());
        return hub;
    };
    t.after(() => {
        for (const st of stores) { try { st.close(); } catch {} }
        rmSync(dir, { recursive: true, force: true });
    });
    return { open, newHub, devices, connections, inventories, delivered };
}

test('one room per card preserves over 500 full messages, retries, and archive across a restart', async t => {
    const f = fixtures(t);
    const store = f.open('node');
    const rooms = createTaskRooms({ store, deviceId: 'origin-device' });
    const card = { id: 'card', title: '归档夹具' };
    const room = rooms.ensure('host', card, workspace, owner);
    assert.equal(rooms.ensure('host', card, workspace, owner).id, room.id);
    assert.notEqual(rooms.ensure('local', card, workspace, owner).id, room.id);
    assert.throws(() => rooms.ensure('host', card, 'different-workspace', owner), { code: 'task-room-conflict' });
    const first = randomUUID();
    const retry = randomUUID();
    await rooms.begin(room.id, first, 'Marshal', 'start', '首次运行');
    const long = '完整回复'.repeat(1_700);
    for (let i = 0; i < 520; i++) {
        await rooms.append(room.id, { kind: 'agent', runId: first, actor: 'Reviewer', text: i ? String(i) : long });
    }
    await rooms.begin(room.id, retry, 'Marshal', 'retry', '重跑审查');
    await rooms.append(room.id, { kind: 'closed', runId: retry, actor: 'Marshal', text: '已归档' });
    store.close();
    const reloaded = f.open('node');
    const head = reloaded.page(room.id, { after: 0, limit: 2 });
    assert.equal(head.records[1].text, long);
    const tail = reloaded.page(room.id, { limit: 2 });
    assert.equal(tail.room.lastSeq, 523);
    assert.equal(tail.room.closed, true);
    assert.deepEqual(tail.records.map(event => [event.kind, event.runId]), [['batch', retry], ['closed', retry]]);
    assert.equal(reloaded.page(room.id, { before: tail.records[0].seq, limit: 1 }).records[0].runId, first);
});

test('Hub migration resumes after a partial upload and a lost commit response', async t => {
    const f = fixtures(t);
    const local = f.open('origin');
    const hubStore = f.open('hub');
    const hub = f.newHub(hubStore);
    let fail = 'import';
    const origin = f.devices.get('origin-device');
    const rooms = createTaskRooms({ store: local, deviceId: origin.id, async hub(input) {
        const result = await hub.handle(origin, input);
        if (input.action === fail) throw new Error('synthetic disconnect');
        return result;
    } });
    const room = rooms.ensure('host', { id: 'first', title: '转存测试' }, workspace, owner);
    await rooms.begin(room.id, randomUUID(), 'Marshal', 'start', '最先一批');
    for (let i = 0; i < 80; i++) await rooms.append(room.id, { kind: 'user', actor: '用户', text: 'message ' + i });
    await assert.rejects(rooms.promote(room.id, peer), /synthetic disconnect/);
    assert.equal((await rooms.page(room.id, { after: 0 })).records[0].text, '最先一批');
    assert.equal(hubStore.get(room.id).storage, 'uploading');
    fail = 'commit';
    await assert.rejects(rooms.promote(room.id, peer), /synthetic disconnect/);
    assert.equal(hubStore.get(room.id).lastSeq, 81);
    assert.equal(local.get(room.id).storage, 'moving');
    fail = undefined;
    const moved = await rooms.promote(room.id, peer);
    assert.equal(moved.id, room.id);
    assert.equal(moved.lastSeq, 81);
    assert.equal(local.get(room.id).storage, 'hub');
    assert.equal(local.page(room.id, { after: 0 }).records.length, 0);
    await rooms.append(room.id, { kind: 'closed', actor: 'Marshal', text: '关单' });
    assert.equal(local.get(room.id).closed, true);
    hubStore.close();
    const archive = f.open('hub');
    const restarted = f.newHub(archive);
    f.connections.delete(origin.id);
    const reader = f.devices.get(peer.deviceId);
    const { rooms: listed } = await restarted.handle(reader, { action: 'list', workspaceId: workspace });
    assert.deepEqual(listed.map(item => item.id), [room.id]);
    await assert.rejects(restarted.handle(reader, { action: 'page', roomId: room.id, workspaceId: 'elsewhere' }), { code: 'task-room-not-found' });
    const page = await restarted.handle(reader, { action: 'page', roomId: room.id, workspaceId: workspace, limit: 82 });
    assert.equal(page.records[0].text, '最先一批');
    assert.equal(page.records.at(-1).text, '关单');
    assert.equal(page.records.length, 82);
    for (const deviceId of ['wrong-workspace', 'wrong-account']) {
        await assert.rejects(restarted.handle(f.devices.get(deviceId), { action: 'page', roomId: room.id, workspaceId: workspace }),
            error => ['workspace-forbidden', 'task-room-not-found'].includes(error.code));
    }
    f.devices.get(peer.deviceId).revoked = true;
    await assert.rejects(restarted.handle(reader, { action: 'page', roomId: room.id, workspaceId: workspace }), { code: 'workspace-forbidden' });
});

test('Hub-backed append only publishes an inserted cursor, including overlapping identical requests', async t => {
    const f = fixtures(t);
    const hub = f.newHub(f.open('hub'));
    const origin = f.devices.get('origin-device');
    const observed = [];
    const rooms = createTaskRooms({
        store: f.open('local'), deviceId: origin.id, hub: input => hub.handle(origin, input),
        eventBus: { emit: (...value) => observed.push(value) },
    });
    const room = rooms.ensure('host', { id: 'card', title: 'Hub room' }, workspace, owner);
    await rooms.promote(room.id, peer);
    const entry = { id: 'message', at: 42, kind: 'user', actor: 'owner', text: 'one message' };
    const [first, replay] = await Promise.all([rooms.append(room.id, entry), rooms.append(room.id, entry)]);
    assert.deepEqual(replay, first);
    assert.deepEqual(await rooms.append(room.id, entry), first);
    assert.deepEqual(observed, [['room.message', { roomId: room.id, seq: 1 }]]);
});

test('Hub admits a workspace-bound remote turn and attributes a late reply to its original group and batch', async t => {
    const f = fixtures(t);
    const hubStore = f.open('hub');
    const hub = f.newHub(hubStore);
    const origin = f.devices.get('origin-device');
    const rooms = createTaskRooms({ store: f.open('local'), deviceId: origin.id, hub: args => hub.handle(origin, args) });
    const group = rooms.ensure('local', { id: 'task', title: '运行批次' }, workspace, owner);
    await rooms.promote(group.id, peer);
    const priorRun = randomUUID();
    const nextRun = randomUUID();
    await rooms.begin(group.id, priorRun, 'Marshal', 'start', '初次派发');
    const wait = rooms.remote(group.id, { runId: priorRun, target: peer, text: 'work', phase: 'reviewing' });
    await new Promise(resolve => setImmediate(resolve));
    const command = f.delivered[0];
    assert.equal(command.args.taskWorkspaceId, workspace);
    await rooms.begin(group.id, nextRun, 'Marshal', 'reassign', '改派');
    const { roomId, memberId, turnId } = command.args;
    const text = '属于上一批的完整回复';
    const frame = { ...f.connections.get(peer.deviceId), roomId, memberId, turnId, state: 'completed', text,
        checksum: createHash('sha256').update(text).digest('hex') };
    hub.result({ deviceId: 'wrong-account' }, frame);
    assert.equal(hubStore.event(group.id, turnId), undefined);
    hub.result({ deviceId: peer.deviceId }, frame);
    assert.equal(await wait, text);
    hub.result({ deviceId: peer.deviceId }, frame);
    const page = await rooms.page(group.id, { after: 0 });
    assert.equal(page.room.runId, nextRun);
    assert.equal(page.records.at(-1).runId, priorRun);
    assert.equal(page.records.filter(record => record.kind === 'agent').length, 1);
});
