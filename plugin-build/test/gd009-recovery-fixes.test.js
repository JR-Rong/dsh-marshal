import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDiscussionPort } from '../lib/src/discussions/ports.js';
import { createAgentMemoryService } from '../lib/src/memory/agent-memory.js';
import { createTaskRoomStore } from '../lib/src/groups/task-room-store.js';
import { createTaskRooms } from '../lib/src/groups/task-rooms.js';
import { taskRoomAudit } from '../lib/src/groups/task-room-routes.js';
import { createTaskOrchestration } from '../lib/src/groups/task-orchestration.js';
import { linkWorkspaceNodeModules } from '../lib/src/groups/task-development.js';
import { decodeAgentTrace, encodeAgentTrace, stripAgentTrace } from '../lib/src/groups/agent-trace.js';
import { syncResidentSessionToRoom } from '../lib/src/groups/session-room-sync.js';
import { readFileSync } from 'node:fs';

const waitUntil = async (fn, ms = 4000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const res = await fn();
        if (res) return res;
        await sleep(25);
    }
    throw new Error('timed out waiting for orchestration condition');
};

test('createDiscussionPort uses >=16384 maxTokens and retries once on length truncation (response-incomplete)', async t => {
    const prepareCalls = [];
    let streamCount = 0;
    const llm = {
        listProviders: () => [{ id: 'deepseek-account' }],
        listModels: async () => [{ id: 'deepseek-flash' }],
        resolveModelInfo: async () => ({
            maxOutputTokens: 16384,
            reasoning: { efforts: [{ id: 'medium' }, { id: 'high' }] },
        }),
        prepareCall: async (cfg) => {
            prepareCalls.push(cfg);
            return {
                config: cfg,
                async *stream({ messages }) {
                    streamCount += 1;
                    if (streamCount === 1) {
                        yield { type: 'text-delta', text: '{"verdict":"rev' };
                        yield { type: 'finish', reason: { kind: 'length' } };
                        return;
                    }
                    assert.match(messages[0].content[0].text, /系统重要提示/);
                    yield { type: 'text-delta', text: '{"verdict":"pass","findings":"ok"}' };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                },
            };
        },
    };
    const port = createDiscussionPort({ agents: ['dsh'], llm });
    t.after(() => port.dispose());
    const models = await port.catalog();
    assert.equal(models.length, 1);
    const ac = new AbortController();
    const out = await port.run(models[0], 'Return strict JSON verdict.', ac.signal, undefined, 'high');
    assert.equal(out, '{"verdict":"pass","findings":"ok"}');
    assert.equal(prepareCalls.length, 2);
    assert.equal(prepareCalls[0].maxTokens, 16384);
    assert.equal(prepareCalls[0].reasoningEffort, 'high');
    assert.equal(prepareCalls[1].maxTokens, 24576);
    assert.equal(prepareCalls[1].reasoningEffort, 'medium');
});

test('createDiscussionPort falls back to 8192 maxTokens when provider rejects 16384', async t => {
    const seenBudgets = [];
    const llm = {
        listProviders: () => [{ id: 'strict-provider' }],
        listModels: async () => [{ id: 'capped-model' }],
        prepareCall: async (cfg) => {
            seenBudgets.push(cfg.maxTokens);
            if (cfg.maxTokens > 8192) throw new Error('max_tokens must be <= 8192');
            return {
                config: cfg,
                async *stream() {
                    yield { type: 'text-delta', text: 'fallback-ok' };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                },
            };
        },
    };
    const port = createDiscussionPort({ agents: ['dsh'], llm });
    t.after(() => port.dispose());
    const [model] = await port.catalog();
    const out = await port.run(model, 'ping', new AbortController().signal);
    assert.equal(out, 'fallback-ok');
    assert.deepEqual(seenBudgets, [16384, 8192]);
});

test('linkWorkspaceNodeModules symlinks root and subdir node_modules during coding and unlinks cleanly before freezePatch', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-worktree-nm-'));
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'mobile', 'src'), { recursive: true });
    mkdirSync(join(repo, 'node_modules', 'root-dep'), { recursive: true });
    mkdirSync(join(repo, 'mobile', 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'root-dep', 'index.js'), 'export default 1;\n');
    writeFileSync(join(repo, 'mobile', 'node_modules', 'vitest', 'index.js'), 'export default 2;\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(repo, 'mobile', 'src', 'app.ts'), 'export const online = true;\n');

    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'init']);

    // Direct unit check on linkWorkspaceNodeModules
    const fakeWt = join(root, 'fake-wt');
    mkdirSync(join(fakeWt, 'mobile'), { recursive: true });
    const unlinkFn = await linkWorkspaceNodeModules(repo, fakeWt);
    assert.equal(lstatSync(join(fakeWt, 'node_modules')).isSymbolicLink(), true);
    assert.equal(lstatSync(join(fakeWt, 'mobile', 'node_modules')).isSymbolicLink(), true);
    await unlinkFn();
    assert.equal(existsSync(join(fakeWt, 'node_modules')), false);
    assert.equal(existsSync(join(fakeWt, 'mobile', 'node_modules')), false);

    // End-to-end check inside runTaskDevelopment + Reviewer compact retry + review-blocked preservation
    const members = [
        { id: 'lead', name: '丞相' },
        { id: 'coder', name: '工部尚书', permission: 'workspace-write' },
        { id: 'reviewer', name: '刑部尚书', permission: 'read-only' },
    ];
    const dsh = { id: 'dsh:fixture:flash', agent: 'dsh', provider: 'fixture', model: 'flash' };
    const codex = { id: 'codex:openai:sol', agent: 'codex', provider: 'openai', model: 'sol', work: true };
    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'rooms.sqlite')), deviceId: 'dev-1' });

    let sawMountedDepsInWorktree = false;
    let reviewerVerdictAttempts = 0;
    const port = {
        catalog: async () => [dsh, codex],
        dispose() {},
        async run(model, prompt, _signal, work) {
            if (model.agent === 'codex' && work && !work.readOnly) {
                sawMountedDepsInWorktree =
                    existsSync(join(work.workspace, 'node_modules', 'root-dep', 'index.js')) &&
                    existsSync(join(work.workspace, 'mobile', 'node_modules', 'vitest', 'index.js'));
                writeFileSync(join(work.workspace, 'mobile', 'src', 'app.ts'), 'export const online = false;\n');
                writeFileSync(join(work.workspace, 'mobile', 'src', 'offline-banner.ts'), 'export const banner = "offline";\n');
                return 'Implemented offline banner and ran vitest via mounted node_modules.';
            }
            if (model.agent === 'codex') {
                assert.equal(work?.readOnly, true);
                assert.equal(existsSync(join(work.workspace, 'mobile', 'node_modules', 'vitest', 'index.js')), true);
                return '1. mobile/src/offline-banner.ts: verify retry button state when reconnected.';
            }
            if (prompt.includes('设计和拆分')) return 'Update mobile offline banner and add tests.';
            if (prompt.includes('你是 Coder')) return JSON.stringify({ action: 'codex', instruction: 'Implement offline banner.' });
            if (prompt.includes('字段 action')) return JSON.stringify({ action: 'codex', instruction: 'Check offline banner edge cases.' });
            if (prompt.includes('你是独立 Reviewer')) {
                reviewerVerdictAttempts += 1;
                if (reviewerVerdictAttempts === 1) {
                    assert.doesNotMatch(prompt, /上次裁决因输出超长截断/);
                } else {
                    assert.match(prompt, /上次裁决因输出超长截断/);
                    assert.match(prompt, /固定补丁（摘要）/);
                }
                throw Object.assign(new Error('response-incomplete'), { code: 'response-incomplete' });
            }
            throw new Error('unexpected prompt: ' + prompt.slice(0, 80));
        },
    };

    const stateChanges = [];
    const flow = createTaskOrchestration({
        file: join(root, 'orchestration.json'),
        memory,
        port,
        workspacePath: async () => repo,
        inventory: () => ({ teams: [{ id: 'team', workspaceId: 'ws-mobile', members }] }),
        onState: async (_source, _taskId, status) => { stateChanges.push(status); },
    });
    t.after(() => { flow.dispose(); rooms.close(); memory.store.close(); rmSync(root, { recursive: true, force: true }); });

    const card = { id: 'gd-00009', title: '[GD-00009] 开发 Marshal 的移动端 node应用' };
    const prepared = flow.prepare({ leaderId: 'team/lead', workspaceId: 'ws-mobile', choice: 'template', templateId: 'development' });
    flow.attach('host', card.id, {
        ...prepared,
        planConfirmed: true,
        plan: {
            templateId: 'development',
            groupTemplate: 'delivery',
            codeWork: true,
            members: { coder: 'team/coder', reviewer: 'team/reviewer' },
            codex: { coding: 'auto', review: 'auto' },
        },
    });
    const room = rooms.ensure('host', card, 'ws-mobile', 'owner-1');
    const audit = taskRoomAudit(rooms, room, 'start');
    flow.start('host', card, audit);

    const settled = await waitUntil(() => {
        const v = flow.view('host', card.id);
        return v && v.state !== 'running' ? v : undefined;
    });

    assert.equal(sawMountedDepsInWorktree, true);
    assert.equal(reviewerVerdictAttempts, 2);
    assert.equal(settled.state, 'review-blocked');
    assert.equal(settled.reviewReason, 'review-blocked');
    assert.ok(settled.development?.digest);
    assert.match(settled.reviewSummary ?? '', /offline-banner\.ts/);
    assert.deepEqual(stateChanges, ['running', 'review']);

    const page = await rooms.page(room.id, { limit: 50 });
    const patchEvent = page.records.find(r => r.phase === 'development-patch');
    assert.ok(patchEvent);
    assert.match(patchEvent.text, /offline-banner\.ts/);
    assert.doesNotMatch(patchEvent.text, /node_modules/);

    // Verify syncStatus transitions cleanly across manual moves / confirmations
    flow.syncStatus('host', card.id, 'done');
    assert.equal(flow.view('host', card.id).state, 'done');
    flow.syncStatus('host', card.id, 'todo');
    assert.equal(flow.view('host', card.id).state, 'ready');
    flow.syncStatus('host', card.id, 'review', {
        development: settled.development,
        reviewReason: 'review-blocked',
        reviewSummary: 'Recovered review summary',
    });
    assert.equal(flow.view('host', card.id).state, 'review-blocked');
    assert.equal(flow.view('host', card.id).development.digest, settled.development.digest);
});

test('agent thinking & processing steps stream live and persist inside each agent bubble (orchestration + resident session)', async t => {
    // 1. Trace codec roundtrip + HTML comment safety
    const rawWithArrow = encodeAgentTrace('Final Markdown conclusion.', {
        thinking: 'Checking a --> b edge case and reasoning step.',
        steps: [{ label: 'bash: npm test', status: 'done', detail: 'exit 0' }],
        durationMs: 2450,
        model: 'deepseek-flash',
    });
    assert.equal(stripAgentTrace(rawWithArrow), 'Final Markdown conclusion.');
    const decoded = decodeAgentTrace(rawWithArrow);
    assert.equal(decoded.text, 'Final Markdown conclusion.');
    assert.match(decoded.trace.thinking, /a --> b/);
    assert.equal(decoded.trace.steps[0].label, 'bash: npm test');

    // 2. createDiscussionPort streams reasoning-delta + retry steps to onProgress
    const progressEvents = [];
    const llm = {
        listProviders: () => [{ id: 'deepseek-account' }],
        listModels: async () => [{ id: 'deepseek-flash' }],
        prepareCall: async cfg => ({
            config: cfg,
            async *stream() {
                yield { type: 'reasoning-delta', text: 'First let us inspect the CAD constraints...' };
                yield { type: 'text-delta', text: 'All 1000 variants verified.' };
                yield { type: 'finish', reason: { kind: 'stop' } };
            },
        }),
    };
    const dshPort = createDiscussionPort({ agents: ['dsh'], llm });
    t.after(() => dshPort.dispose());
    const [dshModel] = await dshPort.catalog();
    const replyText = await dshPort.run(dshModel, 'check', new AbortController().signal, undefined, undefined, undefined, p => {
        progressEvents.push(p);
    });
    assert.equal(replyText, 'All 1000 variants verified.');
    assert.ok(progressEvents.some(p => p.thinking?.includes('inspect the CAD constraints')));

    // 3. Live orchestration bubble + persisted trace in respond()
    const root = mkdtempSync(join(tmpdir(), 'marshal-live-bubbles-'));
    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'rooms.sqlite')), deviceId: 'dev-1' });
    let observedLiveDuringTurn = [];
    let flow;
    const slowPort = {
        catalog: async () => [dshModel],
        dispose() {},
        async run(_m, _p, _s, _w, _r, _u, onProgress) {
            onProgress?.({
                text: 'Partial reply...',
                durationMs: 120,
                thinking: 'Evaluating cluster 004 tolerances...',
                steps: [{ label: '读取工单上下文与历史交接', status: 'done' }],
            });
            observedLiveDuringTurn = flow.live('host', 'gd-00010');
            return 'Cluster 004 ready.';
        },
    };
    flow = createTaskOrchestration({
        file: join(root, 'orch.json'),
        memory,
        port: slowPort,
        inventory: () => ({ teams: [{ id: 'team', workspaceId: 'ws-cad', members: [{ id: 'lead', name: '丞相' }] }] }),
    });
    t.after(() => { flow.dispose(); rooms.close(); memory.store.close(); rmSync(root, { recursive: true, force: true }); });

    const prepared = flow.prepare({ leaderId: 'team/lead', workspaceId: 'ws-cad', choice: 'none' });
    flow.attach('host', 'gd-00010', prepared);
    const chatRes = await flow.respond('host', 'gd-00010', '{"messages":[]}', new AbortController().signal, { mentions: ['丞相'] });
    assert.equal(observedLiveDuringTurn.length, 1);
    assert.equal(observedLiveDuringTurn[0].actor, '丞相');
    assert.match(observedLiveDuringTurn[0].thinking, /cluster 004/);
    assert.equal(flow.live('host', 'gd-00010').length, 0);
    const persistedChat = decodeAgentTrace(chatRes.replies[0].text);
    assert.equal(persistedChat.text, 'Cluster 004 ready.');
    assert.match(persistedChat.trace.thinking, /cluster 004/);

    // 4. syncResidentSessionToRoom projects active & completed resident DSH session steps into the room
    const cadRoom = rooms.ensure('host', { id: 'gd-00010', title: '[GD-00010] CAD 扩展' }, 'ws-cad', 'owner-1');
    let settledStatus = '';
    let includeTurnEnd = false;
    const mockSurface = {
        activeTurn: async () => (includeTurnEnd ? undefined : { turn: 1 }),
        history: async () => ({
            events: [
                { seq: 10, type: 'step/start', data: { turn: 1, step: 97 } },
                { seq: 11, type: 'assistant/message', data: { turn: 1, step: 97, message: { content: [{ type: 'reasoning', text: 'wall_thinned fixed by dropping groove width params.' }] } } },
                { seq: 12, type: 'tool/call', data: { turn: 1, step: 97, callId: 'c1', name: 'run_code', arguments: '{}' } },
                { seq: 13, type: 'tool/ptc-dispatch-start', data: { rootCallId: 'c1', subCallId: 'c1:1', name: 'bash', arguments: { description: 'Pilot production 40 variants' } } },
                ...(includeTurnEnd ? [
                    { seq: 14, type: 'tool/result', data: { turn: 1, step: 97, message: { toolCallId: 'c1', content: [{ type: 'text', text: '40/40 passed' }] } } },
                    { seq: 15, type: 'assistant/message', data: { turn: 1, step: 98, message: { content: [{ type: 'text', text: '已完成全部簇每簇 1000 个零件生成并通过 100% 审查。' }] } } },
                    { seq: 16, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
                ] : []),
            ],
        }),
    };

    const liveResident = await syncResidentSessionToRoom({
        surface: mockSurface,
        rooms,
        room: cadRoom,
        sessionId: 'session-09397328-f294-4c04-b324-c5e64d582d48',
        actor: '丞相',
        runId: '026bde8c-e36c-4894-84ea-e24472d22f82',
        workflowState: 'handed-off',
    });
    assert.ok(liveResident);
    assert.equal(liveResident.actor, '丞相');
    assert.match(liveResident.thinking, /wall_thinned fixed/);
    assert.ok(liveResident.steps.some(s => s.label.includes('Pilot production 40 variants') && s.status === 'running'));

    includeTurnEnd = true;
    const afterEnd = await syncResidentSessionToRoom({
        surface: mockSurface,
        rooms,
        room: cadRoom,
        sessionId: 'session-09397328-f294-4c04-b324-c5e64d582d48',
        actor: '丞相',
        runId: '026bde8c-e36c-4894-84ea-e24472d22f82',
        workflowState: 'handed-off',
        onTurnCompleted: async reason => { settledStatus = reason; },
    });
    assert.equal(afterEnd, undefined);
    assert.equal(settledStatus, 'completed');
    const cadPage = await rooms.page(cadRoom.id, { limit: 20 });
    const agentMsg = cadPage.records.find(r => r.kind === 'agent' && r.actor === '丞相');
    assert.ok(agentMsg);
    const decodedCad = decodeAgentTrace(agentMsg.text);
    assert.match(decodedCad.text, /1000 个零件/);
    assert.match(decodedCad.trace.thinking, /wall_thinned fixed/);
    assert.ok(decodedCad.trace.steps.some(s => s.label.includes('Pilot production 40 variants') && s.status === 'done'));

    // 5. Verify client bundle includes AgentTracePanel and liveBubbles rendering
    const clientCode = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
    assert.ok(clientCode.includes('function AgentTracePanel'));
    assert.ok(clientCode.includes('visible.liveBubbles'));
});

