import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentMemoryService, mountAgentMemory, resolveMemoryIdentity, resolveWorkspaceIdForCwd, workspaceKey } from '../lib/src/memory/agent-memory.js';
import { parseDotEdges } from '../lib/src/memory/mnemon-native.js';
import { createMemoryHttpAuth, hostIsLoopback } from '../lib/src/memory/http-auth.js';
import { parseModelJson, VerdictSchema } from '../lib/src/groups/task-plans.js';
import { createTaskOrchestration, isPermissionBlockedError } from '../lib/src/groups/task-orchestration.js';
import { createWorkspaceRosters } from '../lib/src/groups/workspace-rosters.js';
import { createTicketNumbers, withTicketPrefix } from '../lib/src/groups/ticket-numbers.js';
import { createSessionTitles, isGenericSessionTitle, summarizeFirstMessage } from '../lib/src/groups/session-titles.js';
import { memoryTargetAllowed } from '../lib/src/memory/http-auth.js';
import { parseConfig } from '../lib/src/config.js';
import { createLocalBoard } from '../lib/src/groups/local-board.js';
import { detectAmbiguousTask } from '../lib/src/groups/mount.js';

const tempRoot = () => mkdtempSync(join(tmpdir(), 'marshal-pr7-fixes-'));
const mnemonBin = process.env.MARSHAL_TEST_MNEMON;

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

test('parseModelJson tolerates prose around JSON fences', () => {
    const wrapped = '审查结论如下：\n```json\n{"verdict":"pass","findings":"ok"}\n```\n以上。';
    assert.deepEqual(parseModelJson(wrapped, VerdictSchema), { verdict: 'pass', findings: 'ok' });
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
    assert.ok(source.includes("['tasks', '工单看板']"), 'MarshalNav should list tasks tab');
    assert.ok(source.includes("['monitor', '问题监控']"), 'MarshalNav should list monitor tab');
    assert.ok(source.includes("['agents', '智能体与集群']"), 'MarshalNav should list agents tab');
    assert.ok(source.includes("['memory', '3D 记忆星系']"), 'MarshalNav should list memory tab');
    assert.ok(source.includes("return { tab: 'tasks' };"), 'default landing tab should be tasks');
    assert.ok(source.includes('function AgentDirectChatsView'), 'chats tab should include direct casual chat history view');
    assert.ok(source.includes("fetchJson('marshal/agents/sessions')"), 'client should load agent casual chat history');
    assert.ok(source.includes("fetchJson('marshal/rosters/save'"), 'client should save workspace default rosters');
    assert.ok(source.includes("fetchJson('marshal/devices/status', undefined, true, signal)"), 'client should refresh authenticated device status');
    assert.ok(source.includes('全局记忆与审批') && source.includes('智能体私有记忆') && source.includes('工作区共享记忆'), 'MemoryPage should render 3 orthogonal layers');
    assert.ok(source.includes('isPseudoAgentWorkspace'), 'client should hide pseudo Agent · workspaces');
    assert.ok(!source.includes('自动创建「Agent · '), 'creating a new agent must no longer create pseudo Agent · workspaces');
});


// --- .20 ticket numbers, session titles & workspace memory auth tests ---
test('ticket numbers assign monotonic GD-00001 ids chronologically and prefix room titles idempotently', (t) => {
    const dir = tempRoot();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'ticket-numbers.json');
    const nums = createTicketNumbers(file);
    nums.ensureAll([
        { id: 'task-b', createdAt: 200 },
        { id: 'task-a', createdAt: 100 },
    ]);
    assert.equal(nums.get('task-a'), 'GD-00001');
    assert.equal(nums.get('task-b'), 'GD-00002');
    assert.equal(nums.ensure('task-c'), 'GD-00003');
    assert.equal(withTicketPrefix('GD-00001', '修复工作区记忆'), '[GD-00001] 修复工作区记忆');
    assert.equal(withTicketPrefix('GD-00001', '[GD-00001] 修复工作区记忆'), '[GD-00001] 修复工作区记忆');

    const reloaded = createTicketNumbers(file);
    assert.equal(reloaded.ensure('task-d'), 'GD-00004');
});

test('session titles summarize first messages, ignore generic machine titles, and honor manual renames', (t) => {
    const dir = tempRoot();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'session-titles.json');
    const titles = createSessionTitles(file);

    assert.equal(isGenericSessionTitle('marshal-agent:丞相-4m5jvl / 丞相'), true);
    assert.equal(isGenericSessionTitle('丞相 的闲聊会话'), true);
    assert.equal(isGenericSessionTitle('评审 dsh-agy-native 插件安全性'), false);

    const auto = titles.resolve({
        sessionId: 'session-1',
        dshTitle: 'marshal-agent:丞相-4m5jvl / 丞相',
        firstText: '帮我 review 一下 marshal 的 pr7，看看有没有什么问题',
        agentName: '丞相',
    });
    assert.equal(auto.titleSource, 'auto');
    assert.match(auto.title, /review.*pr7/i);

    const dshReal = titles.resolve({
        sessionId: 'session-2',
        dshTitle: '检查系统日志OOM问题',
        firstText: '帮我看一下系统日志',
        agentName: '丞相',
    });
    assert.equal(dshReal.title, '检查系统日志OOM问题');
    assert.equal(dshReal.titleSource, 'dsh');

    titles.setCustom('session-1', 'PR7 架构深度评审');
    const custom = titles.resolve({
        sessionId: 'session-1',
        dshTitle: 'marshal-agent:丞相-4m5jvl / 丞相',
        firstText: '帮我 review 一下 marshal 的 pr7',
        agentName: '丞相',
    });
    assert.equal(custom.title, 'PR7 架构深度评审');
    assert.equal(custom.titleSource, 'custom');

    assert.equal(summarizeFirstMessage('【超级智能体派发】\n智能体：丞相\n任务标题：修复内存泄漏'), '修复内存泄漏');
});

test('memoryTargetAllowed admits owner real DSH workspaces even without pinned agent teams while blocking foreign workspaces', () => {
    const ownerSession = { owner: true, ownerId: 'owner-a' };
    const guestSession = { owner: false, ownerId: 'owner-b' };
    const ledger = {
        teams: [
            { id: 't-global', name: 'marshal-agent:丞相', members: [{ id: 'a1' }] },
            { id: 't-foreign', workspaceId: 'ws-foreign', ownerId: 'owner-b', members: [{ id: 'a2', ownerId: 'owner-b' }] },
        ],
    };
    const registered = [
        { id: 'ws-real-project', title: 'ChassisControl', path: '/Volumes/SystemDisk/Workspace/ChassisControl' },
        { id: 'ws-foreign', title: 'Foreign', path: '/tmp/foreign' },
    ];
    assert.equal(memoryTargetAllowed(ownerSession, { workspaceId: 'ws-real-project', scope: 'workspace' }, ledger, registered), true);
    assert.equal(memoryTargetAllowed(ownerSession, { workspaceId: 'ws-foreign', scope: 'workspace' }, ledger, registered), false);
    assert.equal(memoryTargetAllowed(ownerSession, { workspaceId: 'ws-unknown-bogus', scope: 'workspace' }, ledger, registered), false);
    assert.equal(memoryTargetAllowed(guestSession, { workspaceId: 'ws-real-project', scope: 'workspace' }, ledger, registered), false);
    assert.equal(memoryTargetAllowed(guestSession, { workspaceId: 'ws-foreign', scope: 'workspace' }, ledger, registered), true);
});

test('shipped client .20 exposes session rename/summarize, [GD-00001] ticket numbers, and board flow guide', () => {
    const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
    assert.ok(source.includes("fetchJson('marshal/agents/sessions/rename'"), 'client should allow renaming sessions');
    assert.ok(source.includes("fetchJson('marshal/agents/sessions/summarize'"), 'client should allow summarizing session titles');
    assert.ok(source.includes('task.ticketNo'), 'board should render GD ticket numbers');
    assert.ok(source.includes('流转规则'), 'board should expose status transition guide');
});


// --- .21 full-fleet Mnemon, MemoryPage TDZ & TaskBoard scroll tests ---
test('config accepts wildcard mnemonPilot.agentId="*" for full-fleet Mnemon memory', () => {
    const cfg = parseConfig({
        role: 'node',
        deviceId: 'mac-1',
        hubUrl: 'wss://hub.example/marshal/uplink',
        token: 'a'.repeat(24),
        mnemonPilot: { agentId: '*', executable: '/usr/local/bin/mnemon' },
    });
    assert.equal(cfg.mnemonPilot?.agentId, '*');
    assert.equal(cfg.mnemonPilot?.executable, '/usr/local/bin/mnemon');
});

test('full-fleet Mnemon powers both agent and workspace scopes, migrates SQLite losslessly, and emits L1 push-index', async (t) => {
    if (!mnemonBin) { t.skip('set MARSHAL_TEST_MNEMON to run full-fleet Mnemon tests'); return; }
    const dir = tempRoot();
    // Pre-seed a legacy SQLite memory before enabling full-fleet Mnemon
    const seeded = createAgentMemoryService({ root: dir });
    await seeded.rememberFor({ agentId: 'cx-1', scope: 'agent', title: '奏对铁律', text: '结论诚实，事实不隐瞒' });
    seeded.store.close();

    const service = createAgentMemoryService({
        root: dir,
        mnemonPilot: { agentId: '*', executable: mnemonBin },
    });
    t.after(() => { service.store.close(); rmSync(dir, { recursive: true, force: true }); });

    assert.equal(service.usesMnemon('cx-1', undefined), true);
    assert.equal(service.usesMnemon(undefined, 'ws-alpha'), true);

    // Workspace shared memory writes and lists via Mnemon with cue metadata
    const wsItem = await service.rememberFor({
        workspaceId: 'ws-alpha',
        scope: 'workspace',
        title: '看板列宽需设置 min-width: 0',
        text: '防止 6 列看板在窄窗下被外层 flex 裁切无法横滚。',
        cue: '修改任务看板布局时',
    });
    assert.equal(wsItem.backend, 'mnemon');
    assert.equal(wsItem.cue, '修改任务看板布局时');

    const agentItems = await service.listFor({ agentId: 'cx-1', scope: 'agent', includeGlobal: false });
    assert.ok(agentItems.some(item => item.title === '奏对铁律'), 'legacy SQLite row should migrate losslessly to Mnemon');

    // Add a second memory so L1 index pushes beyond L0/L2
    await service.rememberFor({ agentId: 'cx-1', scope: 'agent', title: '发版前必跑双测', text: '无 Mnemon 与带 Mnemon 两套回归都要过。', cue: '打包发版前' });
    const prompt = await service.nativePrompt({
        registeredAgent: true,
        agentId: 'cx-1',
        workspaceId: 'ws-alpha',
        sessionId: 's-fleet',
        session: { id: 's-fleet', header: { kind: 'direct' }, events: [{ type: 'user/message', data: { content: '你好' } }] },
    });
    assert.match(prompt, /Mnemon/);
    assert.match(prompt, /奏对铁律|看板列宽|发版前必跑双测/);
});

test('shipped client .21 fixes MemoryPage realWorkspaces TDZ, wraps with ErrorBoundary, and enables TaskBoard horizontal scroll & collapse', () => {
    const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
    const mpStart = source.indexOf('function MemoryPage(');
    const mpEnd = source.indexOf('function AgentDirectChatsView(', mpStart);
    const mpSrc = source.slice(mpStart, mpEnd);
    const declIdx = mpSrc.indexOf('const realWorkspaces = React.useMemo');
    const firstUseIdx = mpSrc.indexOf('realWorkspaces');
    assert.ok(declIdx > 0, 'realWorkspaces declaration should exist in MemoryPage');
    assert.equal(firstUseIdx, declIdx + 'const '.length, 'realWorkspaces must never be referenced before its declaration (TDZ bug)');
    assert.ok(source.includes('class MarshalErrorBoundary'), 'panel should wrap tabs in an ErrorBoundary');
    assert.ok(source.includes('.mtb-page{flex:1;min-height:0;min-width:0;width:100%;overflow:hidden'), 'TaskBoard .mtb-page must constrain min-width: 0 for horizontal scroll');
    assert.ok(source.includes('handleGridDragOver'), 'TaskBoard should auto-scroll horizontally while dragging cards');
    assert.ok(source.includes('toggleCollapseCol'), 'TaskBoard should allow collapsing columns into vertical rails');
});

// --- .22 canonical workspace UUID, zero-duplication Mnemon, graph edges, cue HTTP, and TaskBoard drag-pan tests ---
test('resolveWorkspaceIdForCwd resolves registered workspace UUID, skips legacy Agent pseudo-workspaces, and falls back to workspaceKey', () => {
    const workspaces = [
        { id: 'ws-default-uuid', title: 'default-workspace', path: '/tmp/ws/default-workspace' },
        { id: 'ws-nested-uuid', title: 'nested', path: '/tmp/ws/default-workspace/sub' },
        { id: 'ws-ghost-agent', title: 'Agent · 丞相', path: '/Users/test/.dsh-marshal/agents/Agent · 丞相' },
    ];
    assert.equal(resolveWorkspaceIdForCwd('/tmp/ws/default-workspace', workspaces), 'ws-default-uuid');
    assert.equal(resolveWorkspaceIdForCwd('/tmp/ws/default-workspace/src/app', workspaces), 'ws-default-uuid');
    assert.equal(resolveWorkspaceIdForCwd('/tmp/ws/default-workspace/sub/pkg', workspaces), 'ws-nested-uuid');
    assert.equal(
        resolveWorkspaceIdForCwd('/Users/test/.dsh-marshal/agents/Agent · 丞相', workspaces),
        workspaceKey('/Users/test/.dsh-marshal/agents/Agent · 丞相'),
    );
    assert.equal(resolveWorkspaceIdForCwd('/tmp/unregistered/dir', workspaces), workspaceKey('/tmp/unregistered/dir'));

    const id = resolveMemoryIdentity({ session: { id: 's-1', header: { cwd: '/tmp/ws/default-workspace' } } }, { ledger: { teams: [], runs: [] }, workspaces });
    assert.equal(id.workspaceId, 'ws-default-uuid');
});

test('parseDotEdges deduplicates symmetric edges, preserves directed edges, and prioritizes non-proximity links', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const c = '33333333-3333-4333-8333-333333333333';
    const dot = [
        'digraph mnemon {',
        '  "' + a + '" -> "' + b + '" [label="entity", color="#2ecc71"];',
        '  "' + b + '" -> "' + a + '" [label="entity", color="#2ecc71"];',
        '  "' + a + '" -> "' + c + '" [label="causal", color="#e74c3c"];',
        '  "' + b + '" -> "' + c + '" [label="proximity", color="#aaaaaa"];',
        '}',
    ].join('\n');
    const edges = parseDotEdges(dot);
    assert.equal(edges.length, 2, 'should deduplicate symmetric entity and drop proximity when meaningful edges exist');
    assert.equal(edges[0].kind, 'causal');
    assert.equal(edges[1].kind, 'entity');
});

test('full-fleet Mnemon eliminates SQLite duplicates, migrates legacy workspaceKey aliases, prevents double prompt injection, projects graph edges, and deletes cleanly', async (t) => {
    if (!mnemonBin) { t.skip('set MARSHAL_TEST_MNEMON to run full-fleet Mnemon deduplication tests'); return; }
    const dir = tempRoot();
    const wsPath = '/tmp/marshal-canonical-ws-test';
    const wsUuid = 'ws-uuid-canonical-001';
    const legacyAlias = workspaceKey(wsPath);
    const workspaces = [{ id: wsUuid, title: 'canonical-ws', path: wsPath }];

    // Seed legacy SQLite rows under both agent and legacy hashed workspaceKey
    const seeded = createAgentMemoryService({ root: dir, ledger: { teams: [], runs: [] }, workspaces });
    await seeded.rememberFor({ agentId: 'cx-1', scope: 'agent', title: '奏对铁律', text: '结论诚实，事实不隐瞒' });
    await seeded.rememberFor({ workspaceId: legacyAlias, scope: 'workspace', title: '工作区交接', text: '旧 cwd 哈希下的工作区交接记录', kind: 'handoff' });
    await seeded.rememberFor({ scope: 'global', title: '全局总规', text: '全系统通用全局铁律' });
    seeded.store.close();

    const service = createAgentMemoryService({
        root: dir,
        ledger: { teams: [], runs: [] },
        workspaces,
        mnemonPilot: { agentId: '*', executable: mnemonBin },
    });
    t.after(() => { service.store.close(); rmSync(dir, { recursive: true, force: true }); });

    // Workspace legacy alias migrates into canonical workspace UUID with zero duplicates
    const wsItems = await service.listFor({ workspaceId: wsUuid, scope: 'workspace', includeGlobal: false });
    assert.equal(wsItems.length, 1);
    assert.equal(wsItems[0].title, '工作区交接');
    assert.equal(wsItems[0].backend, 'mnemon');

    // Agent SQLite rows migrate to Mnemon with zero duplicates and real Mnemon UUIDs in graph
    const second = await service.rememberFor({
        agentId: 'cx-1', scope: 'agent', title: '研发流程章程', text: '奏对铁律配套的研发流程章程，结论诚实。', cue: '讨论研发章程时',
    });
    const agentGraph = await service.graphFor({ agentId: 'cx-1', includeGlobal: false });
    assert.equal(agentGraph.nodes.length, 2, 'must not duplicate migrated SQLite + Mnemon nodes');
    assert.ok(agentGraph.nodes.every(n => n.backend === 'mnemon'), 'graph nodes must keep Mnemon UUIDs so edges match');
    assert.ok(agentGraph.edges.length >= 1, 'Mnemon graph edges should be projected into MemoryGalaxy');

    // SQLite memoryBlock() skips Mnemon-powered agent & workspace scopes (no double prompt injection), keeps global
    const identity = { agentId: 'cx-1', registeredAgent: true, workspaceId: wsUuid, sessionId: 's-nodup', session: { id: 's-nodup', header: { kind: 'direct' }, events: [{ type: 'user/message', data: { content: '汇报工作区交接和奏对铁律' } }] } };
    const sqlBlock = service.block(identity);
    assert.match(sqlBlock, /全局总规/, 'global memory should still inject in <memory>');
    assert.doesNotMatch(sqlBlock, /奏对铁律/, 'Mnemon-powered agent memory must not double-inject in SQLite block');
    assert.doesNotMatch(sqlBlock, /工作区交接/, 'Mnemon-powered workspace memory must not double-inject in SQLite block');
    const mnPrompt = await service.nativePrompt(identity);
    assert.match(mnPrompt, /工作区交接/);

    // Forgetting a migrated Mnemon memory also removes its SQLite twin and updates exact stats
    const migratedNode = agentGraph.nodes.find(n => n.title === '奏对铁律');
    assert.ok(migratedNode);
    assert.equal(await service.forgetFor({ agentId: 'cx-1', id: migratedNode.id }), true);
    const afterForget = await service.listFor({ agentId: 'cx-1', scope: 'agent', includeGlobal: false });
    assert.equal(afterForget.length, 1);
    assert.equal(afterForget[0].id, second.id);
    assert.equal(service.store.list('agent', 'cx-1').length, 0, 'SQLite twin must also be removed so it cannot resurrect');
    const stats = await service.statsFor([{ scope: 'agent', ownerId: 'cx-1' }]);
    assert.equal(stats[0].total, 1);
});

test('POST /marshal/memory/remember forwards cue and shipped client .22 exposes TaskBoard drag-pan, collapseEmptyCols & legacyReadOnly badge', () => {
    const httpSrc = readFileSync(new URL('../lib/src/memory/http.js', import.meta.url), 'utf8');
    const remIdx = httpSrc.indexOf("path: '/marshal/memory/remember'");
    assert.ok(remIdx > 0);
    assert.ok(httpSrc.slice(remIdx, remIdx + 1200).includes('cue: body.cue.trim()'), '/marshal/memory/remember must forward cue');

    const clientSrc = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
    assert.ok(clientSrc.includes('handleGridMouseDown'), 'TaskBoard should support drag-to-pan on empty grid canvas');
    assert.ok(clientSrc.includes('handleGridWheel'), 'TaskBoard should support horizontal wheel scrolling');
    assert.ok(clientSrc.includes('collapseEmptyCols'), 'TaskBoard should expose 1-click collapse empty columns');
    assert.ok(clientSrc.includes('mtb-edge-pan-right'), 'TaskBoard should render right-edge quick jump cue');
    assert.ok(clientSrc.includes('legacyReadOnly'), 'Agent chat list should label cleaned legacy sessions as read-only archive');
});

// --- .23 universal todo auto-dispatch regardless of trigger source ---
test('groups/mount.js persists workspaceId on board create and task-development.js explains non-Git workspace errors clearly', () => {
    const gmSrc = readFileSync(new URL('../lib/src/groups/mount.js', import.meta.url), 'utf8');
    assert.ok(gmSrc.includes('cardWorkspaceId'), 'POST /marshal/tasks/create should persist workspaceId onto the task-board card');
    const devSrc = readFileSync(new URL('../lib/src/groups/task-development.js', import.meta.url), 'utf8');
    assert.ok(devSrc.includes('不是 Git 仓库根目录'), 'task-development.js should clearly explain non-Git workspace errors');
});

test('vNext ticket conversation keeps Markdown, bubble roles, independent send and dual-surface review', () => {
    const read = name => readFileSync(new URL(`../client/src/${name}.js`, import.meta.url), 'utf8');
    const room = read('48-ticket-room-vnext');
    const bubbles = read('40-groups');
    const markdown = read('45-trace-and-markdown');
    const board = read('50-tasks');
    const dag = read('46-dag-sidebar');
    assert.match(markdown, /const normalized = React.useMemo\(\(\) => normalizeMessageMarkdown\(text, phase\)/);
    assert.match(bubbles, /h\(RichMarkdown, \{ text, phase \}/);
    assert.match(room, /mine: record.kind === 'user', accent: colorMap.get\(record.actor\)/);
    assert.match(bubbles, /marginInlineStart: mine \? 'var\(--mv-xl\)' : undefined/);
    assert.match(bubbles, /marginInlineEnd: mine \? undefined : 'var\(--mv-xl\)'/);
    assert.match(room, /buildRoomColorMap\(visible\?\.records, visible\?\.participants\)/);
    assert.ok(board.includes("fetchJson('marshal/tasks/confirm-review'"));
    assert.ok(board.includes("fetchJson('marshal/tasks/revise'"));
    assert.match(dag, /fetchJson\(action === 'confirm' \? 'marshal\/tasks\/confirm-review' : 'marshal\/tasks\/revise'/);
    assert.match(room, /action !== 'send' && action !== 'revise' && locked/);
    assert.match(room, /if \(text && !visible\?\.chatBusy\) return act\('send'/);
    assert.match(room, /leaders.filter\(p => p.global \|\| p.workspaceId === workspace\)/);
});
