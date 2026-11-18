import assert from 'node:assert/strict';
import test from 'node:test';
import { createSuperagentBridge } from '../lib/src/superagent/mount.js';
import { agentsFixture, createFakeBoard, createFakeMemory, loggerFixture, memberFixture, taskFixture, tempRoot } from './superagent-support.js';

function setup(options = {}) {
    const root = tempRoot();
    const board = createFakeBoard({
        tasks: options.tasks ?? [taskFixture()],
        sessionDefaultPermission: options.sessionDefaultPermission ?? 'danger-full-access',
        failRun: options.failRun,
        failUpdate: options.failUpdate,
        sessionId: options.sessionId,
    });
    const memory = createFakeMemory(options.memoryItems ?? []);
    const members = options.members ?? [memberFixture()];
    const bridge = createSuperagentBridge({
        root,
        memory,
        readAgents: () => agentsFixture(members),
        logger: loggerFixture(),
        reconcileDelayMs: 0,
        now: options.now,
        uuid: (() => { let n = 0; return () => 'req-' + (++n); })(),
    });
    if (options.withBoard !== false) bridge.setBoard(board);
    if (options.settings !== undefined) bridge.configure(options.settings);
    return { bridge, board, memory, root };
}

test('dispatch: default agent prepares the card and opens the board run', async () => {
    const { bridge, board } = setup({ settings: { defaultAgent: '工部尚书' } });
    const answer = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui', requestId: 'ui-1' });
    assert.equal(answer.status, 202);
    assert.equal(answer.body.via, 'default');
    assert.deepEqual(board.actions.map(entry => entry.action.kind), ['update', 'run']);
    const update = board.actions[0].action;
    assert.match(update.patch.prompt, /工部尚书/);
    assert.match(update.patch.prompt, /掌产品与交付/);
    assert.match(update.patch.prompt, /实现登录页并跑测试/);
    assert.deepEqual(update.patch.tags.map(tag => tag.name), ['智能体:工部尚书']);
    const run = board.actions[1].action;
    assert.equal(run.taskId, 'task-1');
    assert.equal(board.snapshot().tasks[0].status, 'running');
    const record = bridge.stateStore.get('task-1');
    assert.equal(record.status, 'running');
    assert.equal(record.agentName, '工部尚书');
    assert.equal(record.sessionId, 'session-1');
});

test('dispatch: a tag overrides the default agent', async () => {
    const members = [memberFixture(), memberFixture({ id: 'member-2', name: '丞相', teamName: 'marshal-agent:丞相-y', brief: '你是丞相。' })];
    const { bridge, board } = setup({ settings: { defaultAgent: '工部尚书' }, members, tasks: [taskFixture({ tags: [{ name: '@丞相' }] })] });
    const answer = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(answer.status, 202);
    assert.equal(answer.body.via, 'tag');
    const record = bridge.stateStore.get('task-1');
    assert.equal(record.agentName, '丞相');
    assert.match(board.actions[0].action.patch.prompt, /你是丞相/);
});

test('dispatch: duplicate notifications never open a second run', async () => {
    const { bridge, board } = setup({ settings: { defaultAgent: '工部尚书' } });
    const first = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    const second = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.equal(second.body.code, 'duplicate-dispatch');
    assert.equal(board.actions.filter(entry => entry.action.kind === 'run').length, 1);
});

test('dispatch: disabled, no-board and no-agent answer without touching the card', async () => {
    const disabled = setup({ settings: { enabled: false, defaultAgent: '工部尚书' } });
    const off = await disabled.bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(off.status, 200);
    assert.equal(off.body.code, 'disabled');
    assert.equal(disabled.board.actions.length, 0);

    const noBoard = createSuperagentBridge({ root: tempRoot(), memory: createFakeMemory(), readAgents: () => agentsFixture(), logger: loggerFixture(), reconcileDelayMs: 0 });
    const missing = await noBoard.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.code, 'no-task-board');
    noBoard.close();

    const noAgent = setup();
    const unresolved = await noAgent.bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(unresolved.status, 409);
    assert.equal(unresolved.body.code, 'agent-not-resolved');
    assert.equal(noAgent.board.actions.length, 0);
});

test('dispatch: rootOnly suppresses subtasks unless switched off', async () => {
    const subtask = taskFixture({ id: 'task-2', parentId: 'task-1' });
    const first = setup({ settings: { defaultAgent: '工部尚书' }, tasks: [subtask] });
    const suppressed = await first.bridge.humanCreate({ taskId: 'task-2', source: 'board-ui' });
    assert.equal(suppressed.status, 200);
    assert.equal(suppressed.body.code, 'subtask-suppressed');
    assert.equal(first.board.actions.length, 0);

    const second = setup({ settings: { defaultAgent: '工部尚书', rootOnly: false }, tasks: [subtask] });
    const allowed = await second.bridge.humanCreate({ taskId: 'task-2', source: 'board-ui' });
    assert.equal(allowed.status, 202);
    assert.equal(second.board.actions.filter(entry => entry.action.kind === 'run').length, 1);
});

test('dispatch: a member permission above the board default is not raised', async () => {
    const { bridge, board } = setup({ settings: { defaultAgent: '工部尚书' }, sessionDefaultPermission: 'workspace-write' });
    const answer = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(answer.status, 202);
    assert.equal(board.actions[0].action.patch.permission, undefined);
    const record = bridge.stateStore.get('task-1');
    assert.match(record.notes.join(' '), /permission-not-raised/);
});

test('dispatch: run refusal is recorded and surfaced, not swallowed', async () => {
    const { bridge, board } = setup({ settings: { defaultAgent: '工部尚书' }, failRun: 'permission-confirmation-required' });
    const answer = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.code, 'run-refused');
    const record = bridge.stateStore.get('task-1');
    assert.equal(record.status, 'failed');
    assert.match(record.error, /permission-confirmation-required/);
    assert.equal(board.snapshot().tasks[0].status, 'todo');
});

test('dispatch: a retry after a run refusal does not stack identity blocks', async () => {
    const { bridge, board } = setup({ settings: { defaultAgent: '工部尚书' }, failRun: 'permission-confirmation-required' });
    const first = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(first.status, 409);
    board.setFailRun(undefined);
    const retry = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(retry.status, 202);
    const prompt = board.actions.filter(entry => entry.action.kind === 'update').at(-1).action.patch.prompt;
    assert.equal((prompt.match(/【超级智能体派发】/g) ?? []).length, 1);
    assert.equal(board.snapshot().tasks[0].status, 'running');
});

test('dispatch: memory recall feeds the prompt and can be switched off', async () => {
    const recallItem = { id: 'm1', scope: 'agent', title: '测试偏好', content: '先跑 pnpm test', kind: 'fact' };
    const on = setup({ settings: { defaultAgent: '工部尚书' }, memoryItems: [recallItem] });
    await on.bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.match(on.board.actions[0].action.patch.prompt, /先跑 pnpm test/);
    assert.equal(on.memory.recalls.length, 2, 'agent scope + workspace scope are both consulted');
    assert.equal(on.memory.recalls.some(query => query.agentId === 'member-1' && query.scope === 'agent'), true);

    const off = setup({ settings: { defaultAgent: '工部尚书', injectMemory: false }, memoryItems: [recallItem] });
    await off.bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.doesNotMatch(off.board.actions[0].action.patch.prompt, /先跑 pnpm test/);
    assert.equal(off.memory.recalls.length, 0);
});

test('dispatch: the per-minute limiter refuses a flood', async () => {
    const tasks = [taskFixture({ id: 'task-1' }), taskFixture({ id: 'task-2' })];
    const { bridge } = setup({ settings: { defaultAgent: '工部尚书', maxDispatchesPerMinute: 1 }, tasks });
    const first = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    const second = await bridge.humanCreate({ taskId: 'task-2', source: 'board-ui' });
    assert.equal(first.status, 202);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'rate-limited');
});

test('dispatch: an already executed card is never prepared again', async () => {
    const executed = taskFixture({ executions: [{ id: 'old-run', startedAt: 1, endedAt: 2, result: 'failed' }] });
    const { bridge, board } = setup({ settings: { defaultAgent: '工部尚书' }, tasks: [executed] });
    const answer = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.code, 'already-executed');
    assert.equal(board.actions.length, 0, 'an executed card is not rewritten or re-run');
});

test('dispatch: an unknown tag falls back to the default; a bad task id is refused', async () => {
    const { bridge } = setup({ settings: { defaultAgent: '工部尚书' }, tasks: [taskFixture({ tags: [{ name: '@不存在' }] })] });
    const answer = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(answer.status, 202);
    assert.equal(answer.body.via, 'default');
    const bad = await bridge.humanCreate({ taskId: '', source: 'board-ui' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid-task-id');
    const wrongSource = await bridge.humanCreate({ taskId: 'task-1', source: 'agent' });
    assert.equal(wrongSource.status, 400);
});
