import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const bundle = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const button = (tree, label) => all(tree, node => node.type === 'button' &&
    (node.props['aria-label'] ?? text(node)) === label)[0];
function all(tree, predicate) {
    if (Array.isArray(tree)) return tree.flatMap(child => all(child, predicate));
    if (!tree || typeof tree !== 'object') return [];
    return [...(predicate(tree) ? [tree] : []), ...all(tree.props.children, predicate)];
}
function text(tree) {
    if (Array.isArray(tree)) return tree.map(text).join('');
    if (typeof tree === 'string') return tree;
    return tree?.props ? text(tree.props.children) : '';
}

// Run the shipped factory with a small hook/VDOM host, just as the other plugin
// tests do. Keep real request/auth and SSE code; stub the transport boundary.
function fixture(t, reply) {
    const frames = new Map(), requests = [], storage = new Map(), timers = new Map();
    let frame, index, definition, stream, timerId = 0, counter = 0;
    const React = {
        Component: class {},
        Fragment: Symbol('Fragment'),
        createElement: (type, props, ...children) => ({ type, props: { ...props,
            ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}),
        } }),
        useId() { return frame[index++] ??= 'id-' + ++counter; },
        useRef(current) { return frame[index++] ??= { current }; },
        useState(initial) {
            const cell = frame[index++] ??= { value: typeof initial === 'function' ? initial() : initial };
            return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
        },
        useEffect(setup, deps) {
            const i = index++;
            const old = frame[i];
            if (old && deps.every((value, j) => Object.is(value, old.deps[j]))) return;
            old?.stop?.();
            frame[i] = { deps, stop: setup() };
        },
    };
    const window = Object.assign(new EventTarget(), {
        location: new URL('http://localhost/'),
        __ModuleLoader__: { load(value) { definition = value; } },
    });
    const document = Object.assign(new EventTarget(), { baseURI: window.location.href, cookie: 'marshal-memory-csrf=proof' });
    runInNewContext(bundle, {
        window, document, URL, URLSearchParams, AbortController, TextDecoder,
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        async fetch(raw, init) {
            const url = new URL(raw);
            const body = init.headers['content-type'] === 'application/json' ? JSON.parse(init.body) : init.body;
            const request = { path: url.pathname, url, body, method: init.method ?? 'GET', headers: init.headers, signal: init.signal };
            requests.push(request);
            if (request.path === '/marshal/events') return new Response(new ReadableStream({ start(c) { stream = c; } }));
            const response = await reply(request);
            assert.notEqual(response, undefined, 'unexpected fetch: ' + url.href);
            return response instanceof Response ? response : Response.json(response);
        },
    });
    assert.equal(definition.id, 'dsh-marshal');
    const { components, apply } = definition.factory(name => { assert.equal(name, 'react'); return React; });
    assert.equal(typeof apply, 'function', 'the public components come from the production plugin');
    t.after(() => {
        for (const cells of frames.values()) for (const cell of cells) cell?.stop?.();
    });
    const render = (name, props = {}, root = name) => {
        const seen = new Set();
        const expand = (node, path) => {
            if (Array.isArray(node)) return node.map((child, i) => expand(child, path + '/' + (child?.props?.key ?? i)));
            if (!node || typeof node !== 'object') return node;
            if (typeof node.type !== 'function') return { ...node, props: { ...node.props, children: expand(node.props.children, path) } };
            const key = path + '/' + node.type.name + ':' + (node.props.key ?? '');
            seen.add(key);
            if (!frames.has(key)) frames.set(key, []);
            frame = frames.get(key);
            index = 0;
            return expand(node.type(node.props), key);
        };
        const tree = expand(React.createElement(components[name], props), root + ':');
        for (const [key, cells] of frames) if (key.startsWith(root + ':/') && !seen.has(key)) {
            for (const cell of cells) cell?.stop?.();
            frames.delete(key);
        }
        return tree;
    };
    const emit = async (topic, payload) => {
        stream.enqueue(new TextEncoder().encode(`event: ${topic}\ndata: ${JSON.stringify(payload)}\n\n`));
        await tick();
        for (const [id, { fn, delay }] of [...timers]) if (delay === 80) { timers.delete(id); fn(); }
        await tick();
    };
    return { components, requests, storage, render, emit };
}

test('shipped client factory exposes the desktop components and upload helper', t => {
    const { components } = fixture(t, () => undefined);
    for (const name of ['MarshalAgentModelCascade', 'MarshalCascadeContextPicker', 'MarshalVerticalDagSidebar',
        'MarshalDagNodeModal', 'mvUploadPickerAttachments']) {
        assert.equal(typeof components[name], 'function', name);
    }
});

test('Agent → model → effort filters choices and posts immediately once, then dismisses on success', async t => {
    let release;
    const saved = new Promise(resolve => { release = resolve; });
    const f = fixture(t, () => saved);
    const applied = [];
    const render = () => f.render('MarshalAgentModelCascade', { taskId: 'T-1', onApply: (...args) => applied.push(args),
        agents: [
            { id: 'a', configKey: 'leader', name: 'Lin', role: 'Leader', status: '在线', models: [{ route: 'p/one', label: 'One', efforts: ['low', 'xhigh'] }] },
            { id: 'b', configKey: 'coder', name: 'Sam', models: [{ route: 'p/two', label: 'Two', efforts: ['high'] }] },
        ] });
    const root = 'Agent 模型与思考 (2)';
    button(render(), root).props.onClick();
    assert.equal(all(render(), node => node.props.className === 'mv-cascade3-col').length, 3);
    button(render(), 'LinLeader · 在线').props.onClick();
    button(render(), 'One').props.onClick();
    assert.ok(button(render(), 'low'));
    assert.equal(button(render(), 'Two'), undefined);
    button(render(), 'Sam').props.onClick();
    assert.equal(button(render(), 'low'), undefined);
    button(render(), 'Two').props.onClick();
    assert.ok(button(render(), 'off'));
    const select = button(render(), 'high').props.onClick;
    select(); select();
    await tick();
    assert.equal(f.requests.length, 1);
    const [request] = f.requests;
    assert.equal(request.path, '/marshal/tasks/agent-configs');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['x-marshal-csrf'], 'proof');
    assert.deepEqual(request.body, { taskId: 'T-1', agentConfigs: { coder: { model: 'p/two', reasoningEffort: 'high' } } });
    assert.equal(button(render(), root).props['aria-expanded'], true);
    assert.equal(applied.length, 1, 'notify the consumer before the POST completes');
    release({ ok: true });
    await tick();
    assert.equal(button(render(), root).props['aria-expanded'], false);
    assert.equal(applied.length, 1);
    assert.equal(applied[0][0].agentId, 'b');
});

test('Agent saves only mapped workflow slots and delegates or disables unassigned agents', async t => {
    const f = fixture(t, () => ({ ok: true }));
    const applied = [];
    const agents = [
        { id: 'agent-for-coding', name: 'Assigned' },
        { id: 'coder', name: 'Unassigned' }, // A slot-shaped agent ID isn't a binding.
        { id: 'room/guest', name: 'Guest', configKey: 'room/guest' },
    ].map(agent => ({ ...agent, models: [{ route: 'p/model', efforts: ['low'] }] }));
    const task = { id: 'T-3', workflow: { plan: { members: { coder: 'agent-for-coding' } } } };
    let onApply;
    const render = () => f.render('MarshalAgentModelCascade', { agents, task, onApply });
    const trigger = 'Agent 模型与思考 (3)';
    const choose = name => {
        if (!button(render(), trigger).props['aria-expanded']) button(render(), trigger).props.onClick();
        button(render(), name).props.onClick();
        button(render(), 'p/model').props.onClick();
        return button(render(), 'low');
    };
    const disabled = choose('Unassigned');
    assert.equal(disabled.props.disabled, true);
    disabled.props.onClick();
    await tick();
    assert.equal(f.requests.length, 0);

    onApply = selection => applied.push(JSON.parse(JSON.stringify(selection)));
    const guest = choose('Guest');
    assert.equal(guest.props.disabled, false);
    guest.props.onClick();
    await tick();
    assert.equal(f.requests.length, 0);
    assert.deepEqual(applied, [{ agentId: 'room/guest', model: 'p/model', reasoningEffort: 'low' }]);
    assert.equal(button(render(), trigger).props['aria-expanded'], false);

    onApply = undefined;
    choose('Assigned').props.onClick();
    await tick();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].path, '/marshal/tasks/agent-configs');
    assert.deepEqual(f.requests[0].body, { taskId: task.id, agentConfigs: { coder: { model: 'p/model', reasoningEffort: 'low' } } });
});

test('context cascades across scopes, filters live, and emits removable link and attachment chips', async t => {
    const f = fixture(t, request => ({
        '/marshal/task-rooms/workspaces': { workspaces: [{ id: 'ws', title: '项目' }] },
        '/marshal/agents/sessions': { sessions: [{ sessionId: 's', title: 'Alpha', workspaceId: 'ws', agentKey: 'host/team/agent' },
            { sessionId: 'other', title: 'Beta', workspaceId: 'other-ws', agentKey: 'host/other/agent' }] },
        '/marshal/agent-direct-sessions': { mainSession: { id: 'direct', title: '直连' }, subSessions: [{ id: 'child', title: '子会话' }] },
        '/marshal/tasks/state': { tasks: [{ id: 'ticket', title: '联调', taskRoom: { workspaceId: 'ws' } }] },
        '/marshal/memory/list': { items: [{ id: 'm', title: '部署笔记', content: '上线流程' },
            { title: '团队协作', sourceSession: 'memory-origin' },
            { title: '不可引用' }] },
        '/api/task-board/attachments/upload': { attachment: { kind: 'file', attachmentId: 'att', name: 'notes.txt', bytes: 5 } },
    })[request.path]);
    const changes = [];
    let agentKey;
    const render = () => f.render('MarshalCascadeContextPicker', { agentKey, agentWorkspaceId: 'ws', directAgentSessions: true,
        resolveMemoryLink: item => item.id === 'm' ? { key: 'docPaths', id: 'docs/deploy.md' } : undefined,
        onChange: value => changes.push(JSON.parse(JSON.stringify(value))) });
    const click = label => {
        const item = button(render(), label);
        assert.ok(item, label);
        assert.ok(!item.props.disabled, label);
        item.props.onClick();
        render();
    };
    click('添加上下文');
    assert.equal(button(render(), '近期会话'), undefined);
    await tick();
    click('项目');
    click('近期会话');
    await tick();
    assert.equal(button(render(), 'Beta'), undefined);
    click('Alpha');
    click('关联工单');
    await tick();
    click('联调');
    click('记忆片段');
    await tick();
    assert.equal(button(render(), '不可引用暂无可引用标识').props.disabled, true);
    click('团队协作引用来源会话');
    all(render(), node => node.props.type === 'search')[0].props.onChange({ target: { value: '上线' } });
    assert.equal(button(render(), '不可引用暂无可引用标识'), undefined);
    click('部署笔记上线流程');
    click('本地文件/附件');
    const target = { value: 'selected', files: [{ name: 'notes.txt', type: 'text/plain', size: 5 }] };
    all(render(), node => node.props.type === 'file')[0].props.onChange({ target });
    assert.equal(target.value, '');
    await tick();
    assert.deepEqual(changes.at(-1).links, {
        sessionIds: ['s', 'memory-origin'], proposalIds: ['ticket'], docPaths: ['docs/deploy.md'],
    });
    assert.deepEqual(changes.at(-1).attachments.map(item => item.attachmentId), ['att']);
    click('移除 Alpha');
    assert.deepEqual(changes.at(-1).links.sessionIds, ['memory-origin']);
    agentKey = 'host/team/agent';
    click('全局上下文');
    click('近期会话');
    await tick();
    assert.equal(f.requests.at(-1).path, '/marshal/agents/sessions');
    assert.ok(button(render(), 'Alpha'));
    click('Beta');
    assert.ok(!f.requests.some(r => r.path === '/marshal/agent-direct-sessions'));
    click('项目');
    click('近期会话');
    await tick();
    click('子会话');
    assert.deepEqual(changes.at(-1).links.sessionIds, ['memory-origin', 'other', 'child']);
    assert.equal(f.requests.find(r => r.path === '/marshal/agent-direct-sessions').url.searchParams.get('agentKey'), agentKey);
    assert.equal(f.requests.find(r => r.path === '/marshal/memory/list').url.search, '?scope=workspace&workspaceId=ws');
    assert.ok(f.requests.filter(r => r.path.startsWith('/marshal/')).every(r => r.method === 'GET' && r.headers['x-marshal-csrf'] === 'proof'));
});

test('memory rows with distinct IDs from the same session select independently', async t => {
    const f = fixture(t, () => ({ items: [
        { id: 'mem-a', title: '片段A', sourceSession: 'shared-s' },
        { id: 'mem-b', title: '片段B', sourceSession: 'shared-s' },
    ] }));
    let value;
    const render = () => f.render('MarshalCascadeContextPicker', { workspaces: [],
        onChange: next => { value = JSON.parse(JSON.stringify(next)); },
    });
    const click = label => {
        const item = button(render(), label);
        assert.ok(item && !item.props.disabled, label);
        item.props.onClick();
        render();
    };
    for (const label of ['添加上下文', '全局上下文', '记忆片段']) click(label);
    await tick();
    click('片段A');
    click('片段B');
    const tree = render();
    assert.equal(button(tree, '片段A').props['aria-pressed'], true);
    assert.equal(button(tree, '片段B').props['aria-pressed'], true);
    assert.deepEqual(value.links.proposalIds, ['mem-a', 'mem-b']);
    assert.deepEqual(value.links.sessionIds, []);
});

test('sourceSession-only memory rows at index zero stay independent across scopes', async t => {
    const f = fixture(t, ({ path, url }) => {
        assert.equal(path, '/marshal/memory/list');
        if (url.searchParams.get('scope') === 'global') {
            return { items: [{ title: '全局片段', sourceSession: 'sess-global' }] };
        }
        assert.equal(url.searchParams.get('scope'), 'workspace');
        assert.equal(url.searchParams.get('workspaceId'), 'ws');
        return { items: [{ title: '工作区片段', sourceSession: 'sess-ws' }] };
    });
    let value;
    const render = () => f.render('MarshalCascadeContextPicker', { workspaces: [{ id: 'ws', title: '项目' }],
        onChange: next => { value = JSON.parse(JSON.stringify(next)); },
    });
    const click = label => {
        const item = button(render(), label);
        assert.ok(item && !item.props.disabled, label);
        item.props.onClick();
        render();
    };
    for (const label of ['添加上下文', '全局上下文', '记忆片段']) click(label);
    await tick();
    click('全局片段引用来源会话');
    assert.deepEqual(value.links.sessionIds, ['sess-global']);
    click('项目');
    click('记忆片段');
    await tick();
    assert.equal(button(render(), '工作区片段引用来源会话').props['aria-pressed'], false);
    click('工作区片段引用来源会话');
    const tree = render();
    assert.equal(button(tree, '工作区片段引用来源会话').props['aria-pressed'], true);
    assert.deepEqual(value.links.sessionIds, ['sess-global', 'sess-ws']);
    assert.ok(button(tree, '移除 全局片段'));
    assert.ok(button(tree, '移除 工作区片段'));
});

test('proposalId-only memory rows resolved to the same wire link keep independent selections and chips', async t => {
    const f = fixture(t, () => ({ items: [
        { proposalId: 'mem-a', title: '甲', sourceSession: 'shared-s' },
        { proposalId: 'mem-b', title: '乙', sourceSession: 'shared-s' },
    ] }));
    let value;
    const render = () => f.render('MarshalCascadeContextPicker', { workspaces: [], value,
        onChange: next => { value = JSON.parse(JSON.stringify(next)); },
        resolveMemoryLink: item => ({ key: 'sessionIds', id: item.sourceSession }),
    });
    const click = label => {
        button(render(), label).props.onClick();
        render();
    };
    for (const label of ['添加上下文', '全局上下文', '记忆片段']) click(label);
    await tick();
    click('甲引用来源会话');
    assert.equal(button(render(), '乙引用来源会话').props['aria-pressed'], false);
    click('乙引用来源会话');
    assert.equal(button(render(), '甲引用来源会话').props['aria-pressed'], true);
    assert.equal(button(render(), '乙引用来源会话').props['aria-pressed'], true);
    assert.deepEqual(value.links.sessionIds, ['shared-s']);
    click('移除 甲');
    assert.equal(button(render(), '甲引用来源会话').props['aria-pressed'], false);
    assert.equal(button(render(), '乙引用来源会话').props['aria-pressed'], true);
    assert.deepEqual(value.links.sessionIds, ['shared-s']);
    click('乙引用来源会话');
    assert.deepEqual(value.links.sessionIds, []);
    assert.equal(button(render(), '移除 乙'), undefined);
});

test('attachments reject a second batch over 32 MiB before uploading and accept the exact limit', async t => {
    const mib = 1024 * 1024;
    const f = fixture(t, ({ path, body }) => {
        assert.equal(path, '/api/task-board/attachments/upload');
        return { attachment: { kind: 'file', attachmentId: body.name, name: body.name, bytes: body.size } };
    });
    const changes = [];
    const render = () => f.render('MarshalCascadeContextPicker', { workspaces: [], onChange: value => changes.push(value) });
    for (const label of ['添加上下文', '全局上下文', '本地文件/附件']) button(render(), label).props.onClick();
    const upload = (names, size) => {
        const target = { value: 'selected', files: names.map(name => ({ name, size })) };
        all(render(), node => node.props.type === 'file')[0].props.onChange({ target });
        assert.equal(target.value, '');
    };
    upload(['a.txt', 'b.txt', 'c.txt'], 10 * mib);
    await tick();
    assert.equal(changes.at(-1).attachments.length, 3);
    upload(['over.txt'], 2 * mib + 1);
    await tick();
    assert.equal(f.requests.length, 3, 'no upload starts for a batch that would exceed the cumulative limit');
    assert.equal(changes.length, 1, 'do not emit a changed value with an oversized selection');
    assert.match(text(render()), /附件总大小不能超过 32 MiB/);
    upload(['fits.txt'], 2 * mib);
    await tick();
    assert.equal(f.requests.length, 4);
    assert.equal(changes.at(-1).attachments.reduce((sum, item) => sum + item.bytes, 0), 32 * mib);
    assert.doesNotMatch(text(render()), /附件总大小不能超过/);
});

test('attachment input copies the live FileList, clears it, then starts both uploads concurrently', async t => {
    const steps = [], releases = [];
    const make = name => ({ name, type: 'text/plain', size: 6 });
    const live = [make('a.txt'), make('b.txt')];
    const f = fixture(t, request => {
        assert.equal(request.path, '/api/task-board/attachments/upload');
        assert.equal(request.headers['content-type'], 'application/octet-stream');
        const name = request.url.searchParams.get('name');
        assert.equal(request.body.name, name);
        steps.push(name);
        return new Promise(resolve => releases.push(resolve));
    });
    const target = {
        get files() { steps.push('copy'); return live; },
        set value(next) { assert.equal(next, ''); steps.push('clear'); live.length = 0; },
    };
    const upload = f.components.mvUploadPickerAttachments({ target });
    assert.deepEqual(steps, ['copy', 'clear', 'a.txt', 'b.txt']);
    releases[1](new Response('', { status: 413 }));
    releases[0]({ attachment: { kind: 'file', attachmentId: 'a', name: 'a.txt', mediaType: 'TEXT/PLAIN', sha256: 'AB', width: 5 } });
    const result = JSON.parse(JSON.stringify(await upload));
    assert.deepEqual(result.attachments, [{ kind: 'file', attachmentId: 'a', name: 'a.txt', mediaType: 'text/plain', sha256: 'ab' }]);
    assert.deepEqual(result.errors, ['b.txt：HTTP 413']);
});

const node = (id, data = {}) => ({ id, label: id, status: 'done', ...data });
const layer = (type, ...nodes) => ({ id: 'layer:' + nodes[0].id, type, nodes });
const edges = tree => all(tree, item => item.type === 'path' && item.props.vectorEffect).map(item => item.props.d);

test('DAG projects only returned layers, refreshes on SSE, and remembers clamped drag width', async t => {
    const start = node('开始');
    const run = node('执行', { agentName: 'Lin', role: 'coder', model: 'p/real', durationMs: 9, tokens: { totalTokens: 12 } });
    const end = node('完成');
    let layers = [layer('single', start, run), layer('parallel', end)];
    const f = fixture(t, request => request.path === '/marshal/tasks/dag' ? { layers } : { tasks: [] });
    const render = () => f.render('MarshalVerticalDagSidebar', { taskId: 'T-2', members: '成员扩展', taskDrawer: '任务扩展' });
    render();
    await tick();
    assert.deepEqual(edges(render()), ['M50 0 V24', 'M50 0 V24']);
    assert.match(text(render()), /coder · Linp\/real9 ms · 12 tokens/);
    layers = [layer('single', start), layer('parallel', run, node('实际并行')), layer('single', end)];
    await f.emit('room.message', { roomId: 'room' });
    let tree = render();
    assert.equal(all(tree, item => item.props['data-parallel'] === true).length, 1);
    assert.deepEqual(edges(tree), ['M50 0 C50 12 25 12 25 24', 'M50 0 C50 12 75 12 75 24',
        'M25 0 C25 12 50 12 50 24', 'M75 0 C75 12 50 12 50 24']);
    layers = [layer('parallel', start, run), layer('parallel', end, node('another'), node('and another'))];
    await f.emit('tasks.changed', {});
    tree = render();
    assert.equal(edges(tree).length, 5, 'two parallel layers meet at one shared junction, not pairwise links');
    assert.ok(edges(tree)[0].endsWith('50 12') && edges(tree)[2].startsWith('M50 12'));
    layers = [layer('single', end)];
    await f.emit('tasks.changed', {});
    assert.equal(edges(render()).length, 0);
    const drag = all(render(), item => item.props.role === 'separator')[0].props;
    drag.onPointerDown({ button: 0, pointerId: 3, clientX: 500, currentTarget: { setPointerCapture: id => assert.equal(id, 3) } });
    drag.onPointerMove({ pointerId: 3, clientX: 0 });
    assert.equal(render().props.style.width, 520);
    drag.onPointerMove({ pointerId: 3, clientX: 900 });
    assert.equal(render().props.style.width, 260);
    drag.onLostPointerCapture({ pointerId: 3 });
    assert.equal(f.render('MarshalVerticalDagSidebar', {}, 'other-sidebar').props.style.width, 260);
    button(render(), '群聊成员').props.onClick();
    assert.match(text(render()), /成员扩展/);
    button(render(), '任务清单').props.onClick();
    assert.match(text(render()), /任务扩展/);
    button(render(), '收起右栏').props.onClick();
    tree = render();
    assert.equal(tree.props['data-collapsed'], true);
    assert.equal(all(tree, item => item.props.role === 'separator').length, 0);
    button(tree, '展开右栏').props.onClick();
    assert.equal(render().props.style.width, 260);
    assert.ok(f.requests.filter(r => r.path === '/marshal/tasks/dag')
        .every(r => r.url.searchParams.get('taskId') === 'T-2' && r.headers['x-marshal-csrf'] === 'proof'));
});

test('node click fetches decoded detail with auth; modal and header share review actions', async t => {
    const taskId = 'T /&';
    const id = 'patch:?&';
    let task = { id: taskId, status: 'review' };
    const f = fixture(t, request => {
        if (request.path === '/marshal/tasks/state') return { tasks: [task] };
        if (request.path === '/marshal/tasks/dag') return { layers: [layer('single', node(id, { label: '补丁节点' }))] };
        if (request.path === '/marshal/tasks/dag/node') return { node: node(id, { summary: '真实摘要', diffFiles: ['src/a.js'],
            diff: '--- a/src/a.js\n+++ b/src/a.js\n-old\n+new', logs: [{ id: 'real', text: '真实日志', actor: 'Coder' }], patchDigest: 'abc' }) };
        if (request.path === '/marshal/tasks/confirm-review') {
            task = { ...task, status: 'done' };
            return { tasks: [task] };
        }
        if (request.path === '/marshal/tasks/revise') return { ok: true };
    });
    const render = () => f.render('MarshalVerticalDagSidebar', { taskId });
    render();
    await tick();
    all(render(), item => item.props.className === 'mv-dag-node')[0].props.onClick();
    const dialog = () => all(render(), item => item.type === 'dialog')[0];
    dialog();
    await tick();
    const detail = f.requests.find(r => r.path === '/marshal/tasks/dag/node');
    assert.equal(detail.url.searchParams.get('taskId'), taskId);
    assert.equal(detail.url.searchParams.get('nodeId'), id);
    assert.equal(detail.headers['x-marshal-csrf'], 'proof');
    assert.match(text(dialog()), /真实摘要.*src\/a\.js/s);
    assert.match(text(dialog()), /真实日志.*未返回产物路径.*abc/s);
    assert.deepEqual(all(dialog(), item => item.props['data-change']).map(item => [item.props['data-change'], text(item)]),
        [['remove', '-old\n'], ['add', '+new\n']]);
    const topConfirm = button(render(), '确认验收');
    button(dialog(), '确认验收').props.onClick();
    topConfirm.props.onClick();
    await tick();
    const writes = f.requests.filter(r => r.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/marshal/tasks/confirm-review');
    assert.equal(writes[0].headers['x-marshal-csrf'], 'proof');
    assert.deepEqual(writes[0].body, { taskId, applyPatch: false });
    assert.equal(button(render(), '打回返工'), undefined);
    button(dialog(), '关闭节点详情').props.onClick();
    assert.equal(dialog(), undefined);

    const reviewed = [];
    const standalone = () => f.render('MarshalDagNodeModal', { taskId, nodeId: id, task: { status: 'review' },
        onClose() {}, onReview: (...args) => reviewed.push(args) });
    button(standalone(), '打回返工').props.onClick();
    await tick();
    assert.deepEqual(reviewed, [['revise', taskId]]);
    const defaultModal = f.render('MarshalDagNodeModal', { taskId, nodeId: id, task: { status: 'review' }, onClose() {} }, 'default-review');
    button(defaultModal, '打回返工').props.onClick();
    await tick();
    const revise = f.requests.find(r => r.path === '/marshal/tasks/revise');
    assert.equal(revise.headers['x-marshal-csrf'], 'proof');
    assert.deepEqual(revise.body, { taskId });
});

test('review actions return on a new run without an intervening non-review state', async t => {
    const taskId = 'T';
    let task = { id: taskId, status: 'review', workflow: { runId: 'run-1' } };
    const f = fixture(t, ({ path }) => {
        if (path === '/marshal/tasks/state') return { tasks: [task] };
        if (path === '/marshal/tasks/dag') return { layers: [] };
    });
    const actions = [];
    const render = () => f.render('MarshalVerticalDagSidebar', { taskId,
        onReview: (...args) => { actions.push(args); },
    });
    render();
    await tick();
    button(render(), '打回返工').props.onClick();
    await tick();
    assert.deepEqual(actions, [['revise', taskId]]);
    assert.equal(button(render(), '确认验收'), undefined);
    assert.equal(button(render(), '打回返工'), undefined);

    task = { id: taskId, status: 'review', workflow: { state: 'review-blocked', runId: 'run-2' } };
    await f.emit('tasks.changed', { taskId });
    for (const label of ['确认验收', '打回返工']) assert.equal(button(render(), label).props.disabled, false);
    button(render(), '打回返工').props.onClick();
    await tick();
    assert.deepEqual(actions, [['revise', taskId], ['revise', taskId]]);
});

test('a node refresh that returns 404 removes the previous Diff and logs', async t => {
    let exists = true;
    const f = fixture(t, ({ path }) => {
        assert.equal(path, '/marshal/tasks/dag/node');
        return exists
            ? { node: node('n', { diff: '-old\n+stale', logs: [{ text: '过期日志' }] }) }
            : Response.json({ message: '节点已不存在' }, { status: 404 });
    });
    const render = refresh => f.render('MarshalDagNodeModal', { taskId: 'T', nodeId: 'n', refresh, onClose() {} });
    render(0);
    await tick();
    assert.match(text(render(0)), /\+stale/);
    exists = false;
    render(1);
    await tick();
    const failed = render(1);
    assert.equal(f.requests.length, 2);
    assert.match(text(all(failed, item => item.props.role === 'alert')[0]), /节点已不存在/);
    assert.equal(all(failed, item => item.props.className === 'mv-dag-diff').length, 0);
    assert.doesNotMatch(text(failed), /\+stale|过期日志/);
});
