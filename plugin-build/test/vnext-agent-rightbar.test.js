import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const bundle = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
const agent = { agentKey: 'host/team/coder', teamId: 'team', agentId: 'coder', name: 'Coder', workspaceId: 'ws', sessionId: 'recent-ticket-run' };
const ticket = { id: 'ticket-1', ticketNo: 'T-042', title: '关联工单', taskRoom: { id: 'room', taskId: 'ticket-1', workspaceId: 'ws' } };
const personal = { id: 't1', type: 'direct', title: '调研', status: 'running', subSessions: [
    { id: 'child-1', title: '子会话一' }, { id: 'child-2', title: '子会话二' },
] };
const synthetic = { id: 'ticket:host%2Fteam%2Fcoder:ticket-1', type: 'ticket', linkedTicketId: ticket.id,
    title: '关联工单', status: 'review', subSessions: [{ id: 'blocked', title: '不可跳转' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
const submit = { preventDefault() {} };
const tasksSlot = 'sidebar.right.pane.tab', dockSlot = 'conversation.input.dock', overlaySlot = 'shell.overlay';

function fixture(t, { lite = false, mountedRightbar = false, ticketRows = [ticket], directoryAgent = agent,
    directoryTeams = [{ id: 'team', name: 'marshal-agent:coder', members: [{ id: 'coder' }] }],
    workspaces = [], openTaskRoom, directMain = { sessionId: 'direct' }, directChildren = [{ id: 'actual-child' }],
    strictRun = false } = {}) {
    const slots = new Map(), registry = new Map(), effects = [], calls = [], requests = [], timers = new Map();
    const directDeliveries = [];
    let loaded, api, frame, index, timerId = 0, stream, taskRows = [personal, synthetic];
    const window = Object.assign(new EventTarget(), {
        location: new URL('http://localhost/'), __ModuleLoader__: { load: definition => { loaded = definition; } },
        capture: value => { api = value; },
    });
    window.addEventListener('marshal:room', event => calls.push(['room', event.detail]));
    const document = Object.assign(new EventTarget(), { baseURI: window.location.href, cookie: 'marshal-memory-csrf=test' });
    const React = {
        Fragment: Symbol(), Component: class {},
        createElement: (type, props, ...children) => ({ type, props: { ...props,
            ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}),
        } }),
        useRef(value) { return frame[index++] ??= { current: value }; },
        useState(value) {
            const cell = frame[index++] ??= { value: typeof value === 'function' ? value() : value };
            return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
        },
        useEffect(setup, deps) {
            const i = index++;
            const old = frame[i];
            if (old && old.deps?.length === deps?.length && deps.every((value, j) => Object.is(value, old.deps[j]))) return;
            old?.stop?.();
            frame[i] = { deps, stop: setup() };
        },
        useSyncExternalStore(_subscribe, snapshot) { return snapshot(); },
    };
    const marker = '    return {\n      inject: [';
    runInNewContext(bundle.replace(marker, `    window.capture({
      mvOpenAgentDirectSession, mvTaskMutation, mvSubmitGuidance, createMvStore,
    });\n${marker}`), {
        document, window, URL, URLSearchParams, AbortController, CustomEvent, TextDecoder,
        performance: { now: () => 0 },
        setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        async fetch(url, init) {
            url = new URL(url);
            const path = url.pathname;
            const body = init.body && JSON.parse(init.body);
            requests.push({ path, url, auth: init.headers['x-marshal-csrf'], method: init.method ?? 'GET', body, signal: init.signal });
            if (path === '/marshal/events') return new Response(new ReadableStream({
                start(controller) { stream = controller; },
            }), { headers: { 'content-type': 'text/event-stream' } });
            if (path === '/marshal/agent-tasks') return Response.json({ tasks: taskRows });
            if (path === '/marshal/agent-tasks/create') {
                const task = { ...body, id: 'new', status: 'queued', subSessions: [] };
                taskRows = [...taskRows, task];
                return Response.json({ task });
            }
            if (path === '/marshal/agent-tasks/update') {
                taskRows = taskRows.map(task => task.id === body.id ? { ...task, ...body.patch } : task);
                return Response.json({ ok: true });
            }
            if (path === '/marshal/agent-tasks/delete') {
                taskRows = taskRows.filter(task => task.id !== body.id);
                return Response.json({ ok: true });
            }
            if (path === '/dsh-agents/api/run' && strictRun && body?.purpose !== undefined) {
                // The standalone agents plugin refuses a field its own build does not read.
                return Response.json({ ok: false, code: 'invalid-request',
                    error: 'the run request does not name one member of one team' }, { status: 400 });
            }
            if (path === '/marshal/task-rooms/open' && openTaskRoom) return openTaskRoom(body);
            if (path === '/marshal/agents/guidance-sync' && !body.targetTicketId) {
                // Match the API contract: direct recipients come from persisted task bindings.
                for (const id of body.taskIds) directDeliveries.push(taskRows.find(task => task.id === id)?.sessionId ?? 'direct');
            }
            const data = {
                '/marshal/desktop/overview': { host: { deviceId: 'host' }, agents: { items: [directoryAgent] } },
                '/marshal/rosters/state': { rosters: { ws: { coderId: 'team/coder' } } },
                '/marshal/tasks/state': { tasks: ticketRows },
                '/marshal/task-rooms/workspaces': { workspaces },
                '/marshal/task-rooms/open': { room: { id: 'opened-room', taskId: body?.taskId, workspaceId: body?.workspaceId } },
                '/marshal/agent-direct-sessions': { agentKey: agent.agentKey, mainSession: directMain, subSessions: directChildren },
                '/dsh-agents/api/run': { run: { sessionId: 'new-native' } },
                '/dsh-agents/api/state': { teams: directoryTeams },
            };
            return Response.json(data[path] ?? { ok: true });
        },
    });
    const sidebarRight = { openTab(kind) { calls.push(['tab', kind]); } };
    if (mountedRightbar) sidebarRight.active = () => undefined;
    const ctx = {
        slots: {
            inject(_name, install) { return install(); },
            register(options, component) {
                slots.set(options.name, { options, component });
                return { dispose: () => slots.delete(options.name) };
            },
        },
        effect(install) { effects.push(install()); },
        layout: { selectPanel(id) { calls.push(['panel', id]); } },
        uiWorkspace: { openSession(id) { calls.push(['session', id]); } },
        ...(!lite && { sidebarRight, sidebarRightTabs: { register(def) {
            registry.set(def.id, def);
            return () => registry.delete(def.id);
        } } }),
    };
    loaded.factory(name => { assert.equal(name, 'react'); return React; }).apply(ctx);

    const roots = [];
    function mount(seat, props = {}) {
        const frames = new Map();
        roots.push(frames);
        const expand = (node, path) => {
            if (Array.isArray(node)) return node.map((child, i) => expand(child, path + ':' + (child?.props?.key ?? i)));
            if (!node || typeof node !== 'object') return node;
            if (typeof node.type === 'function') {
                const key = path + '/' + node.type.name + ':' + (node.props.key ?? '');
                if (!frames.has(key)) frames.set(key, []);
                frame = frames.get(key);
                index = 0;
                return expand(node.type(node.props), key);
            }
            return { ...node, props: { ...node.props, children: expand(node.props.children, path) } };
        };
        return () => expand(React.createElement(slots.get(seat).component, props), seat);
    }
    const dispose = () => {
        for (const root of roots.splice(0)) for (const cells of root.values()) for (const cell of cells) cell?.stop?.();
        for (const stop of effects.splice(0).reverse()) stop?.();
    };
    t.after(dispose);
    return { ...api, slots, registry, ctx, calls, requests, directDeliveries, mount, dispose,
        replaceRows(rows) { taskRows = rows; },
        setDirectMain(session) { directMain = session; },
        runTimers(delay) {
            for (const [id, task] of [...timers]) if (task.delay === delay) { timers.delete(id); task.fn(); }
        },
        async emit(topic) {
            stream.enqueue(new TextEncoder().encode(`event: ${topic}\ndata: {}\n\n`));
            await tick();
            this.runTimers(100);
            await tick();
        },
    };
}

function find(node, match) {
    if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean);
    if (!node || typeof node !== 'object') return;
    return match(node) ? node : find(node.props?.children, match);
}
const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' ? node :
    typeof node === 'number' ? String(node) : node ? text(node.props?.children) : '';
const byText = (tree, label) => find(tree, node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
const field = (tree, label) => find(tree, node => node.props?.['aria-label'] === label);
const form = tree => find(tree, node => node.type === 'form');
const change = (node, value) => node.props.onChange({ target: { value } });
async function settle(render) {
    for (let i = 0; i < 4; i++) { render(); await tick(); }
    return render();
}

test('official tab, keyed pane and composer dock register and dispose together; slim host is optional', t => {
    const full = fixture(t);
    const def = full.registry.get('dsh-marshal/agent-tasks');
    assert.deepEqual({ ...def, title: def.title() }, {
        id: 'dsh-marshal/agent-tasks', kind: 'marshal-agent-tasks', title: '智能体任务', priority: 'extension', keepMounted: true,
    });
    assert.equal(full.slots.get(tasksSlot).options.key, def.id);
    assert.equal(full.slots.get(dockSlot).options.id, def.id);
    assert.equal(full.slots.has('conversation.composer.bar'), false);
    full.dispose();
    assert.equal(full.registry.size, 0);
    assert.equal(full.slots.size, 0);
    const lite = fixture(t, { lite: true });
    assert.equal(lite.slots.has(tasksSlot), false);
    assert.ok(lite.slots.has(dockSlot));
});

test('Plan A opens a resident DSH session before the right tab and records focus', async t => {
    const host = fixture(t);
    const render = host.mount('sidebar.session.action', { wide: true });
    await settle(render);
    await byText(render(), '1:1 直连').props.onClick();
    assert.deepEqual(host.calls, [['panel', null], ['session', 'direct'], ['tab', 'marshal-agent-tasks']]);
    const lookup = host.requests.find(req => req.path === '/marshal/agent-direct-sessions');
    assert.equal(lookup.url.searchParams.get('agentKey'), agent.agentKey);
    assert.equal(lookup.auth, 'test');
    assert.match(text(await settle(host.mount(tasksSlot))), /Coder/);
    const focus = host.createMvStore(null);
    const lite = fixture(t, { lite: true });
    assert.equal(await lite.mvOpenAgentDirectSession({
        agent, ctx: {}, uiWorkspace: lite.ctx.uiWorkspace, sessionId: 'resident', mvFocusedAgentStore: focus,
    }), undefined);
    assert.equal(focus.getSnapshot().navigationSessionId, 'resident');
});

test('rightbar without a screen query waits for the destination dock and retries a rejected openTab', async t => {
    const host = fixture(t, { mountedRightbar: true });
    const openTab = host.ctx.sidebarRight.openTab;
    let attempts = 0;
    host.ctx.sidebarRight.openTab = async kind => {
        if (++attempts === 1) throw Error('surface not mounted');
        openTab(kind);
    };
    const side = host.mount('sidebar.session.action', { wide: true });
    await settle(side);
    await byText(side(), '1:1 直连').props.onClick();
    assert.deepEqual(host.calls, [['panel', null], ['session', 'direct']]);
    host.mount(dockSlot, { sessionId: 'previous' })();
    host.runTimers(0);
    assert.equal(host.calls.length, 2);
    assert.equal(attempts, 0);
    host.mount(dockSlot, { sessionId: 'direct' })();
    host.runTimers(0);
    await tick();
    assert.equal(attempts, 1);
    assert.equal(host.calls.length, 2);
    host.runTimers(50);
    await tick();
    assert.equal(attempts, 2);
    assert.deepEqual(host.calls.at(-1), ['tab', 'marshal-agent-tasks']);
});

test('native navigation waits for the late rightbar and never opens a tab on the outgoing surface', async t => {
    const host = fixture(t);
    const rightbar = host.ctx.sidebarRight;
    delete host.ctx.sidebarRight;
    const side = host.mount('sidebar.session.action', { wide: true });
    await settle(side);
    const navigating = byText(side(), '1:1 直连').props.onClick();
    await tick();
    assert.deepEqual(host.calls, [['panel', null], ['session', 'direct']]);
    host.ctx.sidebarRight = rightbar;
    rightbar.screen = () => ({ sessionId: 'previous' });
    host.runTimers(50);
    await tick();
    assert.equal(host.calls.length, 2);
    rightbar.screen = () => undefined;
    host.runTimers(150);
    await tick();
    assert.equal(host.calls.length, 2);
    rightbar.screen = () => ({ sessionId: 'direct' });
    host.runTimers(400);
    await navigating;
    assert.deepEqual(host.calls, [['panel', null], ['session', 'direct'], ['tab', 'marshal-agent-tasks']]);
});

test('native openers fall back in order and report exhausted rightbar retries without undoing the session', async t => {
    const host = fixture(t, { lite: true });
    const calls = [];
    const focus = host.createMvStore(null);
    const navigating = host.mvOpenAgentDirectSession({
        agent, mvFocusedAgentStore: focus,
        ctx: {
            layout: { selectPanel(id) { calls.push(['panel', id]); throw Error('no layout'); } },
            sidebarRight: { openTab(kind) { calls.push(['tab', kind]); throw Error('no tab'); } },
        },
        onOpenAgentDirect() { calls.push(['resolve']); return 'resident'; },
        sessionBridge: { openSession(id) { calls.push(['bridge', id]); return false; } },
        uiWorkspace: { openSession(id) { calls.push(['workspace', id]); throw Error('not available'); } },
        openSessionRef: { current(id) { calls.push(['ref', id]); } },
    });
    await tick();
    assert.equal(focus.getSnapshot().navigationSessionId, 'resident');
    assert.deepEqual(calls, [['panel', null], ['resolve'], ['bridge', 'resident'],
        ['workspace', 'resident'], ['ref', 'resident'], ['tab', 'marshal-agent-tasks']]);
    for (const delay of [50, 150, 400, 1000]) {
        host.runTimers(delay);
        await tick();
    }
    assert.match(await navigating, /无法打开任务清单/);
    assert.equal(calls.filter(([kind]) => kind === 'tab').length, 5);
    assert.equal(calls.filter(([kind]) => kind === 'ref').length, 1);
});

test('plugin disposal cancels native rightbar retries before they can open on another surface', async t => {
    const host = fixture(t);
    host.ctx.sidebarRight.openTab = kind => { host.calls.push(['tab', kind]); return false; };
    const side = host.mount('sidebar.session.action', { wide: true });
    await settle(side);
    const navigating = byText(side(), '1:1 直连').props.onClick();
    await tick();
    assert.deepEqual(host.calls, [['panel', null], ['session', 'direct'], ['tab', 'marshal-agent-tasks']]);
    host.dispose();
    host.runTimers(50);
    await navigating;
    assert.equal(host.calls.filter(([kind]) => kind === 'tab').length, 1);
});

test('tab hook identifies a child session, top casual card unbinds focus, and CRUD uses workspace auth', async t => {
    const host = fixture(t);
    const pane = host.mount(tasksSlot, { sessionId: 'wrong', hooks: { tabInfo: () => ({ sessionId: 'actual-child' }) } });
    const tree = await settle(pane);
    assert.equal(text(tree.props.children[0].props.children[0]), '自由闲聊（不绑定任务）');
    byText(tree, '调研').props.onClick();
    assert.equal(byText(pane(), '自由闲聊（不绑定任务）').props['aria-pressed'], false);
    byText(pane(), '自由闲聊（不绑定任务）').props.onClick();
    assert.equal(byText(pane(), '自由闲聊（不绑定任务）').props['aria-pressed'], true);
    assert.equal(field(pane(), '新任务类型').props.value, 'casual');
    change(field(pane(), '新任务标题'), '  随手记录  ');
    await form(pane()).props.onSubmit(submit);
    await change(field(pane(), '任务状态：调研'), 'done');
    const row = find(pane(), node => node.type === 'article' && text(node).includes('随手记录'));
    byText(row, '删除任务').props.onClick();
    await byText(pane(), '确认删除').props.onClick();
    const mutations = host.requests.filter(req => req.path.startsWith('/marshal/agent-tasks/'));
    assert.deepEqual(mutations.map(({ path, body, auth, method }) => [path, body, auth, method]), [
        ['/marshal/agent-tasks/create', { agentKey: agent.agentKey, type: 'casual', title: '随手记录' }, 'test', 'POST'],
        ['/marshal/agent-tasks/update', { agentKey: agent.agentKey, id: 't1', patch: { status: 'done' } }, 'test', 'POST'],
        ['/marshal/agent-tasks/delete', { agentKey: agent.agentKey, id: 'new' }, 'test', 'POST'],
    ]);
    assert.equal(byText(pane(), '随手记录'), undefined);
});

test('task sub-session links navigate without proving a direct binding', async t => {
    const host = fixture(t);
    const pane = host.mount(tasksSlot, { sessionId: 'direct' });
    await settle(pane);
    await byText(pane(), '子会话二').props.onClick();
    assert.deepEqual(host.calls.slice(-3), [['panel', null], ['session', 'child-2'], ['tab', 'marshal-agent-tasks']]);
    const requestCount = host.requests.length;
    const openedChild = host.mount(tasksSlot, { sessionId: 'child-2' });
    await settle(openedChild);
    assert.ok(host.requests.slice(requestCount).some(req => req.path === '/marshal/agent-direct-sessions' &&
        req.method === 'GET' && req.url.searchParams.get('agentKey') === agent.agentKey && req.auth === 'test'));
    assert.match(text(openedChild()), /当前会话非 1:1 直连会话/);
    assert.ok(byText(openedChild(), '打开该智能体 1:1 会话'));
    change(field(openedChild(), '新任务标题'), '子会话任务');
    await form(openedChild()).props.onSubmit(submit);
    assert.deepEqual(host.requests.find(req => req.path.endsWith('/agent-tasks/create')).body,
        { agentKey: agent.agentKey, type: 'direct', title: '子会话任务' });
});

test('synthetic ticket only opens its room or selects guidance; dock and voice share its numbered action', async t => {
    const host = fixture(t);
    const pane = host.mount(tasksSlot, { useTabInfo: () => ({ tab: { sessionId: 'direct' } }) });
    const dock = host.mount(dockSlot, { sessionId: 'direct' });
    const overlay = host.mount(overlaySlot);
    await settle(overlay);
    await settle(pane);
    const row = find(pane(), node => node.type === 'article' && text(node).includes('关联工单'));
    assert.equal(byText(row, '删除任务'), undefined);
    assert.equal(find(row, node => node.type === 'select' || node.type === 'details'), undefined);
    assert.throws(() => host.mvTaskMutation('delete', agent.agentKey, { id: synthetic.id }), /只读/);
    await byText(row, '打开工单群 #T-042').props.onClick();
    assert.equal(host.calls.at(-1)[1].item.id, 'room');
    field(row, '选入同步指导：关联工单').props.onChange();
    const label = '汇总并同步指导至 #T-042';
    assert.ok(byText(pane(), label));
    assert.ok(byText(await settle(dock), label));
    assert.match(text(dock()), /SenseVoice 听写仍在输入框/);
    byText(dock(), '语音通话').props.onClick();
    await tick();
    change(find(overlay(), node => node.type === 'textarea'), '纪要正文');
    byText(overlay(), '挂断并生成纪要').props.onClick();
    await tick();
    byText(overlay(), label).props.onClick();
    const modal = () => find(overlay(), node => node.type === 'dialog');
    assert.match(text(modal()), /Coder.*关联工单/);
    byText(modal(), '@Coder').props.onClick();
    change(find(modal(), node => node.type === 'input'), '请执行');
    await form(modal()).props.onSubmit(submit);
    const sent = host.requests.find(req => req.path === '/marshal/agents/guidance-sync');
    assert.deepEqual([sent.method, sent.auth, sent.body], ['POST', 'test', {
        agentKey: agent.agentKey, taskIds: [synthetic.id], targetTicketId: ticket.id, wakeTicket: true, guidanceText: '纪要正文\n\n@Coder 请执行',
    }]);
    assert.match(text(modal()), /已同步指导至 #T-042，已唤醒工单/);
});

test('voice guidance follows the new task selection and cannot submit tasks across tickets', async t => {
    const otherTicket = { id: 'ticket-2', ticketNo: 'T-043', title: '新工单' };
    const other = { ...synthetic, id: 't2', linkedTicketId: otherTicket.id, title: '新工单任务' };
    const same = { ...other, id: 't3', title: '同工单另一任务' };
    const host = fixture(t, { ticketRows: [ticket, otherTicket] });
    host.replaceRows([personal, synthetic, other, same]);
    const pane = host.mount(tasksSlot, { sessionId: 'direct' });
    const overlay = host.mount(overlaySlot);
    await settle(overlay);
    await settle(pane);
    const pick = task => field(pane(), '选入同步指导：' + task.title).props.onChange();
    pick(synthetic);
    byText(pane(), '语音通话').props.onClick();
    await tick();
    pick(other); // Selection changes while the call is still active.
    change(find(overlay(), node => node.type === 'textarea'), '本次纪要');
    byText(overlay(), '挂断并生成纪要').props.onClick();
    await tick();
    byText(overlay(), '保存为 1:1 任务').props.onClick();
    await tick(); // The saved summary itself is bound to the original ticket.
    byText(overlay(), '汇总提交同步指导').props.onClick();
    const modal = () => find(overlay(), node => node.type === 'dialog');
    const sent = () => host.requests.filter(req => req.path.endsWith('/guidance-sync'));
    assert.match(text(modal()), /请选择同一工单下的任务/);
    assert.equal(byText(modal(), '确认同步指导').props.disabled, true);
    await form(modal()).props.onSubmit(submit);
    assert.deepEqual(sent(), []);
    assert.throws(() => host.mvSubmitGuidance({
        agentKey: agent.agentKey, tasks: [other], targetTicketId: ticket.id, guidanceText: '本次纪要',
    }), /请选择同一工单下的任务/);
    byText(modal(), '关闭同步指导').props.onClick();
    modal(); // Render the modal closed before reopening it.

    pick(synthetic);
    pick(other);
    pick(personal);
    byText(overlay(), '汇总提交同步指导').props.onClick();
    assert.equal(find(modal(), node => node.type === 'select').props.value, '');
    assert.deepEqual(sent(), []);
    byText(modal(), '关闭同步指导').props.onClick();
    modal();

    pick(personal);
    pick(other);
    pick(same);
    assert.equal(byText(overlay(), '汇总并同步指导至 #T-042'), undefined);
    byText(overlay(), '汇总并同步指导至 #T-043').props.onClick();
    assert.equal(find(modal(), node => node.type === 'select').props.value, otherTicket.id);
    assert.equal(find(modal(), node => node.type === 'select').props.disabled, true);
    await form(modal()).props.onSubmit(submit);
    assert.deepEqual(sent().map(req => req.body), [{
        agentKey: agent.agentKey, taskIds: [other.id, same.id], guidanceText: '本次纪要', targetTicketId: otherTicket.id, wakeTicket: true,
    }]);
});

test('guidance rejects a task relinked by a refresh while its modal is open', async t => {
    const host = fixture(t);
    const pane = host.mount(tasksSlot, { sessionId: 'direct' });
    const overlay = host.mount(overlaySlot);
    await settle(pane);
    field(pane(), '选入同步指导：关联工单').props.onChange();
    byText(pane(), '汇总并同步指导至 #T-042').props.onClick();
    const modal = () => find(overlay(), node => node.type === 'dialog');
    change(find(modal(), node => node.type === 'textarea'), '继续');
    host.replaceRows([{ ...synthetic, linkedTicketId: 'new-target' }]);
    await host.emit('tasks.changed');
    await form(modal()).props.onSubmit(submit);
    assert.match(text(modal()), /任务关联已变更/);
    assert.ok(!host.requests.some(req => req.path.endsWith('/guidance-sync')));
});

const unboundTicket = { id: 'plain', ticketNo: 'T-050', title: '普通工单' };
const unusableWorkspaces = [{ id: 'pseudo', name: 'Agent · Coder' }, { id: '' }, { id: 'bad\nid' }];
const guidanceWrites = host => host.requests.filter(req =>
    req.path === '/marshal/task-rooms/open' || req.path === '/marshal/agents/guidance-sync');

async function openUnboundGuidance(host, linked = true) {
    host.replaceRows([{ ...personal, type: linked ? 'direct' : 'casual', lastSummary: '决策',
        ...(linked ? { linkedTicketId: unboundTicket.id } : {}) }]);
    const pane = host.mount(tasksSlot, { sessionId: 'direct' });
    const overlay = host.mount(overlaySlot);
    await settle(pane);
    field(pane(), '选入同步指导：调研').props.onChange();
    byText(pane(), linked ? '汇总并同步指导至 #T-050' : '汇总提交同步指导').props.onClick();
    const modal = () => find(overlay(), node => node.type === 'dialog');
    if (!linked) change(find(modal(), node => node.type === 'select'), unboundTicket.id);
    await settle(modal);
    return modal;
}

test('guidance to a selected unbound ticket waits for workspace choice and a successful room open', async t => {
    let finishOpen;
    const host = fixture(t, { ticketRows: [unboundTicket], directoryAgent: { ...agent, workspaceId: null },
        workspaces: [{ id: 'ws-1', name: '一' }, ...unusableWorkspaces, { id: 'ws-2', name: '二' }],
        openTaskRoom: () => new Promise(resolve => { finishOpen = resolve; }),
    });
    const modal = await openUnboundGuidance(host, false);
    const picker = field(modal(), '选择目标工单工作区');
    assert.equal(picker.type, 'select');
    assert.deepEqual(picker.props.children.flat().map(option => option.props.value), ['', 'ws-1', 'ws-2']);
    assert.match(text(modal()), /请先选择工单群工作区/);
    assert.equal(byText(modal(), '确认同步指导').props.disabled, true);
    await form(modal()).props.onSubmit(submit);
    assert.deepEqual(guidanceWrites(host), []);
    assert.ok(host.requests.some(req => req.path === '/marshal/task-rooms/workspaces' && req.auth === 'test'));

    change(picker, 'ws-2');
    assert.equal(byText(modal(), '确认同步指导').props.disabled, false);
    const submitting = form(modal()).props.onSubmit(submit);
    await tick();
    assert.deepEqual(guidanceWrites(host).map(({ path, method, auth, body }) => [path, method, auth, body]), [
        ['/marshal/task-rooms/open', 'POST', 'test', { taskId: unboundTicket.id, workspaceId: 'ws-2' }],
    ]);
    finishOpen(Response.json({ room: { id: 'opened-room' } }));
    await submitting;
    const [open, sync] = guidanceWrites(host);
    assert.equal(guidanceWrites(host).length, 2);
    assert.equal(sync.signal, open.signal);
    assert.deepEqual([sync.path, sync.method, sync.auth, sync.body], ['/marshal/agents/guidance-sync', 'POST', 'test', {
        agentKey: agent.agentKey, taskIds: [personal.id], guidanceText: '决策', targetTicketId: unboundTicket.id, wakeTicket: true,
    }]);
    assert.match(text(modal()), /已唤醒工单/);
});

test('guidance to a preselected unbound ticket blocks submission when no valid workspace exists', async t => {
    const host = fixture(t, { ticketRows: [unboundTicket], directoryAgent: { ...agent, workspaceId: '\n' },
        workspaces: unusableWorkspaces });
    const modal = await openUnboundGuidance(host);
    assert.match(text(modal()), /没有可用的工单工作区。/);
    assert.equal(byText(modal(), '确认同步指导').props.disabled, true);
    await form(modal()).props.onSubmit(submit);
    assert.deepEqual(guidanceWrites(host), []);
});

test('guidance auto-selects the agent or sole workspace and stops if opening the room fails', async t => {
    for (const workspaceId of [agent.workspaceId, undefined]) {
        const host = fixture(t, { ticketRows: [unboundTicket], directoryAgent: { ...agent, workspaceId },
            workspaces: [...unusableWorkspaces, { id: 'ws-1' }],
            openTaskRoom: () => workspaceId ? Response.json({ ok: false, message: '无法绑定工单群' }, { status: 403 }) :
                Response.json({ ok: true }) });
        const modal = await openUnboundGuidance(host);
        assert.equal(field(modal(), '选择目标工单工作区'), undefined);
        assert.equal(byText(modal(), '确认同步指导').props.disabled, false);
        await form(modal()).props.onSubmit(submit);
        const writes = guidanceWrites(host);
        assert.deepEqual(writes.map(({ path, body }) => [path, body]), [
            ['/marshal/task-rooms/open', { taskId: unboundTicket.id, workspaceId: workspaceId ?? 'ws-1' }],
        ]);
        assert.equal(host.requests.some(req => req.path === '/marshal/task-rooms/workspaces' && req.signal === writes[0].signal),
            !workspaceId);
        assert.match(text(modal()), /打开目标工单群失败/);
        if (!workspaceId) assert.match(text(modal()), /未确认工单群已绑定/);
    }
});

test('guidance uses a newer room binding received while the modal is open', async t => {
    const ticketRows = [unboundTicket];
    const host = fixture(t, { ticketRows, directoryAgent: { ...agent, workspaceId: null } });
    const modal = await openUnboundGuidance(host);
    assert.equal(byText(modal(), '确认同步指导').props.disabled, true);
    ticketRows[0] = { ...unboundTicket, taskRoom: { id: 'now-bound' } };
    await host.emit('tasks.changed');
    assert.equal(byText(modal(), '确认同步指导').props.disabled, false);
    await form(modal()).props.onSubmit(submit);
    assert.deepEqual(guidanceWrites(host).map(req => req.path), ['/marshal/agents/guidance-sync']);
});

test('associated tickets prefer the workflow workspace, then the agent workspace when unbound', async t => {
    const plain = { id: 'plain', ticketNo: 'T-050', title: '普通工单' };
    const explicit = { ...plain, id: 'explicit', ticketNo: 'T-051', workflow: { workspaceId: 'given-ws' } };
    const host = fixture(t, { ticketRows: [plain, explicit] });
    host.replaceRows([
        { ...personal, id: 'plain-link', linkedTicketId: plain.id },
        { ...personal, id: 'explicit-link', linkedTicketId: explicit.id },
    ]);
    const pane = host.mount(tasksSlot, { sessionId: 'direct' });
    await settle(pane);
    const linkedRow = find(pane(), node => node.type === 'article' && text(node).includes('打开工单群 #T-050'));
    assert.match(text(linkedRow), /状态跟随工单/);
    assert.equal(field(linkedRow, '任务状态：调研'), undefined);
    await byText(pane(), '打开工单群 #T-050').props.onClick();
    assert.equal(host.calls.at(-1)?.[1].item.taskId, plain.id);
    assert.equal(host.calls.at(-1)?.[1].item.workspaceId, 'ws');
    await byText(pane(), '打开工单群 #T-051').props.onClick();
    assert.equal(host.calls.at(-1)?.[1].item.workspaceId, 'given-ws');
    assert.deepEqual(host.requests.filter(req => req.path === '/marshal/task-rooms/open')
        .map(({ method, auth, body }) => [method, auth, body]), [
        ['POST', 'test', { taskId: plain.id, workspaceId: 'ws' }],
        ['POST', 'test', { taskId: explicit.id, workspaceId: 'given-ws' }],
    ]);
});

test('unbound ticket opens only after choosing a real workspace when there are multiple options', async t => {
    const plain = { id: 'plain', ticketNo: 'T-050', title: '普通工单' };
    const host = fixture(t, { ticketRows: [plain], directoryAgent: { ...agent, workspaceId: null },
        workspaces: [{ id: 'ws-1', name: '一' }, { id: 'pseudo', name: 'Agent · Coder' }, { id: 'ws-2', name: '二' }] });
    host.replaceRows([{ ...personal, linkedTicketId: plain.id }]);
    const pane = host.mount(tasksSlot, { sessionId: 'direct' });
    const opens = () => host.requests.filter(req => req.path === '/marshal/task-rooms/open');
    await settle(pane);
    await byText(pane(), '打开工单群 #T-050').props.onClick();
    assert.deepEqual(opens(), []);
    const picker = field(pane(), '选择目标工单工作区');
    assert.equal(picker.type, 'select');
    assert.match(text(picker), /一.*二/);
    assert.doesNotMatch(text(picker), /Agent · Coder/);
    assert.ok(host.requests.some(req => req.path === '/marshal/task-rooms/workspaces' && req.auth === 'test'));
    await change(picker, 'pseudo');
    assert.deepEqual(opens(), []);
    await change(picker, 'ws-2');
    assert.deepEqual(opens().map(({ method, auth, body }) => [method, auth, body]),
        [['POST', 'test', { taskId: plain.id, workspaceId: 'ws-2' }]]);
    assert.equal(host.calls.at(-1)[1].item.workspaceId, 'ws-2');
});

test('unbound ticket uses the sole real workspace or reports when none is available', async t => {
    const plain = { id: 'plain', ticketNo: 'T-050', title: '普通工单' };
    for (const workspace of [undefined, { id: 'ws-1' }]) {
        const host = fixture(t, { ticketRows: [plain], directoryAgent: { ...agent, workspaceId: '' },
            workspaces: [{ id: 'pseudo', name: 'Agent · Coder' }, { id: '' }, ...(workspace ? [workspace] : [])] });
        host.replaceRows([{ ...personal, linkedTicketId: plain.id }]);
        const pane = host.mount(tasksSlot, { sessionId: 'direct' });
        await settle(pane);
        await byText(pane(), '打开工单群 #T-050').props.onClick();
        assert.deepEqual(guidanceWrites(host).map(req => [req.path, req.body]),
            workspace ? [['/marshal/task-rooms/open', { taskId: plain.id, workspaceId: workspace.id }]] : []);
        if (!workspace) assert.match(text(pane()), /没有可用的工单工作区/);
    }
});

test('native overview ticket session is not bound to a new direct task and offers a switch', async t => {
    const host = fixture(t);
    const pane = host.mount(tasksSlot, { sessionId: agent.sessionId });
    await settle(pane);
    assert.match(text(pane()), /当前会话非 1:1 直连会话/);
    assert.ok(host.requests.some(req => req.path === '/marshal/agent-direct-sessions' &&
        req.url.searchParams.get('agentKey') === agent.agentKey && req.auth === 'test'));
    change(field(pane(), '新任务标题'), '原生会话任务');
    await form(pane()).props.onSubmit(submit);
    const create = host.requests.find(req => req.path.endsWith('agent-tasks/create'));
    assert.deepEqual(create.body, { agentKey: agent.agentKey, type: 'direct', title: '原生会话任务' });
    await byText(pane(), '打开该智能体 1:1 会话').props.onClick();
    assert.deepEqual(host.calls, [['panel', null], ['session', 'direct'], ['tab', 'marshal-agent-tasks']]);
});

test('native overview session is persisted and used for guidance only after direct confirmation', async t => {
    const host = fixture(t, { directChildren: [{ id: agent.sessionId }] });
    const pane = host.mount(tasksSlot, { sessionId: agent.sessionId });
    const overlay = host.mount(overlaySlot);
    await settle(pane);
    assert.deepEqual(host.calls, []);
    assert.ok(host.requests.some(req => req.path === '/marshal/agent-direct-sessions'));
    assert.doesNotMatch(text(pane()), /当前会话非 1:1 直连会话/);
    change(field(pane(), '新任务标题'), '原生会话任务');
    await form(pane()).props.onSubmit(submit);
    const create = host.requests.find(req => req.path.endsWith('agent-tasks/create'));
    assert.deepEqual(create.body, { agentKey: agent.agentKey, type: 'direct', title: '原生会话任务', sessionId: agent.sessionId });

    byText(pane(), '原生会话任务').props.onClick();
    byText(pane(), '汇总提交同步指导').props.onClick();
    const modal = () => find(overlay(), node => node.type === 'dialog');
    change(find(modal(), node => node.type === 'textarea'), '继续当前会话');
    await form(modal()).props.onSubmit(submit);
    const sent = host.requests.find(req => req.path.endsWith('/guidance-sync'));
    assert.deepEqual(sent.body, { agentKey: agent.agentKey, taskIds: ['new'], guidanceText: '继续当前会话' });
    assert.deepEqual(host.directDeliveries, [agent.sessionId]);
});

test('new native session is not bound until the direct sessions API confirms it', async t => {
    const host = fixture(t, { directMain: null });
    const side = host.mount('sidebar.session.action', { wide: true });
    await settle(side);
    await byText(side(), '1:1 直连').props.onClick();
    assert.deepEqual(host.calls, [['panel', null], ['session', 'new-native'], ['tab', 'marshal-agent-tasks']]);
    const pane = host.mount(tasksSlot, { sessionId: 'new-native' });
    await settle(pane);
    assert.match(text(pane()), /当前会话非 1:1 直连会话/);
    change(field(pane(), '新任务标题'), '新会话任务');
    await form(pane()).props.onSubmit(submit);
    assert.deepEqual(host.requests.find(req => req.path.endsWith('/agent-tasks/create')).body,
        { agentKey: agent.agentKey, type: 'direct', title: '新会话任务' });

    host.setDirectMain({ id: 'new-native' });
    await host.emit('agents.changed');
    assert.doesNotMatch(text(await settle(pane)), /当前会话非 1:1 直连会话/);
    change(field(pane(), '新任务标题'), '已确认直连任务');
    await form(pane()).props.onSubmit(submit);
    assert.deepEqual(host.requests.filter(req => req.path.endsWith('/agent-tasks/create')).at(-1).body,
        { agentKey: agent.agentKey, type: 'direct', title: '已确认直连任务', sessionId: 'new-native' });
});

test('a non-Marshal team in the overview does not own its overview or direct sessions', async t => {
    const host = fixture(t, { directoryTeams: [{ id: agent.teamId, name: 'Ordinary DSH team', members: [{ id: agent.agentId }] }] });
    for (const sessionId of [agent.sessionId, 'direct', 'actual-child']) {
        assert.equal(await settle(host.mount(dockSlot, { sessionId })), null);
        assert.match(text(await settle(host.mount(tasksSlot, { sessionId }))), /当前会话没有关联的智能体。/);
    }
    assert.ok(!host.requests.some(req => ['/marshal/agent-direct-sessions', '/marshal/agent-tasks'].includes(req.path)));
});

test('ordinary sessions hide stale focus; the call dock opens tasks only after navigating to the agent', async t => {
    const host = fixture(t, { mountedRightbar: true });
    const side = host.mount('sidebar.session.action', { wide: true });
    const dock = host.mount(dockSlot, { sessionId: 'ordinary' });
    const destination = host.mount(dockSlot, { sessionId: 'direct' });
    const pane = host.mount(tasksSlot, { sessionId: 'direct' });
    const ordinaryPane = host.mount(tasksSlot, { sessionId: 'ordinary' });
    await settle(host.mount(overlaySlot));
    await settle(side);
    assert.match(text(await settle(ordinaryPane)), /当前会话没有关联的智能体。/);
    assert.equal(byText(ordinaryPane(), '打开该智能体 1:1 会话'), undefined);
    await byText(side(), '1:1 直连').props.onClick();
    await settle(pane);
    destination();
    host.runTimers(0);
    byText(pane(), '调研').props.onClick();
    assert.equal(await settle(dock), null);
    assert.match(text(await settle(ordinaryPane)), /当前会话没有关联的智能体。/);
    assert.ok(byText(ordinaryPane(), '打开该智能体 1:1 会话'));
    assert.equal(form(ordinaryPane()), undefined);

    byText(destination(), '语音通话').props.onClick();
    await tick();
    host.calls.length = 0;
    await byText(dock(), '任务清单 · 2 待处理').props.onClick();
    assert.deepEqual(host.calls, [['panel', null], ['session', 'direct']]);
    dock();
    host.runTimers(0);
    assert.equal(host.calls.length, 2);
    destination();
    host.runTimers(0);
    assert.deepEqual(host.calls.at(-1), ['tab', 'marshal-agent-tasks']);
});

test('unlinked casual guidance requires a target and SSE invalidations refresh authoritative tasks', async t => {
    const host = fixture(t);
    const casual = { id: 'c1', type: 'casual', status: 'running', title: '自由讨论', lastSummary: '决策', subSessions: [] };
    host.replaceRows([casual]);
    const pane = host.mount(tasksSlot, { sessionId: 'direct' });
    const overlay = host.mount(overlaySlot);
    await settle(pane);
    field(pane(), '选入同步指导：自由讨论').props.onChange();
    byText(pane(), '汇总提交同步指导').props.onClick();
    const modal = () => find(overlay(), node => node.type === 'dialog');
    assert.equal(byText(modal(), '确认同步指导').props.disabled, true);
    await form(modal()).props.onSubmit(submit);
    assert.ok(!host.requests.some(req => req.path.endsWith('/guidance-sync')));
    change(find(modal(), node => node.type === 'select'), ticket.id);
    await form(modal()).props.onSubmit(submit);
    const req = host.requests.find(req => req.path.endsWith('/guidance-sync'));
    assert.deepEqual(req.body, { agentKey: agent.agentKey, taskIds: [casual.id], guidanceText: '决策', targetTicketId: ticket.id, wakeTicket: true });
    assert.match(text(modal()), /已唤醒工单/);
    for (const [i, topic] of ['room.message', 'tasks.changed', 'agents.changed'].entries()) {
        host.replaceRows([{ ...casual, title: '后端刷新 ' + i, lastSyncAt: 1234 }]);
        await host.emit(topic);
        assert.match(text(pane()), new RegExp('后端刷新 ' + i + '.*已同步指导'));
    }
    const domain = host.requests.filter(req => /\/marshal\/(desktop\/overview|agent-tasks|agent-direct-sessions|agents\/guidance-sync|rosters\/state)/.test(req.path));
    assert.ok(domain.length > 4 && domain.every(req => req.auth === 'test'));
    host.dispose();
    assert.ok(domain.every(req => req.signal.aborted));
});

test('a strict agents host refuses run purpose and the 1:1 open retries without it', async t => {
    const host = fixture(t, { directMain: null, strictRun: true });
    const render = host.mount('sidebar.session.action', { wide: true });
    await settle(render);
    await byText(render(), '1:1 直连').props.onClick();
    const attempts = host.requests.filter(req => req.path === '/dsh-agents/api/run');
    assert.equal(attempts.length, 2, 'the refused body is retried once, not looped');
    assert.equal(attempts[0].body.purpose, 'direct');
    assert.equal('purpose' in attempts[1].body, false, 'the retry speaks the older host contract');
    assert.deepEqual(attempts[1].body, { teamId: agent.teamId, memberId: agent.agentId });
    assert.deepEqual(host.calls, [['panel', null], ['session', 'new-native'], ['tab', 'marshal-agent-tasks']]);
});
