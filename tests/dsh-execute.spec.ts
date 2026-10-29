import { describe, expect, it, vi } from 'vitest'
import { createDshAdapter } from '../src/adapters/dsh/adapter.ts'
import type { EventFrame } from '../src/wire/frames.ts'

const summaries = [{ sessionId: 's1', running: false, blank: false, updatedAt: 1, cwd: '/w' }]

function surface() {
  return {
    list: vi.fn(async () => summaries),
    follow: vi.fn(async function* () {
      yield { type: 'event', event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } }
    }),
    prompt: vi.fn(async () => ({ accepted: true })),
    cancel: vi.fn(async () => ({ cancelled: true })),
  }
}

const options = { device: 'mac' }

describe('dsh adapter', () => {
  it('未知会话被拒绝并附已知列表', async () => {
    const adapter = createDshAdapter(surface(), options)
    await expect(adapter.execute({ op: 'prompt', target: { sessionId: 'ghost' }, args: { text: 'x' } }))
      .rejects.toThrow(/session-unknown: ghost, known s1/)
  })

  it('prompt 透传文本与请求 id', async () => {
    const s = surface()
    const adapter = createDshAdapter(s, options)
    await adapter.execute({ op: 'prompt', target: { sessionId: 's1' }, args: { text: 'hello', requestId: 'r1' } })
    expect(s.prompt).toHaveBeenCalledWith({ sessionId: 's1', text: 'hello', requestId: 'r1' })
  })

  it('interrupt 调 cancel', async () => {
    const s = surface()
    const adapter = createDshAdapter(s, options)
    await adapter.execute({ op: 'interrupt', target: { sessionId: 's1' } })
    expect(s.cancel).toHaveBeenCalledWith('s1')
  })

  it('answer 采纳 sink 返回 ok 的答案，并把线上数组包成 { answers }', async () => {
    const settle = vi.fn(() => 'ok' as const)
    const adapter = createDshAdapter(surface(), { device: 'mac', answers: { settle } })
    await expect(adapter.execute({
      op: 'answer', target: { sessionId: 's1' },
      args: { requestId: 'q1', answers: [{ id: 'q1', selected: ['A'] }] },
    })).resolves.toEqual({ accepted: true })
    expect(settle).toHaveBeenCalledWith('s1', 'q1', { answers: [{ id: 'q1', selected: ['A'] }] })
  })

  it('answer 未命中已知请求时抛 unknown', async () => {
    const adapter = createDshAdapter(surface(), { device: 'mac', answers: { settle: () => 'unknown' } })
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

  it('capabilities 声明 stream 与 tighten-only 思考强度', () => {
    const adapter = createDshAdapter(surface(), options)
    const capability = adapter.capabilities('s1')
    expect(capability.observe).toBe('stream')
    expect(capability.tunables.find(t => t.id === 'reasoning')?.direction).toBe('tighten-only')
  })

  it('snapshot 产出带设备名的 session.updated', async () => {
    const adapter = createDshAdapter(surface(), options)
    const events = await adapter.snapshot(new AbortController().signal)
    expect(events[0]).toMatchObject({
      v: 1, type: 'event', device: 'mac', agent: 'dsh', sessionId: 's1', seq: 1,
      kind: 'session.updated', payload: { running: false, updatedAt: 1, cwd: '/w' },
    })
  })

  it('frame 与跟随共用一个 seq 计数器', async () => {
    const adapter = createDshAdapter(surface(), options)
    expect(adapter.frame('s1', 'input.requested', { requestId: 'q1' })).toMatchObject({
      device: 'mac', agent: 'dsh', sessionId: 's1', seq: 1, kind: 'input.requested',
      payload: { requestId: 'q1' },
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
})
