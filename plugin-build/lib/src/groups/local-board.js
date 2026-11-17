import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Small file-backed board used when the host has no task-board service. */
export function createLocalBoard(file) {
    let tasks = [];
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed?.tasks)) tasks = parsed.tasks;
    }
    catch { /* first run */ }
    const save = () => {
        try {
            mkdirSync(dirname(file), { recursive: true });
            const temp = file + '.tmp-' + randomUUID();
            writeFileSync(temp, JSON.stringify({ version: 1, tasks }, null, 2) + '\n');
            renameSync(temp, file);
        }
        catch { /* the board stays in memory */ }
    };
    const snapshot = () => ({ tasks: tasks.map(task => ({ ...task, executions: Array.isArray(task.executions) ? task.executions : [] })), sessionDefaultPermission: 'workspace-write' });
    const apply = async (requestId, action) => {
        const at = Date.now();
        if (action?.kind === 'create') {
            const input = action.input ?? {};
            const title = typeof input.title === 'string' ? input.title.trim() : '';
            if (title === '') throw new Error('title is required');
            tasks = [{ id: action.id ?? randomUUID(), title, description: typeof input.description === 'string' ? input.description : '', prompt: typeof input.prompt === 'string' ? input.prompt : title, status: 'todo', priority: 0, executions: [], createdAt: at, updatedAt: at }, ...tasks];
            save();
            return snapshot();
        }
        if (action?.kind === 'delete') {
            tasks = tasks.filter(task => task.id !== action.taskId);
            save();
            return snapshot();
        }
        if (action?.kind === 'run') {
            tasks = tasks.map(task => task.id === action.taskId ? { ...task, status: 'running', updatedAt: at } : task);
            save();
            return snapshot();
        }
        return snapshot();
    };
    return { snapshot, apply, file };
}
