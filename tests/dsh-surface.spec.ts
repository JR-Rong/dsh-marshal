import { describe, expect, it, vi } from 'vitest'
import { createDshAdapter } from '../src/adapters/dsh/adapter.ts'
import {
  NativeWriterBusyError, createDshSurface, type DshSurfaceOptions,
} from '../src/adapters/dsh/surface.ts'
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

  it('终止页是满页且没有 cursor 时报完整性不可确认', async () => {
    const fullPage = Array.from({ length: 20 }, (_, index) => summary(`s${index}`))
    const raw = controller([{ items: fullPage }])
    const result = await surfaceOf(raw).list(new AbortController().signal)
    expect(result.items).toHaveLength(20)
    expect(result.completeness).toBe('unconfirmed')
  })

  it('终止页与已观测最大页同宽时报不完整，跨页重复 id 只保留一条', async () => {
    const raw = controller([
      { items: [summary('s1'), summary('s2')], nextCursor: 'c1' },
      { items: [summary('s2'), summary('s3')] },
    ])
    const result = await surfaceOf(raw, { pageSizeFloor: 2 }).list(new AbortController().signal)
    expect(result.items.map(item => item.sessionId)).toEqual(['s1', 's2', 's3'])
    expect(result.completeness).toBe('unconfirmed')
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

  it('结构化忙拒绝映射为 NativeWriterBusyError', async () => {
    const raw = controller([])
    raw.prompt.mockRejectedValueOnce({ code: 'writer-busy' })
    await expect(surfaceOf(raw).prompt({ sessionId: 's1', text: 'x', requestId: 'r1' }))
      .rejects.toBeInstanceOf(NativeWriterBusyError)
  })

  it('没有结构码的异常不按忙处理', async () => {
    const raw = controller([])
    const native = new Error('session is busy')
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

  it('控制器提供回合绑定时原样透传', async () => {
    const raw = controller([])
    Object.assign(raw, {
      activeTurn: vi.fn(async () => ({ turnId: 't1' })),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
    })
    const surface = surfaceOf(raw)
    await expect(surface.activeTurn?.('s1')).resolves.toEqual({ turnId: 't1' })
    await expect(surface.cancelTurn?.({ sessionId: 's1', turnId: 't1' })).resolves.toEqual({ cancelled: true })
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

  it('同一观察者重复订阅拿到同一个 id，只启动一条原生跟随', async () => {
    const h = harness()
    const first = h.follower.subscribe('s1', 'op\u0000conn-1')
    const second = h.follower.subscribe('s1', 'op\u0000conn-1')
    await flush()
    expect(second).toBe(first)
    expect(h.starts()).toBe(1)
  })

  it('不同观察者各自持有 id，最后一个退出才释放原生跟随', async () => {
    const h = harness()
    const a = h.follower.subscribe('s1', 'op\u0000conn-1')
    const b = h.follower.subscribe('s1', 'op\u0000conn-2')
    await flush()
    expect(b).not.toBe(a)
    expect(h.starts()).toBe(1)

    expect(h.follower.unsubscribe('s1', 'op\u0000conn-1', a)).toBe(true)
    await flush()
    expect(h.aborts()).toBe(0)
    expect(h.follower.subscriptionOf('s1', 'op\u0000conn-2')).toBe(b)

    expect(h.follower.unsubscribe('s1', 'op\u0000conn-2', b)).toBe(true)
    await flush()
    expect(h.aborts()).toBe(1)
    expect(h.follower.has('s1')).toBe(false)
  })

  it('错误 id 或未持有引用的取消被拒绝', async () => {
    const h = harness()
    h.follower.subscribe('s1', 'op\u0000conn-1')
    await flush()
    expect(h.follower.unsubscribe('s1', 'op\u0000conn-1', 'forged')).toBe(false)
    expect(h.follower.unsubscribe('s1', 'op\u0000conn-2', 'forged')).toBe(false)
    expect(h.follower.has('s1')).toBe(true)
  })

  it('断线只清该连接的引用，卸载清空全部', async () => {
    const h = harness()
    h.follower.subscribe('s1', 'op\u0000conn-1')
    h.follower.subscribe('s2', 'op\u0000conn-1')
    h.follower.subscribe('s1', 'op\u0000conn-2')
    await flush()
    expect(h.starts()).toBe(2)

    h.follower.unsubscribeObserver('op\u0000conn-1')
    await flush()
    expect(h.follower.has('s1')).toBe(true)
    expect(h.follower.has('s2')).toBe(false)
    expect(h.follower.subscriptionOf('s1', 'op\u0000conn-2')).toBeDefined()

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
})
