import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = file => readFileSync(new URL('../client/' + file, import.meta.url), 'utf8');
const bundle = read('index.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
const agent = { agentKey: 'host/squad/coder', teamId: 'squad', agentId: 'coder', name: '主智能体', sessionId: 'recent-ticket', status: 'active' };
const newerAgent = { agentKey: 'host/squad-other/other', agentId: 'other', name: '后创建的智能体' };
const room = { id: 'room', workspaceId: 'ws', taskId: 'ticket', title: '测试工单' };

class Element {
    children = [];
    attrs = new Map();
    parentElement = null;
    get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
    setAttribute(key, value) { this.attrs.set(key, value); }
    appendChild(node) { this.insertBefore(node, null); }
    insertBefore(node, anchor) {
        node.remove();
        const index = anchor ? this.children.indexOf(anchor) : this.children.length;
        assert.notEqual(index, -1);
        this.children.splice(index, 0, node);
        node.parentElement = this;
    }
    remove() {
        if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
        this.parentElement = null;
    }
    contains(target) { return target === this || this.children.some(node => node.contains(target)); }
    find(match) {
        for (const child of this.children) {
            if (match(child)) return child;
            const nested = child.find(match);
            if (nested) return nested;
        }
        return null;
    }
    querySelector(selector) {
        const [, key, value] = /^\[([^=\]]+)(?:="([^"]+)")?\]$/.exec(selector);
        return this.find(node => value ? node.attrs.get(key) === value : node.attrs.has(key));
    }
}

function harness({ legacy = false, fetchOverride, openSession } = {}) {
    let loaded, api, now = 0, nextTimer = 0, writer, cancelled = 0, proposals = 2;
    const registrations = new Map(), timers = new Map(), effects = [], reactCleanups = [], selections = [];
    const clearedTimers = [];
    const storage = new Map(), requests = [], observers = [], listeners = new Set(), roomEvents = [];
    const body = new Element(), head = new Element();
    const events = () => {
        const target = new EventTarget();
        return {
            addEventListener(type, fn) {
                if (![...listeners].some(record => record.target === target && record.type === type && record.fn === fn)) {
                    listeners.add({ target, type, fn });
                }
                target.addEventListener(type, fn);
            },
            removeEventListener(type, fn) {
                for (const record of listeners) {
                    if (record.target === target && record.type === type && record.fn === fn) listeners.delete(record);
                }
                target.removeEventListener(type, fn);
            },
            dispatchEvent: event => target.dispatchEvent(event),
        };
    };
    const windowEvents = events();
    const document = {
        ...events(), visibilityState: 'visible',
        body, head, createElement: () => new Element(), baseURI: 'http://localhost/', cookie: 'marshal-memory-csrf=test',
        querySelector: selector => body.querySelector(selector),
        getElementById: id => head.find(node => node.id === id) ?? body.find(node => node.id === id),
    };
    const window = {
        ...windowEvents,
        location: new URL(document.baseURI), __ModuleLoader__: { load(definition) { loaded = definition; } },
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        dispatchEvent(event) {
            if (event.type === 'marshal:room') roomEvents.push(event.detail);
            return windowEvents.dispatchEvent(event);
        },
        captureVnext: value => { api = value; },
    };
    const Fragment = Symbol('Fragment');
    const hooks = new Map();
    let frame, cursor, mounted;
    const React = {
        Fragment, Component: class {},
        createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? {
            children: children.length === 1 ? children[0] : children,
        } : {}) } }),
        useState(init) {
            const cell = frame[cursor++] ??= { value: typeof init === 'function' ? init() : init };
            const root = mounted;
            return [cell.value, value => { cell.value = value; root?.invalidate(); }];
        },
        useRef(init) { return frame[cursor++] ??= { current: init }; },
        useEffect(setup, deps) {
            const old = frame[cursor];
            if (deps && old?.deps?.length === deps.length && deps.every((value, i) => old.deps[i] === value)) {
                cursor++;
                return;
            }
            old?.off?.();
            const cell = frame[cursor++] = { deps, off: setup() };
            reactCleanups.push(() => { cell.off?.(); cell.off = null; });
        },
        useSyncExternalStore(subscribe, get) {
            const root = mounted;
            const value = get();
            if (!root) return value;
            const cell = frame[cursor++] ??= {};
            cell.value = value;
            cell.get = get;
            if (cell.subscribe !== subscribe) {
                cell.off?.();
                cell.subscribe = subscribe;
                cell.off = subscribe(() => {
                    if (!Object.is(cell.value, cell.get())) root.invalidate();
                });
                reactCleanups.push(() => { cell.off?.(); cell.off = null; });
                if (!Object.is(value, get())) root.invalidate();
            }
            return value;
        },
    };
    const cases = {
        '/marshal/desktop/overview': () => ({ host: { deviceId: 'host' }, agents: { items: [newerAgent, agent] }, memory: { pendingProposalCount: proposals } }),
        '/marshal/incidents/summary': () => ({ totalCount: 4, items: [
            { kind: 'failed', targetId: 'ticket' }, { kind: 'tool-anomaly', targetId: 'ticket' },
            { kind: 'memory-proposal', targetId: 'proposal' },
        ] }),
        '/dsh-agents/api/state': () => ({ teams: [
            { id: 'not-marshal', name: '其他', members: [{ id: 'other' }] },
            { id: 'squad-other', name: 'marshal-agent:other', members: [{ id: 'other', createdAt: 2 }] },
            { id: 'squad', name: 'marshal-agent:coder', members: [{ id: 'coder', model: 'deepseek-pro', createdAt: 1 }] },
        ] }),
        '/marshal/task-rooms/workspaces': () => ({ workspaces: [{ id: 'ws' }, { id: 'pseudo', name: 'Agent · Coder' }] }),
        '/marshal/task-rooms/list': () => ({ rooms: [room] }),
        '/marshal/groups/state': () => ({ groups: [{ id: 'group', name: '本机群' }] }),
        '/marshal/cross-groups/state': () => ({ groups: [{ id: 'cross', name: '跨设备群' }] }),
        '/marshal/agent-tasks/create': () => ({ task: { id: 'saved-task' } }),
        '/marshal/agents/guidance-sync': () => ({ ok: true }),
    };
    const marker = '    return {\n      inject: [';
    assert.ok(bundle.includes(marker));
    runInNewContext(bundle.replace(marker, `    window.captureVnext({
      createVoiceCallProvider, createLocalVoiceSessionProvider, MarshalVoiceCallOverlay,
      ensureMarshalVnextStyles, mvVoiceDuration, MarshalSidebarGroupRoom, createMarshalSidebarData, fetchJson,
    });\n${marker}`), {
        document, window, URL, URLSearchParams, AbortController, TextDecoder, CustomEvent,
        performance: { now: () => now },
        setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
        clearTimeout(id) { clearedTimers.push(id); timers.delete(id); },
        setInterval() { assert.fail('unexpected polling'); },
        MutationObserver: class {
            constructor(callback) { this.fire = records => { if (this.active) callback(records); }; observers.push(this); }
            observe(target, config) { this.active = true; this.config = config; assert.equal(target, body); }
            disconnect() { this.active = false; }
        },
        async fetch(url, init) {
            url = new URL(url);
            requests.push({ url, ...init });
            if (url.pathname === '/marshal/events') {
                const stream = new ReadableStream({ start(controller) { writer = controller; }, cancel() { cancelled++; } });
                return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
            }
            const result = fetchOverride?.(url, init);
            if (result) return result;
            assert.ok(cases[url.pathname], `unexpected endpoint ${url.pathname}`);
            return Response.json(cases[url.pathname]());
        },
    });
    const plugin = loaded.factory(name => { assert.equal(name, 'react'); return React; });
    const ctx = {
        slots: {
            inject(name, setup) {
                if (legacy && ['shell.overlay', 'sidebar.session.action'].includes(name)) throw Error('slot unavailable');
                return setup();
            },
            register(options, Component) {
                assert.ok(!registrations.has(options.name));
                registrations.set(options.name, { options, Component });
                return () => registrations.delete(options.name);
            },
        },
        effect(setup) { effects.push(setup()); },
        inject(names, setup) {
            if (names.join() === 'uiWorkspace' && openSession) {
                return { dispose: setup({ get: key => key === 'uiWorkspace' ? { openSession } : undefined }) };
            }
            if (legacy || !names.includes('layout')) return;
            assert.ok(names.length === 1 || names.join() === 'layout,slots,sessions,uiSession,uiConversation');
            return { dispose: setup({ get: key => key === 'layout' ? { selectPanel: id => selections.push(id) } : undefined }) };
        },
    };
    const render = (name, props) => registrations.get(name).Component(props ?? {});
    const expand = (node, stop = []) => {
        if (Array.isArray(node)) return node.map(item => expand(item, stop));
        if (!node || typeof node !== 'object') return node;
        if (node.$$typeof === Symbol.for('react.portal')) return { ...node, children: expand(node.children, stop) };
        if (typeof node.type === 'function') {
            if (stop.includes(node.type.name)) return node;
            const cells = mounted?.hooks ?? hooks;
            if (!cells.has(node.type)) cells.set(node.type, []);
            frame = cells.get(node.type);
            cursor = 0;
            return expand(node.type(node.props), stop);
        }
        return { ...node, props: { ...node.props, children: expand(node.props?.children, stop) } };
    };
    const mount = (name, props) => {
        let tree, queued = false, alive = true;
        const root = {
            hooks: new Map(),
            invalidate() {
                if (queued || !alive) return;
                queued = true;
                queueMicrotask(() => { queued = false; if (alive) commit(); });
            },
        };
        const commit = () => {
            mounted = root;
            try { tree = expand({ type: registrations.get(name).Component, props: props ?? {} }); }
            finally { mounted = undefined; }
        };
        commit();
        reactCleanups.push(() => { alive = false; root.hooks.clear(); });
        return () => tree;
    };
    return {
        ...api, plugin, ctx, window, document, requests, observers, registrations, listeners, timers, clearedTimers,
        body, storage, selections, roomEvents, render, expand, mount,
        setNow: value => { now = value; },
        newProposal: () => { proposals++; },
        stream: topic => writer.enqueue(new TextEncoder().encode(`event: ${topic}\ndata: {}\n\n`)),
        cancelled: () => cancelled,
        dispose: () => effects.splice(0).reverse().forEach(dispose => dispose()),
        unmountReact() {
            reactCleanups.splice(0).reverse().forEach(dispose => dispose());
            hooks.clear();
        },
        async fire(delay) {
            const next = [...timers].find(([, value]) => value.delay === delay);
            assert.ok(next, `missing timer ${delay}`);
            timers.delete(next[0]);
            next[1].fn();
            await flush();
        },
    };
}

function find(node, pred) {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) return node.map(child => find(child, pred)).find(Boolean);
    return pred(node) ? node : find(node.props?.children ?? node.children, pred);
}
function text(node) {
    if (Array.isArray(node)) return node.map(text).join('');
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    return node && typeof node === 'object' ? text(node.props?.children ?? node.children) : '';
}
const button = (tree, label) => find(tree, node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label));

test('Plan A binds the host slots, moves the Portal with its native anchor and refreshes via SSE', async t => {
    const host = harness();
    t.after(host.dispose);
    t.after(host.unmountReact);
    host.plugin.apply(host.ctx);
    assert.equal(host.registrations.get('sidebar.panellist').options.label(), '调度官');
    assert.equal(host.registrations.get('sidebar.panellist').options.id, 'dsh-marshal');
    assert.ok(host.registrations.has('sidebar.session.action'));
    assert.ok(host.document.getElementById('marshal-vnext-styles'));
    assert.equal(host.document.getElementById('marshal-sidebar-sections-portal'), null);

    const scroll = new Element(), wrapper = new Element(), workspaces = new Element(), outside = new Element();
    outside.setAttribute('data-slot', 'sidebar.workspaces');
    workspaces.setAttribute('data-slot', 'sidebar.workspaces');
    scroll.setAttribute('data-sidebar-scrollport', '');
    host.body.appendChild(outside);
    host.body.appendChild(scroll);
    scroll.appendChild(wrapper);
    wrapper.appendChild(workspaces);
    const [observer] = host.observers;
    observer.fire([{ target: host.body }]);
    const target = host.document.getElementById('marshal-sidebar-sections-portal');
    assert.equal(target.nextSibling, workspaces);
    assert.equal(target.parentElement, wrapper);
    scroll.attrs.delete('data-sidebar-scrollport');
    observer.fire([{ target: scroll }]);
    assert.equal(target.parentElement, null);
    scroll.setAttribute('data-sidebar-scrollport', '');
    observer.fire([{ target: scroll }]);
    assert.equal(target.nextSibling, workspaces);

    await flush();
    assert.equal(host.requests.filter(req => req.url.pathname.endsWith('/list')).length, 1);
    assert.equal(host.requests.find(req => req.url.pathname.endsWith('/list')).url.searchParams.get('workspaceId'), 'ws');
    const entry = () => host.expand(host.render('sidebar.panellist'));
    assert.equal(text(entry()), '3', 'two incident records for one ticket plus two memory proposals');
    assert.ok(find(entry(), node => node.type === 'svg'));
    assert.equal(find(entry(), node => node.type === 'button'), undefined, 'the host already owns the button');
    let stopped = false;
    entry().props.onClick({ stopPropagation() { stopped = true; } });
    assert.ok(stopped);
    assert.equal(host.selections.at(-1), 'dsh-marshal');
    host.newProposal();
    host.stream('memory.changed');
    await flush();
    await host.fire(100);
    assert.equal(text(entry()), '4');
    assert.equal(host.timers.size, 0, 'refresh does not schedule another data read');

    const overlay = () => host.expand(host.render('shell.overlay'));
    const portal = find(overlay(), node => node.$$typeof === Symbol.for('react.portal'));
    assert.equal(portal.containerInfo, target);
    assert.ok(find(portal, node => node.props?.['aria-label'] === '有待处理异常'));
    const sections = portal.children;
    const heading = find(sections, node => node.props?.['aria-controls'] === 'mv-sidebar-groups');
    assert.equal(heading.props['aria-expanded'], true);
    heading.props.onClick();
    assert.equal(JSON.parse(host.storage.get('marshal.sidebar.sections.vnext')).groups, true);
    assert.equal(find(overlay(), node => node.props?.id === 'mv-sidebar-groups').props.hidden, true);

    button(sections, '测试工单').props.onClick();
    assert.equal(host.roomEvents.at(-1).kind, 'taskRooms');
    const routed = stop => host.expand(host.render('main'), ['MarshalErrorBoundary', stop]);
    const boardRoom = find(routed('MarshalTicketRoomView'), node => node.type?.name === 'MarshalTicketRoomView');
    assert.equal(boardRoom.props.task.taskRoom.id, room.id);
    button(sections, '本机群').props.onClick();
    assert.equal(host.roomEvents.at(-1).item.id, 'group');
    assert.ok(find(routed('MarshalSidebarGroupRoom'), node => node.type?.name === 'MarshalSidebarGroupRoom'));
    button(sections, '跨设备群').props.onClick();
    assert.equal(host.roomEvents.at(-1).kind, 'cross');
    button(sections, '主智能体').props.onClick();
    assert.equal(find(routed('AgentDirectChatsView'), node => node.type?.name === 'AgentDirectChatsView').props.initialAgentId, 'coder');

    const session = wide => host.expand(host.render('sidebar.session.action', {
        wide, children: host.render('sidebar.panellist'),
    }));
    assert.match(text(session(true)), /主智能体.*deepseek-pro/);
    assert.doesNotMatch(text(session(false)), /deepseek-pro/);
    assert.ok(find(session(false), node => node.props?.className === 'mv-entry'), 'native children are retained');
    button(session(false), '语音通话 · 主智能体').props.onClick();
    assert.ok(button(session(false), '正在连接 · 主智能体'));
    assert.match(text(overlay()), /本地笔记模式，不录音。.*SenseVoice/);
    const capsule = find(overlay(), node => node.props?.className?.includes('mv-capsule'));
    capsule.props.onClick();
    assert.equal(find(overlay(), node => node.props?.['aria-label'] === '语音小会话'), undefined);
    button(session(false), '正在连接 · 主智能体').props.onClick();
    assert.ok(find(overlay(), node => node.props?.['aria-label'] === '语音小会话'));
    button(overlay(), '取消连接').props.onClick();
    assert.match(text(overlay()), /已取消语音连接/);
    assert.equal(find(overlay(), node => node.props?.['aria-label'] === '语音纪要'), undefined);
    button(session(false), '语音通话 · 主智能体').props.onClick();
    await flush();
    assert.ok(button(session(false), '通话中 · 主智能体'));
    host.unmountReact();
    assert.equal(button(session(false), '通话中 · 主智能体'), undefined);
    overlay();
    assert.ok(button(session(false), '语音通话 · 主智能体'), 'remount creates a fresh provider');

    const sse = host.requests.find(req => req.url.pathname === '/marshal/events');
    assert.equal(sse.signal.aborted, false);
    host.stream('tasks.changed');
    await flush();
    assert.ok(host.timers.size > 0);
    host.unmountReact();
    host.dispose();
    await flush();
    assert.ok(sse.signal.aborted);
    assert.equal(host.cancelled(), 1);
    assert.equal(host.listeners.size, 0);
    assert.equal(host.timers.size, 0);
    assert.equal(host.registrations.size, 0);
    assert.equal(observer.active, false);
    assert.equal(host.document.getElementById('marshal-vnext-styles'), null);
    assert.equal(host.document.getElementById('marshal-consolidated-rows'), null);
    assert.equal(target.parentElement, null);
    assert.equal(workspaces.parentElement, wrapper);
});

test('pending cross-groups do not block core UI or member writes; browser refresh listeners are cleaned up', async t => {
    const name = '刚新增的智能体';
    const team = { id: 'squad', name: 'marshal-agent:coder', members: [] };
    const member = { name, model: 'deepseek-pro' };
    const opened = [];
    const never = new Promise(() => {});
    const host = harness({ openSession: id => { opened.push(id); }, fetchOverride(url, init) {
        if (['/marshal/cross-groups/state', '/marshal/task-rooms/workspaces'].includes(url.pathname)) return never;
        if (url.pathname === '/marshal/agent-direct-sessions') {
            return Response.json({ mainSession: { sessionId: 'new-agent-direct' } });
        }
        if (url.pathname === '/dsh-agents/api/member') {
            const body = JSON.parse(init.body);
            if (!body.member?.name) return Response.json({ ok: false, code: 'invalid-member' }, { status: 400 });
            assert.deepEqual(body, { teamId: team.id, member });
            team.members.push({ ...body.member, id: 'coder', createdAt: 1 });
            return Response.json({ team });
        }
        if (url.pathname === '/dsh-agents/api/state') {
            return Response.json({ teams: [team] });
        }
        if (url.pathname === '/marshal/desktop/overview') {
            return Response.json({ host: { deviceId: 'host' }, agents: { items: team.members.length ? [agent] : [] },
                memory: { pendingProposalCount: team.members.length ? 2 : 0 } });
        }
    } });
    t.after(() => { host.unmountReact(); host.dispose(); });
    const scroll = new Element(), anchor = new Element();
    scroll.setAttribute('data-sidebar-scrollport', '');
    anchor.setAttribute('data-slot', 'sidebar.workspaces');
    scroll.appendChild(anchor);
    host.body.appendChild(scroll);
    host.plugin.apply(host.ctx);
    await flush();

    const sidebar = host.mount('sidebar.session.action', { wide: true });
    const overlay = host.mount('shell.overlay');
    const entry = host.mount('sidebar.panellist');
    const card = () => find(sidebar(), node => node.props?.['aria-label'] === '主智能体');
    const list = () => find(overlay(), node => node.props?.id === 'mv-sidebar-agents');
    assert.equal(anchor.parentElement.children[0].id, 'marshal-sidebar-sections-portal');
    const reads = () => host.requests.filter(req => req.url.pathname === '/marshal/desktop/overview').length;
    const crossReads = () => host.requests.filter(req => req.url.pathname === '/marshal/cross-groups/state');
    const initial = reads();
    assert.equal(crossReads().length, 1);
    assert.equal(crossReads()[0].signal.aborted, false);
    assert.equal(text(entry()), '1');
    assert.equal(card(), undefined);
    assert.match(text(list()), /暂无智能体/);
    await host.fetchJson('dsh-agents/api/state');
    await assert.rejects(host.fetchJson('dsh-agents/api/member', {}), { code: 'invalid-member' });
    await flush();
    assert.equal(reads(), initial, 'GETs and failed writes do not invalidate the sidebar');
    await host.fetchJson('dsh-agents/api/member', { teamId: team.id, member });
    await flush();
    assert.equal(reads(), initial + 1);
    assert.ok(text(card()).includes(name));
    assert.ok(text(card()).includes('deepseek-pro'));
    assert.ok(button(list(), name));
    assert.equal(text(entry()), '3');
    const status = find(card(), node => node.props?.['aria-label'] === '智能体运行中');
    assert.equal(status.props.className, 'mv-online');
    assert.equal(status.props.title, '智能体运行中');
    const direct = button(card(), '1:1 直连 · ' + name), voice = button(card(), '语音通话 · ' + name);
    assert.ok(direct && !direct.props.disabled);
    assert.ok(voice && !voice.props.disabled);
    assert.equal(crossReads().length, 2);
    assert.ok(crossReads()[0].signal.aborted, 'new epoch cancels the previous cross read');
    assert.equal(crossReads()[1].signal.aborted, false, 'UI updated before the cross read timed out');
    await direct.props.onClick();
    assert.deepEqual(opened, ['new-agent-direct']);
    voice.props.onClick();
    await flush();
    assert.ok(button(sidebar(), '通话中 · ' + name));

    host.window.dispatchEvent(new CustomEvent('focus'));
    await flush();
    assert.equal(reads(), initial + 2);
    host.document.visibilityState = 'hidden';
    host.document.dispatchEvent(new CustomEvent('visibilitychange'));
    await flush();
    assert.equal(reads(), initial + 2);
    host.document.visibilityState = 'visible';
    host.document.dispatchEvent(new CustomEvent('visibilitychange'));
    await flush();
    assert.equal(reads(), initial + 3);

    host.unmountReact();
    host.dispose();
    assert.equal(host.listeners.size, 0);
    host.window.dispatchEvent(new CustomEvent('marshal:agents-changed'));
    host.window.dispatchEvent(new CustomEvent('focus'));
    host.document.dispatchEvent(new CustomEvent('visibilitychange'));
    await flush();
    assert.equal(reads(), initial + 3);
    assert.ok(crossReads().every(req => req.signal.aborted));
    assert.ok(host.requests.filter(req => req.url.pathname === '/marshal/task-rooms/workspaces').every(req => req.signal.aborted));
    assert.equal(host.timers.size, 0);
});

test('sidebar merges independent batches, ignores stale results and releases the cross timeout', async t => {
    let resolveCore, resolveRooms, resolveGroups, resolveLatestGroups;
    const calls = new Map();
    const never = new Promise(() => {});
    const host = harness({ fetchOverride(url) {
        const attempt = (calls.get(url.pathname) ?? 0) + 1;
        calls.set(url.pathname, attempt);
        switch (url.pathname) {
            case '/marshal/desktop/overview':
                if (attempt === 1) return new Promise(resolve => { resolveCore = resolve; });
                break;
            case '/marshal/task-rooms/workspaces':
                if (attempt === 1) return new Promise(resolve => { resolveRooms = resolve; });
                break;
            case '/marshal/groups/state':
                if (attempt === 1) return new Promise(resolve => { resolveGroups = resolve; });
                if (attempt === 2) return new Promise(resolve => { resolveLatestGroups = resolve; });
                return never;
            case '/marshal/cross-groups/state':
                if (attempt < 3) return never;
                break;
        }
    } });
    const store = host.createMarshalSidebarData();
    t.after(store.dispose);
    const coreReads = () => calls.get('/marshal/desktop/overview');
    await flush();
    assert.equal(store.getSnapshot().loading, true);
    host.window.dispatchEvent(new CustomEvent('focus'));
    host.window.dispatchEvent(new CustomEvent('focus'));
    await flush();
    assert.equal(coreReads(), 1, 'invalidations while core is pending are coalesced');
    resolveCore(Response.json({ memory: { pendingProposalCount: 1 } }));
    await flush();
    assert.equal(coreReads(), 2, 'core settlement releases the trailing refresh');
    assert.equal(store.getSnapshot().loading, false);
    assert.equal(store.getSnapshot().count, 3);
    assert.equal(store.getSnapshot().rooms[0].id, room.id, 'rooms publish before either group list');
    assert.equal(store.getSnapshot().rooms[0].incident, true);
    resolveLatestGroups(Response.json({ groups: [{ id: 'fresh' }] }));
    await flush();
    assert.equal(store.getSnapshot().groups[0].id, 'fresh');
    const current = store.getSnapshot();
    resolveRooms(Response.json({ workspaces: [] }));
    resolveGroups(Response.json({ groups: [{ id: 'stale' }] }));
    await flush();
    assert.equal(store.getSnapshot(), current, 'late prior-epoch rooms and groups cannot overwrite the new snapshot');

    const [[timer, { delay }]] = host.timers;
    assert.equal(host.timers.size, 1);
    assert.equal(delay, 5000);
    await host.fire(delay);
    const crossReads = () => host.requests.filter(req => req.url.pathname === '/marshal/cross-groups/state');
    assert.ok(crossReads()[1].signal.aborted);
    assert.ok(host.clearedTimers.includes(timer), 'the timeout is cleared in finally even when fetch stays pending');
    assert.equal(host.timers.size, 0);
    assert.deepEqual({ ...store.getSnapshot() }, { ...current, incomplete: true });

    host.window.dispatchEvent(new CustomEvent('focus'));
    await flush();
    assert.equal(coreReads(), 3, 'timeout does not block the next refresh');
    assert.equal(store.getSnapshot().incomplete, false);
    assert.deepEqual(Array.from(store.getSnapshot().groups, group => [group.id, group.kind]), [
        ['fresh', 'groups'], ['cross', 'cross'],
    ], 'cross success merges with the previous local list while its replacement is pending');
    assert.equal(host.timers.size, 0);
});

test('primary agent status uses overview and direct errors with matching accessible labels', async t => {
    let current = agent;
    const host = harness({ fetchOverride(url) {
        if (url.pathname === '/marshal/desktop/overview') {
            return Response.json({ host: { deviceId: 'host' }, agents: { items: [current] } });
        }
        if (url.pathname === '/marshal/agent-direct-sessions') return Response.json({ mainSession: {} });
    } });
    t.after(host.dispose);
    host.plugin.apply(host.ctx);
    const render = () => host.expand(host.render('sidebar.session.action', { wide: true }));
    const check = (className, label) => {
        const dot = find(render(), node => node.props?.role === 'img' && node.props?.className === className);
        assert.ok(dot, `${label} should use ${className}`);
        assert.equal(dot.props['aria-label'], label);
        assert.equal(dot.props.title, label);
        assert.equal(dot.props.children.type, 'svg');
    };
    for (const [status, sessionId, color, label] of [
        ['running', undefined, 'mv-online', '智能体运行中'],
        ['idle', 'existing', 'mv-online', '已建立会话'],
        [undefined, undefined, 'mv-muted', '智能体未激活'],
        ['failed', 'existing', 'mv-danger', '智能体运行异常'],
        ['active', 'existing', 'mv-online', '智能体运行中'],
    ]) {
        current = { ...agent, status, sessionId };
        host.window.dispatchEvent(new CustomEvent('focus'));
        await flush();
        check(color, label);
    }
    await button(render(), '1:1 直连 · 主智能体').props.onClick();
    check('mv-danger', '直连异常：暂无 1:1 直连会话。');
});

// DSH 0.2.2-rc.5 renderer smoke (DevTools Console, after loading this
// bundle with the desktop sidebar visible; the native React tree owns the Portal):
// (() => {
//   const check = (ok, message) => { if (!ok) throw Error(message); };
//   check(typeof window.ReactDOM?.createPortal !== 'function', 'not testing the fallback');
//   const root = document.querySelector('#marshal-sidebar-sections-portal');
//   const anchor = document.querySelector('[data-sidebar-scrollport] [data-slot="sidebar.workspaces"]');
//   check(anchor && root?.nextSibling === anchor, 'wrong native insertion point');
//   const toggle = root.querySelector('button[aria-controls="mv-sidebar-groups"]');
//   const list = root.querySelector('#mv-sidebar-groups');
//   check(toggle && list, 'portal children were not committed by react-dom');
//   const before = list.hidden;
//   toggle.click();
//   requestAnimationFrame(() => {
//     check(list.hidden !== before, 'portal click did not reach React');
//     toggle.click(); // restore folded preference
//     console.log('DSH rc.5 portal fallback PASS');
//   });
// })();
// After unmounting the plugin in the host, both IDs should be absent:
// document.querySelector('#marshal-sidebar-sections-portal, #marshal-vnext-styles') === null

test('group shortcut sends deduplicated @members and retains delivery and parsing failures', async t => {
    const group = { id: 'cross', name: '跨设备群', members: [{ name: '群主' }, { name: '成员' }] };
    const host = harness({ fetchOverride(url) {
        if (url.pathname === '/marshal/cross-groups/state') return Response.json({ groups: [group] });
        if (url.pathname === '/marshal/cross-groups/send') {
            return Response.json({ deliveries: [{ name: '成员', state: 'failed', code: 'offline' }] });
        }
    } });
    const owner = new AbortController();
    t.after(() => { owner.abort(); host.unmountReact(); });
    const render = () => host.expand({ type: host.MarshalSidebarGroupRoom, props: {
        route: { kind: 'cross', item: group }, ownerSignal: owner.signal,
    } });
    const input = () => find(render(), node => node.type === 'textarea');
    const sends = () => host.requests.filter(req => req.url.pathname === '/marshal/cross-groups/send');
    const send = async value => {
        input().props.onChange({ target: { value } });
        await find(render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
        await flush();
    };
    render();
    await flush();
    await send('@成员 请跟进 @成员');
    assert.deepEqual(JSON.parse(sends()[0].body), { id: 'cross', text: '@成员 请跟进 @成员', mentions: ['成员'] });
    assert.match(text(render()), /部分成员失败：成员 offline/);
    await send('@不存在 请跟进');
    assert.match(text(render()), /发送失败：未找到 @ 成员：不存在/);
    assert.equal(input().props.value, '@不存在 请跟进');
    await send('@ 请跟进');
    assert.match(text(render()), /发送失败：无法解析 @ 提及/);
    assert.equal(sends().length, 1, 'invalid mentions must not silently send to the group leader');
});

test('local group shortcut matches the server mention punctuation and @全体 alias', async t => {
    const group = { id: 'group', name: '本机群', members: [{ name: '成员' }] };
    const host = harness({ fetchOverride(url) {
        if (url.pathname === '/marshal/groups/get') return Response.json({ group });
        if (url.pathname === '/marshal/groups/send') return Response.json({ deliveries: [] });
    } });
    const owner = new AbortController();
    t.after(() => { owner.abort(); host.unmountReact(); });
    const render = () => host.expand({ type: host.MarshalSidebarGroupRoom, props: {
        route: { kind: 'groups', item: group }, ownerSignal: owner.signal,
    } });
    render();
    await flush();
    const value = '@成员，@成员： 请跟进 @全体';
    find(render(), node => node.type === 'textarea').props.onChange({ target: { value } });
    await find(render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    const sent = host.requests.find(req => req.url.pathname === '/marshal/groups/send');
    assert.deepEqual(JSON.parse(sent.body), { id: 'group', text: value, mentions: ['成员', 'all'] });
});

test('primary direct shortcut reuses the authenticated mainSession and does not create on lookup errors', async t => {
    const opened = [];
    let mode = 'ready', reply;
    const host = harness({
        async openSession(id) { opened.push(id); return mode !== 'refused'; },
        fetchOverride(url) {
            if (url.pathname !== '/marshal/agent-direct-sessions') return;
            if (mode === 'missing') return Response.json({ code: 'not-found' }, { status: 404 });
            if (mode === 'late') return new Promise(resolve => { reply = resolve; });
            return Response.json({ mainSession: mode === 'malformed' ? {} : { sessionId: 'real-direct' } });
        },
    });
    t.after(host.dispose);
    host.plugin.apply(host.ctx);
    await flush();
    const render = () => host.expand(host.render('sidebar.session.action', { wide: false }));
    const click = () => button(render(), '1:1 直连 · 主智能体').props.onClick();
    await click();
    assert.deepEqual(opened, ['real-direct']);
    const req = host.requests.find(req => req.url.pathname === '/marshal/agent-direct-sessions');
    assert.equal(req.method, undefined, 'fetch defaults to GET');
    assert.equal(req.url.searchParams.get('agentKey'), agent.agentKey);
    assert.equal(req.headers['x-marshal-csrf'], 'test');
    for (const [scenario, notice] of [['malformed', /暂无 1:1/], ['missing', /无法打开 1:1/]]) {
        mode = scenario;
        await click();
        assert.match(text(render()), notice);
        assert.deepEqual(opened, ['real-direct'], 'must not fall back to recent-ticket from overview');
        assert.equal(host.roomEvents.length, 0);
    }
    mode = 'refused';
    await click();
    assert.match(text(render()), /宿主无法打开 1:1/);
    mode = 'late';
    const late = click();
    await flush();
    host.dispose();
    assert.ok(host.requests.at(-1).signal.aborted);
    reply(Response.json({ mainSession: { sessionId: 'late-direct' } }));
    await late;
    assert.deepEqual(opened, ['real-direct', 'real-direct']);
    assert.ok(host.requests.every(req => req.url.pathname !== '/dsh-agents/api/run'));
});

test('a new primary agent can open its first direct session and sync a saved voice summary', async t => {
    const team = { id: 'squad', name: 'marshal-agent:coder', members: [] };
    const opened = [];
    let directId;
    const host = harness({
        openSession(id) { opened.push(id); },
        fetchOverride(url, init) {
            if (url.pathname === '/dsh-agents/api/member') {
                const { teamId, member } = JSON.parse(init.body);
                assert.equal(teamId, team.id);
                team.members.push({ ...member, id: agent.agentId });
                return Response.json({ team });
            }
            if (url.pathname === '/dsh-agents/api/state') return Response.json({ teams: [team] });
            if (url.pathname === '/marshal/desktop/overview') {
                // An unrelated run from overview must not be opened or used to sync guidance.
                return Response.json({ host: { deviceId: 'host' }, agents: { items: team.members.length ? [agent] : [] } });
            }
            if (url.pathname === '/marshal/agent-direct-sessions') {
                assert.equal(url.searchParams.get('agentKey'), agent.agentKey);
                return Response.json({ mainSession: directId ? { sessionId: directId } : null });
            }
            if (url.pathname === '/dsh-agents/api/run') {
                assert.equal(init.method, 'POST');
                assert.deepEqual(JSON.parse(init.body), { teamId: team.id, memberId: agent.agentId, purpose: 'direct' });
                assert.equal(directId, undefined, 'do not create another run on a repeat click');
                directId = 'first-direct';
                return Response.json({ run: { sessionId: directId, purpose: 'direct' } });
            }
            if (url.pathname === '/marshal/agents/guidance-sync') {
                assert.deepEqual(JSON.parse(init.body), { agentKey: agent.agentKey, guidanceText: '确认待办', taskIds: ['saved-task'] });
                return directId ? Response.json({ ok: true })
                    : Response.json({ ok: false, code: 'direct-session-not-found' }, { status: 404 });
            }
        },
    });
    t.after(() => { host.unmountReact(); host.dispose(); });
    host.plugin.apply(host.ctx);
    const sidebar = host.mount('sidebar.session.action', { wide: true });
    const overlay = host.mount('shell.overlay');
    await flush();
    assert.equal(button(sidebar(), '1:1 直连 · ' + agent.name), undefined);
    await host.fetchJson('dsh-agents/api/member', { teamId: team.id, member: { name: agent.name } });
    await flush();
    button(sidebar(), '语音通话 · ' + agent.name).props.onClick();
    await flush();
    find(overlay(), node => node.type === 'textarea').props.onChange({ target: { value: '确认待办' } });
    button(overlay(), '挂断并生成纪要').props.onClick();
    await flush();
    button(overlay(), '保存为 1:1 任务').props.onClick();
    await flush();
    button(overlay(), '汇总同步指导').props.onClick();
    await flush();
    assert.match(text(overlay()), /请先建立智能体的 1:1 直连会话/);

    await button(sidebar(), '1:1 直连 · ' + agent.name).props.onClick();
    await flush();
    assert.deepEqual(opened, ['first-direct']);
    button(overlay(), '汇总同步指导').props.onClick();
    await flush();
    assert.match(text(overlay()), /已同步指导/);
    await button(sidebar(), '1:1 直连 · ' + agent.name).props.onClick();
    assert.deepEqual(opened, ['first-direct', 'first-direct']);
    assert.equal(host.requests.filter(req => req.url.pathname === '/dsh-agents/api/run').length, 1);
});

test('voice provider moves through every state, times the session and submits authenticated summary actions', async () => {
    const host = harness();
    let connect, finish, emit, releases = 0;
    const mute = [];
    const voice = host.createVoiceCallProvider({
        connect({ onTranscript }) { emit = onTranscript; return new Promise(resolve => { connect = resolve; }); },
        setMuted(value) { mute.push(value); },
        end() { return new Promise(resolve => { finish = resolve; }); },
        dispose() { releases++; },
    });
    const states = [voice.getSnapshot().status];
    voice.subscribe(() => {
        const { status } = voice.getSnapshot();
        if (status !== states.at(-1)) states.push(status);
    });
    const connecting = voice.start(agent);
    assert.equal(voice.getSnapshot().status, 'connecting');
    connect();
    await connecting;
    assert.equal(voice.reset(), false);
    assert.equal(voice.cancel(), false);
    assert.equal(voice.getSnapshot().status, 'active');
    const active = () => host.expand({ type: host.MarshalVoiceCallOverlay, props: { voice } });
    assert.match(text(active()), /00:00/);
    emit({ speaker: 'Coder', text: '下一步检查队列' });
    voice.setNotes('用户笔记');
    await voice.toggleMuted();
    assert.deepEqual(mute, [true]);
    assert.equal(voice.getSnapshot().muted, true);
    host.setNow(65_800);
    const ending = voice.end();
    assert.equal(voice.getSnapshot().status, 'ending');
    assert.equal(voice.reset(), false);
    finish({ summary: '检查队列' });
    await ending;
    assert.equal(host.mvVoiceDuration(voice.getSnapshot().duration), '01:05');
    assert.equal(voice.getSnapshot().summary, '检查队列\n\n用户笔记');
    assert.equal(voice.getSnapshot().transcript[0].text, '下一步检查队列');
    assert.ok(button(active(), '汇总同步指导').props.disabled);
    voice.editSummary('确认待办');
    await Promise.all([voice.saveSummary(), voice.saveSummary()]);
    await voice.syncGuidance();
    assert.deepEqual(host.requests.map(req => [req.url.pathname, req.method, JSON.parse(req.body)]), [
        ['/marshal/agent-tasks/create', 'POST', { agentKey: agent.agentKey, type: 'direct', title: '语音纪要 · 主智能体', lastSummary: '确认待办' }],
        ['/marshal/agents/guidance-sync', 'POST', { agentKey: agent.agentKey, guidanceText: '确认待办', taskIds: ['saved-task'] }],
    ]);
    assert.equal(host.requests[0].headers['x-marshal-csrf'], 'test');
    assert.ok(voice.getSnapshot().synced);
    voice.close();
    voice.dispose();
    host.unmountReact();
    assert.equal(host.timers.size, 0);
    assert.equal(releases, 1);
    assert.deepEqual(states, ['idle', 'connecting', 'active', 'ending', 'summary', 'idle']);
});

test('cancelled and disposed voice sessions ignore late adapter results and abort in-flight writes', async () => {
    const host = harness({ fetchOverride: (url, { signal }) => {
        if (url.pathname === '/marshal/agent-tasks/create') {
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
    } });
    let complete, connectSignal, releases = 0, ends = 0;
    const pending = host.createVoiceCallProvider({
        connect({ signal }) { connectSignal = signal; return new Promise(resolve => { complete = resolve; }); },
        end() { ends++; },
        dispose() { releases++; },
    });
    const changes = [];
    pending.subscribe(() => changes.push(pending.getSnapshot().status));
    const start = pending.start(agent);
    assert.equal(pending.reset(), false);
    await pending.end();
    assert.equal(pending.getSnapshot().status, 'connecting', 'end is only legal after activation');
    assert.equal(pending.cancel(), true);
    assert.ok(connectSignal.aborted);
    complete();
    await start;
    assert.equal(pending.getSnapshot().status, 'idle');
    assert.equal(pending.getSnapshot().outcome, 'cancelled');
    assert.equal(pending.cancel(), false);
    assert.deepEqual(changes, ['connecting', 'idle']);
    assert.equal(ends, 0);
    pending.dispose();
    assert.equal(releases, 1);
    await pending.start(agent);
    assert.equal(pending.getSnapshot().status, 'idle');

    const local = host.createLocalVoiceSessionProvider();
    await local.start(agent);
    local.setNotes('待保存');
    await local.end();
    const save = local.saveSummary();
    await flush();
    assert.equal(host.requests[0].signal.aborted, false);
    local.dispose();
    await save;
    assert.ok(host.requests[0].signal.aborted);
    assert.equal(local.getSnapshot().status, 'idle');
});

test('failed voice connection emits an idle error without creating a summary and can be retried', async () => {
    const host = harness();
    let attempts = 0, released = 0;
    const voice = host.createVoiceCallProvider({
        connect() { if (++attempts === 1) throw Error('connect failed'); },
        end() { assert.fail('failed connections must not invoke end'); },
        dispose() { released++; },
    });
    const changes = [];
    voice.subscribe(() => changes.push(voice.getSnapshot().status));
    await voice.start(agent);
    assert.deepEqual(changes, ['connecting', 'idle']);
    assert.equal(voice.getSnapshot().outcome, 'error');
    assert.match(text(host.expand({ type: host.MarshalVoiceCallOverlay, props: { voice } })), /无法建立语音会话/);
    assert.equal(voice.reset(), true);
    assert.equal(voice.getSnapshot().outcome, undefined);
    await voice.start(agent);
    assert.equal(voice.getSnapshot().status, 'active');
    voice.dispose();
    assert.equal(released, 2);
    assert.equal(changes.at(-1), 'active', 'destruction does not emit an active-to-idle transition');
});

test('rejected hangup clears the active session without allowing summary writes', async () => {
    const host = harness();
    let rejectEnd, connectionSignal, endingSignal, releases = 0;
    const voice = host.createVoiceCallProvider({
        connect({ signal }) { connectionSignal = signal; },
        end({ signal }) {
            endingSignal = signal;
            return new Promise((_, reject) => { rejectEnd = reject; });
        },
        dispose() { releases++; },
    });
    await voice.start(agent, { targetTicketId: 'ticket' });
    voice.setNotes('不得保存的笔记');
    const states = [voice.getSnapshot().status];
    voice.subscribe(() => states.push(voice.getSnapshot().status));
    const ending = voice.end();
    assert.equal(voice.getSnapshot().status, 'ending');
    await Promise.all([voice.saveSummary(), voice.syncGuidance()]);
    assert.equal(endingSignal.aborted, false);
    rejectEnd(Error('hangup failed'));
    await ending;
    assert.deepEqual(states, ['active', 'ending', 'idle']);
    assert.deepEqual({ ...voice.getSnapshot() }, {
        status: 'idle', outcome: 'error', message: '语音连接结束失败，未生成纪要。',
    });
    assert.ok(connectionSignal.aborted);
    assert.ok(endingSignal.aborted);
    await Promise.all([voice.saveSummary(), voice.syncGuidance()]);
    assert.equal(host.requests.length, 0);
    voice.dispose();
    assert.equal(releases, 1);
});

test('optional host slots and services degrade, and the style disposer is reference counted and idempotent', async () => {
    const host = harness({ legacy: true });
    const disposeOne = host.ensureMarshalVnextStyles(), disposeTwo = host.ensureMarshalVnextStyles();
    disposeOne();
    disposeOne();
    assert.ok(host.document.getElementById('marshal-vnext-styles'));
    host.plugin.apply(host.ctx);
    assert.ok(host.registrations.has('main'));
    assert.ok(host.registrations.has('sidebar.panellist'));
    assert.equal(host.registrations.has('shell.overlay'), false);
    host.dispose();
    disposeTwo();
    assert.equal(host.document.getElementById('marshal-vnext-styles'), null);
    await flush();
});

test('vNext shards add no polling, external imports or emoji UI and keep bundle ordering', () => {
    for (const name of ['05-vnext-styles', '15-sidebar-left', '22-voice-call', '70-plugin-register']) {
        assert.doesNotMatch(read(`src/${name}.js`), /setInterval\s*\(|\brequire\s*\(|\p{Extended_Pictographic}/u);
    }
    assert.doesNotMatch(read('src/70-plugin-register.js'), /installSidebarWorkspaceSwitch\s*\(/);
    assert.ok(bundle.indexOf('function MemoryPage(') < bundle.indexOf('function AgentDirectChatsView('));
});
