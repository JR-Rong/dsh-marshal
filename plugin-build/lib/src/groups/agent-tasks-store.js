import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile, withFileLock } from '../hub/state-file.js';
import { taskError } from './pr-material.js';

const key = z.string().trim().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const agentKeySchema = key.refine(value => /^(?:[^/]+\/){0,2}[^/]+$/.test(value));
const fields = z.object({
    agentKey: agentKeySchema,
    type: z.enum(['casual', 'direct', 'ticket']),
    title: z.string().trim().min(1).max(512),
    status: z.enum(['running', 'review', 'queued', 'done', 'failed']),
    sessionId: key.nullable().optional(),
    subSessions: z.array(z.object({ id: key, role: key, status: key, title: z.string().max(512) }).strict()).max(64),
    linkedTicketId: key.nullable().optional(),
    lastSummary: z.string().max(12000).nullable().optional(),
    lastSyncAt: z.number().int().nonnegative().nullable().optional(),
}).strict();

export function agentKeyMatches(left, right) {
    return typeof left === 'string' && typeof right === 'string' && left !== '' && right !== ''
        && (left === right || left.endsWith('/' + right) || right.endsWith('/' + left));
}

export function parseAgentKey(value) {
    const result = agentKeySchema.safeParse(value);
    if (!result.success) throw taskError('invalid-agent-key', '智能体标识无效。');
    return result.data;
}

export function ticketStatus(task) {
    const state = task.workflow?.state;
    if (task.taskRoom?.closed) return 'done';
    if (['review-blocked', 'permission-blocked', 'waiting'].includes(state)) return 'review';
    if (['running', 'handed-off'].includes(state)) return 'running';
    if (['failed', 'interrupted'].includes(state)) return 'failed';
    if (state === 'done') return task.status === 'done' ? 'done' : task.status === 'review' || task.taskRoom ? 'review' : 'done';
    if (task.status === 'waiting') return 'review';
    return ['running', 'review', 'done', 'failed'].includes(task.status) ? task.status : 'queued';
}

const sessionIdsOf = task => {
    const execution = task.executions?.at(-1);
    return [task.workflow?.sessionId ?? (execution ? execution.sessionId : task.sessionId),
        ...(task.links?.sessionIds ?? [])].filter(Boolean);
};

/** Synthetic ticket views never write to the board; explicit 1:1 records remain editable. */
export function createAgentTaskStore({ dataDir, now = Date.now, listTickets = () => [] }) {
    const file = join(dataDir, 'agent-tasks.json');
    const read = () => {
        let state;
        try { state = JSON.parse(readFileSync(file, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return { version: 1, tasks: [], ticketSync: {} }; throw error; }
        if (state?.version !== 1 || !Array.isArray(state.tasks)) throw taskError('agent-tasks-corrupt', '个人任务仓格式无效。');
        // Migrate older synthetic rows without trusting them as permanent associations.
        const ticketSync = { ...state.ticketSync };
        const tasks = state.tasks.filter(task => {
            if (!task.id.startsWith('ticket:')) return true;
            if (task.lastSyncAt != null && !Object.hasOwn(ticketSync, task.id)) {
                ticketSync[task.id] = { lastSummary: task.lastSummary, lastSyncAt: task.lastSyncAt };
            }
            return false;
        });
        return { version: 1, tasks, ticketSync };
    };
    const mutate = fn => withFileLock(file, () => {
        const state = read();
        const result = fn(state.tasks, state.ticketSync);
        atomicWriteFile(file, JSON.stringify(state, null, 2) + '\n');
        return result;
    });
    const parse = (schema, input) => {
        const result = schema.safeParse(input);
        if (!result.success) throw taskError('invalid-agent-task', '个人任务字段无效。');
        return result.data;
    };
    const indexOf = (tasks, id) => {
        const idx = tasks.findIndex(task => task.id === id);
        if (idx < 0) throw taskError('not-found', '个人任务不存在。');
        return idx;
    };
    return {
        getTask: id => read().tasks.find(task => task.id === id),
        listStoredTasks(agentKey) {
            const parsed = parseAgentKey(agentKey);
            return read().tasks.filter(task => agentKeyMatches(parsed, task.agentKey));
        },
        listTasks(agentKey, { tickets, sessionIds = [], assignedTo, matchesStored } = {}) {
            const parsed = parseAgentKey(agentKey);
            const { tasks, ticketSync } = read();
            const stored = tasks.filter(task => matchesStored ? matchesStored(task) : agentKeyMatches(parsed, task.agentKey));
            const visible = tickets ?? listTickets(parsed);
            const byId = new Map(visible.map(task => [task.id, task]));
            const sessions = new Set([...sessionIds, ...stored.flatMap(task => [task.sessionId, ...task.subSessions.map(sub => sub.id)])].filter(Boolean));
            const linked = new Set();
            const result = stored.flatMap(task => {
                if (!task.linkedTicketId) return [task];
                const ticket = byId.get(task.linkedTicketId);
                if (!ticket || ticket.archivedAt != null) return [];
                linked.add(ticket.id);
                return [{ ...task, title: ticket.title, status: ticketStatus(ticket), sessionId: sessionIdsOf(ticket)[0] ?? task.sessionId }];
            });
            for (const ticket of visible) {
                if (linked.has(ticket.id) || ticket.archivedAt != null) continue;
                const assigned = assignedTo ? assignedTo(ticket) : [ticket.agentKey, ticket.agentId, ticket.workflow?.leaderId,
                    ticket.workflow?.agentId, ...Object.values(ticket.workflow?.plan?.members ?? {})].some(value => agentKeyMatches(value, parsed));
                const ids = sessionIdsOf(ticket);
                if (!assigned && !ids.some(id => sessions.has(id))) continue;
                const id = `ticket:${encodeURIComponent(parsed)}:${ticket.id}`;
                result.push({ id, agentKey: parsed, type: 'ticket', title: ticket.title,
                    status: ticketStatus(ticket), linkedTicketId: ticket.id, sessionId: ids[0], subSessions: [],
                    createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, ...ticketSync[id] });
            }
            return result.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        },
        createTask(input) {
            const data = parse(fields, { status: 'queued', subSessions: [], ...input });
            const at = now();
            const task = { ...data, id: randomUUID(), createdAt: at, updatedAt: at };
            return mutate(tasks => { tasks.push(task); return task; });
        },
        updateTask(id, patch) {
            const data = parse(fields.omit({ agentKey: true }).partial(), patch);
            return mutate(tasks => {
                const idx = indexOf(tasks, id);
                return tasks[idx] = { ...tasks[idx], ...data, updatedAt: now() };
            });
        },
        deleteTask(id) {
            return mutate(tasks => (tasks.splice(indexOf(tasks, id), 1), true));
        },
        markSynced(selected, lastSummary) {
            const at = now();
            return mutate((tasks, ticketSync) => selected.map(task => {
                const idx = tasks.findIndex(row => row.id === task.id && row.agentKey === task.agentKey);
                if (idx >= 0) return tasks[idx] = { ...tasks[idx], lastSummary, lastSyncAt: at, updatedAt: at };
                if (!task.id.startsWith('ticket:')) return undefined;
                ticketSync[task.id] = { lastSummary, lastSyncAt: at };
                return { ...task, ...ticketSync[task.id] };
            }).filter(Boolean));
        },
    };
}
