import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { mountSuperagent } from '../lib/src/superagent/mount.js';
import { agentsFixture, createFakeContext, createFakeMemory, loggerFixture, memberFixture, taskFixture, tempRoot } from './superagent-support.js';

function makeRequest({ method = 'GET', headers = {}, body } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    req.method = method;
    req.url = '/';
    req.headers = headers;
    req.socket = { remoteAddress: '127.0.0.1' };
    const res = {
        status: 0,
        headers: {},
        body: '',
        writeHead(status, values) { this.status = status; this.headers = values ?? {}; },
        end(chunk) { this.body = chunk === undefined ? '' : String(chunk); },
    };
    return { req, res };
}

function setup() {
    const board = createFakeBoardForMount();
    const memory = createFakeMemory();
    const context = createFakeContext({ taskBoard: board, memory, logger: loggerFixture() });
    const bridge = mountSuperagent(context, { agents: ['dsh'] }, {
        root: tempRoot(),
        memory,
        logger: context.logger,
        readAgents: () => agentsFixture([memberFixture()]),
        reconcileDelayMs: -1,
    });
    return { bridge, board, memory, context };
}

import { createFakeBoard } from './superagent-support.js';
function createFakeBoardForMount() {
    return createFakeBoard({ tasks: [taskFixture()] });
}

test('mount: registers the health/status/human-create routes, the tool and the board extension', () => {
    const { bridge, context } = setup();
    try {
        assert.equal(context.routes.length, 3);
        assert.deepEqual(context.routes.map(route => route.path).sort(), [
            '/marshal-superagent/api/human-create',
            '/marshal-superagent/api/status',
            '/marshal-superagent/health',
        ]);
        assert.equal(context.registeredTools.length, 1);
        assert.equal(context.registeredTools[0].name, 'marshal_superagent');
        assert.equal(bridge.extension.summary().ready, true);
    }
    finally {
        context.close();
    }
});

test('mount: health is loopback-only and reflects the extension', async () => {
    const { context } = setup();
    try {
        const health = context.routes.find(route => route.path === '/marshal-superagent/health');
        const ok = makeRequest();
        await health.handler(ok.req, ok.res);
        assert.equal(ok.res.status, 200);
        const value = JSON.parse(ok.res.body);
        assert.equal(value.ok, true);
        assert.equal(value.extension.id, 'marshal-superagent');
        const denied = makeRequest({ headers: { 'sec-fetch-site': 'cross-site' } });
        await health.handler(denied.req, denied.res);
        assert.equal(denied.res.status, 403);
    }
    finally {
        context.close();
    }
});

test('mount: the human-create route dispatches a GUI card and rejects bad envelopes', async () => {
    const { bridge, board, context } = setup();
    try {
        bridge.configure({ defaultAgent: '工部尚书' });
        const route = context.routes.find(item => item.path === '/marshal-superagent/api/human-create');
        const headers = {
            'content-type': 'application/json',
            host: '127.0.0.1:63125',
            origin: 'http://127.0.0.1:63125',
        };
        const ok = makeRequest({ method: 'POST', headers, body: JSON.stringify({ taskId: 'task-1', source: 'board-ui', requestId: 'ui-1' }) });
        await route.handler(ok.req, ok.res);
        assert.equal(ok.res.status, 202);
        assert.deepEqual(board.actions.map(entry => entry.action.kind), ['update', 'run']);
        const noJson = makeRequest({ method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' });
        await route.handler(noJson.req, noJson.res);
        assert.equal(noJson.res.status, 415);
        const crossSite = makeRequest({ method: 'POST', headers: { ...headers, 'sec-fetch-site': 'cross-site' }, body: '{}' });
        await route.handler(crossSite.req, crossSite.res);
        assert.equal(crossSite.res.status, 403);
    }
    finally {
        context.close();
    }
});

test('mount: the tool reports status, configures and dispatches manually', async () => {
    const { bridge, board, context } = setup();
    try {
        const tool = context.registeredTools[0];
        const before = JSON.parse(await tool.execute({ action: 'status' }));
        assert.equal(before.ok, true);
        assert.equal(before.board.available, true);
        const configured = JSON.parse(await tool.execute({ action: 'config', defaultAgent: '工部尚书', rootOnly: true }));
        assert.equal(configured.defaultAgent, '工部尚书');
        const dispatched = JSON.parse(await tool.execute({ action: 'dispatch', taskId: 'task-1' }));
        assert.equal(dispatched.ok, true);
        assert.deepEqual(board.actions.map(entry => entry.action.kind), ['update', 'run']);
        const agents = JSON.parse(await tool.execute({ action: 'agents' }));
        assert.equal(agents.agents[0].name, '工部尚书');
        await assert.rejects(async () => { await tool.execute({ action: 'config', defaultAgent: '不存在' }); }, /not found/);
    }
    finally {
        context.close();
    }
});

test('mount: no dsh agent means no bridge', () => {
    const context = createFakeContext();
    const bridge = mountSuperagent(context, { agents: ['codex'] }, { root: tempRoot(), memory: createFakeMemory(), logger: context.logger });
    assert.equal(bridge, undefined);
    assert.equal(context.routes.length, 0);
});
