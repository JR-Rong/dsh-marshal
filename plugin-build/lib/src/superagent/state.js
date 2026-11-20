/**
 * Dispatch ledger for the superagent bridge.
 *
 * One record per card the bridge itself dispatched. Records are keyed by task
 * id, so a duplicated browser notification can never open two runs. The file is
 * local, atomically replaced, bounded, and keeps only dispatch metadata plus a
 * short card title for status reads — never the full prompt, memory block or
 * session transcript.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export const STATE_VERSION = 1;
export const MAX_DISPATCHES = 500;
const ACTIVE = new Set(['preparing', 'dispatched', 'running', 'memory-pending']);
const TERMINAL = new Set(['settled', 'failed', 'skipped']);

export function defaultState(now = Date.now()) {
    return { version: STATE_VERSION, dispatches: {}, updatedAt: now };
}

function normalizeRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const row = value;
    if (typeof row.taskId !== 'string' || row.taskId === '') return undefined;
    if (typeof row.status !== 'string') return undefined;
    const copy = { ...row };
    for (const key of ['agentId', 'agentName', 'teamId', 'workspaceId', 'requestId', 'executionId', 'sessionId', 'outcome', 'error', 'memoryError', 'title', 'source']) {
        if (copy[key] !== undefined && typeof copy[key] !== 'string') delete copy[key];
    }
    return copy;
}

export function normalizeState(raw, now = Date.now()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaultState(now);
    const dispatches = {};
    const source = raw.dispatches;
    if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
        for (const [taskId, value] of Object.entries(source)) {
            const record = normalizeRecord(value);
            if (record === undefined) continue;
            dispatches[taskId] = { ...record, taskId };
        }
    }
    return { version: STATE_VERSION, dispatches, updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now };
}

export function createStateStore(root, options = {}) {
    const now = options.now ?? Date.now;
    const logger = options.logger ?? { warn: () => {} };
    const file = join(root, 'state.json');
    let error;
    let state = defaultState(now());
    try {
        state = normalizeState(JSON.parse(readFileSync(file, 'utf8')), now());
    }
    catch (cause) {
        if (cause?.code !== 'ENOENT') {
            error = 'state-unreadable: ' + (cause instanceof Error ? cause.message : String(cause));
            logger.warn?.('marshal-superagent: ' + error);
        }
    }
    const save = () => {
        mkdirSync(dirname(file), { recursive: true });
        const temp = file + '.tmp-' + randomUUID();
        writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
        renameSync(temp, file);
    };
    const prune = () => {
        const entries = Object.entries(state.dispatches);
        if (entries.length <= MAX_DISPATCHES) return;
        const removable = entries
            .filter(([, record]) => TERMINAL.has(record.status))
            .sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
        const excess = entries.length - MAX_DISPATCHES;
        for (const [taskId] of removable.slice(0, excess)) delete state.dispatches[taskId];
        // Active records are never evicted; the rate limiter bounds a flood, and
        // dropping a running record would lose its memory write.
    };
    const persist = () => {
        prune();
        state.updatedAt = now();
        try {
            save();
            error = undefined;
        }
        catch (cause) {
            error = 'state-unwritable: ' + (cause instanceof Error ? cause.message : String(cause));
            logger.warn?.('marshal-superagent: ' + error);
        }
    };
    if (error === undefined) persist();
    return {
        file,
        error: () => error,
        get: taskId => state.dispatches[taskId],
        list: () => Object.values(state.dispatches).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
        active: () => Object.values(state.dispatches).filter(record => ACTIVE.has(record.status)),
        put(taskId, patch) {
            const previous = state.dispatches[taskId];
            const record = {
                ...(previous ?? {}),
                ...(patch ?? {}),
                taskId,
                createdAt: previous?.createdAt ?? now(),
                updatedAt: now(),
            };
            state.dispatches[taskId] = record;
            persist();
            return record;
        },
        remove(taskId) {
            delete state.dispatches[taskId];
            persist();
        },
    };
}
