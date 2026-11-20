/**
 * Test doubles for the superagent bridge: a task-board face, a memory service
 * and a Cordis-shaped context. The doubles keep the board's own gates visible
 * (run/update failures throw) instead of assuming success.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempRoot(prefix = 'marshal-superagent-') {
    return mkdtempSync(join(tmpdir(), prefix));
}

export function taskFixture(overrides = {}) {
    return {
        id: 'task-1',
        title: '登录页',
        description: '做一个登录页',
        prompt: '实现登录页并跑测试',
        status: 'todo',
        createdAt: 1,
        updatedAt: 1,
        executions: [],
        ...overrides,
    };
}

export function memberFixture(overrides = {}) {
    return {
        id: 'member-1',
        name: '工部尚书',
        teamId: 'team-1',
        teamName: 'marshal-agent:工部尚书-x',
        teamWorkspaceId: 'ws-1',
        brief: '你是工部尚书，掌产品与交付。',
        permission: 'danger-full-access',
        model: 'deepseek-account/deepseek-flash',
        ...overrides,
    };
}

export function agentsFixture(members = [memberFixture()]) {
    return { available: true, file: '/tmp/ledger.json', members, teams: [] };
}

export function createFakeBoard(options = {}) {
    let tasks = structuredClone(options.tasks ?? [taskFixture()]);
    const sessionDefaultPermission = options.sessionDefaultPermission ?? 'danger-full-access';
    const listeners = new Set();
    const actions = [];
    const integrations = [];
    let extension;
    let host;
    let failRun = options.failRun;
    let failUpdate = options.failUpdate;
    const snapshot = () => ({
        tasks: structuredClone(tasks),
        sessionDefaultPermission,
        extensions: extension === undefined ? {} : { 'marshal-superagent': extension.summary?.() },
    });
    const notify = () => { for (const listener of listeners) listener(); };
    const find = id => tasks.find(task => task.id === id);
    const board = {
        actions,
        integrations,
        get extension() { return extension; },
        get host() { return host; },
        snapshot,
        setFailRun(value) { failRun = value; },
        setFailUpdate(value) { failUpdate = value; },
        apply: async (requestId, action, initiator) => {
            actions.push({ requestId, action, initiator });
            if (action.kind === 'update') {
                if (failUpdate !== undefined) throw new Error(failUpdate);
                const task = find(action.taskId);
                if (task === undefined) throw new Error('task not found');
                Object.assign(task, action.patch, { updatedAt: 2 });
            }
            else if (action.kind === 'run') {
                if (failRun !== undefined) throw new Error(failRun);
                const task = find(action.taskId);
                if (task === undefined) throw new Error('task not found');
                if (task.executions.some(execution => execution.endedAt === undefined && execution.result === undefined)) throw new Error('already running');
                task.status = 'running';
                task.executions = [...task.executions, {
                    id: 'exec-' + (task.executions.length + 1),
                    startedAt: 10,
                    endedAt: undefined,
                    result: undefined,
                    sessionId: options.sessionId ?? 'session-1',
                }];
            }
            else if (action.kind === 'move') {
                const task = find(action.taskId);
                if (task === undefined) throw new Error('task not found');
                if (task.executions.some(execution => execution.endedAt === undefined && execution.result === undefined)) {
                    throw new Error('execution still open');
                }
                task.status = action.status;
                task.updatedAt = 3;
            }
            else if (action.kind === 'settle') {
                const task = find(action.taskId);
                if (task === undefined) throw new Error('task not found');
                const execution = task.executions[task.executions.length - 1];
                if (execution === undefined || execution.endedAt !== undefined) throw new Error('no open execution');
                execution.endedAt = 20;
                execution.result = 'cancelled';
                task.status = 'todo';
            }
            notify();
            return snapshot();
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        registerExtension(candidate) {
            extension = candidate;
            host = {
                tasks: { get: id => find(id), list: () => structuredClone(tasks) },
                events: {
                    handlers: [],
                    onExecutionSettled(callback) { host.events.handlers.push(callback); return () => {}; },
                },
                integration: {
                    write(taskId, payload) {
                        integrations.push({ taskId, payload });
                        const task = find(taskId);
                        if (task !== undefined) task.integrations = { ...(task.integrations ?? {}), 'marshal-superagent': payload };
                    },
                },
                publish(value) { host.published = value; },
                sessions: { async followUp() {} },
            };
            candidate.start(host);
            return () => candidate.stop();
        },
        settleExecution(taskId, outcome = 'succeeded', details = {}) {
            const task = find(taskId);
            if (task === undefined) throw new Error('task not found');
            const execution = task.executions[task.executions.length - 1];
            if (execution === undefined) throw new Error('no execution to settle');
            execution.endedAt = 99;
            execution.result = outcome;
            if (details.error !== undefined) execution.error = details.error;
            if (details.summary !== undefined) execution.summary = { text: details.summary, seq: 7 };
            task.status = outcome === 'succeeded' ? 'done' : outcome === 'cancelled' ? 'todo' : 'failed';
            notify();
            return execution;
        },
        fireSettled(event) {
            for (const callback of host?.events?.handlers ?? []) callback(event);
        },
        tick() { notify(); },
    };
    return board;
}

export function createFakeWorkflow(options = {}) {
    const targets = new Map(Object.entries(options.targets ?? {
        'task-1': { state: options.state ?? 'ready', leaderName: '丞相', agentId: 'member-2', workspaceId: 'ws-1', templateId: 'development' },
    }));
    const starts = [];
    const notes = [];
    const begins = [];
    return {
        starts,
        notes,
        begins,
        target(taskId) { return targets.get(taskId); },
        view(taskId) { return targets.get(taskId); },
        setState(taskId, state) {
            const current = targets.get(taskId);
            if (current !== undefined) targets.set(taskId, { ...current, state });
        },
        async begin(taskId, runId, text) { begins.push({ taskId, runId, text }); },
        async note(taskId, event) { notes.push({ taskId, event }); },
        start(taskId, card, settings) {
            starts.push({ taskId, card, settings });
            const current = targets.get(taskId);
            if (current !== undefined) targets.set(taskId, { ...current, state: 'running' });
            return { ok: true, started: true, state: 'running' };
        },
        async move(taskId, status) { const task = targets.get(taskId); if (task !== undefined) targets.set(taskId, { ...task, state: status }); return true; },
    };
}

export function createFakeMemory(items = []) {
    const writes = [];
    const recalls = [];
    return {
        writes,
        recalls,
        listFor(query) {
            recalls.push(query);
            return items;
        },
        rememberFor(input) {
            writes.push(input);
            return { id: 'memory-' + (writes.length + 1), ...input };
        },
    };
}

export function loggerFixture() {
    const lines = [];
    return {
        lines,
        info(message) { lines.push('info: ' + message); },
        warn(message) { lines.push('warn: ' + message); },
    };
}

/**
 * A small Cordis-shaped context: inject callbacks run immediately against the
 * services the test supplied, and effect disposers are collected.
 */
export function createFakeContext(services = {}) {
    const effects = [];
    const registeredTools = [];
    const routes = [];
    const scoped = {
        ...services,
        tools: services.tools ?? { register(definition) { registeredTools.push(definition); return () => {}; } },
        webServer: services.webServer ?? { register(route) { routes.push(route); return () => {}; } },
        effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose; },
    };
    const ctx = {
        logger: services.logger ?? loggerFixture(),
        effects,
        registeredTools,
        routes,
        inject(names, callback) {
            const present = names.every(name => scoped[name] !== undefined);
            if (present) callback(scoped);
            return () => {};
        },
        effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose; },
        get(name) { return scoped[name]; },
        close() { for (const dispose of effects.splice(0)) dispose(); },
    };
    return ctx;
}
