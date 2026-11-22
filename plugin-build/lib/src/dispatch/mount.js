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
        description: '派单台账：一单单 owner、证据入验收、验收与执行分离。动作：status/list/get/submit/assign/route/claim/evidence/report/verify/complete/workers。',
        parameters: {
            action: { type: 'string', required: true, enum: ACTIONS },
            ticket: { type: 'string', description: '工单 ID' },
            title: { type: 'string' },
            goal: { type: 'string' },
            acceptance: { type: 'array', items: { type: 'string' } },
            role: { type: 'string', enum: ['planner', 'executor', 'reviewer'] },
            priority: { type: 'integer' },
            workspace: { type: 'string' },
            worker: { type: 'string' },
            by: { type: 'string' },
            evidence: {
                type: 'array',
                items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        kind: { type: 'string', required: true, enum: ['file', 'url', 'hash', 'command', 'text'] },
                        ref: { type: 'string', required: true },
                        note: { type: 'string' },
                    },
                },
            },
            verdict: { type: 'string', enum: ['pass', 'fail'] },
            note: { type: 'string' },
            state: { type: 'string' },
            limit: { type: 'integer' },
            name: { type: 'string' },
            agent: { type: 'string', enum: ['dsh', 'codex', 'claude'] },
            capacity: { type: 'integer' },
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
