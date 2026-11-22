import assert from 'node:assert/strict';
import test from 'node:test';
import { createSuperagentBridge } from '../lib/src/superagent/mount.js';
import {
    agentsFixture, createFakeBoard, createFakeMemory, createFakeWorkflow, loggerFixture, memberFixture, taskFixture, tempRoot,
} from './superagent-support.js';

function setup(options = {}) {
    const root = tempRoot();
    const board = createFakeBoard({ tasks: options.tasks ?? [taskFixture()] });
    const memory = createFakeMemory(options.memoryItems ?? []);
    const bridge = createSuperagentBridge({
        root,
        memory,
        readAgents: () => agentsFixture(options.members ?? [memberFixture()]),
        logger: loggerFixture(),
        reconcileDelayMs: -1,
        trustedRequest: () => true,
        workflow: options.workflow,
    });
    bridge.setBoard(board);
    if (options.settings !== undefined) bridge.configure(options.settings);
    return { bridge, board, memory };
}

test('workflow: a preset card is delegated to its workflow instead of a plain board run', async () => {
    const workflow = createFakeWorkflow();
    const { bridge, board } = setup({ workflow });
    const answer = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(answer.status, 202);
    assert.equal(answer.body.via, 'workflow');
    assert.deepEqual(board.actions, [], 'the bridge must not rewrite or run the card itself');
    assert.equal(workflow.starts.length, 1);
    assert.equal(workflow.starts[0].taskId, 'task-1');
    assert.equal(workflow.starts[0].settings.reason, 'auto-dispatch');
    assert.equal(workflow.begins.length, 1, 'the ticket group receives a dispatch batch');
    assert.ok(workflow.notes.some(entry => entry.event.phase === 'dispatch'), 'the ticket group receives the dispatch note');
    const record = bridge.stateStore.get('task-1');
    assert.equal(record.status, 'delegated');
    assert.equal(record.delegated, true);
    assert.equal(record.agentName, '丞相');
    assert.equal(board.snapshot().tasks[0].status, 'todo', 'the workflow owns the column transition');
});

test('workflow: a finished workflow is settled once and reports its outcome on the card', async () => {
    const workflow = createFakeWorkflow();
    const { bridge, board } = setup({ workflow });
    await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    await board.apply('review-move', { kind: 'move', taskId: 'task-1', status: 'review' }, 'test');
    workflow.setState('task-1', 'done');
    const result = await bridge.reconcile('test', { autoDispatch: false });
    assert.equal(result.ok, true);
    const record = bridge.stateStore.get('task-1');
    assert.equal(record.status, 'settled');
    assert.equal(record.outcome, 'succeeded');
    const integration = board.integrations.at(-1);
    assert.equal(integration.taskId, 'task-1');
    assert.equal(integration.payload.outcome, 'succeeded');
    assert.equal(integration.payload.delegated, true);
    const again = await bridge.reconcile('test', { autoDispatch: false });
    assert.equal(again.updated, 0, 'a settled delegation is not settled twice');
});

test('workflow: a done or permission-blocked workflow is not restarted', async () => {
    for (const state of ['done', 'permission-blocked']) {
        const workflow = createFakeWorkflow({ state });
        const { bridge } = setup({ workflow });
        const answer = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
        assert.equal(answer.status, 200);
        assert.equal(answer.body.code, 'workflow-' + state);
        assert.equal(workflow.starts.length, 0);
    }
});

test('workflow: a plain dispatch still writes the ticket group dispatch and settlement notes', async () => {
    const workflow = createFakeWorkflow({ targets: {} });
    const { bridge, board } = setup({ workflow, settings: { defaultAgent: '工部尚书' } });
    const answer = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    assert.equal(answer.status, 202);
    assert.equal(answer.body.via, 'default');
    assert.equal(workflow.starts.length, 0);
    assert.equal(workflow.begins.length, 1);
    assert.match(workflow.begins[0].text, /工部尚书/);
    board.settleExecution('task-1', 'succeeded');
    await bridge.dispatcher.settle({ taskId: 'task-1', executionId: 'exec-1', outcome: 'succeeded' });
    assert.ok(workflow.notes.some(entry => entry.event.phase === 'succeeded'), 'settlement is visible in the ticket group');
});

test('settle: a cancelled run with work already done moves the card to review', async () => {
    const { bridge, board } = setup({ settings: { defaultAgent: '工部尚书' } });
    await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    board.settleExecution('task-1', 'cancelled', { error: 'closed manually without a verdict' });
    assert.equal(board.snapshot().tasks[0].status, 'todo', 'the board itself requeues a cancelled card');
    const settled = await bridge.dispatcher.settle({
        taskId: 'task-1', executionId: 'exec-1', outcome: 'cancelled', error: 'closed manually without a verdict',
    });
    assert.equal(settled.code, 'settled');
    assert.equal(settled.movedToReview, true);
    assert.equal(board.snapshot().tasks[0].status, 'review');
});

test('merge: two copies of one card do not run at the same time', async () => {
    const first = taskFixture({ id: 'task-1', title: '同一个活', workspaceId: 'ws-1' });
    const copy = taskFixture({ id: 'task-2', title: '同一个活（副本）', workspaceId: 'ws-1' });
    const { bridge, board } = setup({ tasks: [first, copy], settings: { defaultAgent: '工部尚书' } });
    const one = await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    const two = await bridge.humanCreate({ taskId: 'task-2', source: 'board-ui' });
    assert.equal(one.status, 202);
    assert.equal(two.body.code, 'duplicate-target');
    assert.equal(board.actions.filter(entry => entry.action.kind === 'run').length, 1);
    assert.equal(bridge.stateStore.get('task-2'), undefined, 'the duplicate writes no record and stays dispatchable later');
});

test('merge: a run whose session died is reaped instead of holding the card forever', async () => {
    let clock = 1_000;
    const root = tempRoot();
    const board = createFakeBoard({ tasks: [taskFixture()] });
    const bridge = createSuperagentBridge({
        root,
        memory: createFakeMemory(),
        readAgents: () => agentsFixture([memberFixture()]),
        logger: loggerFixture(),
        reconcileDelayMs: -1,
        trustedRequest: () => true,
        now: () => clock,
    });
    bridge.setBoard(board);
    bridge.configure({ defaultAgent: '工部尚书', staleRunMinutes: 1 });
    await bridge.humanCreate({ taskId: 'task-1', source: 'board-ui' });
    clock += 61_000;
    const result = await bridge.reconcile('test', { autoDispatch: false });
    assert.equal(result.reaped, 1);
    const record = bridge.stateStore.get('task-1');
    assert.equal(record.status, 'failed');
    assert.match(record.error, /run-stalled/);
    assert.equal(board.snapshot().tasks[0].status, 'todo');
});
