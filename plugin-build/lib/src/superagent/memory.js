/**
 * The bridge's only window into dsh-marshal's long-term memory.
 *
 * A board execution session is not a dsh-agents member run, so the memory
 * service cannot infer the member from the session. The bridge therefore reads
 * the member's agent scope before dispatch and writes an explicit episode after
 * settlement. Every method is best-effort: memory is valuable, but it must not
 * decide whether a card runs.
 */

const MAX_INJECT_CHARS = 2400;
const MAX_EPISODE_CHARS = 4000;

function clip(text, limit) {
    if (typeof text !== 'string') return '';
    const value = text.trim();
    if (value.length <= limit) return value;
    return value.slice(0, Math.max(0, limit - 24)).trimEnd() + ' …（截断）';
}

function itemLine(item) {
    const title = typeof item?.title === 'string' ? item.title.trim() : '';
    const content = typeof item?.content === 'string' ? item.content : '';
    const kind = typeof item?.kind === 'string' ? item.kind : 'note';
    return (title === '' ? '（无标题）' : title) + '（' + kind + '）：' + clip(content, 320);
}

function sharedCardSafe(item, scope, workspaceId) {
    if (item === null || typeof item !== 'object') return false;
    if (scope === 'agent') {
        const visibility = item.visibility;
        if (visibility === 'private' || visibility === 'never-group' || visibility === 'no-group') return false;
        if (typeof item.allowedWorkspaceId === 'string' && item.allowedWorkspaceId !== '' && item.allowedWorkspaceId !== workspaceId) return false;
    }
    return true;
}

async function itemsOf(service, query) {
    if (service === undefined || service === null) return undefined;
    if (typeof service.listFor === 'function') {
        try {
            return await service.listFor({
                ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
                ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
                scope: query.scope,
                limit: query.limit,
                ...(query.text === undefined || query.text === '' ? {} : { query: query.text }),
                group: true,
                includeGlobal: false,
            });
        }
        catch {
            // fall through to the store face
        }
    }
    try {
        const scopes = [];
        if (query.scope !== 'workspace' && typeof query.agentId === 'string' && query.agentId !== '') scopes.push({ scope: 'agent', ownerId: query.agentId });
        if (query.scope !== 'agent' && typeof query.workspaceId === 'string' && query.workspaceId !== '') scopes.push({ scope: 'workspace', ownerId: query.workspaceId });
        if (typeof service.store?.recall === 'function') {
            if (query.text !== undefined && query.text !== '') return service.store.recall(scopes, query.text, { k: query.limit });
            const listed = [];
            for (const target of scopes) listed.push(...(service.store.list?.(target.scope, target.ownerId, { limit: query.limit }) ?? []));
            return listed;
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}

export function createMemoryBridge(service, options = {}) {
    const logger = options.logger ?? { warn: () => {} };
    const available = service !== undefined && service !== null;
    const rememberFor = typeof service?.rememberFor === 'function' ? service.rememberFor.bind(service) : undefined;

    const recall = async ({ agentId, workspaceId, text, limit = 6 }) => {
        if (!available || limit <= 0) return { text: '', count: 0, error: undefined };
        const [agentResult, workspaceResult] = await Promise.all([
            itemsOf(service, { scope: 'agent', agentId, workspaceId, limit, text }),
            itemsOf(service, { scope: 'workspace', workspaceId, limit: Math.max(1, Math.min(3, limit - 1)), text }),
        ]);
        if (agentResult === undefined && workspaceResult === undefined) {
            return { text: '', count: 0, error: 'memory-recall-failed' };
        }
        const agentItems = (agentResult ?? []).filter(item => sharedCardSafe(item, 'agent', workspaceId));
        const workspaceItems = (workspaceResult ?? []).filter(item => sharedCardSafe(item, 'workspace', workspaceId));
        const seen = new Set();
        const lines = [];
        for (const [scope, items] of [['agent', agentItems], ['workspace', workspaceItems]]) {
            for (const item of items) {
                const key = (item?.scope ?? scope) + ':' + (item?.id ?? '') + ':' + (item?.title ?? '');
                if (seen.has(key)) continue;
                seen.add(key);
                lines.push('- [' + scope + '] ' + itemLine(item));
                if (lines.length >= limit) break;
            }
            if (lines.length >= limit) break;
        }
        if (lines.length === 0) return { text: '', count: 0, error: undefined };
        return { text: clip(lines.join('\n'), MAX_INJECT_CHARS), count: lines.length, error: undefined };
    };

    const rememberEpisode = async ({ agentId, workspaceId, title, text, tags, importance = 0.7 }) => {
        if (!available) return { ok: false, error: 'memory-unavailable' };
        if (rememberFor === undefined) return { ok: false, error: 'memory-store-unavailable' };
        if (typeof agentId !== 'string' || agentId === '') return { ok: false, error: 'agent-id-missing' };
        try {
            const item = await rememberFor({
                agentId,
                ...(typeof workspaceId === 'string' && workspaceId !== '' ? { workspaceId } : {}),
                scope: 'agent',
                title: clip(title, 120),
                text: clip(text, MAX_EPISODE_CHARS),
                kind: 'episode',
                importance: Math.min(1, Math.max(0, importance)),
                tags: Array.isArray(tags) ? tags.slice(0, 8) : [],
            });
            if (item === undefined || item === null) return { ok: false, error: 'memory-write-refused' };
            return { ok: true, item };
        }
        catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            logger.warn?.('marshal-superagent: memory write failed: ' + message);
            return { ok: false, error: message };
        }
    };

    const digest = ({ task, execution, agentName, outcome }) => {
        const title = typeof task?.title === 'string' ? task.title : '(untitled)';
        const id = typeof task?.id === 'string' ? task.id : '';
        const summary = typeof execution?.summary?.text === 'string' ? execution.summary.text : '';
        const error = typeof execution?.error === 'string' ? execution.error : '';
        const result = typeof outcome === 'string' ? outcome : (execution?.result ?? 'unknown');
        const lines = [
            '工单「' + title + '」(' + id + ') 由智能体 ' + (agentName ?? 'unknown') + ' 执行。',
            '结果：' + result + (error === '' ? '' : '；错误：' + error),
        ];
        if (summary !== '') lines.push('工作摘要：' + clip(summary, 2600));
        else lines.push('工作摘要：（执行会话未留下可读的助手结论）');
        if (typeof execution?.sessionId === 'string' && execution.sessionId !== '') lines.push('执行会话：' + execution.sessionId);
        // The card description is operator/agent-authored text; the episode keeps
        // the execution's own conclusion so a forged card cannot smuggle arbitrary
        // text into the member's long-term memory through this field.
        return clip(lines.join('\n'), MAX_EPISODE_CHARS);
    };

    return { available, recall, rememberEpisode, digest };
}
