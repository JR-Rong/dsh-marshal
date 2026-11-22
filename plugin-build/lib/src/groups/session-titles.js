import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, withFileLock } from '../hub/state-file.js';

export function isGenericSessionTitle(title) {
    const t = String(title ?? '').trim();
    if (!t) return true;
    if (/^marshal-agent(?:-task)?:/i.test(t)) return true;
    if (/的闲聊会话$/.test(t)) return true;
    if (/^(?:历史会话|新会话|未命名会话|untitled|new chat|new session)$/i.test(t)) return true;
    return false;
}

export function summarizeFirstMessage(rawText) {
    let text = String(rawText ?? '');
    if (!text.trim()) return '';
    // Strip runtime context or XML-like metadata tags
    text = text.replace(/<runtime_context>[\s\S]*?<\/runtime_context>/gi, ' ')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
        .replace(/<[^>]{1,60}>/g, ' ');
    // Extract explicit task title if superagent dispatch wrapper
    const taskTitleMatch = /(?:任务标题|工单标题|标题)[：:]\s*([^\n]{2,60})/.exec(text);
    if (taskTitleMatch) {
        text = taskTitleMatch[1];
    }
    else {
        // Strip dispatch / edict headers
        text = text.replace(/^\s*【[^】]{1,30}】\s*/g, '');
        if (/^智能体[：:]/.test(text.trim())) {
            const descMatch = /(?:任务描述|需求|请处理|目标)[：:]\s*([^\n]{2,80})/.exec(text);
            if (descMatch) text = descMatch[1];
        }
    }
    // Normalize lines and remove code fences / URLs noise
    text = text.replace(/```[\s\S]*?```/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[*#`>_~]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // Strip common conversational openers for concise headline
    text = text.replace(/^(?:请问|请你|请帮我|帮我|麻烦帮我|帮忙|我想让你|我想|你可以|能不能帮我|你好[，,！!\s]*)/, '').trim();
    if (!text) return '';
    // Take first clause/sentence if long
    const cut = text.split(/[。！？!?\n]/)[0].trim();
    const candidate = cut.length >= 6 ? cut : text;
    if (candidate.length <= 28) return candidate;
    return candidate.slice(0, 26).replace(/[，,、；;：:\s]+$/, '') + '…';
}

export function readProjcacheSession(sessionId, dshHome = join(homedir(), '.dsh')) {
    if (typeof sessionId !== 'string' || !sessionId) return undefined;
    const dir = join(dshHome, 'storages', 'session_projcache', 'sessions');
    const clean = sessionId.replace(/^session-/, '');
    for (const name of [clean, sessionId, 'session-' + clean]) {
        const fp = join(dir, name + '.json');
        if (!existsSync(fp)) continue;
        try {
            const parsed = JSON.parse(readFileSync(fp, 'utf8'));
            const rec = parsed?.record ?? parsed;
            const title = typeof rec?.rows?.title?.val === 'string' ? rec.rows.title.val.trim() : '';
            const firstText = typeof rec?.rows?.titleInput?.val?.first?.text === 'string'
                ? rec.rows.titleInput.val.first.text : '';
            const createdAt = typeof rec?.identity?.createdAt === 'number' ? rec.identity.createdAt : undefined;
            const cwd = typeof rec?.identity?.cwd === 'string' ? rec.identity.cwd : undefined;
            return { title, firstText, createdAt, cwd };
        }
        catch { /* unreadable projcache */ }
    }
    return undefined;
}

export function readWorkspaceRegistry(dshHome = join(homedir(), '.dsh')) {
    const fp = join(dshHome, 'storages', 'workspace.json');
    try {
        const parsed = JSON.parse(readFileSync(fp, 'utf8'));
        const tables = parsed?.tables?.workspaces ?? {};
        const archived = new Set(Array.isArray(parsed?.global?.archivedSessionIds) ? parsed.global.archivedSessionIds : []);
        const workspaces = [];
        for (const [id, info] of Object.entries(tables)) {
            if (!info || typeof info !== 'object') continue;
            workspaces.push({
                id,
                title: typeof info.title === 'string' ? info.title : '',
                path: typeof info.path === 'string' ? info.path : '',
                sessionIds: Array.isArray(info.sessionIds) ? info.sessionIds.filter(s => typeof s === 'string' && s) : [],
                updatedAt: info.updatedAt ? Date.parse(info.updatedAt) || 0 : 0,
            });
        }
        return { workspaces, archived };
    }
    catch {
        return { workspaces: [], archived: new Set() };
    }
}

function loadTitles(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed && typeof parsed.titles === 'object' && parsed.titles !== null) {
            return { version: 1, titles: { ...parsed.titles } };
        }
    }
    catch { /* empty */ }
    return { version: 1, titles: {} };
}

export function createSessionTitles(file) {
    const save = state => atomicWriteFile(file, JSON.stringify(state, null, 2) + '\n');
    const get = sessionId => loadTitles(file).titles[sessionId];
    const list = () => loadTitles(file).titles;
    const setCustom = (sessionId, title) => {
        if (typeof sessionId !== 'string' || !sessionId) throw new Error('invalid-session');
        const clean = String(title ?? '').trim().slice(0, 120);
        return withFileLock(file, () => {
            const state = loadTitles(file);
            const cur = state.titles[sessionId] ?? {};
            if (clean === '') {
                delete cur.custom;
                if (!cur.auto) delete state.titles[sessionId];
                else state.titles[sessionId] = { ...cur, updatedAt: Date.now() };
            }
            else {
                state.titles[sessionId] = { ...cur, custom: clean, updatedAt: Date.now() };
            }
            save(state);
            return state.titles[sessionId] ?? {};
        });
    };
    const setAuto = (sessionId, title) => {
        if (typeof sessionId !== 'string' || !sessionId) return undefined;
        const clean = String(title ?? '').trim().slice(0, 120);
        if (!clean) return undefined;
        return withFileLock(file, () => {
            const state = loadTitles(file);
            const cur = state.titles[sessionId] ?? {};
            state.titles[sessionId] = { ...cur, auto: clean, updatedAt: Date.now() };
            save(state);
            return state.titles[sessionId];
        });
    };
    const resolve = ({ sessionId, dshTitle, firstText, agentName, fallbackTitle, createdAt }) => {
        const saved = get(sessionId);
        if (saved?.custom) return { title: saved.custom, titleSource: 'custom' };
        if (dshTitle && !isGenericSessionTitle(dshTitle)) return { title: dshTitle.trim(), titleSource: 'dsh' };
        if (saved?.auto && !isGenericSessionTitle(saved.auto)) return { title: saved.auto, titleSource: 'auto' };
        const summarized = summarizeFirstMessage(firstText);
        if (summarized) {
            try { setAuto(sessionId, summarized); } catch { /* best-effort cache */ }
            return { title: summarized, titleSource: 'auto' };
        }
        if (fallbackTitle && !isGenericSessionTitle(fallbackTitle)) return { title: fallbackTitle, titleSource: 'dsh' };
        const stamp = createdAt ? new Date(createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '';
        return {
            title: (agentName ? agentName + ' · 闲聊' : '未命名会话') + (stamp ? ' (' + stamp + ')' : ''),
            titleSource: 'fallback',
        };
    };
    return { get, list, setCustom, setAuto, resolve };
}
