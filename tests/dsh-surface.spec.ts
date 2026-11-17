import { describe, expect, it, vi } from 'vitest'
import { createDshAdapter } from '../src/adapters/dsh/adapter.ts'
import { createDshSurface, type DshSurfaceOptions } from '../src/adapters/dsh/surface.ts'
import { createFollower } from '../src/node/runner.ts'
import type { Adapter } from '../src/adapters/types.ts'
import type { SessionControllerLike, SessionSummaryLike } from '../src/dsh-types.ts'

const summary = (sessionId: string): SessionSummaryLike => ({
  sessionId, running: false, blank: false, updatedAt: 1,
})

type Page = { items: readonly SessionSummaryLike[]; nextCursor?: string | undefined }

function controller(pages: Page[], requests: Array<{ cursor?: string }> = []) {
  const queue = [...pages]
  const list = vi.fn(async (request: { cursor?: string }) => {
    requests.push({ ...(request.cursor === undefined ? {} : { cursor: request.cursor }) })
    const page = queue.shift()
    if (page === undefined) throw new Error('unexpected extra page')
    return page
  })
  const prompt = vi.fn(async (_request: Record<string, unknown>) => ({ accepted: true }))
  return {
    list,
    prompt,
    follow: async function* () {},
    cancel: vi.fn(),
    requests,
  }
}

const surfaceOf = (raw: ReturnType<typeof controller>, options: DshSurfaceOptions = {}) =>
  createDshSurface(raw as unknown as SessionControllerLike, options)

describe('dsh surface: paged list', () => {
  it('subscribes to opt-in assistant text instead of only durable completion events', async () => {
    const raw = controller([])
    const signal = new AbortController().signal
    const follow = vi.fn(async function* (request: any) {
      if (request.assistantStream) yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'reply' } } }
    })
    const surface = createDshSurface({ ...raw, follow } as unknown as SessionControllerLike)
    const events = []
    for await (const frame of surface.follow('s1', signal)) events.push(frame)
    expect(events).toHaveLength(1)
    expect(follow).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 's1' }, assistantStream: true }, signal)
  })
  it('按 cursor 遍历到终止页并保持顺序', async () => {
    const raw = controller([
      { items: [summary('s1'), summary('s2')], nextCursor: 'c1' },
      { items: [summary('s3')], nextCursor: 'c2' },
      { items: [summary('s4')] },
    ])
    const result = await surfaceOf(raw).list(new AbortController().signal)
    expect(result.items.map(item => item.sessionId)).toEqual(['s1', 's2', 's3', 's4'])
    expect(result.completeness).toBe('complete')
    expect(raw.requests).toEqual([{}, { cursor: 'c1' }, { cursor: 'c2' }])
  })

  it('终止页没有 cursor 就是完整，即使页更短', async () => {
    const raw = controller([
      { items: [summary('s1'), summary('s2')], nextCursor: 'c1' },
      { items: [summary('s3')] },
    ])
    const result = await surfaceOf(raw).list(new AbortController().signal)
    expect(result.items.map(item => item.sessionId)).toEqual(['s1', 's2', 's3'])
    expect(result.completeness).toBe('complete')
  })

  it('终止页是满页但没有 cursor 时仍算完整（页大小不是证据）', async () => {
    const fullPage = Array.from({ length: 20 }, (_, index) => summary(`s${index}`))
    const raw = controller([{ items: fullPage }])
    const result = await surfaceOf(raw).list(new AbortController().signal)
    expect(result.items).toHaveLength(20)
    expect(result.completeness).toBe('complete')
  })

  it('跨页重复 id 只保留一条，终止页缺 cursor 即完整', async () => {
    const raw = controller([
      { items: [summary('s1'), summary('s2')], nextCursor: 'c1' },
      { items: [summary('s2'), summary('s3')] },
    ])
    const result = await surfaceOf(raw).list(new AbortController().signal)
    expect(result.items.map(item => item.sessionId)).toEqual(['s1', 's2', 's3'])
    expect(result.completeness).toBe('complete')
  })

  it('页数上限触发时停止并报不完整', async () => {
    const raw = controller([
      { items: [summary('s1')], nextCursor: 'c1' },
      { items: [summary('s2')], nextCursor: 'c2' },
    ])
    const result = await surfaceOf(raw, { maxPages: 2 }).list(new AbortController().signal)
    expect(result.items.map(item => item.sessionId)).toEqual(['s1', 's2'])
    expect(result.completeness).toBe('unconfirmed')
    expect(raw.requests).toHaveLength(2)
  })

  it('会话数上限触发时不静默截断', async () => {
    const raw = controller([{ items: [summary('s1'), summary('s2')], nextCursor: 'c1' }])
    const result = await surfaceOf(raw, { maxSessions: 2 }).list(new AbortController().signal)
    expect(result.items).toHaveLength(2)
    expect(result.completeness).toBe('unconfirmed')
  })

  it('cursor 不前进时不会无限请求', async () => {
    const raw = controller([
      { items: [summary('s1')], nextCursor: 'same' },
      { items: [summary('s2')], nextCursor: 'same' },
    ])
    const result = await surfaceOf(raw).list(new AbortController().signal)
    expect(result.items).toHaveLength(2)
    expect(result.completeness).toBe('unconfirmed')
    expect(raw.requests).toHaveLength(2)
  })

  it('遍历中途取消时只报不完整，不把半份清单当全量', async () => {
    const raw = controller([])
    const abort = new AbortController()
    raw.list.mockImplementation(async () => {
      abort.abort()
      return { items: [summary('s1')], nextCursor: 'c1' }
    })
    const result = await surfaceOf(raw).list(abort.signal)
    expect(result.items.map(item => item.sessionId)).toEqual(['s1'])
    expect(result.completeness).toBe('unconfirmed')
  })

  it('已取消的 signal 不会发起任何原生调用', async () => {
    const raw = controller([{ items: [summary('s1')] }])
    const abort = new AbortController()
    abort.abort()
    await expect(surfaceOf(raw).list(abort.signal)).rejects.toThrow()
    expect(raw.list).not.toHaveBeenCalled()
  })
})

describe('dsh surface: prompt and turn binding', () => {
  it('prompt 只发 requestId/sessionId/content，不带 mode', async () => {
    const raw = controller([])
    const surface = surfaceOf(raw)
    await surface.prompt({ sessionId: 's1', text: 'hi', requestId: 'r1' })
    expect(raw.prompt).toHaveBeenCalledWith(
      { requestId: 'r1', sessionId: 's1', content: [{ type: 'text', text: 'hi' }] },
      expect.anything(),
    )
    const sent = raw.prompt.mock.calls[0]?.[0] as Record<string, unknown>
    expect('mode' in sent).toBe(false)
  })

  it('prompt 原生异常原样上抛，surface 不自行分类', async () => {
    const raw = controller([])
    const native = Object.assign(new Error('busy'), { code: 'writer-busy' })
    raw.prompt.mockRejectedValueOnce(native)
    await expect(surfaceOf(raw).prompt({ sessionId: 's1', text: 'x', requestId: 'r1' }))
      .rejects.toBe(native)
  })

  it('控制器没有 cancelTurn 时 surface 不暴露 cancelTurn/activeTurn', () => {
    const raw = controller([])
    const surface = surfaceOf(raw)
    expect(surface.cancelTurn).toBeUndefined()
    expect(surface.activeTurn).toBeUndefined()
    // session-only cancel 不再被包装成表面能力。
    expect('cancel' in surface).toBe(false)
  })

  it('控制器提供回合绑定时原样透传 runtimeEpoch', async () => {
    const raw = controller([])
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    Object.assign(raw, {
      activeTurn: vi.fn(async () => ({ turnId: 't1' })),
      cancelTurn,
    })
    const surface = surfaceOf(raw)
    await expect(surface.activeTurn?.('s1')).resolves.toEqual({ turnId: 't1' })
    await expect(surface.cancelTurn?.({ sessionId: 's1', turnId: 't1', runtimeEpoch: 'e' }))
      .resolves.toEqual({ cancelled: true })
    expect(cancelTurn).toHaveBeenCalledWith({ sessionId: 's1', turnId: 't1', runtimeEpoch: 'e' })
  })
})

describe('dsh surface: refcounted subscriptions', () => {
  function harness() {
    let starts = 0
    let aborts = 0
    const adapter = {
      agent: 'dsh',
      follow: async function* (_sessionId: string, signal: AbortSignal) {
        starts += 1
        try {
          yield { marker: starts }
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        } finally {
          aborts += 1
        }
      },
    } as unknown as Adapter
    const follower = createFollower({ adapter, send: () => {}, logger: { warn() {} } })
    return { follower, starts: () => starts, aborts: () => aborts }
  }
  const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
  const caller = 'op\u0000conn-1'

  it('同一 id 同调用者重复订阅是幂等的，只启动一条原生跟随', async () => {
    const h = harness()
    expect(h.follower.subscribe('s1', 'sub-a', caller)).toBe('ok')
    expect(h.follower.subscribe('s1', 'sub-a', caller)).toBe('ok')
    await flush()
    expect(h.starts()).toBe(1)
  })

  it('两个 tab 用不同 id 订阅，互不取消，最后一个退出才释放原生跟随', async () => {
    const h = harness()
    expect(h.follower.subscribe('s1', 'sub-a', caller)).toBe('ok')
    expect(h.follower.subscribe('s1', 'sub-b', caller)).toBe('ok')
    await flush()
    expect(h.starts()).toBe(1)

    expect(h.follower.unsubscribe('s1', 'sub-a', caller)).toBe(true)
    await flush()
    expect(h.aborts()).toBe(0)

    expect(h.follower.unsubscribe('s1', 'sub-b', caller)).toBe(true)
    await flush()
    expect(h.aborts()).toBe(1)
    expect(h.follower.has('s1')).toBe(false)
  })

  it('不同调用者复用已有 id 是 conflict，未知 id 的取消被拒绝', async () => {
    const h = harness()
    expect(h.follower.subscribe('s1', 'sub-a', caller)).toBe('ok')
    expect(h.follower.subscribe('s1', 'sub-a', 'op\u0000conn-2')).toBe('conflict')
    await flush()
    expect(h.follower.unsubscribe('s1', 'forged', caller)).toBe(false)
    expect(h.follower.has('s1')).toBe(true)
  })

  it('断线只清该调用者的 id，卸载清空全部', async () => {
    const h = harness()
    h.follower.subscribe('s1', 'sub-a', caller)
    h.follower.subscribe('s2', 'sub-b', caller)
    h.follower.subscribe('s1', 'sub-c', 'op\u0000conn-2')
    await flush()
    expect(h.starts()).toBe(2)

    h.follower.unsubscribeCaller(caller)
    await flush()
    expect(h.follower.has('s1')).toBe(true)
    expect(h.follower.has('s2')).toBe(false)

    h.follower.stopAll()
    await flush()
    expect(h.follower.has('s1')).toBe(false)
    expect(h.aborts()).toBe(2)
  })
})

describe('dsh adapter: list verification', () => {
  it('prompt 用完整清单校验会话，不泄露清单内容', async () => {
    const raw = controller([{ items: [summary('s1')] }])
    const surface = surfaceOf(raw)
    const adapter = createDshAdapter(surface, { deviceId: 'mac', nodeEpoch: 'e' })
    await expect(adapter.execute({ op: 'prompt', target: { sessionId: 'ghost' }, args: { text: 'x' } }))
      .rejects.toThrow('marshal: session-unknown: session-unknown')
  })

  it('清单里 running=true 时在调用前拒绝 writer-busy', async () => {
    const running = { ...summary('s1'), running: true }
    const raw = controller([{ items: [running] }])
    const surface = surfaceOf(raw)
    const adapter = createDshAdapter(surface, { deviceId: 'mac', nodeEpoch: 'e' })
    await expect(adapter.execute({ op: 'prompt', target: { sessionId: 's1' }, args: { text: 'x' } }))
      .rejects.toMatchObject({ name: 'PreCallRejection', code: 'writer-busy' })
    expect(raw.prompt).not.toHaveBeenCalled()
  })

  it('清单不完整且没找到会话时不预判 session-unknown，交给原生', async () => {
    const raw = controller([])
    raw.list.mockResolvedValue({ items: [], nextCursor: 'c1' })
    const surface = createDshSurface(raw as unknown as SessionControllerLike, { maxPages: 1 })
    // maxPages=1 且还有 cursor ⇒ 完整性不可确认。
    const adapter = createDshAdapter(surface, { deviceId: 'mac', nodeEpoch: 'e' })
    await expect(adapter.execute({ op: 'prompt', target: { sessionId: 'maybe' }, args: { text: 'x' } }))
      .resolves.toEqual({ accepted: true })
    expect(raw.prompt).toHaveBeenCalled()
  })
})
