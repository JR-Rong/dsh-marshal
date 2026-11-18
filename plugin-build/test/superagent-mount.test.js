import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { mountSuperagent } from '../lib/src/superagent/mount.js';
import { agentsFixture, createFakeBoard, createFakeContext, createFakeMemory, loggerFixture, memberFixture, taskFixture, tempRoot } from './superagent-support.js';

function makeRequest({ method = 'GET', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    req.method = method;
    req.url = '/';
    req.headers = headers;
    req.socket = { remoteAddress };
    const res = {
        status: 0,
        headers: {},
        body: '',
        writeHead(status, values) { this.status = status; this.headers = values ?? {}; },
        end(chunk) { this.body = chunk === undefined ? '' : String(chunk); },
    };
    return { req, res };
}

const PROOF = {
    'content-type': 'application/json',
    host: '127.0.0.1:63125',
    origin: 'http://127.0.0.1:63125',
    'sec-fetch-site': 'same-origin',
};

function setup() {
    const board = createFakeBoard({ tasks: [taskFixture()] });
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

function route(context, path) {
    const found = context.routes.find(item => item.path === path);
    assert.notEqual(found, undefined, 'route not registered: ' + path);
    return found;
}

test('mount: registers the page, human routes, read routes, the tool and the board extension', () => {
    const { bridge, context } = setup();
    try {
        assert.equal(context.routes.length, 8);
        assert.deepEqual(context.routes.map(item => item.path).sort(), [
            '/api/marshal-superagent/human-create',
            '/marshal-superagent',
            '/marshal-superagent/api/agents',
            '/marshal-superagent/api/config',
            '/marshal-superagent/api/dispatch',
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

test('mount: health and status are loopback-only and reflect the extension', async () => {
    const { context } = setup();
    try {
        const health = route(context, '/marshal-superagent/health');
        const ok = makeRequest();
        await health.handler(ok.req, ok.res);
        assert.equal(ok.res.status, 200);
        const value = JSON.parse(ok.res.body);
        assert.equal(value.ok, true);
        assert.equal(value.extension.id, 'marshal-superagent');
        assert.equal(value.controlPage, '/marshal-superagent');
        const denied = makeRequest({ headers: { 'sec-fetch-site': 'cross-site' } });
        await health.handler(denied.req, denied.res);
        assert.equal(denied.res.status, 403);
        const remote = makeRequest({ remoteAddress: '203.0.113.9' });
        await health.handler(remote.req, remote.res);
        assert.equal(remote.res.status, 403);
    }
    finally {
        context.close();
    }
});

test('mount: the control page is served at /marshal-superagent', async () => {
    const { context } = setup();
    try {
        const page = route(context, '/marshal-superagent');
        const ok = makeRequest();
        await page.handler(ok.req, ok.res);
        assert.equal(ok.res.status, 200);
        assert.match(ok.res.headers['content-type'], /text\/html/);
        assert.equal(ok.res.headers['x-frame-options'], 'DENY');
        assert.match(ok.res.headers['content-security-policy'], /frame-ancestors/);
        assert.match(ok.res.body, /Super-agent 派发桥/);
        assert.match(ok.res.body, /api\/config/);
        assert.match(ok.res.body, /id="aliases"/);
    }
    finally {
        context.close();
    }
});

test('mount: human-create requires browser proof, source=board-ui and a JSON body', async () => {
    const { bridge, board, context } = setup();
    try {
        bridge.configure({ defaultAgent: '工部尚书' });
        const human = route(context, '/api/marshal-superagent/human-create');
        const ok = makeRequest({ method: 'POST', headers: PROOF, body: JSON.stringify({ taskId: 'task-1', source: 'board-ui', requestId: 'ui-1' }) });
        await human.handler(ok.req, ok.res);
        assert.equal(ok.res.status, 202);
        assert.deepEqual(board.actions.map(entry => entry.action.kind), ['update', 'run']);

        const noOrigin = makeRequest({ method: 'POST', headers: { ...PROOF, origin: undefined }, body: '{}' });
        await human.handler(noOrigin.req, noOrigin.res);
        assert.equal(noOrigin.res.status, 403);
        const noFetchSite = makeRequest({ method: 'POST', headers: { ...PROOF, 'sec-fetch-site': undefined }, body: '{}' });
        await human.handler(noFetchSite.req, noFetchSite.res);
        assert.equal(noFetchSite.res.status, 403);
        const crossSite = makeRequest({ method: 'POST', headers: { ...PROOF, 'sec-fetch-site': 'cross-site' }, body: '{}' });
        await human.handler(crossSite.req, crossSite.res);
        assert.equal(crossSite.res.status, 403);
        const remote = makeRequest({ method: 'POST', headers: PROOF, body: '{}', remoteAddress: '203.0.113.9' });
        await human.handler(remote.req, remote.res);
        assert.equal(remote.res.status, 403);
        const noSource = makeRequest({ method: 'POST', headers: PROOF, body: JSON.stringify({ taskId: 'task-1' }) });
        await human.handler(noSource.req, noSource.res);
        assert.equal(noSource.res.status, 400);
        assert.equal(JSON.parse(noSource.res.body).code, 'bad-source');
        const noJson = makeRequest({ method: 'POST', headers: { ...PROOF, 'content-type': 'text/plain' }, body: '{}' });
        await human.handler(noJson.req, noJson.res);
        assert.equal(noJson.res.status, 415);
    }
    finally {
        context.close();
    }
});

test('mount: config and dispatch are browser-only routes; the tool cannot mutate', async () => {
    const { bridge, board, context } = setup();
    try {
        const config = route(context, '/marshal-superagent/api/config');
        const saved = makeRequest({ method: 'POST', headers: PROOF, body: JSON.stringify({ defaultAgent: '工部尚书', rootOnly: true, memoryLimit: 4 }) });
        await config.handler(saved.req, saved.res);
        assert.equal(saved.res.status, 200);
        assert.equal(JSON.parse(saved.res.body).status.defaultAgent, '工部尚书');
        assert.equal(bridge.settingsStore.get().memoryLimit, 4);

        const deniedConfig = makeRequest({ method: 'POST', headers: { ...PROOF, origin: undefined }, body: '{}' });
        await config.handler(deniedConfig.req, deniedConfig.res);
        assert.equal(deniedConfig.res.status, 403);

        const dispatch = route(context, '/marshal-superagent/api/dispatch');
        const deniedDispatch = makeRequest({ method: 'POST', headers: { ...PROOF, 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ taskId: 'task-1' }) });
        await dispatch.handler(deniedDispatch.req, deniedDispatch.res);
        assert.equal(deniedDispatch.res.status, 403);
        const sent = makeRequest({ method: 'POST', headers: PROOF, body: JSON.stringify({ taskId: 'task-1' }) });
        await dispatch.handler(sent.req, sent.res);
        assert.equal(sent.res.status, 202);
        assert.deepEqual(board.actions.map(entry => entry.action.kind), ['update', 'run']);

        const tool = context.registeredTools[0];
        await assert.rejects(async () => { await tool.execute({ action: 'config', defaultAgent: '工部尚书' }); }, /unknown/);
        await assert.rejects(async () => { await tool.execute({ action: 'dispatch', taskId: 'task-1' }); }, /unknown/);
        const agents = JSON.parse(await tool.execute({ action: 'agents' }));
        assert.equal(agents.agents[0].name, '工部尚书');
        const status = JSON.parse(await tool.execute({ action: 'status' }));
        assert.equal(status.ok, true);
        const reconciled = JSON.parse(await tool.execute({ action: 'reconcile' }));
        assert.equal(reconciled.ok, true);
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
