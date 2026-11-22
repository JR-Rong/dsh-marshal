import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createMemoryHttpAuth } from '../lib/src/memory/http-auth.js';
import { createMemoryRoutes } from '../lib/src/memory/http.js';

const marker = { 'x-marshal-desktop': '1' };
const openHeaders = { ...marker, 'x-marshal-memory': '1' };
const createAuth = () => createMemoryHttpAuth({ resolveOwner: async () => 'owner', installOwner: 'owner', loadLedger: () => ({ teams: [] }) });
const request = (headers = {}, address = '127.0.0.1') => ({ headers, socket: { remoteAddress: address } });

test('desktop proof is limited to the local native transport and still checks CSRF', async () => {
    const auth = createAuth();
    for (const [headers, address] of [
        [{ ...openHeaders, origin: 'https://other.example' }, '127.0.0.1'],
        [{ ...openHeaders, 'sec-fetch-site': 'cross-site' }, '127.0.0.1'],
        [{ ...openHeaders, 'sec-fetch-site': 'same-origin' }, '127.0.0.1'],
        [openHeaders, '192.0.2.10'],
        [{ 'x-marshal-memory': '1' }, '127.0.0.1'],
    ]) assert.equal((await auth.open(request(headers, address))).ok, false);
    const opened = await auth.open(request(openHeaders));
    assert.equal(opened.ok, true);
    assert.equal(opened.cookies, undefined);
    const proof = { ...marker, 'x-marshal-session': opened.session.id, 'x-marshal-csrf': opened.session.csrf };
    assert.equal(auth.authenticate(request(proof), { write: true }).ok, true);
    assert.equal(auth.authenticate(request({ ...proof, 'x-marshal-csrf': 'absent' }), { write: true }).code, 'memory-csrf-mismatch');
    assert.equal(auth.authenticate(request({ ...proof, origin: 'https://other.example' })).ok, false);
    assert.equal(auth.authenticate(request({ cookie: 'marshal-memory-session=' + opened.session.id })).ok, false);
    assert.equal(createAuth().authenticate(request(proof)).status, 401);
});

test('shipped client reopens a desktop session once across concurrent reads and writes after reload', async () => {
    const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('    const MEMORY_CSRF_COOKIE ='), source.indexOf('    const AGENT_TEAM_PREFIX'));
    let auth = createAuth();
    let opens = 0;
    let changes = 0;
    const memory = { saveSettings: patch => { changes++; return patch; }, settings: { autoRecall: true } };
    async function fetch(url, init) {
        // DSH Desktop forwards its own host cookie and strips Origin, fetch-site
        // and the renderer's Cookie. It also strips response Set-Cookie.
        const method = init.method ?? 'GET';
        const req = { ...request({ ...init.headers, cookie: 'dsh-auth-fixture=host-session' }), url: url.pathname, method,
            async *[Symbol.asyncIterator]() { if (init.body) yield init.body; } };
        const route = createMemoryRoutes({ memory, auth }).find(item => item.path === url.pathname && item.method === method);
        assert.ok(route);
        if (url.pathname.endsWith('/session')) opens++;
        let status;
        let body;
        const res = { writeHead(code) { status = code; }, setHeader() {}, end(value) { body = value; } };
        await route.handler(req, res);
        return new Response(body, { status });
    }
    const context = { window: { location: new URL('dsh-app://app/') },
        document: { baseURI: 'dsh-app://app/', cookie: '' }, fetch, URL };
    const call = runInNewContext(block + '\nfetchJson', context);
    await Promise.all([call('marshal/memory/settings/get'), call('marshal/memory/settings/get')]);
    assert.equal(opens, 1);
    auth = createAuth();
    const [, written] = await Promise.all([
        call('marshal/memory/settings/get'), call('marshal/memory/settings', { autoRecall: false }),
    ]);
    assert.equal(written.settings.autoRecall, false);
    assert.equal(changes, 1);
    assert.equal(opens, 2);
});
