/** Numeric DSH projections only; no transcript, path or provider credentials. */
export function dshStatistics(values) {
    if (!values)
        return undefined;
    const result = {};
    const copy = (source, keys) => {
        if (!source || typeof source !== 'object' || Array.isArray(source))
            return;
        for (const [from, to] of Object.entries(keys)) {
            const value = source[from];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)
                result[to] = Math.floor(value);
        }
    };
    copy(values.sessionStats, { turns: 'turns', steps: 'steps', decodeMs: 'decodeMs', decodeTokens: 'decodeTokens' });
    copy(values.tokenUsage, { uncachedInputTokens: 'inputTokens', outputTokens: 'outputTokens', cacheReadTokens: 'cacheReadTokens', cacheWriteTokens: 'cacheWriteTokens' });
    const pressure = values.contextPressure;
    copy(pressure, { contextWindow: 'contextWindow' });
    copy({ used: pressure?.projectedTokens ?? pressure?.pressureTokens }, { used: 'contextTokens' });
    return Object.keys(result).length ? result : undefined;
}
