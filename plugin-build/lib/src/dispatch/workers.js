import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { nowIso, readJson, writeJson } from './store.js';
import { DispatchError, ROLES, ACTIVE } from './ledger.js';

/**
 * Worker 池：把节点上可用的 agent（dsh / codex / claude）投影成「工人」。
 * 借鉴 DS-Bot 的「常驻 bot 团队」与 AionUi 的「多 agent 统一调度」：
 * 每个工人有角色、能力、负载与心跳；派单只发给一个在线的空闲工人。
 */

export const STALE_MS = 10 * 60 * 1000;
const DEFAULT_CAPACITY = 1;

export class WorkerPool {
    constructor(root, config, now = Date.now) {
        this.root = root;
        this.file = join(root, 'workers.json');
        this.config = config;
        this.now = now;
    }

    #defaults() {
        const device = this.config.deviceId ?? 'local';
        return (this.config.agents ?? ['dsh']).map((agent, order) => ({
            id: `${device}:${agent}`,
            name: agent,
            agent,
            role: 'executor',
            capacity: DEFAULT_CAPACITY,
            source: 'node',
            order,
            createdAt: null,
            lastSeen: null,
        }));
    }

    #custom() {
        const data = readJson(this.file, { version: 1, workers: [] });
        return Array.isArray(data.workers) ? data.workers : [];
    }

    #save(workers) {
        writeJson(this.file, { version: 1, workers, updatedAt: nowIso(this.now) });
    }

    list() {
        const seen = new Set();
        const merged = [];
        for (const worker of [...this.#defaults(), ...this.#custom()]) {
            if (seen.has(worker.id))
                continue;
            seen.add(worker.id);
            merged.push(worker);
        }
        return merged;
    }

    get(id) {
        return this.list().find(worker => worker.id === id);
    }

    register(input = {}) {
        const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : undefined;
        if (name === undefined)
            throw new DispatchError('invalid-args', 'worker name is required');
        const agent = input.agent ?? 'dsh';
        if (!['dsh', 'codex', 'claude'].includes(agent))
            throw new DispatchError('invalid-args', 'agent must be dsh|codex|claude');
        const role = input.role ?? 'executor';
        if (!ROLES.includes(role))
            throw new DispatchError('invalid-args', `role must be one of ${ROLES.join(', ')}`);
        const capacity = input.capacity ?? DEFAULT_CAPACITY;
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10)
            throw new DispatchError('invalid-args', 'capacity must be an integer 1..10');
        const custom = this.#custom();
        const existing = custom.find(worker => worker.name === name && worker.agent === agent);
        if (existing !== undefined)
            return existing;
        const worker = {
            id: input.id ?? `${this.config.deviceId ?? 'local'}:${agent}:${name}`,
            name, agent, role, capacity,
            source: 'custom',
            createdAt: nowIso(this.now),
            lastSeen: nowIso(this.now),
        };
        custom.push(worker);
        this.#save(custom);
        return worker;
    }

    remove(id) {
        const custom = this.#custom();
        const next = custom.filter(worker => worker.id !== id);
        if (next.length === custom.length) {
            const isDefault = this.#defaults().some(worker => worker.id === id);
            if (isDefault)
                throw new DispatchError('protected', 'node workers come from config.agents');
            throw new DispatchError('not-found', id);
        }
        this.#save(next);
        return { id };
    }

    /** 心跳：claim / evidence / report 时自动调用，也可手动 online。 */
    touch(id) {
        const custom = this.#custom();
        const worker = custom.find(item => item.id === id);
        if (worker === undefined)
            return false;
        worker.lastSeen = nowIso(this.now);
        this.#save(custom);
        return true;
    }

    /** 负载 = 未完成的指派数；容量默认 1。 */
    load(tickets, id) {
        return tickets.filter(ticket => ticket.owner === id && ACTIVE.has(ticket.state)).length;
    }

    /** 带健康度的工人视图（给调度与工具输出用）。 */
    snapshot(tickets) {
        return this.list().map(worker => {
            const load = this.load(tickets, worker.id);
            const lastSeen = worker.lastSeen;
            const online = lastSeen === null
                ? worker.source === 'node'
                : (this.now() - Date.parse(lastSeen) < STALE_MS);
            return {
                ...worker,
                load,
                capacity: worker.capacity ?? DEFAULT_CAPACITY,
                online,
                status: !online ? 'stale' : load >= (worker.capacity ?? DEFAULT_CAPACITY) ? 'busy' : 'idle',
            };
        });
    }
}

/**
 * 路由策略（确定性）：按角色过滤 → 在线 → 有空位；
 * 依次比较 负载升序 → 最近心跳降序 → id 升序。
 * 返回 { worker, reason }；无候选时给可解释的失败原因。
 */
export function routeTicket(ticket, pool, tickets) {
    const wanted = ticket.role ?? 'executor';
    const snapshot = pool.snapshot(tickets);
    const rejected = [];
    const eligible = [];
    for (const worker of snapshot) {
        if (worker.role !== wanted) {
            rejected.push(`${worker.id}: role ${worker.role} != ${wanted}`);
            continue;
        }
        if (!worker.online) {
            rejected.push(`${worker.id}: stale`);
            continue;
        }
        if (worker.load >= (worker.capacity ?? DEFAULT_CAPACITY)) {
            rejected.push(`${worker.id}: full (${worker.load}/${worker.capacity})`);
            continue;
        }
        eligible.push(worker);
    }
    if (eligible.length === 0) {
        throw new DispatchError('no-eligible-worker', rejected.join('; ') || `no worker with role ${wanted}`);
    }
    eligible.sort((a, b) => {
        const byLoad = a.load - b.load;
        if (byLoad !== 0)
            return byLoad;
        // 并列时按节点配置顺序（dsh 优先），再按最近心跳，最后按 id，保证可复现。
        const byOrder = (a.order ?? 1000) - (b.order ?? 1000);
        if (byOrder !== 0)
            return byOrder;
        const aSeen = a.lastSeen ?? '';
        const bSeen = b.lastSeen ?? '';
        if (aSeen !== bSeen)
            return aSeen < bSeen ? 1 : -1;
        return a.id < b.id ? -1 : 1;
    });
    const worker = eligible[0];
    return {
        worker,
        reason: `role=${wanted}, load=${worker.load}/${worker.capacity ?? DEFAULT_CAPACITY}, seen=${worker.lastSeen ?? 'node-default'}, rejected=${rejected.length}`,
    };
}

export { randomUUID };
