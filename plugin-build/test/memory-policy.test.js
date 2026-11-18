import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createHubMemorySync, handleMemorySyncPull, handleMemorySyncPush } from '../lib/src/hub/memory-sync.js';
import { agentMemoryTool, createAgentMemoryService } from '../lib/src/memory/agent-memory.js';
import { createMemoryHttpAuth, MEMORY_CSRF_COOKIE, MEMORY_SESSION_COOKIE } from '../lib/src/memory/http-auth.js';
import { createMemoryRoutes } from '../lib/src/memory/http.js';
import { MemoryStore as FileMemory } from '../lib/src/memory/store.js';
import { MemoryStore } from '../lib/src/memory/sqlite-store.js';
import { createMemorySyncClient } from '../lib/src/memory/sync-client.js';
import { LEGACY_SALT, passphraseAcceptable, syncKey } from '../lib/src/memory/sync-crypto.js';
import { buildHealthBody } from '../lib/src/groups/mount.js';

const STRONG = 'Correct-Horse-Battery-7';

function tempRoot() {
    return mkdtempSync(join(tmpdir(), 'marshal-memory-'));
}

function ledger() {
    return {
        teams: [{
            id: 'team',
            workspaceId: 'ws-1',
            members: [{ id: 'agent-1', name: '甲' }],
        }],
        runs: [{ sessionId: 's1', teamId: 'team', memberId: 'agent-1' }],
    };
}

function session() {
    return {
        id: 's1',
        events: [
            { type: 'user/message', data: { content: '请记住机主喜欢喝茉莉花茶' } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '记下了。' }] } } },
        ],
    };
}

async function call(handler, { method = 'GET', path = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    req.method = method;
    req.url = path;
    req.headers = headers;
    req.socket = { remoteAddress };
    const res = { status: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }, end(chunk) { if (chunk !== undefined) this.body += String(chunk); } };
    await handler(req, res);
    return { status: res.status, headers: res.headers, body: res.body, json: res.body === '' ? undefined : JSON.parse(res.body) };
}

function cookieHeader(setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    return list.map(item => String(item).split(';')[0]).join('; ');
}

function cookieValue(setCookie, name) {
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const item of list) {
        const first = String(item).split(';')[0];
        if (first.startsWith(name + '=')) return first.slice(name.length + 1);
    }
    return '';
}

test('global agent writes become proposals and are not injected', async () => {
    const root = tempRoot();
    try {
        const service = createAgentMemoryService({ root, ledger: ledger() });
        const tool = agentMemoryTool(service);
        const secret = '提案专用事实-紫藤密码';
        const result = await tool.execute({ action: 'remember', scope: 'global', title: '紫藤', text: secret, visibility: 'all' }, { agent: { session: { id: 's1' } } });
        assert.equal(result.ok, true);
        assert.equal(result.proposal.status, 'pending');
        assert.equal(result.proposal.agentId, 'agent-1');
        assert.equal(result.proposal.visibility, 'all');
        assert.equal(typeof result.proposal.createdAt, 'number');
        assert.equal(service.store.list('global', 'global').some(item => item.content.includes(secret)), false);
        assert.equal(service.block({ agentId: 'agent-1', sessionId: 's1' }).includes(secret), false);
        const listed = await tool.execute({ action: 'list', scope: 'global' }, { agent: { session: { id: 's1' } } });
        assert.equal(listed.text.includes(secret), false);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('owner approves, edits, or rejects a global proposal', () => {
    const root = tempRoot();
    try {
        const store = new MemoryStore({ root });
        const pending = store.propose({ title: '原标题', content: '原始内容要足够长', visibility: 'private', kind: 'fact' }, { agentId: 'agent-1' });
        assert.equal(pending.visibility, 'no-group');
        const rejected = store.propose({ title: '丢掉', content: '这条不该变成记忆', visibility: 'all' }, { agentId: 'agent-1' });
        const edited = store.approveProposal(pending.id, { title: '新标题', text: '机主改过的全局事实', visibility: 'all' });
        assert.equal(edited.memory.visibility, 'all');
        assert.equal(edited.memory.content, '机主改过的全局事实');
        assert.equal(store.getProposal(pending.id).status, 'approved');
        assert.equal(store.rejectProposal(rejected.id).status, 'rejected');
        assert.equal(store.list('global', 'global').some(item => item.content.includes('不该变成记忆')), false);
        assert.equal(store.listProposals('pending').length, 0);
        const direct = store.remember('global', 'global', { title: '机主直写', content: '机主直接创建的全局记忆', visibility: 'no-group', kind: 'fact' });
        assert.equal(direct.visibility, 'no-group');
        const updated = store.update('global', 'global', direct.id, { content: '机主改后的直写记忆', visibility: 'all' });
        assert.equal(updated.visibility, 'all');
        assert.equal(store.forget('global', 'global', direct.id), true);
        assert.equal(store.get('global', 'global', direct.id), undefined);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('global visibility migrates and is enforced for group sessions', () => {
    const root = tempRoot();
    try {
        const first = new MemoryStore({ root });
        const kept = first.remember('global', 'global', { title: '全体', content: '所有会话都要看到的全局规则', visibility: 'all', kind: 'fact' });
        const hidden = first.remember('global', 'global', { title: '单聊', content: '只在一对一会话出现的偏好', visibility: 'no-group', kind: 'fact' });
        first.db('global', 'global').prepare("UPDATE memories SET visibility='private' WHERE id=?").run(hidden.id);
        first.db('global', 'global').prepare("UPDATE memories SET visibility='secret' WHERE id=?").run(kept.id);
        first.db('global', 'global').prepare("UPDATE memories SET visibility='all' WHERE id=?").run(kept.id);
        first.close();
        const store = new MemoryStore({ root });
        assert.equal(store.get('global', 'global', hidden.id).visibility, 'no-group');
        assert.equal(store.get('global', 'global', kept.id).visibility, 'all');
        const service = createAgentMemoryService({ root });
        service.store = store;
        const alone = service.block({ agentId: 'agent-1', group: false, sessionId: 'solo' });
        const group = service.block({ agentId: 'agent-1', group: true, sessionId: 'room' });
        assert.match(alone, /所有会话都要看到的全局规则/);
        assert.match(alone, /只在一对一会话出现的偏好/);
        assert.match(group, /所有会话都要看到的全局规则/);
        assert.equal(group.includes('只在一对一会话出现的偏好'), false);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('file memory and sqlite memory inject one copy of the same fact', () => {
    const root = tempRoot();
    try {
        const files = new FileMemory(join(root, 'files'));
        files.ensure();
        const fact = '部署必须使用 pnpm，不要使用 npm install';
        writeFileSync(join(root, 'files', 'global', 'rules.md'), fact + '\n');
        const service = createAgentMemoryService({ root: join(root, 'sqlite'), fileText: () => files.promptText('/work/app') });
        service.store.remember('agent', 'agent-1', { title: '包管理', content: fact, kind: 'fact', visibility: 'private' });
        service.store.remember('agent', 'agent-1', { title: '主题', content: '编辑器主题固定为暗色', kind: 'fact', visibility: 'private' });
        const block = service.block({ agentId: 'agent-1', group: false });
        const file = files.promptText('/work/app');
        assert.match(file, /部署必须使用 pnpm/);
        assert.equal(block.includes('部署必须使用 pnpm'), false);
        assert.match(block, /编辑器主题固定为暗色/);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('summary uses prepareCall until the daily token cap, then the heuristic', async () => {
    const root = tempRoot();
    try {
        let calls = 0;
        const llm = {
            prepareCall: async ({ provider, model }) => {
                calls += 1;
                assert.equal(provider, 'other');
                assert.equal(model, 'memo');
                return {
                    config: { provider, model },
                    async *stream() {
                        yield { type: 'text-delta', text: '[{"kind":"fact","title":"茶","content":"机主喜欢喝茉莉花茶","importance":80,"tags":["tea"]}]' };
                        yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 } };
                    },
                };
            },
            stream() { throw new Error('raw stream must not be used'); },
        };
        const service = createAgentMemoryService({ root, ledger: ledger() });
        service.llm = llm;
        service.settings.summaryProvider = 'other';
        service.settings.summaryModel = 'memo';
        service.settings.dailyTokenCap = 20000;
        const wrote = await service.summarizeSession(session());
        assert.equal(calls, 1);
        assert.equal(wrote, 1);
        const usage = JSON.parse(readFileSync(join(root, 'summary-usage.json'), 'utf8'));
        assert.equal(usage.tokens, 50);
        service.settings.dailyTokenCap = usage.tokens;
        const second = await service.summarizeSession(session());
        assert.equal(calls, 1);
        assert.equal(second >= 1, true);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('passphrase strength and per-owner salt replace the fixed salt', () => {
    assert.equal(passphraseAcceptable('short'), false);
    assert.equal(passphraseAcceptable('alllowercase!!'), false);
    assert.equal(passphraseAcceptable(STRONG), true);
    const legacy = syncKey(STRONG, LEGACY_SALT);
    const next = syncKey(STRONG, 'owner-salt-value-1');
    assert.notEqual(legacy.equals(next), true);
    assert.equal(syncKey('password', 'owner-salt-value-1'), undefined);
});

test('hub sync checks the device owner, keeps tombstones, and caps the file', async () => {
    const root = tempRoot();
    const file = join(root, 'memory-sync.json');
    try {
        writeFileSync(file, JSON.stringify({
            version: 1,
            records: {
                'agent:agent-1:old': { scope: 'agent', ownerId: 'agent-1', id: 'old', revision: 1, updatedAt: 1, nonce: 'bg==', tag: 'bg==', ciphertext: 'b2xk', kdf: 'legacy' },
            },
        }), { mode: 0o644 });
        const hub = createHubMemorySync({ file, maxBytes: 80, now: () => 10 });
        const devices = {
            'token-op': { id: 'dev-op', revoked: false },
            'token-a': { id: 'dev-a', ownerId: 'acct-a', revoked: false },
            'token-b': { id: 'dev-b', ownerId: 'acct-b', revoked: false },
        };
        const deps = {
            memorySync: hub,
            operatorId: 'hub-operator',
            deviceFromRequest: req => devices[(req.headers.authorization ?? '').replace('Bearer ', '')],
        };
        const pull = (path, token) => call((req, res) => handleMemorySyncPull(req, res, deps), { path, headers: token === undefined ? {} : { authorization: 'Bearer ' + token }, remoteAddress: '203.0.113.8' });
        const legacy = await pull('/marshal/api/memory-sync/pull?scope=agent&ownerId=agent-1', 'token-op');
        assert.equal(legacy.status, 401);
        const before = await pull('/marshal/api/memory-sync/pull?scope=agent&ownerId=agent-1', 'token-a');
        assert.equal(before.status, 200);
        assert.equal(before.json.records.length, 0);
        assert.equal(hub.migrateLegacy('acct-a').migrated, 1);
        const claimed = await pull('/marshal/api/memory-sync/pull?scope=agent&ownerId=agent-1', 'token-a');
        assert.equal(claimed.json.records.length, 1);
        const stolen = await pull('/marshal/api/memory-sync/pull?scope=agent&ownerId=agent-1', 'token-b');
        assert.equal(stolen.status, 403);
        assert.equal(stolen.json.code, 'owner-mismatch');
        const anonymous = await pull('/marshal/api/memory-sync/pull?scope=agent&ownerId=agent-1');
        assert.equal(anonymous.status, 401);
        const live = await call((req, res) => handleMemorySyncPush(req, res, deps), {
            method: 'POST', path: '/marshal/api/memory-sync/push', remoteAddress: '203.0.113.8',
            headers: { authorization: 'Bearer token-a', 'content-type': 'application/json' },
            body: JSON.stringify({ scope: 'agent', ownerId: 'agent-a', salt: 'salt-for-account-a', records: [{ id: 'm1', revision: 2, updatedAt: 2, nonce: 'bg==', tag: 'bg==', ciphertext: 'Y2lwaGVy', kdf: 'scrypt' }] }),
        });
        assert.equal(live.status, 200);
        assert.equal(live.json.salt, 'salt-for-account-a');
        assert.equal((statSync(file).mode & 0o777), 0o600);
        const other = await pull('/marshal/api/memory-sync/pull?scope=agent&ownerId=agent-a', 'token-b');
        assert.equal(other.status, 403);
        const tomb = await call((req, res) => handleMemorySyncPush(req, res, deps), {
            method: 'POST', path: '/marshal/api/memory-sync/push', remoteAddress: '203.0.113.8',
            headers: { authorization: 'Bearer token-a', 'content-type': 'application/json' },
            body: JSON.stringify({ scope: 'agent', ownerId: 'agent-a', salt: 'salt-for-account-a', records: [{ id: 'm1', revision: 3, updatedAt: 3, tombstone: true }] }),
        });
        assert.equal(tomb.status, 200);
        const resurrect = await call((req, res) => handleMemorySyncPush(req, res, deps), {
            method: 'POST', path: '/marshal/api/memory-sync/push', remoteAddress: '203.0.113.8',
            headers: { authorization: 'Bearer token-a', 'content-type': 'application/json' },
            body: JSON.stringify({ scope: 'agent', ownerId: 'agent-a', salt: 'salt-for-account-a', records: [{ id: 'm1', revision: 9, updatedAt: 9, nonce: 'bg==', tag: 'bg==', ciphertext: 'bmV3', kdf: 'scrypt' }] }),
        });
        assert.equal(resurrect.status, 200);
        assert.equal(resurrect.json.accepted, 0);
        const pulled = await pull('/marshal/api/memory-sync/pull?scope=agent&ownerId=agent-a', 'token-a');
        assert.equal(pulled.json.records.length, 1);
        assert.equal(pulled.json.records[0].tombstone, true);
        const tooBig = await call((req, res) => handleMemorySyncPush(req, res, deps), {
            method: 'POST', path: '/marshal/api/memory-sync/push', remoteAddress: '203.0.113.8',
            headers: { authorization: 'Bearer token-a', 'content-type': 'application/json' },
            body: JSON.stringify({ scope: 'agent', ownerId: 'agent-a', salt: 'salt-for-account-a', records: [{ id: 'huge', revision: 4, updatedAt: 4, nonce: 'bg==', tag: 'bg==', ciphertext: 'x'.repeat(200), kdf: 'scrypt' }] }),
        });
        assert.equal(tooBig.status, 413);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('sync client round-trips tombstones with the hub and refuses a weak passphrase', async () => {
    const root = tempRoot();
    try {
        const hub = createHubMemorySync({ file: join(root, 'hub.json'), now: () => 5 });
        const device = { id: 'dev-a', ownerId: 'acct-a', revoked: false };
        const deps = { memorySync: hub, operatorId: 'hub-operator', deviceFromRequest: () => device };
        const fetchImpl = async (url, init = {}) => {
            const parsed = new URL(url);
            const req = Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]);
            req.method = init.method ?? 'GET';
            req.url = parsed.pathname + parsed.search;
            req.headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
            req.socket = { remoteAddress: '203.0.113.9' };
            const res = { status: 200, body: '', setHeader() {}, writeHead(status) { this.status = status; }, end(chunk) { this.body = chunk ?? ''; } };
            if (parsed.pathname.endsWith('/push')) await handleMemorySyncPush(req, res, deps);
            else handleMemorySyncPull(req, res, deps);
            return { ok: res.status >= 200 && res.status < 300, status: res.status, async json() { return JSON.parse(res.body || '{}'); } };
        };
        const local = new MemoryStore({ root: join(root, 'local') });
        const remembered = local.remember('agent', 'agent-1', { title: '盐', content: '每台设备使用不同的同步盐', kind: 'fact' });
        const client = createMemorySyncClient({ hubUrl: 'wss://hub.example/marshal/uplink', token: 'token-a', passphrase: STRONG, deviceId: 'dev-a', fetchImpl });
        const first = await client.sync(local, [{ scope: 'agent', ownerId: 'agent-1' }]);
        assert.equal(first.pushed >= 1, true);
        local.forget('agent', 'agent-1', remembered.id);
        await client.sync(local, [{ scope: 'agent', ownerId: 'agent-1' }]);
        const remote = new MemoryStore({ root: join(root, 'remote') });
        remote.remember('agent', 'agent-1', { title: '盐', content: '每台设备使用不同的同步盐', kind: 'fact' }, { id: remembered.id });
        await client.sync(remote, [{ scope: 'agent', ownerId: 'agent-1' }]);
        assert.equal(remote.get('agent', 'agent-1', remembered.id), undefined);
        assert.equal(remote.hasTombstone('agent', 'agent-1', remembered.id), true);
        const weak = createMemorySyncClient({ hubUrl: 'wss://hub.example/marshal/uplink', token: 'token-a', passphrase: 'password', fetchImpl });
        await assert.rejects(() => weak.sync(local, [{ scope: 'agent', ownerId: 'agent-1' }]), /weak-passphrase/);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('memory HTTP binds the caller and requires owner CSRF for global approval', async () => {
    const root = tempRoot();
    try {
        const memory = createAgentMemoryService({ root });
        const book = {
            teams: [
                { id: 'a', workspaceId: 'ws-a', members: [{ id: 'agent-a', name: '甲' }] },
                { id: 'b', workspaceId: 'ws-b', ownerId: 'owner-b', members: [{ id: 'agent-b', name: '乙', ownerId: 'owner-b' }] },
            ],
        };
        let who = 'owner-a';
        const auth = createMemoryHttpAuth({ resolveOwner: async () => who, installOwner: 'owner-a', loadLedger: () => book });
        const routes = new Map(createMemoryRoutes({ memory, auth }).map(route => [route.method + ' ' + route.path, route.handler]));
        const opened = await call(routes.get('POST /marshal/memory/session'), { method: 'POST', headers: { 'x-marshal-memory': '1', origin: 'dsh-app://app' } });
        assert.equal(opened.status, 200);
        const cookies = cookieHeader(opened.headers['set-cookie']);
        const csrf = cookieValue(opened.headers['set-cookie'], MEMORY_CSRF_COOKIE);
        assert.equal(cookies.includes(MEMORY_SESSION_COOKIE), true);
        const denied = await call(routes.get('GET /marshal/memory/list'), { path: '/marshal/memory/list?agentId=agent-b' });
        assert.equal(denied.status, 401);
        const foreign = await call(routes.get('GET /marshal/memory/list'), { path: '/marshal/memory/list?agentId=agent-b', headers: { cookie: cookies } });
        assert.equal(foreign.status, 403);
        assert.equal(foreign.json.code, 'owner-mismatch');
        const own = await call(routes.get('GET /marshal/memory/list'), { path: '/marshal/memory/list?agentId=agent-a', headers: { cookie: cookies } });
        assert.equal(own.status, 200);
        const proposal = memory.store.propose({ title: '待审', content: '等待机主同意的全局事实', visibility: 'all' }, { agentId: 'agent-a' });
        const noCsrf = await call(routes.get('POST /marshal/memory/proposals/approve'), {
            method: 'POST', headers: { cookie: cookies, 'content-type': 'application/json', origin: 'dsh-app://app' }, body: JSON.stringify({ id: proposal.id }),
        });
        assert.equal(noCsrf.status, 403);
        const approved = await call(routes.get('POST /marshal/memory/proposals/approve'), {
            method: 'POST',
            headers: { cookie: cookies, 'content-type': 'application/json', 'x-marshal-csrf': csrf, origin: 'dsh-app://app' },
            body: JSON.stringify({ id: proposal.id, text: '机主批准的全局事实', visibility: 'no-group' }),
        });
        assert.equal(approved.status, 200);
        assert.equal(approved.json.memory.visibility, 'no-group');
        who = 'owner-b';
        const other = await call(routes.get('POST /marshal/memory/session'), { method: 'POST', headers: { 'x-marshal-memory': '1', origin: 'dsh-app://app' } });
        const otherCookies = cookieHeader(other.headers['set-cookie']);
        const otherCsrf = cookieValue(other.headers['set-cookie'], MEMORY_CSRF_COOKIE);
        const next = memory.store.propose({ title: '另一条', content: '另一个账号不能审批', visibility: 'all' }, { agentId: 'agent-b' });
        const blocked = await call(routes.get('POST /marshal/memory/proposals/approve'), {
            method: 'POST',
            headers: { cookie: otherCookies, 'content-type': 'application/json', 'x-marshal-csrf': otherCsrf, origin: 'dsh-app://app' },
            body: JSON.stringify({ id: next.id }),
        });
        assert.equal(blocked.status, 403);
        assert.equal(blocked.json.code, 'sign-in-to-approve');
        const remote = buildHealthBody({ socket: { remoteAddress: '203.0.113.4' } }, { deviceId: 'dev', agents: true, taskBoardSource: 'local', crossGroups: false, agentMemory: true });
        const local = buildHealthBody({ socket: { remoteAddress: '127.0.0.1' } }, { deviceId: 'dev', agents: true, taskBoardSource: 'local', crossGroups: false, agentMemory: true });
        assert.equal(remote.capabilities.agentMemory, undefined);
        assert.equal(local.capabilities.agentMemory, true);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});
