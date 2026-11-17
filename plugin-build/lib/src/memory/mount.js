import { join } from 'node:path';
import { homedir } from 'node:os';
import { MemoryStore } from './store.js';
import { specToJsonSchema } from '../tools/schema.js';

/**
 * 记忆服务的工具面：status / read / write / handoff / check / list / promote。
 * 两级：global（跨工作区、短）+ workspace（每个工作区一份 handoff/notes）。
 */
export function createMemoryService({ root, logger, now = Date.now } = {}) {
    const dir = root ?? join(homedir(), '.dsh-marshal', 'memory');
    const store = new MemoryStore(dir, now);
    const log = logger ?? { info: () => { } };
    store.ensure();
    log.info?.(`marshal-memory: store at ${dir}`);

    const needCwd = cwd => {
        if (typeof cwd !== 'string' || cwd.trim() === '')
            throw new Error('marshal-memory: invalid-args: workspace operations need the session working directory');
        return cwd;
    };

    const handle = (action, args = {}, context = {}) => {
        const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : context.cwd;
        const by = context.identity;
        switch (action) {
            case 'status': {
                const status = store.status({ cwd: cwd === undefined ? undefined : needCwd(cwd) });
                return { ok: true, action, memory: status, text: formatStatus(status) };
            }
            case 'read': {
                const scope = args.scope ?? 'workspace';
                const file = args.file ?? (scope === 'global' ? 'rules' : 'handoff');
                const record = store.read({ scope, file, cwd: scope === 'workspace' ? needCwd(cwd) : undefined });
                const limit = Math.max(200, Math.min(Number(args.limit) || 4000, 20_000));
                const clipped = record.text.length > limit;
                return {
                    ok: true, action, memory: { ...record, text: undefined, clipped },
                    text: record.text.slice(0, limit) + (clipped ? `\n…（已截断，共 ${record.text.length} 字符）` : ''),
                };
            }
            case 'write': {
                const result = store.write({
                    scope: args.scope ?? 'workspace',
                    file: args.file ?? 'notes',
                    cwd: (args.scope ?? 'workspace') === 'global' ? undefined : needCwd(cwd),
                    content: args.content,
                    by,
                });
                return { ok: true, action, memory: result, text: `已记入 ${result.path}（${result.bytes} B）${result.warning === null || result.warning === undefined ? '' : ` ⚠ ${result.warning}`}` };
            }
            case 'handoff': {
                const result = store.handoff({
                    cwd: needCwd(cwd),
                    last: args.note ?? args.last,
                    projects: args.projects ?? [],
                    next: args.next,
                    blockers: args.blockers ?? '无',
                    by,
                });
                return { ok: true, action, memory: result, text: `交接已写 ${result.path}（${result.bytes} B）${result.archived ? '，旧版已归档' : ''}` };
            }
            case 'check': {
                const result = store.check({ cwd: needCwd(cwd) });
                return { ok: true, action, memory: result, text: result.ok ? '记忆体检通过' : `记忆体检 ${result.issues.length} 个问题：\n- ${result.issues.join('\n- ')}` };
            }
            case 'list': {
                const items = store.list(args.limit ?? 20);
                return {
                    ok: true, action, memory: { workspaces: items },
                    text: items.length === 0 ? '还没有登记工作区' : items.map(item => `${item.slug}  ${item.path}  ${item.lastActive ?? '—'}`).join('\n'),
                };
            }
            case 'promote': {
                if (typeof args.content !== 'string' || args.content.trim() === '')
                    throw new Error('marshal-memory: invalid-args: promote needs content');
                const result = store.promote({ cwd, content: args.content, by });
                return { ok: true, action, memory: result, text: `已沉淀到全局 profile` };
            }
            default:
                throw new Error(`marshal-memory: invalid-args: unknown action ${action}`);
        }
    };

    return { store, handle, dir };
}

function formatStatus(status) {
    const check = status.check;
    return [
        `工作区：${status.workspace.path}（${status.workspace.slug}）`,
        `handoff ${status.workspace.handoff.bytes} B · notes ${status.workspace.notes.bytes} B · rules ${status.global.rules.bytes} B · profile ${status.global.profile.bytes} B`,
        check.ok ? '体检：通过' : `体检：${check.issues.length} 个问题（${check.issues.join('；')}）`,
        status.workspace.handoff.preview === '' ? '交接：空（收工前先写 handoff）' : `交接预览：\n${status.workspace.handoff.preview}`,
    ].join('\n');
}

const MEMORY_ACTIONS = ['status', 'read', 'write', 'handoff', 'check', 'list', 'promote'];

function memoryTool(service) {
    return {
        name: 'marshal_memory',
        description: '两级文件记忆：global（跨工作区：rules 铁律 / profile 画像，保持短）+ workspace（每个工作区一份 handoff 交接 / notes 结论）。'
            + '收工或换会话前用 handoff 写 §〇（≤4 KB，五小节）；只记结论不记过程，单次写入 ≤10 行；'
            + 'status 看当前工作区与全局摘要，check 做体检，promote 把跨工作区结论沉淀到全局。',
        parameters: {
            action: { type: 'string', required: true, enum: MEMORY_ACTIONS },
            scope: { type: 'string', enum: ['global', 'workspace'], description: '读写范围，默认 workspace。' },
            file: { type: 'string', enum: ['rules', 'profile', 'handoff', 'notes'], description: 'global: rules|profile；workspace: handoff|notes。' },
            cwd: { type: 'string', description: '工作区绝对路径；默认当前会话工作目录。' },
            content: { type: 'string', description: 'write/promote 的正文（≤10 行，≤2 KB）。' },
            note: { type: 'string', description: 'handoff 的「上次交接」正文。' },
            last: { type: 'string', description: '同 note，兼容写法。' },
            projects: {
                type: 'array',
                items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        name: { type: 'string', required: true },
                        status: { type: 'string' },
                        next: { type: 'string' },
                    },
                },
                description: 'handoff 的当前项目表。',
            },
            next: { type: 'string', description: 'handoff 的下一步。' },
            blockers: { type: 'string', description: 'handoff 的卡点，默认「无」。' },
            limit: { type: 'integer', description: 'read 的字符上限 / list 的条数。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    action: { type: 'string' },
                    text: { type: 'string' },
                    memory: { type: 'object', additionalProperties: true },
                },
                required: ['ok', 'action', 'text'],
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
            const agent = exec?.agent;
            const cwd = agent?.session?.header?.cwd;
            const identity = agent?.session?.id === undefined ? undefined : `dsh:${String(agent.session.id).slice(0, 12)}`;
            const result = service.handle(args.action, args, { cwd, identity });
            return { ok: true, action: args.action, text: result.text, ...(result.memory === undefined ? {} : { memory: result.memory }) };
        },
    };
}

export function mountMemory(ctx, config, options = {}) {
    const service = createMemoryService({ root: options.root, logger: options.logger ?? ctx.logger });
    ctx.inject(['tools'], scoped => {
        scoped.effect(() => {
            const definition = memoryTool(service);
            definition.parameters = specToJsonSchema(definition.parameters);
            return scoped.tools.register(definition);
        }, 'marshal: memory tool');
    });
    return service;
}
