import { randomUUID } from 'node:crypto';
import { InputTable, mapAnswer, readNativeExpiry, resolveDeadline, stillAuthorized, } from "./inputs.js";
const MAX_BLOCKED_CARDS = 64;
const MAX_DECISIONS = 8;
const MAX_TIMER_MS = 2_147_483_647;
const EMPTY_MAPPING = { questions: new Map() };
const DECLINE = { decision: 'decline' };
const CANCEL = { decision: 'cancel' };
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/** 终态 -> 对适配器的保守决定；只有 remote 携带答案。 */
function decisionOf(value, outcome) {
    if (outcome === 'remote')
        return { decision: 'answer', value };
    if (outcome === 'local' || outcome === 'cancelled')
        return CANCEL;
    return DECLINE;
}
/** 审批卡可用决策 id 集合；只接受白名单形状，其余 id 在 answer 时按非法处理。 */
function decisionMap(approval) {
    const record = asRecord(approval);
    if (record === undefined)
        return undefined;
    const raw = record.decisions;
    if (!Array.isArray(raw))
        return undefined;
    const map = new Map();
    for (const item of raw.slice(0, MAX_DECISIONS)) {
        const decision = asRecord(item);
        if (decision === undefined)
            continue;
        if (typeof decision.id !== 'string' || decision.id === '' || decision.id.length > 32)
            continue;
        if (typeof decision.label !== 'string')
            continue;
        map.set(decision.id, decision.id);
    }
    return map;
}
/**
 * wire 答案 schema 与问题共用：审批答案恰好是一题、该题 id 就是卡上的决策 id，
 * 且不带选择与文本；多一项、带 text 或伪造 id 都拒绝（不消耗请求）。
 */
function parseApprovalAnswer(value, decisions) {
    if (decisions === undefined)
        return undefined;
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const answers = record.answers;
    if (!Array.isArray(answers) || answers.length !== 1)
        return undefined;
    const item = asRecord(answers[0]);
    if (item === undefined)
        return undefined;
    if (typeof item.id !== 'string' || item.id === '')
        return undefined;
    if (!Array.isArray(item.selectedOptionIds) || item.selectedOptionIds.length !== 0)
        return undefined;
    if (item.text !== undefined)
        return undefined;
    return decisions.has(item.id) ? item.id : undefined;
}
/**
 * Codex/Claude 共用的 node 侧交互中继：策略、卡片、期限、单次结算都在这里，
 * 适配器只负责分类原生阻塞请求并执行返回的决定。
 */
export function createInteractionRelay(options) {
    const table = new InputTable();
    const blocked = new Map();
    const sources = new Map();
    const now = options.now ?? Date.now;
    const monoNow = options.monoNow ?? (() => globalThis.performance.now());
    const available = options.available ?? (() => true);
    const stillOwned = options.stillOwned ?? (() => true);
    let disposed = false;
    const policyOf = (kind) => kind === 'approval' ? options.approvalRelay : options.questionRelay;
    const timeoutOf = (kind) => kind === 'approval' ? options.approvalTimeoutMs : options.questionTimeoutMs;
    /** 当前授权按 kind 组合出 relay 字段；未握手时整体缺失。 */
    const currentAuth = (kind) => {
        const current = options.authorization();
        if (current === undefined)
            return undefined;
        return {
            relay: policyOf(kind),
            operatorId: current.operatorId,
            policyRevision: current.policyRevision,
            allowInteractions: current.allowInteractions,
            content: current.content,
        };
    };
    const pruneBlocked = () => {
        const at = now();
        for (const [requestId, card] of blocked) {
            if (card.expiresAt <= at)
                blocked.delete(requestId);
        }
        while (blocked.size > MAX_BLOCKED_CARDS) {
            const first = blocked.keys().next().value;
            if (first === undefined)
                break;
            blocked.delete(first);
        }
    };
    const rememberBlocked = (requestId, kind, sessionId, expiresAt, authorization) => {
        pruneBlocked();
        blocked.set(requestId, { kind, sessionId, expiresAt, authorization });
    };
    /** 卡片 payload 已是投影结果，直接交给 link；失败只影响本次决定。 */
    const emitRequested = (sessionId, payload) => {
        try {
            options.send(options.frame(sessionId, 'input.requested', payload));
            return true;
        }
        catch {
            return false;
        }
    };
    /** notify 只发 body-less 的 session.updated waitKind，不注册可答卡。 */
    const emitWaiting = (sessionId, kind) => {
        const projected = options.projector.event(options.frame(sessionId, 'session.updated', { waitKind: kind }));
        for (const event of projected) {
            try {
                options.send(event);
            }
            catch { /* 通知发不出去不影响本地决定 */ }
        }
    };
    const emitResolved = (sessionId, requestId, outcome) => {
        const state = outcome === 'remote'
            ? 'answered'
            : outcome === 'declined'
                ? 'declined'
                : outcome === 'timeout' || outcome === 'expired'
                    ? 'expired'
                    : outcome === 'invalidated' ? 'invalidated' : 'cancelled';
        // 终态只带标识与原因，仍走 projector 白名单，答案正文不能从这条出口漏出。
        const projected = options.projector.event(options.frame(sessionId, 'input.resolved', { requestId, state }));
        for (const event of projected) {
            try {
                options.send(event);
            }
            catch {
                return;
            }
        }
    };
    const settleApproval = (entry, value) => {
        const id = parseApprovalAnswer(value, entry.decisions);
        if (id === undefined)
            return 'invalid';
        if (id === 'accept') {
            entry.finish('accept', 'remote');
            return 'ok';
        }
        if (id === 'decline') {
            entry.finish(undefined, 'declined');
            return 'ok';
        }
        if (id === 'cancel') {
            entry.finish(undefined, 'cancelled');
            return 'ok';
        }
        return 'invalid';
    };
    return {
        async claim(input, signal) {
            const kind = input.kind;
            // 已卸载/已取消/离线/失去写权都不能认领，否则会留下无法结算的原生等待。
            if (disposed || signal.aborted)
                return DECLINE;
            if (!available() || !stillOwned(input.sessionId))
                return DECLINE;
            const policy = policyOf(kind);
            if (policy === 'off')
                return DECLINE;
            const authorization = currentAuth(kind);
            if (authorization === undefined)
                return DECLINE;
            // remote 还要求 hub 侧 allowInteractions；任一侧缺失按 off，绝不外发正文。
            if (policy === 'remote' && !authorization.allowInteractions)
                return DECLINE;
            if (policy === 'notify') {
                emitWaiting(input.sessionId, kind);
                return DECLINE;
            }
            const createdAt = now();
            const mono = monoNow();
            // 缺省 nativeExpiry 必须按 none 读取；显式传 undefined 会被当成不可验证形状。
            const native = input.nativeExpiry === undefined
                ? 'none'
                : readNativeExpiry({ nativeExpiry: input.nativeExpiry });
            const deadline = resolveDeadline({
                createdAt, timeoutMs: timeoutOf(kind), now: createdAt, monoNow: mono, native,
            });
            // 无可信时钟域/单位或已到期时本地回退；不建卡、不认领远端请求。
            if (deadline === undefined)
                return DECLINE;
            if (deadline.expiresAt <= createdAt || deadline.monoDeadline <= mono)
                return DECLINE;
            const requestId = `${kind === 'approval' ? 'a' : 'q'}-${randomUUID()}`;
            const card = options.projector.card({
                kind,
                requestId,
                sessionId: input.sessionId,
                runtimeEpoch: options.runtimeEpoch,
                expiresAt: deadline.expiresAt,
                ...(input.questions === undefined ? {} : { questions: input.questions }),
                ...(input.approval === undefined ? {} : { approval: input.approval }),
            });
            if (card.mode === 'off')
                return DECLINE;
            if (card.mode === 'notify') {
                emitWaiting(input.sessionId, kind);
                return DECLINE;
            }
            // 不可远答（secret/脱敏歧义/超限）：保留身份与原因，立即走保守路径。
            if (!card.answerable) {
                rememberBlocked(requestId, kind, input.sessionId, deadline.expiresAt, authorization);
                emitRequested(input.sessionId, card.payload);
                return DECLINE;
            }
            // 可答问题必须有稳定映射；缺映射等同不可远答，不能猜答案。
            if (kind === 'question' && card.mapping === undefined) {
                rememberBlocked(requestId, kind, input.sessionId, deadline.expiresAt, authorization);
                emitRequested(input.sessionId, card.payload);
                return DECLINE;
            }
            const questions = (input.questions ?? []);
            const decisions = kind === 'approval' ? decisionMap(input.approval) : undefined;
            const answer = await new Promise((resolve) => {
                let timer;
                let onAbort;
                const entry = {
                    deviceId: options.deviceId,
                    agent: options.agent,
                    runtimeEpoch: options.runtimeEpoch,
                    sessionId: input.sessionId,
                    requestId,
                    kind,
                    questions,
                    mapping: card.mapping ?? EMPTY_MAPPING,
                    ...(decisions === undefined ? {} : { decisions }),
                    authorization,
                    expiresAt: deadline.expiresAt,
                    monoDeadline: deadline.monoDeadline,
                    settled: false,
                    finish(value, outcome) {
                        if (entry.settled)
                            return;
                        entry.settled = true;
                        if (timer !== undefined)
                            clearTimeout(timer);
                        if (onAbort !== undefined)
                            signal.removeEventListener('abort', onAbort);
                        table.remove(entry);
                        sources.delete(requestId);
                        if (outcome !== undefined)
                            emitResolved(input.sessionId, requestId, outcome);
                        resolve(decisionOf(value, outcome));
                    },
                };
                table.add(entry);
                sources.set(requestId, {
                    ...(input.questions === undefined ? {} : { questions: input.questions }),
                    ...(input.approval === undefined ? {} : { approval: input.approval }),
                });
                // 单调期限决定 timer；墙钟回拨/重连都不能延长。
                const delay = Math.min(Math.max(0, entry.monoDeadline - monoNow()), MAX_TIMER_MS);
                timer = setTimeout(() => entry.finish(undefined, 'timeout'), delay);
                timer.unref?.();
                if (signal.aborted) {
                    // 认领期间已被取消：不发卡片，直接结束等待。
                    entry.finish(undefined, 'aborted');
                    return;
                }
                onAbort = () => entry.finish(undefined, 'aborted');
                signal.addEventListener('abort', onAbort, { once: true });
                // 发不出去就结束等待：清掉 pending，且不再尝试发 input.resolved。
                if (!entry.settled && !emitRequested(input.sessionId, card.payload))
                    entry.finish();
            });
            return answer;
        },
        answer(sessionId, requestId, value) {
            const denied = blocked.get(requestId);
            if (denied !== undefined) {
                // 卡片不可远答/已作废：即使 requestId 正确也不能把决定送进原生请求。
                return denied.sessionId === sessionId ? 'decision-invalid' : 'session-mismatch';
            }
            const entry = table.find(requestId);
            if (entry === undefined)
                return 'unknown';
            if (entry.sessionId !== sessionId)
                return 'session-mismatch';
            // 回答入口同步检查墙钟与单调期限；timer 未触发也不能接收过期答案。
            if (now() >= entry.expiresAt || monoNow() >= entry.monoDeadline) {
                entry.finish(undefined, 'expired');
                return 'expired';
            }
            const kind = entry.kind ?? 'question';
            // 写权丢失或授权变化时，旧卡立即作废并一次性结算原生等待。
            if (!stillOwned(sessionId) || !stillAuthorized(entry.authorization, currentAuth(kind))) {
                entry.finish(undefined, 'invalidated');
                return 'decision-invalid';
            }
            if (kind === 'approval')
                return settleApproval(entry, value);
            // 无法映射/校验的答案不消耗请求，保持等待。
            const native = mapAnswer(value, entry.mapping);
            if (native === undefined)
                return 'invalid';
            entry.finish(native, 'remote');
            return 'ok';
        },
        cancel(sessionId, requestId) {
            const denied = blocked.get(requestId);
            if (denied !== undefined) {
                if (denied.sessionId !== sessionId)
                    return 'session-mismatch';
                // 卡片本来就不能远答：取消只是让这个 requestId 不再被提及。
                blocked.delete(requestId);
                return 'ok';
            }
            const entry = table.find(requestId);
            if (entry === undefined)
                return 'unknown';
            if (entry.sessionId !== sessionId)
                return 'session-mismatch';
            if (now() >= entry.expiresAt || monoNow() >= entry.monoDeadline) {
                entry.finish(undefined, 'expired');
                return 'expired';
            }
            const kind = entry.kind ?? 'question';
            if (!stillOwned(sessionId) || !stillAuthorized(entry.authorization, currentAuth(kind))) {
                entry.finish(undefined, 'invalidated');
                return 'decision-invalid';
            }
            // 只有显式用户取消走这里；abort 不重复结算。
            entry.finish(undefined, 'local');
            return 'ok';
        },
        snapshot(sessionId) {
            if (disposed)
                return [];
            const at = now();
            const mono = monoNow();
            const cards = [];
            for (const entry of [...table.values()]) {
                // 只返回本会话/当前 runtimeEpoch 的卡；旧代次不能复活。
                if (entry.sessionId !== sessionId || entry.runtimeEpoch !== options.runtimeEpoch)
                    continue;
                if (at >= entry.expiresAt || mono >= entry.monoDeadline) {
                    entry.finish(undefined, 'expired');
                    continue;
                }
                const kind = entry.kind ?? 'question';
                if (!stillOwned(entry.sessionId) || !stillAuthorized(entry.authorization, currentAuth(kind))) {
                    entry.finish(undefined, 'invalidated');
                    continue;
                }
                const source = sources.get(entry.requestId);
                const questions = source?.questions ?? (kind === 'question' ? entry.questions : undefined);
                // 用当前投影器重投影；到期时刻沿用原值，恢复不能延长等待。
                const card = options.projector.card({
                    kind,
                    requestId: entry.requestId,
                    sessionId: entry.sessionId,
                    runtimeEpoch: entry.runtimeEpoch,
                    expiresAt: entry.expiresAt,
                    ...(questions === undefined ? {} : { questions }),
                    ...(source?.approval === undefined ? {} : { approval: source.approval }),
                });
                if (card.mode !== 'remote' || !card.answerable) {
                    entry.finish(undefined, 'invalidated');
                    continue;
                }
                cards.push(card.payload);
            }
            return cards;
        },
        revalidate() {
            if (disposed)
                return;
            for (const entry of [...table.values()]) {
                const kind = entry.kind ?? 'question';
                if (stillAuthorized(entry.authorization, currentAuth(kind)))
                    continue;
                // 记住失效的 requestId：迟到的伪造答案要明确拒绝而不是当成未知。
                rememberBlocked(entry.requestId, kind, entry.sessionId, entry.expiresAt, entry.authorization);
                entry.finish(undefined, 'invalidated');
            }
            // 失效卡只保留有界身份墓碑，直到原期限；授权改变不能马上删掉刚登记的拒绝证据。
            pruneBlocked();
        },
        invalidate() {
            if (disposed)
                return;
            table.invalidateAll('invalidated');
            blocked.clear();
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            // 卸载时连接即将关闭：只结束等待，不再发任何事件。
            table.invalidateAll();
            blocked.clear();
            sources.clear();
        },
    };
}
