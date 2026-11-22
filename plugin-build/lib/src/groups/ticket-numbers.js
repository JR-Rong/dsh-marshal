import { readFileSync } from 'node:fs';
import { atomicWriteFile, withFileLock } from '../hub/state-file.js';

export function formatTicketNo(seq) {
    const n = Number.isInteger(seq) && seq > 0 ? seq : 1;
    return 'GD-' + String(n).padStart(5, '0');
}

export function withTicketPrefix(ticketNo, title) {
    const cleanTitle = String(title ?? '').trim();
    if (!ticketNo) return cleanTitle;
    const prefix = '[' + ticketNo + ']';
    if (cleanTitle.startsWith(prefix)) return cleanTitle;
    if (/^\[GD-\d{4,}\]\s*/.test(cleanTitle)) return cleanTitle;
    return cleanTitle ? prefix + ' ' + cleanTitle : prefix;
}

function loadState(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const map = parsed && typeof parsed.map === 'object' && parsed.map !== null ? { ...parsed.map } : {};
        let nextSeq = Number.isInteger(parsed?.nextSeq) && parsed.nextSeq > 0 ? parsed.nextSeq : 1;
        for (const val of Object.values(map)) {
            const match = /^GD-(\d+)$/.exec(String(val));
            if (match) nextSeq = Math.max(nextSeq, Number(match[1]) + 1);
        }
        return { version: 1, nextSeq, map };
    }
    catch {
        return { version: 1, nextSeq: 1, map: {} };
    }
}

export function createTicketNumbers(file) {
    const save = state => {
        atomicWriteFile(file, JSON.stringify(state, null, 2) + '\n');
    };
    const get = taskId => {
        if (typeof taskId !== 'string' || taskId === '') return undefined;
        return loadState(file).map[taskId];
    };
    const ensure = taskId => {
        if (typeof taskId !== 'string' || taskId === '') return undefined;
        const quick = loadState(file).map[taskId];
        if (quick) return quick;
        return withFileLock(file, () => {
            const state = loadState(file);
            if (state.map[taskId]) return state.map[taskId];
            const no = formatTicketNo(state.nextSeq);
            state.nextSeq += 1;
            state.map[taskId] = no;
            save(state);
            return no;
        });
    };
    const ensureAll = tasks => {
        if (!Array.isArray(tasks) || tasks.length === 0) return {};
        const current = loadState(file);
        const missing = tasks.filter(t => t && typeof t.id === 'string' && t.id && !current.map[t.id]);
        if (missing.length === 0) return current.map;
        return withFileLock(file, () => {
            const state = loadState(file);
            const sorted = [...missing].sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
            let changed = false;
            for (const task of sorted) {
                if (!state.map[task.id]) {
                    state.map[task.id] = formatTicketNo(state.nextSeq);
                    state.nextSeq += 1;
                    changed = true;
                }
            }
            if (changed) save(state);
            return state.map;
        });
    };
    const list = () => loadState(file).map;
    return { get, ensure, ensureAll, list, withTicketPrefix };
}
