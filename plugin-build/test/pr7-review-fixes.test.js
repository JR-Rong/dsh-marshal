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
import { createTaskOrchestration, isPermissionBlockedError } from '../lib/src/groups/task-orchestration.js';
import { createWorkspaceRosters } from '../lib/src/groups/workspace-rosters.js';
import { createLocalBoard } from '../lib/src/groups/local-board.js';
import { detectAmbiguousTask } from '../lib/src/groups/mount.js';
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
    assert.ok(source.includes('mtb-tpl-pill'), 'create form should expose agent orchestration templates directly');
    assert.ok(source.includes("fetchJson('marshal/tasks/set-parent'"), 'board should support linking subtasks');
    assert.ok(source.includes("fetchJson('marshal/tasks/update'"), 'board should support editing tags and card details');
    assert.ok(source.includes('--mtb-res-c'), 'bottom-left result badge should use high-contrast explicit dot + label-primary text');
    assert.ok(source.includes('api/task-board/parse'), 'board should expose AI task draft parser modal');
    assert.ok(source.includes('api/task-board/model-catalog'), 'board should load models and reasoning efforts');
    assert.ok(source.includes('api/task-board/attachments/upload'), 'board should support optional attachment uploads');
    assert.ok(source.includes('指派 Agent Leader'), 'board should support assigning an Agent Leader');
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
    await board.apply('r5', { kind: 'create', id: 'task-2', input: { title: '子任务', parentId: 'task-1' } });
    const updated = await board.apply('r6', { kind: 'update', taskId: 'task-2', patch: { tags: [{ name: 'P2' }] } });
    const child = updated.tasks.find(item => item.id === 'task-2');
    assert.equal(child.parentId, 'task-1');
    assert.deepEqual(child.tags, [{ name: 'P2' }]);
    const unlinked = await board.apply('r7', { kind: 'set-parent', taskId: 'task-2', parentId: null });
    assert.equal(unlinked.tasks.find(item => item.id === 'task-2').parentId, undefined);
    const archived = await board.apply('r8', { kind: 'archive', taskId: 'task-1' });
    assert.ok(typeof archived.tasks.find(item => item.id === 'task-1').archivedAt === 'number');
    const restored = await board.apply('r9', { kind: 'restore', taskId: 'task-1' });
    assert.equal(restored.tasks.find(item => item.id === 'task-1').archivedAt, undefined);
});

test('embedded patched task-board host runtime is bundled with review settlement', () => {
    const embedded = readFileSync(new URL('../lib/src/task-board/index.js', import.meta.url), 'utf8');
    assert.ok(embedded.includes('mountOnce("@linxin666/dsh-client-ui-task-board"'));
    assert.ok(embedded.includes('if (outcome === "succeeded") return task.schedule?.enabled === true ? "todo" : "review";'));
});

test('detectAmbiguousTask routes vague or underspecified tickets to review while passing clear ones', () => {
    assert.ok(detectAmbiguousTask({ title: '优化一下', description: '' }));
    assert.ok(detectAmbiguousTask({ title: '帮我处理一下页面', description: '看着办' }));
    assert.ok(detectAmbiguousTask({ title: '看板改进', description: '细节待定' }));
    assert.equal(detectAmbiguousTask({ title: '修复 PR #7 看板左下角对比度', description: '把 .mtb-result 改为高对比主文本色并验证暗色/亮色主题。' }), undefined);
    assert.equal(detectAmbiguousTask({ title: '看看截图', description: '', hasAttachments: true }), undefined);
});


// --- .19 unified architecture & bundling tests ---
test('embedded dsh-agents runtime includes process-wide deduplication guard', () => {
    const embedded = readFileSync(new URL('../lib/src/dsh-agents/index.js', import.meta.url), 'utf8');
    assert.ok(embedded.includes('DSH_AGENTS_MOUNT_KEY'), 'embedded dsh-agents must guard against double mount');
    const hostEntry = readFileSync(new URL('../lib/src/index.js', import.meta.url), 'utf8');
    assert.ok(hostEntry.includes('./dsh-agents/index.js'), 'host index should lazily load embedded dsh-agents');
});

test('workspace rosters persist per-workspace default leader, coder, reviewer and members', (t) => {
    const dir = tempRoot();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'workspace-rosters.json');
    const rosters = createWorkspaceRosters(file);
    const saved = rosters.set('ws-alpha', {
        leaderId: 'team-1/cx',
        coderId: 'team-2/gb',
        reviewerId: 'team-3/sz',
        members: ['team-1/cx', 'team-2/gb', 'team-3/sz', 'team-2/gb'],
    });
    assert.equal(saved.leaderId, 'team-1/cx');
    assert.equal(saved.coderId, 'team-2/gb');
    assert.equal(saved.reviewerId, 'team-3/sz');
    assert.deepEqual(saved.members, ['team-1/cx', 'team-2/gb', 'team-3/sz']);

    const reloaded = createWorkspaceRosters(file);
    assert.deepEqual(reloaded.get('ws-alpha')?.members, ['team-1/cx', 'team-2/gb', 'team-3/sz']);
    assert.equal(Object.keys(reloaded.list()).length, 1);
    assert.equal(reloaded.remove('ws-alpha'), true);
    assert.equal(reloaded.get('ws-alpha'), undefined);
});

test('global agents can orchestrate in any target project workspace while permission blocks auto-route to review', async (t) => {
    const dir = tempRoot();
    const memory = createAgentMemoryService({ root: join(dir, 'mem') });
    t.after(() => { memory.store.close(); rmSync(dir, { recursive: true, force: true }); });

    assert.equal(isPermissionBlockedError(new Error('EACCES: permission denied')), true);
    assert.equal(isPermissionBlockedError({ code: 'confirmation-required', message: 'needs approval' }), true);
    assert.equal(isPermissionBlockedError(new Error('ordinary syntax error')), false);

    const blockedEvents = [];
    const flow = createTaskOrchestration({
        file: join(dir, 'orch.json'),
        memory,
        leaderAutoReview: true,
        onPermissionBlocked: (source, taskId, reason) => { blockedEvents.push({ source, taskId, reason }); },
        inventory: () => ({
            teams: [
                { id: 't-global-1', name: 'marshal-agent:丞相-abc', members: [{ id: 'cx', name: '丞相', permission: 'danger-full-access', model: 'deepseek-chat' }] },
                { id: 't-global-2', name: 'marshal-agent:工部-def', members: [{ id: 'gb', name: '工部', permission: 'workspace-write', model: 'deepseek-chat' }] },
                { id: 't-foreign', name: 'project-other', workspaceId: 'ws-other', members: [{ id: 'other', name: '外人', model: 'deepseek-chat' }] },
            ],
        }),
        port: {
            catalog: () => [{ id: 'dsh/deepseek-chat', agent: 'dsh', provider: 'deepseek', model: 'deepseek-chat' }],
            run: async () => {
                const err = new Error('sandbox permission denied outside workspace');
                err.code = 'permission-denied';
                throw err;
            },
        },
    });

    // Global agent can be prepared for any target workspaceId
    const prepared = flow.prepare({
        leaderId: 't-global-1/cx',
        workspaceId: 'ws-target',
        choice: 'leader',
    });
    assert.equal(prepared.workspaceId, 'ws-target');

    // Project-scoped foreign agent stays isolated from ws-target
    assert.throws(() => flow.prepare({
        leaderId: 't-global-1/cx',
        workspaceId: 'ws-target',
        choice: 'template',
        templateId: 'development',
        plan: { templateId: 'development', codeWork: true, members: { coder: 't-foreign/other', reviewer: 't-global-2/gb' } },
    }), /工作区/);

    // Permission-blocked run transitions to permission-blocked and fires onPermissionBlocked callback
    flow.attach('local', 'card-perm-1', prepared);
    flow.start('local', { id: 'card-perm-1', title: '需权限确认的任务', description: '测试权限受阻' });
    for (let i = 0; i < 40 && flow.view('local', 'card-perm-1')?.state === 'running'; i++) {
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    const view = flow.view('local', 'card-perm-1');
    assert.equal(view?.state, 'permission-blocked');
    assert.equal(blockedEvents.length, 1);
    assert.equal(blockedEvents[0].taskId, 'card-perm-1');
});

test('shipped client .19 delivers 4-tab nav, default tasks landing, dual casual-chat entry, rosters and 3-layer memory', () => {
    const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
    assert.ok(source.includes("['tasks', '任务看板']"), 'MarshalNav should list tasks tab');
    assert.ok(source.includes("['chats', '会话']"), 'MarshalNav should list chats tab');
    assert.ok(source.includes("['agents', '智能体']"), 'MarshalNav should list agents tab');
    assert.ok(source.includes("['memory', '记忆']"), 'MarshalNav should list memory tab');
    assert.ok(source.includes("return { tab: 'tasks' };"), 'default landing tab should be tasks');
    assert.ok(source.includes('function AgentDirectChatsView'), 'chats tab should include direct casual chat history view');
    assert.ok(source.includes("fetchJson('marshal/agents/sessions')"), 'client should load agent casual chat history');
    assert.ok(source.includes("fetchJson('marshal/rosters/save'"), 'client should save workspace default rosters');
    assert.ok(source.includes("fetchJson('marshal/devices/status')"), 'client should poll device status capsule');
    assert.ok(source.includes('全局记忆与审批') && source.includes('智能体私有记忆') && source.includes('工作区共享记忆'), 'MemoryPage should render 3 orthogonal layers');
    assert.ok(source.includes('isPseudoAgentWorkspace'), 'client should hide pseudo Agent · workspaces');
    assert.ok(!source.includes('自动创建「Agent · '), 'creating a new agent must no longer create pseudo Agent · workspaces');
});
