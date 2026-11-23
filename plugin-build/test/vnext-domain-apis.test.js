import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentTaskStore } from '../lib/src/groups/agent-tasks-store.js';
import { encodeAgentTrace } from '../lib/src/groups/agent-trace.js';
import { getTaskDagNodeDetail, projectTaskDag } from '../lib/src/groups/dag-projector.js';
import { createMarshalEventBus } from '../lib/src/groups/event-bus.js';
import { buildIncidentsSummary } from '../lib/src/groups/incident-monitor.js';
import { mountGroups } from '../lib/src/groups/mount.js';
import { createTaskRoomStore } from '../lib/src/groups/task-room-store.js';
import { createTaskRooms } from '../lib/src/groups/task-rooms.js';
import { dshAccountHash, DSH_ACCOUNT_ORIGIN } from '../lib/src/hub/account.js';

const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const origin = 'http://127.0.0.1:21080';
const deviceId = 'node-one';
const agentKey = `${deviceId}/squad/coder`;
const owner = 'vnext-owner';
const ownerId = dshAccountHash(owner);
const draft = { agentKey, type: 'direct', title: 'Verify release checklist', sessionId: 'main' };

function fixture({ tasks = [], workflows = [], proposals = [], host = undefined, prompt, history, runs, memory = {} } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'marshal-vnext-'));
    const savedHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;
    const materialize = (file, data) => writeFileSync(join(root, file), JSON.stringify(data));
    mkdirSync(join(root, 'dsh-agents'));
    mkdirSync(join(root, 'storages'));
    materialize('storages/workspace.json', { tables: { workspaces: { ws: {}, private: {} } } });
    materialize('dsh-agents/ledger.json', {
        teams: [{ id: 'squad', name: 'Build', workspaceId: 'ws', members: [{ id: 'coder', name: 'Coder' }] },
            { id: 'foreign', name: 'Foreign', workspaceId: 'private', ownerId: 'different-owner', members: [{ id: 'other', name: 'Other' }] }],
        runs: runs ?? [{ teamId: 'squad', memberId: 'coder', sessionId: 'old', createdAt: 1, status: 'settled' },
            { teamId: 'squad', memberId: 'coder', sessionId: 'main', createdAt: 2, status: 'running', purpose: 'direct' }],
    });
    materialize('tasks.json', { version: 1, tasks });
    materialize('task-orchestration.json', { version: 1, tasks: workflows });
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'task-rooms.sqlite')), deviceId });
    const events = [];
    const eventBus = createMarshalEventBus();
    eventBus.subscribe((topic, payload) => events.push([topic, payload]));
    const calls = [];
    const routes = new Map();
    const dispose = [];
    const effect = setup => dispose.push(setup());
    const services = { webServer: { getOrigin: () => origin, register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
    } }, ...(host ? { taskBoard: host } : {}) };
    const ctx = {
        effect, inject([name], register) { if (services[name]) register({ effect, [name]: services[name] }); },
        get(name) {
            if (name === 'deepseekAccount') return { getPlatformSession: async () => ({ userId: owner, origin: DSH_ACCOUNT_ORIGIN }) };
        },
        sessionController: {
            ...(history ? { async *follow({ address }) {
                yield { type: 'snapshot', cursor: 20, records: history(address.sessionId).map(event => ({ event })) };
            }, async page() { return { records: [] }; } } : {}),
            async list() { return { items: [{ sessionId: 'main', title: 'Resident' },
                { sessionId: 'child', parentSessionId: 'main', title: 'Subagent', status: 'running' },
                { sessionId: 'fork', forkedFromId: 'child', title: 'Fork', status: 'done' },
                { sessionId: 'other', parentSessionId: 'foreign' }] }; },
            async prompt(input, signal) { calls.push(input); return prompt?.(input, signal); },
        },
    };
    const mount = () => mountGroups(ctx, { deviceId, agents: ['dsh'], groupsRoot: root, memoryRoot: join(root, 'memory') },
        { eventBus, memory: { listProposals: () => proposals, ...memory } });
    const unmount = () => { for (const fn of dispose.splice(0).reverse()) fn?.(); };
    mount();
    const request = async (method, url, body, headers = {}, remoteAddress = '127.0.0.1') => {
        const req = { method, url, headers: { host: '127.0.0.1:21080', origin, ...headers }, socket: { remoteAddress },
            async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
        const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; },
            writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
            end(content) { this.body = JSON.parse(content); } };
        await routes.get(url.split('?')[0]).handler(req, res);
        return res;
    };
    const signIn = async () => {
        const res = await request('POST', '/marshal/memory/session', undefined, { 'x-marshal-memory': '1' });
        assert.equal(res.status, 200);
        const cookies = res.headers['set-cookie'].map(value => value.split(';')[0]);
        return { cookie: cookies.join('; '), 'x-marshal-csrf': cookies[1].split('=')[1] };
    };
    return { root, rooms, events, calls, request, signIn, remount() { unmount(); mount(); }, close() {
        unmount(); rooms.close();
        if (savedHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = savedHome;
        rmSync(root, { recursive: true, force: true });
    } };
}

const endpoints = [
    ['GET', '/marshal/desktop/overview'], ['GET', '/marshal/agent-tasks?agentKey=coder'],
    ['POST', '/marshal/agent-tasks/create', draft], ['POST', '/marshal/agent-tasks/update', { id: 'task', title: 'changed' }],
    ['POST', '/marshal/agent-tasks/delete', { id: 'task' }], ['GET', '/marshal/agent-direct-sessions?agentKey=coder'],
    ['POST', '/marshal/agents/guidance-sync', { agentKey, guidanceText: 'continue' }],
    ['GET', '/marshal/tasks/dag?taskId=task'], ['GET', '/marshal/tasks/dag/node?taskId=task&nodeId=intake'],
    ['GET', '/marshal/incidents/summary'], ['POST', '/marshal/tasks/create', { title: 'Desktop', cascadePath: ['a', 'b', 'c'] }],
];

test('all 11 vNext routes deny unauthorized access and denied writes are inert', async () => {
    const app = fixture();
    try {
        const session = await app.signIn();
        for (const [method, path, body] of endpoints) {
            assert.equal((await app.request(method, path, body)).status, 403, path);
            assert.equal((await app.request(method, path, body, session, '192.0.2.1')).status, 403, path);
            if (method === 'POST') {
                const denied = await app.request(method, path, body, { cookie: session.cookie });
                assert.equal(denied.status, 403, path);
                assert.equal(denied.body.code, 'memory-csrf-mismatch', path);
            }
        }
        assert.deepEqual(app.events, []);
        assert.deepEqual(app.calls, []);
        assert.throws(() => readFileSync(join(app.root, 'agent-tasks.json')), { code: 'ENOENT' });
        assert.deepEqual(JSON.parse(readFileSync(join(app.root, 'tasks.json'))).tasks, []);
        assert.equal((await app.request('GET', '/marshal/agent-tasks?agentKey=other', undefined, session)).status, 403);
    } finally { app.close(); }
});

test('personal tasks round-trip through disk and project live assigned and session-linked tickets', async () => {
    const tasks = [{ id: 'assigned', title: 'Assigned', tags: [{ name: '@Coder' }], status: 'waiting' },
        { id: 'session', title: 'Same session', status: 'running', executions: [{ sessionId: 'old' }] },
        { id: 'private', title: 'Private', status: 'running', workspaceId: 'private', tags: [{ name: '@Coder' }] }];
    const app = fixture({ tasks });
    try {
        const headers = await app.signIn();
        const created = await app.request('POST', '/marshal/agent-tasks/create', { ...draft, agentKey: 'squad/coder',
            subSessions: [{ id: 'attached', role: 'assistant', status: 'queued', title: 'Notes' }] }, headers);
        assert.equal(created.status, 200, JSON.stringify(created.body));
        const id = created.body.task.id;
        assert.equal(created.body.task.agentKey, agentKey);
        assert.equal(createAgentTaskStore({ dataDir: app.root }).listTasks('coder')[0].status, 'queued');
        const updated = await app.request('POST', '/marshal/agent-tasks/update', { id, patch: { status: 'running', lastSummary: 'checked' } }, headers);
        assert.equal(updated.status, 200);
        const list = await app.request('GET', '/marshal/agent-tasks?agentKey=coder', undefined, headers);
        assert.deepEqual(new Map(list.body.tasks.map(row => [row.linkedTicketId ?? row.id, row.status])),
            new Map([[id, 'running'], ['assigned', 'review'], ['session', 'running']]));
        const sessions = await app.request('GET', '/marshal/agent-direct-sessions?agentKey=squad/coder', undefined, headers);
        assert.equal(sessions.body.mainSession.id, 'main');
        assert.deepEqual(sessions.body.subSessions.map(sub => [sub.id, sub.role]), [['child', 'subagent'], ['fork', 'fork']]);
        assert.equal((await app.request('POST', '/marshal/agent-tasks/delete', { id: list.body.tasks.find(row => row.linkedTicketId === 'assigned').id }, headers)).status, 404);
        assert.equal((await app.request('POST', '/marshal/agent-tasks/delete', { id }, headers)).status, 200);
        assert.deepEqual(createAgentTaskStore({ dataDir: app.root }).listTasks(agentKey), []);
        assert.deepEqual(JSON.parse(readFileSync(join(app.root, 'tasks.json'))).tasks, tasks);
        assert.deepEqual(app.events.map(([topic]) => topic), Array(3).fill(['tasks.changed', 'agents.changed']).flat());
    } finally { app.close(); }
});

test('guidance appends to the actual room, wakes through revise, and queues direct prompts only to owned sessions', async () => {
    const card = { id: 'ticket', workspaceId: 'ws', title: 'Release', status: 'review', prompt: 'Release baseline' };
    let rejectPrompt = false;
    const initialPrompts = [];
    const board = { snapshot: () => ({ tasks: [card] }), async apply(_id, action) {
        if (action.kind === 'update') Object.assign(card, action.patch);
        else {
            assert.equal(action.kind, 'run');
            card.status = 'running';
            initialPrompts.push(card.prompt);
            card.executions = [{ id: 'first-execution', startedAt: 1, sessionId: 'ticket-executor' }];
        }
        return this.snapshot();
    } };
    const app = fixture({ host: board, prompt: (_request, signal) => {
        assert.ok(signal instanceof AbortSignal);
        if (rejectPrompt) throw new Error('driver unavailable');
    } });
    try {
        const headers = await app.signIn();
        const room = app.rooms.ensure('host', card, 'ws', ownerId);
        const linked = await app.request('POST', '/marshal/agent-tasks/create', { agentKey, type: 'ticket', title: card.title, linkedTicketId: card.id }, headers);
        assert.equal(linked.status, 200, JSON.stringify(linked.body));
        const id = linked.body.task.id;
        app.events.length = 0;
        const appendOnly = await app.request('POST', '/marshal/agents/guidance-sync',
            { agentKey, taskIds: [id], guidanceText: 'Keep current state', wakeTicket: false }, headers);
        assert.equal(appendOnly.status, 200, JSON.stringify(appendOnly.body));
        assert.equal(appendOnly.body.deliveries[0].woken, undefined);
        const page = await app.rooms.page(room.id, {});
        assert.deepEqual(page.records.map(r => [r.kind, r.phase]), [['user', 'guidance']]);
        assert.match(page.records[0].text, /Keep current state/);
        assert.deepEqual(app.events.find(([topic]) => topic === 'room.message')?.[1], { roomId: room.id, seq: 1 });
        for (const event of ['tasks.changed', 'agents.changed', 'incidents.changed']) assert.ok(app.events.some(([topic]) => topic === event));
        assert.equal(card.status, 'review');
        assert.deepEqual(initialPrompts, []);
        const awakened = await app.request('POST', '/marshal/agents/guidance-sync',
            { agentKey, targetTicketId: card.id, taskIds: [id], guidanceText: 'Proceed with the new release checklist' }, headers);
        assert.equal(awakened.status, 200, JSON.stringify(awakened.body));
        assert.equal(awakened.body.deliveries[0].woken, true);
        assert.equal((await app.rooms.page(room.id, {})).records.at(-1).phase, 'revise');
        assert.equal(card.status, 'running');
        assert.equal(card.executions[0].sessionId, 'ticket-executor');
        assert.equal(initialPrompts.length, 1);
        assert.ok(initialPrompts[0].includes(awakened.body.summary));
        const store = createAgentTaskStore({ dataDir: app.root });
        assert.match(store.getTask(id).lastSummary, /Proceed with the new release checklist/);
        assert.ok(store.getTask(id).lastSyncAt > 0);

        const direct = (await app.request('POST', '/marshal/agent-tasks/create', { ...draft, sessionId: 'child' }, headers)).body.task;
        app.events.length = 0;
        const sent = await app.request('POST', '/marshal/agents/guidance-sync',
            { agentKey, taskIds: [direct.id], guidanceText: 'Deploy to staging' }, headers);
        assert.equal(sent.status, 200, JSON.stringify(sent.body));
        assert.deepEqual(app.calls.map(call => [call.sessionId, call.mode]), [['child', 'queue']]);
        assert.match(app.calls[0].content[0].text, /## 主人指示\n\nDeploy to staging/);
        assert.match(app.calls[0].content[0].text, /Verify release checklist/);
        assert.equal(store.getTask(direct.id).lastSummary, sent.body.summary);
        assert.deepEqual(app.events.map(([topic]) => topic), ['agents.changed', 'tasks.changed']);
        rejectPrompt = true;
        app.events.length = 0;
        const rejected = await app.request('POST', '/marshal/agents/guidance-sync', { agentKey, taskIds: [direct.id], guidanceText: 'Retry' }, headers);
        assert.equal(rejected.status, 502);
        assert.equal(rejected.body.code, 'direct-guidance-rejected');
        assert.equal(store.getTask(direct.id).lastSummary, sent.body.summary);
        assert.deepEqual(app.events, []);
        const forged = (await app.request('POST', '/marshal/agent-tasks/create', { ...draft, sessionId: 'other' }, headers)).body.task;
        assert.equal((await app.request('POST', '/marshal/agents/guidance-sync', { agentKey, taskIds: [forged.id], guidanceText: 'unsafe' }, headers)).status, 403);
        assert.equal(app.calls.length, 2);
    } finally { app.close(); }
});

test('DAG uses real sequential run records, preserves rework and resolves actual patch and trace detail', async () => {
    const runId = randomUUID();
    const card = { id: 'work', title: 'Development', status: 'review', workspaceId: 'ws' };
    const app = fixture({ tasks: [card], workflows: [{ source: 'local', taskId: card.id, workspaceId: 'ws', runId,
        leaderId: 'squad/coder', state: 'done', plan: { codex: { coding: 'auto', review: 'auto' } } }] });
    try {
        const headers = await app.signIn();
        const room = app.rooms.ensure('local', card, 'ws', ownerId);
        const requestId = randomUUID();
        const trace = { model: 'actual-model', durationMs: 350, usage: { inputTokens: 12, outputTokens: 3 } };
        const diff = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n';
        const rows = [
            ['agent', 'designing', 'Design', 'Leader'], ['agent', 'coding', 'Delegate', 'Coder'],
            ['status', 'coding-assistant', '已请求子 Agent actual-model', 'Codex · Coder', requestId],
            ['agent', 'coding-assistant', encodeAgentTrace('Implementation', trace), 'Codex · Coder', requestId],
            ['status', 'development-patch', diff, 'Marshal', undefined, 'a'.repeat(64)],
            ['agent', 'dev-reviewing', 'Reviewer verdict', 'Reviewer'],
            ['status', 'coding', 'Reviewer 要求调整，退回 Coder。', 'Marshal'], ['user', 'guidance', 'Fix tests', 'Owner'],
            ['agent', 'coding', 'Second implementation', 'Coder'], ['agent', 'dev-reviewing', 'Pass', 'Reviewer'],
            ['agent', 'summarizing', 'Release notes', 'Leader'],
        ];
        await app.rooms.begin(room.id, runId, 'Marshal', 'start', 'Start');
        for (const [kind, phase, text, actor, requestId, ref] of rows) await app.rooms.append(room.id, { runId, kind, phase, text, actor,
            ...(ref ? { ref } : {}), ...(requestId ? { requestId } : {}) });
        const response = await app.request('GET', '/marshal/tasks/dag?taskId=work', undefined, headers);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const layers = response.body.layers;
        assert.ok(layers.every(layer => layer.type === 'single' && layer.nodes.length === 1));
        const nodes = layers.flatMap(layer => layer.nodes);
        assert.deepEqual(nodes.map(node => node.phase), ['intake', 'designing', 'coding', 'codex-coding', 'development-patch',
            'dev-reviewing', 'revise', 'guidance', 'coding', 'dev-reviewing', 'summarizing']);
        assert.deepEqual(nodes.filter(node => node.phase === 'coding').map(node => node.round), [1, 2]);
        assert.equal(nodes[3].model, 'actual-model');
        assert.equal(nodes[3].durationMs, 350);
        assert.equal(nodes[3].tokens.totalTokens, 15);
        const getNode = id => app.request('GET', '/marshal/tasks/dag/node?taskId=work&nodeId=' + encodeURIComponent(id), undefined, headers);
        const detail = await getNode(nodes[3].id);
        assert.deepEqual(detail.body.node.logs.map(log => log.text), ['已请求子 Agent actual-model', 'Implementation']);
        assert.deepEqual((await getNode(nodes[4].id)).body.node.diffFiles, ['src/a.js']);
        assert.equal((await getNode(nodes[4].id)).body.node.diff, diff);
        assert.equal((await getNode('nonexistent')).status, 404);
        assert.deepEqual(projectTaskDag({ id: 'planned', workflow: { state: 'ready', plan: { codeWork: true, codex: { coding: 'auto' } } } })
            .layers.flatMap(layer => layer.nodes.map(node => node.phase)), ['intake']);
        const linear = projectTaskDag({ id: 'linear' }, rows.slice(0, 6).map(([kind, phase, text, actor, requestId], index) =>
            ({ kind, phase, text, actor, requestId, seq: index + 1, runId })));
        assert.ok(linear.layers.every(layer => layer.type === 'single'));
        const parallel = projectTaskDag({ id: 'parallel' }, [
            { kind: 'status', at: 10, requestId: 'a' }, { kind: 'status', at: 11, requestId: 'b' },
            { kind: 'agent', at: 12, requestId: 'b' }, { kind: 'agent', at: 13, requestId: 'a' },
        ].map((record, i) => ({ ...record, runId, seq: i + 1, phase: 'coding-assistant', actor: record.requestId })));
        assert.deepEqual(parallel.layers.map(layer => layer.type), ['single', 'parallel']);
    } finally { app.close(); }
});

test('a blocked orchestration wakes through its existing revise batch', async () => {
    const card = { id: 'blocked', title: 'Blocked development', status: 'review', workspaceId: 'ws', tags: [{ name: '@Coder' }] };
    const oldRun = randomUUID();
    const app = fixture({ tasks: [card], workflows: [{ source: 'local', taskId: card.id, workspaceId: 'ws',
        leaderId: 'squad/coder', leaderName: 'Coder', agentId: 'coder', state: 'review-blocked',
        choice: 'template', templateId: 'development', runId: oldRun }] });
    try {
        const headers = await app.signIn();
        const room = app.rooms.ensure('local', card, 'ws', ownerId);
        await app.rooms.begin(room.id, oldRun, 'Marshal', 'start', 'Original execution');
        const projected = (await app.request('GET', '/marshal/agent-tasks?agentKey=coder', undefined, headers)).body.tasks[0];
        const result = await app.request('POST', '/marshal/agents/guidance-sync',
            { agentKey, taskIds: [projected.id], guidanceText: 'Use the reviewed approach' }, headers);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.deliveries[0].woken, true);
        const records = (await app.rooms.page(room.id, {})).records;
        const guidance = records.find(row => row.phase === 'guidance');
        const revise = records.find(row => row.kind === 'batch' && row.phase === 'revise');
        assert.equal(guidance.runId, oldRun);
        assert.notEqual(revise.runId, oldRun);
        assert.ok(revise.seq > guidance.seq);
        const listed = (await app.request('GET', '/marshal/agent-tasks?agentKey=coder', undefined, headers)).body.tasks;
        assert.equal(listed[0].id, projected.id);
        assert.match(listed[0].lastSummary, /Use the reviewed approach/);
    } finally { app.close(); }
});

test('incident routes ingest and persist real host history without opening a room', async () => {
    const card = { id: 'resident', title: 'Resident', status: 'running', workspaceId: 'ws',
        executions: [{ id: 'current-run', sessionId: 'executor', startedAt: 100 }] };
    const unbound = { id: 'unbound', title: 'Unbound', status: 'running', sessionId: 'standalone' };
    const app = fixture({ host: { snapshot: () => ({ tasks: [card, unbound] }) }, history: id => id === 'executor' ? [
        { seq: 1, timestamp: 50, type: 'repeat-tool-reminder' }, // previous execution in the same session
        { seq: 2, timestamp: 101, type: 'turn/start' },
        { seq: 3, timestamp: 102, type: 'tool/result', data: { message: { isError: true, content: [{ type: 'text', text: 'TOOL_TIMEOUT' }] } } },
        { seq: 4, timestamp: 103, type: 'turn/end', data: { reason: { kind: 'error', code: 'isolation-violation' } } },
    ] : [{ seq: 1, timestamp: 105, type: 'repeat-tool-reminder' }] });
    try {
        const headers = await app.signIn();
        const room = app.rooms.ensure('host', card, 'ws', ownerId);
        await app.rooms.begin(room.id, randomUUID(), 'Marshal', 'start', 'Start');
        const summary = await app.request('GET', '/marshal/incidents/summary', undefined, headers);
        assert.equal(summary.status, 200, JSON.stringify(summary.body));
        assert.equal(summary.body.totalCount, 3);
        assert.equal(summary.body.countsByKind['tool-anomaly'], 2);
        assert.equal(summary.body.countsByKind.failed, 1);
        assert.ok(!app.events.some(([topic]) => topic === 'incidents.changed')); // read-only route
        const overview = await app.request('GET', '/marshal/desktop/overview', undefined, headers);
        assert.deepEqual(overview.body.incidents, { totalCount: summary.body.totalCount, criticalCount: summary.body.criticalCount,
            countsByKind: summary.body.countsByKind, items: summary.body.items });
        // Startup reconciliation uses the same production path as the periodic collector.
        app.remount();
        let records;
        for (let attempt = 0; attempt < 30; attempt++) {
            records = (await app.rooms.page(room.id, {})).records;
            if (records.filter(record => record.kind === 'status').length >= 2) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(app.events.some(([topic]) => topic === 'incidents.changed'));
        assert.deepEqual(records.filter(record => record.kind === 'status').map(record => record.phase), ['TOOL_TIMEOUT', 'permission-blocked']);
        assert.equal(app.rooms.find('host', unbound.id), undefined);
        // A standard host rerun may reuse the same session without creating a new room batch.
        const newer = { id: 'next-run', sessionId: 'executor', startedAt: 200 };
        card.executions = [...card.executions, newer];
        const afterRetry = await app.request('GET', '/marshal/incidents/summary', undefined, await app.signIn());
        assert.deepEqual(afterRetry.body.items.map(item => item.targetId), ['unbound']);
    } finally { app.close(); }
});

test('a refused run on a roomless card persists a critical incident and operator actions clear it', async () => {
    const card = { id: 'plain-blocked', title: 'Plain card', status: 'todo' };
    let refuse = true;
    const board = { snapshot: () => ({ tasks: [card] }), async apply(_id, action) {
        if (action.kind === 'run' && refuse) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        if (action.kind === 'run') card.status = 'running';
        if (action.kind === 'move') card.status = action.status;
        return this.snapshot();
    } };
    const app = fixture({ host: board });
    try {
        let headers = await app.signIn();
        const mutate = action => app.request('POST', '/marshal/tasks/' + action, { taskId: card.id }, headers);
        const incidents = async () => {
            const res = await app.request('GET', '/marshal/incidents/summary', undefined, headers);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            return res.body;
        };
        const block = async () => {
            refuse = true;
            const res = await mutate('run');
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.permissionBlocked, true);
            assert.equal(res.body.movedToReview, true);
            assert.equal(app.rooms.find('host', card.id), undefined);
            assert.equal((await incidents()).countsByKind.failed, 1);
        };
        await block();
        const initial = await incidents();
        const { overrides: blockedOverrides } = JSON.parse(readFileSync(join(app.root, 'task-overrides.json')));
        const persisted = blockedOverrides['host/' + card.id].permissionBlock;
        assert.deepEqual(persisted, { taskId: card.id, at: initial.items[0].createdAt, summary: 'EACCES：denied' });
        assert.equal(initial.items[0].subtitle, persisted.summary);
        assert.deepEqual(initial.items.map(({ kind, severity, targetId }) => [kind, severity, targetId]),
            [['failed', 'critical', card.id]]);
        assert.ok(app.events.some(([topic]) => topic === 'incidents.changed'));
        app.remount();
        headers = await app.signIn();
        assert.deepEqual((await incidents()).items, initial.items);
        const overview = await app.request('GET', '/marshal/desktop/overview', undefined, headers);
        assert.equal(overview.status, 200, JSON.stringify(overview.body));
        assert.deepEqual(overview.body.incidents.items, initial.items);

        for (const action of ['run', 'revise', 'confirm-review', 'confirm-permission']) {
            if (action !== 'run') await block();
            refuse = false;
            const res = await mutate(action);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal((await incidents()).totalCount, 0);
            const overviewAfter = await app.request('GET', '/marshal/desktop/overview', undefined, headers);
            assert.equal(overviewAfter.body.incidents.totalCount, 0);
            const { overrides } = JSON.parse(readFileSync(join(app.root, 'task-overrides.json')));
            assert.equal(overrides['host/' + card.id]?.permissionBlock, undefined);
        }
    } finally { app.close(); }
});

test('incident summary and desktop overview share four scoped alert categories and ignore old signals', async () => {
    const tasks = [{ id: 'blocked', title: 'Verdict', status: 'review' }, { id: 'waiting', title: 'Waiting', status: 'waiting' },
        { id: 'denied', title: 'Permission', status: 'review', executions: [{ error: { code: 'EACCES' } }] },
        { id: 'fail', title: 'Failed', status: 'failed' }, { id: 'tools', title: 'Tools', status: 'running', workspaceId: 'ws' },
        { id: 'old', title: 'Retried', status: 'running', workspaceId: 'ws' }, { id: 'foreign', title: 'Foreign', status: 'failed', workspaceId: 'private' },
        { id: 'done', title: 'Done', status: 'done', executions: [{ error: 'TOOL_TIMEOUT' }] }]
        .map(task => ({ createdAt: 42, ...task }));
    const app = fixture({ tasks, workflows: [{ source: 'local', taskId: 'blocked', workspaceId: 'ws', state: 'review-blocked' }],
        proposals: [{ id: 'proposal', title: 'Pending', status: 'pending', createdAt: 1 }, { id: 'approved', title: 'Approved', status: 'approved' }] });
    try {
        const headers = await app.signIn();
        for (const card of tasks.filter(task => ['old', 'tools'].includes(task.id))) {
            const room = app.rooms.ensure('local', card, 'ws', ownerId);
            const runId = randomUUID();
            await app.rooms.begin(room.id, runId, 'Marshal', 'start', 'Start');
            await app.rooms.append(room.id, { runId, kind: 'status', phase: 'repeat-tool-reminder', actor: 'Marshal', text: 'Tool loop detected' });
            await app.rooms.append(room.id, { runId, kind: 'status', actor: 'Marshal', text: 'TOOL_TIMEOUT' });
            if (card.id === 'old') {
                const newRun = randomUUID();
                await app.rooms.begin(room.id, newRun, 'Marshal', 'retry', 'Retry');
                await app.rooms.append(room.id, { runId: newRun, kind: 'user', actor: 'Owner', text: 'TOOL_TIMEOUT was fixed' });
            }
        }
        const summary = await app.request('GET', '/marshal/incidents/summary', undefined, headers);
        assert.equal(summary.status, 200, JSON.stringify(summary.body));
        assert.deepEqual(summary.body.countsByKind, { 'review-blocked': 2, failed: 2, 'tool-anomaly': 1, 'memory-proposal': 1 });
        assert.equal(summary.body.totalCount, 6);
        assert.equal(summary.body.criticalCount, 3);
        assert.deepEqual(new Set(summary.body.items.map(item => item.targetId)), new Set(['blocked', 'waiting', 'denied', 'fail', 'tools', 'proposal']));
        const overview = await app.request('GET', '/marshal/desktop/overview', undefined, headers);
        assert.equal(overview.body.host.deviceId, deviceId);
        assert.equal(overview.body.tasks.totalCount, 7);
        assert.equal(overview.body.agents.totalCount, 1);
        assert.equal(overview.body.memory.pendingProposalCount, 1);
        assert.deepEqual(overview.body.incidents.items, summary.body.items);
        assert.equal(buildIncidentsSummary({ tasksState: [{ id: 't', status: 'failed', executions: [{ error: 'TOOL_TIMEOUT' }] }] }).totalCount, 2);
    } finally { app.close(); }
});

test('task creation preserves legacy input and persists sanitized vNext metadata across host remount', async () => {
    const cards = [];
    const actions = [];
    const board = { snapshot: () => ({ tasks: [...cards] }), async apply(_requestId, action) {
        actions.push(action);
        if (action.kind === 'create') {
            assert.ok(!Object.hasOwn(action.input, 'cascadePath') && !Object.hasOwn(action.input, 'links'));
            cards.push({ id: action.id, ...action.input, status: 'todo' });
        }
        return this.snapshot();
    }, applyVerified(...args) { return this.apply(...args); } };
    const app = fixture({ host: board });
    try {
        let headers = await app.signIn();
        const legacy = await app.request('POST', '/marshal/tasks/create', { title: 'Legacy', description: 'Old contract' });
        assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
        assert.equal(legacy.body.tasks[0].cascadePath, undefined);
        const cascadePath = ['Platform', 'Desktop', 'Tickets'];
        const links = { sessionIds: ['main'], proposalIds: ['proposal'], docPaths: ['design/spec.md'] };
        const attachments = [{ kind: 'file', attachmentId: 'attachment-1', name: 'spec.md', bytes: 22, mediaType: 'text/plain', sha256: 'b'.repeat(64) }];
        const enhanced = await app.request('POST', '/marshal/tasks/create', { title: 'Desktop', cascadePath, links, attachments, skipAmbiguityCheck: true }, headers);
        assert.equal(enhanced.status, 200, JSON.stringify(enhanced.body));
        const created = enhanced.body.tasks.find(task => task.title === 'Desktop');
        assert.deepEqual(created.cascadePath, cascadePath);
        assert.deepEqual(created.links, links);
        assert.deepEqual(created.attachments, attachments);
        const legacyView = (await app.request('GET', '/marshal/tasks/state')).body.tasks.find(task => task.id === created.id);
        assert.equal(legacyView.links, undefined);
        assert.equal(legacyView.cascadePath, undefined);
        const before = actions.length;
        const invalid = await app.request('POST', '/marshal/tasks/create', { title: 'Invalid', cascadePath, links: { docPaths: ['../secret'] } }, headers);
        assert.equal(invalid.status, 400);
        assert.equal(actions.length, before);
        app.remount();
        headers = await app.signIn();
        const persisted = (await app.request('GET', '/marshal/tasks/state', undefined, headers)).body.tasks.find(task => task.id === created.id);
        assert.deepEqual(persisted.cascadePath, cascadePath);
        assert.deepEqual(persisted.links, links);
        assert.deepEqual(persisted.attachments, attachments);
        const raw = cards.find(card => card.id === created.id);
        raw.executions = [{ id: 'past', sessionId: 'past-session', endedAt: 42 }];
        assert.equal((await app.request('POST', '/marshal/tasks/run', { taskId: raw.id }, headers)).status, 200);
        assert.equal(actions.at(-1).kind, 'run');
        assert.equal((await app.request('POST', '/marshal/tasks/update', { taskId: raw.id, prompt: 'Actual content revision' }, headers)).status, 200);
        assert.equal((await app.request('POST', '/marshal/tasks/run', { taskId: raw.id }, headers)).status, 200);
        assert.equal(actions.at(-1).kind, 'rework');
        assert.match(actions.at(-1).instructions, /Actual content revision/);
    } finally { app.close(); }
});

test('a host that cannot record run purpose still resolves the agent direct session', async () => {
    // The standalone @linxin666/dsh-agents plugin refuses an unknown `purpose` field,
    // so every run it records is bare. The board scan alone separates ticket sessions.
    const runs = [
        { teamId: 'squad', memberId: 'coder', sessionId: 'main', createdAt: 10 },
        { teamId: 'squad', memberId: 'coder', sessionId: 'gone', createdAt: 5, status: 'failed' },
    ];
    const app = fixture({ runs });
    try {
        const headers = await app.signIn();
        const sessions = () => app.request('GET', '/marshal/agent-direct-sessions?agentKey=coder', undefined, headers);
        assert.equal((await sessions()).body.mainSession.id, 'main', 'a bare run is the direct session when the host cannot tag purpose');
        const create = async sessionId => (await app.request('POST', '/marshal/agent-tasks/create', { ...draft, sessionId }, headers)).body.task.id;
        const send = id => app.request('POST', '/marshal/agents/guidance-sync', { agentKey, taskIds: [id], guidanceText: 'Continue' }, headers);
        assert.equal((await send(await create(undefined))).status, 200);
        // A purpose-aware ledger keeps the stricter rule: bare runs only prove ownership.
        const file = join(app.root, 'dsh-agents/ledger.json');
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)),
            runs: [...runs, { teamId: 'squad', memberId: 'coder', sessionId: 'ticket', createdAt: 50, purpose: 'ticket' }] }));
        assert.equal((await sessions()).body.mainSession, null);
    } finally { app.close(); }
});

test('latest handoff and unclassified runs are not direct guidance destinations', async () => {
    const runs = [
        { teamId: 'squad', memberId: 'coder', sessionId: 'main', createdAt: 10, purpose: 'direct' },
        { teamId: 'squad', memberId: 'coder', sessionId: 'handoff', createdAt: 20, purpose: 'ticket' },
        { teamId: 'squad', memberId: 'coder', sessionId: 'unknown', createdAt: 30 },
    ];
    const app = fixture({ runs });
    try {
        const headers = await app.signIn();
        const sessions = () => app.request('GET', '/marshal/agent-direct-sessions?agentKey=coder', undefined, headers);
        assert.equal((await sessions()).body.mainSession.id, 'main');
        const create = async sessionId => (await app.request('POST', '/marshal/agent-tasks/create', { ...draft, sessionId }, headers)).body.task.id;
        const send = id => app.request('POST', '/marshal/agents/guidance-sync', { agentKey, taskIds: [id], guidanceText: 'Continue' }, headers);
        const implicit = await create(undefined);
        assert.equal((await send(implicit)).status, 200);
        assert.equal((await send(await create('handoff'))).status, 403);
        const file = join(app.root, 'dsh-agents/ledger.json');
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), runs: runs.slice(1) }));
        assert.equal((await sessions()).body.mainSession, null);
        assert.deepEqual((await sessions()).body.subSessions, []);
        assert.equal((await send(implicit)).body.code, 'direct-session-not-found');
        assert.deepEqual(app.calls.map(call => call.sessionId), ['main']);
    } finally { app.close(); }
});

test('ticket sync metadata is persisted but does not grant stale assignment or session eligibility', async () => {
    const card = { id: 'projected', title: 'Original', status: 'review', workspaceId: 'ws', tags: [{ name: '@Coder' }] };
    const board = { snapshot: () => ({ tasks: [card] }) };
    const app = fixture({ host: board });
    try {
        const headers = await app.signIn();
        const list = async () => (await app.request('GET', '/marshal/agent-tasks?agentKey=coder', undefined, headers)).body.tasks;
        const projected = (await list())[0];
        const synced = await app.request('POST', '/marshal/agents/guidance-sync', { agentKey, taskIds: [projected.id],
            guidanceText: 'Save this context', wakeTicket: false }, headers);
        assert.equal(synced.status, 200, JSON.stringify(synced.body));
        const disk = JSON.parse(readFileSync(join(app.root, 'agent-tasks.json')));
        assert.deepEqual(disk.tasks, []);
        assert.deepEqual(Object.keys(disk.ticketSync[projected.id]).sort(), ['lastSummary', 'lastSyncAt']);
        card.tags = [{ name: '@Someone else' }];
        card.executions = [{ sessionId: 'main', endedAt: 100 }, { sessionId: 'new-agent-session' }];
        assert.deepEqual(await list(), []);
        card.links = { sessionIds: ['main'] };
        card.title = 'Live title';
        assert.equal((await list())[0].title, card.title);
        assert.equal((await list())[0].lastSummary, synced.body.summary);
        card.links = { sessionIds: ['other'] };
        assert.deepEqual(await list(), []);
        card.tags = [{ name: '@Coder' }];
        card.archivedAt = 100;
        assert.deepEqual(await list(), []);
    } finally { app.close(); }
});

test('DAG shows Reviewer active after Codex returns and preserves cancelled plain runs', () => {
    const runId = randomUUID();
    const requestId = randomUUID();
    const dag = projectTaskDag({ id: 'review', workflow: { runId, state: 'running', phase: 'dev-reviewing' } }, [
        { runId, seq: 1, kind: 'agent', phase: 'dev-reviewing', actor: 'Reviewer', text: 'Request auxiliary review' },
        { runId, seq: 2, kind: 'status', phase: 'review-assistant', requestId, actor: 'Codex', text: 'Requested' },
        { runId, seq: 3, kind: 'agent', phase: 'review-assistant', requestId, actor: 'Codex', text: 'Finished' },
    ]);
    assert.deepEqual(dag.layers.flatMap(layer => layer.nodes).slice(-2).map(node => [node.role, node.status]),
        [['codexReview', 'done'], ['reviewer', 'running']]);
    assert.equal(dag.layers.at(-1).nodes[0].agentName, 'Reviewer');
    const plain = projectTaskDag({ id: 'plain', executions: [{ id: 'cancelled', startedAt: 1, endedAt: 2, result: 'cancelled' }] });
    assert.equal(plain.layers.at(-1).nodes[0].status, 'cancelled');
});

test('DAG separates Marshal handoffs from active roles and starts coding in the new rework round', () => {
    const runId = randomUUID();
    const records = [
        { kind: 'agent', phase: 'coding', actor: 'Coder', text: 'Round one implementation' },
        { kind: 'status', phase: 'dev-reviewing', actor: 'Marshal', text: 'Review handoff recorded' },
    ].map((row, i) => ({ ...row, runId, seq: i + 1 }));
    const task = { id: 'live', workflow: { runId, state: 'running', phase: 'dev-reviewing' } };
    const nodes = () => projectTaskDag(task, records).layers.flatMap(layer => layer.nodes);
    const reviewer = nodes().at(-1);
    assert.deepEqual([reviewer.role, reviewer.status, reviewer.round], ['reviewer', 'running', 1]);
    assert.equal(reviewer.agentName, null);
    assert.equal(reviewer.sessionId, null);
    assert.deepEqual(getTaskDagNodeDetail(task, records, reviewer.id).logs, []);
    const handoff = nodes().at(-2);
    assert.equal(handoff.agentName, 'Marshal');
    assert.equal(handoff.role, 'marshal');
    assert.notEqual(handoff.status, 'running');
    assert.deepEqual(getTaskDagNodeDetail(task, records, handoff.id).logs, [records[1]]);

    records.push(
        { runId, seq: 3, kind: 'agent', phase: 'dev-reviewing', actor: 'Reviewer', text: 'Revise' },
        { runId, seq: 4, kind: 'status', phase: 'coding', actor: 'Marshal', text: 'Reviewer 要求调整，退回 Coder。' },
    );
    task.workflow.phase = 'coding';
    const coder = nodes().at(-1);
    assert.deepEqual([coder.role, coder.status, coder.round], ['coder', 'running', 2]);
    assert.deepEqual(getTaskDagNodeDetail(task, records, coder.id).logs, []);
    assert.equal(nodes().at(-2).phase, 'revise');
    records.push({ runId, seq: 5, kind: 'agent', phase: 'coding', actor: 'Coder', text: 'Second implementation' });
    assert.deepEqual(nodes().filter(node => node.phase === 'coding' && node.logs.length).map(node => node.round), [1, 2]);
    assert.equal(nodes().at(-1).round, 2);
});

test('a handed-off coding session never turns the Marshal notice into a running executor', () => {
    const runId = randomUUID();
    const sessionId = 'coder-session-123456';
    const shortSess = sessionId.slice(-12);
    const task = { id: 'handoff', workflow: { runId, state: 'handed-off', sessionId,
        plan: { codeWork: true }, leaderName: 'Not the coder' } };
    const records = [
        { runId, seq: 1, kind: 'status', phase: 'assignment', actor: 'Marshal', text: JSON.stringify({ roles: { Coder: 'Actual coder' } }) },
        { runId, seq: 2, kind: 'status', phase: 'handoff', actor: 'Marshal', text: 'Handed off to the coder' },
    ];
    const nodes = () => projectTaskDag(task, records).layers.flatMap(layer => layer.nodes);
    const notice = nodes().at(-2);
    const active = nodes().at(-1);
    assert.deepEqual([notice.role, notice.status, notice.sessionId], ['marshal', 'recorded', null]);
    assert.deepEqual([active.role, active.agentName, active.status, active.sessionId], ['coder', 'Actual coder', 'running', sessionId]);
    assert.deepEqual(getTaskDagNodeDetail(task, records, active.id).logs, []);
    // Real TaskRoomRecord items written by session-room-sync carry no sessionId field.
    records.push({ id: `sess-msg:${shortSess}:5`, runId, seq: 3, kind: 'agent', phase: 'handoff', actor: 'Actual coder', text: 'Started implementation' });
    const all = nodes();
    const real = all.at(-1);
    assert.equal(all.filter(node => node.phase === 'handoff' && node.role !== 'marshal').length, 1);
    assert.deepEqual([real.role, real.status, real.sessionId], ['coder', 'running', sessionId]);
    assert.deepEqual(getTaskDagNodeDetail(task, records, real.id).logs, [records[2]]);
});

test('long historical plain ticket delivers the complete new summary in the host rework payload', async () => {
    const card = { id: 'long', workspaceId: 'ws', title: 'Large baseline', description: 'd'.repeat(15000), prompt: 'p'.repeat(15000),
        status: 'review', executions: [{ id: 'previous', sessionId: 'ticket-session', endedAt: 20, result: 'succeeded' }] };
    const dispatched = [];
    const board = { snapshot: () => ({ tasks: [card] }), async apply(_id, action) {
        assert.equal(action.kind, 'rework');
        assert.ok(action.instructions.length <= 4000);
        dispatched.push(action.instructions);
        setTimeout(() => card.executions.push({ id: 'rework', sessionId: 'ticket-session', startedAt: 21 }), 10);
        return this.snapshot();
    } };
    const app = fixture({ host: board });
    try {
        const headers = await app.signIn();
        const task = (await app.request('POST', '/marshal/agent-tasks/create', { ...draft, type: 'ticket', sessionId: undefined, linkedTicketId: card.id }, headers)).body.task;
        const guidanceText = 'g'.repeat(2970) + ' END OF NEW GUIDANCE';
        const result = await app.request('POST', '/marshal/agents/guidance-sync', { agentKey, taskIds: [task.id], guidanceText }, headers);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.deliveries[0].woken, true);
        assert.equal(card.executions.at(-1).id, 'rework');
        assert.equal(dispatched.length, 1);
        assert.ok(dispatched[0].includes(guidanceText));
        assert.ok(dispatched[0].includes(result.body.summary));
        assert.match(dispatched[0], /Verify release checklist|Large baseline/);
    } finally { app.close(); }
});

for (const [delay, outcome] of [[10, 'fallback-delivered'], [240, 'fallback-launch-failed'], [240, 'fallback-prompt-rejected'],
    [240, 'fallback-delayed-failure']]) {
    test(`guidance detects rework startup failure after ${delay}ms: ${outcome}`, async () => {
        const card = { id: 'rework-ticket', workspaceId: 'ws', title: 'Rework', status: 'review',
            executions: [{ id: 'old', sessionId: 'old-session', endedAt: 20, result: 'succeeded' }] };
        const actions = [];
        const board = { snapshot: () => ({ tasks: [card] }), async apply(_id, action) {
            actions.push(action.kind);
            if (action.kind === 'rework') {
                const run = { id: 'rework', startedAt: 21, sessionId: 'old-session' };
                card.executions.push(run);
                setTimeout(() => Object.assign(run, { endedAt: 22, result: 'failed', error: 'old session closed' }), delay);
            }
            if (action.kind === 'run') {
                assert.equal(card.executions.at(-1).result, 'failed');
                const run = { id: 'fallback', startedAt: 23 };
                card.executions.push(run);
                setTimeout(() => Object.assign(run, outcome === 'fallback-launch-failed'
                    ? { endedAt: 24, result: 'failed' } : { sessionId: 'fresh-session' }), 10);
                if (outcome === 'fallback-delayed-failure') {
                    setTimeout(() => Object.assign(run, { endedAt: 24, result: 'failed' }), 240);
                }
            }
            return this.snapshot();
        } };
        const app = fixture({ host: board, prompt: () => ({ ok: outcome !== 'fallback-prompt-rejected' }) });
        try {
            const headers = await app.signIn();
            const { body: { task } } = await app.request('POST', '/marshal/agent-tasks/create',
                { agentKey, type: 'ticket', title: 'Rework', linkedTicketId: card.id }, headers);
            app.events.length = 0;
            const result = await app.request('POST', '/marshal/agents/guidance-sync',
                { agentKey, taskIds: [task.id], guidanceText: 'Use the new checklist' }, headers);
            assert.deepEqual(actions, ['rework', 'run']);
            const delivery = result.body.deliveries[0];
            assert.equal(delivery.delivered, true); // durable room write even when the host wake fails
            if (outcome === 'fallback-delivered') {
                assert.equal(result.status, 200, JSON.stringify(result.body));
                assert.equal(delivery.woken, true);
            } else {
                assert.equal(result.status, 502, JSON.stringify(result.body));
                assert.equal(delivery.woken, false);
                assert.equal(result.body.code, 'guidance-session-unavailable');
            }
            const queued = ['fallback-delivered', 'fallback-prompt-rejected'].includes(outcome);
            assert.deepEqual(app.calls.map(call => call.sessionId), queued ? ['fresh-session'] : []);
            if (app.calls.length) assert.ok(app.calls[0].content[0].text.startsWith(result.body.summary));
            const room = app.rooms.find('host', card.id);
            const { records } = await app.rooms.page(room.id, {});
            const message = records.find(row => row.kind === 'user' && row.phase === 'guidance');
            assert.equal(message?.text, result.body.summary);
            for (const event of ['room.message', 'tasks.changed', 'incidents.changed']) {
                assert.ok(app.events.some(([topic]) => topic === event), event);
            }
            const synced = createAgentTaskStore({ dataDir: app.root }).getTask(task.id);
            if (outcome === 'fallback-delivered') {
                assert.ok(app.events.some(([topic]) => topic === 'agents.changed'));
                assert.equal(synced.lastSummary, result.body.summary);
                assert.ok(synced.lastSyncAt > 0);
            } else {
                assert.equal(synced.lastSummary, task.lastSummary);
                assert.equal(synced.lastSyncAt, task.lastSyncAt);
                assert.deepEqual(result.body.tasks, []);
            }
        } finally { app.close(); }
    });
}

for (const outcome of ['cancelled', 'aborted', 'timed-out', 'replacement', 'session-replacement', 'no-session']) {
    test(`unconfirmed rework does not report a wake or start a duplicate run: ${outcome}`, async () => {
        const card = { id: 'lost-rework', workspaceId: 'ws', title: 'Rework', status: 'review',
            executions: [{ id: 'previous', startedAt: 1, sessionId: 'original', endedAt: 2, result: 'succeeded' }] };
        const actions = [];
        const board = { snapshot: () => ({ tasks: [card] }), async apply(_id, action) {
            actions.push(action.kind);
            assert.equal(action.kind, 'rework');
            const run = { id: 'new', startedAt: 3, ...(outcome === 'no-session' ? {} : { sessionId: 'original' }) };
            card.executions.push(run);
            if (outcome !== 'no-session') setTimeout(() => {
                if (outcome === 'replacement') card.executions.splice(-1, 1, { id: 'different-run', startedAt: 4, sessionId: 'different' });
                else if (outcome === 'session-replacement') run.sessionId = 'different';
                else Object.assign(run, { endedAt: 4, result: outcome });
            }, 240);
            return this.snapshot();
        } };
        const app = fixture({ host: board });
        try {
            const headers = await app.signIn();
            const result = await app.request('POST', '/marshal/agents/guidance-sync',
                { agentKey, targetTicketId: card.id, guidanceText: 'Continue' }, headers);
            assert.equal(result.status, 502, JSON.stringify(result.body));
            assert.equal(result.body.code, 'guidance-session-unavailable');
            assert.deepEqual(result.body.deliveries.map(row => [row.delivered, row.woken]), [[true, false]]);
            assert.deepEqual(actions, ['rework']);
            assert.deepEqual(app.calls, []);
        } finally { app.close(); }
    });
}

test('a first run that only saves the prompt and changes status does not sync task metadata', async () => {
    const card = { id: 'new-local-card', workspaceId: 'ws', title: 'Local card', status: 'review' };
    const app = fixture({ tasks: [card] });
    try {
        const headers = await app.signIn();
        const { body: { task } } = await app.request('POST', '/marshal/agent-tasks/create',
            { agentKey, type: 'ticket', title: card.title, linkedTicketId: card.id }, headers);
        const result = await app.request('POST', '/marshal/agents/guidance-sync',
            { agentKey, taskIds: [task.id], guidanceText: 'Start with this checklist' }, headers);
        assert.equal(result.status, 502, JSON.stringify(result.body));
        assert.equal(result.body.code, 'guidance-session-unavailable');
        assert.deepEqual(result.body.deliveries.map(row => [row.delivered, row.woken]), [[true, false]]);
        const [saved] = JSON.parse(readFileSync(join(app.root, 'tasks.json'))).tasks;
        assert.ok(saved.prompt.includes(result.body.summary));
        assert.equal(saved.status, 'running');
        assert.equal(saved.executions?.length ?? 0, 0);
        const stored = createAgentTaskStore({ dataDir: app.root }).getTask(task.id);
        assert.equal(stored.lastSyncAt, task.lastSyncAt);
        assert.equal(stored.lastSummary, task.lastSummary);
        assert.deepEqual(app.calls, []);
    } finally { app.close(); }
});

test('orchestrated handoff sends the pinned guidance to the host driver even after a long brief', async () => {
    const card = { id: 'handoff-ticket', title: 'Long handoff', description: 'brief '.repeat(2300), status: 'review',
        workspaceId: 'ws', tags: [{ name: '@Coder' }] };
    const stored = new Map();
    const launches = [];
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        assert.equal(url, origin + '/dsh-agents/api/run');
        launches.push(JSON.parse(init.body));
        return Response.json({ run: { sessionId: 'ticket-run' } });
    };
    const app = fixture({ tasks: [card], workflows: [{ source: 'local', taskId: card.id, workspaceId: 'ws',
        leaderId: 'squad/coder', leaderName: 'Coder', agentId: 'coder', state: 'review-blocked', choice: 'none' }],
        memory: { rememberFor({ text }) { const id = randomUUID(); stored.set(id, { content: text }); return { id }; },
            getFor(_scope, _workspace, id) { return stored.get(id); } } });
    try {
        const headers = await app.signIn();
        const view = (await app.request('GET', '/marshal/agent-tasks?agentKey=coder', undefined, headers)).body.tasks[0];
        const guidanceText = 'Follow the latest checked requirements instead.';
        const result = await app.request('POST', '/marshal/agents/guidance-sync', { agentKey, taskIds: [view.id], guidanceText }, headers);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        for (let attempt = 0; !app.calls.length && attempt < 30; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(launches, [{ teamId: 'squad', memberId: 'coder', purpose: 'ticket' }]);
        assert.equal(app.calls[0]?.sessionId, 'ticket-run');
        assert.ok(app.calls[0].content[0].text.startsWith(result.body.summary));
        assert.ok(app.calls[0].content[0].text.includes(guidanceText));
        assert.match(result.body.summary, /Long handoff/);
    } finally { app.close(); globalThis.fetch = oldFetch; }
});

test('guidance rejects 800ms delayed host failure and confirms first-run succeeded without sessionId', async () => {
    const delayedCard = { id: 'delayed-fail', workspaceId: 'ws', title: 'Delayed', status: 'review',
        executions: [{ id: 'old', sessionId: 'old-session', endedAt: 20, result: 'succeeded' }] };
    const firstDoneCard = { id: 'first-done', workspaceId: 'ws', title: 'Fast first run', status: 'todo' };
    const tasks = [delayedCard, firstDoneCard];
    const board = { snapshot: () => ({ tasks }), async apply(_id, action) {
        if (action.kind === 'update' && action.taskId === firstDoneCard.id) {
            Object.assign(firstDoneCard, action.patch);
            return this.snapshot();
        }
        if (action.kind === 'rework') {
            const run = { id: 'rework', startedAt: 21, sessionId: 'old-session' };
            delayedCard.executions.push(run);
            setTimeout(() => Object.assign(run, { endedAt: 22, result: 'failed', error: 'delayed launch reject' }), 800);
        }
        if (action.kind === 'run' && action.taskId === delayedCard.id) {
            const run = { id: 'fallback', startedAt: 23, sessionId: 'fresh-session' };
            delayedCard.executions.push(run);
            setTimeout(() => Object.assign(run, { endedAt: 24, result: 'failed', error: 'delayed fallback reject' }), 800);
        }
        if (action.kind === 'run' && action.taskId === firstDoneCard.id) {
            firstDoneCard.status = 'done';
            firstDoneCard.executions = [{ id: 'fast', startedAt: 1, endedAt: 2, result: 'succeeded' }];
        }
        return this.snapshot();
    } };
    const app = fixture({ host: board });
    try {
        const headers = await app.signIn();
        const delayed = await app.request('POST', '/marshal/agents/guidance-sync',
            { agentKey, targetTicketId: delayedCard.id, guidanceText: 'Check delayed launch' }, headers);
        assert.equal(delayed.status, 502, JSON.stringify(delayed.body));
        assert.equal(delayed.body.code, 'guidance-session-unavailable');
        assert.deepEqual(delayed.body.deliveries.map(row => [row.delivered, row.woken]), [[true, false]]);
        assert.deepEqual(app.calls, []);

        const first = await app.request('POST', '/marshal/agents/guidance-sync',
            { agentKey, targetTicketId: firstDoneCard.id, guidanceText: 'Run once' }, headers);
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.deepEqual(first.body.deliveries.map(row => [row.delivered, row.woken]), [[true, true]]);
    } finally { app.close(); }
});

test('un-roomed plain card hitting permission error on tasks/revise persists block and surfaces in incidents', async () => {
    const card = { id: 'plain-revise-blocked', title: 'Plain revise card', status: 'review' };
    let refuse = true;
    const board = { snapshot: () => ({ tasks: [card] }), async apply(_id, action) {
        if (action.kind === 'update') { Object.assign(card, action.patch); return this.snapshot(); }
        if (action.kind === 'run' && refuse) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        if (action.kind === 'run') card.status = 'running';
        if (action.kind === 'move') card.status = action.status;
        return this.snapshot();
    } };
    const app = fixture({ host: board });
    try {
        const headers = await app.signIn();
        const res = await app.request('POST', '/marshal/tasks/revise',
            { taskId: card.id, text: 'Retry plain card' }, headers);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.permissionBlocked, true);
        assert.equal(res.body.movedToReview, true);
        assert.equal(card.status, 'review');
        assert.equal(app.rooms.find('host', card.id), undefined);
        const incidents = await app.request('GET', '/marshal/incidents/summary', undefined, headers);
        assert.equal(incidents.status, 200);
        assert.equal(incidents.body.countsByKind.failed, 1);
        assert.equal(incidents.body.items[0].targetId, card.id);
        const { overrides } = JSON.parse(readFileSync(join(app.root, 'task-overrides.json')));
        assert.equal(overrides['host/' + card.id]?.permissionBlock?.summary, 'EACCES：permission denied');

        refuse = false;
        const retried = await app.request('POST', '/marshal/tasks/revise',
            { taskId: card.id, text: 'Approved now' }, headers);
        assert.equal(retried.status, 200, JSON.stringify(retried.body));
        assert.equal(card.status, 'running');
        const cleared = await app.request('GET', '/marshal/incidents/summary', undefined, headers);
        assert.equal(cleared.body.totalCount, 0);
    } finally { app.close(); }
});
