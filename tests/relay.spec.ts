import { describe, expect, it, vi } from 'vitest'
import { HubRelay } from '../src/hub/relay.ts'
import { DeviceRegistry } from '../src/hub/registry.ts'
import type { AckFrame, CommandStatusResultFrame } from '../src/wire/frames.ts'

const CONNECTION_ID = 'conn-1'
const NODE_EPOCH = 'epoch-1'

function origin(deviceId = 'mac'): { deviceId: string; connectionId: string; nodeEpoch: string } {
  return { deviceId, connectionId: CONNECTION_ID, nodeEpoch: NODE_EPOCH }
}

function attach(registry: DeviceRegistry, id: string, sent: string[] = []): void {
  registry.attach(
    { id, name: id, agents: ['dsh'] },
    { send: t => sent.push(t) },
    0,
    { connectionId: CONNECTION_ID, nodeEpoch: NODE_EPOCH },
  )
}

function target(deviceId = 'mac') {
  return { deviceId, agent: 'dsh', sessionId: 's1' }
}

function ack(commandId: string, overrides: Partial<AckFrame> = {}): AckFrame {
  return {
    v: 2, type: 'ack', commandId,
    connectionId: CONNECTION_ID, nodeEpoch: NODE_EPOCH, status: 'accepted',
    ...overrides,
  }
}

function setup(ids: readonly string[] = ['mac']) {
  const registry = new DeviceRegistry()
  const sent: string[] = []
  for (const id of ids) attach(registry, id, sent)
  return { registry, sent }
}

describe('HubRelay', () => {
  it('把指令投递给目标设备', async () => {
    const registry = new DeviceRegistry()
    const sent: string[] = []
    attach(registry, 'mac', sent)
    const relay = new HubRelay({ registry, now: () => 1000, timeoutMs: 50 })

    const promise = relay.command({ op: 'prompt', target: target(), args: { text: 'hi' }, idempotencyKey: 'k1' })
    const frame = JSON.parse(sent[0]!)
    expect(frame.type).toBe('command')
    expect(frame.op).toBe('prompt')

    relay.settle(ack(frame.commandId, { result: { accepted: true } }), origin())
    await expect(promise).resolves.toEqual({ ok: true, status: 'accepted', result: { accepted: true } })
  })

  it('accepted 带通知 code 仍按成功结算，不被缓存成失败', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const input = { op: 'prompt' as const, target: target(), args: { text: 'big' }, idempotencyKey: 'big' }

    const promise = relay.command(input)
    const frame = JSON.parse(sent[0]!)
    relay.settle(ack(frame.commandId, { code: 'result-too-large' }), origin())
    await expect(promise).resolves.toMatchObject({
      ok: true, status: 'accepted', code: 'result-too-large',
    })

    // 同键重试命中成功缓存：code 仍可见，且不会重新下发。
    await expect(relay.command(input)).resolves.toMatchObject({
      ok: true, status: 'accepted', code: 'result-too-large',
    })
    expect(sent).toHaveLength(1)
  })

  it('accepted 与 confirmed 都表示成功', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const accepted = relay.command({ op: 'prompt', target: target(), args: { text: 'a' }, idempotencyKey: 'a' })
    relay.settle(ack(JSON.parse(sent[0]!).commandId, { status: 'accepted', result: 1 }), origin())
    await expect(accepted).resolves.toEqual({ ok: true, status: 'accepted', result: 1 })

    const confirmed = relay.command({ op: 'prompt', target: target(), args: { text: 'b' }, idempotencyKey: 'b' })
    relay.settle(ack(JSON.parse(sent[1]!).commandId, { status: 'confirmed', result: 2 }), origin())
    await expect(confirmed).resolves.toEqual({ ok: true, status: 'confirmed', result: 2 })
  })

  it('rejected 缺 code 时默认 unsupported', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const promise = relay.command({ op: 'prompt', target: target(), args: { text: 'hi' }, idempotencyKey: 'r' })
    relay.settle(ack(JSON.parse(sent[0]!).commandId, { status: 'rejected' }), origin())
    await expect(promise).resolves.toEqual({ ok: false, status: 'rejected', code: 'unsupported' })
  })

  it('pending-confirmation 与 outcome-unknown 保留各自 code', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const pending = relay.command({ op: 'prompt', target: target(), args: { text: 'p' }, idempotencyKey: 'p' })
    relay.settle(ack(JSON.parse(sent[0]!).commandId, { status: 'pending-confirmation' }), origin())
    await expect(pending).resolves.toEqual({ ok: false, status: 'pending-confirmation', code: 'pending-confirmation' })

    const unknown = relay.command({ op: 'prompt', target: target(), args: { text: 'u' }, idempotencyKey: 'u' })
    relay.settle(ack(JSON.parse(sent[1]!).commandId, { status: 'outcome-unknown' }), origin())
    await expect(unknown).resolves.toEqual({ ok: false, status: 'outcome-unknown', code: 'outcome-unknown' })
  })

  it('ACK 必须匹配绑定的 connectionId/nodeEpoch，错配只计数不结算', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const promise = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'bind' })
    const commandId = JSON.parse(sent[0]!).commandId as string

    relay.settle(ack(commandId, { connectionId: 'other' }), origin())
    relay.settle(ack(commandId, { nodeEpoch: 'other' }), origin())
    relay.settle(ack(commandId), origin('pc'))
    expect(relay.rejectedAcks).toBe(3)
    expect(sent).toHaveLength(1)

    relay.settle(ack(commandId, { result: 9 }), origin())
    await expect(promise).resolves.toEqual({ ok: true, status: 'accepted', result: 9 })
  })

  it('设备重连后的旧连接 ACK 不结算新绑定', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const promise = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'old' })
    const commandId = JSON.parse(sent[0]!).commandId as string
    // 同一设备换到新连接：旧连接身份不再等于注册表当前槽位。
    registry.attach(
      { id: 'mac', name: 'mac', agents: ['dsh'] },
      { send: () => {} }, 1, { connectionId: 'conn-2', nodeEpoch: 'epoch-1' },
    )
    relay.settle(ack(commandId), origin())
    expect(relay.rejectedAcks).toBe(1)
    relay.deviceOffline('mac')
    await expect(promise).resolves.toEqual({ ok: false, status: 'outcome-unknown', code: 'device-offline' })
  })


  it('目标离线直接失败', async () => {
    const relay = new HubRelay({ registry: new DeviceRegistry(), now: () => 0, timeoutMs: 50 })
    await expect(relay.command({ op: 'prompt', target: target('ghost'), args: {}, idempotencyKey: 'k' }))
      .resolves.toEqual({ ok: false, status: 'rejected', code: 'device-offline' })
  })

  it('超时失败', async () => {
    vi.useFakeTimers()
    const registry = new DeviceRegistry()
    attach(registry, 'mac')
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 100 })
    const promise = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'k' })
    vi.advanceTimersByTime(150)
    // 发送后丢 ACK 只能是结果未知，不能当作可重试的传输失败。
    await expect(promise).resolves.toEqual({ ok: false, status: 'outcome-unknown', code: 'outcome-unknown' })
    vi.useRealTimers()
  })

  it('同幂等键只执行一次', async () => {
    const registry = new DeviceRegistry()
    const sent: string[] = []
    attach(registry, 'mac', sent)
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const first = relay.command({ op: 'interrupt', target: target(), args: {}, idempotencyKey: 'same' })
    relay.settle(ack(JSON.parse(sent[0]!).commandId), origin())
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
    const base = { v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1', ts: 1 } as const
    relay.publish({ ...base, seq: 1, kind: 'session.updated', payload: { running: true, updatedAt: 9, cwd: '/w' } })
    expect(relay.sessions('mac')).toEqual([
      { deviceId: 'mac', agent: 'dsh', sessionId: 's1', running: true, updatedAt: 9 },
    ])
    relay.publish({ ...base, seq: 2, kind: 'session.removed', payload: {} })
    expect(relay.sessions('mac')).toEqual([])
    expect(received).toHaveLength(2)
  })

  it('会话能力按 sessionId 投影且只保留有界设置结构', () => {
    const registry = new DeviceRegistry()
    registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, { send: () => {} }, 0)
    const relay = new HubRelay({ registry, now: () => 0 })
    const base = { v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1', ts: 1 } as const
    relay.publish({
      ...base, seq: 1, kind: 'capability.changed',
      payload: {
        operations: ['prompt', 'acquire', 'teleport'],
        ownership: 'ours',
        settingsRevision: 4,
        runtimeEpoch: 'epoch-1',
        pending: {
          field: 'goal', status: 'pending',
          requested: { objective: 'secret objective' }, requestedAt: 9, baseFieldRevision: 3,
        },
        tunables: [{
          id: 'permission',
          editable: true,
          values: [{ id: 'a'.repeat(80), label: 'b'.repeat(200) }],
          current: {
            approvalPolicy: 'on-request',
            sandbox: { fileSystem: 'workspace-write', network: false },
            additionalDirectories: ['/home/secret'],
            rules: 'secret rule text',
          },
        }],
      },
    })

    const document = relay.sessionCapability('mac', 'dsh', 's1')
    expect(document).toBeDefined()
    expect(document?.operations).toEqual(['prompt', 'acquire'])
    expect(document?.settingsRevision).toBe(4)
    expect(document?.runtimeEpoch).toBe('epoch-1')
    expect(document?.pending).toEqual({ field: 'goal', status: 'pending' })
    const tunables = document?.tunables as Record<string, unknown>[]
    expect(tunables).toHaveLength(1)
    expect(tunables[0]?.current).toEqual({
      approvalPolicy: 'on-request',
      sandbox: { fileSystem: 'workspace-write', network: false },
    })
    const values = tunables[0]?.values as { id: string; label: string }[]
    expect(values[0]?.id).toHaveLength(64)
    expect(values[0]?.label).toHaveLength(128)
    const serialized = JSON.stringify(document)
    expect(serialized).not.toContain('secret objective')
    expect(serialized).not.toContain('/home/secret')
    expect(serialized).not.toContain('secret rule')
    expect(relay.sessionCapability('mac', 'dsh', 'missing')).toBeUndefined()
  })

  it('session.removed 与 epoch 切换清掉会话级能力', () => {
    const registry = new DeviceRegistry()
    registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, { send: () => {} }, 0)
    const relay = new HubRelay({ registry, now: () => 0 })
    const base = { v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1', ts: 1 } as const
    const capability = { operations: ['prompt', 'acquire'], ownership: 'ours', settingsRevision: 1 }
    relay.publish({ ...base, seq: 1, kind: 'capability.changed', payload: capability })
    expect(relay.sessionCapability('mac', 'dsh', 's1')).toBeDefined()

    relay.publish({ ...base, seq: 2, kind: 'session.removed', payload: {} })
    expect(relay.sessionCapability('mac', 'dsh', 's1')).toBeUndefined()

    relay.publish({ ...base, seq: 3, kind: 'capability.changed', payload: capability })
    expect(relay.sessionCapability('mac', 'dsh', 's1')).toBeDefined()
    relay.beginEpoch('mac', 'epoch-2')
    expect(relay.sessionCapability('mac', 'dsh', 's1')).toBeUndefined()
  })

  it('commitDevice 用 agent 文档回退并覆盖旧会话能力', () => {
    const registry = new DeviceRegistry()
    registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, { send: () => {} }, 0)
    const relay = new HubRelay({ registry, now: () => 0 })
    const commit = {
      deviceId: 'mac',
      nodeEpoch: 'epoch-1',
      version: 1,
      rows: [{ agent: 'dsh', sessionId: 's1', running: false, updatedAt: 9 }],
      capabilities: { dsh: { operations: ['prompt'], ownership: 'foreign-unknown', settingsRevision: 0 } },
    }
    expect(relay.commitDevice(commit)).toBe(true)
    expect(relay.sessionCapability('mac', 'dsh', 's1')).toEqual({
      operations: ['prompt'],
      ownership: 'foreign-unknown',
      settingsRevision: 0,
    })

    const base = { v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1', ts: 1 } as const
    relay.publish({
      ...base, seq: 1, kind: 'capability.changed',
      payload: { operations: ['prompt', 'acquire'], ownership: 'ours', settingsRevision: 7 },
    })
    expect(relay.sessionCapability('mac', 'dsh', 's1')?.settingsRevision).toBe(7)

    // 下一次提交重建为 agent 级回退，旧会话级文档不残留。
    expect(relay.commitDevice({ ...commit, version: 2 })).toBe(true)
    expect(relay.sessionCapability('mac', 'dsh', 's1')?.settingsRevision).toBe(0)
    expect(relay.sessionCapability('mac', 'dsh', 's1')?.operations).toEqual(['prompt'])
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
    await expect(first).resolves.toEqual({ ok: false, status: 'outcome-unknown', code: 'disposed', message: 'relay: disposed' })
    await expect(second).resolves.toEqual({ ok: false, status: 'outcome-unknown', code: 'disposed', message: 'relay: disposed' })

    // 幂等：再次 dispose 不抛错。
    expect(() => relay.dispose()).not.toThrow()
    // 迟到的 ack 与后续指令都不再改变状态。
    relay.settle(ack(JSON.parse(sent[0]!).commandId, { result: 1 }), origin())
    await expect(relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'c' }))
      .resolves.toEqual({ ok: false, status: 'outcome-unknown', code: 'disposed', message: 'relay: disposed' })
    expect(sent).toHaveLength(2)
    vi.useRealTimers()
  })

  it('同键并发只下发一次', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const first = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'dup' })
    const second = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'dup' })
    expect(sent).toHaveLength(1)

    relay.settle(ack(JSON.parse(sent[0]!).commandId, { result: 7 }), origin())
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true, status: 'accepted', result: 7 }, { ok: true, status: 'accepted', result: 7 }])
    expect(sent).toHaveLength(1)
  })

  it('100 个同键同载荷并发只下发一次', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const calls = Array.from({ length: 100 }, () => relay.command({
      op: 'prompt', target: target(), args: { text: 'hello' }, idempotencyKey: 'burst',
    }))
    expect(sent).toHaveLength(1)
    relay.settle(ack(JSON.parse(sent[0]!).commandId, { result: { accepted: true } }), origin())
    const outcomes = await Promise.all(calls)
    expect(new Set(outcomes.map(outcome => JSON.stringify(outcome))).size).toBe(1)
    expect(outcomes[0]).toEqual({ ok: true, status: 'accepted', result: { accepted: true } })
    expect(sent).toHaveLength(1)
  })

  it('同域不同载荷返回 idempotency-conflict 且不二次下发', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const first = relay.command({ op: 'prompt', target: target(), args: { text: 'a' }, idempotencyKey: 'same' })
    await expect(relay.command({ op: 'prompt', target: target(), args: { text: 'b' }, idempotencyKey: 'same' }))
      .resolves.toEqual({ ok: false, status: 'rejected', code: 'idempotency-conflict' })
    expect(sent).toHaveLength(1)
    relay.settle(ack(JSON.parse(sent[0]!).commandId), origin())
    await expect(first).resolves.toMatchObject({ ok: true, status: 'accepted' })
  })

  it('不同 agent/session 同键不互相命中', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const first = relay.command({
      op: 'prompt', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, args: {}, idempotencyKey: 'shared',
    })
    const second = relay.command({
      op: 'prompt', target: { deviceId: 'mac', agent: 'dsh', sessionId: 's2' }, args: {}, idempotencyKey: 'shared',
    })
    const third = relay.command({
      op: 'prompt', target: { deviceId: 'mac', agent: 'other', sessionId: 's1' }, args: {}, idempotencyKey: 'shared',
    })
    expect(sent).toHaveLength(3)
    for (const text of sent) relay.settle(ack(JSON.parse(text).commandId), origin())
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3)
  })

  it('outcome-unknown 不允许同键重发', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const first = relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'unknown' })
    relay.settle(ack(JSON.parse(sent[0]!).commandId, { status: 'outcome-unknown' }), origin())
    await expect(first).resolves.toEqual({ ok: false, status: 'outcome-unknown', code: 'outcome-unknown' })
    await expect(relay.command({ op: 'prompt', target: target(), args: {}, idempotencyKey: 'unknown' }))
      .resolves.toEqual({ ok: false, status: 'outcome-unknown', code: 'outcome-unknown' })
    expect(sent).toHaveLength(1)
  })

  it('状态查询发送 command.status 并按绑定连接结算', async () => {
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const query = relay.commandStatus({ op: 'prompt', target: target(), idempotencyKey: 'k-status' })
    const frame = JSON.parse(sent[0]!) as { type: string; requestId: string; idempotencyKey: string }
    expect(frame).toMatchObject({ type: 'command.status', idempotencyKey: 'k-status' })

    const result: CommandStatusResultFrame = {
      v: 2, type: 'command.status.result', requestId: frame.requestId, status: 'accepted',
    }
    // 错连接的结果不能结算；正确绑定才生效。
    relay.settleStatus(result, { deviceId: 'mac', connectionId: 'other', nodeEpoch: NODE_EPOCH })
    expect(relay.rejectedAcks).toBe(1)
    relay.settleStatus(result, origin())
    await expect(query).resolves.toEqual({ status: 'accepted' })
    expect(sent).toHaveLength(1)
  })

  it('状态查询超时按 outcome-unknown 返回且不重发原命令', async () => {
    vi.useFakeTimers()
    const { registry, sent } = setup()
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 20 })
    const query = relay.commandStatus({ op: 'prompt', target: target(), idempotencyKey: 'k-timeout' })
    vi.advanceTimersByTime(50)
    await expect(query).resolves.toEqual({ status: 'outcome-unknown', code: 'outcome-unknown' })
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!).type).toBe('command.status')
    vi.useRealTimers()
  })

  it('不同设备同键各自下发', async () => {
    const { registry, sent } = setup(['mac', 'pc'])
    const relay = new HubRelay({ registry, now: () => 0, timeoutMs: 50 })
    const onMac = relay.command({ op: 'prompt', target: target('mac'), args: {}, idempotencyKey: 'shared' })
    const onPc = relay.command({ op: 'prompt', target: target('pc'), args: {}, idempotencyKey: 'shared' })
    expect(sent).toHaveLength(2)
    expect(sent.map(text => JSON.parse(text).target.deviceId)).toEqual(['mac', 'pc'])

    for (const text of sent) {
      const frame = JSON.parse(text) as { commandId: string; target: { deviceId: string } }
      relay.settle(ack(frame.commandId), origin(frame.target.deviceId))
    }
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
    relay.settle(ack(JSON.parse(sent[0]!).commandId), origin())
    await expect(retry).resolves.toMatchObject({ ok: true })
  })

  it('单个订阅者抛错不影响其它订阅者与调用方', () => {
    const relay = new HubRelay({ registry: new DeviceRegistry(), now: () => 0 })
    const received: unknown[] = []
    relay.subscribe(() => { throw new Error('boom') })
    relay.subscribe(event => received.push(event))
    const base = { v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1', ts: 1 } as const

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
    const base = { v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1', ts: 1 } as const
    relay.publish({ ...base, seq: 1, kind: 'session.updated', payload: { running: true } })
    expect(relay.sessions()).toHaveLength(1)
    expect(relay.sessions('mac')).toHaveLength(1)

    registry.detach('mac')
    expect(relay.sessions()).toEqual([])
    expect(relay.sessions('mac')).toEqual([])
  })
})
