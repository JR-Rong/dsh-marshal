import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'

export type CodexCounts = Record<string, number>
const MAX_TAIL_BYTES = 2 * 1024 * 1024
const MAX_SESSIONS = 32
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Both sources carry input inclusive of cached input; publish disjoint buckets. */
export function codexTokenCounts(value: unknown, rollout = false): CodexCounts | undefined {
  const usage = record(value), total = record(usage[rollout ? 'total_token_usage' : 'total'])
  const last = record(usage[rollout ? 'last_token_usage' : 'last'])
  const field = (camel: string, snake: string) => rollout ? snake : camel
  const input = number(total[field('inputTokens', 'input_tokens')])
  const output = number(total[field('outputTokens', 'output_tokens')])
  const cached = number(total[field('cachedInputTokens', 'cached_input_tokens')])
  const written = number(total[field('cacheWriteInputTokens', 'cache_write_input_tokens')] ?? 0)
  if (input === undefined || output === undefined || cached === undefined || written === undefined || cached + written > input) return undefined
  const result: CodexCounts = { inputTokens: input - cached - written, outputTokens: output,
    cacheReadTokens: cached, cacheWriteTokens: written }
  const copy = (key: string, value: unknown) => { const n = number(value); if (n !== undefined) result[key] = n }
  copy('totalTokens', total[field('totalTokens', 'total_tokens')])
  copy('reasoningTokens', total[field('reasoningOutputTokens', 'reasoning_output_tokens')])
  copy('contextTokens', last[field('totalTokens', 'total_tokens')])
  copy('contextWindow', usage[field('modelContextWindow', 'model_context_window')])
  return result
}

interface Entry {
  counts?: CodexCounts
  stamp?: string
  active?: { id: string; baseline?: number }
}

export function createCodexStatistics(options: {
  codexHome?: string
  onChanged?: (id: string, counts: CodexCounts) => void
} = {}) {
  const entries = new Map<string, Entry>()
  const home = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const entry = (id: string): Entry => {
    let value = entries.get(id)
    if (!value) {
      value = {}; entries.set(id, value)
      if (entries.size > MAX_SESSIONS) entries.delete(entries.keys().next().value!)
    }
    return value
  }
  const update = (id: string, counts: CodexCounts) => {
    const state = entry(id)
    if (JSON.stringify(state.counts) === JSON.stringify(counts)) return
    state.counts = counts
    options.onChanged?.(id, counts)
  }
  const observe = (id: string, method: string, params: unknown) => {
    const state = entry(id), body = record(params), turn = record(body.turn)
    if (method === 'turn/started' && typeof turn.id === 'string') {
      state.active = { id: turn.id, ...(state.counts ? { baseline: state.counts.outputTokens } : {}) }
    } else if (method === 'thread/tokenUsage/updated') {
      const counts = codexTokenCounts(body.tokenUsage)
      if (counts) update(id, { ...state.counts, ...counts })
    } else if (method === 'turn/completed' && turn.id === state.active?.id) {
      const ms = number(turn.durationMs), baseline = state.active?.baseline
      if (state.counts && baseline !== undefined && ms && state.counts.outputTokens! >= baseline) {
        update(id, { ...state.counts, turnMs: ms, turnOutputTokens: state.counts.outputTokens! - baseline })
      }
      delete state.active
    }
  }
  // Only the selected thread is refreshed. Read at most a bounded tail, and
  // retain numeric metadata only. Never walk the session directory or scan DBs.
  const refresh = async (id: string, path: string | undefined): Promise<void> => {
    if (!path || !/^[a-f0-9-]{36}$/i.test(id)) return
    const state = entry(id), before = state.counts
    try {
      const file = await realpath(path)
      if (!basename(file).endsWith(`-${id}.jsonl`)) return
      const roots = await Promise.all(['sessions', 'archived_sessions'].map(name => realpath(join(home, name)).catch(() => undefined)))
      if (!roots.some(root => {
        if (!root) return false
        const rel = relative(root, file)
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      })) return
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) return
        const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
        if (state.stamp === stamp) return
        const size = Math.min(stat.size, MAX_TAIL_BYTES), buffer = Buffer.alloc(size)
        const { bytesRead } = await handle.read(buffer, 0, size, stat.size - size)
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
        if (stat.size > size) lines.shift()
        let counts: CodexCounts | undefined
        let active: Entry['active']
        let speed: CodexCounts = {}
        for (const line of lines) {
          let event: Record<string, unknown>
          try { event = record(JSON.parse(line)) } catch { continue }
          if (event.type !== 'event_msg') continue
          const payload = record(event.payload)
          if (payload.type === 'token_count') {
            counts = codexTokenCounts(payload.info, true) ?? counts
          } else if (payload.type === 'task_started' && typeof payload.turn_id === 'string') {
            active = { id: payload.turn_id, ...(counts ? { baseline: counts.outputTokens } : {}) }
          } else if (payload.type === 'task_complete' && payload.turn_id === active?.id) {
            const ms = number(payload.duration_ms), baseline = active?.baseline
            if (counts && baseline !== undefined && ms && counts.outputTokens! >= baseline) {
              speed = { turnMs: ms, turnOutputTokens: counts.outputTokens! - baseline }
            }
            active = undefined
          }
        }
        if (state.counts !== before) return // A live notification superseded this read.
        if (counts) update(id, { ...state.counts, ...counts, ...speed })
        state.stamp = stamp
      } finally { await handle.close() }
    } catch { /* Missing/rotated/older rollout: show only independently available metrics. */ }
  }
  return { get: (id: string) => entries.get(id)?.counts, refresh, observe,
    empty: (id: string) => update(id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    resetActive: () => { for (const state of entries.values()) delete state.active },
  }
}
