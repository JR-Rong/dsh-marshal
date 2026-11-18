import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createSuperagentBridge } from '../lib/src/superagent/mount.js';
import { agentsFixture, createFakeBoard, createFakeMemory, loggerFixture, memberFixture, taskFixture, tempRoot } from './superagent-support.js';

const hookSource = readFileSync(join(import.meta.dirname, '..', 'client', 'superagent-hook.js'), 'utf8');

function startBridgeServer(bridge) {
    const routes = bridge.routes();
    const server = createServer(async (req, res) => {
        const path = (req.url || '').split('?')[0];
        const route = routes.find(item => item.path === path);
        if (route === undefined) {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        await route.handler(req, res);
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

async function eventually(check, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
}

test('integration: the browser observer reaches the real HTTP route and dispatches', async () => {
    const board = createFakeBoard({ tasks: [taskFixture()] });
    const memory = createFakeMemory();
    const bridge = createSuperagentBridge({
        root: tempRoot(),
        memory,
        readAgents: () => agentsFixture([memberFixture()]),
        logger: loggerFixture(),
        reconcileDelayMs: -1,
    });
    bridge.setBoard(board);
    bridge.configure({ defaultAgent: '工部尚书' });
    const { server, port } = await startBridgeServer(bridge);
    const base = 'http://127.0.0.1:' + port;
    try {
        const calls = [];
        const realFetch = globalThis.fetch;
        const window = {
            document: { baseURI: base + '/' },
            location: { href: base + '/' },
            fetch: async (input, init) => {
                const url = typeof input === 'string' ? input : input.url;
                calls.push(String(url));
                if (String(url).includes('api/task-board/action')) return { ok: true, status: 200 };
                const absolute = new URL(String(url), base).href;
                return await realFetch(absolute, {
                    ...init,
                    headers: {
                        ...(init && init.headers ? init.headers : {}),
                        origin: base,
                        'sec-fetch-site': 'same-origin',
                    },
                });
            },
        };
        vm.runInNewContext(hookSource, { window, URL, JSON, String, Set, Promise, console }, { filename: 'superagent-hook.js' });
        const envelope = JSON.stringify({
            requestId: 'req-integration',
            action: { kind: 'create', id: 'task-1', input: { title: '集成测试卡', prompt: '验证 hook 到路由' } },
        });
        await window.fetch('api/task-board/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: envelope,
        });
        const dispatched = await eventually(() => board.actions.filter(entry => entry.action.kind === 'run').length === 1);
        assert.equal(dispatched, true, 'the bridge opened one run');
        assert.deepEqual(board.actions.map(entry => entry.action.kind), ['update', 'run']);
        assert.equal(bridge.stateStore.get('task-1').agentName, '工部尚书');
        assert.equal(calls.some(url => url.includes('api/marshal-superagent/human-create')), true);
    }
    finally {
        server.close();
        bridge.close();
    }
});
