import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { MemoryStore } from './sqlite-store.js';
import { specToJsonSchema } from '../tools/schema.js';
import { createMemorySyncClient } from './sync-client.js';

const AGENT_PREFIX = 'Agent · ';
const MAX_BLOCK = 5200;

const DEFAULT_SETTINGS = { autoSummary: true, autoRecall: true, allowGroupQuote: false, summaryModel: '', dailyTokenCap: 50000 };

function readSettings(root) {
    try {
        const parsed = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
        return { ...DEFAULT_SETTINGS, ...(parsed !== null && typeof parsed === 'object' ? parsed : {}) };
    }
    catch { return { ...DEFAULT_SETTINGS }; }
}

function ledgerPath() {
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-agents', 'ledger.json');
}

function readLedger() {
    try {
        const parsed = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
        return parsed !== null && typeof parsed === 'object' ? parsed : { teams: [], runs: [] };
    }
    catch { return { teams: [], runs: [] }; }
}

function findMember(teams, name) {
    for (const team of Array.isArray(teams) ? teams : []) {
        for (const member of Array.isArray(team?.members) ? team.members : []) {
            if (member?.name === name) return { team, member };
        }
    }
    return undefined;
}

function workspaceKey(cwd) {
    return 'ws_' + createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 24);
}

export function resolveMemoryIdentity(context, options = {}) {
    const session = context?.agent?.session ?? context?.session;
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
    const sessionId = typeof session?.id === 'string' ? session.id : undefined;
    const ledger = options.ledger ?? readLedger();
    const run = Array.isArray(ledger.runs) ? ledger.runs.find(entry => entry?.sessionId === sessionId) : undefined;
    let team = run === undefined ? undefined : (ledger.teams ?? []).find(entry => entry?.id === run.teamId);
    let member = team === undefined ? undefined : (team.members ?? []).find(entry => entry?.id === run.memberId);
    let name = member?.name;
    if (member === undefined && cwd !== '') {
        const root = resolve(options.agentsRoot ?? join(homedir(), '.dsh-marshal', 'agents'));
        const absolute = resolve(cwd);
        if (absolute === root || absolute.startsWith(root + sep)) {
            const folder = absolute.slice(root.length).replace(/^[/\\]+/, '').split(/[/\\]/)[0];
            if (folder.startsWith(AGENT_PREFIX)) name = folder.slice(AGENT_PREFIX.length).trim();
            if (name !== undefined) {
                const found = findMember(ledger.teams, name);
                if (found !== undefined) { team = found.team; member = found.member; }
            }
        }
    }
    const agentId = member?.id ?? (name === undefined ? undefined : 'legacy:' + name);
    const workspaceId = team?.workspaceId ?? (cwd === '' ? undefined : workspaceKey(cwd));
    return {
        agentId,
        agentName: name,
        workspaceId,
        workspacePath: cwd === '' ? undefined : cwd,
        sessionId,
        session,
        deviceId: options.deviceId,
    };
}

function scopeList(identity, requested = 'all') {
    const scopes = [];
    if (requested === 'all' || requested === 'agent') {
        if (identity.agentId !== undefined) scopes.push({ scope: 'agent', ownerId: identity.agentId });
    }
    if (requested === 'all' || requested === 'workspace') {
        if (identity.workspaceId !== undefined) scopes.push({ scope: 'workspace', ownerId: identity.workspaceId });
    }
    if (requested === 'all' || requested === 'global') scopes.push({ scope: 'global', ownerId: 'global' });
    return scopes;
}

function textOfContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

function sessionEvents(session) {
    try {
        const events = session?.events;
        return Array.isArray(events) ? events : [];
    }
    catch { return []; }
}

function recentDialog(session) {
    const messages = [];
    for (const event of sessionEvents(session)) {
        if (event?.type === 'user/message') messages.push({ role: 'user', text: textOfContent(event.data?.content) });
        else if (event?.type === 'assistant/message') messages.push({ role: 'assistant', text: textOfContent(event.data?.message?.content) });
    }
    return messages.filter(message => message.text.trim() !== '').slice(-16);
}

function heuristicSummary(session) {
    const dialog = recentDialog(session);
    if (dialog.length === 0) return undefined;
    const user = [...dialog].reverse().find(message => message.role === 'user');
    const assistant = [...dialog].reverse().find(message => message.role === 'assistant');
    const content = [
        user === undefined ? '' : '用户目标：' + user.text.slice(0, 1200),
        assistant === undefined ? '' : '结论：' + assistant.text.slice(0, 2200),
    ].filter(Boolean).join('\n\n');
    return {
        kind: 'episode',
        title: '会话摘要 ' + new Date().toISOString().slice(0, 10),
        content,
        importance: 0.45,
        tags: ['session-summary'],
    };
}

function formatItem(item) {
    return '[' + item.scope + '] ' + item.title + ' (' + item.kind + ', ' + (item.importance * 100).toFixed(0) + '%)' + (item.pinned ? ' 📌' : '') + '\n' + item.content;
}

function memoryBlock(service, identity) {
    const scopes = scopeList(identity);
    const lines = [];
    const agentItems = identity.agentId === undefined ? [] : service.store.list('agent', identity.agentId, { limit: 24 });
    const workspaceItems = identity.workspaceId === undefined ? [] : service.store.list('workspace', identity.workspaceId, { limit: 16 });
    const globalItems = service.store.list('global', 'global', { limit: 8 });
    const stable = item => item.kind === 'profile' || item.kind === 'handoff';
    for (const item of agentItems.filter(stable)) lines.push('【Agent】' + item.title + '：' + item.content);
    for (const item of workspaceItems.filter(stable)) lines.push('【Workspace】' + item.title + '：' + item.content);
    for (const item of globalItems.filter(stable)) lines.push('【Global】' + item.title + '：' + item.content);
    for (const item of agentItems.filter(item => !stable(item)).slice(0, 8)) lines.push('【Agent 相关】' + item.title + '：' + item.content);
    for (const item of workspaceItems.filter(item => !stable(item)).slice(0, 6)) lines.push('【Workspace 相关】' + item.title + '：' + item.content);
    const lastUser = recentDialog(identity.session).filter(message => message.role === 'user').at(-1);
    if (lastUser !== undefined && lastUser.text.trim() !== '') {
        for (const item of (service.settings.autoRecall === false ? [] : service.store.recall(scopes, lastUser.text, { k: 6 }))) {
            if (stable(item)) continue;
            lines.push('【召回·' + item.scope + '】' + item.title + '：' + item.content);
        }
    }
    if (lines.length === 0) return '';
    const policy = service.settings.allowGroupQuote === true
        ? '以下记忆可用于理解和回答。'
        : '以下记忆用于理解上下文；标注 private 的内容不要原文引用到群聊。';
    return '【Agent 记忆】' + policy + '\n' + lines.join('\n').slice(0, MAX_BLOCK);
}

function agentMemoryTool(service) {
    return {
        name: 'agent_memory',
        description: 'Agent 私有/工作区/全局长期记忆。会话开始自动注入；需要细节时 recall；用户说记住时 remember；结束前 handoff。',
        parameters: {
            action: { type: 'string', required: true, enum: ['status', 'remember', 'recall', 'forget', 'list', 'handoff', 'summarize', 'graph'] },
            scope: { type: 'string', enum: ['all', 'agent', 'workspace', 'global'] },
            query: { type: 'string' },
            title: { type: 'string' },
            text: { type: 'string' },
            kind: { type: 'string', enum: ['profile', 'fact', 'decision', 'episode', 'handoff', 'scene'] },
            importance: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
            visibility: { type: 'string', enum: ['private', 'group-safe', 'never-group'] },
            id: { type: 'string' },
            limit: { type: 'integer' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' },
                    items: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    graph: { type: 'object', additionalProperties: true },
                    memory: { type: 'object', additionalProperties: true },
                },
                required: ['ok', 'action', 'text'],
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
            const identity = resolveMemoryIdentity(exec?.agent, { deviceId: service.deviceId });
            const scopes = scopeList(identity, args.scope ?? 'all');
            const action = args.action;
            if (action === 'status') {
                const stats = service.store.stats(scopes);
                const text = stats.map(stat => stat.scope + ' ' + stat.ownerId + '：' + stat.total + ' 条，置顶 ' + stat.pinned).join('\n') || '当前会话没有可用的记忆作用域';
                return { ok: true, action, text, items: stats };
            }
            if (action === 'remember' || action === 'handoff') {
                const target = scopes.find(scope => scope.scope === (args.scope === 'all' ? 'agent' : args.scope)) ?? scopes[0];
                if (target === undefined) throw new Error('no memory scope for this session');
                const kind = action === 'handoff' ? 'handoff' : (args.kind ?? 'fact');
                const title = String((args.title ?? (kind === 'handoff' ? '交接 ' + new Date().toISOString().slice(0, 16) : args.text ?? '')).slice(0, 120));
                const memory = service.store.remember(target.scope, target.ownerId, {
                    kind, title, content: args.text ?? '', importance: kind === 'handoff' ? 0.9 : args.importance,
                    tags: args.tags ?? [], visibility: args.visibility ?? 'private',
                }, { sessionId: identity.sessionId, deviceId: identity.deviceId });
                return { ok: true, action, text: '已记住：' + memory.title, memory };
            }
            if (action === 'recall') {
                const items = service.store.recall(scopes, String(args.query ?? ''), { k: args.limit ?? 8 });
                return { ok: true, action, items, text: items.length === 0 ? '没有找到相关记忆' : items.map(item => formatItem(item)).join('\n\n') };
            }
            if (action === 'list') {
                const items = [];
                for (const target of scopes) items.push(...service.store.list(target.scope, target.ownerId, { limit: args.limit ?? 30, kinds: args.kind === undefined ? undefined : [args.kind] }));
                return { ok: true, action, items, text: items.length === 0 ? '记忆为空' : items.map(item => formatItem(item)).join('\n\n') };
            }
            if (action === 'forget') {
                if (typeof args.id !== 'string' || args.id === '') throw new Error('forget needs id');
                let removed = false;
                for (const target of scopes) removed = service.store.forget(target.scope, target.ownerId, args.id) || removed;
                return { ok: true, action, text: removed ? '已删除记忆' : '没有找到这条记忆' };
            }
            if (action === 'summarize') {
                const summary = heuristicSummary(exec?.agent?.session);
                if (summary === undefined) return { ok: true, action, text: '当前会话没有可摘要的对话' };
                const target = scopes.find(scope => scope.scope === 'agent') ?? scopes[0];
                if (target === undefined) throw new Error('no memory scope for this session');
                const memory = service.store.remember(target.scope, target.ownerId, summary, { sessionId: identity.sessionId, deviceId: identity.deviceId });
                return { ok: true, action, text: '已写入会话摘要：' + memory.title, memory };
            }
            if (action === 'graph') {
                const graph = service.store.graph(scopes, { limit: args.limit ?? 400 });
                return { ok: true, action, graph, text: '记忆图：' + graph.nodes.length + ' 个节点，' + graph.edges.length + ' 条边' };
            }
            throw new Error('unknown memory action');
        },
    };
}

export function createAgentMemoryService({ root, logger, deviceId, hubUrl, token, passphrase, now = Date.now } = {}) {
    const store = new MemoryStore({ root, logger, now });
    const sync = createMemorySyncClient({ hubUrl, token, passphrase, deviceId });
    const service = { store, deviceId, now, sync, settings: readSettings(store.root) };
    service.saveSettings = patch => {
        service.settings = { ...service.settings, ...(patch !== null && typeof patch === 'object' ? patch : {}) };
        writeFileSync(join(store.root, 'settings.json'), JSON.stringify(service.settings, null, 2) + '\n');
        return service.settings;
    };
    service.identity = context => resolveMemoryIdentity(context, { deviceId });
    service.scopes = (identity, scope = 'all') => scopeList(identity, scope);
    service.block = identity => memoryBlock(service, identity);
    service.graphFor = ({ agentId, workspaceId, limit = 400 }) => {
        const scopes = [];
        if (typeof agentId === 'string' && agentId !== '') scopes.push({ scope: 'agent', ownerId: agentId });
        if (typeof workspaceId === 'string' && workspaceId !== '') scopes.push({ scope: 'workspace', ownerId: workspaceId });
        scopes.push({ scope: 'global', ownerId: 'global' });
        return store.graph(scopes, { limit });
    };
    service.listFor = ({ agentId, workspaceId, limit = 100, query, scope = 'all' }) => {
        const scopes = [];
        if ((scope === 'all' || scope === 'agent') && agentId) scopes.push({ scope: 'agent', ownerId: agentId });
        if ((scope === 'all' || scope === 'workspace') && workspaceId) scopes.push({ scope: 'workspace', ownerId: workspaceId });
        if (scope === 'all' || scope === 'global') scopes.push({ scope: 'global', ownerId: 'global' });
        if (query) return store.recall(scopes, query, { k: limit });
        return scopes.flatMap(target => store.list(target.scope, target.ownerId, { limit }));
    };
    service.rememberFor = ({ agentId, workspaceId, scope, title, text, kind, importance, tags, visibility }) => {
        const target = scope === 'workspace' ? { scope: 'workspace', ownerId: workspaceId } : { scope: 'agent', ownerId: agentId };
        if (target.ownerId === undefined) throw new Error('memory owner is missing');
        return store.remember(target.scope, target.ownerId, { kind, title, content: text, importance, tags, visibility });
    };
    service.syncFor = async ({ agentId, workspaceId }) => {
        if (sync === undefined) throw new Error('memory sync is not configured');
        const scopes = [];
        if (agentId) scopes.push({ scope: 'agent', ownerId: agentId });
        if (workspaceId) scopes.push({ scope: 'workspace', ownerId: workspaceId });
        return sync.sync(store, scopes);
    };
    service.forgetFor = ({ agentId, workspaceId, id }) => {
        const scopes = [];
        if (agentId) scopes.push({ scope: 'agent', ownerId: agentId });
        if (workspaceId) scopes.push({ scope: 'workspace', ownerId: workspaceId });
        return scopes.some(target => store.forget(target.scope, target.ownerId, id));
    };
    return service;
}

export function mountAgentMemory(ctx, config, options = {}) {
    const service = createAgentMemoryService({ root: config.memoryRoot, logger: options.logger ?? ctx.logger, deviceId: config.deviceId, hubUrl: config.hubUrl, token: config.token, passphrase: process.env.DSH_MARSHAL_MEMORY_SYNC_KEY });
    ctx.inject(['systemPrompt'], scoped => {
        scoped.effect(() => scoped.systemPrompt.section({
            name: 'marshal:agent-memory',
            order: 5,
            text: context => service.block(resolveMemoryIdentity(context, { deviceId: config.deviceId })),
        }), 'marshal: agent memory prompt');
    });
    ctx.inject(['tools'], scoped => {
        scoped.effect(() => {
            const definition = agentMemoryTool(service);
            definition.parameters = specToJsonSchema(definition.parameters);
            return scoped.tools.register(definition);
        }, 'marshal: agent memory tool');
    });
    // Heuristic session-end capture. It is deliberately local and cheap; an LLM
    // summary can replace this hook later without changing the store.
    const timers = new Map();
    try {
        ctx.effect(() => {
            const off = ctx.on?.('session/event', (session, event) => {
                if (event?.type !== 'turn/end' || service.settings.autoSummary === false) return;
                const id = session?.id;
                if (typeof id !== 'string') return;
                const old = timers.get(id);
                if (old !== undefined) clearTimeout(old);
                const timer = setTimeout(() => {
                    timers.delete(id);
                    try {
                        const identity = resolveMemoryIdentity({ session }, { deviceId: config.deviceId });
                        if (identity.agentId === undefined) return;
                        const summary = heuristicSummary(session);
                        if (summary === undefined) return;
                        service.store.remember('agent', identity.agentId, summary, { sessionId: identity.sessionId, deviceId: config.deviceId });
                    }
                    catch (error) { (options.logger ?? ctx.logger)?.warn?.('marshal memory: session summary failed: ' + (error?.message ?? error)); }
                }, 60_000);
                timers.set(id, timer);
            });
            return () => { if (typeof off === 'function') off(); for (const timer of timers.values()) clearTimeout(timer); timers.clear(); };
        }, 'marshal: agent memory session capture');
    }
    catch (error) { (options.logger ?? ctx.logger)?.warn?.('marshal memory: session capture unavailable: ' + (error?.message ?? error)); }
    return service;
}
