import { nextSettingsRevision } from "./policy.js";
/**
 * 设置回读的纯状态机。
 *
 * confirmed/current/revision 与 requested/pending 严格分离：请求值只进入
 * pending 记录，current 只能由关联确认或长期原生通知更新。所有时钟与定时器
 * 都可注入，测试不用真实等待 10 秒。
 *
 * 不发起原生调用、不重试、不回滚：超时只移除 waiter，迟到确认只在该字段
 * 没有更新值时采用，避免旧值覆盖同字段新确认值。settings-unsafe 是永久闩锁，
 * 恢复只能由源端人工完成。
 */
/** 契约 §9 的确认等待上限。 */
export const READBACK_TIMEOUT_MS = 10_000;
function defaultSchedule(fn, ms) {
    return setTimeout(fn, ms);
}
function defaultCancel(handle) {
    clearTimeout(handle);
}
/** 对象键顺序不参与比较；数组逐元素比较；原始值用 Object.is。 */
function deepEqual(left, right) {
    if (Object.is(left, right))
        return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
            return false;
        for (let index = 0; index < left.length; index += 1) {
            if (!deepEqual(left[index], right[index]))
                return false;
        }
        return true;
    }
    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
        return false;
    }
    const leftRecord = left;
    const rightRecord = right;
    const leftKeys = Object.keys(leftRecord);
    if (leftKeys.length !== Object.keys(rightRecord).length)
        return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(rightRecord, key))
            return false;
        if (!deepEqual(leftRecord[key], rightRecord[key]))
            return false;
    }
    return true;
}
function confirmedField(current, field) {
    switch (field) {
        case 'model': return current.model;
        case 'reasoning': return current.reasoning;
        case 'permission': return current.permission;
        case 'plan': return current.plan;
        case 'goal': return current.goal;
        case 'skill':
        case 'plugin': return undefined;
    }
}
/** goal 的 current 只保存存在性，objective 文本永不进入 ConfirmedSettings。 */
function normalizedValue(field, value) {
    if (field !== 'goal')
        return value;
    if (typeof value === 'boolean')
        return value;
    return value !== null && value !== undefined;
}
function nextConfirmed(current, field, value, revision) {
    switch (field) {
        case 'model':
            return typeof value === 'string' ? { ...current, revision, model: value } : undefined;
        case 'reasoning':
            return typeof value === 'string' ? { ...current, revision, reasoning: value } : undefined;
        case 'permission':
            return typeof value === 'object' && value !== null && !Array.isArray(value)
                ? { ...current, revision, permission: value }
                : undefined;
        case 'plan':
            return value === 'on' || value === 'off' ? { ...current, revision, plan: value } : undefined;
        case 'goal':
            return typeof value === 'boolean' ? { ...current, revision, goal: value } : undefined;
        case 'skill':
        case 'plugin':
            // skill/plugin 属于 host 配置，不在 ConfirmedSettings 内。
            return undefined;
    }
}
export class SettingsReadback {
    timeoutMs;
    now;
    schedule;
    cancel;
    current;
    pending;
    waiter;
    timer;
    /** 每个字段最近一次真实变化的版本；缺失视为 -1。 */
    fieldRevisions = new Map();
    unsafe = false;
    disposed = false;
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs ?? READBACK_TIMEOUT_MS;
        this.now = options.now ?? Date.now;
        this.schedule = options.schedule ?? defaultSchedule;
        this.cancel = options.cancel ?? defaultCancel;
        this.current = options.initial ?? { revision: 0 };
        this.timer = undefined;
    }
    /**
     * 必须在原生 setter 之前调用：先注册 waiter，避免通知先于响应时丢失确认。
     * pending 仍处于等待中时只允许一个请求；超时记录的等待资源已释放，可被新请求替换。
     */
    begin(requestId, field, requested) {
        if (this.disposed)
            throw new Error('readback: disposed');
        if (this.unsafe)
            throw new Error('readback: unsafe');
        if (this.pending?.status === 'pending')
            throw new Error('readback: pending exists');
        let resolve;
        let reject;
        const outcome = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        this.waiter = { requestId, resolve, reject };
        this.pending = {
            requestId,
            field,
            // 请求值同样归一化，否则 goal clear(null) 与确认值 false 会被误判为 mismatch。
            requested: normalizedValue(field, requested),
            requestedAt: this.now(),
            baseFieldRevision: this.fieldRevision(field),
            status: 'pending',
        };
        const handle = this.schedule(() => this.timeout(requestId), this.timeoutMs);
        // 注入的调度器若同步触发超时，等待已经结束；此时清掉刚返回的句柄。
        if (this.waiter !== undefined && this.pending?.status === 'pending') {
            this.timer = { handle };
        }
        else {
            this.cancel(handle);
        }
        return { outcome, abort: () => this.abort(requestId) };
    }
    /**
     * 关联确认。requestId 与 field 必须同时匹配，否则完全不触碰当前 pending。
     * mismatch 仍然发布实际值并推进 revision，绝不保留请求值或回滚。
     */
    confirm(input) {
        const pending = this.pending;
        if (pending === undefined
            || pending.requestId !== input.requestId
            || pending.field !== input.field) {
            return 'ignored';
        }
        if (pending.status === 'pending') {
            const waiter = this.waiter;
            this.clearTimer();
            this.waiter = undefined;
            this.applyConfirmed(input.field, input.value);
            this.pending = undefined;
            const mismatch = !this.matches(pending, input);
            // 先应用实际值再结算，保证 readback-mismatch 返回时 current 已是真实值。
            waiter?.resolve(mismatch
                ? { status: 'confirmed', revision: this.current.revision, code: 'readback-mismatch' }
                : { status: 'confirmed', revision: this.current.revision });
            return mismatch ? 'mismatch' : 'confirmed';
        }
        if (pending.status === 'readback-timeout') {
            // 只有同字段已出现更新值时才丢弃迟到确认；其他字段推进 revision 不影响。
            if (this.fieldRevision(input.field) > pending.baseFieldRevision)
                return 'ignored';
            this.applyConfirmed(input.field, input.value);
            this.pending = { ...pending, status: 'confirmed' };
            // outcome 已 resolved，不能再结算一次。
            return this.matches(pending, input) ? 'confirmed' : 'mismatch';
        }
        return 'ignored';
    }
    /**
     * 长期原生观察：没有 request 关联，因此只更新 current/revision，绝不结算 pending。
     * 返回是否发生了实际变化。
     */
    observe(input) {
        if (this.disposed)
            return false;
        return this.applyConfirmed(input.field, input.value);
    }
    /** 永久闩锁；不扩大也不回滚已确认基线，恢复由源端人工完成。 */
    markUnsafe() {
        this.unsafe = true;
    }
    /** 预调用失败路径：移除 waiter 与 pending；重复调用是无操作。 */
    abort(requestId) {
        const waiter = this.waiter;
        if (waiter === undefined || waiter.requestId !== requestId)
            return;
        this.clearTimer();
        this.waiter = undefined;
        if (this.pending?.requestId === requestId)
            this.pending = undefined;
        waiter.reject(new Error('readback: aborted'));
    }
    snapshot() {
        return {
            current: { ...this.current },
            ...(this.pending === undefined ? {} : { pending: { ...this.pending } }),
            unsafe: this.unsafe,
        };
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.clearTimer();
        const waiter = this.waiter;
        this.waiter = undefined;
        this.pending = undefined;
        waiter?.reject(new Error('readback: disposed'));
    }
    timeout(requestId) {
        const waiter = this.waiter;
        if (waiter === undefined || waiter.requestId !== requestId)
            return;
        this.clearTimer();
        this.waiter = undefined;
        const pending = this.pending;
        if (pending !== undefined && pending.requestId === requestId && pending.status === 'pending') {
            // 保留 pending 供状态查询和迟到确认；不回滚、不重试。
            this.pending = { ...pending, status: 'readback-timeout' };
        }
        waiter.resolve({
            status: 'pending-confirmation',
            code: 'readback-timeout',
            revision: this.current.revision,
        });
    }
    applyConfirmed(field, rawValue) {
        const value = normalizedValue(field, rawValue);
        if (deepEqual(confirmedField(this.current, field), value))
            return false;
        const revision = nextSettingsRevision(this.current.revision);
        const next = nextConfirmed(this.current, field, value, revision);
        if (next === undefined)
            return false;
        this.current = next;
        // 只有值真正变化才推进字段版本，供迟到确认判断是否已被同字段新值覆盖。
        this.fieldRevisions.set(field, revision);
        return true;
    }
    fieldRevision(field) {
        return this.fieldRevisions.get(field) ?? -1;
    }
    /** matches 覆盖只决定结论；current 始终只发布归一化实际值。 */
    matches(pending, input) {
        if (input.matches !== undefined)
            return input.matches;
        return deepEqual(pending.requested, normalizedValue(input.field, input.value));
    }
    clearTimer() {
        const timer = this.timer;
        if (timer === undefined)
            return;
        this.timer = undefined;
        this.cancel(timer.handle);
    }
}
