import { randomUUID } from 'node:crypto';
import { encodeFrame, } from "../wire/frames.js";
import { COMMAND_TTL_MS } from "../wire/limits.js";
import { commandPayloadDigest } from "../wire/commands.js";
import { commandDomainKey } from "../wire/idempotency.js";
import { HubIdempotency, DEFAULT_COMPLETED_LIMIT } from "./idempotency.js";
import { createEventBuffer } from "./buffer.js";
/** T02 会换成持久化 owner 身份；当前显式占位，不能当作安全声明。 */
const PLACEHOLDER_OPERATOR_ID = 'operator-unbound';
const UNBOUND_CONNECTION_ID = 'unbound';
const UNBOUND_NODE_EPOCH = 'unbound';
/** 订阅者数量上限，避免单个 hub 被无限个监听者拖垮。 */
const MAX_SUBSCRIBERS = 200;
/** dispose 之后所有未完成与新到的指令都以这个固定错误结束。 */
const DISPOSED_MESSAGE = 'relay: disposed';
/** 被拒绝 ACK 的计数上限：只用于观测，不能被对端无限推高。 */
const MAX_REJECTED_ACKS = 1_000;
/** 幂等键→设备的有界映射，只用于断线时定位要清正文的缓存；与结果缓存同上限。 */
const MAX_CACHE_DEVICES = DEFAULT_COMPLETED_LIMIT;
function disposedOutcome() {
    return { ok: false, status: 'outcome-unknown', code: 'disposed', message: DISPOSED_MESSAGE };
}
/** 索引计数只收有界非负整数；未知字段/嵌套对象一律丢弃。 */
function indexCounts(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const out = {};
    let seen = 0;
    for (const [key, item] of Object.entries(value)) {
        if (seen >= 16)
            break;
        if (typeof item === 'number' && Number.isInteger(item) && item >= 0) {
            out[key.slice(0, 32)] = item;
            seen += 1;
        }
    }
    return seen === 0 ? undefined : out;
}
const CAPABILITY_OPERATIONS = new Set([
    'prompt', 'interrupt', 'answer', 'cancel', 'configure', 'create', 'fork', 'acquire',
]);
const CAPABILITY_OWNERSHIP = new Set([
    'ours', 'attached', 'foreign-unknown', 'foreign-running', 'unverified',
]);
const CAPABILITY_TOOL_DETAIL = new Set(['args+output', 'args', 'none']);
const CAPABILITY_PROMPT_FIDELITY = new Set(['native', 'relay', 'dom', 'none']);
const CAPABILITY_FOLLOW = new Set(['stream', 'poll', 'none']);
const CAPABILITY_TUNABLE_IDS = new Set([
    'model', 'reasoning', 'permission', 'plan', 'goal', 'skill', 'plugin',
]);
const CAPABILITY_TUNABLE_SCOPES = new Set(['next-turn', 'next-session', 'host']);
const CAPABILITY_TUNABLE_EFFECTS = new Set(['immediate', 'needs-restart', 'next-session']);
const CAPABILITY_TUNABLE_DIRECTIONS = new Set(['tighten-only']);
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function safeShortString(value, max) {
    return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;
}
const SETTING_VALUE_KEYS = new Set(['approvalPolicy', 'sandbox', 'fileSystem', 'network']);
/**
 * 设置 current/values 的有界结构投影（与 node 侧结构一致但不再脱敏）。
 * 目录/规则字段是路径或自由文本，hub 第二次重建时同样丢弃。
 */
function projectSettingValue(value, depth = 0) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string')
        return value.slice(0, 128);
    if (Array.isArray(value)) {
        if (depth > 1)
            return undefined;
        const items = value.slice(0, 16)
            .map(item => projectSettingValue(item, depth + 1))
            .filter(item => item !== undefined);
        return items.length === 0 ? undefined : items;
    }
    const record = asRecord(value);
    if (record === undefined || depth > 1)
        return undefined;
    const out = {};
    for (const key of SETTING_VALUE_KEYS) {
        if (!(key in record))
            continue;
        const item = projectSettingValue(record[key], depth + 1);
        if (item !== undefined)
            out[key] = item;
    }
    return Object.keys(out).length === 0 ? undefined : out;
}
/**
 * capability 只在 hub 侧再做一次白名单重建：即使节点/适配器出错，
 * cwd、标题、工具参数正文或未知字段也不会进入索引与 HTTP。
 */
export function publicCapability(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const out = {};
    const observe = asRecord(record.observe);
    if (observe !== undefined) {
        const projected = {};
        if (typeof observe.history === 'boolean')
            projected.history = observe.history;
        const follow = safeShortString(observe.follow, 16);
        if (follow !== undefined && CAPABILITY_FOLLOW.has(follow))
            projected.follow = follow;
        if (Object.keys(projected).length > 0)
            out.observe = projected;
    }
    if (Array.isArray(record.operations)) {
        out.operations = [...new Set(record.operations
                .filter((item) => typeof item === 'string' && CAPABILITY_OPERATIONS.has(item)))]
            .slice(0, 32);
    }
    const ownership = safeShortString(record.ownership, 32);
    if (ownership !== undefined && CAPABILITY_OWNERSHIP.has(ownership))
        out.ownership = ownership;
    const toolDetail = safeShortString(record.toolDetail, 32);
    if (toolDetail !== undefined && CAPABILITY_TOOL_DETAIL.has(toolDetail))
        out.toolDetail = toolDetail;
    const promptFidelity = safeShortString(record.promptFidelity, 32);
    if (promptFidelity !== undefined && CAPABILITY_PROMPT_FIDELITY.has(promptFidelity)) {
        out.promptFidelity = promptFidelity;
    }
    if (typeof record.reasoning === 'boolean')
        out.reasoning = record.reasoning;
    if (typeof record.stale === 'boolean')
        out.stale = record.stale;
    for (const key of ['revision', 'readAt', 'settingsRevision']) {
        const item = record[key];
        if (typeof item === 'number' && Number.isInteger(item) && item >= 0)
            out[key] = item;
    }
    const runtimeEpoch = safeShortString(record.runtimeEpoch, 128);
    if (runtimeEpoch !== undefined)
        out.runtimeEpoch = runtimeEpoch;
    const pending = asRecord(record.pending);
    if (pending !== undefined) {
        const field = safeShortString(pending.field, 32);
        const status = safeShortString(pending.status, 32);
        if (field !== undefined && CAPABILITY_TUNABLE_IDS.has(field)
            && (status === 'pending' || status === 'readback-timeout')) {
            out.pending = { field, status };
        }
    }
    if (Array.isArray(record.tunables)) {
        out.tunables = record.tunables.slice(0, 16).flatMap(item => {
            const tunable = asRecord(item);
            if (tunable === undefined)
                return [];
            const id = safeShortString(tunable.id, 32);
            if (id === undefined || !CAPABILITY_TUNABLE_IDS.has(id))
                return [];
            const entry = { id };
            const scope = safeShortString(tunable.scope, 32);
            if (scope !== undefined && CAPABILITY_TUNABLE_SCOPES.has(scope))
                entry.scope = scope;
            const effect = safeShortString(tunable.effect, 32);
            if (effect !== undefined && CAPABILITY_TUNABLE_EFFECTS.has(effect))
                entry.effect = effect;
            const direction = safeShortString(tunable.direction, 32);
            if (direction !== undefined && CAPABILITY_TUNABLE_DIRECTIONS.has(direction))
                entry.direction = direction;
            if (typeof tunable.editable === 'boolean')
                entry.editable = tunable.editable;
            const reason = safeShortString(tunable.reason, 64);
            if (reason !== undefined)
                entry.reason = reason;
            if (Array.isArray(tunable.values)) {
                const values = [];
                for (const raw of tunable.values.slice(0, 32)) {
                    const value = asRecord(raw);
                    if (value === undefined)
                        continue;
                    const valueId = safeShortString(value.id, 64);
                    if (valueId === undefined)
                        continue;
                    const label = safeShortString(value.label, 128) ?? valueId;
                    values.push({ id: valueId, label });
                }
                if (values.length > 0)
                    entry.values = values;
            }
            const current = projectSettingValue(tunable.current);
            if (current !== undefined)
                entry.current = current;
            return [entry];
        });
    }
    const unavailable = asRecord(record.unavailable);
    if (unavailable !== undefined) {
        const projected = {};
        let seen = 0;
        for (const [key, item] of Object.entries(unavailable)) {
            if (seen >= 16)
                break;
            const reason = safeShortString(item, 64);
            if (reason === undefined)
                continue;
            projected[key.slice(0, 64)] = reason;
            seen += 1;
        }
        if (seen > 0)
            out.unavailable = projected;
    }
    return out;
}
function stableCapability(document) {
    if (document === undefined)
        return '';
    const { readAt: _readAt, stale: _stale, ...rest } = document;
    return JSON.stringify(rest);
}
function sameSessionRow(previous, next) {
    if (previous === undefined)
        return false;
    return previous.running === next.running
        && previous.updatedAt === next.updatedAt
        && previous.title === next.title
        && (previous.blank ?? false) === (next.blank ?? false)
        && previous.ownership === next.ownership
        && JSON.stringify(previous.counts ?? {}) === JSON.stringify(next.counts ?? {});
}
/** 断线/收紧后缓存只能保留生命周期结论，结果正文一律丢弃。 */
function withoutBody(outcome) {
    if (!outcome.ok)
        return outcome;
    return {
        ok: true,
        status: outcome.status,
        // result 在成功分支是必填字段；undefined 表示正文已按策略丢弃。
        result: undefined,
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
    };
}
export class HubRelay {
    options;
    pending = new Map();
    statusPending = new Map();
    inputsPending = new Map();
    idempotency = new HubIdempotency();
    /** 幂等键归属：断线时按设备清掉缓存里的结果正文。 */
    cacheDevices = new Map();
    consumers = new Set();
    /**
     * 有界历史缓冲是唯一可回放来源；游标 epoch 与 hello.ack 的 hubEpoch 由装配方
     * 传入同一个值，重连后客户端只需按 `last-event-id` 对齐。
     */
    buffer;
    historyEpochValue;
    index = new Map();
    /** 设备 -> agent -> 已提交能力文档；只在 sync 提交或 capability.changed 时更新。 */
    capabilityIndex = new Map();
    /** 设备 -> `${agent}\u0000${sessionId}` -> 会话级能力文档。 */
    sessionCapabilityIndex = new Map();
    epochs = new Map();
    /** 每个设备经历过多少次内容清理；SSE 用它在发出前拦截跨过 purge 的旧帧。 */
    purgeGenerations = new Map();
    /** 每个会话当前活动 turnId；只用于避免迟到的 completed 把新回合置闲。 */
    activeTurns = new Map();
    syncGate;
    disposed = false;
    rejectedAckTotal = 0;
    constructor(options) {
        this.options = options;
        this.historyEpochValue = options.hubEpoch ?? randomUUID();
        this.buffer = createEventBuffer({
            hubEpoch: this.historyEpochValue, now: options.now,
            ...(options.historyTtlMs === undefined ? {} : { ttlMs: options.historyTtlMs }),
        });
    }
    /** hub 装配同步协调器后注入：未完成原子提交的设备不得收到写命令。 */
    setSyncGate(gate) {
        this.syncGate = gate;
    }
    /** 身份不匹配或已超时的 ACK 计数，饱和在上限内。 */
    get rejectedAcks() { return this.rejectedAckTotal; }
    get rejectedAckCount() { return this.rejectedAckTotal; }
    rejectAck() {
        if (this.rejectedAckTotal < MAX_REJECTED_ACKS)
            this.rejectedAckTotal += 1;
    }
    operatorId() {
        return this.options.operatorId ?? PLACEHOLDER_OPERATOR_ID;
    }
    domainKey(target, idempotencyKey) {
        return commandDomainKey({
            operatorId: this.operatorId(),
            target,
            idempotencyKey,
        });
    }
    trackCacheKey(key, deviceId) {
        this.cacheDevices.delete(key);
        this.cacheDevices.set(key, deviceId);
        while (this.cacheDevices.size > MAX_CACHE_DEVICES) {
            const oldest = this.cacheDevices.keys().next().value;
            if (oldest === undefined)
                break;
            this.cacheDevices.delete(oldest);
        }
    }
    /**
     * 只清该设备的结果正文，保留状态与 code；幂等键仍会阻止重放。
     * 交互正文不进入缓存；completed/unresolved 两张表里的 result 一并清除。
     */
    stripDeviceBodies(deviceId) {
        if (this.cacheDevices.size === 0)
            return;
        this.idempotency.stripBodies(key => this.cacheDevices.get(key) === deviceId, withoutBody);
    }
    async command(input) {
        if (this.disposed)
            return { ok: false, status: 'rejected', code: 'disposed' };
        // 先算载荷摘要：同域不同载荷必须 conflict，不能因为 key 相同就复用结果。
        const digest = commandPayloadDigest(input.op, input.target, input.args ?? {});
        const key = this.domainKey(input.target, input.idempotencyKey);
        this.trackCacheKey(key, input.target.deviceId);
        const prior = this.idempotency.lookup(key, digest);
        if (prior !== undefined) {
            if (prior.kind === 'conflict') {
                return { ok: false, status: 'rejected', code: 'idempotency-conflict' };
            }
            if (prior.kind === 'inflight')
                return prior.promise;
            return prior.value;
        }
        const slot = this.options.registry.get(input.target.deviceId);
        if (slot === undefined) {
            return { ok: false, status: 'rejected', code: 'device-offline' };
        }
        // 原子同步屏障完成前禁用写请求；已缓存的幂等结果仍可返回（上面已处理）。
        if (this.syncGate !== undefined && !this.syncGate(input.target.deviceId, slot.connectionId ?? UNBOUND_CONNECTION_ID, slot.nodeEpoch ?? UNBOUND_NODE_EPOCH)) {
            return { ok: false, status: 'rejected', code: 'sync-required' };
        }
        // 登记必须发生在任何 await 之前；同一轮事件循环里的并发调用只能有一个赢家。
        const promise = this.dispatch(input, slot);
        this.idempotency.begin(key, digest, promise);
        try {
            const outcome = await promise;
            if (outcome.ok || outcome.code !== 'disposed') {
                // accepted/confirmed/rejected 是终态；pending/unknown 只阻止重发，不算成功缓存。
                const resolved = outcome.ok || outcome.status === 'rejected';
                this.idempotency.complete(key, digest, input.op === 'observe' ? withoutBody(outcome) : outcome, resolved);
            }
            return outcome;
        }
        finally {
            this.idempotency.end(key, promise);
        }
    }
    async dispatch(input, slot) {
        const commandId = randomUUID();
        const timeoutMs = this.options.timeoutMs ?? COMMAND_TTL_MS;
        const issuedAt = this.options.now();
        const connectionId = slot.connectionId ?? UNBOUND_CONNECTION_ID;
        const nodeEpoch = slot.nodeEpoch ?? UNBOUND_NODE_EPOCH;
        const frame = {
            v: 2, type: 'command', commandId, idempotencyKey: input.idempotencyKey,
            operatorId: this.operatorId(),
            target: input.target,
            op: input.op,
            args: input.args ?? {},
            issuedAt,
            deadline: issuedAt + timeoutMs,
            connectionId,
            nodeEpoch,
        };
        const outcome = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(commandId);
                // 命令已经发出：没有 ACK 不能推断未执行，只能按结果未知处理。
                resolve({ ok: false, status: 'outcome-unknown', code: 'outcome-unknown' });
            }, timeoutMs);
            this.pending.set(commandId, {
                input,
                resolve, timer, deviceId: input.target.deviceId, connectionId, nodeEpoch,
            });
            let text;
            try {
                text = encodeFrame(frame);
            }
            catch (error) {
                // 编码失败不能留下悬挂的 pending 与定时器。
                clearTimeout(timer);
                this.pending.delete(commandId);
                reject(error);
                return;
            }
            try {
                slot.sender.send(text);
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(commandId);
                reject(error);
            }
        });
        return outcome;
    }
    /**
     * 只有 commandId、绑定连接身份与当前注册槽位全部匹配的 ACK 才能结算；
     * 旧连接/旧代次的 ACK 一律忽略并计入有界拒绝计数（契约 §4.6）。
     */
    settleHistory(frame, origin) {
        const entry = this.pending.get(frame.commandId);
        if (!entry || entry.input.op !== 'observe' || asRecord(entry.input.args)?.kind !== 'history'
            || !this.currentBinding(entry, origin) || frame.connectionId !== entry.connectionId
            || frame.nodeEpoch !== entry.nodeEpoch || frame.target.deviceId !== entry.input.target.deviceId
            || frame.target.agent !== entry.input.target.agent || frame.target.sessionId !== entry.input.target.sessionId
            || frame.items.some(item => item.deviceId !== frame.target.deviceId || item.agent !== frame.target.agent
                || item.sessionId !== frame.target.sessionId || item.nodeEpoch !== frame.nodeEpoch
                || item.kind.startsWith('input.'))) {
            this.rejectAck();
            return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(frame.commandId);
        entry.resolve({ ok: true, status: 'confirmed', result: undefined, history: {
                items: frame.items, completeness: frame.completeness,
                ...(frame.nextCursor === undefined ? {} : { nextCursor: frame.nextCursor }),
            } });
    }
    settle(ack, origin) {
        const entry = this.pending.get(ack.commandId);
        if (entry === undefined) {
            this.rejectAck();
            return;
        }
        if (!this.currentBinding(entry, origin)
            || ack.connectionId !== entry.connectionId
            || ack.nodeEpoch !== entry.nodeEpoch) {
            this.rejectAck();
            return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(ack.commandId);
        switch (ack.status) {
            case 'accepted':
                // accepted/confirmed 永远按成功结算；code 只是通知（例如结果过大未回传），
                // 既不能折叠成 rejected，也不能让幂等缓存把它记成失败。
                entry.resolve({
                    ok: true, status: 'accepted', result: ack.result,
                    ...(ack.code === undefined ? {} : { code: ack.code }),
                });
                return;
            case 'confirmed':
                entry.resolve({
                    ok: true, status: 'confirmed', result: ack.result,
                    ...(ack.code === undefined ? {} : { code: ack.code }),
                });
                return;
            case 'rejected':
                entry.resolve({ ok: false, status: 'rejected', code: ack.code ?? 'unsupported' });
                return;
            case 'pending-confirmation':
                entry.resolve({ ok: false, status: 'pending-confirmation', code: ack.code ?? 'pending-confirmation' });
                return;
            case 'outcome-unknown':
                // 状态保持 unknown，code 可以是 recovery-required 等细节；不折叠成失败。
                entry.resolve({ ok: false, status: 'outcome-unknown', code: ack.code ?? 'outcome-unknown' });
                return;
        }
    }
    /** 只读状态查询：发送 command.status，绝不重放原命令。 */
    async commandStatus(input) {
        if (this.disposed)
            return { status: 'outcome-unknown', code: 'disposed' };
        const slot = this.options.registry.get(input.target.deviceId);
        if (slot === undefined)
            return { status: 'outcome-unknown', code: 'device-offline' };
        const requestId = randomUUID();
        const timeoutMs = this.options.timeoutMs ?? COMMAND_TTL_MS;
        const connectionId = slot.connectionId ?? UNBOUND_CONNECTION_ID;
        const nodeEpoch = slot.nodeEpoch ?? UNBOUND_NODE_EPOCH;
        const frame = {
            v: 2, type: 'command.status', requestId,
            operatorId: this.operatorId(),
            target: input.target,
            idempotencyKey: input.idempotencyKey,
            connectionId,
            nodeEpoch,
        };
        return await new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.statusPending.delete(requestId);
                resolve({ status: 'outcome-unknown', code: 'outcome-unknown' });
            }, timeoutMs);
            this.statusPending.set(requestId, {
                resolve, timer, deviceId: input.target.deviceId, connectionId, nodeEpoch,
            });
            try {
                slot.sender.send(encodeFrame(frame));
            }
            catch {
                clearTimeout(timer);
                this.statusPending.delete(requestId);
                // 查询没有发出去：没有执行任何命令，仍按结果未知返回，调用方可重查。
                resolve({ status: 'outcome-unknown', code: 'outcome-unknown' });
            }
        });
    }
    /** 状态查询结果必须来自当前绑定连接；旧连接不能冒充新确认。 */
    settleStatus(frame, origin) {
        const entry = this.statusPending.get(frame.requestId);
        if (entry === undefined) {
            this.rejectAck();
            return;
        }
        if (!this.currentBinding(entry, origin)) {
            this.rejectAck();
            return;
        }
        clearTimeout(entry.timer);
        this.statusPending.delete(frame.requestId);
        entry.resolve({
            status: frame.status,
            ...(frame.code === undefined ? {} : { code: frame.code }),
            ...(frame.result === undefined ? {} : { result: frame.result }),
        });
    }
    /**
     * 当前待答快照：只读、有界（COMMAND_TTL_MS），绑定请求时刻的连接身份。
     * 未注册设备立即返回 device-offline；发出后没有匹配结果按结果未知。
     */
    async requestInputs(target, sessionId) {
        if (this.disposed)
            return { ok: false, code: 'disposed' };
        const slot = this.options.registry.get(target.deviceId);
        if (slot === undefined)
            return { ok: false, code: 'device-offline' };
        const requestId = randomUUID();
        const timeoutMs = this.options.timeoutMs ?? COMMAND_TTL_MS;
        const connectionId = slot.connectionId ?? UNBOUND_CONNECTION_ID;
        const nodeEpoch = slot.nodeEpoch ?? UNBOUND_NODE_EPOCH;
        const frame = {
            v: 2, type: 'inputs.snapshot', requestId,
            target: { deviceId: target.deviceId, agent: target.agent, sessionId },
            connectionId,
            nodeEpoch,
        };
        return await new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.inputsPending.delete(requestId);
                resolve({ ok: false, code: 'outcome-unknown' });
            }, timeoutMs);
            this.inputsPending.set(requestId, {
                resolve, timer, deviceId: target.deviceId, connectionId, nodeEpoch,
            });
            try {
                slot.sender.send(encodeFrame(frame));
            }
            catch {
                // 没有发出去：不是“未知结果”，但也不能当作有效快照，按 unknown 处理。
                clearTimeout(timer);
                this.inputsPending.delete(requestId);
                resolve({ ok: false, code: 'outcome-unknown' });
            }
        });
    }
    /** 结果必须来自请求时刻的同一设备/连接/代次；否则忽略（调用方超时）。 */
    settleInputs(frame, origin) {
        const entry = this.inputsPending.get(frame.requestId);
        if (entry === undefined)
            return;
        if (entry.deviceId !== origin.deviceId
            || entry.connectionId !== origin.connectionId
            || entry.nodeEpoch !== origin.nodeEpoch)
            return;
        if (!this.currentBinding(entry, origin))
            return;
        clearTimeout(entry.timer);
        this.inputsPending.delete(frame.requestId);
        entry.resolve({
            ok: true,
            runtimeEpoch: frame.runtimeEpoch,
            highWatermark: frame.highWatermark,
            cards: frame.cards,
        });
    }
    currentBinding(entry, origin) {
        const slot = this.options.registry.get(entry.deviceId);
        return origin.deviceId === entry.deviceId
            && slot !== undefined
            && (slot.connectionId ?? UNBOUND_CONNECTION_ID) === origin.connectionId
            && (slot.nodeEpoch ?? UNBOUND_NODE_EPOCH) === origin.nodeEpoch;
    }
    /** 设备掉线时立刻结束发给它的指令：已发送的命令只能记为结果未知。 */
    deviceOffline(deviceId) {
        this.stripDeviceBodies(deviceId);
        for (const [commandId, entry] of [...this.pending]) {
            if (entry.deviceId !== deviceId)
                continue;
            clearTimeout(entry.timer);
            this.pending.delete(commandId);
            entry.resolve({ ok: false, status: 'outcome-unknown', code: 'device-offline' });
        }
        for (const [requestId, entry] of [...this.statusPending]) {
            if (entry.deviceId !== deviceId)
                continue;
            clearTimeout(entry.timer);
            this.statusPending.delete(requestId);
            entry.resolve({ status: 'outcome-unknown', code: 'device-offline' });
        }
        for (const [requestId, entry] of [...this.inputsPending]) {
            if (entry.deviceId !== deviceId)
                continue;
            clearTimeout(entry.timer);
            this.inputsPending.delete(requestId);
            entry.resolve({ ok: false, code: 'device-offline' });
        }
    }
    /**
     * 新连接带来 nodeEpoch：同 epoch 的普通重连保留旧索引（stale）；
     * 不同 epoch 立即丢弃旧能力（不能继续当可写），但旧会话行保留到新提交，
     * 删除通知只在原子提交时发布。
     */
    beginEpoch(deviceId, nodeEpoch) {
        const previous = this.epochs.get(deviceId);
        this.epochs.set(deviceId, nodeEpoch);
        if (previous === undefined || previous === nodeEpoch)
            return;
        this.capabilityIndex.delete(deviceId);
        // 旧代次的会话级能力同样失效，等待新提交/新的 capability.changed 重建。
        this.sessionCapabilityIndex.delete(deviceId);
        const prefix = `${deviceId}\u0000`;
        for (const key of [...this.activeTurns.keys()]) {
            if (key.startsWith(prefix))
                this.activeTurns.delete(key);
        }
        // 旧代次的待答快照不能作为新连接的当前状态返回。
        for (const [requestId, entry] of [...this.inputsPending]) {
            if (entry.deviceId !== deviceId)
                continue;
            clearTimeout(entry.timer);
            this.inputsPending.delete(requestId);
            entry.resolve({ ok: false, code: 'outcome-unknown' });
        }
    }
    /**
     * 同步提交：整台设备的会话行与能力文档一次性替换。
     * 只有校验全部通过后调用；提交过程中不 await，因此对订阅者与 HTTP 是原子的。
     */
    commitDevice(commit) {
        if (this.disposed)
            return false;
        const epoch = this.epochs.get(commit.deviceId);
        if (epoch !== undefined && epoch !== commit.nodeEpoch)
            return false;
        this.epochs.set(commit.deviceId, commit.nodeEpoch);
        const previous = new Map();
        for (const [key, row] of this.index) {
            if (row.deviceId === commit.deviceId)
                previous.set(key, row);
        }
        const next = new Map();
        for (const row of commit.rows) {
            const key = `${commit.deviceId}\u0000${row.agent}\u0000${row.sessionId}`;
            next.set(key, {
                deviceId: commit.deviceId,
                agent: row.agent,
                sessionId: row.sessionId,
                running: row.running,
                updatedAt: row.updatedAt,
                ...(row.blank === undefined ? {} : { blank: row.blank }),
                ...(row.title === undefined ? {} : { title: row.title }),
                ...(row.ownership === undefined ? {} : { ownership: row.ownership }),
                ...(row.counts === undefined ? {} : { counts: row.counts }),
            });
        }
        const removed = [...previous.entries()].filter(([key]) => !next.has(key));
        const changed = [...next.entries()].filter(([key, row]) => !sameSessionRow(previous.get(key), row));
        const previousCapabilities = this.capabilityIndex.get(commit.deviceId);
        const capabilities = new Map();
        for (const [agent, document] of Object.entries(commit.capabilities)) {
            const clean = publicCapability(document);
            if (clean !== undefined)
                capabilities.set(agent, clean);
        }
        for (const [key] of removed) {
            this.index.delete(key);
            this.activeTurns.delete(key);
        }
        for (const [key, row] of changed)
            this.index.set(key, row);
        this.capabilityIndex.set(commit.deviceId, capabilities);
        // 会话级能力必须随同步一起重建：先用 agent 文档作保守回退，
        // 具体会话差异由后续 capability.changed 覆盖，绝不保留旧代次的文档。
        const sessionCapabilities = new Map();
        for (const row of next.values()) {
            const document = capabilities.get(row.agent);
            if (document !== undefined) {
                sessionCapabilities.set(`${row.agent}\u0000${row.sessionId}`, document);
            }
        }
        this.sessionCapabilityIndex.set(commit.deviceId, sessionCapabilities);
        // 删除与新/变更都在同一轮同步代码内发布；失败路径不会走到这里。
        // 这些是 hub 派生通知，不回放进历史（重连屏障会重新取索引/能力）。
        for (const [, row] of removed) {
            this.fanout({
                v: 2, type: 'event', deviceId: commit.deviceId, agent: row.agent, sessionId: row.sessionId,
                nodeEpoch: commit.nodeEpoch, seq: 0, ts: this.options.now(), kind: 'session.removed', payload: {},
            }, undefined);
        }
        for (const [, row] of changed) {
            this.fanout(this.sessionEvent(row, commit.nodeEpoch), undefined);
        }
        for (const [agent, document] of capabilities) {
            if (stableCapability(previousCapabilities?.get(agent)) === stableCapability(document))
                continue;
            for (const [, row] of next) {
                if (row.agent !== agent)
                    continue;
                this.fanout({
                    v: 2, type: 'event', deviceId: commit.deviceId, agent, sessionId: row.sessionId,
                    nodeEpoch: commit.nodeEpoch, seq: 0, ts: this.options.now(), kind: 'capability.changed',
                    payload: document,
                }, undefined);
            }
        }
        return true;
    }
    /** 已提交的能力文档；没有提交过的 agent 不会出现。 */
    capabilities(deviceId) {
        const out = {};
        const map = this.capabilityIndex.get(deviceId);
        if (map === undefined)
            return out;
        for (const [agent, document] of map)
            out[agent] = document;
        return out;
    }
    /** 某会话最近一次投影后的能力文档；返回副本，未知会话返回 undefined。 */
    sessionCapability(deviceId, agent, sessionId) {
        const document = this.sessionCapabilityIndex.get(deviceId)
            ?.get(`${agent}\u0000${sessionId}`);
        return document === undefined ? undefined : { ...document };
    }
    /** 停止接收新指令：清定时器、以固定错误结束所有等待中的指令、清空并关闭历史。幂等。 */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.buffer.dispose();
        const waiting = [...this.pending.values()];
        this.pending.clear();
        const waitingStatus = [...this.statusPending.values()];
        this.statusPending.clear();
        const waitingInputs = [...this.inputsPending.values()];
        this.inputsPending.clear();
        this.idempotency.clear();
        for (const entry of waiting) {
            clearTimeout(entry.timer);
            entry.resolve(disposedOutcome());
        }
        for (const entry of waitingStatus) {
            clearTimeout(entry.timer);
            entry.resolve({ status: 'outcome-unknown', code: 'disposed' });
        }
        for (const entry of waitingInputs) {
            clearTimeout(entry.timer);
            entry.resolve({ ok: false, code: 'disposed' });
        }
    }
    sessionEvent(row, nodeEpoch) {
        return {
            v: 2, type: 'event', deviceId: row.deviceId, agent: row.agent, sessionId: row.sessionId,
            nodeEpoch, seq: 0, ts: this.options.now(), kind: 'session.updated',
            payload: {
                running: row.running,
                updatedAt: row.updatedAt,
                ...(row.blank === undefined ? {} : { blank: row.blank }),
                ...(row.title === undefined ? {} : { title: row.title }),
                ...(row.ownership === undefined ? {} : { ownership: row.ownership }),
                ...(row.counts === undefined ? {} : { counts: row.counts }),
            },
        };
    }
    /** 单个订阅者抛错不影响其它订阅者，也不影响调用方。 */
    fanout(event, cursor) {
        for (const consumer of [...this.consumers]) {
            try {
                consumer(event, cursor);
            }
            catch { /* 忽略单个订阅者的失败 */ }
        }
    }
    /**
     * 记录会话索引并扇出；索引只存设备/agent/sessionId/运行态/所有权/计数，
     * 标题仅来自已过滤的内容帧；不存 cwd 或正文。省略字段保留旧值；turn 事件只在已有行上改运行态。
     *
     * 先 append 再扇出：缓存是唯一可回放来源，只有缓存接纳的事件才带游标。
     * 交互帧（input.*）与非白名单载荷会被 buffer 拒收，因此没有 id 行。
     */
    publish(event) {
        const appended = this.buffer.append(event);
        const key = `${event.deviceId}\u0000${event.agent}\u0000${event.sessionId}`;
        this.epochs.set(event.deviceId, event.nodeEpoch);
        const payload = event.kind === 'session.removed'
            ? {}
            : asRecord(event.payload) ?? {};
        if (event.kind === 'session.removed') {
            this.index.delete(key);
            this.activeTurns.delete(key);
            this.sessionCapabilityIndex.get(event.deviceId)?.delete(`${event.agent}\u0000${event.sessionId}`);
        }
        else if (event.kind === 'session.updated') {
            const previous = this.index.get(key);
            const running = typeof payload.running === 'boolean' ? payload.running : previous?.running;
            const updatedAt = typeof payload.updatedAt === 'number'
                && Number.isInteger(payload.updatedAt) && payload.updatedAt >= 0
                ? payload.updatedAt
                : previous?.updatedAt ?? event.ts;
            const blank = typeof payload.blank === 'boolean' ? payload.blank : previous?.blank;
            const title = typeof payload.title === 'string' ? payload.title.slice(0, 160) : previous?.title;
            const ownership = typeof payload.ownership === 'string'
                ? payload.ownership.slice(0, 32)
                : previous?.ownership;
            const counts = indexCounts(payload.counts) ?? previous?.counts;
            this.index.set(key, {
                deviceId: event.deviceId, agent: event.agent, sessionId: event.sessionId,
                running: running === true, updatedAt,
                ...(blank === undefined ? {} : { blank }),
                ...(title === undefined ? {} : { title }),
                ...(ownership === undefined ? {} : { ownership }),
                ...(counts === undefined ? {} : { counts }),
            });
        }
        else if (event.kind === 'turn.started' || event.kind === 'turn.completed') {
            // 没有会话行时绝不用 turn 事件凭空创建状态。
            const row = this.index.get(key);
            const turnId = typeof payload.turnId === 'string'
                ? payload.turnId
                : typeof payload.turn === 'string' ? payload.turn : undefined;
            if (row !== undefined) {
                if (event.kind === 'turn.started') {
                    if (turnId !== undefined)
                        this.activeTurns.set(key, turnId);
                    if (!row.running)
                        this.index.set(key, { ...row, running: true });
                }
                else {
                    const state = typeof payload.state === 'string' ? payload.state : 'completed';
                    const active = this.activeTurns.get(key);
                    // 迟到的 A.completed 不能结束已经开始的 B；没有 turnId 时按当前活动回合处理。
                    if (state !== 'running' && (turnId === undefined || active === undefined || active === turnId)) {
                        if (row.running)
                            this.index.set(key, { ...row, running: false });
                        if (turnId === undefined || active === turnId)
                            this.activeTurns.delete(key);
                    }
                }
            }
        }
        else if (event.kind === 'capability.changed') {
            const document = publicCapability(payload.capability ?? payload);
            if (document !== undefined) {
                let map = this.capabilityIndex.get(event.deviceId);
                if (map === undefined) {
                    map = new Map();
                    this.capabilityIndex.set(event.deviceId, map);
                }
                map.set(event.agent, document);
                // 会话级文档与 agent 级文档同源；页面按 sessionId 渲染当前值/待阅读。
                let sessions = this.sessionCapabilityIndex.get(event.deviceId);
                if (sessions === undefined) {
                    sessions = new Map();
                    this.sessionCapabilityIndex.set(event.deviceId, sessions);
                }
                sessions.set(`${event.agent}\u0000${event.sessionId}`, document);
            }
        }
        this.fanout(event, appended.cursor);
    }
    /** 只返回注册表里仍存在设备的会话，设备断线后不再残留。 */
    sessions(deviceId) {
        return [...this.index.values()].filter(row => (deviceId === undefined || row.deviceId === deviceId) && this.options.registry.get(row.deviceId) !== undefined);
    }
    /** 设备是否仍在注册表中；回放/暂存时据此跳过已经消失的设备。 */
    isDeviceKnown(deviceId) {
        return this.options.registry.get(deviceId) !== undefined;
    }
    subscribe(consumer) {
        if (!this.consumers.has(consumer) && this.consumers.size >= MAX_SUBSCRIBERS) {
            throw new Error('relay: too many subscribers');
        }
        this.consumers.add(consumer);
        return () => { this.consumers.delete(consumer); };
    }
    /** hub 实例 epoch；与 hello.ack 的 hubEpoch、缓存游标前缀同源。 */
    historyEpoch() {
        return this.historyEpochValue;
    }
    /** 当前高水位游标；没有可回放事件时为 `${epoch}:0`。 */
    historyCursor() {
        return this.buffer.cursor();
    }
    /** 权威当前代次：publish/beginEpoch/commit 都先更新它，再扇出或允许回放。 */
    nodeEpoch(deviceId) {
        return this.epochs.get(deviceId);
    }
    /** cursor 省略 = 只做 live 对齐；未知/过期/跨 epoch 游标由 buffer 标 gap。 */
    historyRead(cursor) {
        return this.buffer.read(cursor);
    }
    /** 内容授权收紧：删除该设备全部可回放历史，返回删除条数。 */
    purgeHistory(deviceId) {
        // 即使没有可删事件也要推进代次：暂存队列里可能还留着该设备的旧帧。
        this.purgeGenerations.set(deviceId, this.purgeGeneration(deviceId) + 1);
        this.stripDeviceBodies(deviceId);
        for (const [key, row] of this.index) {
            if (row.deviceId === deviceId && row.title !== undefined) {
                const { title: _title, ...metadata } = row;
                this.index.set(key, metadata);
            }
        }
        return this.buffer.purgeDevice(deviceId);
    }
    /** 该设备的内容清理代次；从未清理过时为 0。 */
    purgeGeneration(deviceId) {
        return this.purgeGenerations.get(deviceId) ?? 0;
    }
}
