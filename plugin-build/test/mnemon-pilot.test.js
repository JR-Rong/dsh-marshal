import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentMemoryTool, createAgentMemoryService } from '../lib/src/memory/agent-memory.js';
import { parseConfig } from '../lib/src/config.js';

const executable = process.env.MARSHAL_TEST_MNEMON;
const owner = 'pilot-agent';
const peer = 'peer-agent';
const workspaceId = 'shared-workspace';
const rootOf = () => mkdtempSync(join(tmpdir(), 'marshal-native-test-'));
const ledger = {
    teams: [{ id: 'team', workspaceId, members: [{ id: owner, name: '试点' }, { id: peer, name: '同事' }] }],
    runs: [['session-a1', owner], ['session-a2', owner], ['session-b', peer]].map(([sessionId, memberId]) =>
        ({ sessionId, memberId, teamId: 'team' })),
};
const context = (id, group = false) => ({ agent: { session: { id, header: { kind: group ? 'group' : 'direct' } } } });

test('pilot configuration requires a single stable agent and an explicit executable', () => {
    const base = { role: 'node', deviceId: 'local', hubUrl: 'wss://pilot.example.test', token: 'fixture-node-token' };
    assert.deepEqual(parseConfig({ ...base, mnemonPilot: { agentId: owner, executable: '/usr/local/bin/mnemon' } }).mnemonPilot,
        { agentId: owner, executable: '/usr/local/bin/mnemon' });
    assert.throws(() => parseConfig({ ...base, mnemonPilot: { agentId: owner, executable: 'mnemon' } }), /mnemonPilot/);
});

test('real Mnemon pilot persists across sessions, protects ownership and respects group visibility', {
    skip: !executable && 'set MARSHAL_TEST_MNEMON to a native Mnemon executable',
}, async t => {
    const root = rootOf();
    let service = createAgentMemoryService({ root, ledger, mnemonPilot: { agentId: owner, executable } });
    t.after(() => { service.store.close(); rmSync(root, { recursive: true, force: true }); });
    const first = agentMemoryTool(service);
    const query = '流水线验收';
    const personal = await first.execute({ action: 'remember', scope: 'agent', title: '流水线验收', text: '流水线验收。私有指纹青松七。' }, context('session-a1'));
    const approved = await first.execute({ action: 'remember', scope: 'agent', title: '流水线验收清单',
        text: '流水线验收。先跑单元测试。', visibility: 'group-safe' }, context('session-a1'));
    await first.execute({ action: 'remember', scope: 'workspace', title: '流水线验收交接',
        text: '流水线验收。可以共享的交接。' }, context('session-a1'));
    assert.equal(personal.memory.backend, 'mnemon');
    assert.equal(personal.memory.sourceSession, 'session-a1');
    assert.equal(approved.memory.allowedWorkspaceId, workspaceId);
    assert.equal(service.store.list('agent', owner).length, 0);
    assert.equal(service.store.list('workspace', workspaceId).length, 1);
    service.store.close();
    service = createAgentMemoryService({ root, ledger, mnemonPilot: { agentId: owner, executable } });
    const next = agentMemoryTool(service);
    const recall = (id, group) => next.execute({ action: 'recall', scope: 'agent', query }, context(id, group));
    assert.ok((await recall('session-a2')).items.some(item => item.id === personal.memory.id));
    assert.deepEqual((await recall('session-b')).items, []);
    assert.deepEqual((await recall('session-a2', true)).items.map(item => item.id), [approved.memory.id]);
    assert.deepEqual(await service.taskPrivateContext(owner, 'other-workspace', query), []);
    assert.deepEqual(await service.taskPrivateContext(peer, workspaceId, query), []);
    assert.equal((await service.taskPrivateContext(owner, workspaceId, query)).length, 1);
    const promptFor = (sessionId, group = false) => {
        const ctx = context(sessionId, group);
        ctx.agent.session.events = [{ type: 'user/message', data: { content: query } }];
        return service.nativePrompt(service.identity(ctx));
    };
    assert.match(await promptFor('session-a2'), /私有指纹青松七/);
    assert.doesNotMatch(await promptFor('session-a2', true), /私有指纹青松七/);
    assert.equal(await promptFor('session-b'), '');
    const fromAgentFolder = { agent: { session: { id: 'unbound', header: { cwd: join(process.env.HOME, '.dsh-marshal', 'agents', 'Agent · 试点') } } } };
    assert.deepEqual((await next.execute({ action: 'recall', scope: 'agent', query }, fromAgentFolder)).items, []);
    assert.match((await next.execute({ action: 'recall', scope: 'workspace', query }, context('session-b'))).text, /可以共享的交接/);
    assert.equal((await service.graphFor({ agentId: owner, includeGlobal: false })).nodes.length, 2);
    assert.equal((await service.statsFor([{ scope: 'agent', ownerId: owner }]))[0].total, 2);
    assert.equal((await service.getFor('agent', peer, personal.memory.id)), undefined);
    assert.equal(await service.forgetFor({ agentId: peer, id: personal.memory.id }), false);
    assert.equal(await service.forgetFor({ agentId: owner, id: personal.memory.id }), true);
    assert.equal(await service.getFor('agent', owner, personal.memory.id), undefined);
    assert.ok(!(await recall('session-a2')).items.some(item => item.id === personal.memory.id));
    assert.doesNotMatch(await promptFor('session-a2'), /私有指纹青松七/);
});
