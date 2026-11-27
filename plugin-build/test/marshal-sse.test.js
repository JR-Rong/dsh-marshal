import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { createMarshalEventBus } from '../lib/src/groups/event-bus.js';
import { createLocalBoard } from '../lib/src/groups/local-board.js';
import { mountGroups } from '../lib/src/groups/mount.js';
import { createTaskOrchestration } from '../lib/src/groups/task-orchestration.js';
import { createTaskRoomStore } from '../lib/src/groups/task-room-store.js';
import { createTaskRooms } from '../lib/src/groups/task-rooms.js';
import { DSH_ACCOUNT_ORIGIN } from '../lib/src/hub/account.js';
import { createMemoryHttpAuth, MEMORY_SESSION_IDLE_MS } from '../lib/src/memory/http-auth.js';

// The packaged plugin tests also run directly with node --test.
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const origin = 'http://127.0.0.1:12345';
const ready = 'event: ready\ndata: {}\n\n';
const event = topic => `event: ${topic}\ndata: {}\n\n`;

function fakeHeartbeats() {
    const timers = new Set();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const set = mock.method(globalThis, 'setInterval', (callback, delay, ...args) => {
        if (delay !== 25_000) return realSet(callback, delay, ...args);
        const timer = { callback, unref() { this.unrefCalled = true; } };
        timers.add(timer);
        return timer;
    });
    const clear = mock.method(globalThis, 'clearInterval', timer => {
        if (!timers.delete(timer)) realClear(timer);
    });
    return {
        timers,
        restore() {
            set.mock.restore();
            clear.mock.restore();
        },
    };
}

function fixture({ eventBus, memory, host = false, sessionController = {} } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'marshal-sse-'));
    const routes = new Map();
    const effects = new Map();
    const boardEvents = new EventEmitter();
    const services = {
        webServer: {
            getOrigin: () => origin,
            register(route) {
                routes.set(route.path, route);
                return () => routes.delete(route.path);
            },
        },
        ...(host ? { taskBoard: {
            ...createLocalBoard(join(root, 'host-tasks.json')),
            subscribe(listener) {
                boardEvents.on('change', listener);
                return () => boardEvents.off('change', listener);
            },
        } } : {}),
    };
    const effect = (setup, name) => effects.set(name, setup());
    const dispose = () => {
        for (const teardown of [...effects.values()].reverse()) teardown?.();
        effects.clear();
        rmSync(root, { recursive: true, force: true });
    };
    let userId = 'sse-test-owner';
    mountGroups({
        sessionController,
        effect,
        inject([name], register) {
            if (services[name]) register({ effect, [name]: services[name] });
        },
        get(name) {
            if (name === 'deepseekAccount') {
                return { getPlatformSession: async () => ({ userId, origin: DSH_ACCOUNT_ORIGIN }) };
            }
        },
    }, { deviceId: 'sse-test', agents: ['dsh'], groupsRoot: root, memoryRoot: join(root, 'memory') }, { eventBus, memory });
    // Exercise the exact registered handlers without a TCP listener.
    const request = async (method, path, { headers, body, signal, acceptsWrite = () => true } = {}) => {
        const req = Object.assign(new EventEmitter(), {
            method, url: path, headers: { host: '127.0.0.1:12345', origin, ...headers },
            socket: { remoteAddress: '127.0.0.1' },
            async *[Symbol.asyncIterator]() {
                if (body !== undefined) yield Buffer.from(JSON.stringify(body));
            },
        });
        const res = Object.assign(new EventEmitter(), {
            headers: {}, chunks: [], destroyCalls: 0,
            setHeader(name, value) { this.headers[name] = value; },
            writeHead(status, head) { this.status = status; Object.assign(this.headers, head); },
            write(chunk) { this.chunks.push(chunk); return acceptsWrite(chunk); },
            destroy() {
                this.destroyCalls += 1;
                this.destroyed = true;
                this.emit('close');
            },
            end(chunk) {
                this.writableEnded = true;
                if (chunk !== undefined) this.write(chunk);
                this.emit('close');
            },
            json() { return JSON.parse(this.chunks.join('')); },
        });
        if (signal) {
            const abort = () => req.emit('close');
            if (signal.aborted) throw signal.reason;
            signal.addEventListener('abort', abort, { once: true });
            res.once('close', () => signal.removeEventListener('abort', abort));
        }
        await routes.get(path).handler(req, res);
        return { req, res };
    };
    const signIn = async () => {
        const { res } = await request('POST', '/marshal/memory/session', { headers: { 'x-marshal-memory': '1' } });
        assert.equal(res.status, 200);
        const cookies = res.headers['set-cookie'].map(value => value.split(';')[0]);
        return { cookie: cookies.join('; '), 'x-marshal-csrf': cookies[1].split('=')[1] };
    };
    return { root, request, signIn, dispose, boardEvents, effects, setUserId: id => { userId = id; } };
}

test('event bus isolates listeners and supports idempotent unsubscribe and dispose', () => {
    const bus = createMarshalEventBus();
    const observed = [];
    bus.subscribe(() => { throw new Error('listener failed'); });
    bus.subscribe(async () => { throw new Error('async listener failed'); });
    const collect = (...value) => observed.push(value);
    const stop = bus.subscribe(collect);
    const stopOther = bus.subscribe(collect);
    assert.equal(bus.subscriberCount(), 4);
    bus.emit('tasks.changed');
    stop();
    stop();
    bus.emit('groups.changed', { revision: 3 });
    assert.deepEqual(observed, [['tasks.changed', {}], ['tasks.changed', {}], ['groups.changed', { revision: 3 }]]);
    assert.equal(bus.subscriberCount(), 3);
    bus.dispose();
    bus.dispose();
    stopOther();
    bus.subscribe(collect)();
    bus.emit('agents.changed');
    assert.equal(bus.subscriberCount(), 0);
    assert.equal(observed.length, 3);
});

test('SSE denies unauthenticated and cross-site requests without subscribing', async () => {
    const bus = createMarshalEventBus();
    const app = fixture({ eventBus: bus });
    try {
        const { res } = await app.request('GET', '/marshal/events');
        assert.equal(res.status, 403);
        assert.match(res.headers['content-type'], /application\/json/);
        assert.deepEqual(res.json(), { ok: false, code: 'unauthorized' });
        const headers = { ...await app.signIn(), 'sec-fetch-site': 'cross-site' };
        const blocked = await app.request('GET', '/marshal/events', { headers });
        assert.equal(blocked.res.status, 403);
        assert.deepEqual(blocked.res.json(), { ok: false, code: 'forbidden' });
        assert.equal(bus.subscriberCount(), 0);
    } finally { app.dispose(); }
});

test('SSE sends ready, mutation frames and heartbeat, and cleans up on either close', async () => {
    const bus = createMarshalEventBus();
    const controller = new AbortController();
    const { timers, restore } = fakeHeartbeats();
    const app = fixture({ eventBus: bus });
    try {
        const headers = await app.signIn();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
        const { req, res } = await app.request('GET', '/marshal/events', { headers, signal });
        assert.equal(res.status, 200);
        assert.deepEqual(res.headers, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no',
        });
        assert.equal(res.writableEnded, undefined);
        assert.deepEqual(res.chunks, [ready]);
        assert.equal(bus.subscriberCount(), 1);
        assert.equal(timers.size, 1);
        const [heartbeat] = timers;
        assert.equal(heartbeat.unrefCalled, true);
        heartbeat.callback();
        assert.deepEqual(res.chunks, [ready, ': ping\n\n']);

        const failed = await app.request('POST', '/marshal/tasks/create', { body: {} });
        assert.equal(failed.res.status, 400);
        assert.equal(res.chunks.length, 2);
        const { res: created } = await app.request('POST', '/marshal/tasks/create', { body: { title: '验证任务状态实时推送' } });
        assert.equal(created.status, 200);
        assert.deepEqual(res.chunks.slice(2), [event('tasks.changed'), event('incidents.changed')]);
        bus.emit('test.payload', { text: 'a\nb' });
        assert.equal(res.chunks.at(-1), 'event: test.payload\ndata: {"text":"a\\nb"}\n\n');

        controller.abort();
        assert.equal(bus.subscriberCount(), 0);
        assert.equal(timers.size, 0);
        assert.equal(req.listenerCount('close'), 0);
        assert.equal(res.listenerCount('close'), 0);
        assert.equal(res.destroyCalls, 1);
        const count = res.chunks.length;
        bus.emit('tasks.changed');
        assert.equal(res.chunks.length, count);

        const other = await app.request('GET', '/marshal/events', { headers });
        assert.equal(timers.size, 1);
        other.res.emit('close');
        assert.equal(timers.size, 0);
        assert.equal(bus.subscriberCount(), 0);
        assert.equal(other.req.listenerCount('close'), 0);
        assert.equal(other.res.listenerCount('close'), 0);
        assert.equal(other.res.destroyCalls, 1);
    } finally {
        controller.abort();
        app.dispose();
        restore();
    }
});

test('read-only session checks preserve lastSeenAt while ordinary authentication still renews it', async () => {
    let now = Date.now();
    const absoluteMs = 2 * MEMORY_SESSION_IDLE_MS;
    const auth = createMemoryHttpAuth({
        now: () => now, resolveOwner: async () => 'owner', allowedOrigins: [origin], absoluteMs,
    });
    const req = {
        headers: { host: '127.0.0.1:12345', origin, 'x-marshal-memory': '1' },
        socket: { remoteAddress: '127.0.0.1' },
    };
    const opened = await auth.open(req);
    assert.equal(opened.ok, true);
    req.headers.cookie = opened.cookies.map(value => value.split(';')[0]).join('; ');
    const start = now;
    now += MEMORY_SESSION_IDLE_MS - 1;
    assert.equal(auth.authenticate(req, { touch: false }).session.lastSeenAt, start);
    assert.equal(auth.authenticate(req).session.lastSeenAt, now);
    now += 1;
    assert.equal(auth.authenticate(req, { touch: false }).session.lastSeenAt, now - 1);
    now = start + absoluteMs - 2;
    assert.equal(auth.authenticate(req).session.lastSeenAt, now);
    now = start + absoluteMs;
    assert.equal(auth.authenticate(req, { touch: false }).ok, false);
});

for (const trigger of ['event', 'heartbeat']) {
    test(`SSE heartbeat and event writes do not renew idle sessions (${trigger} detects expiry)`, async () => {
        const bus = createMarshalEventBus();
        const { timers, restore } = fakeHeartbeats();
        const start = Date.now();
        let now = start;
        const clock = mock.method(Date, 'now', () => now);
        const app = fixture({ eventBus: bus });
        try {
            const headers = await app.signIn();
            // Establishing the stream remains ordinary session activity.
            const connectedAt = start + MEMORY_SESSION_IDLE_MS / 2;
            now = connectedAt;
            const { req, res } = await app.request('GET', '/marshal/events', { headers });
            assert.deepEqual(res.chunks, [ready]);
            assert.equal(bus.subscriberCount(), 1);
            const [heartbeat] = timers;
            const ping = ': ping\n\n';
            now = start + MEMORY_SESSION_IDLE_MS;
            heartbeat.callback();
            now = connectedAt + MEMORY_SESSION_IDLE_MS - 1;
            heartbeat.callback();
            bus.emit('memory.changed');
            const beforeExpiry = [ready, ping, ping, event('memory.changed')];
            assert.deepEqual(res.chunks, beforeExpiry);
            assert.equal(res.destroyCalls, 0);

            now = connectedAt + MEMORY_SESSION_IDLE_MS;
            if (trigger === 'heartbeat') {
                heartbeat.callback();
            } else {
                bus.emit('memory.changed', { revision: 1 });
            }
            assert.equal(res.destroyCalls, 1);
            assert.equal(bus.subscriberCount(), 0);
            assert.equal(timers.size, 0);
            assert.equal(req.listenerCount('close'), 0);
            bus.emit('tasks.changed');
            assert.deepEqual(res.chunks, beforeExpiry);
        } finally {
            app.dispose();
            clock.mock.restore();
            restore();
        }
    });
}

for (const blocked of [ready, ': ping\n\n']) {
    test(`SSE cleans up and destroys on ${blocked === ready ? 'ready' : 'ping'} backpressure`, async () => {
        const bus = createMarshalEventBus();
        const { timers, restore } = fakeHeartbeats();
        const app = fixture({ eventBus: bus });
        try {
            const { req, res } = await app.request('GET', '/marshal/events', {
                headers: await app.signIn(), acceptsWrite: chunk => chunk !== blocked,
            });
            if (blocked !== ready) {
                assert.equal(bus.subscriberCount(), 1);
                const [heartbeat] = timers;
                heartbeat.callback();
            }
            assert.equal(res.status, 200);
            assert.equal(res.destroyCalls, 1);
            assert.equal(bus.subscriberCount(), 0);
            assert.equal(timers.size, 0);
            assert.equal(req.listenerCount('close'), 0);
            assert.equal(res.listenerCount('close'), 0);
            assert.deepEqual(res.chunks, blocked === ready ? [ready] : [ready, blocked]);
        } finally {
            app.dispose();
            restore();
        }
    });
}

test('SSE disconnects a client under backpressure without interrupting other streams', async () => {
    const bus = createMarshalEventBus();
    const { timers, restore } = fakeHeartbeats();
    const app = fixture({ eventBus: bus });
    try {
        const headers = await app.signIn();
        const slow = await app.request('GET', '/marshal/events', { headers });
        const healthy = await app.request('GET', '/marshal/events', { headers });
        assert.equal(bus.subscriberCount(), 2);
        const [slowHeartbeat, healthyHeartbeat] = timers;
        slow.res.write = chunk => { slow.res.chunks.push(chunk); return false; };

        bus.emit('tasks.changed');
        assert.equal(slow.res.destroyCalls, 1);
        assert.equal(slow.req.listenerCount('close'), 0);
        assert.equal(bus.subscriberCount(), 1);
        assert.equal(timers.has(slowHeartbeat), false);
        assert.equal(timers.has(healthyHeartbeat), true);
        bus.emit('incidents.changed');
        assert.deepEqual(slow.res.chunks, [ready, event('tasks.changed')]);
        assert.equal(healthy.res.destroyCalls, 0);
        assert.deepEqual(healthy.res.chunks, [ready, event('tasks.changed'), event('incidents.changed')]);
    } finally {
        app.dispose();
        restore();
    }
});

test('host board notifications are sanitized and plugin teardown destroys streams and unsubscribes', async () => {
    const bus = createMarshalEventBus();
    const observed = [];
    const stop = bus.subscribe((topic, payload) => observed.push([topic, payload]));
    const { timers, restore } = fakeHeartbeats();
    const app = fixture({ eventBus: bus, host: true });
    try {
        const { req, res } = await app.request('GET', '/marshal/events', { headers: await app.signIn() });
        assert.equal(app.boardEvents.listenerCount('change'), 1);
        assert.equal(timers.size, 1);
        const change = { kind: 'move-failed', taskId: 'host-task', details: 'private' };
        app.boardEvents.emit('change', change);
        assert.deepEqual(res.chunks, [ready, event('tasks.changed'), event('incidents.changed')]);
        app.boardEvents.emit('change'); // Some hosts notify without a payload.
        assert.deepEqual(res.chunks.slice(3), [event('tasks.changed'), event('incidents.changed')]);
        app.effects.get('marshal: groups prompt lifetime')();
        app.effects.delete('marshal: groups prompt lifetime');
        assert.equal(res.destroyCalls, 1);
        assert.equal(req.listenerCount('close'), 0);
        assert.equal(bus.subscriberCount(), 1);
        assert.equal(timers.size, 0);
        app.dispose();
        assert.equal(res.destroyCalls, 1);
        assert.equal(app.boardEvents.listenerCount('change'), 0);
        app.boardEvents.emit('change', change);
        const expected = [['tasks.changed', {}], ['incidents.changed', {}], ['tasks.changed', {}], ['incidents.changed', {}]];
        assert.deepEqual(observed, expected);
        bus.emit('agents.changed');
        assert.deepEqual(observed, [...expected, ['agents.changed', {}]]);
    } finally {
        app.dispose();
        stop();
        restore();
    }
});

test('the default bus connects group, roster and memory mutations to the stream', async () => {
    const app = fixture({
        memory: {
            rejectProposal: id => id === 'known' ? { id, status: 'rejected' } : undefined,
            forgetGlobal: () => false,
        },
    });
    try {
        const headers = await app.signIn();
        const { res } = await app.request('GET', '/marshal/events', { headers });
        const post = async (path, body, status = 200) => {
            const result = await app.request('POST', path, { headers, body });
            assert.equal(result.res.status, status, JSON.stringify(result.res.chunks));
        };
        const members = ['agent-a', 'agent-b'].map(id => ({ squadId: 'team', memberId: id, name: id }));
        await post('/marshal/groups/create', { name: 'SSE group', mode: 'chat', members });
        await post('/marshal/rosters/save', { workspaceId: 'workspace', members: ['agent'] });
        await post('/marshal/memory/proposals/reject', { id: 'unknown' }, 404);
        await post('/marshal/memory/global/forget', { id: 'unknown' });
        assert.deepEqual(res.chunks, [ready, event('groups.changed'), event('agents.changed')]);
        await post('/marshal/memory/proposals/reject', { id: 'known' });
        assert.deepEqual(res.chunks.slice(3), [event('memory.changed'), event('incidents.changed')]);
        app.dispose();
        assert.equal(res.destroyCalls, 1);
    } finally { app.dispose(); }
});

test('group send streams the stored message before delivery resolves and later streams the stored reply', async () => {
    const delivery = Promise.withResolvers();
    const prompting = Promise.withResolvers();
    let reply;
    let poll;
    const realSetTimeout = globalThis.setTimeout;
    const timer = mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
        if (delay !== 1500) return realSetTimeout(callback, delay, ...args);
        poll = callback;
        return { unref() { return this; } };
    });
    const app = fixture({ sessionController: {
        page() {},
        async *follow() {
            yield { type: 'snapshot', cursor: reply?.seq ?? 0, records: reply ? [{ event: reply }] : [] };
        },
        prompt() {
            prompting.resolve();
            return delivery.promise;
        },
    } });
    try {
        const headers = await app.signIn();
        const post = (path, body) => app.request('POST', path, { headers, body });
        const members = ['a', 'b'].map(id => ({ squadId: 'team', memberId: id, name: id }));
        const { res: created } = await post('/marshal/groups/create', { name: 'Group', members });
        assert.equal(created.status, 200);
        const { id } = created.json().group;
        const { res: bound } = await post('/marshal/groups/bind', { id, key: 'sse-test/team/a', sessionId: 'session-a' });
        assert.equal(bound.status, 200);
        const { res } = await app.request('GET', '/marshal/events', { headers });
        const changed = event('groups.changed');
        const messages = () => JSON.parse(readFileSync(join(app.root, 'groups.json'), 'utf8')).groups[0].messages;
        const sending = post('/marshal/groups/send', { id, text: 'private user message' });
        await Promise.race([prompting.promise, sending.then(() => assert.fail('send finished without calling prompt'))]);
        assert.deepEqual(res.chunks, [ready, changed]);
        assert.equal(messages()[0].author, 'user');
        assert.deepEqual(messages()[0].deliveries, []);

        delivery.resolve();
        assert.equal((await sending).res.status, 200);
        assert.deepEqual(res.chunks, [ready, changed, changed]);
        assert.equal(messages()[0].deliveries[0].state, 'accepted');
        reply = {
            seq: 1, type: 'assistant/message', surfaceOp: 'append',
            data: { message: { content: [{ type: 'text', text: 'private asynchronous reply' }] } },
        };
        assert.equal(typeof poll, 'function');
        await poll();
        assert.deepEqual(res.chunks, [ready, changed, changed, changed]);
        assert.equal(messages()[1].author, 'member');
        assert.equal(messages()[1].text, 'private asynchronous reply');
    } finally {
        delivery.resolve();
        app.dispose();
        timer.mock.restore();
    }
});

test('room route pushes cursor metadata only to sessions that can read the room', async () => {
    const app = fixture();
    const previousHome = process.env.DSH_HOME;
    try {
        process.env.DSH_HOME = app.root;
        mkdirSync(join(app.root, 'storages'));
        writeFileSync(join(app.root, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { workspace: {} } } }));
        const headers = await app.signIn();
        const { res: created } = await app.request('POST', '/marshal/tasks/create', { body: { title: '测试工单群实时状态推送' } });
        assert.equal(created.status, 200);
        const taskId = created.json().tasks[0].id;
        const { res: owner } = await app.request('GET', '/marshal/events', { headers });
        app.setUserId('different-account');
        const { res: other } = await app.request('GET', '/marshal/events', { headers: await app.signIn() });
        assert.equal(other.status, 200);
        const open = () => app.request('POST', '/marshal/task-rooms/open', { headers, body: { taskId, workspaceId: 'workspace' } });
        const { res: opened } = await open();
        assert.equal(opened.status, 200, opened.chunks.join(''));
        const roomId = opened.json().room.id;
        const roomFrame = seq => `event: room.message\ndata: ${JSON.stringify({ roomId, seq })}\n\n`;
        const invalidations = [event('tasks.changed'), event('incidents.changed')];
        assert.deepEqual(owner.chunks, [ready, roomFrame(0), ...invalidations]);
        assert.deepEqual(other.chunks, [ready, ...invalidations]);
        const { res: reopened } = await open();
        assert.equal(reopened.status, 200);
        assert.equal(reopened.json().room.id, roomId);
        assert.deepEqual(owner.chunks, [ready, roomFrame(0), ...invalidations]);
        assert.deepEqual(other.chunks, [ready, ...invalidations]);

        const close = () => app.request('POST', '/marshal/task-rooms/action', { headers, body: { roomId, action: 'close' } });
        const { res: closed } = await close();
        assert.equal(closed.status, 200);
        const { res: alreadyClosed } = await close();
        assert.equal(alreadyClosed.status, 200);
        const { res: confirmed } = await app.request('POST', '/marshal/task-rooms/action', { headers, body: { roomId, action: 'confirm' } });
        assert.equal(confirmed.status, 200);
        assert.deepEqual(owner.chunks, [ready, roomFrame(0), ...invalidations, roomFrame(1), ...invalidations]);
        assert.deepEqual(other.chunks, [ready, ...invalidations, ...invalidations]);
    } finally {
        if (previousHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previousHome;
        app.dispose();
    }
});

test('room writes and workflow transitions publish invalidations after persistence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-sse-producers-'));
    const bus = createMarshalEventBus();
    const observed = [];
    bus.subscribe((topic, payload) => observed.push([topic, payload]));
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'rooms.sqlite')), deviceId: 'test', eventBus: bus, now: () => 123 });
    const orchestration = createTaskOrchestration({ file: join(root, 'workflow.json'), eventBus: bus });
    try {
        const room = rooms.ensure('local', { id: 'card', title: 'Task' }, 'workspace', 'owner');
        const runId = randomUUID();
        await rooms.begin(room.id, runId, 'Marshal', 'start', 'private batch text');
        const message = { id: 'message', kind: 'user', runId, actor: 'owner', text: 'private user text' };
        const record = await rooms.append(room.id, message);
        // A byte-identical replay (including its timestamp) keeps the original cursor.
        await rooms.begin(room.id, runId, 'Marshal', 'start', 'private batch text');
        assert.deepEqual(await rooms.append(room.id, message), record);
        await assert.rejects(rooms.append(room.id, { ...message, text: 'conflicting replay' }), { code: 'task-room-conflict' });
        assert.deepEqual(observed, [
            ['room.message', { roomId: room.id, seq: 1 }],
            ['room.message', { roomId: room.id, seq: 2 }],
        ]);
        orchestration.attach('local', 'card', { state: 'handed-off', phase: 'handoff' });
        orchestration.syncStatus('local', 'card', 'review');
        assert.equal(orchestration.view('local', 'card').state, 'review-blocked');
        orchestration.syncStatus('local', 'card', 'review'); // no state/phase transition
        assert.deepEqual(observed.slice(2), [['tasks.changed', {}], ['incidents.changed', {}]]);
    } finally {
        orchestration.dispose();
        rooms.close();
        bus.dispose();
        rmSync(root, { recursive: true, force: true });
    }
});
