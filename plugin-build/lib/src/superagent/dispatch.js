/**
 * The deterministic router between a human-created card and one agent.
 *
 * It is intentionally not an LLM: the operator names a default agent (or tags
 * the card), the board's own run opens the execution session, and every gate
 * (permission confirmation, workspace, spend, schedule) remains the board's.
 * This module only prepares the card, asks the board to run it, and then keeps
 * the dispatch ledger and the agent's memory in step with what the board did.
 */
import { randomUUID } from 'node:crypto';
import { composePrompt, planCardPatch, taskIsDispatchable } from './prompt.js';
import { readAgents, resolveAgentForTask } from './agents.js';

const ACTIVE = new Set(['preparing', 'dispatched', 'running', 'delegated']);

function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

function latestExecution(task) {
    const executions = Array.isArray(task?.executions) ? task.executions : [];
    return executions.length === 0 ? undefined : executions[executions.length - 1];
}

export function createDispatcher(options) {
    const getBoard = options.getBoard;
    const settingsStore = options.settingsStore;
    const stateStore = options.stateStore;
    const memory = options.memory;
    const workflow = options.workflow;
    const logger = options.logger ?? { warn: () => {}, info: () => {} };
    const now = options.now ?? Date.now;
    const uuid = options.uuid ?? (() => randomUUID());
    const readAgentsFn = options.readAgents ?? readAgents;
    const inFlight = new Set();
    const settling = new Set();
    let lastError;

    const noteError = (message) => {
        lastError = { message, at: now() };
        logger.warn?.('marshal-superagent: ' + message);
    };

    const boardFor = () => {
        try { return getBoard(); }
        catch { return undefined; }
    };

    const snapshotOf = board => {
        try { return board.snapshot(); }
        catch (cause) { noteError('snapshot failed: ' + messageOf(cause)); return undefined; }
    };

    const findTask = (snapshot, taskId) => (snapshot?.tasks ?? []).find(task => task?.id === taskId);

    const workflowTarget = taskId => {
        try { return workflow?.target?.(taskId); }
        catch { return undefined; }
    };

    // A cancelled run is not a fresh todo card: the session already produced
    // work, so the card owes a human verdict. The board's own settle rule sends
    // `cancelled` back to todo; this bridge upgrades that one case to review so
    // the column matches the review the board writes for a succeeded run.
    const reviewAfterCancel = async taskId => {
        const board = boardFor();
        if (board === undefined) return false;
        let task;
        try { task = findTask(snapshotOf(board), taskId); }
        catch { return false; }
        if (!task || (task.status !== 'todo' && task.status !== 'running')) return false;
        try {
            await board.apply(uuid(), { kind: 'move', taskId, status: 'review' }, 'marshal-superagent');
            return true;
        }
        catch (cause) {
            noteError('settle ' + taskId + ' could not move the card to review: ' + messageOf(cause));
            return false;
        }
    };

    const recentHumanDispatchCount = () => {
        const since = now() - 60_000;
        const counted = new Set(['preparing', 'dispatched', 'running', 'delegated', 'settled', 'memory-pending']);
        return stateStore.list().filter(record => record.source !== 'manual' && (record.createdAt ?? 0) >= since && counted.has(record.status)).length;
    };

    /**
     * A trailing copy marker names the SAME work, not different work. Two copies
     * of one card must not run at the same time, so the marker is stripped
     * before cards are compared.
     */
    const stripCopySuffix = value => {
        let text = value;
        for (let guard = 0; guard < 4; guard += 1) {
            const next = text.replace(/[(（]\s*(?:副本|cop(?:y|ies))\s*\d*\s*[)）]\s*$/iu, '').trim();
            if (next === text) return text;
            text = next;
        }
        return text;
    };

    /** Identity of the work a card asks for: one workspace plus one normalized title. */
    const targetKeyOf = (title, workspaceId) => {
        const text = stripCopySuffix(String(title ?? '').replace(/\s+/gu, ' ').trim().toLowerCase());
        if (text === '') return '';
        const scope = typeof workspaceId === 'string' && workspaceId !== '' ? workspaceId : '-';
        return scope + '::' + text;
    };

    /** Target keys another active dispatch already owns. */
    const activeTargetKeys = () => {
        const keys = new Set();
        for (const record of stateStore.list()) {
            if (!ACTIVE.has(record.status)) continue;
            const key = targetKeyOf(record.title, record.workspaceId);
            if (key !== '') keys.add(key);
        }
        return keys;
    };

    const status = () => {
        const settings = settingsStore.get();
        const board = boardFor();
        const agents = readAgentsFn();
        return {
            ok: true,
            enabled: settings.enabled,
            autoDispatchTodo: settings.autoDispatchTodo,
            defaultAgent: settings.defaultAgent,
            rootOnly: settings.rootOnly,
            tagPrefix: settings.tagPrefix,
            injectMemory: settings.injectMemory,
            memoryLimit: settings.memoryLimit,
            maxDispatchesPerMinute: settings.maxDispatchesPerMinute,
            staleRunMinutes: settings.staleRunMinutes,
            board: { available: board !== undefined },
            agents: { available: agents.available, ...(agents.code === undefined ? {} : { code: agents.code }), count: agents.members.length },
            memory: { available: memory.available },
            state: { file: stateStore.file, records: stateStore.list().length, error: stateStore.error() ?? null },
            settingsFile: settingsStore.file,
            settingsError: settingsStore.error() ?? null,
            lastError: lastError ?? null,
            recent: stateStore.list().slice(0, 8).map(record => ({
                taskId: record.taskId,
                title: record.title,
                status: record.status,
                agentName: record.agentName,
                outcome: record.outcome,
                error: record.error,
                memoryError: record.memoryError ?? null,
                memoryWritten: record.memoryWritten === true,
                notes: record.notes ?? null,
                executionId: record.executionId ?? null,
                sessionId: record.sessionId ?? null,
                updatedAt: record.updatedAt,
            })),
        };
    };

    const configure = (patch) => {
        const next = settingsStore.update(patch);
        return { ok: true, settings: { ...next } };
    };

    const listAgentSummaries = () => {
        const agents = readAgentsFn();
        return {
            available: agents.available,
            ...(agents.code === undefined ? {} : { code: agents.code }),
            file: agents.file,
            agents: agents.members.map(member => ({
                id: member.id,
                name: member.name,
                team: member.teamName,
                ...(member.preset === undefined ? {} : { preset: member.preset }),
                ...(member.permission === undefined ? {} : { permission: member.permission }),
                ...(member.model === undefined ? {} : { model: member.model }),
                ...(member.reasoningEffort === undefined ? {} : { reasoningEffort: member.reasoningEffort }),
            })),
        };
    };

    const fail = (taskId, code, message, extra = {}) => {
        const record = stateStore.put(taskId, { status: 'failed', error: code + ': ' + message, ...extra });
        noteError('dispatch ' + taskId + ' failed: ' + code + ': ' + message);
        return { ok: false, code, error: message, record };
    };

    const skip = (taskId, code, extra = {}) => {
        const existing = stateStore.get(taskId);
        // Never clobber a record that already reached a terminal state: a late
        // duplicate notification must not erase the settled outcome or its
        // memory-write receipt.
        if (existing !== undefined) {
            return { ok: false, code, skipped: true, record: existing };
        }
        const record = stateStore.put(taskId, { status: 'skipped', error: code, ...extra });
        return { ok: false, code, skipped: true, record };
    };

    /**
     * Dispatch one card. Serialized per task: two browser notifications in the
     * same tick share one attempt, not two runs.
     */
    const dispatch = async (request = {}) => {
        const taskId = typeof request.taskId === 'string' ? request.taskId.trim() : '';
        if (taskId === '') return { ok: false, code: 'invalid-task-id' };
        if (inFlight.has(taskId)) return { ok: false, code: 'in-flight' };
        inFlight.add(taskId);
        try {
            const settings = settingsStore.get();
            if (settings.enabled !== true) return { ok: false, code: 'disabled' };
            const previous = stateStore.get(taskId);
            if (previous?.status === 'awaiting-confirmation' && request.source !== 'manual') {
                return skip(taskId, 'awaiting-confirmation');
            }
            const board = boardFor();
            if (board === undefined) return fail(taskId, 'no-task-board', 'the task board service is not mounted');
            const snapshot = snapshotOf(board);
            if (snapshot === undefined) return fail(taskId, 'snapshot-failed', 'the task board snapshot is unavailable');
            const task = findTask(snapshot, taskId);
            if (task === undefined) return fail(taskId, 'task-not-found', 'no card with id ' + taskId);
            if (request.force !== true && previous !== undefined && (ACTIVE.has(previous.status) || previous.status === 'settled')) {
                return skip(taskId, 'duplicate-dispatch', { agentId: previous.agentId, agentName: previous.agentName });
            }
            const dispatchable = taskIsDispatchable(task, settings);
            if (dispatchable.ok !== true) return skip(taskId, dispatchable.code, { agentId: previous?.agentId, agentName: previous?.agentName });
            // A card created through Marshal can carry a preset workflow (leader,
            // coder, reviewer and template). Waking the card with a plain board
            // run would bypass that preset, so the workflow is the executor here
            // and the bridge only records the hand-off.
            const bound = workflowTarget(task.id);
            if (bound !== undefined && typeof workflow?.start === 'function') {
                if (bound.state === 'done' || bound.state === 'permission-blocked') {
                    // A finished workflow is a human decision, not a dispatch failure:
                    // write no record, so moving the card back to todo can retry it.
                    return { ok: false, code: 'workflow-' + bound.state, agentId: bound.agentId, agentName: bound.leaderName };
                }
                if (bound.state === 'running' || bound.state === 'handed-off') {
                    return skip(taskId, 'already-running', { agentId: bound.agentId, agentName: bound.leaderName });
                }
                if (request.force !== true && request.source !== 'manual') {
                    const targetKey = targetKeyOf(task.title, bound.workspaceId);
                    if (targetKey !== '' && activeTargetKeys().has(targetKey)) {
                        return { ok: false, code: 'duplicate-target', targetKey };
                    }
                }
                if (recentHumanDispatchCount() >= settings.maxDispatchesPerMinute) {
                    return fail(taskId, 'rate-limited', 'more than ' + settings.maxDispatchesPerMinute + ' dispatches in the last minute', {
                        agentId: bound.agentId,
                        agentName: bound.leaderName,
                        title: task.title,
                    });
                }
                const requestId = typeof request.requestId === 'string' && request.requestId !== '' ? request.requestId : uuid();
                stateStore.put(taskId, {
                    status: 'preparing',
                    delegated: true,
                    agentId: bound.agentId,
                    agentName: bound.leaderName,
                    ...(typeof bound.workspaceId === 'string' && bound.workspaceId !== '' ? { workspaceId: bound.workspaceId } : {}),
                    title: typeof task.title === 'string' ? task.title : '',
                    source: request.source ?? 'ui',
                    requestId,
                    memoryError: undefined,
                });
                let result;
                try {
                    await workflow.begin?.(taskId, requestId, '超级智能体按工单预设编排派单。');
                    result = workflow.start(taskId, task, { reason: 'auto-dispatch', skipBegin: true });
                }
                catch (cause) {
                    await workflow.note?.(taskId, {
                        kind: 'status', actor: 'Marshal', phase: 'failed',
                        text: '预设编排未能启动：' + messageOf(cause).slice(0, 400),
                    });
                    return fail(taskId, 'workflow-start-failed', messageOf(cause), {
                        agentId: bound.agentId, agentName: bound.leaderName, notes: ['workflow-delegation'],
                    });
                }
                if (result === undefined || result.ok !== true) {
                    await workflow.note?.(taskId, {
                        kind: 'status', actor: 'Marshal', phase: 'failed',
                        text: '预设编排未能启动：' + String(result?.code ?? 'unknown'),
                    });
                    return fail(taskId, 'workflow-start-failed', result?.code ?? 'unknown', {
                        agentId: bound.agentId, agentName: bound.leaderName, notes: ['workflow-delegation'],
                    });
                }
                await workflow.note?.(taskId, {
                    kind: 'status', actor: 'Marshal', phase: 'dispatch',
                    text: '超级智能体已按工单预设编排启动：Leader ' + (bound.leaderName ?? '未指定')
                        + '，模板 ' + (bound.templateId ?? '普通任务') + '。',
                });
                const record = stateStore.put(taskId, {
                    status: 'delegated',
                    delegated: true,
                    agentId: bound.agentId,
                    agentName: bound.leaderName,
                    notes: ['workflow-delegation'],
                });
                logger.info?.('marshal-superagent: delegated ' + taskId + ' to workflow leader ' + (bound.leaderName ?? 'unknown'));
                return { ok: true, code: 'dispatched', via: 'workflow', record };
            }
            const agents = readAgentsFn();
            if (agents.available !== true) return fail(taskId, 'agents-unavailable', 'the dsh-agents ledger is unavailable: ' + (agents.code ?? 'unknown'));
            const resolved = resolveAgentForTask(task, settings, agents.members);
            if (resolved.member === undefined) return fail(taskId, 'agent-not-resolved', resolved.error ?? 'no agent resolved');
            const member = resolved.member;
            if (recentHumanDispatchCount() >= settings.maxDispatchesPerMinute) {
                return fail(taskId, 'rate-limited', 'more than ' + settings.maxDispatchesPerMinute + ' human dispatches in the last minute', {
                    agentId: member.id,
                    agentName: member.name,
                    title: task.title,
                });
            }
            const effectiveWorkspaceId = (typeof task.workspaceId === 'string' && task.workspaceId.trim() !== '' ? task.workspaceId.trim() : undefined)
                ?? member.teamWorkspaceId;
            if (request.force !== true && request.source !== 'manual') {
                // Another card asking for the same work in the same workspace is
                // still active. Leave this one in the todo column and write NO
                // record, so a later reconcile can dispatch it once the sibling
                // settles.
                const targetKey = targetKeyOf(task.title, effectiveWorkspaceId);
                if (targetKey !== '' && activeTargetKeys().has(targetKey)) {
                    return { ok: false, code: 'duplicate-target', targetKey };
                }
            }
            const requestId = typeof request.requestId === 'string' && request.requestId !== '' ? request.requestId : uuid();
            const started = stateStore.put(taskId, {
                status: 'preparing',
                agentId: member.id,
                agentName: member.name,
                teamId: member.teamId,
                ...(effectiveWorkspaceId === undefined ? {} : { workspaceId: effectiveWorkspaceId }),
                title: typeof task.title === 'string' ? task.title : '',
                source: request.source ?? 'ui',
                requestId,
                memoryError: undefined,
            });
            let memoryBlock = '';
            let memoryCount = 0;
            if (settings.injectMemory === true) {
                try {
                    const recalled = await memory.recall({
                        agentId: member.id,
                        ...(effectiveWorkspaceId === undefined ? {} : { workspaceId: effectiveWorkspaceId }),
                        text: [task.title, task.description, task.prompt].filter(part => typeof part === 'string' && part.trim() !== '').join(' '),
                        limit: settings.memoryLimit,
                    });
                    memoryBlock = recalled.text;
                    memoryCount = recalled.count;
                    if (recalled.error !== undefined) stateStore.put(taskId, { memoryError: recalled.error });
                }
                catch (cause) {
                    stateStore.put(taskId, { memoryError: 'memory-recall-failed: ' + messageOf(cause) });
                }
            }
            const prompt = composePrompt({ member, task, memory: memoryBlock, memoryCount });
            const planned = planCardPatch({ task, member, snapshot, prompt });
            let updated;
            try {
                updated = await board.apply(uuid(), { kind: 'update', taskId, patch: planned.patch }, 'marshal-superagent');
            }
            catch (cause) {
                return fail(taskId, 'card-update-refused', messageOf(cause), { agentId: member.id, agentName: member.name });
            }
            const preparedTask = findTask(updated ?? snapshotOf(board), taskId) ?? task;
            let after;
            try {
                after = await board.apply(uuid(), { kind: 'run', taskId }, 'marshal-superagent');
            }
            catch (cause) {
                return fail(taskId, 'run-refused', messageOf(cause), {
                    agentId: member.id,
                    agentName: member.name,
                    notes: planned.notes,
                });
            }
            const ranTask = findTask(after ?? snapshotOf(board), taskId) ?? preparedTask;
            const execution = latestExecution(ranTask);
            const status = execution === undefined ? 'dispatched' : 'running';
            const memoryError = stateStore.get(taskId)?.memoryError;
            const record = stateStore.put(taskId, {
                status,
                ...(execution === undefined ? {} : { executionId: execution.id }),
                ...(execution?.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
                ...(planned.notes.length === 0 ? {} : { notes: planned.notes }),
                ...(memoryError === undefined ? {} : { memoryError }),
            });
            if (execution !== undefined) {
                await workflow?.begin?.(taskId, execution.id,
                    '超级智能体已派单给 ' + member.name + '（' + resolved.via + '），执行会话已开启。');
            }
            logger.info?.('marshal-superagent: dispatched ' + taskId + ' to ' + member.name + ' (' + resolved.via + ')');
            return { ok: true, code: 'dispatched', via: resolved.via, record };
        }
        catch (cause) {
            noteError('dispatch ' + taskId + ' crashed: ' + messageOf(cause));
            return { ok: false, code: 'internal-error', error: messageOf(cause) };
        }
        finally {
            inFlight.delete(taskId);
        }
    };

    /**
     * Write back one settled execution. Called from the board extension event
     * and from reconciliation, so a missed event is caught on the next board
     * change or restart.
     */
    const settle = async (event, host) => {
        const taskId = typeof event?.taskId === 'string' ? event.taskId : '';
        if (taskId === '') return { ok: false, code: 'invalid-task-id' };
        if (settling.has(taskId)) return { ok: false, code: 'settle-in-flight' };
        settling.add(taskId);
        try {
            return await settleLocked(event, host);
        }
        finally {
            settling.delete(taskId);
        }
    };

    const settleLocked = async (event, host) => {
        const taskId = typeof event?.taskId === 'string' ? event.taskId : '';
        const record = stateStore.get(taskId);
        if (record === undefined || typeof record.agentId !== 'string' || record.agentId === '') return { ok: false, code: 'not-dispatched' };
        if (settingsStore.get().enabled !== true) return { ok: false, code: 'disabled' };
        if (record.status === 'awaiting-confirmation') return { ok: false, code: 'awaiting-confirmation' };
        if (record.status === 'failed' || record.status === 'skipped') return { ok: false, code: 'not-active' };
        if (record.memoryWritten === true) return { ok: true, code: 'already-settled' };
        if (typeof event.executionId === 'string' && typeof record.executionId === 'string' && record.executionId !== event.executionId) {
            // A later manual rerun is not this dispatch's execution.
            return { ok: false, code: 'execution-mismatch' };
        }
        const board = host?.tasks === undefined ? boardFor() : undefined;
        let task;
        try {
            task = host?.tasks?.get(taskId) ?? findTask(snapshotOf(board), taskId);
        }
        catch (cause) {
            noteError('settle ' + taskId + ' could not read the card: ' + messageOf(cause));
            return { ok: false, code: 'task-read-failed' };
        }
        if (task === undefined) return { ok: false, code: 'task-not-found' };
        const executions = Array.isArray(task.executions) ? task.executions : [];
        // An event that names an execution must resolve to THAT execution; a
        // later manual rerun is not this dispatch's work.
        const execution = typeof event.executionId === 'string'
            ? executions.find(item => item?.id === event.executionId)
            : latestExecution(task);
        if (execution === undefined) return { ok: false, code: 'execution-not-found' };
        if (execution.endedAt === undefined && execution.result === undefined) return { ok: false, code: 'execution-still-open' };
        const outcome = typeof event.outcome === 'string' ? event.outcome : (execution.result ?? 'unknown');
        const error = typeof event.error === 'string' ? event.error : (execution.error ?? undefined);
        stateStore.put(taskId, {
            status: 'memory-pending',
            executionId: execution.id,
            ...(execution.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
            outcome,
            ...(error === undefined ? {} : { error }),
        });
        const memoryResult = await memory.rememberEpisode({
            agentId: record.agentId,
            workspaceId: record.workspaceId,
            title: '工单「' + (task.title ?? record.title ?? taskId) + '」' + (outcome === 'succeeded' ? '完成' : outcome),
            text: memory.digest({ task, execution, agentName: record.agentName, outcome }),
            tags: [taskId, 'superagent', record.agentName].filter(tag => typeof tag === 'string' && tag !== ''),
        });
        stateStore.put(taskId, {
            status: memoryResult.ok === true ? 'settled' : 'memory-pending',
            memoryWritten: memoryResult.ok === true,
            ...(memoryResult.ok === true ? { memoryError: undefined } : { memoryError: memoryResult.error ?? 'memory-write-failed' }),
        });
        if (memoryResult.ok !== true) noteError('settle ' + taskId + ' memory write failed: ' + (memoryResult.error ?? 'unknown'));
        try {
            host?.integration?.write(taskId, {
                dispatch: {
                    agentId: record.agentId,
                    agentName: record.agentName,
                    source: record.source,
                    at: record.createdAt,
                    executionId: execution.id,
                    ...(execution.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
                },
                outcome,
                memoryWritten: memoryResult.ok === true,
            });
        }
        catch (cause) {
            noteError('settle ' + taskId + ' integration write failed: ' + messageOf(cause));
        }
        const movedToReview = outcome === 'cancelled' ? await reviewAfterCancel(taskId) : false;
        if (movedToReview) stateStore.put(taskId, { movedToReview: true });
        const outcomeLabel = outcome === 'succeeded' ? '已完成待验收' : outcome === 'cancelled' ? '已取消，保留工作待确认' : outcome;
        await workflow?.note?.(taskId, {
            kind: 'status', actor: 'Marshal', phase: movedToReview ? 'review' : outcome,
            text: '执行结束：' + outcomeLabel + (error === undefined ? '。' : '。' + String(error).slice(0, 400)),
        });
        return { ok: true, code: 'settled', outcome, memoryWritten: memoryResult.ok === true, movedToReview };
    };

    /**
     * Reconcile active dispatch records against the board. Runs on mount, on
     * board changes (throttled by the mount), and on demand from the tool.
     */
    const reconcile = async (filter = {}, host) => {
        const settings = settingsStore.get();
        if (settings.enabled !== true) return { ok: false, code: 'disabled', checked: 0 };
        const board = boardFor();
        if (board === undefined) return { ok: false, code: 'no-task-board', checked: 0 };
        const snapshot = snapshotOf(board);
        if (snapshot === undefined) return { ok: false, code: 'snapshot-failed', checked: 0 };
        const records = (filter.taskId === undefined ? stateStore.active() : [stateStore.get(filter.taskId)].filter(Boolean));
        let settled = 0;
        let updated = 0;
        let reaped = 0;
        for (const record of records) {
            if (record.status === 'awaiting-confirmation') continue;
            const task = findTask(snapshot, record.taskId);
            if (task === undefined) {
                stateStore.put(record.taskId, { status: 'failed', error: 'task-disappeared' });
                updated += 1;
                continue;
            }
            if (record.delegated === true) {
                let view;
                try { view = workflow?.view?.(record.taskId) ?? workflowTarget(record.taskId); }
                catch { view = undefined; }
                const terminal = task.status === 'review' || task.status === 'done' || task.status === 'failed'
                    || view?.state === 'done' || view?.state === 'failed' || view?.state === 'permission-blocked';
                if (terminal) {
                    const outcome = view?.state === 'permission-blocked' ? 'blocked'
                    : task.status === 'failed' || view?.state === 'failed' ? 'failed' : 'succeeded';
                    stateStore.put(record.taskId, { status: 'settled', delegated: true, outcome, memoryWritten: false });
                    try {
                        host?.integration?.write(record.taskId, {
                            dispatch: {
                                agentId: record.agentId,
                                agentName: record.agentName,
                                source: record.source,
                                at: record.createdAt,
                                ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
                            },
                            outcome,
                            memoryWritten: false,
                            delegated: true,
                        });
                    }
                    catch (cause) {
                        noteError('reconcile ' + record.taskId + ' integration write failed: ' + messageOf(cause));
                    }
                    updated += 1;
                }
                continue;
            }
            const execution = latestExecution(task);
            if (execution !== undefined) {
                const open = execution.endedAt === undefined && execution.result === undefined;
                if (open && record.status === 'running' && settings.staleRunMinutes > 0) {
                    const age = now() - (record.updatedAt ?? record.createdAt ?? 0);
                    if (age > settings.staleRunMinutes * 60_000) {
                        // A run whose session died never settles itself. Close the open
                        // execution so the card leaves the running column and becomes
                        // dispatchable again; never claim that run's outcome.
                        stateStore.put(record.taskId, {
                            status: 'failed',
                            error: 'run-stalled: no settle within ' + settings.staleRunMinutes + ' min',
                        });
                        reaped += 1;
                        updated += 1;
                        // Only now close the open execution: the board notification
                        // this triggers re-enters reconcile, which must already see a
                        // terminal record and leave it alone.
                        try {
                            await board.apply(uuid(), { kind: 'settle', taskId: record.taskId }, 'marshal-superagent');
                        }
                        catch (cause) {
                            noteError('stale run ' + record.taskId + ' could not be settled: ' + messageOf(cause));
                        }
                        continue;
                    }
                }
                if (typeof record.executionId === 'string' && record.executionId !== execution.id) {
                    // A manual rerun replaced the run this record opened; do not
                    // claim its outcome or write its work into the agent's memory.
                    stateStore.put(record.taskId, { status: 'failed', error: 'execution-superseded' });
                    updated += 1;
                    continue;
                }
                const patch = {
                    status: 'running',
                    executionId: execution.id,
                    ...(execution.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
                };
                if (record.executionId !== execution.id || record.sessionId !== execution.sessionId || record.status !== 'running') {
                    stateStore.put(record.taskId, patch);
                    updated += 1;
                }
                if (execution.endedAt !== undefined || execution.result !== undefined) {
                    await settle({ taskId: record.taskId, executionId: execution.id, outcome: execution.result, error: execution.error }, host);
                    settled += 1;
                }
                continue;
            }
            if (record.status === 'preparing' || record.status === 'dispatched') {
                const age = now() - (record.updatedAt ?? record.createdAt ?? 0);
                if (age > 60_000) {
                    stateStore.put(record.taskId, { status: 'failed', error: 'run-not-opened' });
                    updated += 1;
                }
            }
        }
        let dispatched = 0;
        if (filter.taskId === undefined && filter.autoDispatch !== false && settings.autoDispatchTodo === true && inFlight.size === 0) {
            const agents = readAgentsFn();
            if (agents.available === true && agents.members.length > 0) {
                const latestSnap = snapshotOf(board) ?? snapshot;
                const candidates = [...(latestSnap.tasks ?? [])]
                    .filter(task => task && task.status === 'todo')
                    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
                for (const task of candidates) {
                    if (inFlight.has(task.id)) continue;
                    if (stateStore.get(task.id) !== undefined) continue;
                    if (taskIsDispatchable(task, settings, { requireTodo: true }).ok !== true) continue;
                    const bound = workflowTarget(task.id);
                    const workflowReady = bound !== undefined && ['ready', 'interrupted', 'failed'].includes(bound.state);
                    if (!workflowReady && resolveAgentForTask(task, settings, agents.members).member === undefined) continue;
                    if (recentHumanDispatchCount() >= settings.maxDispatchesPerMinute) break;
                    const res = await dispatch({ taskId: task.id, source: 'todo' });
                    if (res.ok === true) dispatched += 1;
                }
            }
        }
        return { ok: true, checked: records.length, settled, updated, dispatched, reaped };
    };

    return {
        dispatch,
        settle,
        reconcile,
        status,
        configure,
        listAgentSummaries,
        lastError: () => lastError,
        isActive: taskId => ACTIVE.has(stateStore.get(taskId)?.status),
    };
}
