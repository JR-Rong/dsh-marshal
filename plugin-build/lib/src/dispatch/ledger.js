import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendJsonLine, nowIso, readJson, writeJson } from './store.js';

/**
 * 派单台账：Router → Worker 的任务状态机。
 *
 * 借鉴官方 dsh-superagent-prototype 的四层（决策 / 执行 / 验收 / 档案）
 * 与 LangGraph 的「显式状态 + 允许转移表 + 可回放日志」：
 *
 *   queued → assigned → running → awaiting_verification → verified → done
 *                   ↘ blocked ↗        ↘ running(验收驳回重做)
 *   assigned/running/awaiting_verification/blocked → failed | cancelled
 *
 * 硬约束（不变量，工具层无法绕过）：
 *   1. 一单一 owner：同一时刻只有一个执行者；
 *   2. 证据 > 声明：进入验收必须带证据，通过验收的人不能是执行者；
 *   3. done 只能从 verified 进入：没有验收就没有完成；
 *   4. 每次状态变化都落事件日志，可回放、可审计。
 */

export const TICKET_STATES = Object.freeze([
    'queued', 'assigned', 'running', 'awaiting_verification',
    'verified', 'done', 'blocked', 'failed', 'cancelled',
]);

const TRANSITIONS = Object.freeze({
    queued: ['assigned', 'blocked', 'cancelled'],
    assigned: ['running', 'queued', 'blocked', 'failed', 'cancelled'],
    running: ['awaiting_verification', 'blocked', 'failed', 'cancelled'],
    awaiting_verification: ['verified', 'running', 'blocked', 'failed', 'cancelled'],
    verified: ['done', 'blocked'],
    blocked: ['queued', 'assigned', 'failed', 'cancelled'],
    done: [],
    failed: [],
    cancelled: [],
});

export const ROLES = Object.freeze(['planner', 'executor', 'reviewer']);
export const MAX_ATTEMPTS = 3;
const ACTIVE = new Set(['assigned', 'running', 'awaiting_verification']);
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

export class DispatchError extends Error {
    constructor(code, detail) {
        super(`marshal-dispatch: ${code}${detail === undefined ? '' : `: ${detail}`}`);
        this.name = 'DispatchError';
        this.code = code;
    }
}

const text = (value, field, max = 20_000) => {
    if (typeof value !== 'string' || value.trim() === '')
        throw new DispatchError('invalid-args', `${field} must be a non-empty string`);
    const trimmed = value.trim();
    if (trimmed.length > max)
        throw new DispatchError('invalid-args', `${field} is too long`);
    return trimmed;
};

const optionalText = (value, field, max = 20_000) => {
    if (value === undefined || value === null)
        return undefined;
    return text(value, field, max);
};

export class Ledger {
    constructor(root) {
        this.root = root;
        this.file = join(root, 'ledger.json');
        this.eventsFile = join(root, 'events.jsonl');
    }

    #load() {
        const data = readJson(this.file, { version: 1, tickets: [] });
        if (!Array.isArray(data.tickets))
            throw new DispatchError('corrupt-ledger', 'tickets must be an array');
        return data;
    }

    #save(data) {
        data.updatedAt = nowIso();
        writeJson(this.file, data);
    }

    #event(type, detail) {
        appendJsonLine(this.eventsFile, { at: nowIso(), type, ...detail });
    }

    #ticket(data, id) {
        if (typeof id !== 'string' || id.trim() === '')
            throw new DispatchError('invalid-args', 'ticket id is required');
        const ticket = data.tickets.find(item => item.id === id);
        if (ticket === undefined)
            throw new DispatchError('not-found', id);
        return ticket;
    }

    #transition(ticket, to, { by, note, reason } = {}) {
        const allowed = TRANSITIONS[ticket.state] ?? [];
        if (!allowed.includes(to))
            throw new DispatchError('invalid-transition', `${ticket.state} -> ${to}`);
        if ((to === 'blocked' || to === 'failed') && (reason === undefined || String(reason).trim() === ''))
            throw new DispatchError('reason-required', to);
        ticket.state = to;
        ticket.updatedAt = nowIso();
        if (by !== undefined)
            ticket.updatedBy = by;
        (ticket.history ??= []).push({ at: ticket.updatedAt, state: to, by: by ?? null, note: note ?? null, reason: reason ?? null });
        if (to === 'done')
            ticket.doneAt = ticket.updatedAt;
        if (to === 'blocked')
            ticket.blockedReason = reason;
        if (to === 'failed')
            ticket.failReason = reason;
        if (to === 'queued') {
            ticket.owner = null;
            ticket.blockedReason = null;
        }
    }

    /** 新建一张工单（决策层：谁来做、做什么、做到什么算数）。 */
    submit(input = {}) {
        const title = text(input.title, 'title', 200);
        const goal = optionalText(input.goal, 'goal') ?? title;
        const acceptance = Array.isArray(input.acceptance) ? input.acceptance.map(item => text(item, 'acceptance', 500)).slice(0, 20) : [];
        const role = input.role === undefined ? 'executor' : input.role;
        if (!ROLES.includes(role))
            throw new DispatchError('invalid-args', `role must be one of ${ROLES.join(', ')}`);
        const priority = input.priority === undefined ? 2 : input.priority;
        if (!Number.isInteger(priority) || priority < 0 || priority > 3)
            throw new DispatchError('invalid-args', 'priority must be an integer 0..3');
        const data = this.#load();
        const ticket = {
            id: randomUUID(),
            title,
            goal,
            acceptance,
            role,
            workspace: optionalText(input.workspace, 'workspace', 4096) ?? null,
            priority,
            state: 'queued',
            owner: null,
            attempts: 0,
            evidence: [],
            verification: null,
            messages: [],
            history: [{ at: nowIso(), state: 'queued', by: input.by ?? null, note: 'submitted', reason: null }],
            createdAt: nowIso(),
            updatedAt: nowIso(),
        };
        data.tickets.push(ticket);
        this.#save(data);
        this.#event('ticket.submitted', { ticketId: ticket.id, title: ticket.title, by: input.by ?? null });
        return ticket;
    }

    /** 指派：queued/blocked 的工单交给唯一 owner（一单一 owner）。 */
    assign(id, workerId, by) {
        const worker = text(workerId, 'worker', 200);
        const data = this.#load();
        const ticket = this.#ticket(data, id);
        if (!['queued', 'blocked'].includes(ticket.state))
            throw new DispatchError('invalid-transition', `${ticket.state} -> assigned (only queued/blocked can be assigned)`);
        if (ticket.attempts >= MAX_ATTEMPTS)
            throw new DispatchError('max-attempts', `${ticket.attempts} attempts used`);
        ticket.attempts += 1;
        ticket.owner = worker;
        this.#transition(ticket, 'assigned', { by: by ?? 'router', note: `attempt ${ticket.attempts}` });
        this.#save(data);
        this.#event('ticket.assigned', { ticketId: ticket.id, owner: worker, attempt: ticket.attempts, by: by ?? null });
        return ticket;
    }

    /** 执行者开工：assigned → running。 */
    claim(id, workerId) {
        const data = this.#load();
        const ticket = this.#ticket(data, id);
        this.#assertOwner(ticket, workerId);
        this.#transition(ticket, 'running', { by: workerId });
        this.#save(data);
        this.#event('ticket.started', { ticketId: ticket.id, owner: ticket.owner });
        return ticket;
    }

    /** 证据登记：执行过程中可多次追加，验收前至少一条。 */
    addEvidence(id, items, by) {
        if (!Array.isArray(items) || items.length === 0 || items.length > 20)
            throw new DispatchError('invalid-args', 'evidence must be a non-empty array (max 20)');
        const data = this.#load();
        const ticket = this.#ticket(data, id);
        if (!['running', 'awaiting_verification'].includes(ticket.state))
            throw new DispatchError('invalid-transition', `evidence only while running/awaiting_verification (now ${ticket.state})`);
        this.#assertOwner(ticket, by);
        for (const item of items) {
            const kind = item?.kind;
            if (!['file', 'url', 'hash', 'command', 'text'].includes(kind))
                throw new DispatchError('invalid-args', 'evidence.kind must be file|url|hash|command|text');
            ticket.evidence.push({
                kind,
                ref: text(item.ref, 'evidence.ref', 4096),
                note: optionalText(item.note, 'evidence.note', 1000) ?? null,
                at: nowIso(),
                by: by ?? ticket.owner,
            });
        }
        ticket.updatedAt = nowIso();
        this.#save(data);
        this.#event('ticket.evidence', { ticketId: ticket.id, count: items.length, by: by ?? null });
        return ticket;
    }

    /** 交付验收：running → awaiting_verification（必须有证据）。 */
    report(id, by) {
        const data = this.#load();
        const ticket = this.#ticket(data, id);
        this.#assertOwner(ticket, by);
        if (ticket.evidence.length === 0)
            throw new DispatchError('evidence-required', 'report needs at least one evidence item');
        this.#transition(ticket, 'awaiting_verification', { by });
        this.#save(data);
        this.#event('ticket.reported', { ticketId: ticket.id, evidence: ticket.evidence.length });
        return ticket;
    }

    /** 验收：执行者不能给自己验收；驳回则退回 running 并记录意见。 */
    verify(id, verdict, by, note) {
        if (verdict !== 'pass' && verdict !== 'fail')
            throw new DispatchError('invalid-args', 'verdict must be pass|fail');
        const data = this.#load();
        const ticket = this.#ticket(data, id);
        if (ticket.state !== 'awaiting_verification')
            throw new DispatchError('invalid-transition', `${ticket.state} -> verified (only awaiting_verification can be verified)`);
        const verifier = optionalText(by, 'by', 200) ?? 'reviewer';
        if (verifier === ticket.owner)
            throw new DispatchError('self-verification', 'the owner cannot verify their own ticket');
        ticket.verification = { by: verifier, verdict, note: optionalText(note, 'note', 4000) ?? null, at: nowIso() };
        this.#transition(ticket, verdict === 'pass' ? 'verified' : 'running', { by: verifier, note: `verify:${verdict}` });
        this.#save(data);
        this.#event('ticket.verified', { ticketId: ticket.id, verdict, by: verifier });
        return ticket;
    }

    /** 完成：只有通过验收的工单才算完成（证据 > 声明）。 */
    complete(id, by) {
        const data = this.#load();
        const ticket = this.#ticket(data, id);
        if (ticket.state !== 'verified')
            throw new DispatchError('invalid-transition', `${ticket.state} -> done (verify first)`);
        this.#transition(ticket, 'done', { by: by ?? ticket.verification?.by ?? null });
        this.#save(data);
        this.#event('ticket.done', { ticketId: ticket.id, by: by ?? null });
        return ticket;
    }

    block(id, reason, by) {
        const data = this.#load();
        const ticket = this.#ticket(data, id);
        this.#transition(ticket, 'blocked', { by: by ?? null, reason });
        this.#save(data);
        this.#event('ticket.blocked', { ticketId: ticket.id, reason, by: by ?? null });
        return ticket;
    }

    unblock(id, by) {
        const data = this.#load();
        const ticket = this.#ticket(data, id);
        this.#transition(ticket, 'queued', { by: by ?? null, note: 'unblocked' });
        this.#save(data);
        this.#event('ticket.unblocked', { ticketId: ticket.id, by: by ?? null });
        return ticket;
    }

    fail(id, reason, by) {
        const data = this.#load();
        const ticket = this.#ticket(data, id);
        this.#transition(ticket, 'failed', { by: by ?? null, reason });
        this.#save(data);
        this.#event('ticket.failed', { ticketId: ticket.id, reason, by: by ?? null });
        return ticket;
    }

    cancel(id, by) {
        const data = this.#load();
        const ticket = this.#ticket(data, id);
        if (TERMINAL.has(ticket.state))
            throw new DispatchError('invalid-transition', `${ticket.state} is terminal`);
        this.#transition(ticket, 'cancelled', { by: by ?? null });
        this.#save(data);
        this.#event('ticket.cancelled', { ticketId: ticket.id, by: by ?? null });
        return ticket;
    }

    /** 工单内消息（bot ↔ bot 派单讨论的最小实现）。 */
    message(id, from, body) {
        const data = this.#load();
        const ticket = this.#ticket(data, id);
        const message = {
            id: randomUUID(),
            from: optionalText(from, 'from', 200) ?? 'unknown',
            text: text(body, 'text', 4000),
            at: nowIso(),
        };
        ticket.messages.push(message);
        ticket.updatedAt = message.at;
        this.#save(data);
        this.#event('ticket.message', { ticketId: ticket.id, from: message.from });
        return message;
    }

    /** 收件箱：别人发给我的消息（按工单汇总，最新在前）。 */
    inbox(worker, limit = 20) {
        const id = text(worker, 'worker', 200);
        const data = this.#load();
        const items = [];
        for (const ticket of data.tickets) {
            for (const message of ticket.messages ?? []) {
                if (message.from === id)
                    continue;
                items.push({ ticketId: ticket.id, ticketTitle: ticket.title, ...message });
            }
        }
        items.sort((a, b) => (a.at < b.at ? 1 : -1));
        return items.slice(0, Math.max(1, Math.min(limit, 100)));
    }

    get(id) {
        return this.#ticket(this.#load(), id);
    }

    list(filter = {}) {
        const limit = Math.max(1, Math.min(Number(filter.limit) || 20, 200));
        const data = this.#load();
        let items = data.tickets;
        if (filter.state !== undefined)
            items = items.filter(ticket => ticket.state === filter.state);
        if (filter.owner !== undefined)
            items = items.filter(ticket => ticket.owner === filter.owner);
        if (filter.workspace !== undefined)
            items = items.filter(ticket => ticket.workspace === filter.workspace);
        items = [...items].sort((a, b) => {
            const byPriority = (a.priority ?? 2) - (b.priority ?? 2);
            if (byPriority !== 0)
                return byPriority;
            return a.updatedAt < b.updatedAt ? 1 : -1;
        });
        return items.slice(0, limit).map(ticket => this.#summary(ticket));
    }

    stats() {
        const data = this.#load();
        const byState = {};
        for (const ticket of data.tickets)
            byState[ticket.state] = (byState[ticket.state] ?? 0) + 1;
        return { total: data.tickets.length, byState, updatedAt: data.updatedAt ?? null };
    }

    #summary(ticket) {
        return {
            id: ticket.id, title: ticket.title, state: ticket.state, owner: ticket.owner,
            role: ticket.role, priority: ticket.priority, attempts: ticket.attempts,
            workspace: ticket.workspace, updatedAt: ticket.updatedAt,
            evidence: ticket.evidence.length, verification: ticket.verification,
        };
    }

    #assertOwner(ticket, worker) {
        const id = optionalText(worker, 'by/worker', 200);
        if (id === undefined)
            throw new DispatchError('invalid-args', 'worker identity is required');
        if (ticket.owner !== id)
            throw new DispatchError('not-owner', `${id} is not the owner of ${ticket.id}`);
    }
}

export { ACTIVE, TERMINAL };
