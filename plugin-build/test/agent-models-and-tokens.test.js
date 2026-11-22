import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { createDiscussionPort } from '../lib/src/discussions/ports.js';
import { mountGroups } from '../lib/src/groups/mount.js';
import { createLocalBoard } from '../lib/src/groups/local-board.js';
import { createAgentMemoryService } from '../lib/src/memory/agent-memory.js';
import { DSH_ACCOUNT_ORIGIN } from '../lib/src/hub/account.js';
import { decodeAgentTrace } from '../lib/src/groups/agent-trace.js';
import { createTaskRoomStore } from '../lib/src/groups/task-room-store.js';
import { createTaskRooms } from '../lib/src/groups/task-rooms.js';
import { taskRoomAudit } from '../lib/src/groups/task-room-routes.js';
import { createTaskOrchestration } from '../lib/src/groups/task-orchestration.js';
import { syncResidentSessionToRoom } from '../lib/src/groups/session-room-sync.js';

const waitUntil = async (fn, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const res = await fn();
        if (res) return res;
        await sleep(25);
    }
    throw new Error('timed out waiting for condition');
};

test('createDiscussionPort accumulates input/output token usage across truncation retries', async t => {
    let attempt = 0;
    let finalReportedUsage;
    const progressSnapshots = [];
    const llm = {
        listProviders: () => [{ id: 'deepseek-account' }],
        listModels: async () => [{ id: 'deepseek-reasoner' }],
        resolveModelInfo: async () => ({ maxOutputTokens: 16384, reasoning: { efforts: [{ id: 'medium' }, { id: 'high' }] } }),
        prepareCall: async cfg => ({
            config: cfg,
            async *stream() {
                attempt += 1;
                if (attempt === 1) {
                    yield { type: 'reasoning-delta', text: 'Long first attempt CoT...' };
                    yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 8192 } };
                    yield { type: 'finish', reason: { kind: 'length' } };
                    return;
                }
                yield { type: 'reasoning-delta', text: 'Concise retry CoT.' };
                yield { type: 'text-delta', text: '{"verdict":"pass","findings":"ok"}' };
                yield { type: 'usage', usage: { inputTokens: 1100, outputTokens: 400 } };
                yield { type: 'finish', reason: { kind: 'stop' } };
            },
        }),
    };
    const port = createDiscussionPort({ agents: ['dsh'], llm });
    t.after(() => port.dispose());
    const [model] = await port.catalog();
    const out = await port.run(
        model,
        'verdict?',
        new AbortController().signal,
        undefined,
        'high',
        u => { finalReportedUsage = u; },
        p => { progressSnapshots.push(p); },
    );
    assert.equal(out, '{"verdict":"pass","findings":"ok"}');
    assert.ok(finalReportedUsage);
    assert.equal(finalReportedUsage.inputTokens, 2100);
    assert.equal(finalReportedUsage.outputTokens, 8592);
    assert.equal(finalReportedUsage.totalTokens, 10692);
    assert.ok(progressSnapshots.at(-1)?.usage?.totalTokens === 10692);
});

test('end-to-end HTTP + Git workflow honors per-agent model & thinking mode switching (including off & >8 models) and records per-agent token usage', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-e2e-models-tokens-'));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;

    // 1. Real Git repo for development workflow
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'index.mjs'), 'export const v = 1;\n');
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'init']);

    // 2. Agents ledger with default models and reasoning efforts
    const ledgerDir = join(root, 'dsh-agents');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, 'ledger.json'), JSON.stringify({
        teams: [{
            id: 'team',
            name: '研发班底',
            workspaceId: 'ws-dev',
            members: [
                { id: 'lead', name: '丞相', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'medium', permission: 'workspace-write' },
                { id: 'coder', name: '工部尚书', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'high', permission: 'workspace-write' },
                { id: 'reviewer', name: '刑部尚书', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'high', permission: 'read-only' },
            ],
        }],
    }));

    // 3. Multi-provider DSH LLM with 12 models in deepseek-account (>8 default slice) + openai-account
    const observedCalls = [];
    const deepseekModels = Array.from({ length: 12 }, (_, idx) => ({
        id: idx === 0 ? 'deepseek-chat' : idx === 1 ? 'deepseek-reasoner' : `deepseek-m${idx + 1}`,
    }));
    const llm = {
        listProviders: () => [{ id: 'deepseek-account' }, { id: 'openai-account' }],
        listModels: async provider => provider === 'openai-account' ? [{ id: 'gpt-5-pro' }] : deepseekModels,
        resolveModelInfo: async (_provider, modelId) => ({
            maxOutputTokens: 16384,
            reasoning: {
                efforts: modelId === 'gpt-5-pro'
                    ? [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }]
                    : [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
            },
        }),
        prepareCall: async cfg => {
            observedCalls.push({
                provider: cfg.provider,
                model: cfg.model,
                reasoningEffort: cfg.reasoningEffort,
                maxTokens: cfg.maxTokens,
            });
            return {
                config: cfg,
                async *stream({ messages }) {
                    const prompt = messages[0].content[0].text;
                    if (prompt.includes('设计和拆分')) {
                        yield { type: 'reasoning-delta', text: 'Leader planning architecture...' };
                        yield { type: 'text-delta', text: '1. Modify index.mjs and verify.' };
                        yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 450 } };
                    } else if (prompt.includes('你是 Coder')) {
                        // Coder chose `continue` (resident handoff) OR let's test full review by having Coder delegate if codex present;
                        // Here agents=['dsh'] so codex.coding is disabled -> manual handoff, OR let's inspect Reviewer in PR-review / development!
                        yield { type: 'text-delta', text: JSON.stringify({ action: 'continue', instruction: 'Update v to 2.' }) };
                        yield { type: 'usage', usage: { inputTokens: 2100, outputTokens: 320 } };
                    } else if (prompt.includes('独立审查')) {
                        yield { type: 'reasoning-delta', text: 'Critic checking PR diff...' };
                        yield { type: 'text-delta', text: '- index.mjs:1 verified clean.' };
                        yield { type: 'usage', usage: { inputTokens: 3400, outputTokens: 600 } };
                    } else {
                        yield { type: 'reasoning-delta', text: 'Chat response thinking...' };
                        yield { type: 'text-delta', text: '工部尚书已收到指令，随时待命。' };
                        yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 180 } };
                    }
                    yield { type: 'finish', reason: { kind: 'stop' } };
                },
            };
        },
    };

    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const hostBoard = createLocalBoard(join(root, 'host-board.json'));
    const routes = new Map();
    const disposers = [];
    const selectedModelsOnSessions = [];
    const promptsOnSessions = [];
    const origin = 'http://127.0.0.1:29410';

    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const u = String(url);
        if (u === origin + '/dsh-agents/api/state') {
            return Response.json({ workspaces: [{ id: 'ws-dev', path: repo }], teams: [] });
        }
        if (u === origin + '/dsh-agents/api/run') {
            const body = JSON.parse(init.body);
            return Response.json({ run: { sessionId: 'sess-' + body.memberId } });
        }
        throw new Error('unexpected fetch: ' + u);
    });

    t.after(() => {
        for (const dispose of disposers.reverse()) dispose?.();
        memory.store.close();
        if (prevHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevHome;
        rmSync(root, { recursive: true, force: true });
    });

    mountGroups({
        get(name) {
            if (name === 'llm') return llm;
            if (name === 'deepseekAccount') {
                return { getPlatformSession: async () => ({ userId: 'owner-e2e', origin: DSH_ACCOUNT_ORIGIN }) };
            }
            return undefined;
        },
        sessionController: {
            async selectModel(input) { selectedModelsOnSessions.push(input); },
            async prompt(input) { promptsOnSessions.push(input); },
        },
        inject(names, cb) {
            const scoped = {
                effect: setup => disposers.push(setup()),
                ...(names.includes('tools') ? { tools: { register: () => () => {} } } : {}),
                ...(names.includes('taskBoard') ? { taskBoard: hostBoard } : {}),
                ...(names.includes('webServer') ? {
                    webServer: {
                        getOrigin: () => origin,
                        register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
                    },
                } : {}),
            };
            cb(scoped);
        },
        effect: setup => disposers.push(setup()),
    }, { groupsRoot: join(root, 'groups'), memoryRoot: join(root, 'memory'), agents: ['dsh'], deviceId: 'desktop' }, { memory });

    const request = async (path, body, extraHeaders = {}) => {
        const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
            headers: { origin, ...extraHeaders },
            url: path,
            method: body === undefined ? 'GET' : 'POST',
            socket: { remoteAddress: '127.0.0.1' },
        });
        let response;
        const responseHeaders = {};
        const res = {
            setHeader(name, value) { responseHeaders[name] = value; },
            writeHead(code, hdrs) { response = { code, headers: { ...responseHeaders, ...hdrs } }; },
            end(value) { response.data = value ? JSON.parse(value) : undefined; },
        };
        const handler = routes.get(path.split('?')[0]);
        assert.ok(handler, 'missing route ' + path);
        await handler(req, res);
        return response;
    };

    const opened = await request('/marshal/memory/session', {}, { 'x-marshal-memory': '1' });
    const cookies = opened.headers['set-cookie'].map(line => line.split(';')[0]);
    const headers = { cookie: cookies.join('; '), 'x-marshal-csrf': cookies[1].split('=')[1] };

    // A. Verify GET /marshal/tasks/orchestration exposes each agent's default model & reasoningEffort
    const catRes = await request('/marshal/tasks/orchestration', undefined, headers);
    assert.equal(catRes.code, 200);
    const coderCatalog = catRes.data.leaders.find(l => l.id === 'team/coder');
    assert.equal(coderCatalog.model, 'deepseek-account/deepseek-chat');
    assert.equal(coderCatalog.reasoningEffort, 'high');

    // B. Create a development ticket with custom per-agent models & thinking modes (including model #11 and 'off')
    const createRes = await request('/marshal/tasks/create', {
        title: '[E2E] 验证多智能体模型与思考模式切换',
        description: '实现测试模块并验证每个角色模型、思考模式与 Token 计量生效。',
        workspaceId: 'ws-dev',
        orchestration: {
            leaderId: 'team/lead',
            workspaceId: 'ws-dev',
            choice: 'template',
            templateId: 'development',
            agentConfigs: {
                leader: { model: 'openai-account/gpt-5-pro', reasoningEffort: 'low' },
                coder: { model: 'deepseek-account/deepseek-m11', reasoningEffort: 'off' },
                reviewer: { model: 'deepseek-account/deepseek-reasoner', reasoningEffort: 'medium' },
            },
            plan: {
                templateId: 'development',
                codeWork: true,
                members: { coder: 'team/coder', reviewer: 'team/reviewer' },
                codex: { coding: 'auto', review: 'auto' },
                agentConfigs: {
                    leader: { model: 'openai-account/gpt-5-pro', reasoningEffort: 'low' },
                    coder: { model: 'deepseek-account/deepseek-m11', reasoningEffort: 'off' },
                    reviewer: { model: 'deepseek-account/deepseek-reasoner', reasoningEffort: 'medium' },
                },
            },
        },
    }, headers);
    assert.equal(createRes.code, 200, JSON.stringify(createRes.data));
    const createdCard = createRes.data.tasks[0];
    const roomId = createdCard.taskRoom.id;

    // C. Switch Leader thinking mode from 'low' -> 'xhigh' via live Drawer endpoint POST /marshal/tasks/agent-configs
    const switchRes = await request('/marshal/tasks/agent-configs', {
        taskId: createdCard.id,
        agentConfigs: {
            leader: { model: 'openai-account/gpt-5-pro', reasoningEffort: 'xhigh' },
        },
    }, headers);
    assert.equal(switchRes.code, 200, JSON.stringify(switchRes.data));
    assert.equal(switchRes.data.tasks[0].workflow.plan.agentConfigs.leader.reasoningEffort, 'xhigh');
    assert.equal(switchRes.data.tasks[0].workflow.plan.agentConfigs.coder.model, 'deepseek-account/deepseek-m11');
    assert.equal(switchRes.data.tasks[0].workflow.plan.agentConfigs.coder.reasoningEffort, 'off');

    // D. Run the ticket -> Leader runs designing (gpt-5-pro + xhigh), Coder chooses continue -> hands off to Coder resident session (deepseek-m11 + off)!
    // First disable codex.coding via agent-configs so Coder executes DSH turn & hands off cleanly without needing native codex binary:
    await request('/marshal/tasks/agent-configs', {
        taskId: createdCard.id,
        codex: { coding: 'auto' },
    }, headers);
    // Actually let's set codex.coding = null? Note when codex.coding === null, runTaskDevelopment calls manual() right after Leader designing!
    // Let's test BOTH: first run with codex.coding = null -> tests Leader (gpt-5-pro + xhigh) + Coder resident session selectModel(deepseek-m11, no reasoningEffort because 'off'!)
    await request('/marshal/tasks/agent-configs', {
        taskId: createdCard.id,
        codex: { coding: null, review: null },
    }, headers);

    const runRes = await request('/marshal/tasks/run', { taskId: createdCard.id }, headers);
    assert.equal(runRes.code, 200);

    await waitUntil(async () => {
        const st = await request('/marshal/tasks/state', undefined, headers);
        return st.data.tasks[0]?.workflow?.state === 'handed-off';
    });

    // Assert Leader hit openai-account / gpt-5-pro with reasoningEffort 'xhigh'!
    assert.equal(observedCalls.length, 1);
    assert.equal(observedCalls[0].provider, 'openai-account');
    assert.equal(observedCalls[0].model, 'gpt-5-pro');
    assert.equal(observedCalls[0].reasoningEffort, 'xhigh');

    // Assert Coder resident session handoff called selectModel with deepseek-m11 (model #11!) and NO reasoningEffort (because 'off' overrode 'high'!)
    assert.equal(selectedModelsOnSessions.length, 1);
    assert.deepEqual(selectedModelsOnSessions[0], {
        sessionId: 'sess-coder',
        provider: 'deepseek-account',
        model: 'deepseek-m11',
    });

    // E. Test live @工部尚书 chat in ticket room -> must ALSO use deepseek-m11 with reasoningEffort === undefined ('off')!
    const sendRes = await request('/marshal/task-rooms/action', {
        roomId,
        action: 'send',
        text: '@工部尚书 请汇报当前模型配置',
    }, headers);
    assert.equal(sendRes.code, 200);
    assert.equal(observedCalls.length, 2);
    assert.equal(observedCalls[1].provider, 'deepseek-account');
    assert.equal(observedCalls[1].model, 'deepseek-m11');
    assert.equal(observedCalls[1].reasoningEffort, undefined, 'thinking mode off must suppress static high effort');

    // F. Inspect GET /marshal/task-rooms/page -> verify BOTH 丞相 and 工部尚书 bubbles carry exact token usage!
    const pageRes = await request(`/marshal/task-rooms/page?roomId=${roomId}&workspaceId=ws-dev`, undefined, headers);
    assert.equal(pageRes.code, 200);
    const agentRecords = pageRes.data.records.filter(r => r.kind === 'agent');
    assert.equal(agentRecords.length, 2);

    const leaderDecoded = decodeAgentTrace(agentRecords[0].text);
    assert.equal(agentRecords[0].actor, '丞相');
    assert.deepEqual(leaderDecoded.trace.usage, { inputTokens: 1200, outputTokens: 450, totalTokens: 1650 });

    const coderDecoded = decodeAgentTrace(agentRecords[1].text);
    assert.equal(agentRecords[1].actor, '工部尚书');
    assert.deepEqual(coderDecoded.trace.usage, { inputTokens: 900, outputTokens: 180, totalTokens: 1080 });
});

test('full development + Codex sub-agent slot overrides (model + reasoningEffort) & resident session token accumulation', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-codex-slot-override-'));
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'app.js'), 'export const x = 1;\n');
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'init']);

    const dshChat = { id: 'dsh:dp:chat', agent: 'dsh', provider: 'dp', model: 'chat', reasoningEfforts: ['low', 'medium', 'high'] };
    const dshReasoner = { id: 'dsh:dp:reasoner', agent: 'dsh', provider: 'dp', model: 'reasoner', reasoningEfforts: ['low', 'medium', 'high'] };
    const codexDefault = { id: 'codex:openai:codex-mini', agent: 'codex', provider: 'openai', model: 'codex-mini', work: true, reasoningEfforts: ['low', 'medium', 'high'] };
    const codexPro = { id: 'codex:openai:gpt-6.2-sol', agent: 'codex', provider: 'openai', model: 'gpt-6.2-sol', work: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] };

    const portCalls = [];
    const port = {
        catalog: async () => [dshChat, dshReasoner, codexDefault, codexPro],
        dispose() {},
        async run(model, prompt, _signal, work, reasoning, onUsage, onProgress) {
            portCalls.push({ id: model.id, reasoning, work: Boolean(work), readOnly: work?.readOnly === true, snippet: prompt.slice(0, 40) });
            const sampleUsage = model.agent === 'codex'
                ? { inputTokens: 3000, outputTokens: 800, totalTokens: 3800, durationMs: 500 }
                : { inputTokens: 1500, outputTokens: 350, totalTokens: 1850, durationMs: 300 };
            onProgress?.({ text: 'working...', durationMs: 100, usage: sampleUsage, thinking: 'step reasoning' });
            onUsage?.(sampleUsage);
            if (model.agent === 'codex' && work && !work.readOnly) {
                writeFileSync(join(work.workspace, 'app.js'), 'export const x = 2;\n');
                return 'Updated app.js and verified.';
            }
            if (model.agent === 'codex') {
                return 'No regression in app.js.';
            }
            if (prompt.includes('设计和拆分')) return 'Update x to 2 in app.js.';
            if (prompt.includes('你是 Coder')) return JSON.stringify({ action: 'codex', instruction: 'Set x = 2.' });
            if (prompt.includes('字段 action')) return JSON.stringify({ action: 'codex', instruction: 'Audit app.js.' });
            return JSON.stringify({ verdict: 'pass', findings: 'Verified app.js.' });
        },
    };

    const memory = createAgentMemoryService({ root: join(root, 'mem') });
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'rooms.sqlite')), deviceId: 'dev' });
    const flow = createTaskOrchestration({
        file: join(root, 'orch.json'),
        memory,
        port,
        leaderAutoReview: true,
        workspacePath: async () => repo,
        inventory: () => ({
            teams: [{
                id: 'team',
                workspaceId: 'ws-1',
                members: [
                    { id: 'lead', name: '丞相', model: 'dp/chat', reasoningEffort: 'low' },
                    { id: 'coder', name: '工部尚书', model: 'dp/chat', reasoningEffort: 'high', permission: 'workspace-write' },
                    { id: 'reviewer', name: '刑部尚书', model: 'dp/chat', reasoningEffort: 'high', permission: 'read-only' },
                ],
            }],
        }),
    });
    t.after(() => { flow.dispose(); rooms.close(); memory.store.close(); rmSync(root, { recursive: true, force: true }); });

    const card = { id: 't-codex', title: 'Test Codex & Role Switching' };
    const prepared = flow.prepare({
        leaderId: 'team/lead',
        workspaceId: 'ws-1',
        choice: 'template',
        templateId: 'development',
        plan: {
            templateId: 'development',
            codeWork: true,
            members: { coder: 'team/coder', reviewer: 'team/reviewer' },
            codex: { coding: 'codex:openai:gpt-6.2-sol', review: 'auto' },
            agentConfigs: {
                leader: { model: 'dp/reasoner', reasoningEffort: 'high' },
                coder: { model: 'dp/chat', reasoningEffort: 'off' },
                reviewer: { model: 'dp/reasoner', reasoningEffort: 'medium' },
                codexCoding: { model: 'codex:openai:gpt-6.2-sol', reasoningEffort: 'xhigh' },
                codexReview: { reasoningEffort: 'low' },
            },
        },
    });
    flow.attach('host', card.id, prepared);
    const room = rooms.ensure('host', card, 'ws-1', 'owner');
    flow.start('host', card, taskRoomAudit(rooms, room, 'start'));

    await waitUntil(() => flow.view('host', card.id)?.state === 'done');

    // Verify every single agent turn used its exact configured model + thinking mode!
    const [leaderDesign, coderDelegate, codexCode, reviewerDelegate, codexRev, reviewerVerdict, leaderFinal] = portCalls;
    assert.deepEqual({ id: leaderDesign.id, r: leaderDesign.reasoning }, { id: 'dsh:dp:reasoner', r: 'high' });
    assert.deepEqual({ id: coderDelegate.id, r: coderDelegate.reasoning }, { id: 'dsh:dp:chat', r: undefined }); // 'off' disabled 'high'
    assert.deepEqual({ id: codexCode.id, r: codexCode.reasoning, w: codexCode.work }, { id: 'codex:openai:gpt-6.2-sol', r: 'xhigh', w: true });
    assert.deepEqual({ id: reviewerDelegate.id, r: reviewerDelegate.reasoning }, { id: 'dsh:dp:reasoner', r: 'medium' });
    assert.deepEqual({ id: codexRev.id, r: codexRev.reasoning, w: codexRev.work, ro: codexRev.readOnly }, { id: 'codex:openai:codex-mini', r: 'low', w: true, ro: true });
    assert.deepEqual({ id: reviewerVerdict.id, r: reviewerVerdict.reasoning }, { id: 'dsh:dp:reasoner', r: 'medium' });
    assert.deepEqual({ id: leaderFinal.id, r: leaderFinal.reasoning }, { id: 'dsh:dp:reasoner', r: 'high' });

    // Verify every LLM/Codex-backed agent bubble carries exact token usage without double-counting template summaries
    const page = await rooms.page(room.id, { limit: 40 });
    const agentBubbles = page.records.filter(r => r.kind === 'agent');
    assert.equal(agentBubbles.length, 8); // 7 LLM/Codex turns + 1 JS-assembled final delivery report
    const tracedBubbles = agentBubbles.map(b => ({ actor: b.actor, phase: b.phase, trace: decodeAgentTrace(b.text).trace })).filter(b => b.trace?.usage);
    assert.equal(tracedBubbles.length, 7, 'All 7 actual LLM/Codex calls must record token usage');
    const totalRecordedTokens = tracedBubbles.reduce((sum, b) => sum + b.trace.usage.totalTokens, 0);
    assert.equal(totalRecordedTokens, 5 * 1850 + 2 * 3800, 'Recorded bubble token sum must match exact 7 model calls without double-counting');

    // Verify resident session multi-step token summation
    const resRoom = rooms.ensure('host', { id: 't-res', title: 'Resident Tok' }, 'ws-1', 'owner');
    const liveBubble = await syncResidentSessionToRoom({
        rooms,
        room: resRoom,
        sessionId: 'session-abcd12345678',
        actor: '丞相',
        runId: prepared.runId,
        workflowState: 'handed-off',
        surface: {
            activeTurn: async () => ({ turn: 1 }),
            history: async () => ({
                events: [
                    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
                    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 250, cacheReadTokens: 500, reasoningTokens: 120 }, message: { content: [{ type: 'reasoning', text: 'Step 1 thinking' }] } } },
                    { seq: 3, type: 'step/start', data: { turn: 1, step: 2 } },
                    { seq: 4, type: 'assistant/message', data: { turn: 1, step: 2, usage: { inputTokens: 800, outputTokens: 300, cacheReadTokens: 200, reasoningTokens: 80 }, message: { content: [{ type: 'text', text: 'Milestone progress!' }] } } },
                ],
            }),
        },
    });
    assert.ok(liveBubble);
    assert.deepEqual(liveBubble.usage, {
        inputTokens: 2500,
        outputTokens: 550,
        totalTokens: 3050,
        reasoningTokens: 200,
    });
});

test('shipped client/index.js renders per-agent model/thinking switchers in TaskBoardView and token badges in TaskRoomsPage, and interactive switching triggers /marshal/tasks/agent-configs', async () => {
    const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');

    // Minimal stateful React hooks runtime to execute and inspect real component VDOM trees
    function createMiniReact() {
        let currentHookIdx = 0;
        let currentInstance = null;
        const pendingEffects = [];
        const React = {
            Fragment: Symbol.for('react.fragment'),
            Component: class Component {
                constructor(props) { this.props = props; this.state = {}; }
                setState(patch) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch); }
            },
            createElement(type, props, ...children) {
                const flat = [];
                const pushChild = c => {
                    if (Array.isArray(c)) for (const item of c) pushChild(item);
                    else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c);
                };
                for (const c of children) pushChild(c);
                return { type, props: { ...(props || {}), children: flat.length === 0 ? undefined : (flat.length === 1 ? flat[0] : flat) } };
            },
            useState(init) {
                const inst = currentInstance;
                const idx = currentHookIdx++;
                if (!(idx in inst.hooks)) inst.hooks[idx] = typeof init === 'function' ? init() : init;
                const setter = next => {
                    inst.hooks[idx] = typeof next === 'function' ? next(inst.hooks[idx]) : next;
                };
                return [inst.hooks[idx], setter];
            },
            useRef(init) {
                const inst = currentInstance;
                const idx = currentHookIdx++;
                if (!(idx in inst.hooks)) inst.hooks[idx] = { current: init };
                return inst.hooks[idx];
            },
            useMemo(fn) {
                currentHookIdx++;
                return fn();
            },
            useCallback(fn) {
                currentHookIdx++;
                return fn;
            },
            useEffect(fn, deps) {
                const inst = currentInstance;
                const idx = currentHookIdx++;
                const prev = inst.hooks[idx];
                const changed = !prev || !deps || deps.some((d, i) => !Object.is(d, prev.deps?.[i]));
                if (changed) {
                    inst.hooks[idx] = { deps };
                    pendingEffects.push(fn);
                }
            },
        };

        const instances = new Map();
        const expand = (node, pathKey = 'root') => {
            if (node === null || node === undefined || typeof node === 'boolean') return null;
            if (typeof node === 'string' || typeof node === 'number') return String(node);
            if (Array.isArray(node)) return node.map((c, i) => expand(c, pathKey + '.' + i)).filter(Boolean);
            if (node.type === React.Fragment) {
                const ch = node.props?.children;
                return expand(Array.isArray(ch) ? ch : (ch !== undefined ? [ch] : []), pathKey + '.frag');
            }
            if (typeof node.type === 'function') {
                const compKey = pathKey + ':' + (node.type.name || 'anon');
                if (node.type.prototype && typeof node.type.prototype.render === 'function') {
                    let clsInst = instances.get(compKey);
                    if (!clsInst) { clsInst = new node.type(node.props || {}); instances.set(compKey, clsInst); }
                    else clsInst.props = node.props || {};
                    return expand(clsInst.render(), compKey);
                }
                let fnInst = instances.get(compKey);
                if (!fnInst) { fnInst = { hooks: [] }; instances.set(compKey, fnInst); }
                const prevInst = currentInstance;
                const prevIdx = currentHookIdx;
                currentInstance = fnInst;
                currentHookIdx = 0;
                let rendered;
                try {
                    rendered = node.type(node.props || {});
                } finally {
                    currentInstance = prevInst;
                    currentHookIdx = prevIdx;
                }
                return expand(rendered, compKey);
            }
            const rawCh = node.props?.children;
            const childArr = Array.isArray(rawCh) ? rawCh : (rawCh !== undefined ? [rawCh] : []);
            return {
                tag: node.type,
                props: node.props || {},
                children: childArr.map((c, i) => expand(c, pathKey + '/' + String(node.type) + idxKey(c, i))).filter(v => v !== null),
            };
        };
        const idxKey = (c, i) => (c && typeof c === 'object' && c.props?.key !== undefined ? '[' + c.props.key + ']' : '[' + i + ']');
        const flushEffects = () => {
            while (pendingEffects.length > 0) {
                const eff = pendingEffects.shift();
                try { eff(); } catch { /* ignore timer cleanup in mock */ }
            }
        };
        return { React, expand, flushEffects };
    }

    const { React, expand, flushEffects } = createMiniReact();
    let loadedModule;
    const agentConfigPayloads = [];

    const sampleTask = {
        id: 'task-ui-1',
        ticketNo: 'GD-00009',
        title: '[GD-00009] 移动端应用验证',
        description: '测试工单面板每个 Agent 模型与思考模式切换',
        status: 'review',
        patchAvailable: true,
        taskRoom: { id: '11111111-2222-4333-8444-555555555555', workspaceId: 'ws-ui', title: '[GD-00009] 移动端应用验证', lastSeq: 3, closed: false },
        workflow: {
            source: 'host',
            taskId: 'task-ui-1',
            leaderId: 'team/lead',
            leaderName: '丞相',
            workspaceId: 'ws-ui',
            choice: 'template',
            templateId: 'development',
            selected: 'development',
            state: 'review-blocked',
            reviewReason: 'review-blocked',
            planConfirmed: true,
            plan: {
                templateId: 'development',
                groupTemplate: 'delivery',
                codeWork: true,
                members: { coder: 'team/coder', reviewer: 'team/reviewer' },
                codex: { coding: 'auto', review: 'auto' },
                agentConfigs: {
                    leader: { model: 'deepseek-account/deepseek-reasoner', reasoningEffort: 'high' },
                    coder: { model: 'deepseek-account/deepseek-chat', reasoningEffort: 'off' },
                },
            },
        },
        createdAt: Date.now() - 60000,
        updatedAt: Date.now(),
    };

    const mockFetch = async (input, init) => {
        const u = typeof input === 'string' ? input : String(input?.href || input?.url || input);
        const method = String(init?.method || 'GET').toUpperCase();
        if (u.endsWith('/marshal/setup')) return Response.json({ ok: true, ready: true });
        if (u.includes('marshal/memory/session')) {
            return new Response(JSON.stringify({ ok: true, csrf: 'csrf-ui' }), { status: 200 });
        }
        if (u.includes('marshal/tasks/state')) {
            return new Response(JSON.stringify({ ok: true, tasks: [sampleTask], sessionDefaultPermission: 'workspace-write' }), { status: 200 });
        }
        if (u.includes('marshal/tasks/orchestration')) {
            return new Response(JSON.stringify({
                ok: true,
                memoryAvailable: true,
                templates: [{
                    id: 'development', name: '开发交付', groupTemplate: 'delivery', stages: ['设计', '编码', '审查'], automated: true,
                    roles: [{ id: 'coder', name: 'Coder', required: true }, { id: 'reviewer', name: 'Reviewer', required: true }],
                    codingRoles: [{ id: 'coder', name: 'Coder', required: true }, { id: 'reviewer', name: 'Reviewer', required: true }],
                }],
                groupTemplates: [{ id: 'delivery', name: '分阶段交付', count: 3 }],
                plainTemplate: { id: 'none', name: '普通任务', groupTemplate: 'free', stages: [], roles: [{ id: 'collaborator', name: '协作者', required: false }], codingRoles: [] },
                leaders: [
                    { id: 'team/lead', name: '丞相', workspaceId: 'ws-ui', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'medium', permission: 'workspace-write' },
                    { id: 'team/coder', name: '工部尚书', workspaceId: 'ws-ui', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'high', permission: 'workspace-write' },
                    { id: 'team/reviewer', name: '刑部尚书', workspaceId: 'ws-ui', model: 'deepseek-account/deepseek-reasoner', reasoningEffort: 'high', permission: 'read-only' },
                ],
                codexModels: [
                    { id: 'codex:openai:gpt-6.2-sol', agent: 'codex', provider: 'openai', model: 'gpt-6.2-sol', work: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
                ],
            }), { status: 200 });
        }
        if (u.includes('api/task-board/model-catalog')) {
            return new Response(JSON.stringify({
                groups: [{
                    id: 'deepseek-account',
                    models: [
                        { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: { efforts: [] } },
                        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] } },
                    ],
                }],
            }), { status: 200 });
        }
        if (u.includes('marshal/task-rooms/workspaces')) {
            return new Response(JSON.stringify({ ok: true, workspaces: [{ id: 'ws-ui', name: 'dsh-marshal', path: '/tmp/ws-ui' }] }), { status: 200 });
        }
        if (u.includes('marshal/rosters/state')) {
            return new Response(JSON.stringify({ ok: true, rosters: {} }), { status: 200 });
        }
        if (u.includes('marshal/tasks/agent-configs') && method === 'POST') {
            const payload = JSON.parse(init.body);
            agentConfigPayloads.push(payload);
            return new Response(JSON.stringify({ ok: true, tasks: [sampleTask] }), { status: 200 });
        }
        if (u.includes('marshal/task-rooms/list')) {
            return new Response(JSON.stringify({ ok: true, rooms: [sampleTask.taskRoom] }), { status: 200 });
        }
        if (u.includes('marshal/task-rooms/page')) {
            return new Response(JSON.stringify({
                ok: true,
                origin: true,
                room: sampleTask.taskRoom,
                runState: 'review-blocked',
                cardStatus: 'review',
                patchAvailable: true,
                workflow: sampleTask.workflow,
                participants: [
                    { id: 'team/lead', name: '丞相', role: 'Leader', primary: true },
                    { id: 'team/coder', name: '工部尚书', role: 'Coder', primary: true },
                ],
                records: [{
                    seq: 1,
                    id: 'r1',
                    kind: 'agent',
                    actor: '丞相',
                    phase: 'designing',
                    at: Date.now() - 10000,
                    text: '<!--marshal-trace:{"v":1,"thinking":"先拆分移动端离线提示模块","steps":[{"label":"Mnemon 召回了 2 条记忆","status":"done"}],"usage":{"inputTokens":4500,"outputTokens":900,"totalTokens":5400},"durationMs":1800,"model":"deepseek-reasoner"}-->\n已完成模块拆分方案。',
                }],
                liveBubbles: [{
                    id: 'live-1',
                    actor: '工部尚书',
                    phase: 'coding',
                    model: 'deepseek-chat',
                    startedAt: Date.now() - 4000,
                    updatedAt: Date.now(),
                    thinking: '正在检查隔离工作树单测结果…',
                    steps: [{ label: '执行命令: npm test', status: 'running' }],
                    usage: { inputTokens: 2100, outputTokens: 400, totalTokens: 2500 },
                    text: '正在生成补丁…',
                }],
            }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    class MockMutationObserver {
        observe() {}
        disconnect() {}
    }
    const noopTimer = () => 1;
    const win = {
        location: new URL('http://127.0.0.1:62578/'),
        fetch: mockFetch,
        MutationObserver: MockMutationObserver,
        addEventListener() {},
        removeEventListener() {},
        requestAnimationFrame: fn => fn(),
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        __ModuleLoader__: {
            load(def) { loadedModule = def; },
        },
    };
    const doc = {
        baseURI: 'http://127.0.0.1:62578/',
        cookie: 'marshal-memory-csrf=csrf-ui',
        body: { appendChild() {} },
        documentElement: {},
        head: { appendChild() {} },
        getElementById: () => null,
        createElement: () => ({ style: {}, setAttribute() {}, append() {}, appendChild() {}, remove() {} }),
        querySelector: () => null,
        querySelectorAll: () => [],
    };

    runInNewContext(source, {
        window: win,
        globalThis: win,
        document: doc,
        MutationObserver: MockMutationObserver,
        fetch: win.fetch,
        URL,
        URLSearchParams,
        Response,
        AbortController,
        TextDecoder,
        Blob,
        Intl,
        performance,
        setTimeout: noopTimer,
        clearTimeout() {},
        setInterval: noopTimer,
        clearInterval() {},
        requestAnimationFrame: fn => fn(),
        console,
    });

    assert.ok(loadedModule, 'client/index.js must register with __ModuleLoader__');
    const pluginObj = loadedModule.factory(mod => {
        assert.equal(mod, 'react');
        return React;
    });

    let RegisteredMainPanel;
    pluginObj.apply({
        effect() {},
        inject() {},
        slots: {
            inject(_slot, fn) { return fn(); },
            register(meta, Comp) {
                if (meta.name === 'main') RegisteredMainPanel = Comp;
                return () => {};
            },
        },
    });
    assert.ok(RegisteredMainPanel, 'SafeMarshalPanel must be registered on main slot');

    // Helper to walk expanded VDOM
    const collectAll = (node, pred, out = []) => {
        if (!node || typeof node !== 'object') return out;
        if (Array.isArray(node)) { for (const n of node) collectAll(n, pred, out); return out; }
        if (pred(node)) out.push(node);
        if (Array.isArray(node.children)) for (const c of node.children) collectAll(c, pred, out);
        return out;
    };
    const textOf = node => {
        if (node === null || node === undefined) return '';
        if (typeof node === 'string') return node;
        if (Array.isArray(node)) return node.map(textOf).join('');
        return (node.children || []).map(textOf).join('');
    };

    // 1. Render SafeMarshalPanel (defaults to Tasks tab -> TaskBoardView), flush initial data loads, re-render
    expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));
    flushEffects();
    await sleep(60);
    let tree = expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));
    flushEffects();
    await sleep(30);
    tree = expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));

    // Click the GD-00009 card to open Ticket Detail Drawer!
    const cardArticle = collectAll(tree, n => n.tag === 'article' && n.props?.id === 'marshal-ticket-task-ui-1')[0];
    assert.ok(cardArticle, 'GD-00009 ticket card must render on TaskBoardView');
    cardArticle.props.onClick();
    flushEffects();
    tree = expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));

    // Verify per-agent model & thinking mode <select> controls exist in the Drawer!
    const selects = collectAll(tree, n => n.tag === 'select');
    const byAria = label => selects.find(s => s.props?.['aria-label'] === label);

    const leaderModelSelect = byAria('Leader 模型');
    const leaderThinkSelect = byAria('Leader 思考模式');
    const coderModelSelect = byAria('Coder 模型');
    const coderThinkSelect = byAria('Coder 思考模式');
    const reviewerModelSelect = byAria('Reviewer 模型');
    const reviewerThinkSelect = byAria('Reviewer 思考模式');
    const codexCodeThinkSelect = byAria('⚙️ Codex · 编码执行子 Agent 思考模式');

    assert.ok(leaderModelSelect && leaderThinkSelect, 'Drawer must render Leader model & thinking mode switchers');
    assert.ok(coderModelSelect && coderThinkSelect, 'Drawer must render Coder model & thinking mode switchers');
    assert.ok(reviewerModelSelect && reviewerThinkSelect, 'Drawer must render Reviewer model & thinking mode switchers');
    assert.ok(codexCodeThinkSelect, 'Drawer must render Codex sub-agent thinking mode switcher');

    assert.equal(leaderModelSelect.props.value, 'deepseek-account/deepseek-reasoner');
    assert.equal(leaderThinkSelect.props.value, 'high');
    assert.equal(coderThinkSelect.props.value, 'off', 'Coder thinking mode off must be reflected in select value');

    // Verify 'off' ("思考：关闭 (直出)") option exists inside Reviewer 思考模式 dropdown, and trigger onChange!
    const reviewerOptions = collectAll(reviewerThinkSelect, n => n.tag === 'option').map(o => o.props?.value);
    assert.ok(reviewerOptions.includes('off'), 'Thinking mode dropdown must include off option');
    assert.ok(reviewerOptions.includes('high'), 'Thinking mode dropdown must include high option');

    reviewerThinkSelect.props.onChange({ target: { value: 'off' } });
    await sleep(30);
    assert.equal(agentConfigPayloads.length, 1);
    assert.deepEqual(agentConfigPayloads[0], {
        taskId: 'task-ui-1',
        agentConfigs: { reviewer: { reasoningEffort: 'off' } },
    });

    // 2. Click "进入工单群" button in Drawer to navigate to TaskRoomsPage and verify per-agent token badges render!
    const enterRoomBtn = collectAll(tree, n => n.tag === 'button' && textOf(n) === '进入工单群')[0];
    assert.ok(enterRoomBtn, 'Drawer must have 进入工单群 button');
    enterRoomBtn.props.onClick();
    flushEffects();
    await sleep(60);
    tree = expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));
    flushEffects();
    await sleep(40);
    tree = expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));

    const fullRoomText = textOf(tree);
    assert.match(fullRoomText, /5\.4k tok \(入 4\.5k · 出 900\)/, 'Persisted 丞相 bubble must render formatted token badge');
    assert.match(fullRoomText, /2\.5k tok \(入 2\.1k · 出 400\)/, 'Live 工部尚书 bubble must render live token badge');
    assert.match(fullRoomText, /累计 7\.9k tok/, 'Room header must render cumulative token total across agents');
    assert.match(fullRoomText, /@丞相· Leader· 🪙5\.4k/, '@角色 chip must display per-agent cumulative token count');
});
