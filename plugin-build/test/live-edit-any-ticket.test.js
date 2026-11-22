import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { mountGroups } from '../lib/src/groups/mount.js';
import { createAgentMemoryService } from '../lib/src/memory/agent-memory.js';
import { DSH_ACCOUNT_ORIGIN } from '../lib/src/hub/account.js';

const waitUntil = async (fn, ms = 6000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const res = await fn();
        if (res) return res;
        await sleep(25);
    }
    throw new Error('timed out waiting for condition');
};

/**
 * Strict mock of host @linxin666/dsh-client-ui-task-board:
 * Rejects any update carrying title/description/prompt/attachments once executions.length > 0
 * with `Error("task has already been executed")` — matching real host behavior 1:1.
 */
function createStrictHostBoard() {
    const tasks = [];
    const reworkCalls = [];
    const runCalls = [];
    const FROZEN = ['title', 'description', 'prompt', 'attachments'];
    return {
        tasks,
        reworkCalls,
        runCalls,
        snapshot() {
            return { tasks: tasks.map(t => ({ ...t, executions: [...(t.executions ?? [])] })) };
        },
        async apply(_reqId, action, initiator) {
            const now = Date.now();
            if (action.kind === 'create') {
                const created = {
                    id: action.id,
                    title: action.input.title,
                    description: action.input.description ?? '',
                    prompt: action.input.prompt ?? action.input.description ?? action.input.title,
                    status: 'todo',
                    createdAt: now,
                    updatedAt: now,
                    executions: [],
                    ...(action.input.workspaceId ? { workspaceId: action.input.workspaceId } : {}),
                    ...(action.input.tags ? { tags: action.input.tags } : {}),
                    ...(action.input.permission ? { permission: action.input.permission } : {}),
                    ...(action.input.model ? { model: action.input.model } : {}),
                    ...(action.input.reasoningEffort ? { reasoningEffort: action.input.reasoningEffort } : {}),
                    ...(action.input.reuseSession !== undefined ? { reuseSession: action.input.reuseSession } : {}),
                    ...(action.input.attachments ? { attachments: action.input.attachments } : {}),
                };
                tasks.push(created);
                return this.snapshot();
            }
            const idx = tasks.findIndex(t => t.id === action.taskId);
            if (idx === -1) throw new Error('task not found');
            const cur = tasks[idx];
            if (action.kind === 'update') {
                if (FROZEN.some(f => f in action.patch) && cur.executions.length > 0) {
                    throw new Error('task has already been executed');
                }
                const next = { ...cur, updatedAt: now };
                for (const [k, v] of Object.entries(action.patch)) {
                    if (v === null || v === '') delete next[k];
                    else next[k] = v;
                }
                tasks[idx] = next;
                return this.snapshot();
            }
            if (action.kind === 'move') {
                tasks[idx] = { ...cur, status: action.status, updatedAt: now };
                return this.snapshot();
            }
            if (action.kind === 'run' || action.kind === 'rerun' || action.kind === 'rework') {
                if (action.kind === 'rework') {
                    const hasSettledSession = [...cur.executions].reverse().some(e => e.endedAt !== undefined && e.sessionId);
                    if (!hasSettledSession) throw new Error('task records no execution session to continue');
                    reworkCalls.push({ taskId: cur.id, instructions: action.instructions, initiator });
                } else {
                    runCalls.push({ taskId: cur.id, kind: action.kind, initiator });
                }
                const ex = {
                    id: randomUUID(),
                    sessionId: 'sess-plain-' + (cur.executions.length + 1),
                    startedAt: now,
                    ...(action.kind === 'rework' ? { rework: { instructions: action.instructions } } : {}),
                };
                tasks[idx] = { ...cur, status: 'running', updatedAt: now, executions: [...cur.executions, ex] };
                return this.snapshot();
            }
            if (action.kind === 'settle') {
                tasks[idx] = {
                    ...cur,
                    status: 'failed',
                    updatedAt: now,
                    executions: cur.executions.map(e => e.endedAt === undefined ? { ...e, endedAt: now, result: 'failed', error: 'settled' } : e),
                };
                return this.snapshot();
            }
            if (action.kind === 'set-parent') {
                const next = { ...cur, updatedAt: now };
                if (action.parentId) next.parentId = action.parentId;
                else delete next.parentId;
                tasks[idx] = next;
                return this.snapshot();
            }
            return this.snapshot();
        },
    };
}

test('failed workflow & plain tickets with prior executions allow editing agent models, thinking modes, and frozen content, notify room, and take effect on rerun', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-failed-edit-e2e-'));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;

    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'feature.js'), 'export const version = 1;\n');
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'init']);

    const ledgerDir = join(root, 'dsh-agents');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, 'ledger.json'), JSON.stringify({
        teams: [{
            id: 'team',
            name: '研发班底',
            workspaceId: 'ws-dev',
            members: [
                { id: 'lead', name: '丞相', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'medium', permission: 'workspace-write' },
                { id: 'coder', name: '工部尚书', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'medium', permission: 'workspace-write' },
                { id: 'reviewer', name: '刑部尚书', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'high', permission: 'read-only' },
            ],
        }],
    }));

    let failFirstRun = true;
    const observedCalls = [];
    const llm = {
        listProviders: () => [{ id: 'deepseek-account' }, { id: 'openai-account' }],
        listModels: async p => p === 'openai-account' ? [{ id: 'gpt-5-pro' }] : [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
        resolveModelInfo: async (_p, m) => ({
            maxOutputTokens: 16384,
            reasoning: { efforts: m === 'gpt-5-pro' ? [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }] : [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
        }),
        prepareCall: async cfg => {
            const promptText = cfg.messages?.[0]?.content?.[0]?.text ?? '';
            return {
                config: cfg,
                async *stream({ messages }) {
                    const text = messages?.[0]?.content?.[0]?.text ?? promptText;
                    observedCalls.push({ provider: cfg.provider, model: cfg.model, reasoningEffort: cfg.reasoningEffort, prompt: text });
                    if (failFirstRun) {
                        throw Object.assign(new Error('upstream model timeout'), { code: 'leader-model-unavailable' });
                    }
                    if (text.includes('设计和拆分')) {
                        yield { type: 'text-delta', text: '按修订要求导出 version = 99。' };
                    } else if (text.includes('你是 Coder')) {
                        yield { type: 'text-delta', text: JSON.stringify({ action: 'continue', instruction: 'Set version = 99 in feature.js' }) };
                    } else {
                        yield { type: 'text-delta', text: '收到' };
                    }
                    yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 120 } };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                },
            };
        },
    };

    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const hostBoard = createStrictHostBoard();
    const routes = new Map();
    const disposers = [];
    const selectedModels = [];
    const sessionPrompts = [];
    const origin = 'http://127.0.0.1:29501';

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
            if (name === 'deepseekAccount') return { getPlatformSession: async () => ({ userId: 'owner-1', origin: DSH_ACCOUNT_ORIGIN }) };
            return undefined;
        },
        sessionController: {
            async selectModel(input) { selectedModels.push(input); },
            async prompt(input) { sessionPrompts.push(input); },
        },
        inject(names, cb) {
            cb({
                effect: setup => disposers.push(setup()),
                ...(names.includes('tools') ? { tools: { register: () => () => {} } } : {}),
                ...(names.includes('taskBoard') ? { taskBoard: hostBoard } : {}),
                ...(names.includes('webServer') ? {
                    webServer: {
                        getOrigin: () => origin,
                        register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
                    },
                } : {}),
            });
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

    // 1. Create a workflow ticket, stamp a prior execution on hostBoard (like a failed card on real DSH), and let its run fail!
    const createdRes = await request('/marshal/tasks/create', {
        title: '[修复] 旧版工单失败后无法切换模型',
        description: '初始描述：导出 version = 1。',
        workspaceId: 'ws-dev',
        orchestration: {
            leaderId: 'team/lead',
            workspaceId: 'ws-dev',
            choice: 'template',
            templateId: 'development',
            plan: {
                templateId: 'development',
                codeWork: true,
                members: { coder: 'team/coder', reviewer: 'team/reviewer' },
                codex: { coding: 'auto', review: 'auto' },
            },
        },
    }, headers);
    assert.equal(createdRes.code, 200);
    const wfTask = createdRes.data.tasks[0];
    const roomId = wfTask.taskRoom.id;

    // Simulate that hostBoard also recorded a failed execution (so hostBoard freezes content fields!)
    const rawHostCard = hostBoard.tasks.find(t => t.id === wfTask.id);
    rawHostCard.executions.push({
        id: randomUUID(),
        sessionId: 'sess-old-failed',
        startedAt: Date.now() - 5000,
        endedAt: Date.now() - 1000,
        result: 'failed',
        error: 'first run failed',
    });

    await request('/marshal/tasks/run', { taskId: wfTask.id }, headers);
    await waitUntil(async () => {
        const st = await request('/marshal/tasks/state', undefined, headers);
        return st.data.tasks.find(t => t.id === wfTask.id)?.workflow?.state === 'failed';
    });

    // 2. Now on this FAILED ticket (with executions.length > 0!), modify Leader & Coder models & thinking modes!
    const cfgRes = await request('/marshal/tasks/agent-configs', {
        taskId: wfTask.id,
        agentConfigs: {
            leader: { model: 'openai-account/gpt-5-pro', reasoningEffort: 'xhigh' },
            coder: { model: 'deepseek-account/deepseek-reasoner', reasoningEffort: 'off' },
        },
    }, headers);
    assert.equal(cfgRes.code, 200, 'Editing agent model/thinking on a failed ticket must succeed');
    assert.match(cfgRes.data.notice, /Leader（丞相）.*gpt-5-pro/);
    assert.match(cfgRes.data.notice, /极高 \(xhigh\)/);
    assert.match(cfgRes.data.notice, /下一轮对话\/阶段生效/);

    // Verify the ticket room received the config-change notice!
    const roomAfterCfg = await request(`/marshal/task-rooms/page?roomId=${roomId}&workspaceId=ws-dev`, undefined, headers);
    const cfgRecord = roomAfterCfg.data.records.find(r => r.kind === 'status' && r.phase === 'config-change');
    assert.ok(cfgRecord, 'Ticket room must contain a Marshal config-change notice');
    assert.match(cfgRecord.text, /下一轮对话\/阶段生效/);

    // 3. Also edit title, description, prompt, and card model on this already-executed FAILED ticket!
    // (Previously threw Error("task has already been executed")!)
    const updRes = await request('/marshal/tasks/update', {
        taskId: wfTask.id,
        title: '[修复] 失败工单已修改标题与描述',
        description: '修订后描述：必须导出 version = 99 并校验。',
        prompt: '严格导出 version = 99',
        model: 'openai-account/gpt-5-pro',
        reasoningEffort: 'high',
    }, headers);
    assert.equal(updRes.code, 200, 'Updating frozen content + model on an already-executed failed card must succeed');
    const updatedView = updRes.data.tasks.find(t => t.id === wfTask.id);
    assert.equal(updatedView.title, '[修复] 失败工单已修改标题与描述');
    assert.equal(updatedView.description, '修订后描述：必须导出 version = 99 并校验。');
    assert.equal(updatedView.prompt, '严格导出 version = 99');
    assert.equal(updatedView.model, 'openai-account/gpt-5-pro');
    assert.equal(updatedView.reasoningEffort, 'high');

    // 4. Re-run the failed ticket and verify BOTH the new models/thinking modes AND the overridden description actually take effect!
    observedCalls.length = 0;
    failFirstRun = false;
    const rerunRes = await request('/marshal/tasks/run', { taskId: wfTask.id }, headers);
    assert.equal(rerunRes.code, 200);
    await waitUntil(async () => {
        const st = await request('/marshal/tasks/state', undefined, headers);
        return st.data.tasks.find(t => t.id === wfTask.id)?.workflow?.state === 'handed-off';
    });

    assert.equal(observedCalls[0].provider, 'openai-account');
    assert.equal(observedCalls[0].model, 'gpt-5-pro');
    assert.equal(observedCalls[0].reasoningEffort, 'xhigh', 'Switched Leader model + xhigh thinking mode must take effect on rerun');
    assert.match(observedCalls[0].prompt, /必须导出 version = 99/, 'Overridden description on failed card must reach Leader');

    assert.equal(observedCalls[1].provider, 'deepseek-account');
    assert.equal(observedCalls[1].model, 'deepseek-reasoner');
    assert.equal(observedCalls[1].reasoningEffort, undefined, 'Switched Coder model + off thinking mode must take effect');

    // 5. Also test a PLAIN executed failed card: edit content + model + thinking mode, and revise/rerun via rework!
    const plainCreate = await request('/marshal/tasks/create', {
        title: '[单卡] 普通执行卡片修改测试',
        description: '普通卡片初始内容，用于验证已执行卡片内容覆盖与重跑生效。',
        workspaceId: 'ws-dev',
        tags: [{ name: '智能体:工部尚书' }],
    }, headers);
    const plainCard = plainCreate.data.tasks.find(t => t.title.includes('普通执行卡片'));
    const rawPlain = hostBoard.tasks.find(t => t.id === plainCard.id);
    rawPlain.status = 'failed';
    rawPlain.executions.push({
        id: randomUUID(),
        sessionId: 'sess-plain-settled',
        startedAt: Date.now() - 4000,
        endedAt: Date.now() - 2000,
        result: 'failed',
        error: 'plain card failed',
    });

    const plainUpd = await request('/marshal/tasks/update', {
        taskId: plainCard.id,
        description: '普通卡片失败后修改的新描述：改为输出 123',
        model: 'openai-account/gpt-5-pro',
        reasoningEffort: 'low',
    }, headers);
    assert.equal(plainUpd.code, 200);
    assert.match(plainUpd.data.configNotice, /工部尚书.*gpt-5-pro/);
    assert.match(plainUpd.data.configNotice, /低 \(low\)/);
    assert.ok(selectedModels.some(s => s.sessionId === 'sess-plain-settled' && s.provider === 'openai-account' && s.model === 'gpt-5-pro' && s.reasoningEffort === 'low'),
        'Changing model & effort on a card with a resident session must invoke sessionController.selectModel');

    const plainRevise = await request('/marshal/tasks/revise', {
        taskId: plainCard.id,
        text: '请按新描述输出 123 并附带单元测试',
    }, headers);
    assert.equal(plainRevise.code, 200, 'Revising an already-executed plain card must not fail with task has already been executed');
    assert.equal(hostBoard.reworkCalls.length, 1);
    assert.match(hostBoard.reworkCalls[0].instructions, /改为输出 123/);
    assert.match(hostBoard.reworkCalls[0].instructions, /请按新描述输出 123 并附带单元测试/);
});

test('mid-run edits on an actively running workflow immediately inject live steering content AND apply switched model/thinking on the very next stage', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-midrun-steer-e2e-'));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;

    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'calc.js'), 'export const add = (a, b) => a + b;\n');
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'init']);

    const ledgerDir = join(root, 'dsh-agents');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, 'ledger.json'), JSON.stringify({
        teams: [{
            id: 'team',
            name: '研发班底',
            workspaceId: 'ws-live',
            members: [
                { id: 'lead', name: '丞相', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'low', permission: 'workspace-write' },
                { id: 'coder', name: '工部尚书', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'low', permission: 'workspace-write' },
                { id: 'reviewer', name: '刑部尚书', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'medium', permission: 'read-only' },
            ],
        }],
    }));

    let releaseDesigning;
    const designingEntered = new Promise(resolve => {
        releaseDesigning = (() => {
            let unblock;
            const gate = new Promise(r => { unblock = r; });
            return { notifyEntered: resolve, gate, unblock };
        })();
    });

    const stageCalls = [];
    const llm = {
        listProviders: () => [{ id: 'deepseek-account' }, { id: 'openai-account' }],
        listModels: async p => p === 'openai-account' ? [{ id: 'gpt-5-pro' }] : [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
        resolveModelInfo: async (_p, m) => ({
            maxOutputTokens: 16384,
            reasoning: { efforts: m === 'gpt-5-pro' ? [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }] : [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
        }),
        prepareCall: async cfg => ({
            config: cfg,
            async *stream({ messages }) {
                const prompt = messages?.[0]?.content?.[0]?.text ?? '';
                stageCalls.push({
                    provider: cfg.provider,
                    model: cfg.model,
                    reasoningEffort: cfg.reasoningEffort,
                    prompt,
                });
                if (prompt.includes('设计和拆分')) {
                    releaseDesigning.notifyEntered();
                    await releaseDesigning.gate;
                    yield { type: 'text-delta', text: '1. 修改 calc.js 并补齐验证。' };
                } else if (prompt.includes('你是 Coder')) {
                    yield { type: 'text-delta', text: JSON.stringify({ action: 'continue', instruction: 'Apply steered mul(a,b) requirement.' }) };
                } else {
                    yield { type: 'text-delta', text: '已收到群聊消息。' };
                }
                yield { type: 'usage', usage: { inputTokens: 600, outputTokens: 150 } };
                yield { type: 'finish', reason: { kind: 'stop' } };
            },
        }),
    };

    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const hostBoard = createStrictHostBoard();
    const routes = new Map();
    const disposers = [];
    const selectedModels = [];
    const steeredSessionPrompts = [];
    const origin = 'http://127.0.0.1:29502';

    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const u = String(url);
        if (u === origin + '/dsh-agents/api/state') return Response.json({ workspaces: [{ id: 'ws-live', path: repo }], teams: [] });
        if (u === origin + '/dsh-agents/api/run') {
            const body = JSON.parse(init.body);
            return Response.json({ run: { sessionId: 'sess-live-' + body.memberId } });
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
            if (name === 'deepseekAccount') return { getPlatformSession: async () => ({ userId: 'owner-2', origin: DSH_ACCOUNT_ORIGIN }) };
            return undefined;
        },
        sessionController: {
            async selectModel(input) { selectedModels.push(input); },
            async prompt(input) { steeredSessionPrompts.push(input); },
        },
        inject(names, cb) {
            cb({
                effect: setup => disposers.push(setup()),
                ...(names.includes('tools') ? { tools: { register: () => () => {} } } : {}),
                ...(names.includes('taskBoard') ? { taskBoard: hostBoard } : {}),
                ...(names.includes('webServer') ? {
                    webServer: {
                        getOrigin: () => origin,
                        register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
                    },
                } : {}),
            });
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

    // 1. Create and start the development workflow
    const createRes = await request('/marshal/tasks/create', {
        title: '[新功能] 实时插话与下一轮模型切换验证',
        description: '初始需求：仅保留 add(a, b) 函数。',
        workspaceId: 'ws-live',
        orchestration: {
            leaderId: 'team/lead',
            workspaceId: 'ws-live',
            choice: 'template',
            templateId: 'development',
            plan: {
                templateId: 'development',
                codeWork: true,
                members: { coder: 'team/coder', reviewer: 'team/reviewer' },
                codex: { coding: 'auto', review: 'auto' },
            },
        },
    }, headers);
    const card = createRes.data.tasks[0];
    const roomId = card.taskRoom.id;

    // Also simulate hostBoard open execution so content is frozen on hostBoard while running!
    hostBoard.tasks[0].executions.push({ id: randomUUID(), startedAt: Date.now() });

    const runRes = await request('/marshal/tasks/run', { taskId: card.id }, headers);
    assert.equal(runRes.code, 200);
    await designingEntered;

    // Confirm workflow is actively in-flight in `designing`
    const midState = await request('/marshal/tasks/state', undefined, headers);
    assert.equal(midState.data.tasks[0].workflow.state, 'running');
    assert.equal(midState.data.tasks[0].workflow.phase, 'designing');

    // 2. WHILE RUNNING: modify ticket description with steerNow: true!
    const steerUpdateRes = await request('/marshal/tasks/update', {
        taskId: card.id,
        description: '实时修订需求：除 add(a, b) 外，必须立刻新增 mul(a, b) 乘法导出！',
        steerNow: true,
    }, headers);
    assert.equal(steerUpdateRes.code, 200, 'Updating ticket content while workflow is running must succeed');
    assert.equal(steerUpdateRes.data.steered, true, 'Response must confirm live steering injection');

    // 3. WHILE RUNNING: switch Coder (`工部尚书`) model & thinking strength!
    const midCfgRes = await request('/marshal/tasks/agent-configs', {
        taskId: card.id,
        agentConfigs: {
            coder: { model: 'openai-account/gpt-5-pro', reasoningEffort: 'xhigh' },
        },
    }, headers);
    assert.equal(midCfgRes.code, 200, 'Switching agent model & thinking strength while running must succeed');
    assert.match(midCfgRes.data.notice, /Coder（工部尚书）.*gpt-5-pro/);
    assert.match(midCfgRes.data.notice, /极高 \(xhigh\)/);
    assert.match(midCfgRes.data.notice, /下一轮对话\/阶段生效/);

    // 4. Release `designing` so the SAME workflow advances to `coding` (`工部尚书`'s turn)!
    releaseDesigning.unblock();

    await waitUntil(async () => {
        const st = await request('/marshal/tasks/state', undefined, headers);
        return st.data.tasks[0].workflow.state === 'handed-off';
    });

    // Verify Stage 1 (`designing` - started before switch) used initial deepseek-chat + low:
    assert.equal(stageCalls[0].provider, 'deepseek-account');
    assert.equal(stageCalls[0].model, 'deepseek-chat');
    assert.equal(stageCalls[0].reasoningEffort, 'low');

    // Verify Stage 2 (`coding` - NEXT turn in the SAME running workflow!) used the switched gpt-5-pro + xhigh AND received the steered content!
    assert.equal(stageCalls[1].provider, 'openai-account');
    assert.equal(stageCalls[1].model, 'gpt-5-pro');
    assert.equal(stageCalls[1].reasoningEffort, 'xhigh', 'Mid-run thinking strength switch must take effect on the very next turn');
    assert.match(stageCalls[1].prompt, /必须立刻新增 mul\(a, b\) 乘法导出/, 'Coder turn must receive updated card description');
    assert.match(stageCalls[1].prompt, /【工单内容实时修订插话】/, 'Coder turn must receive live steering operator note');

    // Verify resident handoff session (`sess-live-coder`) ALSO got `gpt-5-pro` + `xhigh` selected!
    assert.ok(selectedModels.some(s => s.sessionId === 'sess-live-coder' && s.provider === 'openai-account' && s.model === 'gpt-5-pro' && s.reasoningEffort === 'xhigh'));

    // 5. Now while `handed-off` to resident session `sess-live-coder`, edit description again -> must immediately queue steer prompt into `sess-live-coder`!
    const promptsBefore = steeredSessionPrompts.length;
    const residentSteerRes = await request('/marshal/tasks/update', {
        taskId: card.id,
        description: '二次插话：请同时补充 divide(a, b) 零除保护！',
        steerNow: true,
    }, headers);
    assert.equal(residentSteerRes.code, 200);
    assert.equal(residentSteerRes.data.steered, true);
    assert.ok(steeredSessionPrompts.length > promptsBefore, 'Editing content while handed-off must queue live steering prompt to resident session');
    const lastQueued = steeredSessionPrompts.at(-1);
    assert.equal(lastQueued.sessionId, 'sess-live-coder');
    assert.equal(lastQueued.mode, 'queue');
    assert.match(lastQueued.content[0].text, /二次插话：请同时补充 divide\(a, b\) 零除保护/);

    // 6. Verify ticket room records contain BOTH the `steering` user bubbles AND the `config-change` status notice!
    const roomPage = await request(`/marshal/task-rooms/page?roomId=${roomId}&workspaceId=ws-live`, undefined, headers);
    const steeringBubbles = roomPage.data.records.filter(r => r.kind === 'user' && r.phase === 'steering');
    const configPills = roomPage.data.records.filter(r => r.kind === 'status' && r.phase === 'config-change');
    assert.ok(steeringBubbles.length >= 2, 'Ticket room must record both live steering user messages');
    assert.equal(configPills.length, 1, 'Ticket room must record the model/thinking change notice');
    assert.match(configPills[0].text, /下一轮对话\/阶段生效/);

    // 7. Close the room (`done`), then send a chat message with autoReopen: true -> verify auto-reopen works!
    await request('/marshal/task-rooms/action', { roomId, action: 'close' }, headers);
    const sendOnClosed = await request('/marshal/task-rooms/action', {
        roomId,
        action: 'send',
        text: '@工部尚书 归档后补问一句',
        autoReopen: true,
    }, headers);
    assert.equal(sendOnClosed.code, 200, 'Sending chat in a closed room must auto-reopen and succeed');
    assert.equal(sendOnClosed.data.room.closed, false);

    // 8. Also test upgrading a brand-new PLAIN card into multi-agent orchestration via POST /marshal/tasks/plan!
    const plainRes = await request('/marshal/tasks/create', {
        title: '[升级测试] 普通工单中途启用多智能体编排',
        description: '创建时未选编排，后续直接开启编排分工。',
        workspaceId: 'ws-live',
    }, headers);
    const plainTask = plainRes.data.tasks.find(t => t.title.includes('升级测试'));
    assert.equal(plainTask.workflow, undefined);
    const upgradeRes = await request('/marshal/tasks/plan', {
        taskId: plainTask.id,
        orchestration: {
            leaderId: 'team/lead',
            workspaceId: 'ws-live',
            choice: 'template',
            templateId: 'development',
            plan: {
                templateId: 'development',
                codeWork: true,
                members: { coder: 'team/coder', reviewer: 'team/reviewer' },
                codex: { coding: 'auto', review: 'auto' },
            },
        },
    }, headers);
    assert.equal(upgradeRes.code, 200, 'Upgrading a plain ticket to orchestration via /marshal/tasks/plan must succeed');
    const upgradedView = upgradeRes.data.tasks.find(t => t.id === plainTask.id);
    assert.ok(upgradedView.workflow, 'Upgraded plain card must now carry workflow');
    assert.equal(upgradedView.workflow.leaderName, '丞相');
});

test('shipped client/index.js unlocks Agent switchers & live-steering editor on RUNNING and FAILED tickets', async () => {
    const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');

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
            useMemo(fn) { currentHookIdx++; return fn(); },
            useCallback(fn) { currentHookIdx++; return fn; },
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
                try { rendered = node.type(node.props || {}); }
                finally { currentInstance = prevInst; currentHookIdx = prevIdx; }
                return expand(rendered, compKey);
            }
            const rawCh = node.props?.children;
            const childArr = Array.isArray(rawCh) ? rawCh : (rawCh !== undefined ? [rawCh] : []);
            return {
                tag: String(node.type),
                props: node.props || {},
                children: childArr.map((c, i) => expand(c, pathKey + '.' + String(node.type) + '.' + i)).filter(c => c !== null && c !== undefined),
            };
        };
        const flushEffects = () => {
            while (pendingEffects.length > 0) {
                const fn = pendingEffects.shift();
                try { fn(); } catch {}
            }
        };
        return { React, expand, flushEffects };
    }

    const { React, expand, flushEffects } = createMiniReact();
    let loadedModule = null;
    const updatePayloads = [];
    const agentConfigPayloads = [];

    const runningWfTask = {
        id: 'task-running-1',
        ticketNo: 'GD-00011',
        title: '[开发中] 正在运行的编排任务',
        description: '原始描述内容',
        prompt: '原始描述内容',
        status: 'running',
        openExecution: true,
        createdAt: Date.now() - 20_000,
        updatedAt: Date.now() - 2_000,
        taskRoom: { id: '11111111-2222-4333-8444-555555555555', workspaceId: 'ws-1', title: '[GD-00011] 正在运行的编排任务', closed: false, lastSeq: 3 },
        workflow: {
            leaderId: 'team/lead',
            leaderName: '丞相',
            workspaceId: 'ws-1',
            choice: 'template',
            templateId: 'development',
            state: 'running',
            phase: 'coding',
            planConfirmed: true,
            plan: {
                templateId: 'development',
                groupTemplate: 'delivery',
                codeWork: true,
                members: { coder: 'team/coder', reviewer: 'team/reviewer' },
                codex: { coding: 'auto', review: 'auto' },
            },
        },
    };
    const failedPlainTask = {
        id: 'task-failed-2',
        ticketNo: 'GD-00012',
        title: '[故障] 已经失败的单卡工单',
        description: '之前执行失败的工单',
        prompt: '之前执行失败的工单',
        status: 'failed',
        runCount: 2,
        result: 'failed',
        tags: [{ name: '智能体:工部尚书' }],
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 5_000,
    };

    const mockFetch = async (url, init = {}) => {
        const u = String(url);
        const method = init.method || 'GET';
        if (u.endsWith('/marshal/setup')) return Response.json({ ok: true, ready: true });
        if (u.includes('api/task-board/model-catalog')) {
            return new Response(JSON.stringify({
                defaultModel: { provider: 'deepseek-account', model: 'deepseek-chat' },
                groups: [{
                    id: 'deepseek-account',
                    name: 'DeepSeek',
                    models: [
                        { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] } },
                        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] } },
                    ],
                }],
            }), { status: 200 });
        }
        if (u.includes('marshal/tasks/state')) {
            return new Response(JSON.stringify({ ok: true, tasks: [runningWfTask, failedPlainTask], sessionDefaultPermission: 'workspace-write' }), { status: 200 });
        }
        if (u.includes('marshal/tasks/orchestration')) {
            return new Response(JSON.stringify({
                ok: true,
                memoryAvailable: true,
                templates: [{
                    id: 'development', name: '开发交付', groupTemplate: 'delivery', stages: ['设计', '编码', '审查'],
                    roles: [{ id: 'coder', name: 'Coder', required: true }, { id: 'reviewer', name: 'Reviewer', required: true }],
                    codingRoles: [{ id: 'coder', name: 'Coder', required: true }, { id: 'reviewer', name: 'Reviewer', required: true }],
                }],
                plainTemplate: { id: 'none', name: '普通任务', roles: [], codingRoles: [] },
                groupTemplates: [{ id: 'delivery', name: '分阶段交付', count: 3 }],
                leaders: [
                    { id: 'team/lead', name: '丞相', workspaceId: 'ws-1', permission: 'workspace-write', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'medium' },
                    { id: 'team/coder', name: '工部尚书', workspaceId: 'ws-1', permission: 'workspace-write', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'high' },
                    { id: 'team/reviewer', name: '刑部尚书', workspaceId: 'ws-1', permission: 'read-only', model: 'deepseek-account/deepseek-chat', reasoningEffort: 'high' },
                ],
                codexModels: [{ id: 'codex:openai:gpt-5-codex', agent: 'codex', provider: 'openai', model: 'gpt-5-codex', work: true, reasoningEfforts: ['low', 'medium', 'high'] }],
            }), { status: 200 });
        }
        if (u.includes('marshal/task-rooms/workspaces')) {
            return new Response(JSON.stringify({ ok: true, workspaces: [{ id: 'ws-1', name: 'dsh-marshal', path: '/repo' }] }), { status: 200 });
        }
        if (u.includes('marshal/rosters/state')) {
            return new Response(JSON.stringify({ ok: true, rosters: {} }), { status: 200 });
        }
        if (u.includes('marshal/tasks/agent-configs') && method === 'POST') {
            agentConfigPayloads.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ ok: true, notice: '⚙️ 配置变更：已切换模型 —— 将在下一轮对话/阶段生效。', tasks: [runningWfTask, failedPlainTask] }), { status: 200 });
        }
        if (u.includes('marshal/tasks/update') && method === 'POST') {
            updatePayloads.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ ok: true, steered: true, tasks: [runningWfTask, failedPlainTask] }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    class MockMutationObserver { observe() {} disconnect() {} }
    const noopTimer = () => 1;
    const win = {
        location: new URL('http://127.0.0.1:62578/'),
        fetch: mockFetch,
        MutationObserver: MockMutationObserver,
        addEventListener() {},
        removeEventListener() {},
        requestAnimationFrame: fn => fn(),
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        __ModuleLoader__: { load(def) { loadedModule = def; } },
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
        window: win, globalThis: win, document: doc, MutationObserver: MockMutationObserver,
        fetch: win.fetch, URL, URLSearchParams, Response, AbortController, TextDecoder, Blob, Intl, performance,
        setTimeout: noopTimer, clearTimeout() {}, setInterval: noopTimer, clearInterval() {},
        requestAnimationFrame: fn => fn(), console,
    });

    const pluginObj = loadedModule.factory(() => React);
    let RegisteredMainPanel;
    pluginObj.apply({
        effect() {}, inject() {},
        slots: {
            inject(_slot, fn) { return fn(); },
            register(meta, Comp) { if (meta.name === 'main') RegisteredMainPanel = Comp; return () => {}; },
        },
    });

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

    expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));
    flushEffects();
    await sleep(60);
    let tree = expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));
    flushEffects();
    await sleep(30);
    tree = expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));

    // A. Click the RUNNING workflow ticket!
    const runningCardNode = collectAll(tree, n => n.tag === 'article' && n.props?.id === 'marshal-ticket-task-running-1')[0];
    assert.ok(runningCardNode, 'Running ticket card must render');
    runningCardNode.props.onClick();
    flushEffects();
    tree = expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));

    // Verify Agent switchers are ENABLED (not disabled!) even while running!
    const selects = collectAll(tree, n => n.tag === 'select');
    const coderModelSelect = selects.find(s => s.props?.['aria-label'] === 'Coder 模型');
    const coderThinkSelect = selects.find(s => s.props?.['aria-label'] === 'Coder 思考模式');
    assert.ok(coderModelSelect && coderThinkSelect);
    assert.equal(coderModelSelect.props.disabled, false, 'Coder model select must NOT be disabled while running');
    assert.equal(coderThinkSelect.props.disabled, false, 'Coder thinking select must NOT be disabled while running');
    assert.match(textOf(tree), /运行中可随时切换 · 下一轮生效并通知工单群/);

    // Switch Coder model while running!
    coderModelSelect.props.onChange({ target: { value: 'deepseek-account/deepseek-reasoner' } });
    await sleep(30);
    assert.equal(agentConfigPayloads.length, 1);
    assert.deepEqual(agentConfigPayloads[0], {
        taskId: 'task-running-1',
        agentConfigs: { coder: { model: 'deepseek-account/deepseek-reasoner' } },
    });

    // Click "实时编辑" button on the running ticket!
    const liveEditBtn = collectAll(tree, n => n.tag === 'button' && textOf(n) === '实时编辑')[0];
    assert.ok(liveEditBtn, 'Running ticket Drawer must display 实时编辑 button');
    liveEditBtn.props.onClick();
    tree = expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));

    assert.match(textOf(tree), /立即以插话形式将修改后的内容发送给正在运行的 Agent/);
    const textareas = collectAll(tree, n => n.tag === 'textarea');
    assert.ok(textareas.length >= 2);
    // Modify ONLY description and click "保存并立即插话发送" -> verify diff-only patch + steerNow: true!
    textareas[0].props.onChange({ target: { value: '运行中追加的插话描述！' } });
    tree = expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));
    const saveSteerBtn = collectAll(tree, n => n.tag === 'button' && textOf(n) === '保存并立即插话发送')[0];
    assert.ok(saveSteerBtn, 'Running editor must show 保存并立即插话发送 button');
    saveSteerBtn.props.onClick();
    await sleep(30);
    assert.equal(updatePayloads.length, 1);
    assert.deepEqual(updatePayloads[0], {
        taskId: 'task-running-1',
        description: '运行中追加的插话描述！',
        steerNow: true,
    }, 'saveDrawerEdit must send ONLY changed fields plus steerNow: true');

    // B. Click the FAILED plain ticket -> verify model/thinking selects + 编辑 + 启用编排 are all enabled!
    const failedCardNode = collectAll(tree, n => n.tag === 'article' && n.props?.id === 'marshal-ticket-task-failed-2')[0];
    assert.ok(failedCardNode, 'Failed plain ticket card must render');
    failedCardNode.props.onClick();
    flushEffects();
    tree = expand(React.createElement(RegisteredMainPanel, { marshalContext: {}, openPanel() {} }));

    const failedSelects = collectAll(tree, n => n.tag === 'select');
    const plainModelSelect = failedSelects.find(s => s.props?.['aria-label'] === '工单模型');
    const plainThinkSelect = failedSelects.find(s => s.props?.['aria-label'] === '工单思考模式');
    assert.ok(plainModelSelect && plainThinkSelect);
    assert.equal(plainModelSelect.props.disabled, false);
    assert.equal(plainThinkSelect.props.disabled, false);

    const enableOrchBtn = collectAll(tree, n => n.tag === 'button' && textOf(n) === '启用编排')[0];
    assert.ok(enableOrchBtn, 'Plain card Drawer must offer 启用编排 button so any ticket type can configure multi-agent orchestration');
});
