function scopeKey(scope) {
    return [scope.deviceId, scope.agent, scope.sessionId, scope.nodeEpoch].join('\u0000');
}
/**
 * 公开 seq 只在投影与过滤之后分配，键为
 * `(deviceId, agent, sessionId, nodeEpoch)`。
 * 被隐私层丢弃的帧不占号，分片帧按输出顺序取连续号。
 */
export function createSeqAllocator() {
    const counters = new Map();
    let peak = 0;
    return {
        next(scope) {
            const key = scopeKey(scope);
            const value = (counters.get(key) ?? 0) + 1;
            counters.set(key, value);
            if (value > peak)
                peak = value;
            return value;
        },
        highWatermark(scope) {
            if (scope === undefined)
                return peak;
            return counters.get(scopeKey(scope)) ?? 0;
        },
    };
}
/** 覆盖适配器预分配的 seq；仅在投影完成之后调用。 */
export function withPublicSeq(allocator, frame) {
    return { ...frame, seq: allocator.next(frame) };
}
