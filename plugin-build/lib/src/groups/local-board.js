import { readFileSync } from 'node:fs';
import { atomicWriteFile } from '../hub/state-file.js';
import { randomUUID } from 'node:crypto';

/** Small file-backed board used when the host has no task-board service. */
export function createLocalBoard(file) {
    let tasks = [];
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed?.tasks)) tasks = parsed.tasks;
    }
    catch { /* first run */ }
    const save = next => {
        atomicWriteFile(file, JSON.stringify({ version: 1, tasks: next }, null, 2) + '\n');
        tasks = next;
    };
    const snapshot = () => ({ tasks: tasks.map(task => ({ ...task, executions: Array.isArray(task.executions) ? task.executions : [] })), sessionDefaultPermission: 'workspace-write' });
    const apply = async (requestId, action) => {
        const at = Date.now();
        if (action?.kind === 'create') {
            const input = action.input ?? {};
            const title = typeof input.title === 'string' ? input.title.trim() : '';
            if (title === '') throw new Error('title is required');
            save([{ id: action.id ?? randomUUID(), title, description: typeof input.description === 'string' ? input.description : '', prompt: typeof input.prompt === 'string' ? input.prompt : title, status: 'todo', priority: 0, executions: [], createdAt: at, updatedAt: at }, ...tasks]);
            return snapshot();
        }
        if (action?.kind === 'delete') {
            save(tasks.filter(task => task.id !== action.taskId));
            return snapshot();
        }
        if (action?.kind === 'run') {
            save(tasks.map(task => task.id === action.taskId ? { ...task, status: 'running', updatedAt: at } : task));
            return snapshot();
        }
        if (action?.kind === 'move' && ['backlog', 'todo', 'running', 'review', 'done', 'failed'].includes(action.status)) {
            save(tasks.map(task => task.id === action.taskId ? { ...task, status: action.status, updatedAt: at } : task));
            return snapshot();
        }
        return snapshot();
    };
    return { snapshot, apply, file };
}
