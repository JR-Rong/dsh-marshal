import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DeviceStore } from '../lib/src/hub/devices.js';
import { accountOwnerForDevice, createHubMemorySync, handleMemorySyncPull } from '../lib/src/hub/memory-sync.js';
import { createAgentMemoryService, reserveSummaryBudget } from '../lib/src/memory/agent-memory.js';
import { createMemoryHttpAuth, installOwnerFor, MEMORY_SESSION_COOKIE } from '../lib/src/memory/http-auth.js';
import { createMemoryRoutes } from '../lib/src/memory/http.js';
import { attachFileProposals, createMemoryService } from '../lib/src/memory/mount.js';
import { MemoryStore } from '../lib/src/memory/sqlite-store.js';
import { createMemorySyncClient, syncHttpBase } from '../lib/src/memory/sync-client.js';
import { sessionIsGroup } from '../lib/src/memory/policy.js';

const STRONG = 'Correct-Horse-Battery-7';

function tempRoot() {
    return mkdtempSync(join(tmpdir(), 'marshal-review-'));
}

async function call(handler, { method = 'GET', path = '/', headers = {}, body } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    req.method = method;
    req.url = path;
    req.headers = headers;
    req.socket = { remoteAddress: '127.0.0.1' };
    const res = {
        status: 0, headers: {}, body: '',
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        writeHead(status, extra = {}) { this.status = status; Object.assign(this.headers, extra); },
        end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
    };
    await handler(req, res);
    return { status: res.status, headers: res.headers, json: res.body === '' ? undefined : JSON.parse(res.body) };
}

test('unknown install owner is not an owner', async () => {
    assert.equal(installOwnerFor({}), undefined);
    assert.equal(installOwnerFor({ deviceId: 'laptop' }), undefined);
    assert.equal(installOwnerFor({ dshAccountHash: 'ab'.repeat(32) }), 'ab'.repeat(32));
    assert.equal(installOwnerFor({}, 'cd'.repeat(32)), 'cd'.repeat(32));
    const auth = createMemoryHttpAuth({ resolveOwner: async () => 'device:laptop' });
    const opened = await auth.open({
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-marshal-memory': '1', origin: 'dsh-app://app' },
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.session.owner, false);
    const routes = new Map(createMemoryRoutes({
        memory: { listProposals: () => [], approveProposal() { throw new Error('should not approve'); } },
        auth,
    }).map(route => [route.method + ' ' + route.path, route.handler]));
    const cookie = opened.cookies.map(item => item.split(';')[0]).join('; ');
    const csrf = opened.session.csrf;
    const denied = await call(routes.get('POST /marshal/memory/proposals/approve'), {
        method: 'POST',
        headers: { cookie, origin: 'dsh-app://app', 'x-marshal-csrf': csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'proposal' }),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, 'sign-in-to-approve');
    assert.match(denied.json.message, /请先登录机主账号后再审批全局记忆/);
});

test('file global write and promote become proposals', () => {
    const root = tempRoot();
    try {
        const files = createMemoryService({ root: join(root, 'files') });
        const agent = createAgentMemoryService({ root: join(root, 'sqlite') });
        attachFileProposals(files, agent);
        const before = readFileSync(join(root, 'files', 'global', 'profile.md'), 'utf8');
        const promoted = files.handle('promote', { content: '跨工作区结论必须先审批', cwd: '/work/app' }, { identity: 'agent-9' });
        assert.equal(promoted.proposal.status, 'pending');
        assert.equal(promoted.proposal.tags.includes('file-profile'), true);
        assert.equal(readFileSync(join(root, 'files', 'global', 'profile.md'), 'utf8'), before);
        assert.throws(() => files.store.write({ scope: 'global', file: 'profile', content: '直接写全局' }), /approval-required/);
        assert.throws(() => files.store.promote({ cwd: '/work/app', content: '直接沉淀' }), /approval-required/);
        const approved = agent.approveProposal(promoted.proposal.id);
        assert.match(readFileSync(join(root, 'files', 'global', 'profile.md'), 'utf8'), /跨工作区结论必须先审批/);
        assert.equal(approved.memory.content.includes('跨工作区结论必须先审批'), true);
        assert.equal(agent.store.list('global', 'global').some(item => item.content.includes('直接写全局')), false);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('uncertain group status hides no-group memory and the cache key includes the flag', () => {
    const root = tempRoot();
    try {
        const groups = join(root, 'groups.json');
        writeFileSync(groups, '{');
        assert.equal(sessionIsGroup({ sessionId: 's1' }, { ids: new Set(), status: 'unknown' }), true);
        assert.equal(sessionIsGroup({ sessionId: 's1', group: false }, { ids: new Set(['s1']), status: 'ok' }), true);
        assert.equal(sessionIsGroup(null, { ids: new Set(), status: 'missing' }), true);
        const service = createAgentMemoryService({ root: join(root, 'sqlite'), groupsFile: groups });
        service.store.remember('global', 'global', { title: '单聊', content: '只在确定的一对一会话出现', visibility: 'no-group', kind: 'fact' });
        const leaked = service.block({ agentId: 'agent-1', sessionId: 's1', group: false });
        assert.equal(leaked.includes('只在确定的一对一会话出现'), false);
        const directFile = join(root, 'missing-groups.json');
        service.groupsFile = directFile;
        service.cacheVersion++;
        const direct = service.block({ agentId: 'agent-1', sessionId: 's1', group: false });
        const grouped = service.block({ agentId: 'agent-1', sessionId: 's1', group: true });
        assert.match(direct, /只在确定的一对一会话出现/);
        assert.equal(grouped.includes('只在确定的一对一会话出现'), false);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('unbound devices do not claim legacy hub records', () => {
    const root = tempRoot();
    try {
        const devices = join(root, 'devices.json');
        writeFileSync(devices, JSON.stringify({ version: 2, devices: [] }));
        const added = new DeviceStore(devices).add('laptop', 'Laptop');
        assert.equal(added.entry.ownerId, undefined);
        assert.equal(accountOwnerForDevice(added.entry, 'hub-operator'), undefined);
        const file = join(root, 'memory-sync.json');
        writeFileSync(file, JSON.stringify({
            version: 1,
            records: { 'agent:agent-1:old': { scope: 'agent', ownerId: 'agent-1', id: 'old', revision: 1, updatedAt: 1, nonce: 'bg==', tag: 'bg==', ciphertext: 'b2xk' } },
        }));
        const hub = createHubMemorySync({ file, now: () => 3 });
        const deps = {
            memorySync: hub,
            deviceFromRequest: () => ({ id: 'laptop', revoked: false }),
        };
        let status = 0;
        const req = Readable.from([]);
        req.method = 'GET';
        req.url = '/marshal/api/memory-sync/pull?scope=agent&ownerId=agent-1';
        req.headers = { authorization: 'Bearer token' };
        req.socket = { remoteAddress: '203.0.113.10' };
        const res = { writeHead(code) { status = code; }, end() {}, setHeader() {} };
        handleMemorySyncPull(req, res, deps);
        assert.equal(status, 401);
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const records = parsed.legacyRecords ?? parsed.records;
        assert.equal(records['agent:agent-1:old'].id, 'old');
        assert.equal(parsed.legacyClaimedBy, undefined);
        assert.equal(hub.migrateLegacy('acct-real').migrated, 1);
        assert.equal(hub.pull({ accountOwner: 'acct-real', scope: 'agent', memoryOwnerId: 'agent-1' }).records.length, 1);
        assert.throws(() => hub.pull({ accountOwner: 'acct-other', scope: 'agent', memoryOwnerId: 'agent-1' }), /owner-mismatch/);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('memory sessions expire and writes require a matching origin', async () => {
    let now = 1_000_000;
    const auth = createMemoryHttpAuth({
        now: () => now,
        resolveOwner: async () => 'owner-a',
        installOwner: 'owner-a',
        absoluteMs: 1_000,
        idleMs: 400,
    });
    const opened = await auth.open({
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-marshal-memory': '1', origin: 'dsh-app://app' },
    });
    const cookie = MEMORY_SESSION_COOKIE + '=' + opened.session.id;
    const routes = new Map(createMemoryRoutes({
        memory: { saveSettings: () => ({}) },
        auth,
    }).map(route => [route.method + ' ' + route.path, route.handler]));
    const missing = await call(routes.get('POST /marshal/memory/settings'), {
        method: 'POST',
        headers: { cookie, 'x-marshal-csrf': opened.session.csrf, 'content-type': 'application/json' },
        body: '{}',
    });
    assert.equal(missing.status, 403);
    const wrong = await call(routes.get('POST /marshal/memory/settings'), {
        method: 'POST',
        headers: { cookie, origin: 'https://evil.example', 'x-marshal-csrf': opened.session.csrf, 'content-type': 'application/json' },
        body: '{}',
    });
    assert.equal(wrong.status, 403);
    now += 401;
    const idle = await call(routes.get('GET /marshal/memory/settings/get'), { headers: { cookie } });
    assert.equal(idle.status, 401);
});

test('summary budget is reserved before the call and caps output tokens', async () => {
    const root = tempRoot();
    try {
        let maxTokens = 0;
        const llm = {
            prepareCall: async ({ maxTokens: limit }) => {
                maxTokens = limit;
                return {
                    config: {},
                    async *stream() {
                        yield { type: 'text-delta', text: '[{"kind":"fact","title":"茶","content":"机主喜欢喝茉莉花茶","importance":80,"tags":["tea"]}]' };
                        yield { type: 'usage', usage: { totalTokens: 400 } };
                    },
                };
            },
        };
        const service = createAgentMemoryService({
            root,
            ledger: { teams: [{ id: 'team', members: [{ id: 'agent-1', name: '甲' }] }], runs: [{ sessionId: 's1', teamId: 'team', memberId: 'agent-1' }] },
        });
        service.llm = llm;
        service.settings.summaryProvider = 'other';
        service.settings.summaryModel = 'memo';
        service.settings.dailyTokenCap = 8;
        const skipped = await service.summarizeSession({
            id: 's1',
            events: [
                { type: 'user/message', data: { content: '请记住机主喜欢喝茉莉花茶' } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '记下了。' }] } } },
            ],
        });
        assert.equal(maxTokens, 0);
        assert.equal(skipped, 1);
        const reserved = reserveSummaryBudget(root, Date.now(), 100, 40);
        assert.equal(reserved.ok, true);
        assert.equal(reserved.maxTokens <= 60, true);
        assert.equal(reserved.tokens <= 100, true);
        service.settings.dailyTokenCap = 5000;
        await service.summarizeSession({
            id: 's1',
            events: [
                { type: 'user/message', data: { content: '请记住机主喜欢喝茉莉花茶' } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '记下了。' }] } } },
            ],
        });
        assert.equal(maxTokens <= 1024, true);
        assert.equal(maxTokens < 1024 || maxTokens === 1024, true);
        const usage = JSON.parse(readFileSync(join(root, 'summary-usage.json'), 'utf8'));
        assert.equal(usage.tokens <= 5000, true);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('approved global memories sync and proposals stay local', async () => {
    const root = tempRoot();
    try {
        const seen = [];
        const fetchImpl = async (url, init = {}) => {
            seen.push(String(url) + '\n' + String(init.body ?? ''));
            return { ok: true, status: 200, async json() { return { ok: true, records: [], salt: 'salt-for-account-aaaa', accepted: 1 }; } };
        };
        const service = createAgentMemoryService({
            root, hubUrl: 'https://hub.example/marshal/uplink', token: 'token-a', passphrase: STRONG, deviceId: 'dev-a', fetchImpl,
        });
        service.store.propose({ title: '待审', content: '提案不该出现在同步正文', visibility: 'all' }, { agentId: 'agent-1' });
        service.store.remember('global', 'global', { title: '已批准', content: '这条全局记忆应该同步', visibility: 'all', kind: 'fact' });
        await service.syncFor({ agentId: 'agent-1' });
        const pushes = seen.filter(entry => entry.includes('/push')).map(entry => JSON.parse(entry.slice(entry.indexOf('\n') + 1)));
        const globalPush = pushes.find(body => body.scope === 'global');
        assert.equal(globalPush.ownerId, 'global');
        assert.equal(globalPush.records.length, 1);
        assert.equal(globalPush.records[0].kdf, 'scrypt');
        assert.equal(seen.some(entry => entry.includes('提案不该出现在同步正文')), false);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('a tombstone blocks the same text under a new id', () => {
    const root = tempRoot();
    try {
        const store = new MemoryStore({ root });
        const item = store.remember('agent', 'agent-1', { title: 'Tea', content: 'Owner likes jasmine tea', kind: 'fact' });
        assert.equal(store.forget('agent', 'agent-1', item.id), true);
        const revived = store.remember('agent', 'agent-1', { title: ' tea ', content: '  Owner   likes jasmine tea ', kind: 'fact' });
        assert.equal(revived, undefined);
        assert.equal(store.list('agent', 'agent-1').length, 0);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('sync base keeps https and refuses remote http', () => {
    assert.equal(syncHttpBase('wss://hub.example/marshal/uplink'), 'https://hub.example');
    assert.equal(syncHttpBase('https://hub.example/marshal/uplink'), 'https://hub.example');
    assert.equal(syncHttpBase('http://hub.example/marshal/uplink'), undefined);
    assert.equal(syncHttpBase('http://127.0.0.1:8787/marshal/uplink'), 'http://127.0.0.1:8787');
    assert.equal(createMemorySyncClient({ hubUrl: 'http://hub.example/uplink', token: 'token-a', passphrase: STRONG }), undefined);
    const loopback = createMemorySyncClient({ hubUrl: 'http://127.0.0.1:8787/marshal/uplink', token: 'token-a', passphrase: STRONG, fetchImpl: async () => ({ ok: true, async json() { return { records: [] }; } }) });
    assert.equal(typeof loopback.sync, 'function');
});

test('loopback memory cookies are readable without Secure or __Host-', async () => {
    const auth = createMemoryHttpAuth({ resolveOwner: async () => 'owner-a', installOwner: 'owner-a' });
    const opened = await auth.open({
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-marshal-memory': '1', origin: 'http://127.0.0.1:8787' },
    }, ['http://127.0.0.1:8787']);
    const cookies = opened.cookies.join('\n');
    assert.equal(cookies.includes('Secure'), false);
    assert.equal(cookies.includes('__Host-'), false);
    assert.match(cookies, /marshal-memory-session=/);
    assert.match(cookies, /marshal-memory-csrf=/);
    assert.match(cookies, /SameSite=Strict/);
    assert.match(cookies, /HttpOnly/);
    assert.equal(cookies.split('HttpOnly').length, 2);
});
