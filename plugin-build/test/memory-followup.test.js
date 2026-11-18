import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createHubMemorySync, handleMemorySyncMigrate } from '../lib/src/hub/memory-sync.js';
import { createAgentMemoryService } from '../lib/src/memory/agent-memory.js';
import { createMemoryHttpAuth, resolveDesktopOwner } from '../lib/src/memory/http-auth.js';
import { createMemoryRoutes } from '../lib/src/memory/http.js';
import { attachFileProposals, createMemoryService } from '../lib/src/memory/mount.js';
import { sessionIsGroup } from '../lib/src/memory/policy.js';

const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);

function tempRoot() {
    return mkdtempSync(join(tmpdir(), 'marshal-followup-'));
}

function legacyHub(root) {
    const file = join(root, 'memory-sync.json');
    writeFileSync(file, JSON.stringify({
        version: 1,
        records: {
            'agent:agent-1:old': { scope: 'agent', ownerId: 'agent-1', id: 'old', revision: 1, updatedAt: 4, nonce: 'bg==', tag: 'bg==', ciphertext: 'b2xk' },
        },
    }));
    return createHubMemorySync({ file, now: () => 4 });
}

async function call(handler, { method = 'POST', path = '/', headers = {}, body, remoteAddress = '203.0.113.20' } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    req.method = method;
    req.url = path;
    req.headers = headers;
    req.socket = { remoteAddress };
    const res = {
        status: 0, body: '',
        setHeader() {},
        writeHead(status) { this.status = status; },
        end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
    };
    await handler(req, res);
    return { status: res.status, json: res.body === '' ? undefined : JSON.parse(res.body) };
}

test('hub migrate endpoint binds legacy records once and refuses everyone else', async () => {
    const root = tempRoot();
    try {
        const hub = legacyHub(root);
        const devices = {
            unbound: { id: 'laptop', revoked: false },
            owner: { id: 'dev-a', ownerId: 'acct-a', revoked: false },
            other: { id: 'dev-b', ownerId: 'acct-b', revoked: false },
        };
        const deps = {
            memorySync: hub,
            deviceFromRequest: req => devices[(req.headers.authorization ?? '').replace('Bearer ', '')],
        };
        const migrate = (token, body) => call((req, res) => handleMemorySyncMigrate(req, res, deps), {
            path: '/marshal/api/memory-sync/migrate',
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            body: body ?? '{"accountOwner":"acct-stolen"}',
        });
        const refused = await migrate('unbound');
        assert.equal(refused.status, 401);
        assert.equal(JSON.parse(readFileSync(join(root, 'memory-sync.json'), 'utf8')).records['agent:agent-1:old'].id, 'old');
        const first = await migrate('owner');
        assert.equal(first.status, 200);
        assert.equal(first.json.migrated, 1);
        assert.equal(first.json.accountOwner, 'acct-a');
        const again = await migrate('owner');
        assert.equal(again.status, 200);
        assert.equal(again.json.migrated, 0);
        assert.equal(hub.pull({ accountOwner: 'acct-a', scope: 'agent', memoryOwnerId: 'agent-1' }).records.length, 1);
        const stolen = await migrate('other');
        assert.equal(stolen.status, 403);
        assert.equal(stolen.json.code, 'owner-mismatch');
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('local migrate button route is owner-only and calls the hub migration', async () => {
    let calls = 0;
    const memory = { async migrateLegacy() { calls += 1; return { migrated: 2 }; } };
    const auth = createMemoryHttpAuth({ resolveOwner: async () => 'owner-a', installOwner: 'owner-a' });
    const opened = await auth.open({
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-marshal-memory': '1', origin: 'dsh-app://app' },
    });
    const routes = new Map(createMemoryRoutes({ memory, auth }).map(route => [route.method + ' ' + route.path, route.handler]));
    const cookie = opened.cookies.map(item => item.split(';')[0]).join('; ');
    const guest = createMemoryHttpAuth({ resolveOwner: async () => 'device:laptop' });
    const guestOpen = await guest.open({
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-marshal-memory': '1', origin: 'dsh-app://app' },
    });
    const guestRoutes = new Map(createMemoryRoutes({ memory, auth: guest }).map(route => [route.method + ' ' + route.path, route.handler]));
    const denied = await call(guestRoutes.get('POST /marshal/memory/migrate-legacy'), {
        remoteAddress: '127.0.0.1',
        headers: {
            cookie: guestOpen.cookies.map(item => item.split(';')[0]).join('; '),
            origin: 'dsh-app://app',
            'x-marshal-csrf': guestOpen.session.csrf,
            'content-type': 'application/json',
        },
        body: '{}',
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, 'sign-in-to-approve');
    assert.equal(calls, 0);
    const ok = await call(routes.get('POST /marshal/memory/migrate-legacy'), {
        remoteAddress: '127.0.0.1',
        headers: { cookie, origin: 'dsh-app://app', 'x-marshal-csrf': opened.session.csrf, 'content-type': 'application/json' },
        body: '{}',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.migrated, 2);
    assert.equal(calls, 1);
});

test('file-rules are all-or-sqlite, and no-group never enters rules.md', () => {
    const root = tempRoot();
    try {
        const files = createMemoryService({ root: join(root, 'files') });
        const agent = createAgentMemoryService({ root: join(root, 'sqlite') });
        attachFileProposals(files, agent);
        const rulesBefore = readFileSync(join(root, 'files', 'global', 'rules.md'), 'utf8');
        const proposed = files.handle('write', { scope: 'global', file: 'rules', content: '所有会话都要遵守的铁律' }, { identity: 'agent-1' });
        assert.equal(proposed.proposal.visibility, 'all');
        assert.equal(proposed.proposal.tags.includes('file-rules'), true);
        agent.approveProposal(proposed.proposal.id);
        assert.match(readFileSync(join(root, 'files', 'global', 'rules.md'), 'utf8'), /所有会话都要遵守的铁律/);
        const quiet = files.handle('write', { scope: 'global', file: 'rules', content: '这条只该留在单聊' }, { identity: 'agent-1' });
        agent.approveProposal(quiet.proposal.id, { visibility: 'no-group' });
        const rulesAfter = readFileSync(join(root, 'files', 'global', 'rules.md'), 'utf8');
        assert.equal(rulesAfter.includes('这条只该留在单聊'), false);
        assert.equal(rulesBefore.includes('这条只该留在单聊'), false);
        const stored = agent.store.list('global', 'global').find(item => item.content.includes('这条只该留在单聊'));
        assert.equal(stored.visibility, 'no-group');
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('the first signed-in owner stays usable after logout, and a different account does not', async () => {
    const root = tempRoot();
    const ownerFile = join(root, 'owner.json');
    try {
        assert.equal(resolveDesktopOwner({ config: {}, platformHash: undefined, ownerFile }).install, undefined);
        const signedIn = resolveDesktopOwner({ config: {}, platformHash: HASH_A, ownerFile });
        assert.equal(signedIn.install, HASH_A);
        assert.equal(signedIn.caller, HASH_A);
        const loggedOut = resolveDesktopOwner({ config: {}, platformHash: undefined, ownerFile });
        assert.equal(loggedOut.install, HASH_A);
        assert.equal(loggedOut.caller, HASH_A);
        const other = resolveDesktopOwner({ config: {}, platformHash: HASH_B, ownerFile });
        assert.equal(other.install, HASH_A);
        assert.equal(other.caller, HASH_B);
        assert.notEqual(other.caller, other.install);
        const auth = createMemoryHttpAuth({
            resolveOwner: async () => loggedOut.caller,
            installOwner: loggedOut.install,
        });
        const opened = await auth.open({
            socket: { remoteAddress: '127.0.0.1' },
            headers: { 'x-marshal-memory': '1', origin: 'dsh-app://app' },
        });
        assert.equal(opened.session.owner, true);
        const stranger = createMemoryHttpAuth({
            resolveOwner: async () => other.caller,
            installOwner: other.install,
        });
        const strangerOpen = await stranger.open({
            socket: { remoteAddress: '127.0.0.1' },
            headers: { 'x-marshal-memory': '1', origin: 'dsh-app://app' },
        });
        assert.equal(strangerOpen.session.owner, false);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test('injection without a session id fails closed as a group', () => {
    const roster = { ids: new Set(), status: 'missing' };
    assert.equal(sessionIsGroup({ agentId: 'agent-1' }, roster), true);
    assert.equal(sessionIsGroup({ agentId: 'agent-1', sessionId: 'solo', group: false }, roster), false);
});
