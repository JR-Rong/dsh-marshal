import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createSettingsStore, defaultSettings, normalizeSettings } from '../lib/src/superagent/settings.js';
import { findMember, readAgents, resolveAgentForTask, resolveTaggedAgent } from '../lib/src/superagent/agents.js';
import { composePrompt, permissionRank, planCardPatch, taskIsDispatchable } from '../lib/src/superagent/prompt.js';
import { agentsFixture, memberFixture, taskFixture, tempRoot } from './superagent-support.js';

test('settings: defaults are safe and a malformed file falls back', () => {
    const root = tempRoot();
    const store = createSettingsStore(root);
    const initial = store.get();
    assert.equal(initial.enabled, true);
    assert.equal(initial.defaultAgent, null);
    assert.equal(initial.rootOnly, true);
    assert.equal(initial.tagPrefix, '@');
    assert.equal(store.error(), undefined);
    const next = store.update({ defaultAgent: '工部尚书', memoryLimit: 3 });
    assert.equal(next.defaultAgent, '工部尚书');
    assert.equal(next.memoryLimit, 3);
    const reloaded = createSettingsStore(root);
    assert.equal(reloaded.get().defaultAgent, '工部尚书');
    assert.equal(reloaded.get().memoryLimit, 3);
});

test('settings: a corrupt file falls back and is reported, not overwritten', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'settings.json'), '{not-json');
    const store = createSettingsStore(root, { logger: { warn: () => {} } });
    assert.equal(store.get().enabled, true);
    assert.equal(store.get().defaultAgent, null);
    assert.match(store.error(), /settings-unreadable/);
});

test('settings: normalization refuses invalid values without throwing', () => {
    const normalized = normalizeSettings({
        enabled: 'yes',
        defaultAgent: '  ',
        rootOnly: 1,
        tagPrefix: '',
        aliases: { '工部': '工部尚书', '': 'x', toolong: 'y'.repeat(65) },
        memoryLimit: 99,
        maxDispatchesPerMinute: -1,
    });
    const defaults = defaultSettings();
    assert.equal(normalized.enabled, defaults.enabled);
    assert.equal(normalized.defaultAgent, null);
    assert.equal(normalized.rootOnly, defaults.rootOnly);
    assert.equal(normalized.tagPrefix, '@');
    assert.deepEqual(normalized.aliases, { '工部': '工部尚书' });
    assert.equal(normalized.memoryLimit, defaults.memoryLimit);
    assert.equal(normalized.maxDispatchesPerMinute, defaults.maxDispatchesPerMinute);
});

test('agents: ledger read, tag override, alias and default', () => {
    const home = tempRoot();
    mkdirSync(join(home, 'dsh-agents'), { recursive: true });
    writeFileSync(join(home, 'dsh-agents', 'ledger.json'), JSON.stringify({
        schemaVersion: 1,
        teams: [
            { id: 'legacy', name: '智能体库', members: [{ id: 'old', name: '丞相', brief: '旧丞相' }] },
            { id: 't1', name: 'marshal-agent:工部尚书-x', workspaceId: 'ws-1', members: [
                { id: 'm1', name: '工部尚书', brief: '你是工部尚书。', permission: 'danger-full-access', model: 'deepseek-account/deepseek-flash' },
                { id: 'm2', name: '丞相', brief: '你是丞相。' },
            ] },
        ],
    }));
    const agents = readAgents({ DSH_HOME: home }, home);
    assert.equal(agents.available, true);
    assert.equal(agents.members.length, 3);
    const preferred = findMember(agents.members, '丞相');
    assert.equal(preferred.id, 'm2', 'non-legacy member wins');
    const settings = { ...defaultSettings(), defaultAgent: '工部尚书' };
    const byDefault = resolveAgentForTask(taskFixture(), settings, agents.members);
    assert.equal(byDefault.member.id, 'm1');
    assert.equal(byDefault.via, 'default');
    const tagged = resolveAgentForTask(taskFixture({ tags: [{ name: '@丞相' }] }), settings, agents.members);
    assert.equal(tagged.member.id, 'm2');
    assert.equal(tagged.via, 'tag');
    const aliased = resolveAgentForTask(taskFixture({ tags: [{ name: '@工部' }] }), { ...settings, aliases: { '工部': '工部尚书' } }, agents.members);
    assert.equal(aliased.member.id, 'm1');
    const missing = resolveAgentForTask(taskFixture(), { ...defaultSettings(), defaultAgent: '不存在' }, agents.members);
    assert.equal(missing.member, undefined);
    assert.match(missing.error, /default-agent-not-found/);
    const noDefault = resolveAgentForTask(taskFixture(), defaultSettings(), agents.members);
    assert.equal(noDefault.member, undefined);
    assert.match(noDefault.error, /no-agent/);
});

test('agents: tag prefix and 智能体: marker are both accepted', () => {
    const members = agentsFixture().members;
    const settings = { ...defaultSettings(), tagPrefix: '@' };
    assert.equal(resolveTaggedAgent(taskFixture({ tags: [{ name: '智能体:工部尚书' }] }), settings, members).member.id, memberFixture().id);
    assert.equal(resolveTaggedAgent(taskFixture({ tags: [{ name: '@工部尚书' }] }), settings, members).member.id, memberFixture().id);
});

test('prompt: identity, brief, memory and task all travel', () => {
    const prompt = composePrompt({
        member: memberFixture(),
        task: taskFixture(),
        memory: '- 上次交付用了 pnpm 测试',
        memoryCount: 1,
    });
    assert.match(prompt, /工部尚书/);
    assert.match(prompt, /掌产品与交付/);
    assert.match(prompt, /登录页/);
    assert.match(prompt, /实现登录页并跑测试/);
    assert.match(prompt, /上次交付用了 pnpm 测试/);
    assert.match(prompt, /ask_user_question/);
});

test('patch: member fills blanks, never raises permission above the board default', () => {
    const member = memberFixture();
    const snapshot = { sessionDefaultPermission: 'workspace-write' };
    const planned = planCardPatch({ task: taskFixture(), member, snapshot, prompt: 'p' });
    assert.equal(planned.patch.permission, undefined);
    assert.equal(planned.patch.model, member.model);
    assert.equal(permissionRank('danger-full-access') > permissionRank(snapshot.sessionDefaultPermission), true);
    assert.match(planned.notes.join(' '), /permission-not-raised/);
    const allowed = planCardPatch({ task: taskFixture(), member: { ...member, permission: 'workspace-write' }, snapshot, prompt: 'p' });
    assert.equal(allowed.patch.permission, 'workspace-write');
    const pinned = planCardPatch({
        task: taskFixture({ permission: 'read-only', model: 'kilo/x', reasoningEffort: 'high' }),
        member,
        snapshot: { sessionDefaultPermission: 'danger-full-access' },
        prompt: 'p',
    });
    assert.equal(pinned.patch.permission, undefined, 'card pin wins');
    assert.equal(pinned.patch.model, undefined, 'card model wins');
    assert.equal(pinned.patch.reasoningEffort, undefined, 'card effort wins');
    assert.deepEqual(pinned.patch.tags.map(tag => tag.name), ['智能体:工部尚书']);
});

test('dispatchability: root only, not archived, not already executed', () => {
    const settings = defaultSettings();
    assert.equal(taskIsDispatchable(taskFixture(), settings).ok, true);
    assert.equal(taskIsDispatchable(taskFixture({ parentId: 'parent' }), settings).code, 'subtask-suppressed');
    assert.equal(taskIsDispatchable(taskFixture({ parentId: 'parent' }), { ...settings, rootOnly: false }).ok, true);
    assert.equal(taskIsDispatchable(taskFixture({ archivedAt: 1 }), settings).code, 'task-archived');
    assert.equal(taskIsDispatchable(taskFixture({ executions: [{ id: 'e', startedAt: 1, endedAt: 2, result: 'succeeded' }] }), settings).code, 'already-executed');
});
