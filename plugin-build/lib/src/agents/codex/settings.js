import { randomUUID } from 'node:crypto';
import { PreCallRejection } from "../../adapters/types.js";
import { decideConfigure } from "../../tunables/policy.js";
import { SettingsReadback, } from "../../tunables/readback.js";
import { CodexPeerError } from "./peer.js";
import { parseGoalClearResponse, parseGoalClearedNotification, parseGoalGetResponse, parseGoalSetResponse, parseGoalUpdatedNotification, parseThreadSettingsSnapshot, parseThreadSettingsUpdated, } from "./protocol.js";
/**
 * 保守目录：只有 goal 声明了真实回读；不提供任何模型/等级 lattice。
 * 能力文档据此生成 tunables，绝不把目录之外的设置当作已知值。
 */
export const CODEX_SETTINGS_CATALOG = {
    agent: 'codex', models: [], readback: { goal: true },
};
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function rpcRejection(error) {
    switch (error.rpcCode) {
        case -32602: return new PreCallRejection('invalid-args');
        case -32601: return new PreCallRejection('unsupported');
        default: return new PreCallRejection('conflict');
    }
}
function goalObjective(value) {
    const objective = asRecord(value)?.objective;
    return typeof objective === 'string' && objective.trim() !== '' ? objective : undefined;
}
export function createCodexSettingsPort(deps) {
    const readbacks = new Map();
    let disposed = false;
    const ensureUsable = () => {
        if (disposed)
            throw new PreCallRejection('unsupported', 'settings-readback-unavailable');
    };
    const readbackFor = (sessionId) => {
        const existing = readbacks.get(sessionId);
        if (existing !== undefined)
            return existing;
        const created = new SettingsReadback({
            ...deps.readbackOptions,
            initial: { revision: 0 },
            ...(deps.now === undefined ? {} : { now: deps.now }),
            ...(deps.readbackTimeoutMs === undefined ? {} : { timeoutMs: deps.readbackTimeoutMs }),
        });
        readbacks.set(sessionId, created);
        return created;
    };
    /** epoch → 非空会话 → 写权；任何一条不满足都在原生调用前拒绝。 */
    const authorize = (request) => {
        ensureUsable();
        if (request.runtimeEpoch !== deps.runtimeEpoch)
            throw new PreCallRejection('stale-connection');
        if (request.sessionId === '')
            throw new PreCallRejection('invalid-args', 'sessionId is required');
        if (!deps.writable(request.sessionId))
            throw new PreCallRejection('ownership-unverified');
        return readbackFor(request.sessionId);
    };
    const observeSnapshot = (readback, snapshot) => {
        if (snapshot.model !== undefined)
            readback.observe({ field: 'model', value: snapshot.model });
        if (snapshot.reasoning !== undefined)
            readback.observe({ field: 'reasoning', value: snapshot.reasoning });
        if (snapshot.permission !== undefined)
            readback.observe({ field: 'permission', value: snapshot.permission });
        if (snapshot.plan !== undefined)
            readback.observe({ field: 'plan', value: snapshot.plan });
    };
    const readSettings = async (request, signal) => {
        const readback = authorize(request);
        if (signal.aborted)
            throw signal.reason;
        let resumed;
        try {
            resumed = await deps.request('thread/resume', { threadId: request.sessionId, excludeTurns: true }, signal, parseThreadSettingsSnapshot);
        }
        catch (error) {
            // RPC 错误意味着没有受理；其它错误（超时/断连）原样上抛，绝不伪造值。
            if (error instanceof CodexPeerError && error.code === 'rpc')
                throw rpcRejection(error);
            throw error;
        }
        if (resumed.threadId !== request.sessionId) {
            // resume 成功但身份不一致：不能把别的线程设置写进本会话。
            throw new Error('marshal: codex settings thread mismatch');
        }
        let goal;
        try {
            const response = await deps.request('thread/goal/get', { threadId: request.sessionId }, signal, parseGoalGetResponse);
            goal = response.goal !== null;
        }
        catch (error) {
            if (error instanceof CodexPeerError && error.code === 'rpc')
                throw rpcRejection(error);
            throw error;
        }
        observeSnapshot(readback, resumed);
        // objective 不进入 current；这里只归一化为存在性。
        readback.observe({ field: 'goal', value: goal });
        const current = readback.snapshot().current;
        const revision = current.revision;
        const values = [];
        if (current.model !== undefined)
            values.push({ field: 'model', current: current.model, revision, confirmed: true });
        if (current.reasoning !== undefined)
            values.push({ field: 'reasoning', current: current.reasoning, revision, confirmed: true });
        if (current.permission !== undefined)
            values.push({ field: 'permission', current: current.permission, revision, confirmed: true });
        if (current.plan !== undefined)
            values.push({ field: 'plan', current: current.plan, revision, confirmed: true });
        if (current.goal !== undefined)
            values.push({ field: 'goal', current: current.goal, revision, confirmed: true });
        // 已确认状态更新完毕：让装配方发布带 current/revision 的新能力文档。
        deps.onChanged?.(request.sessionId);
        return { values, runtimeEpoch: deps.runtimeEpoch, revision };
    };
    /**
     * 原生写入 + 以 goal/get 为唯一真值。RPC 错误可安全 abort；其它错误
     * 保持 pending，由 10s 回读超时给出 pending-confirmation。
     */
    const writeGoal = async (readback, handle, requestId, threadId, objective, signal) => {
        // 原生写尚未发出：释放 waiter 并按调用前拒绝，不进入 10s 回读等待。
        if (signal.aborted) {
            handle.abort();
            throw signal.reason;
        }
        try {
            if (objective === undefined) {
                await deps.request('thread/goal/clear', { threadId }, signal, parseGoalClearResponse);
            }
            else {
                await deps.request('thread/goal/set', { threadId, objective }, signal, parseGoalSetResponse);
            }
        }
        catch (error) {
            if (error instanceof CodexPeerError && error.code === 'rpc') {
                // 写调用被明确拒绝：没有受理证据，清除 pending 后按调用前拒绝返回。
                handle.abort();
                throw rpcRejection(error);
            }
            // 超时/断连/write/aborted：写可能已生效，保持 pending 等回读超时。
            return;
        }
        let currentGoal;
        try {
            // 只认 get：set/clear 响应和请求文本都不能合成确认值。
            currentGoal = (await deps.request('thread/goal/get', { threadId }, signal, parseGoalGetResponse)).goal;
        }
        catch {
            // 写已发出后 get 失败：实际值未知，不能 abort 成“未受理”。
            return;
        }
        const exists = currentGoal !== null;
        const matches = objective === undefined
            ? !exists
            : currentGoal !== null && currentGoal.objective === objective;
        readback.confirm({
            requestId,
            field: 'goal',
            value: exists,
            ...(matches ? {} : { matches: false }),
        });
    };
    const configure = async (request, signal) => {
        const readback = authorize(request);
        if (signal.aborted)
            throw signal.reason;
        const base = readback.snapshot();
        if (request.expectedRevision !== base.current.revision) {
            throw new PreCallRejection('revision-conflict', 'settings-revision-mismatch');
        }
        // 只有仍在等待回读的请求才占用会话；超时已释放 waiter，允许手动重试（不排队）。
        const activePending = base.pending?.status === 'pending' ? base.pending : undefined;
        const decision = decideConfigure(request, {
            agent: 'codex',
            runtimeEpoch: deps.runtimeEpoch,
            state: deps.idle(request.sessionId) ? 'idle' : 'running',
            settingsRevision: base.current.revision,
            current: base.current,
            catalog: CODEX_SETTINGS_CATALOG,
            contentAuthorized: request.contentAuthorized,
            ...(activePending === undefined
                ? {}
                : { pending: { requestId: activePending.requestId, field: activePending.field } }),
        });
        if (decision.outcome === 'reject') {
            throw new PreCallRejection(decision.code, decision.reason);
        }
        // v1 只有 goal 有可验证写面；其余字段即使决策放行也不触达原生。
        if (request.field !== 'goal') {
            throw new PreCallRejection('unsupported', 'settings-readback-unavailable');
        }
        if (decision.outcome === 'no-op') {
            // 无状态变化也要让页面看到最新 revision/待确认状态。
            deps.onChanged?.(request.sessionId);
            return {
                status: 'confirmed',
                revision: base.current.revision,
                runtimeEpoch: deps.runtimeEpoch,
            };
        }
        const clear = request.value === null;
        const objective = clear ? undefined : goalObjective(request.value);
        if (!clear && objective === undefined) {
            throw new PreCallRejection('invalid-args', 'goal-objective-invalid');
        }
        deps.beginConfigure(request.sessionId);
        try {
            if (readback.snapshot().unsafe) {
                throw new PreCallRejection('conflict', 'settings-unsafe');
            }
            const requestId = randomUUID();
            // 先注册 waiter 再发原生调用：通知先于响应时不能丢确认。
            const handle = readback.begin(requestId, 'goal', clear ? false : true);
            // 预调用 abort 后 outcome 的拒绝已由抛出路径处理；这里避免悬空 unhandled。
            void handle.outcome.catch(() => { });
            await writeGoal(readback, handle, requestId, request.sessionId, objective, signal);
            const outcome = await handle.outcome;
            const snapshot = readback.snapshot();
            // confirmed 与 pending-confirmation 都发布了新的 current/pending，必须重新广播。
            deps.onChanged?.(request.sessionId);
            return {
                status: outcome.status,
                revision: snapshot.current.revision,
                runtimeEpoch: deps.runtimeEpoch,
                ...(snapshot.unsafe
                    ? { code: 'settings-unsafe' }
                    : outcome.code === undefined ? {} : { code: outcome.code }),
            };
        }
        finally {
            deps.endConfigure(request.sessionId);
        }
    };
    const observeNotification = (method, params) => {
        if (disposed)
            return;
        if (method === 'thread/settings/updated') {
            const update = parseThreadSettingsUpdated(params);
            if (update === undefined)
                return;
            const readback = readbacks.get(update.threadId);
            if (readback === undefined)
                return;
            observeSnapshot(readback, update.snapshot);
            deps.onChanged?.(update.threadId);
            return;
        }
        if (method === 'thread/goal/updated') {
            const update = parseGoalUpdatedNotification(params);
            if (update === undefined)
                return;
            // 只为已有回读的会话更新；未知会话不创建状态。
            const readback = readbacks.get(update.threadId);
            if (readback === undefined)
                return;
            readback.observe({ field: 'goal', value: true });
            deps.onChanged?.(update.threadId);
            return;
        }
        if (method === 'thread/goal/cleared') {
            const update = parseGoalClearedNotification(params);
            if (update === undefined)
                return;
            const readback = readbacks.get(update.threadId);
            if (readback === undefined)
                return;
            readback.observe({ field: 'goal', value: false });
            deps.onChanged?.(update.threadId);
        }
    };
    return {
        readSettings,
        configure,
        observeNotification,
        snapshot(sessionId) {
            return readbacks.get(sessionId)?.snapshot();
        },
        reset() {
            for (const readback of readbacks.values())
                readback.dispose();
            readbacks.clear();
        },
        dispose() {
            for (const readback of readbacks.values())
                readback.dispose();
            readbacks.clear();
            disposed = true;
        },
    };
}
