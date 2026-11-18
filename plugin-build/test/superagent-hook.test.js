import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const clientDir = join(import.meta.dirname, '..', 'client');
const hookSource = readFileSync(join(clientDir, 'superagent-hook.js'), 'utf8');
const bundleSource = readFileSync(join(clientDir, 'index.js'), 'utf8');

function loadHook(responses = []) {
    const calls = [];
    const fetch = function fakeFetch(input, init) {
        const url = typeof input === 'string' ? input : input?.url;
        calls.push({ url, init, thisValue: this });
        const response = responses.length > 0 ? responses.shift() : { ok: true, status: 200 };
        return Promise.resolve(response);
    };
    const window = {
        fetch,
        document: { baseURI: 'http://127.0.0.1:63125/' },
        location: { href: 'http://127.0.0.1:63125/' },
    };
    const context = { window, URL, JSON, String, Set, Promise, console };
    vm.runInNewContext(hookSource, context, { filename: 'superagent-hook.js' });
    return { window, calls };
}

function createEnvelope(id = 'task-9') {
    return JSON.stringify({ requestId: 'req-1', action: { kind: 'create', id, input: { title: '登录页' } } });
}

test('hook: a successful GUI create notifies the host once', async () => {
    const { window, calls } = loadHook();
    const response = { ok: true, status: 200 };
    const result = await window.fetch('api/task-board/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: createEnvelope() });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(result.ok, response.ok, 'the board response is returned unchanged');
    assert.equal(result.status, response.status);
    assert.equal(calls.length, 2, 'board request + host notification');
    assert.match(calls[0].url, /api\/task-board\/action/);
    assert.match(calls[1].url, /api\/marshal-superagent\/human-create/);
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.taskId, 'task-9');
    assert.equal(body.source, 'board-ui');
    assert.equal(body.requestId, 'req-1');
});

test('hook: update actions, failed responses and non-JSON bodies never notify', async () => {
    const update = loadHook();
    await update.window.fetch('api/task-board/action', {
        method: 'POST',
        body: JSON.stringify({ requestId: 'r', action: { kind: 'update', taskId: 'task-9', patch: { title: 'x' } } }),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(update.calls.length, 1);

    const failed = loadHook([{ ok: false, status: 400 }]);
    await failed.window.fetch('api/task-board/action', { method: 'POST', body: createEnvelope() });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(failed.calls.length, 1);

    const malformed = loadHook();
    await malformed.window.fetch('api/task-board/action', { method: 'POST', body: 'not-json' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(malformed.calls.length, 1);
});

test('hook: duplicate create ids do not double-notify and the patch is idempotent', async () => {
    const { window, calls } = loadHook();
    const init = { method: 'POST', body: createEnvelope('task-9') };
    await window.fetch('api/task-board/action', init);
    await window.fetch('api/task-board/action', init);
    await new Promise(resolve => setTimeout(resolve, 0));
    const notifications = calls.filter(call => String(call.url).includes('human-create'));
    assert.equal(notifications.length, 1);
    const before = window.fetch;
    vm.runInNewContext(hookSource, { window, URL, JSON, String, Set, Promise, console }, { filename: 'superagent-hook.js' });
    assert.equal(window.fetch, before, 'a second load leaves the installed hook alone');
});

test('hook: the generated bundle carries the observer', () => {
    assert.match(bundleSource, /dsh-marshal superagent human-create observer/);
    assert.match(bundleSource, /__marshalSuperagentHook/);
    assert.match(bundleSource, /api\/marshal-superagent\/human-create/);
});

test('hook: a window without fetch is left alone', () => {
    const window = { document: { baseURI: 'http://127.0.0.1/' } };
    assert.doesNotThrow(() => vm.runInNewContext(hookSource, { window, URL, JSON, String, Set, Promise, console }, { filename: 'superagent-hook.js' }));
    assert.equal(window.__marshalSuperagentHook, true);
    assert.equal(window.fetch, undefined);
});

