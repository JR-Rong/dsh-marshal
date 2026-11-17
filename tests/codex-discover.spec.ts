import { describe, expect, it } from 'vitest'
import {
  CODEX_MAX_PAGE_SIZE, listAllThreads, listTurnsPage, threadRow,
  type CodexRequest,
} from '../src/agents/codex/discover.ts'
import type { CodexThread } from '../src/agents/codex/protocol.ts'

interface Call {
  readonly method: string
  readonly params: Record<string, unknown>
}

function fakeRequest(
  responder: (method: string, params: Record<string, unknown>) => unknown,
): { readonly request: CodexRequest; readonly calls: Call[] } {
  const calls: Call[] = []
  const request: CodexRequest = async (method, params, _signal, parse) => {
    const record = (params ?? {}) as Record<string, unknown>
    calls.push({ method, params: record })
    const parsed = parse(responder(method, record))
    if (parsed === undefined) throw new Error(`unexpected response for ${method}`)
    return parsed
  }
  return { request, calls }
}

function thread(id: string, overrides: Partial<CodexThread> = {}): CodexThread {
  return { id, ...overrides }
}

describe('codex discovery', () => {
  it('walks every page and only reports complete on the terminal page', async () => {
    const { request, calls } = fakeRequest((_method, params) => {
      if (params.cursor === undefined) return { data: [thread('s1')], nextCursor: 'c1' }
      return { data: [thread('s2')] }
    })
    const result = await listAllThreads(request, new AbortController().signal)
    expect(result.complete).toBe(true)
    expect(result.threads.map(item => item.id)).toEqual(['s1', 's2'])
    expect(calls).toHaveLength(2)
    expect(calls[0]?.params).toMatchObject({ limit: CODEX_MAX_PAGE_SIZE, archived: false })
    expect(calls[0]?.params.cursor).toBeUndefined()
    expect(calls[1]?.params.cursor).toBe('c1')
  })

  it('reports unconfirmed when the server repeats a cursor', async () => {
    const { request, calls } = fakeRequest(() => ({ data: [], nextCursor: 'same' }))
    const result = await listAllThreads(request, new AbortController().signal)
    expect(result.complete).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('deduplicates thread ids that appear across pages', async () => {
    const { request } = fakeRequest((_method, params) => params.cursor === undefined
      ? { data: [thread('s1')], nextCursor: 'c1' }
      : { data: [thread('s1'), thread('s2')] })
    const result = await listAllThreads(request, new AbortController().signal)
    expect(result.complete).toBe(true)
    expect(result.threads.map(item => item.id)).toEqual(['s1', 's2'])
  })

  it('clamps page size and stops at the page budget without claiming completeness', async () => {
    let next = 0
    const { request, calls } = fakeRequest(() => ({ data: [], nextCursor: `c${next++}` }))
    const result = await listAllThreads(request, new AbortController().signal, {
      pageSize: 5_000,
      maxPages: 3,
    })
    expect(calls).toHaveLength(3)
    expect(calls[0]?.params.limit).toBe(CODEX_MAX_PAGE_SIZE)
    expect(result.complete).toBe(false)
  })

  it('uses the supported turn pagination shape', async () => {
    const { request, calls } = fakeRequest(() => ({
      data: [{ id: 't1', status: 'completed', items: [] }],
      nextCursor: 'n1',
    }))
    const page = await listTurnsPage(request, {
      threadId: 's1',
      cursor: 'abc',
      limit: 20,
    }, new AbortController().signal)
    expect(page.complete).toBe(false)
    expect(page.nextCursor).toBe('n1')
    expect(page.turns.map(item => item.id)).toEqual(['t1'])
    expect(calls[0]?.method).toBe('thread/turns/list')
    expect(calls[0]?.params).toMatchObject({
      threadId: 's1',
      itemsView: 'full',
      sortDirection: 'asc',
      limit: 20,
      cursor: 'abc',
    })
  })

  it('treats a terminal turn page as complete', async () => {
    const { request } = fakeRequest(() => ({ data: [] }))
    const page = await listTurnsPage(request, { threadId: 's1' }, new AbortController().signal)
    expect(page).toMatchObject({ turns: [], complete: true })
    expect(page.nextCursor).toBeUndefined()
  })

  it('projects a bounded title while leaving raw preview and cwd out', () => {
    const row = threadRow(thread('s1', {
      status: { type: 'active', activeFlags: [] },
      updatedAt: 1_700_000_000,
      preview: 'secret preview',
    }))
    expect(row).toEqual({
      sessionId: 's1',
      running: true,
      updatedAt: 1_700_000_000_000,
      blank: false,
      title: 'secret preview',
    })
  })

  it('marks a thread with no preview and no turns as blank', () => {
    const row = threadRow(thread('s2'))
    expect(row).toEqual({ sessionId: 's2', running: false, updatedAt: 0, blank: true, title: '新会话' })
  })
})
