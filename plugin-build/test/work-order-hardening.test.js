import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { DiscussionError, WorkScopeSchema } from '../lib/src/discussions/types.js';
import { createAgentMemoryService } from '../lib/src/memory/agent-memory.js';
import { createLocalBoard } from '../lib/src/groups/local-board.js';
import { createPatchStore, parsePatchArtifactHeader, resolvePatchText } from '../lib/src/groups/patch-store.js';
import { createTaskRoomStore } from '../lib/src/groups/task-room-store.js';
import { createTaskRooms } from '../lib/src/groups/task-rooms.js';
import { createTaskRoomRoutes, findLatestPatch, taskRoomAudit } from '../lib/src/groups/task-room-routes.js';
import { createTaskOrchestration } from '../lib/src/groups/task-orchestration.js';
import { applyDevelopmentPatch } from '../lib/src/groups/task-development.js';
import { DelegationSchema, parseModelJson } from '../lib/src/groups/task-plans.js';
import { createTaskToolController } from '../lib/src/groups/task-tool-controller.js';
import { agentToolDefinitions } from '../lib/src/groups/agent-tools.js';

function initTempRepo(root, name = 'repo') {
    const repo = join(root, name);
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'mobile', 'plugins', 'local-plugin', 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(repo, 'src', 'app.js'), 'export const version = 1;\n');
    writeFileSync(join(repo, 'mobile', 'plugins', 'local-plugin', 'package.json'), '{"name":"local-plugin"}\n');
    writeFileSync(join(repo, 'mobile', 'plugins', 'local-plugin', 'node_modules', 'dep', 'index.js'), 'export const ok = true;\n');
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'init']);
    return { repo, git };
}

async function waitUntil(fn, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const val = await fn();
        if (val) return val;
        await sleep(15);
    }
    throw new Error('Timed out waiting for condition');
}

const MEMBERS = [
    { id: 'lead', name: '丞相', permission: 'danger-full-access' },
    { id: 'coder', name: '工部尚书', permission: 'workspace-write' },
    { id: 'reviewer', name: '刑部尚书', permission: 'read-only' },
];
const DSH_MODEL = { id: 'dsh:fixture:flash', agent: 'dsh', provider: 'fixture', model: 'flash' };
const CODEX_MODEL = { id: 'codex:openai:sol', agent: 'codex', provider: 'openai', model: 'sol', work: true };

test('WorkScopeSchema supports readOnly flag and parseModelJson handles stray braces + long instructions', () => {
    assert.deepEqual(WorkScopeSchema.parse({ workspace: '/tmp/wt', readOnly: true }), { workspace: '/tmp/wt', readOnly: true });
    assert.throws(() => WorkScopeSchema.parse({ workspace: '/tmp/wt', unknown: 1 }));

    const longInstruction = 'X'.repeat(8500);
    const wrapped = '先看下背景对象 {foo: bar}，再给出决定：\n' + JSON.stringify({ action: 'codex', instruction: longInstruction }) + '\n补充注释 {baz}';
    const parsed = parseModelJson(wrapped, DelegationSchema);
    assert.equal(parsed.action, 'codex');
    assert.equal(parsed.instruction.length, 8500);
});

test('large patch (>48 KiB) persists in patchStore, injects repoContext, mounts readOnly review worktree, and commits only touched files', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-large-patch-'));
    const { repo, git } = initTempRepo(root);
    // Add an unrelated dirty file in host workspace to verify selective commit
    writeFileSync(join(repo, 'unrelated-dirty.txt'), 'keep me unstaged\n');

    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'rooms.sqlite')), deviceId: 'dev-1' });
    const patchStore = createPatchStore(join(root, 'patches'));

    let sawRepoContext = false;
    let sawReadOnlyReviewWorktree = false;
    let sawNestedPluginDeps = false;
    let reviewerDelegationCalls = 0;

    const port = {
        catalog: async () => [DSH_MODEL, CODEX_MODEL],
        dispose() {},
        async run(model, prompt, _signal, work) {
            if (model.agent === 'codex' && work && !work.readOnly) {
                sawNestedPluginDeps = existsSync(join(work.workspace, 'mobile', 'plugins', 'local-plugin', 'node_modules', 'dep', 'index.js'));
                // Generate a ~72 KiB real diff (previously blew up at 48 KiB!)
                const bigBody = Array.from({ length: 1200 }, (_, i) => `export const line_${i} = "${'abcdef0123456789'.repeat(3)}_${i}";`).join('\n') + '\n';
                writeFileSync(join(work.workspace, 'src', 'large-feature.js'), bigBody);
                writeFileSync(join(work.workspace, 'src', 'app.js'), 'export const version = 2;\n');
                return 'Implemented large-feature.js (~72 KiB) and bumped version.';
            }
            if (model.agent === 'codex' && work?.readOnly === true) {
                sawReadOnlyReviewWorktree = existsSync(join(work.workspace, 'src', 'large-feature.js'));
                return 'Verified large-feature.js directly inside read-only worktree.';
            }
            if (prompt.includes('设计和拆分')) {
                sawRepoContext = prompt.includes('"repoContext"') && prompt.includes('"referencedPaths"') && prompt.includes('src/app.js');
                return 'Modify src/app.js and add src/large-feature.js.';
            }
            if (prompt.includes('你是 Coder')) {
                return JSON.stringify({ action: 'codex', instruction: 'Create src/large-feature.js and update src/app.js.' });
            }
            if (prompt.includes('你是独立 Reviewer') && prompt.includes('字段 action')) {
                reviewerDelegationCalls += 1;
                return JSON.stringify({ action: 'codex', instruction: 'Inspect src/large-feature.js in read-only worktree.' });
            }
            return JSON.stringify({ verdict: 'pass', findings: [{ file: 'src/large-feature.js', conclusion: 'Verified in worktree.' }] });
        },
    };

    const flow = createTaskOrchestration({
        file: join(root, 'orch.json'),
        memory,
        port,
        patchStore,
        workspacePath: async () => repo,
        inventory: () => ({ teams: [{ id: 'team', workspaceId: 'ws-1', members: MEMBERS }] }),
    });
    t.after(() => { flow.dispose(); rooms.close(); memory.store.close(); rmSync(root, { recursive: true, force: true }); });

    const card = { id: 'ticket-large', title: 'Implement large module', description: 'Update src/app.js and add src/large-feature.js' };
    const prepared = flow.prepare({
        leaderId: 'team/lead', workspaceId: 'ws-1', choice: 'template', templateId: 'development',
        plan: { templateId: 'development', members: { coder: 'team/coder', reviewer: 'team/reviewer' } },
    });
    flow.attach('host', card.id, prepared);
    const room = rooms.ensure('host', card, 'ws-1', 'owner-1');
    flow.start('host', card, taskRoomAudit(rooms, room, 'start'));

    const settled = await waitUntil(() => {
        const v = flow.view('host', card.id);
        return v && v.state !== 'running' ? v : undefined;
    });

    assert.equal(settled.state, 'done', settled.error);
    assert.equal(sawRepoContext, true);
    assert.equal(sawNestedPluginDeps, true);
    assert.equal(sawReadOnlyReviewWorktree, true);
    assert.equal(reviewerDelegationCalls, 1);

    const page = await rooms.page(room.id, { limit: 60 });
    const patchEvent = page.records.find(r => r.phase === 'development-patch');
    assert.ok(patchEvent);
    // Room event itself stays compact (<32 KiB) while referencing durable artifact
    assert.ok(Buffer.byteLength(patchEvent.text, 'utf8') < 32 * 1024);
    const parsedHeader = parsePatchArtifactHeader(patchEvent.text);
    assert.ok(parsedHeader?.meta?.stored === true);
    assert.ok(parsedHeader.meta.bytes > 60 * 1024);
    assert.equal(parsedHeader.meta.fileCount, 2);

    // Resolve full verified patch from patchStore and apply with selective commitMessage
    const full = await findLatestPatch(rooms, room.id, settled.development.digest, patchStore);
    assert.ok(Buffer.byteLength(full.text, 'utf8') > 60 * 1024);
    assert.equal(resolvePatchText(patchEvent.text, patchEvent.ref, patchStore).text, full.text);

    const applied = await applyDevelopmentPatch(repo, full.text, AbortSignal.timeout(15_000), {
        commitMessage: 'feat: apply ticket-large patch',
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.committed, true);
    assert.ok(applied.commitHash);
    assert.equal(readFileSync(join(repo, 'src', 'app.js'), 'utf8'), 'export const version = 2;\n');
    assert.equal(existsSync(join(repo, 'src', 'large-feature.js')), true);

    // Verify commit only included touched files, NOT unrelated-dirty.txt
    const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(committedFiles, ['src/app.js', 'src/large-feature.js']);
    assert.match(git(['status', '--porcelain']), /\?\? unrelated-dirty\.txt/);
});

test('revise seeds previous unapplied patch into fresh worktree and marshal_task executes full lifecycle', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-revise-tool-'));
    const { repo, git } = initTempRepo(root);
    const board = createLocalBoard(join(root, 'board.json'));
    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'rooms.sqlite')), deviceId: 'dev-1' });
    const patchStore = createPatchStore(join(root, 'patches'));

    let codexRunCount = 0;
    let secondRunSawPreloadedFile = false;
    let reviewerDelegationFails = 0;

    const port = {
        catalog: async () => [DSH_MODEL, CODEX_MODEL],
        dispose() {},
        async run(model, prompt, _signal, work) {
            if (model.agent === 'codex' && work && !work.readOnly) {
                codexRunCount += 1;
                if (codexRunCount === 1) {
                    writeFileSync(join(work.workspace, 'src', 'feature.js'), 'export const step = 1;\n');
                    return 'Round 1 wrote src/feature.js';
                }
                secondRunSawPreloadedFile = existsSync(join(work.workspace, 'src', 'feature.js'))
                    && readFileSync(join(work.workspace, 'src', 'feature.js'), 'utf8').includes('step = 1');
                writeFileSync(join(work.workspace, 'src', 'feature.js'), 'export const step = 2;\n');
                return 'Round 2 incrementally updated src/feature.js to step = 2';
            }
            if (model.agent === 'codex') return 'Read-only check ok';
            if (prompt.includes('设计和拆分')) return 'Implement src/feature.js.';
            if (prompt.includes('你是 Coder')) {
                return JSON.stringify({ action: 'codex', instruction: 'Update src/feature.js.' });
            }
            if (prompt.includes('你是独立 Reviewer') && prompt.includes('字段 action')) {
                // Force Reviewer delegation parse failure twice on run 1 to test graceful fallback
                if (codexRunCount === 1 && reviewerDelegationFails < 2) {
                    reviewerDelegationFails += 1;
                    return 'not valid json at all';
                }
                return JSON.stringify({ action: 'continue', instruction: 'Direct verdict.' });
            }
            if (codexRunCount === 1) {
                return JSON.stringify({ verdict: 'blocked', findings: 'Need step = 2 before shipping.' });
            }
            return JSON.stringify({ verdict: 'pass', findings: 'step = 2 verified.' });
        },
    };

    // Wrap board to prove orchestration is attached BEFORE board.apply('create') runs (race fix!)
    let observedPreAttachedWorkflow = false;
    const flow = createTaskOrchestration({
        file: join(root, 'orch.json'),
        memory,
        port,
        patchStore,
        workspacePath: async () => repo,
        inventory: () => ({ teams: [{ id: 'team', workspaceId: 'ws-1', members: MEMBERS }] }),
        onState: async (_source, taskId, status) => {
            try { await board.apply('move-' + Date.now() + Math.random(), { kind: 'move', taskId, status }, 'marshal:test'); } catch { /* ignore */ }
        },
    });
    const wrappedBoard = {
        snapshot: () => board.snapshot(),
        async apply(reqId, action, actor) {
            if (action.kind === 'create' && action.id) {
                observedPreAttachedWorkflow = Boolean(flow.target('local', action.id));
            }
            return board.apply(reqId, action, actor);
        },
    };
    t.after(() => { flow.dispose(); rooms.close(); memory.store.close(); rmSync(root, { recursive: true, force: true }); });

    const steeredCalls = [];
    const controller = createTaskToolController({
        getBoard: () => wrappedBoard,
        boardSource: () => 'local',
        initiator: 'marshal:test',
        ownerId: 'owner-1',
        orchestration: flow,
        rooms,
        patchStore,
        workspacePath: async () => repo,
        readInventory: () => ({ teams: [{ id: 'team', workspaceId: 'ws-1', members: MEMBERS }] }),
        readWorkspaces: () => [{ id: 'ws-1', title: 'Test Repo', path: repo }],
        steerResidentSession: async (sid, text) => { steeredCalls.push({ sid, text }); return true; },
    });

    const tools = agentToolDefinitions({ agents: {}, service: {}, tasks: controller });
    const taskTool = tools.find(tool => tool.name === 'marshal_task');
    assert.ok(taskTool);
    assert.equal(taskTool.parameters.type, 'object');
    assert.ok(taskTool.parameters.properties.action);

    const execTask = async args => JSON.parse(await taskTool.execute(args));

    const cat = await execTask({ action: 'catalog' });
    assert.ok(cat.templates.some(tpl => tpl.id === 'development'));
    assert.equal(cat.agents.length, 3);

    const created = await execTask({
        action: 'create',
        title: 'Build feature.js',
        description: 'Add src/feature.js exporting step',
        workspaceId: 'ws-1',
        orchestration: {
            leaderId: 'team/lead',
            choice: 'template',
            templateId: 'development',
            plan: { templateId: 'development', members: { coder: 'team/coder', reviewer: 'team/reviewer' } },
        },
    });
    assert.equal(observedPreAttachedWorkflow, true, 'orchestration must be attached before board.apply(create)');
    const taskId = created.task.id;

    await execTask({ action: 'run', taskId });
    await waitUntil(() => {
        const v = flow.view('local', taskId);
        return v && v.state === 'review-blocked' ? v : undefined;
    });
    assert.equal(reviewerDelegationFails, 2, 'reviewer delegation should retry once and gracefully fall back without losing patch');

    const patch1 = await execTask({ action: 'patch', taskId });
    assert.match(patch1.patch, /export const step = 1;/);

    const revised = await execTask({ action: 'revise', taskId, text: '请把 step 改成 2' });
    assert.equal(revised.seededPreviousPatch, true);

    await waitUntil(() => {
        const v = flow.view('local', taskId);
        return v && v.state === 'done' ? v : undefined;
    });
    assert.equal(secondRunSawPreloadedFile, true, 'revise worktree must preload previous unapplied patch');

    const confirmed = await execTask({
        action: 'confirm',
        taskId,
        applyPatch: true,
        commitMessage: 'feat: land feature.js step=2',
        note: '验收通过',
    });
    assert.equal(confirmed.patchApplied, true);
    assert.equal(confirmed.committed, true);
    assert.equal(readFileSync(join(repo, 'src', 'feature.js'), 'utf8'), 'export const step = 2;\n');
    assert.match(git(['log', '-1', '--oneline']), /feat: land feature\.js step=2/);
    assert.equal(confirmed.task.status, 'done');
});

test('handed-off room chat routes directly to steerResidentSession instead of text-only respond()', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-resident-steer-'));
    const board = createLocalBoard(join(root, 'board.json'));
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'rooms.sqlite')), deviceId: 'dev-1' });
    t.after(() => { rooms.close(); rmSync(root, { recursive: true, force: true }); });

    await board.apply('c1', { kind: 'create', id: 'card-1', input: { title: 'CAD Task', description: 'Run script', workspaceId: 'ws-1' } }, 'marshal:test');
    const room = rooms.ensure('local', { id: 'card-1', title: 'CAD Task' }, 'ws-1', 'owner-1');

    let respondCalls = 0;
    const steered = [];
    const fakeOrch = {
        target: () => ({ workspaceId: 'ws-1', state: 'handed-off', sessionId: 'sess-real-1', leaderName: '丞相' }),
        view: () => ({ workspaceId: 'ws-1', state: 'handed-off', sessionId: 'sess-real-1', leaderName: '丞相' }),
        assertIdle() {},
        respond: async () => { respondCalls += 1; return { actor: '刑部尚书', text: 'text-only discussion reply' }; },
    };

    const routeBundle = createTaskRoomRoutes({
        exact: () => ({}),
        write: () => {},
        readBody: async () => ({}),
        authenticate: () => ({ ok: true, session: { owner: true, ownerId: 'owner-1' } }),
        allowed: () => true,
        auth: { loadLedger: () => ({}) },
        rooms,
        orchestration: fakeOrch,
        getBoard: () => board,
        boardSource: () => 'local',
        getInitiator: () => 'test',
        steerResidentSession: async (sid, text) => { steered.push({ sid, text }); return true; },
    });

    const access = { ok: true, session: { owner: true, ownerId: 'owner-1' } };
    const r1 = await routeBundle.sendMessage(room, { text: '马上执行生成脚本并汇报结果' }, access);
    assert.equal(r1.steeredResident, true);
    assert.equal(steered.length, 1);
    assert.equal(steered[0].sid, 'sess-real-1');
    assert.match(steered[0].text, /马上执行生成脚本/);
    assert.equal(respondCalls, 0);

    // Explicitly @mentioning another member still routes to discussion respond()
    const r2 = await routeBundle.sendMessage(room, { text: '@刑部尚书 帮忙看一下风险' }, access);
    assert.equal(r2.steeredResident, undefined);
    assert.equal(respondCalls, 1);
});

test('DiscussionError codes map to clear Chinese diagnostics in orchestration failure state', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-err-diag-'));
    const { repo } = initTempRepo(root);
    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'rooms.sqlite')), deviceId: 'dev-1' });
    t.after(() => { flow.dispose(); rooms.close(); memory.store.close(); rmSync(root, { recursive: true, force: true }); });

    const port = {
        catalog: async () => [DSH_MODEL, CODEX_MODEL],
        dispose() {},
        async run() { throw new DiscussionError('size-limit'); },
    };
    const flow = createTaskOrchestration({
        file: join(root, 'orch.json'),
        memory,
        port,
        workspacePath: async () => repo,
        inventory: () => ({ teams: [{ id: 'team', workspaceId: 'ws-1', members: MEMBERS }] }),
    });
    const card = { id: 'err-card', title: 'Error diag test' };
    flow.attach('host', card.id, flow.prepare({
        leaderId: 'team/lead', workspaceId: 'ws-1', choice: 'template', templateId: 'development',
        plan: { templateId: 'development', members: { coder: 'team/coder', reviewer: 'team/reviewer' } },
    }));
    const room = rooms.ensure('host', card, 'ws-1', 'owner-1');
    flow.start('host', card, taskRoomAudit(rooms, room, 'start'));

    const settled = await waitUntil(() => {
        const v = flow.view('host', card.id);
        return v && v.state === 'failed' ? v : undefined;
    });
    assert.match(settled.error, /16 KiB/);
});

test('Bug #9: all registered Marshal agent tool schemas stay under 1950 bytes for eager MCP loaders', async () => {
    const tools = agentToolDefinitions({
        agents: {},
        service: {},
        tasks: {
            catalog: async () => ({}), list: async () => ({}), get: async () => ({}),
            create: async () => ({}), plan: async () => ({}), run: async () => ({}),
            roomRead: async () => ({}), roomSend: async () => ({}), patch: async () => ({}),
            revise: async () => ({}), confirm: async () => ({}),
        },
    });
    for (const tool of tools) {
        const bytes = Buffer.byteLength(JSON.stringify({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        }), 'utf8');
        assert.ok(bytes < 1950, `${tool.name} schema is ${bytes} bytes (>= 1950 bytes risks MCP eager cutoff)`);
    }
});

test('Bug #10: resolveOwnerId unwraps desktopOwner {caller, install} object, creates task room, and patch/confirm fall back to patchStore without room', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-bug10-'));
    const { repo } = initTempRepo(root);
    const board = createLocalBoard(join(root, 'board.json'));
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'rooms.sqlite')), deviceId: 'dev-1' });
    const patchStore = createPatchStore(root);
    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const flow = createTaskOrchestration({
        file: join(root, 'orch.json'),
        memory,
        port: { catalog: async () => [DSH_MODEL, CODEX_MODEL], dispose() {}, async run() { return 'ok'; } },
        workspacePath: async () => repo,
        inventory: () => ({ teams: [{ id: 'team', workspaceId: 'ws-1', members: MEMBERS }] }),
        patchStore,
    });
    t.after(() => { flow.dispose(); rooms.close(); memory.store.close(); rmSync(root, { recursive: true, force: true }); });

    const controller = createTaskToolController({
        getBoard: () => board,
        boardSource: () => 'host',
        initiator: 'marshal:dev-1',
        // Exact object shape returned by desktopOwner() in mount.js
        resolveOwnerId: async () => ({ caller: 'owner-hash-abc', install: 'install-hash-xyz' }),
        orchestration: flow,
        rooms,
        patchStore,
        workspacePath: async () => repo,
        readInventory: () => ({ teams: [{ id: 'team', workspaceId: 'ws-1', members: MEMBERS }] }),
        readWorkspaces: () => [{ id: 'ws-1', title: 'repo', path: repo }],
    });

    const created = await controller.create({
        title: 'Room creation unwrap test',
        description: 'Verify task room is created cleanly',
        workspaceId: 'ws-1',
        orchestration: {
            leaderId: 'team/lead',
            choice: 'template',
            templateId: 'development',
            plan: { templateId: 'development', members: { coder: 'team/coder', reviewer: 'team/reviewer' } },
        },
    });
    assert.ok(created.roomId, 'create() must return a real roomId when resolveOwnerId returns {caller, install}');
    assert.equal(rooms.local(created.roomId)?.ownerId, 'owner-hash-abc');

    // Also verify patch() & confirm(applyPatch=true) fall back cleanly to patchStore when no room exists
    const noRoomCtrl = createTaskToolController({
        getBoard: () => board,
        boardSource: () => 'host',
        initiator: 'marshal:dev-1',
        ownerId: 'owner-hash-abc',
        orchestration: flow,
        rooms: undefined,
        patchStore,
        workspacePath: async () => repo,
    });
    const patchText = [
        'diff --git a/src/from-store.js b/src/from-store.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/from-store.js',
        '@@ -0,0 +1 @@',
        '+export const fallback = true;',
        '',
    ].join('\n');
    const saved = patchStore.save(patchText);
    const snap = await board.apply('c-noroom', { kind: 'create', id: 'noroom-1', input: { title: 'No room card', workspaceId: 'ws-1' } }, 'marshal:dev-1');
    assert.ok(snap.tasks.some(x => x.id === 'noroom-1'));
    const readBack = await noRoomCtrl.patch({ taskId: 'noroom-1', digest: saved.digest });
    assert.match(readBack.patch, /fallback = true/);
    const confirmed = await noRoomCtrl.confirm({ taskId: 'noroom-1', digest: saved.digest, applyPatch: true });
    assert.equal(confirmed.patchApplied, true);
    assert.equal(readFileSync(join(repo, 'src', 'from-store.js'), 'utf8'), 'export const fallback = true;\n');
});

test('Bugs #11 & #13: freezePatch excludes .npm/Library cache junk and coding timeout salvages worktree patch into review-blocked', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-bug11-13-'));
    const { repo } = initTempRepo(root);
    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'rooms.sqlite')), deviceId: 'dev-1' });
    const patchStore = createPatchStore(root);
    t.after(() => { flow.dispose(); rooms.close(); memory.store.close(); rmSync(root, { recursive: true, force: true }); });

    const port = {
        catalog: async () => [DSH_MODEL, CODEX_MODEL],
        dispose() {},
        async run(model, prompt, _signal, work) {
            if (model.agent === 'codex' && work) {
                // Simulate npm/macOS cache pollution inside worktree + real code written before timeout
                mkdirSync(join(work.workspace, '.npm', '_logs'), { recursive: true });
                writeFileSync(join(work.workspace, '.npm', '_logs', 'debug.log'), 'noisy npm cache\n');
                mkdirSync(join(work.workspace, 'Library', 'Caches'), { recursive: true });
                writeFileSync(join(work.workspace, 'Library', 'Caches', 'tmp.bin'), 'noisy mac cache\n');
                writeFileSync(join(work.workspace, 'src', 'salvaged.js'), 'export const salvaged = 42;\n');
                throw new DiscussionError('cancelled');
            }
            if (prompt.includes('设计和拆分')) return 'Implement src/salvaged.js';
            if (prompt.includes('你是 Coder')) return JSON.stringify({ action: 'codex', instruction: 'Write src/salvaged.js' });
            throw new Error('unexpected prompt: ' + prompt.slice(0, 100));
        },
    };
    const flow = createTaskOrchestration({
        file: join(root, 'orch.json'),
        memory,
        port,
        workspacePath: async () => repo,
        inventory: () => ({ teams: [{ id: 'team', workspaceId: 'ws-1', members: MEMBERS }] }),
        patchStore,
    });
    const card = { id: 'salvage-card', title: 'Timeout salvage test' };
    flow.attach('host', card.id, flow.prepare({
        leaderId: 'team/lead', workspaceId: 'ws-1', choice: 'template', templateId: 'development',
        plan: { templateId: 'development', members: { coder: 'team/coder', reviewer: 'team/reviewer' } },
    }));
    const room = rooms.ensure('host', card, 'ws-1', 'owner-1');
    flow.start('host', card, taskRoomAudit(rooms, room, 'start'));

    const settled = await waitUntil(() => {
        const v = flow.view('host', card.id);
        return v && v.state !== 'running' ? v : undefined;
    });
    assert.equal(settled.state, 'review-blocked', 'timeout with worktree edits should salvage into review-blocked instead of discarding work');
    assert.ok(settled.development?.digest, 'salvaged patch digest must be recorded on workflow');
    const salvagedPatch = patchStore.read(settled.development.digest);
    assert.ok(salvagedPatch, 'salvaged patch must exist in patchStore');
    assert.match(salvagedPatch, /src\/salvaged\.js/);
    assert.doesNotMatch(salvagedPatch, /\.npm\/_logs|Library\/Caches/, 'runtime cache directories must be excluded from frozen patch');
});
