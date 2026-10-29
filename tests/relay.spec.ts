import { describe, expect, it, vi } from 'vitest'
import { HubRelay } from '../src/hub/relay.ts'
import { DeviceRegistry } from '../src/hub/registry.ts'

function target(device = 'mac') {
  return { device, agent: 'dsh', sessionId: 's1' }
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
    const relay = new HubRelay({ registry: new DeviceRegistry(), now: () => 0 })
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
})
