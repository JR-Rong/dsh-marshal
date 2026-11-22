export function createMarshalEventBus() {
    const subscriptions = new Set();
    let disposed = false;
    return {
        subscribe(listener) {
            if (disposed) return () => {};
            const subscription = { listener };
            subscriptions.add(subscription);
            return () => { subscriptions.delete(subscription); };
        },
        emit(topic, payload = {}) {
            for (const subscription of [...subscriptions]) {
                if (!subscriptions.has(subscription)) continue;
                try {
                    const result = subscription.listener(topic, payload);
                    if (typeof result?.then === 'function') void Promise.resolve(result).catch(() => {});
                }
                catch { /* A subscriber must not interrupt a mutation or other listeners. */ }
            }
        },
        subscriberCount: () => subscriptions.size,
        dispose() {
            disposed = true;
            subscriptions.clear();
        },
    };
}
