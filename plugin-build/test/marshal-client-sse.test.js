import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const readClient = name => readFileSync(new URL(`../client/${name}.js`, import.meta.url), 'utf8');
const source = ['00-core-bootstrap', '15-sidebar-left', '30-ui-kit', '32-sse-client', '40-groups', '42-task-room-shared', '45-trace-and-markdown', '48-ticket-room-vnext', '50-tasks', '20-memory']
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
    const api = runInNewContext(source + '\n({ subscribeMarshalEvents, disposeAllMarshalSse, CrossGroupsPage, mvTicketConversation, MemoryPage, marshalSetup })', {
        URL, URLSearchParams, AbortController, AbortSignal, DOMException, TextDecoder, document, window, React, h: React?.createElement,
        Math: Object.create(Math, { random: { value: () => 0.5 } }),
        setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
        setInterval() {}, clearInterval() {}, // Local message reveal animation.
        async fetch(url, init) {
            if (String(url).endsWith('/marshal/memory/session')) {
                sessions.push(init);
                const n = sessions.length;
                if (session) return session(n, init);
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
    let slots = [];
    let index, dirty, effects, tree;
    const React = {
        Fragment: Symbol('Fragment'),
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState(initial) {
            const slot = slots[index++] ??= { value: typeof initial === 'function' ? initial() : initial };
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
                unmount() { for (const slot of slots) slot.cleanup?.(); slots = []; },
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
    const mount = (roomId = 'a') => hooks.mount(h.mvTicketConversation, { roomId, workspace: 'ws' });
    return { ...h, reads, page: mount(), mount };
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
        busy: running, runState: running ? 'running' : 'done',
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
    assert.ok(h.page.find(node => node.props?.text?.includes('record-2')));

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
        assert.ok(h.page.find(node => node.props?.text?.includes(`record-${seq}`)));
    }
    h.page.find(node => node.props?.label === '刷新').props.onClick();
    await h.page.settle();
    assert.deepEqual(h.reads.map(read => read.after), [null, '2', '4', '6', '7', '8']);
    assert.ok(h.page.find(node => node.children.includes('Room read failed')));
    h.page.find(node => node.props?.label === '刷新').props.onClick();
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
    h.page.unmount();
    const next = h.mount('b'); // The archive selector remounts the keyed conversation.
    await next.settle();
    assert.equal(h.reads[1].signal.aborted, true);
    pending[1](roomPage({ seqs: [2], hasNewer: true }));
    await h.page.settle();
    assert.deepEqual(h.reads.map(read => [read.id, read.after]), [['a', null], ['a', '1'], ['b', null]]);
    next.unmount();
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
    h.page.find(node => node.props?.label === '刷新').props.onClick();
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

test('memory.changed refreshes the visible memory workbench and unmount aborts graph and SSE reads', async t => {
    const hooks = pageHooks();
    let calls = 0, resolveGraph;
    const signals = [];
    const h = harness(t, 'https://marshal.test/', { React: hooks.React, route(url, init) {
        const name = url.pathname.split('/').at(-1);
        switch (name) {
            case 'graph': {
                assert.equal(init.headers['x-marshal-csrf'], 'proof');
                assert.equal(url.searchParams.get('scope'), 'global');
                signals.push(init.signal);
                if (++calls === 2) return new Promise(resolve => { resolveGraph = resolve; });
                return Response.json({ graph: { nodes: [], edges: [] } });
            }
            case 'state': return Response.json({ teams: [] });
            case 'workspaces': return Response.json({ workspaces: [] });
            case 'get': return Response.json({});
            case 'health': return Response.json({ health: [] });
            case 'proposals': return Response.json({ proposals: [] });
            default: throw new Error(`unexpected route: ${url}`);
        }
    } });
    h.document.cookie = 'marshal-memory-csrf=proof';
    let closes = 0;
    const page = hooks.mount(h.MemoryPage, { closeMemorySidebar: () => { closes++; } });
    await page.settle();
    assert.equal(calls, 1);
    assert.equal(closes, 1);
    page.find(buttonNamed('暂停漂移')).props.onClick();
    await page.settle();
    assert.equal(page.find(node => node.type?.name === 'MemoryGalaxy').props.paused, true);
    page.find(buttonNamed('恢复漂移')).props.onClick();
    await page.settle();
    assert.equal(page.find(node => node.type?.name === 'MemoryGalaxy').props.paused, false);
    h.respond(0).send('event: memory.changed\ndata: {}\n\n');
    await flush();
    assert.equal(calls, 2);
    page.unmount();
    assert.equal(signals[1].aborted, true);
    assert.equal(h.requests[0].init.signal.aborted, true);
    resolveGraph(Response.json({ graph: { nodes: [], edges: [] } }));
    await flush();
    assert.equal(h.timers.size, 0);
});

test('unmount cancels the cold memory handshake without waiting for a response', async t => {
    const hooks = pageHooks();
    let librarySignal;
    const h = harness(t, undefined, { React: hooks.React, session: (_, { signal }) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    route(url, { signal }) {
        assert.equal(url.pathname, '/dsh-agents/api/state');
        librarySignal = signal;
        return Response.json({ teams: [] });
    } });
    const page = hooks.mount(h.MemoryPage);
    await page.settle();
    assert.equal(h.sessions.length, 1, 'graph, workbench and SSE share the handshake');
    assert.equal(h.sessions[0].signal.aborted, false);
    assert.ok(librarySignal instanceof AbortSignal);
    page.unmount();
    assert.equal(librarySignal.aborted, true);
    await flush();
    assert.equal(h.sessions[0].signal.aborted, true);
    assert.equal(h.requests.length, 0);
});

test('full canvas merges all accessible scopes and closes editing controls', async t => {
    const hooks = pageHooks();
    const nodes = ['global', 'workspace', 'agent'].map(scope => ({ id: scope, title: scope, scope, kind: 'fact' }));
    const h = harness(t, 'https://marshal.test/', { React: hooks.React, route(url) {
        const scope = url.searchParams.get('scope');
        switch (url.pathname) {
            case '/dsh-agents/api/state': return Response.json({ teams: [{ name: 'marshal-agent:test', members: [{ id: 'a' }] }] });
            case '/marshal/task-rooms/workspaces': return Response.json({ workspaces: [{ id: 'w', path: '/project' }] });
            case '/marshal/memory/graph':
            case '/marshal/memory/list':
            case '/marshal/memory/get':
                assert.equal(url.searchParams.get('workspaceId'), scope === 'workspace' ? 'w' : null);
                assert.equal(url.searchParams.get('agentId'), scope === 'agent' ? 'a' : null);
                if (url.pathname.endsWith('/list')) {
                    assert.equal(url.searchParams.get('query'), '匹配');
                    return Response.json({ items: nodes });
                }
                if (url.pathname.endsWith('/get')) {
                    assert.equal(url.searchParams.get('id'), scope);
                    return Response.json({ item: { ...nodes.find(node => node.scope === scope), content: '正文' } });
                }
                return Response.json({ graph: { nodes } });
            default: return Response.json({ settings: {} });
        }
    } });
    h.document.cookie = 'marshal-memory-csrf=proof';
    let closes = 0;
    const page = hooks.mount(h.MemoryPage, { closeMemorySidebar: () => { closes++; } });
    const galaxy = () => page.find(el => el.type?.name === 'MemoryGalaxy').props;
    const scopes = () => Array.from(galaxy().graph.nodes, node => node.scope);
    await page.settle();
    assert.deepEqual(scopes(), ['global']);
    page.find(buttonNamed('＋ 记忆')).props.onClick();
    page.find(buttonNamed('设置')).props.onClick();
    await page.settle();
    assert.ok(page.find(buttonNamed('取消')));
    page.find(buttonNamed('全画布')).props.onClick();
    await page.settle();
    assert.equal(closes, 2);
    assert.deepEqual(scopes(), ['global', 'workspace', 'agent']);
    assert.equal(page.find(buttonNamed('＋ 记忆')), undefined);
    assert.equal(page.find(buttonNamed('设置')), undefined);
    page.find(el => el.props?.placeholder === '搜索全域记忆…').props.onChange({ target: { value: '匹配' } });
    await page.settle();
    page.find(buttonNamed('搜索')).props.onClick();
    await page.settle();
    assert.deepEqual(scopes(), ['global', 'workspace', 'agent']);
    await galaxy().onSelect(nodes[1]);
    await page.settle();
    assert.ok(page.find(el => el.type === 'p' && el.children.includes('正文')));
    page.find(buttonNamed('退出全画布')).props.onClick();
    await page.settle();
    assert.deepEqual(scopes(), ['global']);
    assert.ok(page.find(buttonNamed('设置')));
    assert.equal(page.find(buttonNamed('取消')), undefined);
    assert.equal(page.find(el => el.props?.placeholder === 'empty = 本地'), undefined);
    page.unmount();
});

test('galaxy drifts slowly, brakes on hover and drag, pauses, and releases its canvas resources', () => {
    const refs = [], listeners = new Map(), frames = new Map(), effects = [];
    let hook, effect, nextFrame = 0, cancelled = 0, point, selected, captured, schemeChange;
    let ink = '#303030', paintedInk, hostThemeChange;
    let resize, resizeDisconnects = 0;
    const host = {};
    const ctx = {
        setTransform() {}, clearRect() {}, beginPath() {}, fill() {}, fillText() { paintedInk = this.fillStyle; },
        arc(x, y) { point = { clientX: x, clientY: y }; },
    };
    const canvas = {
        clientWidth: 600, clientHeight: 480, style: {}, parentElement: host, getContext: () => ctx,
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener(type, fn) { assert.equal(listeners.get(type), fn); listeners.delete(type); },
        setPointerCapture(id) { captured = id; },
        hasPointerCapture(id) { return captured === id; },
        releasePointerCapture() { captured = undefined; },
    };
    const Galaxy = runInNewContext(readClient('src/20-memory') + '\nMemoryGalaxy', {
        React: {
            useRef(value) { return refs[hook++] ??= { current: value }; },
            useMemo(run) { return run(); },
            useEffect(run, deps) {
                const index = effect++;
                const previous = effects[index];
                if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
                previous?.cleanup?.();
                effects[index] = { deps, cleanup: run() };
            },
        },
        h: () => null,
        dswTheme: { layer: 'transparent', layer3: 'transparent' },
        window: {
            getComputedStyle: () => ({ color: ink, getPropertyValue: () => '' }),
            matchMedia: () => ({
                addEventListener(type, fn) { assert.equal(type, 'change'); schemeChange = fn; },
                removeEventListener(type, fn) { assert.equal(fn, schemeChange); schemeChange = undefined; },
            }),
        },
        MutationObserver: class {
            constructor(fn) { hostThemeChange = fn; }
            observe(target, options) {
                assert.equal(target, host);
                assert.ok(options.attributeFilter.includes('data-theme'));
            }
            disconnect() { hostThemeChange = undefined; }
        },
        ResizeObserver: class {
            constructor(fn) { resize = fn; }
            observe(target) { assert.equal(target, canvas); }
            disconnect() { resizeDisconnects++; }
        },
        requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; },
        cancelAnimationFrame(id) { cancelled++; frames.delete(id); },
    });
    const graph = { nodes: [{ id: 'a', title: '记忆', scope: 'global', kind: 'fact' }] };
    refs[0] = { current: canvas };
    const render = (paused, data = graph) => { hook = effect = 0; Galaxy({ graph: data, paused, onSelect: node => { selected = node.id; } }); };
    const frame = () => {
        const [[id, draw]] = frames;
        frames.delete(id);
        const before = refs[2].current.yaw;
        draw();
        return refs[2].current.yaw - before;
    };
    const fire = (type, props = {}) => listeners.get(type)({ ...point, button: 0, pointerId: 1, type, ...props });
    render(false);
    assert.ok(Math.abs(frame() - 0.00028) < 1e-12);
    fire('pointermove');
    const hoverStep = frame();
    assert.ok(hoverStep > 0 && hoverStep < 0.00028);
    render(false, { nodes: [{ ...graph.nodes[0], title: '刷新' }] });
    assert.ok(frame() < hoverStep);
    fire('pointerdown');
    fire('pointerleave');
    const dragStep = frame();
    assert.ok(dragStep > 0 && dragStep < hoverStep);
    render(false, { ...graph });
    assert.equal(captured, 1);
    assert.ok(frame() < dragStep);
    fire('pointerup');
    assert.equal(selected, 'a');
    fire('pointerleave');
    render(true);
    assert.equal(frame(), 0);
    assert.equal(frames.size, 0, 'paused galaxy does not queue another frame');
    resize();
    assert.equal(frames.size, 1);
    assert.equal(frame(), 0);
    assert.equal(frames.size, 0, 'a resize paints once without restarting paused drift');
    ink = '#eeeeee';
    hostThemeChange();
    schemeChange();
    assert.equal(frames.size, 1);
    assert.equal(frame(), 0);
    assert.equal(paintedInk, ink);
    assert.equal(frames.size, 0, 'a theme change does not restart drift');
    const yaw = refs[2].current.yaw;
    fire('pointerdown');
    fire('pointermove', { clientX: point.clientX + 20 });
    assert.ok(refs[2].current.yaw > yaw, 'manual orbit still works while paused');
    fire('pointercancel');
    assert.equal(frame(), 0);
    assert.equal(frames.size, 0, 'paused interaction paints only one frame');
    render(false);
    assert.ok(frame() > 0);
    fire('pointermove');
    for (let i = 0; frames.size && i < 100; i++) frame();
    assert.equal(frames.size, 0, 'hover stops scheduling once braking is complete');
    schemeChange();
    assert.equal(frame(), 0);
    assert.equal(frames.size, 0, 'theme change preserves hover braking');
    fire('pointerleave');
    assert.ok(frame() > 0, 'leaving the node restarts drift');
    fire('pointerdown');
    for (const entry of effects) entry.cleanup?.();
    assert.equal(captured, undefined);
    assert.equal(cancelled, 1);
    assert.equal(frames.size, 0);
    assert.equal(listeners.size, 0);
    assert.equal(schemeChange, undefined);
    assert.equal(hostThemeChange, undefined);
    assert.equal(resizeDisconnects, 1);
});

test('memory bundle keeps ordering, workspace TDZ, and the main panel error boundary', () => {
    const bundle = readClient('index');
    const start = bundle.indexOf('function MemoryPage(');
    const end = bundle.indexOf('function AgentDirectChatsView(');
    assert.ok(start >= 0 && end > start);
    const page = bundle.slice(start, end);
    assert.equal(page.indexOf('realWorkspaces'), page.indexOf('const realWorkspaces = React.useMemo') + 'const '.length);
    assert.match(page, /isPseudoAgentWorkspace\(ws\)/);
    for (const label of ['全局记忆与审批', '智能体私有记忆', '工作区共享记忆']) assert.ok(page.includes(label));
    assert.match(readClient('src/60-agents'), /function SafeMarshalPanel\(props\)\s*\{\s*return h\(MarshalErrorBoundary, \{ resetKey: 'marshal-panel-root' \}, h\(MarshalPanel, props\)\);/);
    assert.match(readClient('src/70-plugin-register'), /h\(SafeMarshalPanel, props\)/);
    assert.doesNotMatch(bundle, /\b(?:AgentsPage|TaskRoomsPage)\b/);
    assert.match(bundle, /function TaskBoardPage\(/);
    assert.match(readClient('src/56-hub-agents'), /fetchJson\('marshal\/rosters\/save'/);
    assert.doesNotMatch(readClient('src/20-memory'), /\p{Extended_Pictographic}|\bsetInterval\b|\brequire\s*\(/u);
});

test('memory search filters the galaxy, resolves node details and keeps global proposal decisions usable', async t => {
    const hooks = pageHooks();
    const node = { id: 'a', title: '工作偏好', scope: 'global', kind: 'profile' };
    const decisions = [], proposals = ['approve-me', 'reject-me'].map(id => ({ id, title: id, content: '记忆' }));
    let resolveSearch, resolveDetail, resolveCatalog, resolveFailedSearch;
    let detailSignal;
    let holdDetail = false, reads = 0, detailReads = 0, writes = 0, remoteText = '已读取正文';
    const h = harness(t, 'https://marshal.test/', { React: hooks.React, route(url, init) {
        switch (url.pathname) {
            case '/dsh-agents/api/state': return Response.json({
                teams: [{ id: 'team', name: 'marshal-agent:team', members: [{ id: 'agent', name: '智能体' }] }],
            });
            case '/marshal/task-rooms/workspaces': return new Promise(resolve => { resolveCatalog = resolve; });
            case '/marshal/memory/settings/get': return Response.json({});
            case '/marshal/memory/health': return Response.json({});
            case '/marshal/memory/proposals': return Response.json({ proposals: proposals.filter(item => !decisions.some(d => d.id === item.id)) });
            case '/marshal/memory/graph': return Response.json({ graph: { nodes: [node, { ...node, id: 'b' }], edges: [] } });
            case '/marshal/memory/list':
                if (url.searchParams.get('query') === '失败查询') return new Promise(resolve => { resolveFailedSearch = resolve; });
                assert.equal(url.searchParams.get('query'), '偏好');
                if (++reads === 2 || reads === 3) return new Promise(resolve => { resolveSearch = resolve; });
                return Response.json({ items: [node, { ...node, id: 'foreign', scope: 'workspace' }] });
            case '/marshal/memory/get':
                assert.equal(url.searchParams.get('id'), 'a');
                detailSignal = init.signal;
                detailReads++;
                if (holdDetail) return new Promise(resolve => { resolveDetail = resolve; });
                return remoteText === null
                    ? Response.json({ code: 'not-found' }, { status: 404 })
                    : Response.json({ item: { ...node, content: remoteText } });
            case '/marshal/memory/global/update':
                writes++;
                remoteText = JSON.parse(init.body).text;
                return Response.json({ item: { ...node, content: remoteText } });
            case '/marshal/memory/proposals/approve':
            case '/marshal/memory/proposals/reject':
                assert.equal(init.headers['x-marshal-csrf'], 'proof');
                assert.ok(init.signal instanceof AbortSignal);
                decisions.push(JSON.parse(init.body));
                return Response.json({ ok: true });
            default: throw new Error(`unexpected route: ${url}`);
        }
    } });
    h.document.cookie = 'marshal-memory-csrf=proof';
    const page = hooks.mount(h.MemoryPage);
    const galaxy = () => page.find(el => el.type?.name === 'MemoryGalaxy').props;
    await page.settle();
    assert.equal(galaxy().graph.nodes.length, 2);
    page.find(el => el.props?.placeholder === '搜索当前层级记忆…').props.onChange({ target: { value: '偏好' } });
    await page.settle();
    page.find(buttonNamed('搜索')).props.onClick();
    await page.settle();
    assert.equal(galaxy().graph.nodes.length, 1);
    page.find(el => el.props?.placeholder === '搜索当前层级记忆…').props.onChange({ target: { value: '失败查询' } });
    await page.settle();
    assert.equal(galaxy().graph.nodes.length, 1, 'typing does not replace the displayed search');
    page.find(buttonNamed('搜索')).props.onClick();
    await page.settle();
    assert.equal(galaxy().graph.nodes.length, 1, 'pending search keeps the displayed search');
    resolveFailedSearch(Response.json({}, { status: 500 }));
    await page.settle();
    assert.equal(galaxy().graph.nodes.length, 1, 'failed search keeps the displayed search');
    page.find(el => el.props?.placeholder === '搜索当前层级记忆…').props.onChange({ target: { value: '偏好' } });
    await page.settle();
    await galaxy().onSelect(node);
    await page.settle();
    const textarea = () => page.find(el => el.type === 'textarea' && el.props?.rows === 6);
    const alert = () => page.find(el => el.props?.role === 'alert');
    const stream = h.respond(0);
    const emit = async type => {
        stream.send(`event: ${type}\ndata: {}\n\n`);
        await page.settle();
    };
    assert.equal(textarea().props.value, remoteText);
    remoteText = '未编辑时的新正文';
    await emit('memory.changed');
    assert.equal(reads, 2);
    assert.equal(detailReads, 2);
    assert.equal(textarea().props.value, remoteText);
    assert.equal(galaxy().graph.nodes.length, 1, 'old results remain until the new search returns');
    assert.equal(page.find(el => el.props?.placeholder === '搜索当前层级记忆…').props.value, '偏好');
    resolveSearch(Response.json({ items: [node] }));
    await page.settle();
    textarea().props.onChange({ target: { value: '未保存草稿' } });
    await page.settle();
    await emit('incidents.changed');
    assert.equal(reads, 3);
    assert.equal(galaxy().graph.nodes.length, 1, 'incident refresh keeps the current search list while pending');
    assert.equal(textarea().props.value, '未保存草稿');
    assert.equal(alert(), undefined);
    remoteText = '与草稿冲突的新版本';
    const staleSave = page.find(buttonNamed('保存全局记忆')).props.onClick;
    holdDetail = true;
    const beforeConflictRead = detailReads;
    await emit('memory.changed');
    assert.equal(reads, 3, 'the earlier search is still pending');
    assert.equal(detailReads, beforeConflictRead + 1, 'detail verification starts independently of search');
    assert.equal(page.find(buttonNamed('保存全局记忆')).props.disabled, true);
    staleSave();
    await page.settle();
    assert.equal(writes, 0, 'save handler cannot bypass an in-flight detail read');
    resolveDetail(Response.json({}, { status: 500 }));
    await page.settle();
    assert.equal(page.find(buttonNamed('保存全局记忆')).props.disabled, true, 'failed verification keeps save blocked');
    staleSave();
    assert.equal(writes, 0);
    holdDetail = false;
    await emit('memory.changed');
    assert.ok(alert(), 'conflict is already visible before the search returns');
    resolveSearch(Response.json({ items: [node] }));
    await page.settle();
    assert.equal(galaxy().graph.nodes.length, 1);
    assert.equal(textarea().props.value, '未保存草稿');
    assert.ok(alert());
    const save = page.find(buttonNamed('保存全局记忆'));
    assert.equal(save.props.disabled, true);
    save.props.onClick();
    await page.settle();
    assert.equal(writes, 0);
    assert.ok(page.find(buttonNamed('覆盖保存')));
    const staleLoad = page.find(buttonNamed('载入最新版本')).props.onClick;
    remoteText = '更新的远端版本 C';
    holdDetail = true;
    const beforeLatestRead = detailReads;
    await emit('memory.changed');
    const load = page.find(buttonNamed('载入最新版本'));
    assert.equal(load.props.disabled, true);
    assert.equal(page.find(buttonNamed('覆盖保存')).props.disabled, true);
    load.props.onClick();
    staleLoad();
    await page.settle();
    assert.equal(detailReads, beforeLatestRead + 1, 'stale handlers do not duplicate an in-flight check');
    assert.ok(alert());
    assert.equal(textarea().props.value, '未保存草稿');
    await emit('memory.changed');
    assert.equal(detailReads, beforeLatestRead + 1, 'new invalidations queue behind the in-flight check');
    resolveDetail(Response.json({ item: { ...node, content: '已过期的核验回包' } }));
    await page.settle();
    assert.equal(detailReads, beforeLatestRead + 2);
    assert.equal(page.find(buttonNamed('载入最新版本')).props.disabled, true, 'a superseded response cannot unlock the conflict');
    holdDetail = false;
    resolveDetail(Response.json({ item: { ...node, content: remoteText } }));
    await page.settle();
    assert.equal(page.find(buttonNamed('载入最新版本')).props.disabled, false);
    page.find(buttonNamed('载入最新版本')).props.onClick();
    await page.settle();
    assert.equal(textarea().props.value, remoteText);
    assert.equal(alert(), undefined);
    textarea().props.onChange({ target: { value: '明确覆盖的草稿' } });
    await page.settle();
    remoteText = '再次更新的远端正文';
    await emit('memory.changed');
    page.find(buttonNamed('覆盖保存')).props.onClick();
    await page.settle();
    assert.equal(writes, 1);
    assert.equal(remoteText, '明确覆盖的草稿');
    assert.equal(alert(), undefined);
    textarea().props.onChange({ target: { value: '远端删除时也保留' } });
    await page.settle();
    remoteText = null;
    await emit('memory.changed');
    assert.ok(alert());
    assert.equal(textarea().props.value, '远端删除时也保留');
    assert.equal(page.find(buttonNamed('覆盖保存')), undefined);
    page.find(buttonNamed('载入最新版本')).props.onClick();
    await page.settle();
    assert.equal(page.find(el => el.type === 'aside'), undefined);
    page.find(buttonNamed('同意')).props.onClick();
    await page.settle();
    assert.equal(page.find(el => el.type === 'input' && el.props?.value === 'approve-me'), undefined);
    page.find(buttonNamed('拒绝')).props.onClick();
    await page.settle();
    assert.deepEqual(decisions, [{ id: 'approve-me', title: 'approve-me', text: '记忆', visibility: 'no-group' }, { id: 'reject-me' }]);
    assert.equal(page.find(buttonNamed('拒绝')), undefined);
    page.find(buttonNamed('全画布')).props.onClick();
    await page.settle();
    remoteText = '目录载入前打开的正文';
    await galaxy().onSelect(node);
    await page.settle();
    textarea().props.onChange({ target: { value: '目录载入前的草稿' } });
    await page.settle();
    resolveCatalog(Response.json({ workspaces: [{ id: 'project', title: '项目' }] }));
    await page.settle();
    assert.equal(page.find(el => el.props?.['aria-label'] === '项目工作区').props.value, 'project');
    assert.equal(page.find(el => el.props?.['aria-label'] === '智能体').props.value, 'agent');
    assert.equal(galaxy().selectedId, node.id);
    assert.equal(textarea().props.value, '目录载入前的草稿');
    holdDetail = true;
    page.find(buttonNamed('刷新')).props.onClick();
    await page.settle();
    assert.equal(detailSignal.aborted, false);
    page.unmount();
    assert.equal(detailSignal.aborted, true);
});

function mountGlobalMemory(t, { node, session, get, update }) {
    const hooks = pageHooks();
    const h = harness(t, undefined, { React: hooks.React, session, route(url, init) {
        switch (url.pathname) {
            case '/dsh-agents/api/state': return Response.json({ teams: [] });
            case '/marshal/task-rooms/workspaces': return Response.json({ workspaces: [] });
            case '/marshal/memory/settings/get':
            case '/marshal/memory/health':
            case '/marshal/memory/proposals': return Response.json({});
            case '/marshal/memory/graph': return Response.json({ graph: { nodes: [node], edges: [] } });
            case '/marshal/memory/get': return get(url.searchParams.get('id'));
            case '/marshal/memory/global/update': return update(init);
            default: throw new Error(`unexpected route: ${url}`);
        }
    } });
    const page = hooks.mount(h.MemoryPage);
    t.after(() => page.unmount());
    return { h, page,
        select: item => page.find(el => el.type?.name === 'MemoryGalaxy').props.onSelect(item),
        save: () => page.find(buttonNamed('保存全局记忆')),
        textarea: () => page.find(el => el.type === 'textarea' && el.props?.rows === 6),
    };
}

for (const cached of [false, true]) {
    test(`initial detail verification rejects a superseded /get (${cached ? 'cached body' : 'metadata only'})`, async t => {
        const node = { id: 'current', scope: 'global', title: '当前记忆', ...(cached ? { content: '缓存 A' } : {}) };
        const previous = { id: 'previous', scope: 'global', title: '上条记忆', content: '已核验' };
        const pending = [], writes = [];
        const { h, page, select, save, textarea } = mountGlobalMemory(t, { node,
            get: id => id === previous.id ? Response.json({ item: previous }) : new Promise(resolve => pending.push(resolve)),
            update: init => { writes.push(JSON.parse(init.body)); return Response.json({ item: node }); },
        });
        await page.settle();
        await select(previous);
        await page.settle();
        const staleSave = save().props.onClick;
        const stream = h.respond(0);
        void select(node);
        staleSave();
        await page.settle();
        assert.equal(pending.length, 1, 'cached content cannot skip the initial GET');
        assert.equal(save(), undefined, 'editing remains unavailable during the initial GET');
        assert.deepEqual(writes, []);

        stream.send('event: memory.changed\ndata: {}\n\n');
        await page.settle();
        assert.equal(pending.length, 1, 'invalidation queues rather than starting a parallel GET');
        pending[0](Response.json({ item: { ...node, content: '迟到的 A' } }));
        await page.settle();
        assert.equal(pending.length, 2);
        assert.equal(textarea(), undefined, 'superseded GET cannot open an editor with stale content');
        staleSave();
        await page.settle();
        assert.deepEqual(writes, []);

        pending[1](Response.json({ item: { ...node, content: '远端 B' } }));
        await page.settle();
        assert.equal(textarea().props.value, '远端 B');
        assert.equal(save().props.disabled, false);
    });
}

for (const [status, code] of [[401, 'session-expired'], [403, 'memory-csrf-mismatch']]) {
    test(`global save rechecks its baseline after credential refresh (${code})`, async t => {
        const node = { id: 'a', scope: 'global', title: '记忆' };
        let remote = '远端 A', finishSession, detailReads = 0;
        const writes = [];
        const proof = n => Response.json({ ok: true, sessionToken: `session-${n}`, csrf: `csrf-${n}` });
        const { h, page, select, save, textarea } = mountGlobalMemory(t, { node,
            session: n => n === 2 ? new Promise(resolve => { finishSession = () => resolve(proof(n)); }) : proof(n),
            get: () => { detailReads++; return Response.json({ item: { ...node, content: remote } }); },
            update: init => {
                writes.push(JSON.parse(init.body).text);
                if (writes.length === 1) return Response.json({ code }, { status });
                remote = writes.at(-1);
                return Response.json({ item: { ...node, content: remote } });
            },
        });
        await page.settle();
        await select(node);
        await page.settle();
        const stream = h.respond(0);
        textarea().props.onChange({ target: { value: '本地草稿' } });
        await page.settle();
        save().props.onClick();
        await page.settle();
        assert.deepEqual(writes, ['本地草稿']);
        assert.equal(typeof finishSession, 'function', 'retry is waiting for fresh credentials');

        remote = '远端 B';
        stream.send('event: memory.changed\ndata: {}\n\n');
        await page.settle();
        assert.equal(save().props.disabled, true);
        finishSession();
        await page.settle();
        assert.deepEqual(writes, ['本地草稿'], 'the transport must not retry the stale write');
        assert.equal(remote, '远端 B');
        assert.equal(detailReads, 2, 'the canceled save immediately resumes detail verification');
        assert.equal(textarea().props.value, '本地草稿');
        assert.ok(page.find(el => el.props?.role === 'alert'));
        assert.equal(save().props.disabled, true);
        page.find(buttonNamed('载入最新版本')).props.onClick();
        await page.settle();
        assert.equal(textarea().props.value, '远端 B');
    });
}

test('global save response arriving after memory.changed preserves draft and detects conflict', async t => {
    const node = { id: 'a', scope: 'global', title: '记忆' };
    let remote = '远端 A', finishUpdate, detailReads = 0;
    const { h, page, select, save, textarea } = mountGlobalMemory(t, { node,
        session: () => Response.json({ ok: true, sessionToken: 'session-1', csrf: 'csrf-1' }),
        get: () => { detailReads++; return Response.json({ item: { ...node, content: remote } }); },
        update: () => new Promise(resolve => { finishUpdate = resolve; }),
    });
    await page.settle();
    await select(node);
    await page.settle();
    const stream = h.respond(0);
    textarea().props.onChange({ target: { value: '本地保存草稿' } });
    await page.settle();
    save().props.onClick();
    await page.settle();
    assert.equal(typeof finishUpdate, 'function', 'update request is in flight');

    remote = '另一窗口更新 B';
    stream.send('event: memory.changed\ndata: {}\n\n');
    await page.settle();
    finishUpdate(Response.json({ item: { ...node, content: '本地保存草稿' } }));
    await page.settle();

    assert.equal(detailReads >= 2, true);
    assert.equal(textarea().props.value, '本地保存草稿');
    assert.ok(page.find(el => el.props?.role === 'alert'));
    assert.equal(save().props.disabled, true);
    page.find(buttonNamed('载入最新版本')).props.onClick();
    await page.settle();
    assert.equal(textarea().props.value, '另一窗口更新 B');
});
