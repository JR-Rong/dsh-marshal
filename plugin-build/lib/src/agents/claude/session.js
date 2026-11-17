/**
 * Claude 受管会话集合 + 每会话观察者登记。
 *
 * - 本适配器 create/fork 或显式原 ID 恢复后进入 managed，并保留恢复来源。
 * - 观察者各自持有有界队列，溢出即结束该观察者（调用方应从历史补齐），
 *   绝不无界缓存正文；正常关闭、异常退出、输入取消都走 `clear`/`closeSession`。
 * - 本文件不发起任何原生订阅：Claude 侧没有可比的多会话通知面，
 *   事件只来自我们自己的 Query 消息泵。
 */
export const CLAUDE_MAX_QUEUED_EVENTS = 2048;
function wake(listener) {
    const waiters = listener.waiters.splice(0, listener.waiters.length);
    for (const resolve of waiters)
        resolve();
}
function closeListener(listener) {
    if (listener.closed)
        return;
    // 保留已入队的终止帧：调用方需要看到 agent-crashed/session.updated 才能
    // 知道该会话已结束；队列由 maxQueued 截断，不会无限增长。
    listener.closed = true;
    wake(listener);
}
export function createClaudeSessionRegistry(options = {}) {
    const maxQueued = Math.max(1, options.maxQueuedEvents ?? CLAUDE_MAX_QUEUED_EVENTS);
    const managed = new Map();
    const listeners = new Map();
    const closeSet = (set, dropQueued = false) => {
        if (set === undefined)
            return;
        for (const listener of set) {
            if (dropQueued)
                listener.queue.length = 0;
            closeListener(listener);
        }
    };
    const publish = (sessionId, event) => {
        const set = listeners.get(sessionId);
        if (set === undefined)
            return;
        for (const listener of [...set]) {
            if (listener.closed)
                continue;
            listener.queue.push(event);
            if (listener.queue.length > maxQueued) {
                // 慢观察者不能拖垮进程内存；结束该观察者，由调用方从历史补齐。
                closeListener(listener);
                continue;
            }
            wake(listener);
        }
    };
    const observe = async function* (sessionId, signal) {
        if (signal.aborted)
            return;
        const listener = { queue: [], waiters: [], closed: false };
        let set = listeners.get(sessionId);
        if (set === undefined) {
            set = new Set();
            listeners.set(sessionId, set);
        }
        set.add(listener);
        const onAbort = () => closeListener(listener);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            while (true) {
                const next = listener.queue.shift();
                if (next !== undefined) {
                    yield next;
                    continue;
                }
                if (listener.closed)
                    return;
                await new Promise(resolve => listener.waiters.push(resolve));
            }
        }
        finally {
            signal.removeEventListener('abort', onAbort);
            set.delete(listener);
            // closeSession 之后可能已有新观察者注册到新的 set；只清理自己那一份。
            if (set.size === 0 && listeners.get(sessionId) === set)
                listeners.delete(sessionId);
            closeListener(listener);
        }
    };
    return {
        markManaged(sessionId, resumed = false) { managed.set(sessionId, resumed); },
        isResumed(sessionId) { return managed.get(sessionId) === true; },
        isManaged(sessionId) { return managed.has(sessionId); },
        managedIds() { return [...managed.keys()]; },
        publish,
        observe,
        subscriberCount(sessionId) {
            const set = listeners.get(sessionId);
            if (set === undefined)
                return 0;
            let count = 0;
            for (const listener of set)
                if (!listener.closed)
                    count += 1;
            return count;
        },
        closeSession(sessionId) {
            const set = listeners.get(sessionId);
            if (set === undefined)
                return;
            closeSet(set);
            listeners.delete(sessionId);
        },
        clear() {
            // stop 是显式销毁：未消费的帧不再有意义，直接丢弃。
            for (const set of listeners.values())
                closeSet(set, true);
            listeners.clear();
            managed.clear();
        },
    };
}
