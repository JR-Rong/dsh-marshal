import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const shard = name => readFileSync(new URL(`../client/src/${name}.js`, import.meta.url), 'utf8');
const roomColors = shard('42-task-room-shared').split('    function ensureTaskRoomStyles')[0];
const roomSource = shard('48-ticket-room-vnext');
const groupsSource = shard('40-groups');
const sidebarSource = shard('15-sidebar-left');
const groupHelpers = sidebarSource.slice(sidebarSource.indexOf('    function marshalCrossGroupMentions'),
    sidebarSource.indexOf('    // The existing group list views'));
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(route, globals = {}) {
    const requests = [], subscriptions = new Set(), instances = new Map();
    const styles = { acquired: 0, released: 0 };
    let current, effects, visited, root, tree;
    const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
    const React = {
        Fragment: Symbol('fragment'),
        useId() { return 'picker-' + current.index++; },
        useState(initial) {
            const slots = current.slots, i = current.index++;
            const slot = slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
            return [slot.value, update => { slot.value = typeof update === 'function' ? update(slot.value) : update; }];
        },
        useMemo(fn) { current.index++; return fn(); },
        useRef(initial) { return current.slots[current.index++] ??= { current: initial }; },
        useEffect(fn, deps) {
            const slot = current.slots[current.index++] ??= {};
            if (deps?.length === slot.deps?.length && deps?.every((dep, i) => dep === slot.deps[i])) return;
            effects.push(() => { slot.cleanup?.(); slot.deps = deps; slot.cleanup = fn(); });
        },
        useLayoutEffect(fn, deps) { React.useEffect(fn, deps); },
    };
    function expand(node, path = '') {
        if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}/${child?.props?.key ?? i}`));
        if (!node?.type) return node;
        if (typeof node.type === 'function') {
            const id = `${path}:${node.type.name}:${node.props.key ?? ''}`;
            if (!instances.has(id)) instances.set(id, { slots: [] });
            visited.add(id);
            current = instances.get(id);
            current.index = 0;
            return expand(node.type({ ...node.props, children: node.children }), id);
        }
        return { ...node, children: expand(node.children, path) };
    }
    const dispose = instance => instance.slots.forEach(slot => slot.cleanup?.());
    const marker = name => props => h(name, props, props.text);
    const context = {
        React, h, AbortController, URLSearchParams, Map, Set, crypto: webcrypto, TextEncoder,
        document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
        window: { addEventListener() {}, removeEventListener() {} },
        setTimeout() { return 1; }, clearTimeout() {},
        ensureMarshalVnextStyles() { styles.acquired++; return () => { styles.released++; }; },
        ensureTaskRoomStyles() {}, isPseudoAgentWorkspace: () => false,
        dswTheme: {}, uiMuted: {}, uiInput: {}, uiButton: () => ({}),
        MvIcon: marker('svg'), MvAvatar: marker('avatar'), RichMarkdown: marker('markdown'),
        AgentTracePanel: marker('trace'), TaskReviewReport: marker('report'), EmptyState: marker('empty'),
        MvButton: ({ label, children, ...props }) => h('button', props, children.length ? children : label),
        mvDagSidebar: { MarshalVerticalDagSidebar: props => h('dag-sidebar', props, props.members), MarshalDagNodeModal: marker('dag-modal') },
        taskPhases: {}, formatTokenCount: String, formatUsageTitle: () => '', decodeAgentTraceClient: text => ({ text }),
        loadAgentLibrary: async () => route({ path: 'test/agent-library' }) ?? { agents: [], models: [] },
        flattenModelCatalog: () => ({ options: [] }),
        async fetchJson(path, body, auth, signal) {
            const url = new URLSearchParams(path.split('?')[1]);
            const req = { path: path.split('?')[0], url, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)), auth, signal };
            requests.push(req);
            if (/^marshal\/(?:tasks|task-rooms|groups|cross-groups)\//.test(path)) assert.equal(auth, true, path);
            return route(req) ?? {};
        },
        subscribeMarshalEvents(names, request, options) {
            const sub = { names, request };
            subscriptions.add(sub);
            if (options.initial) request();
            return () => subscriptions.delete(sub);
        },
        ...globals,
    };
    // Execute the production refresh scheduler, while controlling the SSE transport.
    const scheduler = shard('32-sse-client').split('    function createVisibleMarshalRefresh')[1];
    const api = runInNewContext(`function createVisibleMarshalRefresh${scheduler}\n${shard('35-cascade-picker')}\n${roomColors}\n${groupHelpers}\n${groupsSource}\n${roomSource}\n({ MarshalTicketRoomView, GroupsPage, CrossGroupsPage })`, context);
    function render() {
        effects = []; visited = new Set(); tree = expand(root);
        for (const [id, instance] of instances) if (!visited.has(id)) { dispose(instance); instances.delete(id); }
        for (const effect of effects) effect();
    }
    function* nodes(node) {
        if (Array.isArray(node)) for (const child of node) yield* nodes(child);
        else if (node?.type) { yield node; yield* nodes(node.children); }
    }
    const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' ? node : node?.type ? text(node.children) : '';
    const find = fn => [...nodes(tree)].find(fn);
    return { api, requests, subscriptions, styles, find, text: (node = tree) => text(node),
        button(label) { return find(node => node.type === 'button' && text(node) === label); },
        mount(component, props) { root = h(api[component], props); render(); },
        async settle() { for (let i = 0; i < 5; i++) { await flush(); render(); } },
        async event(name) { await Promise.all([...subscriptions].filter(sub => sub.names.includes(name)).map(sub => sub.request())); },
        unmount() { root = null; render(); },
    };
}

test('ticket conversation follows SSE, pages backward, opens the projected DAG node, persists cascade and sends context', async () => {
    const room = { id: 'r1', workspaceId: 'ws', taskId: 't1', title: '工单标题', closed: false };
    let delta = false;
    let running = false;
    let chatBusy = false;
    const host = harness(({ path, url, body }) => {
        if (path.endsWith('/workspaces')) return { workspaces: [{ id: 'ws', name: '工作区' }] };
        if (path.endsWith('/list')) return { rooms: [room] };
        if (path.endsWith('/orchestration')) return { leaders: [{ id: 'lead', workspaceId: 'ws', name: '负责人' }] };
        if (path.endsWith('/action')) {
            if (body.action === 'close') room.closed = true;
            if (body.action === 'reopen' || body.autoReopen) room.closed = false;
        }
        if (path.endsWith('/page')) {
            const first = { seq: 2, id: 'assign', kind: 'status', phase: 'assignment', actor: 'Marshal', text: '{"roles":{"Coder":"编码员"}}' };
            return { room: { ...room }, origin: true, taskId: room.taskId, cardStatus: running ? 'running' : 'review',
                busy: running, chatBusy, hasOlder: !url.has('before'),
                participants: [{ id: 'coder', name: '编码员', role: 'Coder', configKey: 'coder', models: [{ route: 'provider/model' }] }],
                workflow: { plan: { members: { coder: 'coder' } }, reportId: 'report' },
                records: url.has('before') ? [{ seq: 1, kind: 'user', text: '旧消息' }] : url.has('after') ?
                    delta && url.get('after') === '2' ? [{ seq: 3, kind: 'agent', text: '增量回复' }] : [] : [first],
                liveBubbles: [{ id: 'live', actor: '编码员', text: '正在生成', thinking: '思考内容', steps: [{ label: '执行验证' }], usage: { totalTokens: 18 } }],
            };
        }
        if (path === 'marshal/tasks/dag') return { layers: [{ nodes: [{ id: 'merged-node', logs: [{ seq: 2 }] }] }] };
        if (path === 'marshal/tasks/state') return { tasks: [{ id: 'related', title: '关联工单', workspaceId: 'ws' }] };
    });
    host.mount('MarshalTicketRoomView', { task: { id: 't1', taskRoom: room } });
    await host.settle();
    assert.match(host.text(), /工单标题.*累计 18 tok/s);
    assert.match(host.text(), /@编码员/);
    const trace = host.find(node => node.type === 'trace');
    assert.equal(trace.props.trace.thinking, '思考内容');
    assert.equal(trace.props.trace.steps[0].label, '执行验证');
    assert.ok(host.find(node => node.type === 'report'));
    await host.button('定位 DAG 节点').props.onClick();
    await host.settle();
    assert.equal(host.find(node => node.type === 'dag-modal').props.nodeId, 'merged-node');
    host.button('DAG 编排').props.onClick();
    await host.settle();
    assert.equal(host.find(node => node.type === 'dag-sidebar').props.taskId, 't1');
    await host.button('加载更早消息').props.onClick();
    delta = true;
    await host.event('room.message');
    await host.settle();
    assert.match(host.text(), /旧消息.*增量回复/s);
    assert.equal(host.requests.filter(req => req.path.endsWith('/list')).length, 2);
    await host.event('ready');
    await host.event('tasks.changed');
    assert.equal(host.requests.filter(req => req.path.endsWith('/list')).length, 4);
    assert.ok(host.requests.some(req => req.url.get('after') === '2'));
    assert.ok(host.requests.some(req => req.url.get('before') === '2'));
    host.button('Agent 模型与思考 (1)').props.onClick();
    await host.settle();
    host.find(node => node.props.className === 'mv-cascade3-choice' && node.children[0]?.children?.includes('编码员')).props.onClick();
    await host.settle();
    host.button('provider/model').props.onClick();
    await host.settle();
    host.button('off').props.onClick();
    await host.settle();
    assert.deepEqual(host.requests.find(req => req.path === 'marshal/tasks/agent-configs').body,
        { taskId: 't1', agentConfigs: { coder: { model: 'provider/model', reasoningEffort: 'off' } } });
    assert.equal(host.find(node => node.props['aria-label'] === 'Agent 模型与思考'), undefined);
    host.button('添加上下文').props.onClick();
    await host.settle();
    host.button('工作区').props.onClick();
    await host.settle();
    host.find(node => node.props.className === 'mv-cascade3-choice' && node.children[0]?.children?.includes('关联工单')).props.onClick();
    await host.settle();
    host.find(node => node.props.className === 'mv-cascade3-choice' && node.children[0]?.children?.includes('关联工单') && node.props['aria-pressed'] === false).props.onClick();
    await host.settle();
    const type = async value => { host.find(node => node.type === 'textarea').props.onChange({ target: { value } }); await host.settle(); };
    const click = async label => { await host.button(label).props.onClick(); await host.settle(); };
    await type('继续'); await click('发送');
    await type('验收备注'); await click('确认验收');
    await type('返工意见'); await click('返工');
    await click('重试');
    host.find(node => node.props['aria-label'] === '改派负责人').props.onChange({ target: { value: 'local/lead' } });
    await host.settle();
    await click('改派并运行');
    await click('关闭工单'); await click('重开工单');
    await click('关闭工单'); await type('追加讨论'); await click('发送');
    running = true;
    chatBusy = true;
    await host.event('tasks.changed'); await host.settle();
    assert.equal(host.button('返工'), undefined);
    assert.equal(host.button('按意见返工').props.disabled, true);
    await type('  修改执行方案  ');
    assert.equal(host.button('按意见返工').props.disabled, true);
    chatBusy = false;
    await host.event('tasks.changed'); await host.settle();
    await type('   ');
    assert.equal(host.button('按意见返工').props.disabled, true);
    await type('  修改执行方案  ');
    assert.equal(host.button('按意见返工').props.disabled, false);
    await click('按意见返工');
    assert.deepEqual(host.requests.filter(req => req.path.endsWith('/action')).map(req => req.body), [
        { roomId: 'r1', action: 'send', text: '继续', links: { proposalIds: ['related'] } },
        { roomId: 'r1', action: 'confirm', applyPatch: false, note: '验收备注' },
        { roomId: 'r1', action: 'revise', text: '返工意见' },
        { roomId: 'r1', action: 'retry' },
        { roomId: 'r1', action: 'reassign', leaderId: 'lead' },
        { roomId: 'r1', action: 'close' },
        { roomId: 'r1', action: 'reopen' },
        { roomId: 'r1', action: 'close' },
        { roomId: 'r1', action: 'send', text: '追加讨论', autoReopen: true },
        { roomId: 'r1', action: 'revise', text: '修改执行方案' },
    ]);
    host.unmount();
    assert.equal(host.subscriptions.size, 0);
});

test('ticket handoffs distinguish source and recipient, and show artifacts instead of memory refs', async () => {
    const room = { id: 'r1', workspaceId: 'ws', taskId: 't1' };
    const base = { kind: 'status', phase: 'coding', actor: 'Marshal', ref: 'public-memory-ref' };
    const cases = [
        { text: 'Reviewer 要求调整，退回 Coder。', banner: '审查员 → @开发员' },
        { text: 'Reviewer → Coder', banner: '审查员 → @开发员' },
        { text: '由 Reviewer 移交给 Coder', kind: 'agent', banner: '审查员 → @开发员' },
        { text: '由 Reviewer 分配给 Coder', banner: '审查员 → @开发员' },
        { text: 'Reviewer 要求调整，退回未知成员。请 @开发员 留意。', banner: '审查员 → 待分配' },
        { text: 'Reviewer 已记录交接意见。', kind: 'handoff', banner: 'Marshal → 待分配' },
        { text: '任务说明已交给 Leader。', phase: 'handoff', banner: 'Marshal → @负责人' },
        { text: '开发设计交接已写入工作区公共记忆。', phase: 'designing', banner: '负责人 → @开发员' },
        { text: '编码交给 开发员 的常驻会话。', phase: 'handoff', banner: 'Marshal → @开发员' },
        { text: '编码交付与审查交接已写入工作区公共记忆。', phase: 'dev-reviewing', banner: '开发员 → @审查员',
            summary: '补丁 fedcba987654 · 1 个文件 · +4 · -0' },
        { text: '编码交付与审查交接已写入工作区公共记忆。', phase: 'dev-reviewing', banner: '开发员 → @审查员',
            patchDigest: 'direct-patch-digest', summary: 'direct-patch-digest' },
        { text: 'Reviewer → Coder', targetName: '交付负责人', artifactSummary: '修改 src/a.js',
            patchDigest: 'secondary-digest', banner: '审查员 → @交付负责人', summary: '修改 src/a.js' },
        { text: '{"from":"Reviewer","to":"Coder","patchDigest":"stored-patch-digest"}',
            banner: 'Reviewer → @开发员', summary: 'stored-patch-digest' },
    ];
    const patch = (seq, digest, files, additions, deletions) => ({ ...base, seq, runId: 'old', phase: 'development-patch',
        text: `<!--marshal-patch-artifact:${JSON.stringify({ digest, files, additions, deletions })}-->\ndiff preview` });
    const review = '编码交付与审查交接已写入工作区公共记忆。';
    const inlineDiff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n';
    const inlineDigest = createHash('sha256').update(inlineDiff).digest('hex').slice(0, 12);
    const findings = '审查交接中的边界条件仍未覆盖。发现：空列表会导致崩溃。';
    const offset = cases.length;
    const reviewRow = (index, runId) => ({ ...base, seq: offset + index, runId, phase: 'dev-reviewing', text: review });
    const host = harness(({ path, url }) => {
        if (path.endsWith('/page')) return { room, taskId: room.taskId, workflow: { runId: 'current',
            development: { digest: 'abcdef0123456789', fileCount: 2, additions: 8, deletions: 3 } }, participants: [
            { name: '负责人', role: 'Leader' }, { name: '开发员', role: 'Coder' }, { name: '审查员', role: 'Reviewer' },
        ], records: url.has('after') ? [] : [
            patch(-1, '0123456789ab'.repeat(6).slice(0, 64), ['old.js'], 1, 1),
            patch(0, 'fedcba987654'.repeat(6).slice(0, 64), ['src/a.js'], 4, 0),
            ...cases.map((row, i) => ({ ...base, ...row, seq: i + 1 })),
            { kind: 'agent', seq: offset + 1, text: '状态转换：loading → done' },
            { kind: 'agent', phase: 'dev-reviewing', actor: '审查员', seq: offset + 2, text: findings },
            { ...base, seq: offset + 3, phase: 'development-patch', text: inlineDiff },
            reviewRow(4, 'old'),
            reviewRow(5, 'another'),
            { ...patch(offset + 6, '123456789abc'.repeat(6).slice(0, 64), ['other.js'], 5, 2), runId: 'another' },
            { kind: 'batch', seq: offset + 7, text: '新批次' },
            reviewRow(8),
            reviewRow(9, 'current'),
        ] };
    });
    const props = { task: { id: 't1', taskRoom: room } };
    for (let cycle = 1; cycle <= 2; cycle++) {
        host.mount('MarshalTicketRoomView', props);
        await host.settle();
        assert.deepEqual(host.styles, { acquired: cycle, released: cycle - 1 });
        const bannerAt = seq => host.find(node => node.props['aria-label'] === '阶段交接' && node.props['data-record-seq'] === seq);
        const summaryAt = seq => host.text(bannerAt(seq)?.children[1] ?? []);
        for (const [i, { banner, summary, text }] of cases.entries()) {
            const row = bannerAt(i + 1);
            assert.ok(row, banner);
            assert.ok(host.text(row.children[0]).startsWith(banner), host.text(row));
            assert.doesNotMatch(host.text(row), /public-memory-ref|secondary-digest/);
            assert.equal(summaryAt(i + 1), summary ?? '');
            assert.ok(host.find(node => node.type === 'markdown' && node.props.text === text && node.props.phase));
        }
        assert.match(host.text(), /状态转换：loading → done/);
        assert.equal(bannerAt(offset + 1), undefined);
        assert.equal(bannerAt(offset + 2), undefined);
        assert.ok(host.find(node => node.type === 'markdown' && node.props.text === findings));
        assert.equal(summaryAt(offset + 4), `补丁 ${inlineDigest} · 1 个文件 · +2 · -1`);
        assert.equal(summaryAt(offset + 5), '');
        assert.equal(summaryAt(offset + 8), '');
        assert.equal(summaryAt(offset + 9), '补丁 abcdef012345 · 2 个文件 · +8 · -3');
        host.unmount();
        assert.deepEqual(host.styles, { acquired: cycle, released: cycle });
    }
});

test('ticket handoffs use same-run assignments and never borrow reassigned members for historical rounds', async () => {
    const room = { id: 'r1', workspaceId: 'ws', taskId: 't1' };
    const review = (seq, runId, extra) => ({ seq, runId, kind: 'status', phase: 'dev-reviewing', actor: 'Marshal',
        text: '编码交付与审查交接已写入工作区公共记忆。', ...extra });
    const host = harness(({ path }) => {
        if (path.endsWith('/page')) return { room, workflow: { runId: 'new' }, participants: [
            { name: '新开发员', role: 'Coder' }, { name: '新审查员', role: 'Reviewer' },
        ], records: [
            { seq: 1, runId: 'old', kind: 'assignment', text: JSON.stringify({ body: { meta: {
                leader: '旧丞相', roles: { Coder: '旧开发员', Reviewer: '旧审查员' },
            } } }) },
            review(2, 'old'),
            review(3, 'older'),
            review(4, 'older', { to: '指定接收人' }),
            review(5, 'older', { text: '移交给 @历史接收人。' }),
            { seq: 6, runId: 'old', phase: 'assignment', kind: 'status', body: '{"roles":{"Reviewer":"旧审查员"}}' },
            { seq: 7, runId: 'old', kind: 'batch', text: '新批次' },
            review(8, 'old'),
            review(9, 'new'),
            review(10, 'older', { phase: 'coding', text: '编码交给 旧开发员 的常驻会话。' }),
        ] };
    });
    host.mount('MarshalTicketRoomView', { task: { id: 't1', taskRoom: room } });
    await host.settle();
    const banner = seq => host.text(host.find(node => node.props['aria-label'] === '阶段交接' && node.props['data-record-seq'] === seq) ?? []);
    assert.match(banner(2), /旧开发员 → @旧审查员/);
    assert.doesNotMatch(banner(2), /新开发员|@新审查员/);
    assert.match(banner(3), /Marshal → 待分配/);
    assert.doesNotMatch(banner(3), /新开发员|@新审查员/);
    assert.match(banner(4), /Marshal → @指定接收人/);
    assert.match(banner(5), /Marshal → @历史接收人/);
    assert.match(banner(8), /Marshal → 待分配/);
    assert.match(banner(9), /新开发员 → @新审查员/);
    assert.match(banner(10), /Marshal → @旧开发员/);
    assert.doesNotMatch(banner(10), /新开发员|待分配/);
    host.unmount();
});

for (const paged of [false, true]) test(`ticket patch controls retrieve and download ${paged ? 'an exact paginated' : 'the latest'} full diff`, async () => {
    const room = { id: 'r1', workspaceId: 'ws', taskId: 't1' };
    const digest = 'abc123456789';
    const preview = 'diff --git a/preview b/preview\n' + 'p'.repeat(12 * 1024);
    const full = 'diff --git a/full b/full\n'.padEnd(60 * 1024, 'f');
    const blobs = [], links = [], revoked = [], timers = [];
    let fail = false;
    const host = harness(({ path, url }) => {
        if (path.endsWith('/page') && paged && !url.has('before')) return {
            room, hasOlder: true, records: [{ seq: 102, kind: 'status', text: '最新消息' }],
        };
        if (path.endsWith('/page')) return { room, patchAvailable: true, records: [
            { id: 'historical-record', seq: 1, kind: 'status', phase: 'development-patch',
                text: `<!--marshal-patch-artifact:{"v":1,"stored":true,"digest":"${digest}","bytes":60000,"fileCount":3}-->\n${preview}` },
        ] };
        if (path.endsWith('/patch')) {
            if (fail) throw new Error('离线');
            return paged ? { seq: 101, digest: 'different', patch: '错件' } : { seq: 1, digest, patch: full };
        }
        if (path.endsWith('/dag/node') && paged) return {
            node: { id: 'development-patch:historical-record', patchDigest: digest, diff: fail ? preview : full },
        };
    }, {
        Blob,
        URL: {
            createObjectURL(blob) { return `blob:patch-${blobs.push(blob)}`; },
            revokeObjectURL(url) { revoked.push(url); },
        },
        document: {
            visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
            createElement(tag) {
                assert.equal(tag, 'a');
                return { click() { links.push(this); } };
            },
        },
        setTimeout(callback, delay) { if (delay === 1000) timers.push(callback); return 1; },
    });
    host.mount('MarshalTicketRoomView', { task: { id: 't1', taskRoom: room } });
    await host.settle();
    if (paged) {
        assert.ok(!host.text().includes(preview));
        await host.button('加载更早消息').props.onClick();
        await host.settle();
        assert.ok(host.requests.some(req => req.path.endsWith('/page') && req.url.get('before') === '102'));
    }
    const requests = () => host.requests.filter(req => req.path === 'marshal/task-rooms/patch');
    const click = (label, region = 'header') => {
        const control = host.find(node => node.type === region && host.text(node).includes(label));
        const button = node => Array.isArray(node) ? node.map(button).find(Boolean)
            : node?.type === 'button' && host.text(node) === label ? node : node?.type ? button(node.children) : undefined;
        return button(control).props.onClick();
    };
    const renderedDiff = () => host.find(node => node.type === 'pre');
    assert.ok(host.text().includes(preview));
    assert.ok(!host.text().includes(full));
    assert.equal(requests().length, 0);
    await click('查看完整补丁');
    await host.settle();
    assert.equal(host.text(renderedDiff()), full);
    assert.equal(requests().length, 1);
    await click('收起完整补丁', 'article');
    await host.settle();
    assert.equal(renderedDiff(), undefined);
    await click('查看完整补丁');
    await host.settle();
    assert.equal(requests().length, 1);
    await click('下载完整 .patch');
    await host.settle();
    assert.equal(requests().length, 2);
    for (const req of requests()) {
        assert.equal(req.auth, true);
        assert.equal(req.body, undefined);
        assert.equal(req.url.get('roomId'), 'r1');
        assert.equal(req.url.get('digest'), digest);
        assert.equal(req.url.get('seq'), '1');
        assert.ok(req.signal instanceof AbortSignal);
    }
    assert.equal(await blobs[0].text(), full);
    assert.equal(blobs[0].type, 'text/plain');
    assert.equal(links[0].download, `development-${digest}.patch`);
    assert.equal(links[0].href, 'blob:patch-1');
    fail = true;
    await click('下载完整 .patch');
    await host.settle();
    assert.match(host.text(), /完整补丁读取失败：离线（将下载预览）/);
    assert.equal(await blobs[1].text(), preview);
    const dagRequests = host.requests.filter(req => req.path === 'marshal/tasks/dag/node');
    assert.equal(dagRequests.length, paged ? 3 : 1);
    if (paged) dagRequests.forEach((req, i) => {
        assert.equal(req.auth, true);
        assert.equal(req.url.get('taskId'), 't1');
        assert.equal(req.url.get('nodeId'), 'development-patch:historical-record');
        assert.equal(req.signal, requests()[i].signal);
    });
    timers.forEach(callback => callback());
    assert.deepEqual(revoked, ['blob:patch-1', 'blob:patch-2']);
    host.unmount();
    assert.equal(requests().at(-1).signal.aborted, true);
});

test('header patch fallback resolves nodeId via tasks/dag when patch bubble is beyond latest page', async () => {
    const digest = 'deadbeef12345678';
    const room = { id: 'r1', workspaceId: 'ws', taskId: 't1' };
    const full = 'diff --git a/header b/header\n'.padEnd(20 * 1024, 'h');
    const host = harness(({ path, url }) => {
        if (path.endsWith('/page')) return {
            room, patchAvailable: true,
            workflow: { runId: 'run1', development: { digest, bytes: full.length } },
            records: [{ seq: 150, kind: 'status', text: '分页外补丁未载入' }],
        };
        if (path.endsWith('/patch')) throw new Error('outside-latest-100');
        if (path === 'marshal/tasks/dag') return {
            layers: [{ nodes: [{ id: `patch:run1:${digest}`, phase: 'development-patch', patchDigest: digest }] }],
        };
        if (path === 'marshal/tasks/dag/node') {
            assert.equal(url.get('nodeId'), `patch:run1:${digest}`);
            return { node: { id: `patch:run1:${digest}`, patchDigest: digest, diff: full } };
        }
    });
    host.mount('MarshalTicketRoomView', { task: { id: 't1', taskRoom: room } });
    await host.settle();
    await host.button('查看完整补丁').props.onClick();
    await host.settle();
    const diff = host.find(node => node.type === 'pre');
    assert.equal(host.text(diff), full);
    assert.ok(host.requests.some(req => req.path === 'marshal/tasks/dag' && req.auth === true));
    assert.ok(host.requests.some(req => req.path === 'marshal/tasks/dag/node' && req.auth === true));
    host.unmount();
});

test('local and cross group pages render vNext controls and cancel in-flight reads on unmount', async () => {
    for (const [component, prefix] of [['GroupsPage', 'marshal/groups'], ['CrossGroupsPage', 'marshal/cross-groups']]) {
        const member = { name: '成员', deviceId: 'device', sessionId: 'existing' };
        const group = { id: 'g', name: '演示群', memberCount: 1,
            members: [component === 'CrossGroupsPage' ? member : { ...member, deviceName: '工作机', model: 'provider/model',
                squadId: 'team', memberId: 'member' }],
            messages: [{ id: 'm', role: 'agent', text: '实时回复', streaming: true }] };
        let block = false;
        const host = harness(req => {
            if (block && req.path === prefix + '/state') return new Promise(resolve => req.signal.addEventListener('abort', resolve, { once: true }));
            if (req.path === 'test/agent-library') return {
                agents: [{ id: 'member', name: '成员', squadId: 'team', model: 'provider/model' }],
                models: [{ route: 'provider/next' }],
            };
            if (req.path.endsWith('/state')) return { deviceId: 'device', groups: [group] };
            if (req.path.endsWith('/get')) return { group };
            if (req.path === 'marshal/cross-groups/catalog') return { devices: [
                { id: 'device', name: '工作机', members: [{ sessionId: 'existing', model: 'provider/model' }] },
            ] };
            if (req.path === 'dsh-agents/api/run') return { run: { sessionId: 'rebuilt' } };
            if (req.path === 'marshal/groups/bind') group.members[0].sessionId = req.body.sessionId;
            if (req.path === 'marshal/cross-groups/send') return { deliveries: [{ name: '成员', state: 'failed', code: 'offline' }] };
        });
        const opened = [];
        host.mount(component, { openSession: id => opened.push(id) });
        await host.settle();
        host.find(node => node.type === 'button' && node.props.onClick && JSON.stringify(node.children).includes('演示群')).props.onClick();
        await host.settle();
        assert.match(host.text(), /实时回复/);
        assert.ok(host.button('添加上下文'));
        if (component === 'GroupsPage') {
            assert.ok(host.button('Agent 模型与思考 (1)'));
            assert.match(host.text(), /默认模型与思考，新会话生效/);
            host.button('Agent 模型与思考 (1)').props.onClick();
            await host.settle();
            host.button('成员').props.onClick();
            await host.settle();
            host.button('provider/next').props.onClick();
            await host.settle();
            host.button('off').props.onClick();
            await host.settle();
            assert.deepEqual(host.requests.find(req => req.path === 'dsh-agents/api/member')?.body,
                { teamId: 'team', member: { id: 'member', name: '成员', model: 'provider/next', reasoningEffort: 'off' } });
        } else {
            assert.equal(host.button('Agent 模型与思考 (1)'), undefined);
            assert.match(host.text(), /跨设备成员模型只读（由所在设备管理）/);
        }
        host.button('群聊成员').props.onClick();
        await host.settle();
        assert.ok(host.find(node => node.type === 'dag-sidebar'));
        assert.match(host.text(), /工作机 · provider\/model/);
        if (component === 'GroupsPage') {
            host.button('打开会话').props.onClick();
            await host.button('重建会话').props.onClick();
            await host.settle();
            host.button('打开会话').props.onClick();
            assert.deepEqual(opened, ['existing', 'rebuilt']);
            assert.deepEqual(host.requests.find(req => req.path === 'dsh-agents/api/run').body, { teamId: 'team', memberId: 'member' });
            assert.deepEqual(host.requests.find(req => req.path === 'marshal/groups/bind').body,
                { id: 'g', key: 'device/team/member', sessionId: 'rebuilt' });
        } else {
            assert.equal(host.button('重建会话'), undefined);
        }
        host.find(node => node.type === 'textarea').props.onChange({ target: { value: '@成员 你好' } });
        await host.settle();
        await host.button('发送').props.onClick();
        await host.settle();
        assert.deepEqual(host.requests.find(req => req.path === prefix + '/send').body.mentions, ['成员']);
        if (component === 'CrossGroupsPage') assert.match(host.text(), /部分成员失败：成员 offline/);
        block = true;
        const refreshing = host.event('groups.changed');
        await flush();
        const request = host.requests.findLast(req => req.path === prefix + '/state');
        assert.equal(request.signal.aborted, false);
        host.unmount();
        await refreshing;
        assert.equal(request.signal.aborted, true);
        assert.equal(host.subscriptions.size, 0);
    }
});

test('new conversation shards add neither legacy timers nor emoji or module imports', () => {
    assert.doesNotMatch(roomSource + groupsSource, /\b(?:setInterval|require)\s*\(|\p{Extended_Pictographic}/u);
    assert.match(shard('28-marshal-panel'), /resetKey: 'taskRooms-'[^\n]*\n\s*h\(MarshalTicketRoomView/);
    assert.match(shard('70-plugin-register'), /kind === 'taskRooms' \? h\(MarshalTicketRoomView/);
});
