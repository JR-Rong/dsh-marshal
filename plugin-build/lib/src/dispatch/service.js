import { join } from 'node:path';
import { homedir } from 'node:os';
import { Ledger, DispatchError, ROLES } from '../dispatch/ledger.js';
import { WorkerPool, routeTicket } from '../dispatch/workers.js';

/**
 * 调度服务：把台账（状态机）、工人池（路由）和工具面组合起来。
 * 节点角色默认挂载；hub 角色不挂（hub 没有本机会话）。
 */
export function createDispatchService({ root, config, memory, logger, now = Date.now } = {}) {
    const dir = root ?? join(homedir(), '.dsh-marshal', 'dispatch');
    const ledger = new Ledger(dir);
    const pool = new WorkerPool(dir, config ?? {}, now);
    const log = logger ?? { warn: () => { }, info: () => { } };

    const handle = (action, args = {}, context = {}) => {
        const cwd = context.cwd;
        const by = typeof args.by === 'string' && args.by.trim() !== '' ? args.by.trim() : undefined;
        const worker = typeof args.worker === 'string' && args.worker.trim() !== '' ? args.worker.trim() : undefined;
        const identity = by ?? worker ?? context.identity ?? 'agent';
        switch (action) {
            case 'submit': {
                const ticket = ledger.submit({
                    title: args.title, goal: args.goal, acceptance: args.acceptance,
                    role: args.role, priority: args.priority,
                    workspace: typeof args.workspace === 'string' ? args.workspace : cwd,
                    by: identity,
                });
                return { ok: true, action, ticket, text: `已建单 ${short(ticket.id)}（${ticket.state}）：${ticket.title}` };
            }
            case 'assign': {
                const ticket = requireTicket(args);
                let target = worker;
                let reason = 'explicit';
                if (target === undefined) {
                    const routed = routeTicket(ticket, pool, ledger.list({ limit: 200 }));
                    target = routed.worker.id;
                    reason = routed.reason;
                }
                const assigned = ledger.assign(ticket.id, target, identity);
                pool.touch(target);
                return { ok: true, action, ticket: assigned, text: `已指派 ${short(ticket.id)} → ${target}（${reason}）` };
            }
            case 'route': {
                const ticket = requireTicket(args);
                const routed = routeTicket(ticket, pool, ledger.list({ limit: 200 }));
                return { ok: true, action, routed: { worker: routed.worker, reason: routed.reason }, text: `建议路由 ${short(ticket.id)} → ${routed.worker.id}（${routed.reason}）` };
            }
            case 'claim': {
                const ticket = requireTicket(args);
                const owner = worker ?? ticket.owner;
                if (owner === undefined)
                    throw new DispatchError('invalid-args', 'claim needs worker (or a ticket already assigned)');
                const next = ledger.claim(ticket.id, owner);
                pool.touch(owner);
                return { ok: true, action, ticket: next, text: `已开工 ${short(ticket.id)}（${owner}）` };
            }
            case 'evidence': {
                const ticket = requireTicket(args);
                const next = ledger.addEvidence(ticket.id, args.evidence, worker ?? ticket.owner);
                pool.touch(ticket.owner ?? worker ?? '');
                return { ok: true, action, ticket: next, text: `已登记证据 ${short(ticket.id)} ×${args.evidence.length}` };
            }
            case 'report': {
                const ticket = requireTicket(args);
                const next = ledger.report(ticket.id, ticket.owner ?? worker);
                return { ok: true, action, ticket: next, text: `已提交验收 ${short(ticket.id)}（证据 ${next.evidence.length} 条）` };
            }
            case 'verify': {
                const ticket = requireTicket(args);
                const next = ledger.verify(ticket.id, args.verdict, by, args.note);
                return { ok: true, action, ticket: next, text: `验收 ${args.verdict}：${short(ticket.id)}` };
            }
            case 'complete': {
                const ticket = requireTicket(args);
                const next = ledger.complete(ticket.id, by);
                if (memory !== undefined && next.workspace !== null && next.workspace !== undefined)
                    memory.archiveTicket(next, next.workspace);
                return { ok: true, action, ticket: next, text: `已完成 ${short(ticket.id)}（已写入档案层）` };
            }
            case 'block': {
                const ticket = requireTicket(args);
                const next = ledger.block(ticket.id, args.note ?? args.reason, identity);
                return { ok: true, action, ticket: next, text: `已挂起 ${short(ticket.id)}：${args.note ?? args.reason}` };
            }
            case 'unblock': {
                const ticket = requireTicket(args);
                const next = ledger.unblock(ticket.id, identity);
                return { ok: true, action, ticket: next, text: `已解除挂起 ${short(ticket.id)}` };
            }
            case 'fail': {
                const ticket = requireTicket(args);
                const next = ledger.fail(ticket.id, args.note ?? args.reason, identity);
                return { ok: true, action, ticket: next, text: `已失败 ${short(ticket.id)}：${args.note ?? args.reason}` };
            }
            case 'cancel': {
                const ticket = requireTicket(args);
                const next = ledger.cancel(ticket.id, identity);
                return { ok: true, action, ticket: next, text: `已取消 ${short(ticket.id)}` };
            }
            case 'message': {
                const ticket = requireTicket(args);
                const message = ledger.message(ticket.id, identity, args.note ?? args.text);
                return { ok: true, action, message, text: `已留言 ${short(ticket.id)}` };
            }
            case 'inbox': {
                const items = ledger.inbox(worker ?? identity, args.limit ?? 20);
                return { ok: true, action, messages: items, text: items.length === 0 ? '没有新留言' : `${items.length} 条留言（最新在前）` };
            }
            case 'status': {
                const stats = ledger.stats();
                const workers = pool.snapshot(ledger.list({ limit: 200 }));
                const active = ledger.list({ limit: 10 }).filter(item => !['done', 'failed', 'cancelled'].includes(item.state));
                return {
                    ok: true, action, stats, workers, activeTickets: active,
                    text: summarize(stats, workers, active),
                };
            }
            case 'list': {
                const items = ledger.list({ state: args.state, owner: worker, limit: args.limit ?? 20 });
                return { ok: true, action, tickets: items, text: items.length === 0 ? '没有工单' : items.map(item => `${short(item.id)} ${item.state} ${item.title}`).join('\n') };
            }
            case 'get': {
                const ticket = requireTicket(args);
                return { ok: true, action, ticket, text: formatTicket(ticket) };
            }
            case 'workers': {
                const workers = pool.snapshot(ledger.list({ limit: 200 }));
                return { ok: true, action, workers, text: workers.map(worker => `${worker.id} ${worker.role} ${worker.status} ${worker.load}/${worker.capacity}`).join('\n') };
            }
            case 'register_worker': {
                const created = pool.register({ name: args.name, agent: args.agent, role: args.role, capacity: args.capacity });
                return { ok: true, action, worker: created, text: `已登记工人 ${created.id}（${created.role}）` };
            }
            case 'remove_worker': {
                const removed = pool.remove(worker ?? args.name);
                return { ok: true, action, worker: removed, text: `已移除工人 ${removed.id}` };
            }
            default:
                throw new DispatchError('invalid-args', `unknown action ${action}`);
        }
    };

    const requireTicket = args => {
        if (typeof args.ticket !== 'string' || args.ticket.trim() === '')
            throw new DispatchError('invalid-args', 'ticket id is required for this action');
        return ledger.get(args.ticket.trim());
    };

    log.info?.(`marshal-dispatch: ledger at ${dir}`);
    return { ledger, pool, handle, dir };
}

export function summarize(stats, workers, active) {
    const idle = workers.filter(worker => worker.status === 'idle').length;
    const busy = workers.filter(worker => worker.status === 'busy').length;
    return [
        `工单 ${stats.total} 张：` + Object.entries(stats.byState).map(([state, count]) => `${state}=${count}`).join(' ') || '无',
        `工人 ${workers.length} 个：idle=${idle} busy=${busy}`,
        active.length === 0 ? '没有进行中的工单' : '进行中：\n' + active.map(ticket => `- ${short(ticket.id)} ${ticket.state} ${ticket.title}`).join('\n'),
    ].join('\n');
}

export function short(id) {
    return String(id).slice(0, 8);
}

export function formatTicket(ticket) {
    return [
        `${ticket.title} [${ticket.state}] ${ticket.id}`,
        `- owner: ${ticket.owner ?? '—'} · role: ${ticket.role} · attempts: ${ticket.attempts}`,
        `- 目标: ${ticket.goal}`,
        `- 验收判据: ${(ticket.acceptance ?? []).join('；') || '—'}`,
        `- 证据: ${(ticket.evidence ?? []).length} 条`,
        `- 验收: ${ticket.verification === null ? '—' : `${ticket.verification.verdict} by ${ticket.verification.by}`}`,
        `- 消息: ${(ticket.messages ?? []).length} 条`,
    ].join('\n');
}

export const DISPATCH_ROLES = ROLES;
