import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = name => readFileSync(new URL('../client/' + name, import.meta.url), 'utf8');
const bundle = read('index.js');
const ticket = { id: 'ticket-1', title: '修正文档', ticketNo: 'GD-00001', status: 'failed', taskRoom: { id: 'room', workspaceId: 'ws' } };
const agent = { agentKey: 'host/team/coder', teamId: 'team', agentId: 'coder', name: '编写者', workspaceId: 'ws' };
const attachment = { attachmentId: 'att-' + 'a'.repeat(64), kind: 'file', name: 'notes.txt', mediaType: 'text/plain', bytes: 3, sha256: 'a'.repeat(64) };
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = node => Array.isArray(node) ? node.map(text).join('') : (node?.children ? text(node.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '');
function find(tree, match) {
    return (Array.isArray(tree) ? tree : [tree]).flatMap(node => node?.tag ? [...(match(node) ? [node] : []), ...find(node.children, match)] : []);
}

function fixture(t, component, props = {}, holdPath, uploadReply, {
    initialTicket = ticket, extraTickets = [], updateReply, runBlocked = false,
    sessionDefaultPermission = 'read-only', failureReason = 'confirmation-required：需要工作区写入权限', failureKind = 'failed',
} = {}) {
    let loaded, api, frame, cursor, effects, active, tree, eventStream, created, incidentCount = 2;
    let existing = initialTicket;
    const frames = new Map(), live = new Set(), requests = [];
    const document = Object.assign(new EventTarget(), { baseURI: 'http://localhost/', cookie: 'marshal-memory-csrf=test', visibilityState: 'visible' });
    const window = Object.assign(new EventTarget(), { location: new URL(document.baseURI),
        __ModuleLoader__: { load: definition => { loaded = definition; } }, capture: value => { api = value; } });
    const React = {
        Fragment: Symbol(), Component: class {},
        createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }),
        useState(init) {
            const cell = frame[cursor++] ??= { value: typeof init === 'function' ? init() : init };
            return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
        },
        useRef(value) { return frame[cursor++] ??= { current: value }; },
        useMemo(calculate) { return (frame[cursor++] ??= { value: calculate() }).value; },
        useId() { return 'fixture-id-' + cursor++; },
        useEffect(setup, deps = []) {
            const hooks = frame, position = cursor++, previous = hooks[position];
            if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
            effects.push(() => { previous?.dispose?.(); hooks[position] = { deps, dispose: setup() }; });
        },
        useLayoutEffect(setup, deps) { React.useEffect(setup, deps); },
    };
    const marker = '    return {\n      inject: [';
    runInNewContext(bundle.replace(marker, `    window.capture({ MarshalPanel, MarshalHubKanbanView, MarshalHubMonitorView, MarshalHubAgentsView, mvCascadeContextPicker, resolveNavTarget });\n${marker}`), {
        document, window, URL, URLSearchParams, AbortController, CustomEvent, TextDecoder, setTimeout, clearTimeout,
        async fetch(url, init) {
            const { pathname: path } = new URL(url);
            const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
            requests.push({ path, body, auth: init.headers?.['x-marshal-csrf'], signal: init.signal });
            if (path === holdPath) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
            if (path === '/marshal/events') return new Response(new ReadableStream({ start(controller) { eventStream = controller; } }),
                { headers: { 'content-type': 'text/event-stream' } });
            if (path === '/marshal/tasks/create') { created = { ...body, id: 'created', status: 'queued' }; return Response.json({ tasks: [ticket, created] }); }
            if (path === '/marshal/tasks/run' && runBlocked && created?.id === body.taskId) {
                created = { ...created, status: 'review' };
                return Response.json({ tasks: [existing, created], permissionBlocked: true, message: '需要工作区写入权限' });
            }
            if (path === '/marshal/tasks/plan') {
                existing = { ...ticket, workflow: { state: 'ready', ...body.orchestration } };
                return Response.json({ tasks: [existing] });
            }
            if (path === '/api/task-board/attachments/upload' && uploadReply) return uploadReply(body);
            if (path === '/marshal/tasks/update' && updateReply) return updateReply(body);
            const replies = {
                '/marshal/setup': { ready: true },
                '/api/task-board/model-catalog': { groups: [{ id: 'test', models: [{ id: 'model', name: 'Test' }] }] },
                '/marshal/tasks/state': { tasks: [existing, ...extraTickets, ...(created ? [created] : [])], sessionDefaultPermission },
                '/marshal/tasks/run': { tasks: created ? [ticket, { ...created, status: 'running' }] : [ticket] },
                '/marshal/tasks/agent-configs': { notice: '\u2699\uFE0F Leader 思考模式已更新：high（下一轮生效）' },
                '/marshal/tasks/orchestration': { plainTemplate: { id: 'none', name: '普通任务', roles: [] },
                    leaders: [{ id: 'team/coder', name: '编写者', workspaceId: 'ws', permission: 'workspace-write' }] },
                '/marshal/task-rooms/workspaces': { workspaces: [{ id: 'ws', name: '项目一' }] },
                '/marshal/desktop/overview': { host: { deviceId: 'host' }, tasks: { totalCount: 1 }, agents: { totalCount: 3, items: [
                    agent, { agentKey: 'host/squad-123/global', teamId: 'squad-123', agentId: 'global', name: '全局成员', workspaceId: 'other' },
                    { agentKey: 'host/docs/shared', teamId: 'docs', agentId: 'shared', name: '跨工作区成员', workspaceId: 'other', global: false },
                ] }, memory: { pendingProposalCount: 1 } },
                '/marshal/incidents/summary': { totalCount: incidentCount, criticalCount: 1, items: [
                    { id: 'failed:' + ticket.id, kind: failureKind, severity: 'critical', targetId: ticket.id, targetType: 'task',
                        title: ticket.title, subtitle: failureReason },
                    { id: 'review', kind: 'review-blocked', targetId: ticket.id, targetType: 'task', title: '等待裁决' },
                    { id: 'memory', kind: 'memory-proposal', targetId: 'proposal', title: '整理发布流程' },
                ] },
                '/marshal/rosters/state': { rosters: { ws: {} } },
                '/marshal/rosters/save': { rosters: { ws: body } },
                '/marshal/devices/status': { deviceId: 'host', devices: [{ deviceId: 'host' }, { deviceId: 'phone', online: false }] },
                '/marshal/agent-tasks': { tasks: [{ status: 'done' }, { status: 'running' }] },
                '/dsh-agents/api/state': { teams: [
                    { id: 'team', name: '文档团队', members: [{ id: 'coder', model: 'test-model', permission: 'read-only' }] },
                    { id: 'squad-123', name: 'marshal-agent:global', workspaceId: 'other', members: [{ id: 'global' }] },
                    { id: 'docs', name: '跨区文档团队', workspaceId: 'other', members: [{ id: 'shared', global: true }] },
                ] },
                '/marshal/agents/sessions': { sessions: [{ sessionId: 'session-1', title: '规划会话' }] },
                '/api/task-board/attachments/upload': { attachment },
            };
            return Response.json({ ok: true, ...replies[path] });
        },
    });
    loaded.factory(name => { assert.equal(name, 'react'); return React; });
    const disposeFrame = hooks => hooks.forEach(cell => cell?.dispose?.());
    function expand(node, path = 'root') {
        if (Array.isArray(node)) return node.flatMap((child, i) => expand(child, path + '/' + (child?.props?.key ?? i) + ':' + i));
        if (node == null || typeof node === 'boolean') return [];
        if (typeof node !== 'object') return [node];
        if (node.type === React.Fragment) return expand(node.props.children, path);
        if (typeof node.type === 'function') {
            const { name } = node.type;
            if (node.type.prototype.render) return expand(node.props.children, path + ':' + node.props.resetKey);
            if (['MarshalTicketRoomView', 'MemoryPage'].includes(name)) return [{ tag: name, props: node.props, children: [] }];
            const id = path + ':' + name;
            active.add(id);
            if (!frames.has(id)) frames.set(id, []);
            frame = frames.get(id); cursor = 0;
            return expand(node.type(node.props), id);
        }
        return [{ tag: node.type, props: node.props, children: expand(node.props.children, path) }];
    }
    const draw = () => {
        active = new Set(); effects = [];
        tree = expand(React.createElement(api[component], props));
        for (const [key, hooks] of frames) if (!active.has(key)) { disposeFrame(hooks); frames.delete(key); }
        for (const setup of effects) setup();
        return tree;
    };
    const unmount = () => { for (const hooks of frames.values()) disposeFrame(hooks); frames.clear(); };
    t.after(unmount);
    const one = match => { const row = find(tree, match)[0]; assert.ok(row, 'missing rendered control'); return row; };
    const button = label => one(node => node.tag === 'button' && (node.props['aria-label'] === label || text(node) === label));
    const click = label => { button(label).props.onClick({ stopPropagation() {} }); draw(); };
    const change = (label, value) => { one(node => node.props['aria-label'] === label && typeof node.props.onChange === 'function').props.onChange({ target: { value } }); draw(); };
    return { api, requests, draw, one, click, change, button, unmount,
        setIncidentCount(value) { incidentCount = value; },
        emit(topic) { eventStream.enqueue(new TextEncoder().encode(`event: ${topic}\ndata: {}\n\n`)); },
        settle: async () => { await tick(); await tick(); return draw(); } };
}

test('Hub switches four tabs, shows SSE-backed count, and opens full-canvas rooms', async t => {
    const hub = fixture(t, 'MarshalPanel');
    hub.draw();
    await hub.settle();
    const nav = () => hub.one(node => node.props.id === 'marshal-quick-nav');
    const tabs = () => find(nav(), node => node.tag === 'button');
    assert.deepEqual(tabs().map(text), ['工单看板', '问题监控2', '3D 记忆星系', '智能体与集群']);
    assert.equal(nav().props['data-active'], 'tasks');
    assert.equal(hub.api.resolveNavTarget('rosters').agentSub, 'rosters');
    for (const key of ['chats', 'groups', 'cross', 'direct', 'taskRooms', 'remote']) {
        assert.ok(['agents', 'tasks'].includes(hub.api.resolveNavTarget(key).tab));
    }
    hub.setIncidentCount(0);
    hub.emit('incidents.changed');
    await new Promise(resolve => setTimeout(resolve, 110));
    await hub.settle();
    assert.equal(text(tabs()[1]), '问题监控');
    hub.click('问题监控');
    await hub.settle();
    assert.equal(nav().props['data-active'], 'monitor');
    assert.ok(hub.requests.some(row => row.path === '/marshal/incidents/summary' && row.auth === 'test' && row.signal));
    hub.click('查看记忆提案');
    const memory = hub.one(node => node.tag === 'MemoryPage');
    assert.equal(nav().props['data-active'], 'memory');
    assert.equal(memory.props.initialAgentId, '');
    assert.equal(memory.props.initialLayer, 'global');
    hub.click('智能体与集群');
    assert.equal(nav().props['data-active'], 'agents');
    hub.click('问题监控');
    await hub.settle();
    hub.click('进入工单群处理');
    assert.equal(find(hub.draw(), node => node.props.id === 'marshal-quick-nav').length, 0);
    const room = hub.one(node => node.tag === 'MarshalTicketRoomView');
    assert.equal(room.props.task.taskRoom.id, 'room');
    room.props.openBoard(ticket.id);
    hub.draw();
    assert.equal(nav().props['data-active'], 'tasks');

});

test('Kanban creates a ticket with real picker links and uploaded attachment metadata', async t => {
    let finishUpload;
    const reply = new Promise(resolve => { finishUpload = resolve; });
    const hub = fixture(t, 'MarshalHubKanbanView', {}, undefined, () => reply);
    hub.draw();
    await hub.settle();
    hub.click('新建工单');
    hub.change('工单标题', '新建文档工单');
    hub.change('工单描述', '补齐安装指引，交付文档与验证记录');
    for (const [label, value] of [['一级分类', '产品'], ['二级分类', '文档'], ['三级分类', '安装']]) hub.change(label, value);
    hub.click('添加上下文');
    hub.click('全局上下文');
    hub.click('近期会话');
    await hub.settle();
    hub.click('规划会话');
    hub.click('本地文件/附件');
    const file = { name: 'notes.txt', type: 'text/plain', size: 3 };
    const target = { value: 'notes.txt', get files() { return this.value ? [file] : []; } };
    hub.one(node => node.tag === 'input' && node.props.type === 'file').props.onChange({ target });
    assert.equal(target.value, '');
    const submit = hub.one(node => node.tag === 'form').props.onSubmit;
    submit({ preventDefault() {} }); // Even a submit before the next render must be blocked.
    const pendingTree = await hub.settle();
    assert.equal(hub.button('创建工单').props.disabled, true);
    assert.match(text(pendingTree), /正在上传附件/);
    submit({ preventDefault() {} });
    assert.ok(!hub.requests.some(row => row.path === '/marshal/tasks/create'));
    finishUpload(Response.json({ attachment }));
    await hub.settle();
    assert.equal(hub.button('创建工单').props.disabled, false);
    assert.ok(hub.requests.some(row => row.path === '/api/task-board/attachments/upload' && row.body === file));
    hub.one(node => node.tag === 'form').props.onSubmit({ preventDefault() {} });
    const tree = await hub.settle();
    const created = hub.requests.find(row => row.path === '/marshal/tasks/create');
    assert.equal(created.auth, 'test');
    assert.ok(created.signal);
    assert.deepEqual(created.body, { title: '新建文档工单', description: '补齐安装指引，交付文档与验证记录', workspaceId: 'ws',
        cascadePath: ['产品', '文档', '安装'], links: { sessionIds: ['session-1'], docPaths: [], proposalIds: [] }, attachments: [attachment] });
    assert.equal(find(tree, node => node.tag === 'dialog').length, 0);
    hub.one(node => node.props.id === 'marshal-ticket-created');
});

test('Kanban preserves failures across upload batches and requires confirmation before using successful attachments', async t => {
    const hub = fixture(t, 'MarshalHubKanbanView', {}, undefined, file => file.name === attachment.name
        ? Response.json({ attachment }) : Response.json({ error: '\u2699\uFE0F 存储不可用' }, { status: 500 }));
    hub.draw();
    await hub.settle();
    hub.click('新建工单');
    hub.change('工单标题', '部分附件失败');
    hub.click('添加上下文');
    hub.click('全局上下文');
    hub.click('本地文件/附件');
    hub.one(node => node.tag === 'input' && node.props.type === 'file').props.onChange({ target: { value: 'files',
        files: ['failed.txt', 'also-failed.txt'].map(name => ({ name, type: 'text/plain', size: 3 })) } });
    await hub.settle();
    hub.one(node => node.tag === 'input' && node.props.type === 'file').props.onChange({ target: { value: 'files',
        files: [{ name: attachment.name, type: 'text/plain', size: 3 }] } });
    await hub.settle();
    assert.match(text(hub.one(node => node.props.role === 'alert')), /附件上传失败：failed\.txt：\s*存储不可用；also-failed\.txt：\s*存储不可用/);
    assert.equal(hub.button('创建工单').props.disabled, true);
    const submit = () => hub.one(node => node.tag === 'form').props.onSubmit({ preventDefault() {} });
    submit();
    assert.ok(!hub.requests.some(row => row.path === '/marshal/tasks/create'));
    hub.click('仅保留已上传附件');
    assert.equal(hub.button('创建工单').props.disabled, false);
    submit();
    await hub.settle();
    assert.deepEqual(hub.requests.find(row => row.path === '/marshal/tasks/create').body.attachments, [attachment]);
});

for (const workflow of [undefined, { state: 'ready' }]) {
    test(`Kanban edits a todo ticket with openExecution (${workflow ? 'workflow' : 'plain'})`, async t => {
        const hub = fixture(t, 'MarshalHubKanbanView', {}, undefined, undefined, {
            initialTicket: { ...ticket, status: 'todo', openExecution: true, workflow },
        });
        hub.draw();
        await hub.settle();
        assert.ok(find(hub.one(node => node.props['aria-label'] === '运行中'), node => node.props.id === 'marshal-ticket-ticket-1').length);
        hub.click(ticket.title);
        for (const [label, steerNow] of [['保存', false], ['保存并立即插话发送', true]]) {
            hub.click('实时编辑');
            assert.equal(hub.button('保存并立即插话发送').props.disabled, false);
            hub.change('描述', label);
            hub.click(label);
            await hub.settle();
            const request = hub.requests.filter(row => row.path === '/marshal/tasks/update').at(-1);
            assert.deepEqual(request.body, { taskId: ticket.id, description: label, steerNow });
            assert.equal(request.auth, 'test');
            assert.ok(request.signal);
        }
    });
}

test('Completing a save preserves newer edits on the same ticket', async t => {
    let finishSave;
    const pendingSave = new Promise(resolve => { finishSave = resolve; });
    const hub = fixture(t, 'MarshalHubKanbanView', {}, undefined, undefined, {
        updateReply: body => body.description === '已提交描述' ? pendingSave : Response.json({ ok: true }),
    });
    hub.draw();
    await hub.settle();
    hub.click(ticket.title);
    hub.click('编辑');
    hub.change('描述', '已提交描述');
    hub.click('保存');
    await hub.settle();
    assert.equal(hub.button('保存').props.disabled, true);
    hub.change('描述', '');
    hub.change('执行指令', '较新指令');
    finishSave(Response.json({ tasks: [{ ...ticket, description: '已提交描述' }] }));
    await hub.settle();
    assert.equal(hub.one(node => node.tag === 'textarea' && node.props['aria-label'] === '描述').props.value, '');
    assert.equal(hub.one(node => node.tag === 'textarea' && node.props['aria-label'] === '执行指令').props.value, '较新指令');
    assert.equal(hub.button('保存').props.disabled, false);
    hub.click('保存');
    await hub.settle();
    assert.deepEqual(hub.requests.filter(row => row.path === '/marshal/tasks/update').map(row => row.body), [
        { taskId: ticket.id, description: '已提交描述', steerNow: false },
        { taskId: ticket.id, description: '', prompt: '较新指令', steerNow: false },
    ]);
});

test('Completing ticket A’s save does not clear ticket B’s draft', async t => {
    const second = { ...ticket, id: 'ticket-2', ticketNo: 'GD-00002', title: '更新说明', description: 'B 原始描述' };
    let finishFirstSave;
    const firstSave = new Promise(resolve => { finishFirstSave = resolve; });
    const hub = fixture(t, 'MarshalHubKanbanView', {}, undefined, undefined, {
        extraTickets: [second],
        updateReply: body => body.taskId === ticket.id ? firstSave : Response.json({ ok: true }),
    });
    hub.draw();
    await hub.settle();
    hub.click(ticket.title);
    hub.click('编辑');
    hub.change('描述', 'A 修改描述');
    hub.click('保存');
    await hub.settle();
    const updates = () => hub.requests.filter(row => row.path === '/marshal/tasks/update');
    assert.deepEqual(updates()[0].body, { taskId: ticket.id, description: 'A 修改描述', steerNow: false });

    hub.click(second.title);
    hub.click('编辑');
    hub.change('描述', 'B 未保存草稿');
    assert.equal(hub.button('保存').props.disabled, true);
    finishFirstSave(Response.json({ tasks: [{ ...ticket, description: 'A 修改描述' }, second] }));
    await hub.settle();
    assert.equal(hub.one(node => node.tag === 'textarea' && node.props['aria-label'] === '描述').props.value, 'B 未保存草稿');
    assert.equal(hub.button('保存').props.disabled, false);
    hub.click('保存');
    await hub.settle();
    assert.deepEqual(updates().map(row => row.body), [
        { taskId: ticket.id, description: 'A 修改描述', steerNow: false },
        { taskId: second.id, description: 'B 未保存草稿', steerNow: false },
    ]);
});

for (const mode of ['close', 'disable']) {
    test(`Attachment upload aborts on ${mode}`, async t => {
        const props = {};
        const hub = fixture(t, mode === 'close' ? 'MarshalHubKanbanView' : 'mvCascadeContextPicker', props, '/api/task-board/attachments/upload');
        hub.draw();
        await hub.settle();
        if (mode === 'close') hub.click('新建工单');
        hub.click('添加上下文');
        hub.click('全局上下文');
        hub.click('本地文件/附件');
        hub.one(node => node.tag === 'input' && node.props.type === 'file').props.onChange({ target: { value: 'notes.txt',
            files: [{ name: 'notes.txt', type: 'text/plain', size: 3 }] } });
        await hub.settle();
        const { signal } = hub.requests.find(row => row.path === '/api/task-board/attachments/upload');
        assert.equal(signal.aborted, false);
        if (mode === 'close') hub.click('关闭');
        else { props.disableUpload = true; hub.draw(); }
        assert.equal(signal.aborted, true);
        assert.doesNotMatch(text(await hub.settle()), /正在上传附件|附件上传失败/);
    });
}

for (const component of ['MarshalHubKanbanView', 'MarshalHubMonitorView']) {
    test(`${component} retries and confirms permission for a blocked plain ticket`, async t => {
        const hub = fixture(t, component, {}, undefined, undefined, {
            initialTicket: { ...ticket, status: 'review' },
        });
        hub.draw();
        await hub.settle();
        if (component === 'MarshalHubKanbanView') hub.click(ticket.title);
        else {
            const review = hub.one(node => node.props['aria-label'] === '待人工裁决');
            assert.ok(find(review, node => node.tag === 'button' && text(node) === '进入工单群处理').length);
        }
        for (const [label, path] of [['单次放行', '/marshal/tasks/confirm-permission'], ['重试运行', '/marshal/tasks/run']]) {
            if (component === 'MarshalHubMonitorView') {
                const queue = hub.one(node => node.props['aria-label'] === '执行失败或受阻');
                const [button] = find(queue, node => node.tag === 'button' && text(node) === label);
                assert.ok(button);
                button.props.onClick();
            } else hub.click(label);
            await hub.settle();
            const request = hub.requests.find(row => row.path === path);
            assert.deepEqual(request.body, { taskId: ticket.id });
            assert.equal(request.auth, 'test');
            assert.ok(request.signal);
        }
    });
}

test('Monitor retries ordinary failures and only offers one-time confirmation for a permission block', async t => {
    const cases = [
        ['failed', false, ticket],
        ['tool-anomaly', false, ticket],
        ['failed', true, { ...ticket, status: 'review' }],
        ['failed', true, { ...ticket, permission: 'workspace-write' }],
    ];
    for (const [failureKind, blocked, initialTicket] of cases) {
        const hub = fixture(t, 'MarshalHubMonitorView', {}, undefined, undefined, {
            failureKind, failureReason: '沙箱权限检查进程退出，状态码 1', initialTicket,
        });
        hub.draw();
        const tree = await hub.settle();
        const queue = hub.one(node => node.props['aria-label'] === (failureKind === 'failed' ? '执行失败或受阻' : '工具异常'));
        const labels = find(queue, node => node.tag === 'button').map(text);
        assert.deepEqual(labels, ['进入工单群处理', '重试运行', ...(blocked ? ['单次放行'] : [])]);
        if (!blocked) assert.equal(find(tree, node => node.tag === 'button' && text(node) === '单次放行').length, 0);
        const label = blocked ? '单次放行' : '重试运行';
        find(queue, node => node.tag === 'button' && text(node) === label)[0].props.onClick();
        await hub.settle();
        const actions = hub.requests.filter(row => ['/marshal/tasks/confirm-permission', '/marshal/tasks/run'].includes(row.path));
        assert.equal(actions.length, 1);
        assert.equal(actions[0].path, blocked ? '/marshal/tasks/confirm-permission' : '/marshal/tasks/run');
        assert.deepEqual(actions[0].body, { taskId: ticket.id });
        assert.equal(actions[0].auth, 'test');
        assert.ok(actions[0].signal);
    }
});

test('Monitor permits one-time confirmation for an orchestrated ticket in permission-blocked state', async t => {
    const hub = fixture(t, 'MarshalHubMonitorView', {}, undefined, undefined, {
        initialTicket: { ...ticket, status: 'review', workflow: { state: 'permission-blocked' } },
    });
    hub.draw();
    await hub.settle();
    const queue = hub.one(node => node.props['aria-label'] === '执行失败或受阻');
    const [button] = find(queue, node => node.tag === 'button' && text(node) === '单次放行');
    assert.ok(button);
    assert.equal(find(queue, node => node.tag === 'button' && text(node) === '重试运行').length, 0);
    button.props.onClick();
    await hub.settle();
    const request = hub.requests.find(row => row.path === '/marshal/tasks/confirm-permission');
    assert.deepEqual(request.body, { taskId: ticket.id });
    assert.equal(request.auth, 'test');
    assert.ok(request.signal);
});

test('Kanban renders the agent-configs notice without emoji or variation selectors', async t => {
    const hub = fixture(t, 'MarshalHubKanbanView');
    hub.draw();
    await hub.settle();
    hub.click('修正文档');
    hub.click('启用编排');
    hub.change('编排模板', 'none');
    hub.change('Leader 人选', 'team/coder');
    hub.one(node => node.tag === 'form').props.onSubmit({ preventDefault() {} });
    await hub.settle();
    hub.change('Leader 思考模式', 'high');
    await hub.settle();
    const configured = hub.requests.find(row => row.path === '/marshal/tasks/agent-configs');
    assert.deepEqual(configured.body, { taskId: ticket.id, agentConfigs: { leader: { reasoningEffort: 'high' } } });
    assert.equal(configured.auth, 'test');
    assert.ok(configured.signal);
    const status = text(hub.one(node => node.props.role === 'status'));
    assert.equal(status, 'Leader 思考模式已更新：high（下一轮生效）');
    assert.doesNotMatch(status, /\p{Extended_Pictographic}|\uFE0F/u);
});

test('Kanban enables orchestration and reports a permission-blocked launch without claiming it started', async t => {
    const hub = fixture(t, 'MarshalHubKanbanView', {}, undefined, undefined, { runBlocked: true });
    hub.draw();
    await hub.settle();
    hub.click('修正文档');
    hub.click('启用编排');
    hub.change('编排模板', 'none');
    hub.change('Leader 人选', 'team/coder');
    hub.change('Leader 模型', 'test/model');
    hub.change('Leader 思考模式', 'high');
    const submit = () => hub.one(node => node.tag === 'form').props.onSubmit({ preventDefault() {} });
    submit();
    await hub.settle();
    const planned = hub.requests.find(row => row.path === '/marshal/tasks/plan');
    assert.equal(planned.auth, 'test');
    assert.ok(planned.signal);
    assert.deepEqual(planned.body, { taskId: ticket.id, orchestration: { workspaceId: 'ws', leaderId: 'team/coder', choice: 'none',
        plan: { templateId: 'none', codeWork: false, members: {}, agentConfigs: { leader: { model: 'test/model', reasoningEffort: 'high' } } } } });
    hub.click('新建工单');
    hub.change('工单标题', '运行文档工单');
    hub.one(node => node.tag === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
    hub.draw();
    submit();
    const tree = await hub.settle();
    const started = hub.requests.find(row => row.path === '/marshal/tasks/run');
    assert.equal(started.auth, 'test');
    assert.ok(started.signal);
    assert.deepEqual(started.body, { taskId: 'created' });
    assert.match(text(tree), /工单已创建，运行受阻或人工确认：需要工作区写入权限/);
    assert.doesNotMatch(text(tree), /工单已创建并启动/);
    assert.ok(find(hub.one(node => node.props['aria-label'] === '待验收'), node => node.props.id === 'marshal-ticket-created').length);
    hub.click('运行文档工单');
    assert.ok(hub.button('单次放行'));
});

test('Agents shows merged member details, opens direct, voice and memory, and saves a roster', async t => {
    const calls = [];
    const hub = fixture(t, 'MarshalHubAgentsView', { mvOpenDirect: row => calls.push(['direct', row.agentKey]),
        onStartVoice: row => calls.push(['voice', row.agentKey]), onOpenMemory: id => calls.push(['memory', id]) });
    hub.draw();
    const tree = await hub.settle();
    assert.match(text(tree), /文档团队.*test-model.*只读.*1:1 任务：1 \/ 2 已完成/);
    hub.click('1:1 原生对话');
    assert.equal(find(hub.button('语音通话'), row => row.tag === 'svg').length, 1);
    hub.click('语音通话');
    hub.click('私有记忆');
    assert.deepEqual(calls, [['direct', agent.agentKey], ['voice', agent.agentKey], ['memory', agent.agentId]]);
    hub.click('设备节点');
    assert.match(text(hub.one(row => row.props['aria-label'] === '设备与手机状态')), /在线设备（1 \/ 2）/);
    hub.click('工作区默认阵容');
    const coder = hub.one(node => node.tag === 'select' && node.props['aria-label'] === '默认 Coder');
    assert.equal(text(find(coder, node => node.tag === 'option' && node.props.value === 'squad-123/global')), '全局成员');
    assert.equal(text(find(coder, node => node.tag === 'option' && node.props.value === 'docs/shared')), '跨工作区成员');
    hub.change('默认 Coder', 'squad-123/global');
    hub.click('保存工作区默认阵容');
    await hub.settle();
    const saved = hub.requests.find(row => row.path === '/marshal/rosters/save');
    assert.deepEqual(saved.body, { workspaceId: 'ws', coderId: 'squad-123/global', members: [] });
    assert.equal(saved.auth, 'test');
    assert.ok(saved.signal);
});

test('Unmount aborts an outstanding Hub read and unsubscribes the shared event stream', async t => {
    const hub = fixture(t, 'MarshalHubKanbanView', {}, '/marshal/tasks/state');
    hub.draw();
    await tick();
    const read = hub.requests.find(row => row.path === '/marshal/tasks/state');
    const stream = hub.requests.find(row => row.path === '/marshal/events');
    assert.ok(read.signal && stream.signal);
    assert.equal(read.signal.aborted, false);
    hub.unmount();
    assert.equal(read.signal.aborted, true);
    assert.equal(stream.signal.aborted, true);
});

test('Hub shards contain no emoji icons, polling intervals or module-loader calls', () => {
    for (const name of ['00-core-bootstrap', '28-marshal-panel', '30-ui-kit', '35-cascade-picker', '52-hub-kanban', '54-hub-monitor', '56-hub-agents', '70-plugin-register']) {
        assert.doesNotMatch(read('src/' + name + '.js'), /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u20E3]|\b(?:setInterval|require)\s*\(/u, name);
    }
    assert.ok(bundle.indexOf('function MemoryPage(') > 0);
    assert.ok(bundle.indexOf('function MemoryPage(') < bundle.indexOf('function AgentDirectChatsView('));
    assert.match(bundle, /resetKey: 'taskRooms-' \+ \(roomTask\?\.id \|\| 'archive'\)/);
});
