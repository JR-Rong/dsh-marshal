import { createDispatchService, summarize } from './service.js';
import { specToJsonSchema } from '../tools/schema.js';

const ACTIONS = [
    'submit', 'assign', 'route', 'claim', 'evidence', 'report', 'verify', 'complete',
    'block', 'unblock', 'fail', 'cancel', 'message', 'inbox', 'status', 'list', 'get',
    'workers', 'register_worker', 'remove_worker',
];

const TICKET_FIELDS = {
    type: 'object', additionalProperties: true,
};

function dispatchTool(service) {
    return {
        name: 'marshal_dispatch',
        description: '调度台的派单台账。一个工单同一时刻只有一个 owner；进入验收必须带证据；'
            + '通过验收的人不能是执行者；只有通过验收才能完成（证据 > 声明）。'
            + 'status 看全局，list 看工单，assign/route 派单，claim 开工，evidence 登记证据，report 交验收，verify 验收，complete 收单。',
        parameters: {
            action: { type: 'string', required: true, enum: ACTIONS, description: '要执行的动作。' },
            ticket: { type: 'string', description: '工单 id（assign/claim/evidence/report/verify/complete 等必填）。' },
            title: { type: 'string', description: 'submit 时的工单标题。' },
            goal: { type: 'string', description: 'submit 时的目标，默认同 title。' },
            acceptance: { type: 'array', items: { type: 'string' }, description: 'submit 时的验收判据（0~20 条）。' },
            role: { type: 'string', enum: ['planner', 'executor', 'reviewer'], description: 'submit 的工单角色。' },
            priority: { type: 'integer', description: '0（最高）到 3。' },
            workspace: { type: 'string', description: '工单归属的工作区绝对路径；默认当前会话工作目录。' },
            worker: { type: 'string', description: '工人 id（assign 的目标、claim 的身份、workers 的过滤）。' },
            by: { type: 'string', description: '操作者身份；默认当前会话。' },
            evidence: {
                type: 'array',
                items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        kind: { type: 'string', required: true, enum: ['file', 'url', 'hash', 'command', 'text'], description: '证据类型。' },
                        ref: { type: 'string', required: true, description: '文件路径 / URL / 哈希 / 命令 / 文本。' },
                        note: { type: 'string', description: '一句说明。' },
                    },
                },
                description: 'evidence 动作要登记的证据（1~20 条）。',
            },
            verdict: { type: 'string', enum: ['pass', 'fail'], description: 'verify 的结论。' },
            note: { type: 'string', description: '备注 / 驳回意见 / 挂起原因 / 留言正文。' },
            state: { type: 'string', description: 'list 的状态过滤。' },
            limit: { type: 'integer', description: '最多返回多少条（默认 20，上限 100）。' },
            name: { type: 'string', description: 'register_worker 的工人名。' },
            agent: { type: 'string', enum: ['dsh', 'codex', 'claude'], description: 'register_worker 的 agent 类型。' },
            capacity: { type: 'integer', description: 'register_worker 的并发容量（1~10）。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    action: { type: 'string' },
                    text: { type: 'string' },
                    ticket: TICKET_FIELDS,
                    tickets: { type: 'array', items: TICKET_FIELDS },
                    workers: { type: 'array', items: TICKET_FIELDS },
                    messages: { type: 'array', items: TICKET_FIELDS },
                    activeTickets: { type: 'array', items: TICKET_FIELDS },
                    routed: TICKET_FIELDS,
                    worker: TICKET_FIELDS,
                    message: TICKET_FIELDS,
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
            return {
                ok: true,
                action: args.action,
                text: result.text,
                ...(result.ticket === undefined ? {} : { ticket: compactTicket(result.ticket) }),
                ...(result.tickets === undefined ? {} : { tickets: result.tickets }),
                ...(result.workers === undefined ? {} : { workers: result.workers }),
                ...(result.messages === undefined ? {} : { messages: result.messages }),
                ...(result.activeTickets === undefined ? {} : { activeTickets: result.activeTickets }),
                ...(result.routed === undefined ? {} : { routed: result.routed }),
                ...(result.worker === undefined ? {} : { worker: result.worker }),
                ...(result.message === undefined ? {} : { message: result.message }),
            };
        },
    };
}

function compactTicket(ticket) {
    return {
        id: ticket.id, title: ticket.title, state: ticket.state, owner: ticket.owner,
        role: ticket.role, attempts: ticket.attempts, workspace: ticket.workspace,
        evidence: ticket.evidence?.length ?? 0, verification: ticket.verification ?? null,
        messages: ticket.messages?.length ?? 0, acceptance: ticket.acceptance ?? [],
        goal: ticket.goal, updatedAt: ticket.updatedAt,
    };
}

/** 只接受本机回环请求的只读状态接口，给面板/诊断用。 */
function isLoopback(req) {
    const address = req.socket?.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function mountDispatch(ctx, config, options = {}) {
    const service = createDispatchService({
        root: options.root,
        config,
        memory: options.memory,
        logger: options.logger ?? ctx.logger,
    });
    ctx.inject(['tools'], scoped => {
        scoped.effect(() => {
            const definition = dispatchTool(service);
            definition.parameters = specToJsonSchema(definition.parameters);
            return scoped.tools.register(definition);
        }, 'marshal: dispatch tool');
    });
    ctx.inject(['webServer'], scoped => {
        scoped.effect(() => scoped.webServer.register({
            kind: 'exact',
            path: '/marshal/dispatch/state',
            handler(req, res) {
                if (req.method !== 'GET' || !isLoopback(req)) {
                    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, code: 'forbidden' }));
                    return;
                }
                const result = service.handle('status', {});
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ ok: true, stats: result.stats, workers: result.workers, activeTickets: result.activeTickets, text: summarize(result.stats, result.workers, result.activeTickets) }));
            },
        }), 'marshal: dispatch state route');
    });
    return service;
}
