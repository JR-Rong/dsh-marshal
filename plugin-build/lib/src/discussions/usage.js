import { dshStatistics } from "../adapters/dsh/statistics.js";
import { codexTokenCounts } from "../agents/codex/statistics.js";
import { DiscussionUsageSchema } from "./types.js";
/** Source usage samples are cumulative snapshots, not increments. */
export function discussionUsage(agent, sample, durationMs) {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample))
        return undefined;
    const value = sample;
    const counts = agent === 'codex' ? codexTokenCounts(value) : dshStatistics({ tokenUsage: {
            uncachedInputTokens: value.inputTokens, outputTokens: value.outputTokens,
            cacheReadTokens: value.cacheReadTokens ?? 0, cacheWriteTokens: value.cacheWriteTokens ?? 0,
        } });
    if (!counts || ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some(key => counts[key] === undefined))
        return undefined;
    const inputTokens = counts.inputTokens + counts.cacheReadTokens + counts.cacheWriteTokens;
    const outputTokens = counts.outputTokens;
    const parsed = DiscussionUsageSchema.safeParse({ inputTokens, outputTokens,
        totalTokens: inputTokens + outputTokens, durationMs: Math.max(0, Math.round(durationMs)) });
    return parsed.success ? parsed.data : undefined;
}
export function summarizeUsage(calls) {
    const reported = calls.filter((call) => call.usage !== undefined);
    const pendingCalls = calls.filter(call => call.state === 'pending').length;
    return {
        calls: calls.length, reportedCalls: reported.length, pendingCalls,
        missingCalls: calls.filter(call => call.state !== 'pending' && !call.usage).length,
        partialCalls: reported.filter(call => call.state !== 'completed' && call.state !== 'pending').length,
        inputTokens: reported.reduce((sum, call) => sum + call.usage.inputTokens, 0),
        outputTokens: reported.reduce((sum, call) => sum + call.usage.outputTokens, 0),
        totalTokens: reported.reduce((sum, call) => sum + call.usage.totalTokens, 0),
        durationMs: reported.reduce((sum, call) => sum + call.usage.durationMs, 0),
    };
}
