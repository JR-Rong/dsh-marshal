import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAgentMemoryService } from '../lib/src/memory/agent-memory.js';
import { createTaskRoomStore } from '../lib/src/groups/task-room-store.js';
import { createTaskRooms } from '../lib/src/groups/task-rooms.js';
import { parseRoomMentions, taskRoomAudit } from '../lib/src/groups/task-room-routes.js';
import { createTaskOrchestration } from '../lib/src/groups/task-orchestration.js';
import { applyDevelopmentPatch } from '../lib/src/groups/task-development.js';
import { GROUP_TEMPLATES, TEMPLATES, taskPlan } from '../lib/src/groups/task-plans.js';

const members = [
    { id: 'lead', name: 'Leader' },
    { id: 'coder', name: 'Coder', permission: 'workspace-write' },
    { id: 'reviewer', name: 'Reviewer', permission: 'read-only' },
    { id: 'alternate', name: 'Backup reviewer', permission: 'read-only' },
];
const candidates = members.map(member => ({ ...member, id: 'team/' + member.id, workspaceId: 'fixture-workspace' }));
const dsh = { id: 'dsh:fixture:chat', agent: 'dsh', provider: 'fixture', model: 'chat' };
const codex = { id: 'codex:openai:fixture', agent: 'codex', provider: 'openai', model: 'fixture', work: true };
const selected = { leaderId: 'team/lead', choice: 'template', templateId: 'development' };

test('map the five workflows to editable group roles and scope Codex defaults to code', () => {
    assert.equal(GROUP_TEMPLATES.length, 3);
    const expect = { development: 'delivery', 'pr-review': 'adversarial', report: 'delivery', research: 'delivery', incident: 'free' };
    for (const template of TEMPLATES) {
        const task = { ...selected, workspaceId: 'fixture-workspace', templateId: template.id, prUrl: 'https://github.com/o/r/pull/1' };
        const plan = taskPlan({ raw: { templateId: template.id }, task, candidates, recommend: true });
        assert.equal(plan.groupTemplate, expect[template.id]);
        assert.equal(plan.codex.coding, template.id === 'development' ? 'auto' : null);
        assert.equal(plan.codex.review, ['development', 'pr-review'].includes(template.id) ? 'auto' : null);
        if (['report', 'research', 'incident'].includes(template.id)) {
            const withCode = taskPlan({ raw: { templateId: template.id, codeWork: true }, task, candidates: candidates.slice(0, 3), recommend: true });
            assert.equal(withCode.groupTemplate, 'delivery');
            assert.deepEqual(withCode.members, { coder: 'team/coder', reviewer: 'team/reviewer' });
            assert.deepEqual(withCode.codex, { coding: 'auto', review: 'auto' });
        }
    }
    const task = { ...selected, workspaceId: 'fixture-workspace' };
    assert.throws(() => taskPlan({ raw: { templateId: 'development', members: { coder: 'team/reviewer' } }, task, candidates }), { code: 'invalid-task-assignee' });
    assert.throws(() => taskPlan({ raw: { templateId: 'development', members: { coder: 'team/coder', reviewer: 'team/coder' } }, task, candidates }), { code: 'invalid-task-assignee' });
    assert.throws(() => taskPlan({ raw: { templateId: 'development', members: { reviewer: 'foreign/agent' } }, task, candidates }), { code: 'invalid-task-assignee' });
});

const nativeExecutable = process.env.MARSHAL_TEST_MNEMON;
for (const run of [{ reviewerDelegates: true }, { reviewerDelegates: false }, { reviewerDelegates: true, pilot: true }]) {
    const { reviewerDelegates, pilot } = run;
    test('run an isolated development ticket with ' + (pilot ? 'private Mnemon memory' : 'reviewer delegation ' + reviewerDelegates), {
        skip: pilot && !nativeExecutable && 'set MARSHAL_TEST_MNEMON to a native Mnemon executable',
    }, async t => {
        const root = mkdtempSync(join(tmpdir(), 'marshal-development-evidence-'));
        const repo = join(root, 'source');
        mkdirSync(repo);
        const git = (args, input) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
        git(['init', '-q']);
        writeFileSync(join(repo, 'sum.mjs'), 'export const sum = (x, y) => x - y;\n');
        writeFileSync(join(repo, 'note.txt'), 'baseline\n');
        git(['add', '.']);
        git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
        writeFileSync(join(repo, 'note.txt'), 'another change in the original tree\n');

        const memory = createAgentMemoryService({ root: join(root, 'memory'),
            ...(pilot ? { mnemonPilot: { agentId: 'coder', executable: nativeExecutable } } : {}),
        });
        const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'groups.sqlite')), deviceId: 'device' });
        const calls = [];
        let reviewed = false;
        const port = {
            catalog: async () => [dsh, codex],
            dispose() {},
            async run(model, prompt, _signal, work) {
                calls.push({ model, prompt, work });
                if (prompt.includes('在运行前推荐协作分工')) {
                    return JSON.stringify({ templateId: 'development', members: { coder: 'team/coder', reviewer: 'team/reviewer' } });
                }
                if (model.agent === 'codex' && work && !work.readOnly) {
                    assert.notEqual(work.workspace, repo);
                    writeFileSync(join(work.workspace, 'sum.mjs'), 'export const sum = (x, y) => x + y;\n');
                    writeFileSync(join(work.workspace, 'new.mjs'), 'export const metadata = "new";\n');
                    return 'Codex implementation and command evidence';
                }
                if (model.agent === 'codex') {
                    assert.equal(work?.readOnly, true);
                    assert.ok(typeof work?.workspace === 'string' && work.workspace !== repo);
                    assert.match(prompt, /固定补丁/);
                    assert.match(prompt, /new\.mjs/);
                    reviewed = true;
                    return 'Read-only Codex found no regression';
                }
                if (prompt.includes('设计和拆分')) return 'Fix addition and verify the new file.';
                if (prompt.includes('你是 Coder')) {
                    if (pilot) {
                        assert.match(prompt, /工作区授权的数据/);
                        assert.doesNotMatch(prompt, /绝对私有的哨兵/);
                    }
                    return JSON.stringify({ action: 'codex', instruction: 'Fix addition and create the new file.' });
                }
                assert.doesNotMatch(prompt, /工作区授权的数据|绝对私有的哨兵/);
                assert.match(prompt, /Backup reviewer/);
                if (prompt.includes('字段 action')) return JSON.stringify({ action: reviewerDelegates ? 'codex' : 'continue', instruction: 'Check the return value.' });
                if (reviewerDelegates) assert.ok(reviewed);
                const findings = 'Addition and the new module match the brief.';
                return JSON.stringify({ verdict: 'pass', findings: pilot ? [{ file: 'sum.mjs:1', conclusion: findings }] : findings });
            },
        };
        const flow = createTaskOrchestration({
            file: join(root, 'workflow.json'), memory, port, workspacePath: async id => {
                assert.equal(id, 'fixture-workspace');
                return repo;
            },
            inventory: () => ({ teams: [{ id: 'team', workspaceId: 'fixture-workspace', members }] }),
        });
        t.after(() => { flow.dispose(); rooms.close(); memory.store.close(); rmSync(root, { recursive: true, force: true }); });
        const card = { id: 'ticket', title: 'Fix addition' };
        if (pilot) {
            await memory.rememberFor({ scope: 'agent', agentId: 'coder', workspaceId: 'fixture-workspace',
                title: 'Fix addition', text: '工作区授权的数据。', visibility: 'group-safe' });
            await memory.rememberFor({ scope: 'agent', agentId: 'coder', title: 'Fix addition', text: '绝对私有的哨兵。' });
        }
        const proposed = await flow.recommend(selected, card, () => true);
        assert.deepEqual(proposed.plan.members, { coder: 'team/coder', reviewer: 'team/reviewer' });
        flow.attach('host', card.id, flow.prepare({ ...selected, plan: {
            templateId: 'development', members: proposed.plan.members,
        } }));
        flow.configure('host', card.id, flow.prepare({ ...selected, plan: {
            templateId: 'development', members: { ...proposed.plan.members, reviewer: 'team/alternate' },
        } }));
        const room = rooms.ensure('host', card, 'fixture-workspace', 'owner');
        flow.start('host', card, taskRoomAudit(rooms, room));
        const until = AbortSignal.timeout(5500);
        let state;
        while ((state = flow.view('host', card.id)).state === 'running') await sleep(10, undefined, { signal: until });
        assert.equal(state.state, 'done', state.error);
        assert.match(flow.report('host', card.id), /Addition and the new module/);
        const { records } = await rooms.page(room.id, { after: 0 });
        const outputs = records.filter(row => row.kind === 'agent' && row.requestId);
        assert.deepEqual(outputs.map(row => row.phase), reviewerDelegates ? ['coding-assistant', 'review-assistant'] : ['coding-assistant']);
        assert.equal(new Set(outputs.map(row => row.requestId)).size, outputs.length);
        assert.ok(outputs.every(row => row.runId === state.runId));
        assert.equal(calls.filter(call => call.model === codex).length, outputs.length);
        assert.equal(await readFileSync(join(repo, 'sum.mjs'), 'utf8'), 'export const sum = (x, y) => x - y;\n');
        assert.match(readFileSync(join(repo, 'note.txt'), 'utf8'), /another change/);
        assert.equal(git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
        const patch = records.find(row => row.phase === 'development-patch');
        assert.match(patch.text, /new\.mjs/);
        assert.doesNotMatch(patch.text, /note\.txt/);
        git(['apply', '--check', '-'], patch.text);
        const handoffs = memory.store.list('workspace', 'fixture-workspace').filter(row => row.kind === 'handoff');
        assert.equal(handoffs.length, 3);
        assert.ok(handoffs.some(row => row.content.includes('Fix addition and verify')));
        assert.ok(handoffs.some(row => row.content.includes(patch.ref)));
        assert.ok(records.some(row => row.phase === 'dev-reviewing' && handoffs.some(item => item.id === row.ref)));
        assert.equal(memory.store.list('agent', 'lead').length, 0);
        if (pilot) {
            const receipts = records.filter(row => row.phase === 'private-memory');
            assert.equal(receipts.length, 2);
            assert.match(receipts[0].text, /1 条/);
            assert.match(receipts[1].text, /已写入/);
            assert.ok(receipts.every(row => row.runId === state.runId));
            assert.doesNotMatch(JSON.stringify(records), /工作区授权的数据|绝对私有的哨兵/);
            assert.ok((await memory.listFor({ agentId: 'coder', scope: 'agent' }))
                .some(item => item.backend === 'mnemon' && item.tags.includes('run:' + state.runId)));
            assert.deepEqual(await memory.listFor({ agentId: 'reviewer', scope: 'agent' }), []);
        }
        assert.equal((await rooms.page(room.id, { limit: 1 })).room.closed, false, 'finished workflow stays open in review until human confirmation');
        const applyRes = await applyDevelopmentPatch(repo, patch.text);
        assert.equal(applyRes.applied, true);
        assert.match(readFileSync(join(repo, 'sum.mjs'), 'utf8'), /\+/);
        const secondApply = await applyDevelopmentPatch(repo, patch.text);
        assert.equal(secondApply.alreadyApplied, true);
    });
}

test('reviewer blocked verdict enters review-blocked instead of failed, and revision injects room operator notes', async t => {
    const root = mkdtempSync(join(tmpdir(), 'marshal-dev-review-blocked-'));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (args, input) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q']);
    writeFileSync(join(repo, 'app.mjs'), 'export const mode = "phone";\n');
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'init']);

    const memory = createAgentMemoryService({ root: join(root, 'memory') });
    const rooms = createTaskRooms({ store: createTaskRoomStore(join(root, 'rooms.sqlite')), deviceId: 'node-1' });
    let shouldBlock = true;
    const seenPrompts = [];
    const port = {
        catalog: async () => [dsh, codex],
        dispose() {},
        async run(model, prompt, _signal, work) {
            seenPrompts.push(prompt);
            if (work) {
                writeFileSync(join(work.workspace, 'app.mjs'), shouldBlock ? 'export const mode = "phone-v1";\n' : 'export const mode = "node-v2";\n');
                return 'implemented change';
            }
            if (prompt.includes('设计和拆分开发任务')) return 'Design plan';
            if (prompt.includes('你是 Coder')) return JSON.stringify({ action: 'codex', instruction: 'implement' });
            if (prompt.includes('需要 Codex 只读协助')) return JSON.stringify({ action: 'continue', instruction: 'direct verdict' });
            if (shouldBlock) {
                return JSON.stringify({
                    verdict: 'blocked',
                    findings: [{ file: 'app.mjs', conclusion: '请确认手机端是作为 controller 还是独立 node 运行。' }],
                });
            }
            return JSON.stringify({ verdict: 'pass', findings: '已按机主裁决改为 node-v2。' });
        },
    };
    const states = [];
    const flow = createTaskOrchestration({
        file: join(root, 'workflow.json'),
        memory,
        port,
        workspacePath: async () => repo,
        inventory: () => ({ teams: [{ id: 'team', workspaceId: 'fixture-workspace', members }] }),
        onState: async (_src, taskId, status) => { states.push({ taskId, status }); },
    });
    t.after(() => { flow.dispose(); rooms.close(); memory.store.close(); rmSync(root, { recursive: true, force: true }); });

    const card = { id: 'card-rb', title: '移动端模式确认' };
    flow.attach('host', card.id, flow.prepare({
        ...selected,
        plan: { templateId: 'development', members: { coder: 'team/coder', reviewer: 'team/reviewer' } },
    }));
    const room = rooms.ensure('host', card, 'fixture-workspace', 'owner');
    flow.start('host', card, taskRoomAudit(rooms, room, 'start'));
    const until = AbortSignal.timeout(5500);
    let state;
    while ((state = flow.view('host', card.id)).state === 'running') await sleep(10, undefined, { signal: until });
    assert.equal(state.state, 'review-blocked');
    assert.equal(state.reviewReason, 'review-blocked');
    assert.doesNotMatch(state.reviewSummary, /\[object Object\]/);
    assert.match(state.reviewSummary, /app\.mjs/);
    assert.equal(states.at(-1).status, 'review');

    // Operator discusses in room with @Reviewer and @Coder, then triggers revision
    assert.deepEqual(parseRoomMentions('@Reviewer @Coder 请统一按独立 node-v2 实现'), ['Reviewer', 'Coder']);
    const chatReply = await flow.respond('host', card.id, '群消息上下文', AbortSignal.timeout(3000), {
        mentions: ['Reviewer', 'Coder'],
        workspaceId: 'fixture-workspace',
    });
    assert.equal(chatReply.replies.length, 2);
    assert.deepEqual(chatReply.replies.map(r => r.actor), ['Reviewer', 'Coder']);

    await rooms.append(room.id, { kind: 'user', runId: state.runId, actor: '工单操作者', text: '机主拍板：统一按 node-v2 实现', phase: 'revision' });
    shouldBlock = false;
    seenPrompts.length = 0;
    flow.start('host', card, taskRoomAudit(rooms, room, 'revise'));
    while ((state = flow.view('host', card.id)).state === 'running') await sleep(10, undefined, { signal: until });
    assert.equal(state.state, 'done');
    assert.ok(seenPrompts.some(p => p.includes('机主拍板：统一按 node-v2 实现')), 'operator guidance from room is injected into workflow prompts');
});
