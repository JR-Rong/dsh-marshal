import { describe, it, expect } from 'vitest'
import { discussionUsage, summarizeUsage } from '../src/discussions/usage.ts'
import { DiscussionUsageSchema } from '../src/discussions/types.ts'
import { DISCUSSION_SCRIPT } from '../src/hub/discussions/page.ts'
import { runInNewContext } from 'node:vm'

describe('group usage accounting', () => {
  it('normalizes disjoint DSH and inclusive Codex input without counting cache or reasoning twice', () => {
    const dsh = discussionUsage('dsh', { inputTokens: 40, cacheReadTokens: 60, outputTokens: 50, reasoningTokens: 20 }, 1000)
    const codex = discussionUsage('codex', { total: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 50, reasoningOutputTokens: 20 } }, 1000)
    expect(dsh).toEqual(codex)
    expect(codex).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150, durationMs: 1000 })
    expect(discussionUsage('dsh', { outputTokens: 30 }, 100)).toBeUndefined()
    expect(discussionUsage('codex', { total: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 5 } }, 100)).toBeUndefined()
    expect(DiscussionUsageSchema.safeParse({ ...dsh, totalTokens: 999 }).success).toBe(false)
    expect(DiscussionUsageSchema.safeParse({ ...dsh, durationMs: Infinity }).success).toBe(false)
  })
  it('sums input and output across calls and weights speed by duration; unknown is not zero', () => {
    const result = summarizeUsage([
      { state: 'completed', usage: { inputTokens: 50, outputTokens: 100, totalTokens: 150, durationMs: 1000 } },
      { state: 'failed', usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, durationMs: 9000 } },
      { state: 'completed' }, { state: 'pending' },
    ])
    expect(result).toEqual({ calls: 4, reportedCalls: 2, pendingCalls: 1, missingCalls: 1, partialCalls: 1,
      inputTokens: 150, outputTokens: 200, totalTokens: 350, durationMs: 10000 })
    const functions = DISCUSSION_SCRIPT.slice(DISCUSSION_SCRIPT.indexOf('function groupTokens('), DISCUSSION_SCRIPT.indexOf('function renderGroupUsage('))
    const ui = runInNewContext(functions + ';({groupUsageText,groupCoverage})')
    expect(ui.groupUsageText(result, true)).toBe('350 tok · 平均 20.0 tok/s')
    expect(ui.groupCoverage(result)).toBe('已上报 2/4 次 · 1 次待回报 · 1 次未上报 · 1 次非完整调用')
    expect(ui.groupUsageText(summarizeUsage([{ state: 'completed' }]), true)).toBe('用量未上报')
    expect(ui.groupCoverage(summarizeUsage([]))).toBe('尚未调用')
  })
})
