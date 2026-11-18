import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createSuperagentBridge } from '../lib/src/superagent/mount.js';
import { createStateStore } from '../lib/src/superagent/state.js';
import { agentsFixture, createFakeBoard, createFakeMemory, loggerFixture, memberFixture, taskFixture, tempRoot } from './superagent-support.js';

function setup(options = {}) {
    const root = tempRoot();
    const board = createFakeBoard({ tasks: options.tasks ?? [taskFixture()] });
    const memory = options.memory ?? createFakeMemory();
    const bridge = createSuperagentBridge({
        root,
        memory,
        readAgents: () => agentsFixture(options.members ?? [memberFixture()]),
        logger: loggerFixture(),
        reconcileDelayMs: -1,
    });
    bridge.setBoard(board);
    if (options.defaultAgent !== false) bridge.configure({ defaultAgent: '工部尚书' });
    return { bridge, board, memory, root };
}

const wait = () => new Promise(resolve => setTimeout(resolve, 20));

test('settle: a successful execution writes exactly one agent-scoped episode', async () => {
    const { bridge, board, memory } = setup();
    await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    board.settleExecution('task-1', 'succeeded', { summary: '登录页已完成，提交 PR #12。' });
    board.fireSettled({ taskId: 'task-1', executionId: 'exec-1', outcome: 'succeeded' });
    await wait();
    assert.equal(memory.writes.length, 1);
    const write = memory.writes[0];
    assert.equal(write.agentId, 'member-1');
    assert.equal(write.scope, 'agent');
    assert.equal(write.kind, 'episode');
    assert.match(write.title, /登录页/);
    assert.match(write.text, /登录页已完成/);
    assert.match(write.text, /exec-1|session-1/);
    assert.deepEqual(write.tags.slice(0, 2), ['task-1', 'superagent']);
    const record = bridge.stateStore.get('task-1');
    assert.equal(record.status, 'settled');
    assert.equal(record.memoryWritten, true);
    assert.equal(board.integrations.length, 1);
    assert.equal(board.integrations[0].payload.outcome, 'succeeded');
    // A duplicate delivery is harmless.
    board.fireSettled({ taskId: 'task-1', executionId: 'exec-1', outcome: 'succeeded' });
    await wait();
    assert.equal(memory.writes.length, 1);
});

test('settle: an unknown execution is not the dispatched run', async () => {
    const { bridge, board, memory } = setup();
    await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    board.settleExecution('task-1', 'succeeded', { summary: 'done' });
    board.fireSettled({ taskId: 'task-1', executionId: 'some-other-run', outcome: 'succeeded' });
    await wait();
    assert.equal(memory.writes.length, 0);
    assert.equal(bridge.stateStore.get('task-1').status, 'running');
});

test('settle: a card the bridge never dispatched gets no memory', async () => {
    const { bridge, board, memory } = setup();
    await board.apply('manual-run', { kind: 'run', taskId: 'task-1' }, 'human-session');
    board.settleExecution('task-1', 'succeeded', { summary: 'manual work' });
    board.fireSettled({ taskId: 'task-1', executionId: 'exec-1', outcome: 'succeeded' });
    await wait();
    assert.equal(memory.writes.length, 0);
});

test('settle: memory unavailable or throwing is recorded, never fatal', async () => {
    const throwing = {
        listFor: () => [],
        rememberFor: () => { throw new Error('disk full'); },
    };
    const { bridge, board } = setup({ memory: throwing });
    await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    board.settleExecution('task-1', 'failed', { error: 'tests failed', summary: '测试失败' });
    board.fireSettled({ taskId: 'task-1', executionId: 'exec-1', outcome: 'failed', error: 'tests failed' });
    await wait();
    const record = bridge.stateStore.get('task-1');
    assert.equal(record.status, 'memory-pending');
    assert.equal(record.memoryWritten, false);
    assert.match(record.memoryError, /disk full/);
    assert.equal(board.integrations[0].payload.memoryWritten, false);
    assert.equal(board.snapshot().tasks[0].status, 'failed');
});

test('reconcile: a missed settle event is caught on the next board read', async () => {
    const { bridge, board, memory } = setup();
    await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    board.settleExecution('task-1', 'succeeded', { summary: '对账补写' });
    // No fireSettled: only reconcile runs.
    const result = await bridge.reconcile('test');
    assert.equal(result.ok, true);
    assert.equal(result.settled, 1);
    assert.equal(memory.writes.length, 1);
    assert.equal(bridge.stateStore.get('task-1').memoryWritten, true);
});

test('state: a corrupt dispatch file falls back to an empty ledger', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'state.json'), '{broken');
    const store = createStateStore(root, { logger: { warn: () => {} } });
    assert.equal(store.list().length, 0);
    assert.match(store.error(), /state-unreadable/);
});

test('settle: a late duplicate notification cannot erase the settled record', async () => {
    const { bridge, board, memory } = setup();
    await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    board.settleExecution('task-1', 'succeeded', { summary: 'done' });
    board.fireSettled({ taskId: 'task-1', executionId: 'exec-1', outcome: 'succeeded' });
    await wait();
    assert.equal(bridge.stateStore.get('task-1').status, 'settled');
    assert.equal(memory.writes.length, 1);
    const late = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(late.status, 200);
    assert.equal(bridge.stateStore.get('task-1').status, 'settled');
    assert.equal(bridge.stateStore.get('task-1').memoryWritten, true);
    assert.equal(memory.writes.length, 1);
});

test('settle: disabling the bridge defers memory until it is re-enabled', async () => {
    const { bridge, board, memory } = setup();
    await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    bridge.configure({ enabled: false });
    board.settleExecution('task-1', 'succeeded', { summary: 'disabled settle' });
    board.fireSettled({ taskId: 'task-1', executionId: 'exec-1', outcome: 'succeeded' });
    await wait();
    assert.equal(memory.writes.length, 0, 'disabled bridge must not write memory');
    assert.equal(bridge.stateStore.get('task-1').status, 'running');
    const blocked = await bridge.reconcile('test');
    assert.equal(blocked.code, 'disabled');
    assert.equal(blocked.checked, 0);
    assert.equal(memory.writes.length, 0);
    bridge.configure({ enabled: true });
    const result = await bridge.reconcile('test');
    assert.equal(result.settled, 1);
    assert.equal(memory.writes.length, 1);
    assert.equal(bridge.stateStore.get('task-1').status, 'settled');
});

test('settle: a failed dispatch record is never written by a later manual run', async () => {
    const { bridge, board, memory } = setup();
    board.setFailRun('permission-confirmation-required');
    const refused = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(refused.status, 409);
    assert.equal(bridge.stateStore.get('task-1').status, 'failed');
    board.setFailRun(undefined);
    await board.apply('manual-run', { kind: 'run', taskId: 'task-1' }, 'human-session');
    board.settleExecution('task-1', 'succeeded', { summary: 'manual work' });
    board.fireSettled({ taskId: 'task-1', executionId: 'exec-1', outcome: 'succeeded' });
    await wait();
    assert.equal(memory.writes.length, 0);
    assert.equal(bridge.stateStore.get('task-1').status, 'failed');
});

test('settle: a transient memory failure is retried by reconcile', async () => {
    const writes = [];
    let fail = true;
    const memory = {
        listFor: () => [],
        rememberFor(input) {
            if (fail) {
                fail = false;
                throw new Error('transient disk error');
            }
            writes.push(input);
            return { id: 'memory-retried' };
        },
    };
    const { bridge, board } = setup({ memory });
    await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    board.settleExecution('task-1', 'succeeded', { summary: 'retry me' });
    board.fireSettled({ taskId: 'task-1', executionId: 'exec-1', outcome: 'succeeded' });
    await wait();
    const pending = bridge.stateStore.get('task-1');
    assert.equal(pending.status, 'memory-pending');
    assert.match(pending.memoryError, /transient/);
    assert.match(bridge.status().recent[0].memoryError, /transient/);
    const result = await bridge.reconcile('test');
    assert.equal(result.settled, 1);
    assert.equal(writes.length, 1);
    const settled = bridge.stateStore.get('task-1');
    assert.equal(settled.status, 'settled');
    assert.equal(settled.memoryWritten, true);
});

test('restart: a new bridge with the same root does not re-dispatch a running card', async () => {
    const { bridge, board, root } = setup();
    await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    bridge.close();
    const resumed = createSuperagentBridge({
        root,
        memory: createFakeMemory(),
        readAgents: () => agentsFixture(),
        logger: loggerFixture(),
        reconcileDelayMs: 0,
    });
    resumed.setBoard(board);
    resumed.configure({ defaultAgent: '工部尚书' });
    const answer = await resumed.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.code, 'duplicate-dispatch');
    assert.equal(board.actions.filter(entry => entry.action.kind === 'run').length, 1);
    resumed.close();
});
