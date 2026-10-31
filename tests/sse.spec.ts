import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { HubRelay } from '../src/hub/relay.ts'
import { registerMarshalRoutes } from '../src/hub/api.ts'
import type { InputsSnapshotResultFrame } from '../src/wire/frames.ts'
import { createMemoryWeb, type MemoryResponse, type MemoryWeb } from './support/memory.ts'

const TOKEN = 'test-dashboard-token-0123456789abcdef'
const AUTH = { 'x-marshal-token': TOKEN }
const ORIGIN = 'https://marshal.example'

let web: MemoryWeb | undefined
let routes: { dispose(): void } | undefined

afterEach(() => {
  routes?.dispose()
  routes = undefined
  web = undefined
})

function start(options: { writeResult?: boolean } = {}) {
  const registry = new DeviceRegistry()
  const sent: string[] = []
  registry.attach(
    { id: 'mac', name: 'Mac', agents: ['dsh'] },
    { send: text => sent.push(text) },
    0,
    { connectionId: 'conn-1', nodeEpoch: 'epoch-1' },
  )
  const relay = new HubRelay({ registry, now: Date.now, timeoutMs: 50, hubEpoch: 'hub-test' })
  const test = createMemoryWeb({ ...(options.writeResult === undefined ? {} : { writeResult: options.writeResult }) })
  routes = registerMarshalRoutes({
    webServer: test.webServer,
    registry,
    relay,
    requireToken: TOKEN,
    publicOrigin: ORIGIN,
    operatorId: 'operator-test',
    loginFailureDelayMs: 0,
  })
  web = test
  return { web: test, relay, sent, registry }
}

function publishSession(relay: HubRelay, sessionId = 's1'): void {
  relay.publish({
    v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId, nodeEpoch: 'epoch-1',
    seq: 1, ts: 1, kind: 'session.updated', payload: { running: false, updatedAt: 1 },
  })
}

function publishDelta(relay: HubRelay, seq: number, text: string, sessionId = 's1'): void {
  relay.publish({
    v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId, nodeEpoch: 'epoch-1',
    seq, ts: seq, kind: 'message.delta', payload: { text },
  })
}

/** 重连屏障会按会话索引发起 inputs.snapshot；用给定高水位立即结算。 */
async function settleSnapshot(sent: string[], relay: HubRelay, highWatermark: number): Promise<void> {
  const frame = await waitForFrame(sent, 'inputs.snapshot')
  relay.settleInputs({
    v: 2, type: 'inputs.snapshot.result', requestId: frame.requestId as string,
    runtimeEpoch: 'epoch-1', highWatermark, cards: [],
  } satisfies InputsSnapshotResultFrame, { deviceId: 'mac', connectionId: 'conn-1', nodeEpoch: 'epoch-1' })
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function waitForFrame(sent: string[], type: string): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined
  await waitFor(() => {
    found = sent
      .map(text => JSON.parse(text) as Record<string, unknown>)
      .find(frame => frame.type === type)
    return found !== undefined
  }, type)
  return found!
}

function resetPayload(response: MemoryResponse): Record<string, unknown> | undefined {
  const index = response.body.indexOf('event: reset')
  if (index < 0) return undefined
  const dataAt = response.body.indexOf('data: ', index)
  const end = response.body.indexOf('\n\n', dataAt)
  if (dataAt < 0 || end < 0) return undefined
  return JSON.parse(response.body.slice(dataAt + 'data: '.length, end)) as Record<string, unknown>
}

/** 一条流可能先发屏障 reset，再因降级补发多条 reset；按顺序全部取回。 */
function resetPayloads(response: MemoryResponse): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let index = 0
  for (;;) {
    const at = response.body.indexOf('event: reset', index)
    if (at < 0) break
    const dataAt = response.body.indexOf('data: ', at)
    const end = response.body.indexOf('\n\n', dataAt)
    if (dataAt < 0 || end < 0) break
    out.push(JSON.parse(response.body.slice(dataAt + 'data: '.length, end)) as Record<string, unknown>)
    index = end + 2
  }
  return out
}

describe('hub sse', () => {
  it('每次建连先发 reset-required，不声称正文回放', async () => {
    const { web: target } = await start()
    const { res, done } = target.start('/marshal/api/stream', { headers: AUTH })
    await waitFor(() => resetPayload(res) !== undefined, 'reset')
    const payload = resetPayload(res)
    expect(payload).toMatchObject({ required: true, hubEpoch: 'hub-test', degradedDevices: [], complete: true })
    expect(res.header('content-type')).toBe('text/event-stream')
    expect(res.header('cache-control')).toContain('no-store')
    expect(res.body.startsWith(': connected')).toBe(true)
    await done
  })

  it('快照屏障只放行高水位之后的增量', async () => {
    const { web: target, relay, sent } = start()
    publishSession(relay)
    const { res, done } = target.start('/marshal/api/stream', { headers: AUTH })
    const frame = await waitForFrame(sent, 'inputs.snapshot')
    relay.settleInputs({
      v: 2, type: 'inputs.snapshot.result', requestId: frame.requestId as string,
      runtimeEpoch: 'epoch-1', highWatermark: 10, cards: [],
    } satisfies InputsSnapshotResultFrame, { deviceId: 'mac', connectionId: 'conn-1', nodeEpoch: 'epoch-1' })
    await waitFor(() => resetPayload(res) !== undefined, 'reset')

    const event = (seq: number): void => relay.publish({
      v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1',
      seq, ts: seq, kind: 'message.delta', payload: { text: `m${seq}` },
    })
    event(5) // 屏障前已存在的旧增量：必须丢弃
    event(11) // 高水位之后：必须放行
    await waitFor(() => res.body.includes('m11'), 'new delta')
    expect(res.body).not.toContain('m5"')
    await done
  })

  it('屏障失败保持未知不可答', async () => {
    const { web: target, relay } = start()
    publishSession(relay)
    const { res, done } = target.start('/marshal/api/stream', { headers: AUTH })
    // 不结算 inputs.snapshot，relay 50ms 后按结果未知结束屏障。
    await waitFor(() => resetPayload(res) !== undefined, 'reset')
    expect(resetPayload(res)).toMatchObject({
      required: true, complete: false, degradedDevices: ['mac'],
    })
    await done
  })

  it('慢客户端有界丢弃，不无限缓冲', async () => {
    const { web: target, relay } = start({ writeResult: false })
    const { res, done } = target.start('/marshal/api/stream', { headers: AUTH })
    await waitFor(() => resetPayload(res) !== undefined, 'reset')
    const before = res.chunks.length
    for (let seq = 2; seq < 200; seq += 1) {
      relay.publish({
        v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1',
        seq, ts: seq, kind: 'message.delta', payload: { text: 'x' },
      })
    }
    await new Promise(resolve => setTimeout(resolve, 10))
    // 第一次 write 返回 false 后进入 blocked，后续增量直接丢弃。
    expect(res.chunks.length - before).toBeLessThan(5)
    await done
  })

  it('重连按 last-event-id 回放缓存事件', async () => {
    const { web: target, relay, sent } = await start()
    const first = target.start('/marshal/api/stream', { headers: AUTH })
    await waitFor(() => resetPayload(first.res) !== undefined, 'first reset')
    const cursor = resetPayload(first.res)?.cursor
    expect(typeof cursor).toBe('string')
    expect((cursor as string).startsWith('hub-test:')).toBe(true)
    first.res.destroy()
    await first.done

    publishSession(relay, 's2')
    publishDelta(relay, 2, 'replayed-missing', 's2')

    const second = target.start('/marshal/api/stream', {
      headers: { ...AUTH, 'last-event-id': cursor as string },
    })
    // s2 已进入索引，屏障必须取到输入快照；高水位 1 让 seq 2 的增量进入回放。
    await settleSnapshot(sent, relay, 1)
    await waitFor(() => resetPayload(second.res) !== undefined, 'second reset')
    expect(resetPayload(second.res)).toMatchObject({
      cursor: expect.stringMatching(/^hub-test:/),
      replay: { gap: false, truncated: false },
    })
    await waitFor(() => second.res.body.includes('replayed-missing'), 'replayed delta')
    expect(second.res.body).toContain('id: hub-test:')
    await second.done
    second.res.destroy()
  })

  it('回放的 replay.cursor 指向最后一条实际回放事件', async () => {
    const { web: target, relay, sent } = start()
    publishSession(relay)
    const cursor = relay.historyCursor()
    expect(cursor).toBe('hub-test:1')
    publishDelta(relay, 2, 'replay-two')
    publishDelta(relay, 3, 'replay-three')

    const { res, done } = target.start('/marshal/api/stream', {
      headers: { ...AUTH, 'last-event-id': cursor },
    })
    // 高水位 1 让 seq 2/3 的增量进入回放。
    await settleSnapshot(sent, relay, 1)
    await waitFor(() => resetPayload(res) !== undefined, 'reset')
    // reset.cursor 仍是快照时刻的高水位，replay.cursor 是可续读的最后一条回放。
    expect(resetPayload(res)).toMatchObject({
      cursor: 'hub-test:3',
      replay: { gap: false, truncated: false, cursor: 'hub-test:3' },
    })
    await waitFor(() => res.body.includes('replay-three'), 'replayed deltas')
    const ids = [...res.body.matchAll(/^id: (\S+)$/gm)].map(match => match[1])
    expect(ids[ids.length - 1]).toBe('hub-test:3')
    await done
    res.destroy()
  })

  it('过期或跨 epoch 游标只 reset 并报告缺口', async () => {
    const { web: target, relay } = await start()
    publishDelta(relay, 1, 'cached-should-not-replay')
    const { res, done } = target.start('/marshal/api/stream', {
      headers: { ...AUTH, 'last-event-id': 'hub-test:999999' },
    })
    await waitFor(() => resetPayload(res) !== undefined, 'reset')
    expect(resetPayload(res)).toMatchObject({
      cursor: expect.stringMatching(/^hub-test:/),
      replay: { gap: true, truncated: false },
    })
    expect(res.body).not.toContain('cached-should-not-replay')
    await done
    res.destroy()
  })

  it('回放跳过不可缓存的交互帧（query 游标）', async () => {
    const { web: target, relay } = await start()
    const first = target.start('/marshal/api/stream', { headers: AUTH })
    await waitFor(() => resetPayload(first.res) !== undefined, 'first reset')
    const cursor = resetPayload(first.res)?.cursor as string
    first.res.destroy()
    await first.done

    relay.publish({
      v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1',
      seq: 1, ts: 1, kind: 'input.requested', payload: { requestId: 'req-1' },
    })
    publishDelta(relay, 2, 'after-input')

    const { res, done } = target.start(
      `/marshal/api/stream?cursor=${encodeURIComponent(cursor)}`,
      { headers: AUTH },
    )
    await waitFor(() => resetPayload(res) !== undefined, 'reset')
    expect(resetPayload(res)).toMatchObject({ replay: { gap: false } })
    await waitFor(() => res.body.includes('after-input'), 'later delta')
    expect(res.body).not.toContain('input.requested')
    await done
    res.destroy()
  })

  it('内容撤权清空历史后旧游标变为缺口', async () => {
    const { web: target, relay } = await start()
    publishDelta(relay, 1, 'before-purge')
    const cursor = relay.historyCursor()
    expect(cursor).toBe('hub-test:1')
    publishDelta(relay, 2, 'purged-payload')
    expect(relay.purgeHistory('mac')).toBe(2)

    const { res, done } = target.start('/marshal/api/stream', {
      headers: { ...AUTH, 'last-event-id': cursor },
    })
    await waitFor(() => resetPayload(res) !== undefined, 'reset')
    expect(resetPayload(res)).toMatchObject({ replay: { gap: true } })
    expect(res.body).not.toContain('purged-payload')
    await done
    res.destroy()
  })

  it('暂存期间发生内容清理后不再发出旧帧', async () => {
    const { web: target, relay, sent } = start()
    publishSession(relay)
    const { res, done } = target.start('/marshal/api/stream', { headers: AUTH })
    // 屏障停在 inputs.snapshot：订阅已建立，之后的事件先进入 staged。
    const frame = await waitForFrame(sent, 'inputs.snapshot')
    publishDelta(relay, 2, 'staged-before-purge')
    // 内容清理发生在事件已暂存、尚未放行之间。
    expect(relay.purgeHistory('mac')).toBe(2)
    relay.settleInputs({
      v: 2, type: 'inputs.snapshot.result', requestId: frame.requestId as string,
      runtimeEpoch: 'epoch-1', highWatermark: 1, cards: [],
    } satisfies InputsSnapshotResultFrame, { deviceId: 'mac', connectionId: 'conn-1', nodeEpoch: 'epoch-1' })
    await waitFor(() => resetPayload(res) !== undefined, 'reset')
    await new Promise(resolve => setTimeout(resolve, 10))
    // 高水位 1 本应放行 seq 2，但它在清理之前已被观测，必须整条丢弃。
    expect(res.body).not.toContain('staged-before-purge')
    // 清理之后观测到的增量仍要正常放行，不能把整条流永久毒化。
    publishDelta(relay, 3, 'after-purge-live')
    await waitFor(() => res.body.includes('after-purge-live'), 'post-purge delta')
    await done
    res.destroy()
  })

  it('屏障不完整时不声称已恢复历史', async () => {
    const { web: target, relay } = start()
    publishSession(relay)
    const { res, done } = target.start('/marshal/api/stream', {
      headers: { ...AUTH, 'last-event-id': 'hub-test:0' },
    })
    // 不结算 inputs.snapshot：50ms 后屏障按未知失败，complete=false。
    await waitFor(() => resetPayload(res) !== undefined, 'reset')
    // 没有回放任何事件，即使游标本身有效也不能报告 gap:false。
    expect(resetPayload(res)).toMatchObject({
      required: true, complete: false, degradedDevices: ['mac'], replay: { gap: true },
    })
    await done
    res.destroy()
  })

  it('换代后旧 epoch 的回放事件被丢弃并降级', async () => {
    const { web: target, relay, sent, registry } = start()
    publishSession(relay, 's2')
    const cursor = relay.historyCursor()
    expect(cursor).toBe('hub-test:1')
    publishDelta(relay, 2, 'stale-payload', 's2')

    // 设备以新 epoch 重连：注册表槽位与中继权威代次一起换代。
    relay.beginEpoch('mac', 'epoch-2')
    registry.attach(
      { id: 'mac', name: 'Mac', agents: ['dsh'] },
      { send: text => sent.push(text) },
      0,
      { connectionId: 'conn-2', nodeEpoch: 'epoch-2' },
    )

    const { res, done } = target.start('/marshal/api/stream', {
      headers: { ...AUTH, 'last-event-id': cursor },
    })
    // 屏障按新连接身份结算，确保 complete=true 后才真正回放旧代次事件。
    const frame = await waitForFrame(sent, 'inputs.snapshot')
    relay.settleInputs({
      v: 2, type: 'inputs.snapshot.result', requestId: frame.requestId as string,
      runtimeEpoch: 'epoch-2', highWatermark: 1, cards: [],
    } satisfies InputsSnapshotResultFrame, { deviceId: 'mac', connectionId: 'conn-2', nodeEpoch: 'epoch-2' })

    await waitFor(() => resetPayload(res) !== undefined, 'reset')
    await waitFor(() => res.body.includes('"degradedDevices":["mac"]'), 'degraded reset')
    expect(res.body).not.toContain('stale-payload')
    expect(resetPayloads(res).some(payload =>
      payload['complete'] === false
      && Array.isArray(payload['degradedDevices'])
      && (payload['degradedDevices'] as string[]).includes('mac'))).toBe(true)
    await done
    res.destroy()
  })
})
