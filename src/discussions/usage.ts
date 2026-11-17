import { dshStatistics } from '../adapters/dsh/statistics.ts'
import { codexTokenCounts } from '../agents/codex/statistics.ts'
import { DiscussionUsageSchema, type DiscussionUsage } from './types.ts'

/** Source usage samples are cumulative snapshots, not increments. */
export function discussionUsage(agent: 'dsh' | 'codex', sample: unknown, durationMs: number): DiscussionUsage | undefined {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return undefined
  const value = sample as Record<string, unknown>
  const counts = agent === 'codex' ? codexTokenCounts(value) : dshStatistics({ tokenUsage: {
    uncachedInputTokens: value.inputTokens, outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens ?? 0, cacheWriteTokens: value.cacheWriteTokens ?? 0,
  } })
  if (!counts || ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some(key => counts[key] === undefined)) return undefined
  const inputTokens = counts.inputTokens! + counts.cacheReadTokens! + counts.cacheWriteTokens!
  const outputTokens = counts.outputTokens!
  const parsed = DiscussionUsageSchema.safeParse({ inputTokens, outputTokens,
    totalTokens: inputTokens + outputTokens, durationMs: Math.max(0, Math.round(durationMs)) })
  return parsed.success ? parsed.data : undefined
}

export function summarizeUsage(calls: readonly { state: string; usage?: DiscussionUsage | undefined }[]) {
  const reported = calls.filter((call): call is typeof call & { usage: DiscussionUsage } => call.usage !== undefined)
  const pendingCalls = calls.filter(call => call.state === 'pending').length
  return {
    calls: calls.length, reportedCalls: reported.length, pendingCalls,
    missingCalls: calls.filter(call => call.state !== 'pending' && !call.usage).length,
    partialCalls: reported.filter(call => call.state !== 'completed' && call.state !== 'pending').length,
    inputTokens: reported.reduce((sum, call) => sum + call.usage.inputTokens, 0),
    outputTokens: reported.reduce((sum, call) => sum + call.usage.outputTokens, 0),
    totalTokens: reported.reduce((sum, call) => sum + call.usage.totalTokens, 0),
    durationMs: reported.reduce((sum, call) => sum + call.usage.durationMs, 0),
  }
}
