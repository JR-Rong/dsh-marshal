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
            const tags = Array.isArray(input.tags) ? input.tags.filter(t => t && typeof t.name === 'string' && t.name.trim() !== '').map(t => ({ name: t.name.trim(), ...(typeof t.promptPrefix === 'string' && t.promptPrefix.trim() !== '' ? { promptPrefix: t.promptPrefix.trim() } : {}) })) : undefined;
            const parentId = typeof input.parentId === 'string' && input.parentId.trim() !== '' ? input.parentId.trim() : undefined;
            const permission = ['read-only', 'workspace-write', 'danger-full-access'].includes(input.permission) ? input.permission : undefined;
            const model = typeof input.model === 'string' && input.model.trim() !== '' ? input.model.trim() : undefined;
            const reasoningEffort = typeof input.reasoningEffort === 'string' && input.reasoningEffort.trim() !== '' ? input.reasoningEffort.trim() : undefined;
            const reuseSession = typeof input.reuseSession === 'boolean' ? input.reuseSession : undefined;
            const attachments = Array.isArray(input.attachments) && input.attachments.length > 0 ? input.attachments : undefined;
            save([{ id: action.id ?? randomUUID(), title, description: typeof input.description === 'string' ? input.description : '', prompt: typeof input.prompt === 'string' ? input.prompt : title, status: 'todo', priority: 0, ...(parentId ? { parentId } : {}), ...(permission ? { permission } : {}), ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(reuseSession !== undefined ? { reuseSession } : {}), ...(attachments ? { attachments } : {}), ...(tags && tags.length > 0 ? { tags } : {}), executions: [], createdAt: at, updatedAt: at }, ...tasks]);
            return snapshot();
        }
        if (action?.kind === 'update' && action.patch && typeof action.patch === 'object') {
            const p = action.patch;
            save(tasks.map(task => {
                if (task.id !== action.taskId) return task;
                const next = { ...task, updatedAt: at };
                if (typeof p.title === 'string' && p.title.trim() !== '') next.title = p.title.trim();
                if (typeof p.description === 'string') next.description = p.description;
                if (typeof p.prompt === 'string') next.prompt = p.prompt;
                if (['read-only', 'workspace-write', 'danger-full-access'].includes(p.permission)) next.permission = p.permission;
                if (typeof p.model === 'string') { if (p.model.trim()) next.model = p.model.trim(); else delete next.model; }
                if (typeof p.reasoningEffort === 'string') { if (p.reasoningEffort.trim()) next.reasoningEffort = p.reasoningEffort.trim(); else delete next.reasoningEffort; }
                if (p.reuseSession === null) delete next.reuseSession;
                else if (typeof p.reuseSession === 'boolean') next.reuseSession = p.reuseSession;
                if (p.attachments === null) delete next.attachments;
                else if (Array.isArray(p.attachments)) next.attachments = p.attachments;
                if (p.freeze === null) delete next.freeze;
                else if (p.freeze && typeof p.freeze === 'object') next.freeze = p.freeze;
                if (p.tags === null) delete next.tags;
                else if (Array.isArray(p.tags)) next.tags = p.tags;
                return next;
            }));
            return snapshot();
        }
        if (action?.kind === 'set-parent') {
            const parentId = typeof action.parentId === 'string' && action.parentId.trim() !== '' && action.parentId !== action.taskId ? action.parentId.trim() : undefined;
            save(tasks.map(task => {
                if (task.id !== action.taskId) return task;
                const next = { ...task, updatedAt: at };
                if (parentId) next.parentId = parentId;
                else delete next.parentId;
                return next;
            }));
            return snapshot();
        }
        if (action?.kind === 'archive') {
            save(tasks.map(task => task.id === action.taskId && task.status !== 'running' ? { ...task, archivedAt: at, updatedAt: at } : task));
            return snapshot();
        }
        if (action?.kind === 'restore') {
            save(tasks.map(task => {
                if (task.id !== action.taskId) return task;
                const next = { ...task, updatedAt: at };
                delete next.archivedAt;
                return next;
            }));
            return snapshot();
        }
        if (action?.kind === 'settle') {
            save(tasks.map(task => task.id === action.taskId && task.status === 'running' ? { ...task, status: 'todo', updatedAt: at } : task));
            return snapshot();
        }
        if (action?.kind === 'confirm-permission') {
            save(tasks.map(task => task.id === action.taskId ? { ...task, permissionConfirmedAt: at, updatedAt: at } : task));
            return snapshot();
        }
        if (action?.kind === 'set-schedule' && action.patch && typeof action.patch === 'object') {
            save(tasks.map(task => task.id === action.taskId ? { ...task, schedule: { ...(task.schedule ?? {}), ...action.patch }, updatedAt: at } : task));
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
