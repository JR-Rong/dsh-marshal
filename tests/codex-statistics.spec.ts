import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexTokenCounts, createCodexStatistics } from '../src/agents/codex/statistics.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const usage = (output = 50) => ({ total: { inputTokens: 100, cachedInputTokens: 60, outputTokens: output, totalTokens: 100 + output },
  last: { totalTokens: 80 }, modelContextWindow: 400 })

describe('Codex statistics', () => {
  it('preserves token totals without double-counting cache or inventing unknown fields', () => {
    expect(codexTokenCounts(usage())).toEqual({ inputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 0, outputTokens: 50,
      totalTokens: 150, contextTokens: 80, contextWindow: 400 })
    expect(codexTokenCounts({ total: { ...usage().total, cachedInputTokens: 101 } })).toBeUndefined()
    expect(codexTokenCounts({ total: { ...usage().total, outputTokens: Infinity } })).toBeUndefined()
    expect(codexTokenCounts({ total: { outputTokens: 50 } })).toBeUndefined()
  })
  it('uses output delta and complete turn duration, not cumulative output or partial timing', () => {
    const stats = createCodexStatistics()
    stats.observe('s', 'thread/tokenUsage/updated', { tokenUsage: usage(50) })
    stats.observe('s', 'turn/started', { turn: { id: 't' } })
    stats.observe('s', 'thread/tokenUsage/updated', { tokenUsage: usage(150) })
    expect(stats.get('s')?.turnMs).toBeUndefined()
    stats.observe('s', 'turn/completed', { turn: { id: 'other', durationMs: 2000 } })
    expect(stats.get('s')?.turnMs).toBeUndefined()
    stats.observe('s', 'turn/completed', { turn: { id: 't', durationMs: 2000 } })
    expect(stats.get('s')).toMatchObject({ outputTokens: 150, turnOutputTokens: 100, turnMs: 2000 })
    stats.observe('s', 'turn/started', { turn: { id: 't2' } }); stats.resetActive()
    stats.observe('s', 'turn/completed', { turn: { id: 't2', durationMs: 1 } })
    expect(stats.get('s')?.turnMs).toBe(2000)
  })
  it('reads a bounded authorized rollout tail and never exposes transcript or arbitrary paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'marshal-stats-')); dirs.push(home)
    await mkdir(join(home, 'sessions'))
    const id = '12345678-1234-1234-1234-123456789abc', file = join(home, 'sessions', `rollout-${id}.jsonl`)
    const token = (output: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: output, total_tokens: 100 + output },
      last_token_usage: { total_tokens: 70 }, model_context_window: 200 } } }) + '\n'
    const started = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't', secret: 'do not publish' } }) + '\n'
    const completed = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't', duration_ms: 1000 } }) + '\n'
    await writeFile(file, 'x'.repeat(3 * 1024 * 1024) + '\n' + token(10) + started + token(50) + completed)
    const stats = createCodexStatistics({ codexHome: home })
    await stats.refresh(id, file)
    expect(stats.get(id)).toMatchObject({ outputTokens: 50, turnOutputTokens: 40, turnMs: 1000, contextTokens: 70 })
    expect(Object.values(stats.get(id)!)).toEqual(expect.arrayContaining([50, 40, 1000]))
    expect(Object.values(stats.get(id)!).every(value => typeof value === 'number')).toBe(true)
    const outside = join(home, `outside-${id}.jsonl`); await writeFile(outside, token(999))
    await stats.refresh(id, outside)
    expect(stats.get(id)?.outputTokens).toBe(50)
  })
})
