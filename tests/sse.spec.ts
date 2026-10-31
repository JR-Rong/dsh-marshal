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
  const relay = new HubRelay({ registry, now: Date.now, timeoutMs: 50 })
  const test = createMemoryWeb({ ...(options.writeResult === undefined ? {} : { writeResult: options.writeResult }) })
  routes = registerMarshalRoutes({
    webServer: test.webServer,
    registry,
    relay,
    requireToken: TOKEN,
    publicOrigin: ORIGIN,
    operatorId: 'operator-test',
    hubEpoch: 'hub-test',
    loginFailureDelayMs: 0,
  })
  web = test
  return { web: test, relay, sent }
}

function publishSession(relay: HubRelay, sessionId = 's1'): void {
  relay.publish({
    v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId, nodeEpoch: 'epoch-1',
    seq: 1, ts: 1, kind: 'session.updated', payload: { running: false, updatedAt: 1 },
  })
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
})
