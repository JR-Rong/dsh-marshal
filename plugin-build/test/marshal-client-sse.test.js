import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const readClient = name => readFileSync(new URL(`../client/${name}.js`, import.meta.url), 'utf8');
const source = ['00-core-bootstrap', '30-ui-kit', '32-sse-client', '40-groups', '42-task-room-shared', '45-trace-and-markdown', '50-tasks']
    .map(name => readClient(`src/${name}`)).concat(readClient('setup')).join('\n');
const flush = () => new Promise(resolve => setImmediate(resolve));
const encoder = new TextEncoder();

function harness(t, baseURI = 'dsh-app://app/', { session, route, React } = {}) {
    const sessions = [], requests = [];
    const timers = new Map();
    let nextTimer = 0;
    const events = new EventTarget(), windowEvents = new EventTarget();
    const document = {
        baseURI, cookie: '', visibilityState: 'visible',
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        getElementById: () => ({}),
    };
    const window = {
        location: new URL(baseURI),
        addEventListener: windowEvents.addEventListener.bind(windowEvents),
        removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    };
    const api = runInNewContext(source + '\n({ subscribeMarshalEvents, disposeAllMarshalSse, CrossGroupsPage, TaskRoomsPage, marshalSetup })', {
        URL, URLSearchParams, AbortController, TextDecoder, document, window, React, h: React?.createElement,
        Math: Object.create(Math, { random: { value: () => 0.5 } }),
        setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
        setInterval() {}, clearInterval() {}, // Local message reveal animation.
        async fetch(url, init) {
            if (String(url).endsWith('/marshal/memory/session')) {
                sessions.push(init);
                const n = sessions.length;
                if (session) return session(n);
                return Promise.resolve(Response.json({ ok: true, sessionToken: 'session-' + n, csrf: 'csrf-' + n }));
            }
            if (!String(url).endsWith('/marshal/events')) return route?.(new URL(url), init);
            return new Promise(resolve => requests.push({ url, init, resolve }));
        },
    });
    t.after(api.disposeAllMarshalSse);
    function respond(index, status = 200) {
        let writer;
        const body = new ReadableStream({ start(controller) { writer = controller; } });
        requests[index].resolve(new Response(body, { status }));
        return { bytes: bytes => writer.enqueue(bytes), send: text => writer.enqueue(encoder.encode(text)),
            close: () => writer.close(), fail: () => writer.error(new Error('network lost')) };
    }
    async function tick(baseDelay) {
        // Fixed 125ms jitter from the mocked random value.
        await fire(baseDelay < 1000 ? baseDelay : baseDelay + 125);
    }
    async function fire(delay) {
        const pending = [...timers].find(([, entry]) => entry.delay === delay);
        assert.ok(pending, `expected timer with delay ${delay}`);
        timers.delete(pending[0]);
        pending[1].fn();
        await flush();
    }
    return { ...api, sessions, requests, document, timers, respond, tick, fire,
        focus: () => windowEvents.dispatchEvent(new Event('focus')),
        visibility(state) {
            document.visibilityState = state;
            events.dispatchEvent(new Event('visibilitychange'));
        } };
}

test('shares one desktop fetch, forwards session headers, and dispatches chunked SSE frames by topic', async t => {
    const { subscribeMarshalEvents: subscribe, sessions, requests, respond, timers } = harness(t);
    const tasks = [], groups = [], all = [], late = [];
    const taskOff = subscribe(['tasks.changed'], (topic, data) => tasks.push([topic, data.text]));
    const groupOff = subscribe(['groups.changed'], (topic, data) => groups.push([topic, data.revision]));
    const allOff = subscribe('*', topic => all.push(topic));
    const failingOff = subscribe('*', () => { throw new Error('listener failure'); });
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].headers['x-marshal-desktop'], '1');
    assert.equal(requests[0].url, 'dsh-app://app/marshal/events');
    const { headers, credentials, signal } = requests[0].init;
    assert.equal(credentials, 'same-origin');
    assert.equal(headers.accept, 'text/event-stream');
    assert.equal(headers['x-marshal-desktop'], '1');
    assert.equal(headers['x-marshal-session'], 'session-1');
    assert.equal(headers['x-marshal-csrf'], 'csrf-1');

    const stream = respond(0);
    stream.send(': ping\r\n\r\n');
    stream.send('event: ready\ndata: {}\n\nevent: tasks.changed\ndata: broken\n\n');
    const bytes = encoder.encode('event: tasks.changed\r\ndata: {"text":\r\ndata: "群"}\r\n\r\n');
    for (const byte of bytes) stream.bytes(Uint8Array.of(byte));
    stream.send('event: groups.changed\ndata: {"revision":3}\n');
    stream.send('\n');
    await flush();
    assert.deepEqual(tasks, [['tasks.changed', '群']]);
    assert.deepEqual(groups, [['groups.changed', 3]]);
    assert.deepEqual(all, ['ready', 'tasks.changed', 'groups.changed']);
    const lateOff = subscribe(['ready'], topic => late.push(topic));
    assert.deepEqual(late, ['ready'], 'joining an active connection gets ready without a new fetch');

    taskOff();
    groupOff();
    allOff();
    failingOff();
    assert.equal(signal.aborted, false);
    lateOff();
    lateOff();
    assert.equal(signal.aborted, true);
    await flush();
    assert.equal(timers.size, 0);
    assert.equal(requests.length, 1);
});

for (const status of [401, 403]) {
    test(`${status} refreshes desktop credentials once, then reconnects with backoff`, async t => {
        const { subscribeMarshalEvents: subscribe, sessions, requests, respond, tick, timers } = harness(t);
        const ready = [];
        const off = subscribe(['ready'], topic => ready.push(topic));
        await flush();
        respond(0, status);
        await flush();
        assert.equal(sessions.length, 2);
        await tick(1000);
        assert.equal(requests[1].init.headers['x-marshal-session'], 'session-2');
        assert.equal(requests[1].init.headers['x-marshal-csrf'], 'csrf-2');
        respond(1, status);
        await flush();
        assert.equal(sessions.length, 2, 'repeated rejection must not open a new session each time');
        await tick(2000);
        const stream = respond(2);
        stream.send('event: ready\ndata: {}\n\n');
        stream.close();
        await flush();
        assert.deepEqual(ready, ['ready']);
        await tick(5000);
        respond(3).fail();
        await flush();
        await tick(15000);
        respond(4).send('event: ready\ndata: {}\n\n');
        await flush();
        assert.deepEqual(ready, ['ready', 'ready']);
        off();
        assert.equal(requests[4].init.signal.aborted, true);
        assert.equal(timers.size, 0);
    });

    test(`pauses SSE if the session refresh itself returns ${status}`, async t => {
        const h = harness(t, undefined, { session: n => n === 1
            ? Response.json({ ok: true, sessionToken: 'first', csrf: 'first' })
            : Response.json({ ok: false, code: 'account-unavailable' }, { status }) });
        const off = h.subscribeMarshalEvents('*', () => {});
        await flush();
        h.respond(0, 401);
        await flush();
        assert.equal(h.sessions.length, 2);
        assert.equal(h.timers.size, 0, 'no reconnect timer after a credential rejection');
        const otherOff = h.subscribeMarshalEvents('ready', () => {});
        await flush();
        assert.equal(h.sessions.length, 2);
        assert.equal(h.requests.length, 1);
        off();
        otherOff();
        assert.equal(h.requests[0].init.signal.aborted, true);
    });

    test(`recovers a ${status}-paused SSE stream automatically on focus or re-login`, async t => {
        let authed = false;
        const ready = [];
        const h = harness(t, undefined, { session: n => {
            if (n === 1) return Response.json({ ok: true, sessionToken: 'stale', csrf: 'stale' });
            if (!authed) return Response.json({ ok: false, code: 'account-unavailable' }, { status });
            return Response.json({ ok: true, sessionToken: 'fresh-' + n, csrf: 'csrf-' + n });
        } });
        const off = h.subscribeMarshalEvents(['ready'], topic => ready.push(topic));
        await flush();
        h.respond(0, 401);
        await flush();
        assert.equal(h.sessions.length, 2);
        assert.equal(h.timers.size, 0);

        authed = true;
        h.focus();
        await flush();
        assert.equal(h.sessions.length, 3);
        assert.equal(h.requests.length, 2);
        assert.equal(h.requests[1].init.headers['x-marshal-session'], 'fresh-3');
        h.respond(1).send('event: ready\ndata: {}\n\n');
        await flush();
        assert.deepEqual(ready, ['ready']);
        off();
        assert.equal(h.timers.size, 0);
    });
}

test('keeps refreshing with backoff after a transient session failure, then uses the new proof', async t => {
    const h = harness(t, undefined, { session: n => {
        if (n === 2 || n === 3) throw new TypeError('network unavailable');
        return Response.json({ ok: true, sessionToken: `session-${n}`, csrf: `csrf-${n}` });
    } });
    const off = h.subscribeMarshalEvents('*', () => {});
    await flush();
    h.respond(0, 403);
    await flush();
    assert.equal(h.sessions.length, 2);
    await h.tick(1000);
    assert.equal(h.sessions.length, 3);
    assert.equal(h.requests.length, 1, 'does not reconnect without a refreshed proof');
    await h.tick(2000);
    assert.equal(h.sessions.length, 4);
    assert.equal(h.requests[1].init.headers['x-marshal-session'], 'session-4');
    h.respond(1, 403);
    await flush();
    assert.equal(h.sessions.length, 4);
    assert.equal(h.timers.size, 1);
    off();
    assert.equal(h.timers.size, 0);
});

test('coalesces refreshes following an in-flight read and globally disposes timers and streams by base', async t => {
    const { subscribeMarshalEvents: subscribe, disposeAllMarshalSse: dispose, requests, respond, tick, timers, document } =
        harness(t, 'https://example.test/client/');
    document.cookie = 'marshal-memory-csrf=browser-proof';
    const calls = [];
    let finish;
    const off = subscribe(['ready', 'room.message'], topic => {
        calls.push(topic);
        if (topic === 'initial') return new Promise(resolve => { finish = resolve; });
    }, { initial: true, debounceMs: 80 });
    assert.deepEqual(calls, ['initial']);
    assert.equal(requests[0].url, 'https://example.test/client/marshal/events');
    assert.equal(requests[0].init.headers['x-marshal-csrf'], 'browser-proof');
    assert.equal(requests[0].init.headers['x-marshal-desktop'], undefined);
    const stream = respond(0);
    stream.send('event: ready\ndata: {}\n\nevent: room.message\ndata: {}\n\nevent: room.message\ndata: {}\n\n');
    await flush();
    assert.equal(timers.size, 0, 'waits for the in-flight read');
    finish();
    await flush();
    await tick(80);
    assert.deepEqual(calls, ['initial', 'room.message']);
    stream.send('event: room.message\ndata: {}\n\n');

    document.baseURI = 'https://other.test/';
    const other = subscribe('*', () => {});
    assert.equal(requests[1].url, 'https://other.test/marshal/events');
    respond(1).close();
    await flush();
    assert.deepEqual([...timers.values()].map(timer => timer.delay).sort((a, b) => a - b), [80, 1125]);
    dispose();
    off();
    other();
    assert.equal(timers.size, 0);
    assert.ok(requests.every(request => request.init.signal.aborted));
    assert.deepEqual(calls, ['initial', 'room.message']);
});

test('shipped bundle has no legacy injected header or high-frequency network intervals', () => {
    const bundle = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(bundle, /ensureTaskboardHeader|headerTimer|marshal-taskboard-head/);
    for (const interval of bundle.matchAll(/\bsetInterval\([\s\S]*?,\s*([\d_]+)\s*\)/g)) {
        assert.ok(![350, 1000, 1600, 2000, 3000].includes(Number(interval[1].replaceAll('_', ''))), interval[0]);
    }
    assert.match(bundle, /ctx\.effect\(\(\) => \(\) => \{\s*disposeAllMarshalSse\(\)/);
});

// Render the actual page functions and commit their hooks without requiring the DSH host.
function pageHooks() {
    const slots = [];
    let index, dirty, effects, tree;
    const React = {
        Fragment: Symbol('Fragment'),
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState(initial) {
            const slot = slots[index++] ??= { value: initial };
            return [slot.value, update => {
                const value = typeof update === 'function' ? update(slot.value) : update;
                if (!Object.is(slot.value, value)) dirty = true;
                slot.value = value;
            }];
        },
        useRef(initial) { return slots[index++] ??= { current: initial }; },
        useMemo(fn) { return fn(); },
        useEffect(fn, deps) {
            const slot = slots[index++] ??= {};
            if (deps && deps.length === slot.deps?.length && deps.every((dep, i) => Object.is(dep, slot.deps[i]))) return;
            effects.push(() => { slot.cleanup?.(); slot.deps = deps; slot.cleanup = fn(); });
        },
    };
    return {
        React,
        mount(Page, props = {}) {
            function render() {
                dirty = false;
                index = 0;
                effects = [];
                tree = Page(props);
                for (const effect of effects) effect();
            }
            render();
            return {
                async settle() {
                    do {
                        await flush();
                        if (!dirty) break;
                        render();
                    } while (true);
                },
                find(predicate) {
                    function* nodes(node) {
                        if (Array.isArray(node)) for (const child of node) yield* nodes(child);
                        else if (node?.children) {
                            yield node;
                            yield* nodes(node.children);
                        }
                    }
                    return [...nodes(tree)].find(predicate);
                },
                unmount() { for (const slot of slots) slot.cleanup?.(); },
            };
        },
    };
}

const buttonNamed = text => node => node.type === 'button' && node.children.includes(text);
const crossDelay = 12_375, roomDelay = 5_375;

test('visible cross-device page picks up a Hub message without local SSE, and cancels hidden reads', async t => {
    const hooks = pageHooks();
    const group = { id: 'hub-group', name: 'Remote', members: [], messages: [] };
    const signals = [];
    let block = false, finish;
    const state = () => Response.json({ groups: [group] });
    const h = harness(t, undefined, { React: hooks.React, route(url, { signal }) {
        if (url.pathname.endsWith('/catalog')) return Response.json({ devices: [] });
        assert.ok(url.pathname.endsWith('/state'));
        signals.push(signal);
        return block ? new Promise(resolve => { finish = resolve; }) : state();
    } });
    const page = hooks.mount(h.CrossGroupsPage);
    await page.settle();
    h.respond(0).send('event: ready\ndata: {}\n\n');
    await flush();
    await h.tick(80);
    page.find(buttonNamed('Remote · 0 人')).props.onClick();
    await page.settle();
    const initialReads = signals.length;
    group.messages.push({ id: 'remote-message', author: 'Other device', role: 'agent', at: 0, text: 'From Hub', streaming: true });
    await h.fire(crossDelay);
    await page.settle();
    assert.equal(signals.length, initialReads + 1);
    assert.ok(page.find(node => node.children.includes('From Hub')));

    block = true;
    await h.fire(crossDelay);
    const inFlight = signals.length;
    page.find(buttonNamed('刷新')).props.onClick();
    await flush();
    assert.equal(signals.length, inFlight, 'manual refresh does not overlap the fallback');
    h.visibility('hidden');
    assert.equal(signals.at(-1).aborted, true);
    finish(state());
    await flush();
    assert.equal(h.timers.size, 0, 'hiding cancels the timer and queued refresh');
    h.visibility('visible');
    await flush();
    assert.equal(signals.length, inFlight + 1, 'visibility restores refresh');
    page.unmount();
    assert.equal(signals.at(-1).aborted, true);
    finish(state());
    await flush();
    assert.equal(h.timers.size, 0);
});

function mountRoom(t, readPage) {
    const hooks = pageHooks();
    const reads = [];
    const h = harness(t, 'https://marshal.test/', { React: hooks.React, route(url, { signal }) {
        switch (url.pathname.split('/').at(-1)) {
            case 'workspaces': return Response.json({ workspaces: [{ id: 'ws' }] });
            case 'orchestration': return Response.json({ leaders: [] });
            case 'list': return Response.json({ rooms: [{ id: 'a', title: 'Room A' }, { id: 'b', title: 'Room B' }] });
            case 'page': {
                const read = { id: url.searchParams.get('roomId'), after: url.searchParams.get('after'), signal };
                reads.push(read);
                return readPage(read, reads.length);
            }
            default: throw new Error(`unexpected route: ${url.pathname}`);
        }
    } });
    h.document.cookie = 'marshal-memory-csrf=proof';
    const page = hooks.mount(h.TaskRoomsPage, { task: { taskRoom: { id: 'a', workspaceId: 'ws' } } });
    return { ...h, reads, page };
}

const roomPage = ({ id = 'a', seqs = [], ...rest } = {}) => Response.json({
    room: { id, title: `Room ${id}` },
    records: seqs.map(seq => ({ seq, kind: 'batch', at: 0, text: `record-${seq}` })),
    hasNewer: false,
    ...rest,
});

test('running room refreshes thinking, steps and streaming text multiple times in the same phase without SSE', async t => {
    let progress = 1, running = true, finish;
    const response = () => roomPage({
        runState: running ? 'running' : 'done',
        liveBubbles: running ? [{ id: 'live', actor: 'Coder', phase: 'coding',
            thinking: `thinking ${progress}`, steps: [{ label: `step ${progress}` }], text: `stream ${progress}` }] : [],
    });
    const h = mountRoom(t, () => progress === 4 ? new Promise(resolve => { finish = resolve; }) : response());
    const assertProgress = n => {
        const trace = h.page.find(node => node.props?.trace?.id === 'live')?.props.trace;
        assert.equal(trace?.phase, 'coding');
        assert.equal(trace.thinking, `thinking ${n}`);
        assert.equal(trace.steps[0].label, `step ${n}`);
        assert.ok(h.page.find(node => node.props?.text === `stream ${n}`));
    };
    await h.page.settle();
    assertProgress(1);
    for (progress of [2, 3]) {
        await h.fire(roomDelay);
        await h.page.settle();
        assertProgress(progress);
    }
    progress = 4;
    await h.fire(roomDelay);
    h.visibility('hidden');
    assert.equal(h.reads.at(-1).signal.aborted, true);
    finish(response());
    await h.page.settle();
    assertProgress(3);
    assert.equal(h.timers.size, 0);
    running = false;
    progress = 5;
    h.visibility('visible');
    await h.page.settle();
    assert.ok(!h.page.find(node => node.props?.trace?.id === 'live'));
    assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [crossDelay], 'open idle room switches from 5s to 12s cross-device fallback');
    h.page.unmount();
});

test('non-originating open task room converges on cross-device messages at 12s and stops when closed', async t => {
    let closed = false;
    let seqs = [1];
    const h = mountRoom(t, () => roomPage({ seqs, origin: false, room: { id: 'a', title: 'Room a', closed } }));
    await h.page.settle();
    assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [crossDelay]);

    seqs = [1, 2];
    await h.fire(crossDelay);
    await h.page.settle();
    assert.ok(h.page.find(node => node.children.some(child => typeof child === 'string' && child.includes('record-2'))));

    closed = true;
    await h.fire(crossDelay);
    await h.page.settle();
    assert.equal(h.timers.size, 0, 'closed task room stops polling');
    h.page.unmount();
});

test('reconnect ready drains newer room pages serially, stopping on failure or a stalled cursor', async t => {
    let resolveFirst;
    const h = mountRoom(t, (_, n) => {
        if (n === 1) return roomPage({ seqs: [2] });
        if (n === 2) return new Promise(resolve => { resolveFirst = resolve; });
        if (n === 3) return roomPage({ seqs: [5, 6], hasNewer: true });
        if (n === 4) return roomPage({ seqs: [7] });
        if (n === 5) return roomPage({ seqs: [8], hasNewer: true });
        if (n === 6) return Promise.reject(new Error('Room read failed'));
        return roomPage({ seqs: [8], hasNewer: true });
    });
    await h.page.settle();
    h.respond(0).close();
    await flush();
    await h.tick(1000);
    h.respond(1).send('event: ready\ndata: {}\n\n');
    await flush();
    await h.tick(80);
    assert.deepEqual(h.reads.map(read => read.after), [null, '2']);
    resolveFirst(roomPage({ seqs: [3, 4], hasNewer: true }));
    await h.page.settle();
    assert.deepEqual(h.reads.map(read => read.after), [null, '2', '4', '6']);
    for (const seq of [2, 3, 4, 5, 6, 7]) {
        assert.ok(h.page.find(node => node.children.some(child => typeof child === 'string' && child.includes(`record-${seq}`))));
    }
    h.page.find(buttonNamed('刷新')).props.onClick();
    await h.page.settle();
    assert.deepEqual(h.reads.map(read => read.after), [null, '2', '4', '6', '7', '8']);
    assert.ok(h.page.find(node => node.children.includes('Room read failed')));
    h.page.find(buttonNamed('刷新')).props.onClick();
    await h.page.settle();
    assert.deepEqual(h.reads.map(read => read.after), [null, '2', '4', '6', '7', '8', '8']);
    h.page.unmount();
});

test('switching rooms or unmounting aborts pagination and ignores stale responses', async t => {
    const pending = [];
    const h = mountRoom(t, () => new Promise(resolve => pending.push(resolve)));
    await h.page.settle();
    pending[0](roomPage({ seqs: [1], hasNewer: true }));
    await h.page.settle();
    assert.deepEqual(h.reads.map(read => [read.id, read.after]), [['a', null], ['a', '1']]);
    h.page.find(node => node.type === 'button' && node.props?.key === 'b').props.onClick();
    await h.page.settle();
    assert.equal(h.reads[1].signal.aborted, true);
    pending[1](roomPage({ seqs: [2], hasNewer: true }));
    await h.page.settle();
    assert.deepEqual(h.reads.map(read => [read.id, read.after]), [['a', null], ['a', '1'], ['b', null]]);
    h.page.unmount();
    assert.equal(h.reads[2].signal.aborted, true);
    pending[2](roomPage({ id: 'b', seqs: [1], hasNewer: true }));
    await flush();
    assert.equal(h.reads.length, 3);
    assert.equal(h.timers.size, 0);
});

test('an initially empty room catches up from sequence zero instead of jumping to the newest page', async t => {
    const h = mountRoom(t, (_, n) => n === 1 ? roomPage()
        : n === 2 ? roomPage({ seqs: [1], hasNewer: true }) : roomPage({ seqs: [2] }));
    await h.page.settle();
    h.page.find(buttonNamed('刷新')).props.onClick();
    await h.page.settle();
    assert.deepEqual(h.reads.map(read => read.after), [null, '0', '1']);
    h.page.unmount();
});

test('pre-auth setup checks immediately on focus, backs off on failure and stops when ready', async t => {
    const hooks = pageHooks();
    const signals = [];
    let finish;
    const h = harness(t, undefined, { route(url, { signal }) {
        assert.equal(url.pathname, '/marshal/setup');
        signals.push(signal);
        if (signals.length === 1) return Promise.reject(new Error('offline'));
        return new Promise(resolve => { finish = resolve; });
    } });
    const { Setup } = h.marshalSetup(hooks.React);
    let ready = 0;
    const page = hooks.mount(Setup, { initial: {}, onReady: () => ready++ });
    assert.ok([...h.timers.values()].some(timer => timer.delay === 3500));
    h.focus();
    await page.settle();
    assert.equal(signals.length, 1);
    assert.ok([...h.timers.values()].some(timer => timer.delay === 7000));
    h.focus();
    h.focus();
    await flush();
    assert.equal(signals.length, 2);
    finish(Response.json({ ready: true }));
    await page.settle();
    assert.equal(ready, 1);
    assert.equal(h.timers.size, 0);
    page.unmount();
    assert.equal(signals.at(-1).aborted, true);
});
