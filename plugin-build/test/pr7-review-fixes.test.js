import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentMemoryService, mountAgentMemory } from '../lib/src/memory/agent-memory.js';
import { createMemoryHttpAuth, hostIsLoopback } from '../lib/src/memory/http-auth.js';
import { createMemoryBridge } from '../lib/src/superagent/memory.js';
import { findMember, resolveAgentForTask } from '../lib/src/superagent/agents.js';
import { defaultSettings } from '../lib/src/superagent/settings.js';
import { parseModelJson, VerdictSchema } from '../lib/src/groups/task-plans.js';
import { createTaskOrchestration } from '../lib/src/groups/task-orchestration.js';
import { createLocalBoard } from '../lib/src/groups/local-board.js';
import { mountSuperagent } from '../lib/src/superagent/mount.js';
import { createFakeBoard, createFakeContext, createFakeMemory, loggerFixture } from './superagent-support.js';

const tempRoot = () => mkdtempSync(join(tmpdir(), 'marshal-pr7-fixes-'));
const mnemonBin = process.env.MARSHAL_TEST_MNEMON;

test('superagent memory bridge never leaks private or never-group memories onto shared board cards', async (t) => {
    const root = tempRoot();
    const service = createAgentMemoryService({
        root,
        ...(mnemonBin ? { mnemonPilot: { agentId: 'agent-a', executable: mnemonBin } } : {}),
    });
    t.after(() => { service.store.close(); rmSync(root, { recursive: true, force: true }); });

    await service.rememberFor({ agentId: 'agent-a', workspaceId: 'ws-1', scope: 'agent', title: 'Secret Key', text: 'PRIVATE_TOKEN_XYZ', visibility: 'private' });
    await service.rememberFor({ agentId: 'agent-a', workspaceId: 'ws-1', scope: 'agent', title: 'Never Group', text: 'NEVER_GROUP_SECRET', visibility: 'never-group' });
    await service.rememberFor({ agentId: 'agent-a', workspaceId: 'ws-1', scope: 'agent', title: 'Shared Checklist', text: 'SAFE_CHECKLIST_ITEM', visibility: 'group-safe' });
    await service.rememberFor({ agentId: 'agent-a', workspaceId: 'ws-2', scope: 'workspace', title: 'Other Workspace', text: 'OTHER_WS_ITEM', visibility: 'group-safe' });
    if (mnemonBin) {
        await service.rememberFor({ agentId: 'agent-a', workspaceId: 'ws-2', scope: 'agent', title: 'Other Workspace Private', text: 'OTHER_WS_MNEMON_ITEM', visibility: 'group-safe' });
    }

    const bridge = createMemoryBridge(service);
    const recalled = await bridge.recall({ agentId: 'agent-a', workspaceId: 'ws-1', text: 'Secret Key Never Group Shared Checklist Other Workspace', limit: 6 });
    assert.doesNotMatch(recalled.text, /PRIVATE_TOKEN_XYZ/);
    assert.doesNotMatch(recalled.text, /NEVER_GROUP_SECRET/);
    assert.doesNotMatch(recalled.text, /OTHER_WS_ITEM/);
    if (mnemonBin) assert.doesNotMatch(recalled.text, /OTHER_WS_MNEMON_ITEM/);
    assert.match(recalled.text, /SAFE_CHECKLIST_ITEM/);
});

test('memory http-auth requires connection admission for desktop mode and blocks DNS rebinding Host headers', async () => {
    assert.equal(hostIsLoopback('127.0.0.1:53478'), true);
    assert.equal(hostIsLoopback('localhost:53478'), true);
    assert.equal(hostIsLoopback('[::1]:53478'), true);
    assert.equal(hostIsLoopback('evil.example:53478'), false);

    const auth = createMemoryHttpAuth({
        resolveOwner: async () => 'owner',
        installOwner: 'owner',
        trustedRequest: req => req.headers?.cookie === 'dsh-auth=valid',
    });
    const req = headers => ({ headers, socket: { remoteAddress: '127.0.0.1' } });
    const base = { 'x-marshal-desktop': '1', 'x-marshal-memory': '1', host: '127.0.0.1:53478' };

    // Unadmitted local curl cannot mint a desktop session
    assert.equal((await auth.open(req(base))).ok, false);
    // DNS rebinding Host header is rejected even with valid admission cookie
    assert.equal((await auth.open(req({ ...base, host: 'evil.example:53478', cookie: 'dsh-auth=valid' }))).ok, false);
    // Admitted desktop request succeeds
    const opened = await auth.open(req({ ...base, cookie: 'dsh-auth=valid' }));
    assert.equal(opened.ok, true);
    const proof = { 'x-marshal-desktop': '1', 'x-marshal-session': opened.session.id, 'x-marshal-csrf': opened.session.csrf, host: '127.0.0.1:53478' };
    // Subsequent authenticate also enforces admission and loopback Host
    assert.equal(auth.authenticate(req(proof), { write: true }).ok, false);
    assert.equal(auth.authenticate(req({ ...proof, host: 'evil.example:53478', cookie: 'dsh-auth=valid' }), { write: true }).ok, false);
    assert.equal(auth.authenticate(req({ ...proof, cookie: 'dsh-auth=valid' }), { write: true }).ok, true);
});

test('debounced turn/end capture merges rapid same-owner turns instead of dropping the earlier turn', async (t) => {
    const root = tempRoot();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let listener;
    let unmount;
    const ledger = {
        teams: [{ id: 'team', members: [{ id: 'agent-a', name: '甲' }] }],
        runs: [{ sessionId: 's1', teamId: 'team', memberId: 'agent-a' }],
    };
    const ctx = {
        inject() {},
        effect(setup, label) { if (label === 'marshal: agent memory session capture') unmount = setup(); },
        on(_name, callback) { listener = callback; },
    };
    const service = mountAgentMemory(ctx, { memoryRoot: root, deviceId: 'dev-a' }, { ledger });
    t.after(() => { unmount?.(); service.store.close(); rmSync(root, { recursive: true, force: true }); });

    const end1 = { type: 'turn/end', seq: 3, data: { turn: 1, reason: 'completed' } };
    const session = {
        id: 's1',
        events: [
            { type: 'user/message', seq: 1, data: { content: '实现关键协议修复' } },
            { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: '已完成协议修复并通过测试' } } },
        ],
    };
    listener(session, end1);
    const end2 = { type: 'turn/end', seq: 6, data: { turn: 2, reason: 'completed' } };
    session.events.push(
        end1,
        { type: 'user/message', seq: 4, data: { content: '好的谢谢' } },
        { type: 'assistant/message', seq: 5, data: { turn: 2, message: { content: '不客气' } } },
    );
    t.mock.timers.tick(5_000);
    listener(session, end2);
    t.mock.timers.tick(60_000);
    await Promise.resolve();
    const entries = service.store.list('agent', 'agent-a');
    assert.equal(entries.length, 1);
    assert.match(entries[0].content, /实现关键协议修复/);
    assert.match(entries[0].content, /好的谢谢/);
});

test('Mnemon native updates metadata on duplicate content and injects pinned profile/handoff without keyword match', {
    skip: !mnemonBin && 'set MARSHAL_TEST_MNEMON to run real Mnemon checks',
}, async (t) => {
    const root = tempRoot();
    const ledger = {
        teams: [{ id: 't1', workspaceId: 'ws-a', members: [{ id: 'pilot', name: '试点' }] }],
        runs: [{ sessionId: 's1', teamId: 't1', memberId: 'pilot' }],
    };
    const service = createAgentMemoryService({ root, ledger, mnemonPilot: { agentId: 'pilot', executable: mnemonBin } });
    t.after(() => { service.store.close(); rmSync(root, { recursive: true, force: true }); });

    const first = await service.rememberFor({ agentId: 'pilot', workspaceId: 'ws-a', scope: 'agent', title: '部署约定', text: '先跑回归再打包。', visibility: 'private', kind: 'profile' });
    assert.equal(first.visibility, 'private');
    const updated = await service.rememberFor({ agentId: 'pilot', workspaceId: 'ws-a', scope: 'agent', title: '部署约定', text: '先跑回归再打包。', visibility: 'group-safe', kind: 'profile' });
    assert.equal(updated.visibility, 'group-safe');
    assert.equal(updated.allowedWorkspaceId, 'ws-a');

    const prompt = await service.nativePrompt(service.identity({
        session: { id: 's1', header: { kind: 'direct' }, events: [{ type: 'user/message', data: { content: '你好' } }] },
    }));
    assert.match(prompt, /先跑回归再打包/);
});

test('parseModelJson tolerates prose around JSON fences and superagent disambiguates duplicate names by workspace', () => {
    const wrapped = '审查结论如下：\n```json\n{"verdict":"pass","findings":"ok"}\n```\n以上。';
    assert.deepEqual(parseModelJson(wrapped, VerdictSchema), { verdict: 'pass', findings: 'ok' });

    const members = [
        { id: 'm1', name: '丞相', teamId: 't1', teamWorkspaceId: 'ws-1', legacy: false },
        { id: 'm2', name: '丞相', teamId: 't2', teamWorkspaceId: 'ws-2', legacy: false },
    ];
    assert.equal(findMember(members, '丞相'), undefined);
    assert.equal(findMember(members, '丞相', 'ws-2')?.id, 'm2');
    const resolved = resolveAgentForTask({ id: 'card-1', workspaceId: 'ws-2', tags: [{ name: '@丞相' }] }, defaultSettings(), members);
    assert.equal(resolved.member?.id, 'm2');
});

test('task orchestration matches bare model ids and clips oversize handoffs instead of failing', async (t) => {
    const root = tempRoot();
    const memory = createAgentMemoryService({ root: join(root, 'mem') });
    t.after(() => { memory.store.close(); rmSync(root, { recursive: true, force: true }); });

    const flow = createTaskOrchestration({
        file: join(root, 'orch.json'),
        memory,
        inventory: () => ({
            teams: [{ id: 'team', workspaceId: 'ws-1', members: [{ id: 'lead', name: 'Leader', model: 'deepseek-chat' }] }],
        }),
        port: {
            catalog: () => [{ id: 'dsh/deepseek-chat', agent: 'dsh', provider: 'deepseek', model: 'deepseek-chat' }],
            run: async () => JSON.stringify({ templateId: 'report', codeWork: false, members: {} }),
        },
    });
    const rec = await flow.recommend({ leaderId: 'team/lead', choice: 'template', templateId: 'report' }, { title: '大报告' });
    assert.equal(rec.plan.templateId, 'report');
});

test('shipped client keeps plain card create/run working and sends auth for taskRoom cards', () => {
    const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
    assert.ok(source.includes('if (leaderId && !workspace)'));
    assert.ok(source.includes("fetchJson('marshal/tasks/run', { taskId: task.id }, Boolean(task.workflow || task.taskRoom))"));
    assert.ok(source.includes("fetchJson('marshal/tasks/move', { taskId: task.id, status }, Boolean(task.workflow || task.taskRoom))"));
    assert.ok(source.includes("fetchJson('marshal/tasks/delete', { taskId: task.id }, Boolean(task.workflow || task.taskRoom))"));
    assert.ok(source.includes("!task.taskRoom?.closed && task.status !== 'running' && (!workflow || workflow.state !== 'done')"));
    for (const [key, label] of [['backlog', '待规划'], ['todo', '待办'], ['running', '进行中'], ['review', '待确认'], ['done', '已完成'], ['failed', '已失败']]) {
        assert.ok(source.includes("key: '" + key + "', label: '" + label + "'"), 'missing board column ' + key);
    }
    assert.ok(source.includes('--mtb-accent'), 'board should apply per-column theme accents');
    assert.ok(source.includes('taskTagTone'), 'board should render colored tag and priority pills');
    assert.ok(source.includes('mtb-drawer'), 'board should open a detail drawer on card click');
});

test('mountSuperagent adopts connection trust with only the real connection service (no connection.authentication)', async () => {
    const context = createFakeContext({
        taskBoard: createFakeBoard(),
        memory: createFakeMemory(),
        logger: loggerFixture(),
        connection: {
            requestRejection(req) {
                return String(req.headers.cookie ?? '').includes('dsh-auth-live=ok') ? undefined : 401;
            },
        },
    });
    try {
        mountSuperagent(context, { agents: ['dsh'] }, { root: tempRoot(), memory: createFakeMemory(), logger: context.logger, reconcileDelayMs: -1 });
        const route = context.routes.find(item => item.path === '/api/marshal-superagent/human-create');
        assert.ok(route);
        const invoke = async headers => {
            let status = 0;
            const req = { method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{"taskId":"t1","source":"board-ui"}'); } };
            const res = { writeHead(code) { status = code; }, end() {} };
            await route.handler(req, res);
            return status;
        };
        assert.equal(await invoke({ host: '127.0.0.1:56822', 'content-type': 'application/json' }), 403);
        assert.notEqual(await invoke({ host: '127.0.0.1:56822', 'content-type': 'application/json', cookie: 'dsh-auth-live=ok' }), 403);
    }
    finally {
        context.close();
    }
});

test('local board supports moving tasks across all six columns including review', async (t) => {
    const dir = tempRoot();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const board = createLocalBoard(join(dir, 'board.json'));
    const created = await board.apply('r1', { kind: 'create', id: 'task-1', input: { title: '验证待确认列', tags: [{ name: '记忆' }, { name: 'P1' }] } });
    assert.equal(created.tasks[0].status, 'todo');
    assert.deepEqual(created.tasks[0].tags, [{ name: '记忆' }, { name: 'P1' }]);
    const inReview = await board.apply('r2', { kind: 'move', taskId: 'task-1', status: 'review' });
    assert.equal(inReview.tasks[0].status, 'review');
    const confirmed = await board.apply('r3', { kind: 'move', taskId: 'task-1', status: 'done' });
    assert.equal(confirmed.tasks[0].status, 'done');
    const ignored = await board.apply('r4', { kind: 'move', taskId: 'task-1', status: 'bogus' });
    assert.equal(ignored.tasks[0].status, 'done');
});
