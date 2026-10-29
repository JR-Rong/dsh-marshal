import { describe, expect, it, vi } from 'vitest'
import { HubRelay } from '../src/hub/relay.ts'
import { DeviceRegistry } from '../src/hub/registry.ts'

function target(device = 'mac') {
  return { device, agent: 'dsh', sessionId: 's1' }
}

function setup(ids: readonly string[] = ['mac']) {
  const registry = new DeviceRegistry()
  const sent: string[] = []
  for (const id of ids) {
    registry.attach({ id, name: id, agents: ['dsh'] }, { send: t => sent.push(t) }, 0)
  }
  return { registry, sent }
}

describe('HubRelay', () => {
  it('把指令投递给目标设备', async () => {
    const registry = new DeviceRegistry()
    const sent: string[] = []
    registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, { send: t => sent.push(t) }, 0)
    const relay = new HubRelay({ registry, now: () => 1000, timeoutMs: 50 })

    const promise = relay.command({ op: 'prompt', target: target(), args: { text: 'hi' }, idempotencyKey: 'k1' })
    const frame = JSON.parse(sent[0]!)
    expect(frame.type).toBe('command')
    expect(frame.op).toBe('prompt')

    relay.settle({ v: 1, type: 'ack', id: frame.id, ok: true, result: { accepted: true } })
    await expect(promise).resolves.toEqual({ ok: true, result: { accepted: true } })
  })

  it('目标离线直接失败', async () => {
    const relay = new HubRelay({ registry: new DeviceRegistry(), now: () => 0, timeoutMs: 50 })
    await expect(relay.command({ op: 'prompt', target: target('ghost'), args: {}, idempotencyKey: 'k' }))
      .resolves.toEqual({ ok: false, code: 'device-offline' })
  })

  it('超时失败', async () => {
    vi.useFakeTimers()
    const registry = new DeviceRegistry()
    registry.attach({ id: 'mac', name: 'Mac', agents: [] }, { send: () => {} }, 0)
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 100 })
    const promise = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'k' })
    vi.advanceTimersByTime(150)
    await expect(promise).resolves.toEqual({ ok: false, code: 'timeout' })
    vi.useRealTimers()
  })

  it('同幂等键只执行一次', async () => {
    const registry = new DeviceRegistry()
    const sent: string[] = []
    registry.attach({ id: 'mac', name: 'Mac', agents: [] }, { send: t => sent.push(t) }, 0)
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const first = relay.command({ op: 'interrupt', target: target(), args: {}, idempotencyKey: 'same' })
    relay.settle({ v: 1, type: 'ack', id: JSON.parse(sent[0]!).id, ok: true })
    await first
    await expect(relay.command({ op: 'interrupt', target: target(), args: {}, idempotencyKey: 'same' }))
      .resolves.toMatchObject({ ok: true })
    expect(sent).toHaveLength(1)
  })

  it('会话索引跟随 session.updated 与 session.removed', () => {
    const received: unknown[] = []
    const registry = new DeviceRegistry()
    registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, { send: () => {} }, 0)
    const relay = new HubRelay({ registry, now: () => 0 })
    relay.subscribe(event => received.push(event))
    const base = { v: 1, type: 'event', device: 'mac', agent: 'dsh', sessionId: 's1', ts: 't' } as const
    relay.publish({ ...base, seq: 1, kind: 'session.updated', payload: { running: true, updatedAt: 9, cwd: '/w' } })
    expect(relay.sessions('mac')).toEqual([
      { device: 'mac', agent: 'dsh', sessionId: 's1', running: true, updatedAt: 9, cwd: '/w' },
    ])
    relay.publish({ ...base, seq: 2, kind: 'session.removed', payload: {} })
    expect(relay.sessions('mac')).toEqual([])
    expect(received).toHaveLength(2)
  })

  it('dispose 拒绝未完成的指令并清理定时器', async () => {
    vi.useFakeTimers()
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 1000 })
    const first = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'a' })
    const second = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'b' })
    expect(vi.getTimerCount()).toBe(2)

    relay.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await expect(first).resolves.toEqual({ ok: false, code: 'disposed', message: 'relay: disposed' })
    await expect(second).resolves.toEqual({ ok: false, code: 'disposed', message: 'relay: disposed' })

    // 幂等：再次 dispose 不抛错。
    expect(() => relay.dispose()).not.toThrow()
    // 迟到的 ack 与后续指令都不再改变状态。
    relay.settle({ v: 1, type: 'ack', id: JSON.parse(sent[0]!).id, ok: true, result: 1 })
    await expect(relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'c' }))
      .resolves.toEqual({ ok: false, code: 'disposed', message: 'relay: disposed' })
    expect(sent).toHaveLength(2)
    vi.useRealTimers()
  })

  it('同键并发只下发一次', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const first = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'dup' })
    const second = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'dup' })
    expect(sent).toHaveLength(1)

    relay.settle({ v: 1, type: 'ack', id: JSON.parse(sent[0]!).id, ok: true, result: 7 })
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true, result: 7 }, { ok: true, result: 7 }])
    expect(sent).toHaveLength(1)
  })

  it('不同设备同键各自下发', async () => {
    const { registry, sent } = setup(['mac', 'pc'])
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const onMac = relay.command({ op: 'prompt', target: target('mac'), args: {}, idempotencyKey: 'shared' })
    const onPc = relay.command({ op: 'prompt', target: target('pc'), args: {}, idempotencyKey: 'shared' })
    expect(sent).toHaveLength(2)
    expect(sent.map(text => JSON.parse(text).target.device)).toEqual(['mac', 'pc'])

    for (const text of sent) relay.settle({ v: 1, type: 'ack', id: JSON.parse(text).id, ok: true })
    await expect(Promise.all([onMac, onPc])).resolves.toMatchObject([{ ok: true }, { ok: true }])
  })

  it('encode 失败时不留悬挂的 pending', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const circular: Record<string, unknown> = {}
    circular.self = circular

    await expect(relay.command({ op: 'prompt', target: target(), args: circular, idempotencyKey: 'bad' }))
      .rejects.toThrow()
    expect(sent).toHaveLength(0)

    // 同键重试必须重新下发，而不是复用已失败的 in-flight Promise。
    const retry = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'bad' })
    expect(sent).toHaveLength(1)
    relay.settle({ v: 1, type: 'ack', id: JSON.parse(sent[0]!).id, ok: true })
    await expect(retry).resolves.toMatchObject({ ok: true })
  })

  it('单个订阅者抛错不影响其它订阅者与调用方', () => {
    const relay = new HubRelay({ registry: new DeviceRegistry(), now: () => 0 })
    const received: unknown[] = []
    relay.subscribe(() => { throw new Error('boom') })
    relay.subscribe(event => received.push(event))
    const base = { v: 1, type: 'event', device: 'mac', agent: 'dsh', sessionId: 's1', ts: 't' } as const

    expect(() => relay.publish({ ...base, seq: 1, kind: 'turn.started', payload: {} })).not.toThrow()
    expect(received).toHaveLength(1)
  })

  it('订阅者超过 200 抛错', () => {
    const relay = new HubRelay({ registry: new DeviceRegistry(), now: () => 0 })
    const disposers: Array<() => void> = []
    for (let i = 0; i < 200; i += 1) disposers.push(relay.subscribe(() => {}))

    expect(() => relay.subscribe(() => {})).toThrow('relay: too many subscribers')
    // 退订后可以重新订阅。
    disposers[0]!()
    expect(() => relay.subscribe(() => {})).not.toThrow()
  })

  it('设备 detach 后 sessions 不再返回其会话', () => {
    const registry = new DeviceRegistry()
    registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, { send: () => {} }, 0)
    const relay = new HubRelay({ registry, now: () => 0 })
    const base = { v: 1, type: 'event', device: 'mac', agent: 'dsh', sessionId: 's1', ts: 't' } as const
    relay.publish({ ...base, seq: 1, kind: 'session.updated', payload: { running: true } })
    expect(relay.sessions()).toHaveLength(1)
    expect(relay.sessions('mac')).toHaveLength(1)

    registry.detach('mac')
    expect(relay.sessions()).toEqual([])
    expect(relay.sessions('mac')).toEqual([])
  })
})
