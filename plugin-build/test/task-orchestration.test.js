import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { mountGroups } from '../lib/src/groups/mount.js';
import { DSH_ACCOUNT_ORIGIN } from '../lib/src/hub/account.js';
import { setImmediate } from 'node:timers/promises';
import { createTaskOrchestration } from '../lib/src/groups/task-orchestration.js';
import { parsePullRequest, readPullRequest } from '../lib/src/groups/pr-material.js';
import { createLocalBoard } from '../lib/src/groups/local-board.js';
import { createAgentMemoryService } from '../lib/src/memory/agent-memory.js';

const pr = 'https://github.com/example/widgets/pull/32';
const gitee = 'https://gitee.com/example/widgets/pulls/32';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const dsh = { id: 'dsh:fixture:review', agent: 'dsh', provider: 'fixture', model: 'review' };
const codex = { id: 'codex:openai:review', agent: 'codex', provider: 'openai', model: 'review' };
const leaderId = 'team/leader';

function fixture(t, options = {}) {
    const root = mkdtempSync(join(tmpdir(), 'marshal-task-workflow-'));
    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const leader = { id: 'leader', name: '负责人', model: 'fixture/review', brief: '复核证据' };
    const team = { id: 'team', workspaceId: 'workspace-a', members: [leader] };
    const file = join(root, 'workflows.json');
    const args = {
        file, memory, inventory: () => ({ teams: [team] }),
        readPr: async url => ({ url, base, head, diff: 'PINNED_DIFF', omitted: [] }),
        port: { catalog: async () => [dsh, codex], dispose() {}, run: options.run },
        startLeader: options.startLeader,
    };
    const orchestration = createTaskOrchestration(args);
    const board = createLocalBoard(join(root, 'tasks.json'));
    t.after(() => { orchestration.dispose(); memory.store.close(); rmSync(root, { recursive: true, force: true }); });
    const create = async (body, id = 'task-id') => {
        const prepared = orchestration.prepare({ leaderId, ...body });
        const snapshot = await board.apply(id, { kind: 'create', id, input: { title: 'Work card', description: 'Review source' } });
        const task = snapshot.tasks.find(item => item.id === id);
        orchestration.attach('local', task.id, prepared);
        return task;
    };
    const complete = async (task, expected) => {
        for (let i = 0; i < 12 && orchestration.view('local', task.id).state === 'running'; i++) await setImmediate();
        const view = orchestration.view('local', task.id);
        assert.equal(view.state, expected, view.error);
        return view;
    };
    return { orchestration, create, complete, memory, team, args };
}

test('pins both providers to immutable revisions and bounds what reaches the reviewers', async () => {
    for (const link of [pr, gitee]) {
        const requests = [];
        const result = await readPullRequest(link, AbortSignal.timeout(1000), {
            env: {},
            fetchImpl: async (url, init) => {
                requests.push(url);
                assert.equal(init.redirect, 'error');
                return Response.json(requests.length === 1
                    ? { base: { sha: base }, head: { sha: head }, changed_files: 2 }
                    : { files: [{ filename: 'file.ts', patch: '@@ -1 +1 @@\n-old\n+new' }, { filename: 'graphic.png' }] });
            },
        });
        assert.equal(result.head, head);
        assert.match(requests[1].pathname, new RegExp('/compare/' + base + '\\.\\.\\.' + head + '$'));
        assert.match(result.diff, /file\.ts/);
        assert.deepEqual(result.omitted, ['graphic.png']);
    }
    assert.equal(parsePullRequest(pr + '/files?code=2#diff').url, pr);
    for (const link of ['http://github.com/example/widgets/pull/32', 'https://github.com@internal/pull/32',
        'https://gitee.com/../widgets/pulls/32', 'https://github.com/example/widgets/pull/32/settings']) {
        assert.throws(() => parsePullRequest(link), { code: 'invalid-pr' });
    }
});

test('runs independent reviews, reads peer handoffs from Workspace, and retains the finished report after reload', async t => {
    const calls = [];
    let f;
    const reviewers = async (model, prompt) => {
        calls.push({ model, prompt });
        if (prompt.startsWith('独立审查')) {
            assert.doesNotMatch(prompt, /(?:dsh|codex)-finding/);
            assert.match(prompt, /PINNED_DIFF/);
            return model.agent + '-finding';
        }
        if (prompt.startsWith('复核')) {
            const peer = model.agent === 'dsh' ? 'codex' : 'dsh';
            assert.match(prompt, new RegExp(peer + '-finding'));
            assert.ok(f.memory.store.list('workspace', 'workspace-a').some(item => item.content === peer + '-finding'));
            return model.agent + '-crosscheck';
        }
        assert.equal(model.agent, 'dsh');
        assert.match(prompt, /dsh-crosscheck/);
        assert.match(prompt, /codex-crosscheck/);
        return '## Verified review report';
    };
    f = fixture(t, { run: reviewers });
    const card = await f.create({ choice: 'template', templateId: 'pr-review', prUrl: pr });
    f.orchestration.start('local', card);
    f.orchestration.start('local', card);
    assert.throws(() => f.orchestration.assertIdle('local', card.id), { code: 'task-running' });
    const view = await f.complete(card, 'done');
    assert.equal(calls.length, 5);
    assert.equal(view.pr.head, head);
    assert.equal(new Set(view.handoffs).size, 5);
    assert.equal(f.memory.store.list('workspace', 'workspace-a').length, 5);
    assert.equal(f.memory.store.list('workspace', 'another-workspace').length, 0);
    assert.equal(f.memory.store.list('agent', 'leader').length, 0);
    assert.equal(f.memory.store.list('global', 'global').length, 0);
    assert.equal(f.orchestration.report('local', card.id), '## Verified review report');
    assert.equal(f.orchestration.report('host', card.id), undefined);
    const reloaded = createTaskOrchestration(f.args);
    assert.equal(reloaded.view('local', card.id).state, 'done');
    assert.equal(reloaded.report('local', card.id), '## Verified review report');
});

test('supports five templates, Leader selection, and opting out through the bound Agent session', async t => {
    const received = [];
    let choice = 'none';
    const f = fixture(t, {
        run: async (_model, prompt) => {
            assert.match(prompt, /模板 ID/);
            assert.doesNotMatch(prompt, /"id":"pr-review"/);
            return choice;
        },
        startLeader: async (leader, text) => {
            assert.equal(leader.workspaceId, 'workspace-a');
            assert.equal(leader.memberId, 'leader');
            received.push(JSON.parse(text));
            return 'resident-leader-session';
        },
    });
    assert.equal(f.orchestration.catalog().templates.length, 5);
    assert.throws(() => f.orchestration.prepare({ leaderId, choice: 'template', templateId: 'pr-review' }), { code: 'invalid-pr' });
    const first = await f.create({ choice: 'leader' }, 'choose-none');
    f.orchestration.start('local', first);
    assert.equal((await f.complete(first, 'handed-off')).selected, 'none');
    choice = 'incident';
    const second = await f.create({ choice: 'leader' }, 'choose-incident');
    f.orchestration.start('local', second);
    const handoff = await f.complete(second, 'handed-off');
    assert.equal(handoff.selected, 'incident');
    assert.equal(handoff.sessionId, 'resident-leader-session');
    assert.deepEqual(received.map(item => item.execution), ['普通任务', '故障排查']);
    assert.equal(received[1].stages.length, 3);
});

test('a failed reviewer blocks synthesis and an explicit retry publishes its own handoffs', async t => {
    let fail = true;
    let summary = 0;
    const f = fixture(t, { run: async (model, prompt) => {
        if (fail && model.agent === 'codex') throw Object.assign(new Error('private upstream detail'), { code: 'fixture-failure' });
        if (prompt.includes('从允许列表中选一个模板 ID')) return 'pr-review';
        if (prompt.startsWith('你是任务 Leader')) summary++;
        return model.agent + (prompt.startsWith('复核') ? '-cross' : '-output');
    } });
    const card = await f.create({ choice: 'leader', prUrl: pr });
    f.orchestration.start('local', card);
    const unsuccessful = await f.complete(card, 'failed');
    assert.doesNotMatch(unsuccessful.error, /private upstream detail/);
    assert.equal(summary, 0);
    assert.equal(f.orchestration.report('local', card.id), undefined);
    fail = false;
    f.orchestration.start('local', card);
    const finished = await f.complete(card, 'done');
    assert.notEqual(finished.runId, unsuccessful.runId);
    assert.equal(summary, 1);
    f.team.workspaceId = 'workspace-b';
    const displaced = { id: 'displaced', title: 'Old scope task' };
    f.team.workspaceId = 'workspace-a';
    f.orchestration.attach('local', displaced.id, f.orchestration.prepare({ leaderId, choice: 'none' }));
    f.team.workspaceId = 'workspace-b';
    assert.throws(() => f.orchestration.start('local', displaced), { code: 'leader-unbound' });
});

test('desktop board routes enforce workspace authorization and launch the selected resident Leader', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-board-routes-'));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;
    const ledgerDir = join(root, 'dsh-agents');
    mkdirSync(ledgerDir);
    writeFileSync(join(ledgerDir, 'ledger.json'), JSON.stringify({ teams: [
        { id: 'team', name: 'Main', workspaceId: 'workspace-a', members: [{ id: 'leader', name: '负责人' }] },
        { id: 'foreign', name: 'Remote', workspaceId: 'workspace-b', ownerId: 'different-operator',
            members: [{ id: 'other', name: '其他人' }] },
    ] }));
    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const routes = new Map();
    const hostBoard = createLocalBoard(join(root, 'host-board.json'));
    const disposers = [];
    const prompts = [];
    const origin = 'http://127.0.0.1:29310';
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, origin + '/dsh-agents/api/run');
        assert.deepEqual(JSON.parse(init.body), { teamId: 'team', memberId: 'leader' });
        return Response.json({ run: { sessionId: 'leader-session' } });
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
            if (name === 'deepseekAccount') return {
                getPlatformSession: async () => ({ userId: 'local-user', origin: DSH_ACCOUNT_ORIGIN }),
            };
        },
        sessionController: { async prompt(input) { prompts.push(input); } },
        inject(names, callback) {
            if (names[0] === 'taskBoard') callback({
                effect: setup => disposers.push(setup()),
                taskBoard: {
                    snapshot: hostBoard.snapshot,
                    apply: (requestId, action) => {
                        assert.notEqual(action.kind, 'run', 'Workflow must own task execution');
                        return hostBoard.apply(requestId, { ...action, id: undefined });
                    },
                },
            });
            if (names[0] === 'webServer') {
                callback({
                    effect: setup => disposers.push(setup()),
                    webServer: {
                        getOrigin: () => origin,
                        register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
                    },
                });
            }
        },
        effect: setup => disposers.push(setup()),
    }, { groupsRoot: join(root, 'groups'), memoryRoot: join(root, 'memory'), agents: ['dsh'], deviceId: 'desktop' }, { memory });

    const request = async (path, body, headers = {}) => {
        const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
            headers: { origin, ...headers }, url: path,
            method: body === undefined ? 'GET' : 'POST', socket: { remoteAddress: '127.0.0.1' },
        });
        let response;
        const responseHeaders = {};
        const res = {
            setHeader(name, value) { responseHeaders[name] = value; },
            writeHead(code, headers) { response = { code, headers: { ...responseHeaders, ...headers } }; },
            end(value) { response.data = value ? JSON.parse(value) : undefined; },
        };
        await routes.get(path.split('?')[0])(req, res);
        return response;
    };
    assert.equal((await request('/marshal/tasks/orchestration')).code, 401);
    const opened = await request('/marshal/memory/session', {}, { 'x-marshal-memory': '1' });
    const cookies = opened.headers['set-cookie'].map(line => line.split(';')[0]);
    const headers = { cookie: cookies.join('; '), 'x-marshal-csrf': cookies[1].split('=')[1] };
    const catalog = await request('/marshal/tasks/orchestration', undefined, headers);
    assert.deepEqual(catalog.data.leaders.map(leader => leader.id), ['team/leader']);

    const input = { title: '测试工作区交接', orchestration: { leaderId, choice: 'none' } };
    assert.equal((await request('/marshal/tasks/create', input)).code, 401);
    const forbidden = await request('/marshal/tasks/create', { ...input, orchestration: { leaderId: 'foreign/other', choice: 'none' } }, headers);
    assert.equal(forbidden.code, 403);
    const created = await request('/marshal/tasks/create', input, headers);
    assert.equal(created.code, 200, JSON.stringify(created.data));
    const task = created.data.tasks[0];
    assert.equal(task.workflow.workspaceId, 'workspace-a');
    assert.equal((await request('/marshal/tasks/run', { taskId: task.id })).code, 401);
    assert.equal((await request('/marshal/tasks/run', { taskId: task.id }, headers)).code, 200);
    await setImmediate();
    const state = await request('/marshal/tasks/state', undefined, headers);
    assert.equal(state.data.tasks[0].workflow.state, 'handed-off');
    assert.equal(state.data.tasks[0].sessionId, 'leader-session');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].content[0].text, /测试工作区交接/);
    assert.equal(memory.store.list('workspace', 'workspace-a').length, 1);
    assert.equal((await request('/marshal/tasks/state')).data.tasks[0].workflow, undefined);
});
