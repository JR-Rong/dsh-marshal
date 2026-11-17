import { PreCallRejection } from "../adapters/types.js";
const WIRE_BY_OWNERSHIP = {
    'writer-busy': 'writer-busy',
    'ownership-unverified': 'ownership-unverified',
    'stale-runtime': 'stale-connection',
    'turn-unbound': 'stale-connection',
    'turn-mismatch': 'stale-connection',
};
/** 稳定的内部错误分类；wire 只看到映射后的 code，消息不含会话内容。 */
export class OwnershipError extends PreCallRejection {
    name = 'OwnershipError';
    ownershipCode;
    constructor(code) {
        super(WIRE_BY_OWNERSHIP[code], code);
        this.ownershipCode = code;
    }
}
export function toWireOwnership(state, scope) {
    switch (state) {
        case 'foreign-unknown': return 'foreign-unknown';
        case 'foreign-running': return 'foreign-running';
        case 'acquiring': return 'unverified';
        case 'ours-idle':
        case 'ours-running': return scope === 'native-runtime' ? 'attached' : 'ours';
    }
}
/**
 * 每 runtimeEpoch 一个协调器。所有状态转换都是同步的；JavaScript 单线程执行
 * 本身就是锁，因此本文件从不跨 await 持有互斥量（acquire 等待上游时只保留
 * `acquiring` 标记，其余请求立即 busy 拒绝）。
 */
export function createOwnershipCoordinator(options) {
    const clock = options.now ?? Date.now;
    const owned = new Map();
    const observed = new Map();
    // 每次 acquire 一个 token：clear/release/revoke 之后旧的在途结果不能再落地。
    const acquiring = new Map();
    /** 租约到期即撤销：任何读取/守卫都必须先清掉过期证据再回落到观察值。 */
    const prune = (sessionId) => {
        const current = owned.get(sessionId);
        if (current === undefined)
            return;
        const expiresAt = current.evidence.expiresAt;
        if (expiresAt === undefined)
            return;
        if (expiresAt <= clock())
            owned.delete(sessionId);
    };
    const state = (sessionId) => {
        prune(sessionId);
        if (acquiring.has(sessionId))
            return 'acquiring';
        const current = owned.get(sessionId);
        if (current !== undefined)
            return current.turnActive ? 'ours-running' : 'ours-idle';
        return observed.get(sessionId) ?? 'foreign-unknown';
    };
    const controlReason = (sessionId) => {
        switch (state(sessionId)) {
            case 'foreign-unknown': return 'ownership-unverified';
            case 'foreign-running': return 'writer-busy';
            case 'acquiring': return 'writer-busy';
            case 'ours-idle':
            case 'ours-running': return undefined;
        }
    };
    const validateEvidence = (sessionId, candidate) => {
        if (candidate === undefined)
            return undefined;
        if (candidate.scope !== undefined && candidate.scope !== 'native-runtime')
            return undefined;
        if (candidate.sessionId !== sessionId)
            return undefined;
        if (typeof candidate.mechanism !== 'string' || candidate.mechanism === '')
            return undefined;
        if (typeof candidate.holder !== 'string' || candidate.holder === '')
            return undefined;
        if (candidate.runtimeEpoch !== options.runtimeEpoch)
            return undefined;
        if (!Number.isFinite(candidate.acquiredAt))
            return undefined;
        if (candidate.expiresAt !== undefined && !(candidate.expiresAt > clock()))
            return undefined;
        if (!Array.isArray(candidate.invalidatesOn) || candidate.invalidatesOn.length === 0)
            return undefined;
        if (candidate.invalidatesOn.some(entry => typeof entry !== 'string' || entry === ''))
            return undefined;
        return {
            ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
            sessionId: candidate.sessionId,
            mechanism: candidate.mechanism,
            holder: candidate.holder,
            runtimeEpoch: candidate.runtimeEpoch,
            acquiredAt: candidate.acquiredAt,
            ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
            invalidatesOn: [...candidate.invalidatesOn],
        };
    };
    return {
        runtimeEpoch: options.runtimeEpoch,
        holder: options.holder,
        state,
        ownership(sessionId) {
            return toWireOwnership(state(sessionId), owned.get(sessionId)?.evidence.scope);
        },
        evidence(sessionId) {
            prune(sessionId);
            return owned.get(sessionId)?.evidence;
        },
        controlReason,
        noteObserved(sessionId, running) {
            // acquiring 是显式动作的临时权威；并发观察不能把它改回 foreign-*。
            // 已持有 ownership 时仍记录最新观察，但有效状态由 ownership 优先决定。
            if (acquiring.has(sessionId))
                return;
            observed.set(sessionId, running ? 'foreign-running' : 'foreign-unknown');
        },
        async acquire(sessionId, acquireFn, acquireOptions = {}) {
            const current = state(sessionId);
            if (current !== 'foreign-unknown')
                throw new OwnershipError('writer-busy');
            const signal = acquireOptions.signal ?? new AbortController().signal;
            if (signal.aborted)
                throw signal.reason;
            // 必须在第一个 await 之前置位，第二个 acquire/prompt/configure 才能立即 busy。
            const token = Symbol(sessionId);
            acquiring.set(sessionId, token);
            const ownsToken = () => acquiring.get(sessionId) === token;
            // 只有仍持有 token 的结果才能落地：clear/release/revoke 已取消这次取得。
            const cancelIfStale = () => {
                if (ownsToken())
                    return;
                throw new OwnershipError('stale-runtime');
            };
            let candidate;
            try {
                candidate = await acquireFn({ sessionId, runtimeEpoch: options.runtimeEpoch, signal });
            }
            catch (error) {
                cancelIfStale();
                acquiring.delete(sessionId);
                if (signal.aborted)
                    throw signal.reason;
                if (error instanceof PreCallRejection)
                    throw error;
                throw new OwnershipError('ownership-unverified');
            }
            cancelIfStale();
            acquiring.delete(sessionId);
            if (signal.aborted)
                throw signal.reason;
            // 必须验证控制句柄及失效边界；原生恢复使用 attached，不能冒充排他。
            const evidence = validateEvidence(sessionId, candidate);
            if (evidence === undefined)
                throw new OwnershipError('ownership-unverified');
            owned.set(sessionId, { evidence, turnActive: false, configuring: false });
            const next = state(sessionId);
            const reason = controlReason(sessionId);
            return {
                sessionId,
                state: next,
                wire: toWireOwnership(next, evidence.scope),
                evidence,
                ...(reason === undefined ? {} : { reason }),
            };
        },
        beginPrompt(sessionId) {
            const current = state(sessionId);
            const session = owned.get(sessionId);
            if (current === 'ours-idle' && session !== undefined &&
                !session.configuring && !session.turnActive) {
                // 立即置 turnActive：原生 turnId 未返回前也必须拒绝第二次写入。
                owned.set(sessionId, { evidence: session.evidence, turnActive: true, configuring: false });
                return;
            }
            if (current === 'foreign-unknown')
                throw new OwnershipError('ownership-unverified');
            throw new OwnershipError('writer-busy');
        },
        bindTurn(sessionId, turnId) {
            prune(sessionId);
            const session = owned.get(sessionId);
            if (session === undefined)
                throw new OwnershipError('stale-runtime');
            if (typeof turnId !== 'string' || turnId === '')
                throw new OwnershipError('turn-unbound');
            if (session.turnId !== undefined && session.turnId !== turnId) {
                // 已被更晚的回合占用：迟到的绑定不能覆盖当前的活动回合。
                throw new OwnershipError('turn-mismatch');
            }
            owned.set(sessionId, {
                evidence: session.evidence,
                turnActive: true,
                configuring: session.configuring,
                turnId,
            });
        },
        endTurn(sessionId, turnId) {
            prune(sessionId);
            const session = owned.get(sessionId);
            if (session === undefined || !session.turnActive)
                return false;
            // 旧回合的完成事件不能清掉后来绑定的新回合；未绑定时只接受无 id 的完成。
            if (turnId !== undefined && (session.turnId === undefined || turnId !== session.turnId)) {
                return false;
            }
            owned.set(sessionId, {
                evidence: session.evidence,
                turnActive: false,
                configuring: session.configuring,
            });
            return true;
        },
        beginConfigure(sessionId) {
            const current = state(sessionId);
            const session = owned.get(sessionId);
            if (current === 'ours-idle' && session !== undefined &&
                !session.configuring && !session.turnActive) {
                owned.set(sessionId, { evidence: session.evidence, turnActive: false, configuring: true });
                return;
            }
            if (current === 'foreign-unknown')
                throw new OwnershipError('ownership-unverified');
            throw new OwnershipError('writer-busy');
        },
        endConfigure(sessionId) {
            prune(sessionId);
            const session = owned.get(sessionId);
            if (session === undefined || !session.configuring)
                return;
            owned.set(sessionId, {
                evidence: session.evidence,
                turnActive: session.turnActive,
                configuring: false,
            });
        },
        authorizeControl(sessionId, turnId) {
            const current = state(sessionId);
            const session = owned.get(sessionId);
            if (session === undefined) {
                if (current === 'foreign-running' || current === 'acquiring') {
                    throw new OwnershipError('writer-busy');
                }
                throw new OwnershipError('ownership-unverified');
            }
            // 控制动作只看活动回合身份；configuring/busy 标记不能阻塞长回合并发中的打断。
            if (!session.turnActive || session.turnId === undefined) {
                throw new OwnershipError('turn-unbound');
            }
            if (typeof turnId !== 'string' || turnId === '' || turnId !== session.turnId) {
                throw new OwnershipError('turn-mismatch');
            }
        },
        release(sessionId) {
            // 显式释放只清 ownership；观察值仍是最新事实。
            owned.delete(sessionId);
            acquiring.delete(sessionId);
        },
        revoke(sessionId) {
            // 进程退出/租约丢失：撤销控制但不伪造 idle，也不抹掉最后的观察。
            owned.delete(sessionId);
            acquiring.delete(sessionId);
        },
        clear() {
            owned.clear();
            observed.clear();
            acquiring.clear();
        },
        turn(sessionId) {
            prune(sessionId);
            const session = owned.get(sessionId);
            if (session === undefined || !session.turnActive)
                return undefined;
            return session.turnId;
        },
    };
}
