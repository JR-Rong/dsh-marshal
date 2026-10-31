import { describe, expect, it, vi } from 'vitest'
import { createDshAdapter } from '../src/adapters/dsh/adapter.ts'
import type { DshSurface } from '../src/adapters/dsh/surface.ts'
import type { EventFrame } from '../src/wire/frames.ts'

const summaries = [{ sessionId: 's1', running: false, blank: false, updatedAt: 1, cwd: '/w' }]

function surface(overrides: Partial<DshSurface> = {}): DshSurface {
  let turn = 0
  return {
    list: vi.fn(async () => ({ items: summaries, completeness: 'complete' as const })),
    follow: vi.fn(async function* () {
      turn += 1
      yield { type: 'event', event: { type: 'turn/start', seq: turn, time: 0, data: { turn } } }
    }),
    prompt: vi.fn(async () => ({ accepted: true })),
    ...overrides,
  }
}

const options = { deviceId: 'mac', nodeEpoch: 'epoch-1' }

describe('dsh adapter', () => {
  it('未知会话被拒绝且不泄露已知会话列表', async () => {
    const adapter = createDshAdapter(surface(), options)
    await expect(adapter.execute({ op: 'prompt', target: { sessionId: 'ghost' }, args: { text: 'x' } }))
      .rejects.toThrow(/session-unknown/)
  })

  it('清单完整性不可确认时“没找到”不能作为会话未知的证据', async () => {
    const s = surface({ list: vi.fn(async () => ({ items: [], completeness: 'unconfirmed' as const })) })
    const adapter = createDshAdapter(s, options)
    await expect(adapter.execute({ op: 'prompt', target: { sessionId: 'maybe' }, args: { text: 'x' } }))
      .resolves.toEqual({ accepted: true })
    expect(s.prompt).toHaveBeenCalled()
  })

  it('prompt 透传文本与请求 id，不自行附加 mode', async () => {
    const s = surface()
    const adapter = createDshAdapter(s, options)
    await adapter.execute({ op: 'prompt', target: { sessionId: 's1' }, args: { text: 'hello', requestId: 'r1' } })
    expect(s.prompt).toHaveBeenCalledWith({ sessionId: 's1', text: 'hello', requestId: 'r1' })
  })

  it('清单 running=true 时在调用前拒绝 writer-busy', async () => {
    const s = surface({
      list: vi.fn(async () => ({
        items: [{ sessionId: 's1', running: true, blank: false, updatedAt: 1 }],
        completeness: 'complete' as const,
      })),
    })
    const adapter = createDshAdapter(s, options)
    await expect(adapter.execute({ op: 'prompt', target: { sessionId: 's1' }, args: { text: 'x' } }))
      .rejects.toMatchObject({ name: 'PreCallRejection', code: 'writer-busy' })
    expect(s.prompt).not.toHaveBeenCalled()
  })

  it('调用后的 prompt 异常原样上抛，不伪造 writer-busy', async () => {
    const native = Object.assign(new Error('busy'), { code: 'writer-busy' })
    const s = surface({ prompt: vi.fn(async () => { throw native }) })
    const adapter = createDshAdapter(s, options)
    await expect(adapter.execute({ op: 'prompt', target: { sessionId: 's1' }, args: { text: 'x' } }))
      .rejects.toBe(native)
  })

  it('没有 cancelTurn 时 interrupt 关闭，且不调用 session-only cancel', async () => {
    const s = surface()
    const adapter = createDshAdapter(s, options)
    expect(adapter.capabilities('s1').operations.has('interrupt')).toBe(false)
    expect(adapter.capabilities('s1').unavailable?.interrupt).toBe('no-atomic-turn-binding')
    await expect(adapter.execute({ op: 'interrupt', target: { sessionId: 's1' } }))
      .rejects.toThrow(/atomic turn binding/)
  })

  it('interrupt 使用 activeTurn + cancelTurn 的原子回合绑定', async () => {
    const activeTurn = vi.fn(async () => ({ turnId: 't1' }))
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const s = surface({ activeTurn, cancelTurn })
    const adapter = createDshAdapter(s, options)
    expect(adapter.capabilities('s1').operations.has('interrupt')).toBe(true)
    await expect(adapter.execute({
      op: 'interrupt', target: { sessionId: 's1' }, args: { runtimeEpoch: 'epoch-1' },
    })).resolves.toEqual({ cancelled: true })
    expect(activeTurn).toHaveBeenCalledWith('s1')
    expect(cancelTurn).toHaveBeenCalledWith({ sessionId: 's1', turnId: 't1', runtimeEpoch: 'epoch-1' })
  })

  it('runtimeEpoch 不符时拒绝 stale-connection 且不调用原生取消', async () => {
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const adapter = createDshAdapter(surface({
      activeTurn: async () => ({ turnId: 't1' }), cancelTurn,
    }), options)
    await expect(adapter.execute({
      op: 'interrupt', target: { sessionId: 's1' }, args: { runtimeEpoch: 'epoch-old' },
    })).rejects.toMatchObject({ name: 'PreCallRejection', code: 'stale-connection' })
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it('显式 turnId 与当前回合不符时拒绝', async () => {
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const adapter = createDshAdapter(surface({
      activeTurn: async () => ({ turnId: 't2' }), cancelTurn,
    }), options)
    await expect(adapter.execute({
      op: 'interrupt', target: { sessionId: 's1' }, args: { runtimeEpoch: 'epoch-1', turnId: 't1' },
    })).rejects.toThrow(/conflict/)
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it('cancel 是问题表操作，缺 requestId 拒绝', async () => {
    const cancel = vi.fn(() => 'ok' as const)
    const adapter = createDshAdapter(surface(), { ...options, answers: { settle: () => 'ok', cancel } })
    await expect(adapter.execute({ op: 'cancel', target: { sessionId: 's1' } }))
      .rejects.toThrow(/invalid-args/)
    expect(cancel).not.toHaveBeenCalled()
    await expect(adapter.execute({ op: 'cancel', target: { sessionId: 's1' }, args: { requestId: 'q1' } }))
      .resolves.toEqual({ cancelled: true })
    expect(cancel).toHaveBeenCalledWith('s1', 'q1')
  })

  it('没有待答表时 cancel 明确 unsupported', async () => {
    const adapter = createDshAdapter(surface(), options)
    await expect(adapter.execute({ op: 'cancel', target: { sessionId: 's1' }, args: { requestId: 'q1' } }))
      .rejects.toThrow(/unsupported/)
  })

  it('answer 采纳 sink 返回 ok 的答案，并把线上数组包成 { answers }', async () => {
    const settle = vi.fn(() => 'ok' as const)
    const adapter = createDshAdapter(surface(), { ...options, answers: { settle } })
    await expect(adapter.execute({
      op: 'answer', target: { sessionId: 's1' },
      args: { requestId: 'q1', answers: [{ id: 'q1', selected: ['A'] }] },
    })).resolves.toEqual({ accepted: true })
    expect(settle).toHaveBeenCalledWith('s1', 'q1', { answers: [{ id: 'q1', selected: ['A'] }] })
  })

  it('answer 未命中已知请求时抛 unknown', async () => {
    const adapter = createDshAdapter(surface(), { ...options, answers: { settle: () => 'unknown' } })
    await expect(adapter.execute({
      op: 'answer', target: { sessionId: 's1' }, args: { requestId: 'q1', answers: [] },
    })).rejects.toThrow(/unknown:/)
  })

  it('configure 拒绝远端放宽 permission', async () => {
    const adapter = createDshAdapter(surface(), options)
    await expect(adapter.execute({
      op: 'configure', target: { sessionId: 's1' }, args: { field: 'permission', value: 'wide' },
    })).rejects.toThrow(/tighten-only/)
  })

  it('configure 只认出字段，v0 不支持修改 model', async () => {
    const adapter = createDshAdapter(surface(), options)
    await expect(adapter.execute({
      op: 'configure', target: { sessionId: 's1' }, args: { field: 'model', value: 'opus' },
    })).rejects.toThrow(/unsupported/)
  })

  it('observe 历史没有只读入口，明确 unsupported', async () => {
    const adapter = createDshAdapter(surface(), options)
    await expect(adapter.execute({ op: 'observe', target: { sessionId: 's1' } }))
      .rejects.toThrow(/history-unavailable/)
  })

  it('capabilities 分开 history/follow，七项设置只读', () => {
    const adapter = createDshAdapter(surface(), options)
    const capability = adapter.capabilities('s1')
    expect(capability.observe).toEqual({ history: false, follow: 'stream' })
    expect(capability.ownership).toBe('unverified')
    expect(capability.unavailable).toMatchObject({
      'observe.history': 'history-unavailable',
      configure: 'read-only-in-v0',
    })
    expect(capability.tunables.find(t => t.id === 'reasoning')?.direction).toBe('tighten-only')
    expect(capability.tunables.every(t => !t.editable && t.reason !== undefined)).toBe(true)
    expect(capability.tunables.map(t => t.reason)).toEqual([
      'v0-field-only', 'v0-field-only', 'v0-tighten-only',
      'v0-field-only', 'v0-field-only', 'host-config', 'host-config',
    ])
  })

  it('snapshot 不发 cwd，并为每个会话发 capability.changed', async () => {
    const adapter = createDshAdapter(surface(), options)
    const events = await adapter.snapshot(new AbortController().signal)
    expect(events.map(event => event.kind)).toEqual(['session.updated', 'capability.changed'])
    expect(events[0]).toMatchObject({
      v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1', seq: 1,
      kind: 'session.updated', payload: { running: false, updatedAt: 1, blank: false },
    })
    expect(JSON.stringify(events[0])).not.toContain('/w')
    expect(events[1]?.payload).toMatchObject({
      observe: { history: false, follow: 'stream' },
      ownership: 'unverified',
      revision: 1,
    })
    expect(adapter.snapshotCompleteness).toBe('complete')
  })

  it('snapshot 把分页不完整如实暴露给同步方', async () => {
    const adapter = createDshAdapter(surface({
      list: async () => ({ items: summaries, completeness: 'unconfirmed' }),
    }), options)
    await adapter.snapshot(new AbortController().signal)
    expect(adapter.snapshotCompleteness).toBe('unconfirmed')
  })

  it('frame 与跟随共用一个 seq 计数器', async () => {
    const adapter = createDshAdapter(surface(), options)
    expect(adapter.frame('s1', 'input.requested', { requestId: 'q1' })).toMatchObject({
      deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1', seq: 1,
      kind: 'input.requested', payload: { requestId: 'q1' },
    })
    const first: EventFrame[] = []
    for await (const event of adapter.follow('s1', new AbortController().signal)) {
      first.push(event)
      break
    }
    expect(first[0]?.seq).toBe(2)
  })

  it('同一会话的 seq 跨多次跟随仍单调', async () => {
    const adapter = createDshAdapter(surface(), options)
    const collect = async (): Promise<EventFrame[]> => {
      const out: EventFrame[] = []
      for await (const event of adapter.follow('s1', new AbortController().signal)) out.push(event)
      return out
    }
    expect((await collect())[0]?.seq).toBe(1)
    expect((await collect())[0]?.seq).toBe(2)
  })

  it('重复的完成态不重复投递，也不消耗公开 seq', async () => {
    const repeated = {
      type: 'event',
      event: {
        type: 'tool/result', seq: 2, time: 5,
        data: { turn: 1, step: 1, message: { toolCallId: 'call-1', content: [], isError: false } },
      },
    }
    const s = surface({
      follow: vi.fn(async function* () {
        yield repeated
        yield repeated
        yield { type: 'event', event: { type: 'turn/end', seq: 3, time: 6, data: { turn: 1, reason: 'completed' } } }
      }),
    })
    const adapter = createDshAdapter(s, options)
    const events: EventFrame[] = []
    for await (const event of adapter.follow('s1', new AbortController().signal)) events.push(event)
    expect(events.map(event => event.kind)).toEqual(['tool.completed', 'turn.completed'])
    expect(events.map(event => event.seq)).toEqual([1, 2])
  })
})
