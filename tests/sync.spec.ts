import { afterEach, describe, expect, it } from 'vitest'
import type { SyncSnapshot } from '../src/adapters/types.ts'
import { HubRelay, type FrameIdentity } from '../src/hub/relay.ts'
import { createHubSync, type SyncHost } from '../src/hub/sync.ts'
import { DeviceRegistry } from '../src/hub/registry.ts'
import type { NodeLink, NodeLinkState } from '../src/node/link.ts'
import { createPrivacyProjector } from '../src/node/privacy.ts'
import { createNodeSync } from '../src/node/sync.ts'
import type { EventFrame, Frame, SyncAckFrame } from '../src/wire/frames.ts'
import { buildSyncChunks, syncChecksum } from '../src/wire/sync.ts'

const POLL_INTERVAL_MS = 10
const POLL_TIMEOUT_MS = 2_000
const DEVICE_ID = 'mac'
const NODE_EPOCH = 'epoch-1'

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

function settle(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function frameOf(text: string): Frame {
  return JSON.parse(text) as Frame
}

class FakeLink {
  state: NodeLinkState = 'syncing'
  online = false
  readonly handshake = { connectionId: 'conn-1', nodeEpoch: NODE_EPOCH, serverTimeOffset: 0 }
  readonly controls: string[] = []
  readonly begun: string[] = []
  readonly confirmed: string[] = []
  readonly rejected: string[] = []

  beginSync(syncId: string): boolean {
    this.begun.push(syncId)
    return true
  }

  confirmSync(syncId: string): boolean {
    this.confirmed.push(syncId)
    this.state = 'online'
    this.online = true
    return true
  }

  rejectSync(reason: string): void {
    this.rejected.push(reason)
    this.online = false
  }

  sendControl(text: string): void {
    this.controls.push(text)
  }

  frames(): Frame[] {
    return this.controls.map(frameOf)
  }
}

class FakeAdapter {
  readonly agent = 'dsh'
  private readonly snapshots: SyncSnapshot[]

  constructor(snapshots: SyncSnapshot[]) {
    this.snapshots = snapshots
  }

  async syncSnapshot(_signal: AbortSignal): Promise<SyncSnapshot> {
    const next = this.snapshots.length > 1 ? this.snapshots.shift() : this.snapshots[0]
    if (next === undefined) throw new Error('no snapshot')
    return next
  }
}

function sessionRow(sessionId: string, updatedAt: number, running = false): SyncSnapshot['rows'][number] {
  return { sessionId, running, updatedAt, blank: false }
}

function snapshot(rows: SyncSnapshot['rows'], capability: Record<string, unknown> | undefined = undefined): SyncSnapshot {
  return {
    rows,
    capabilities: capability === undefined ? [] : [{ agent: 'dsh', capability }],
    completeness: 'complete',
  }
}

function projector() {
  return createPrivacyProjector({
    privacy: 'metadata', allowContent: false,
    questionRelay: 'off', approvalRelay: 'off', allowInteractions: false,
    redaction: [], deviceId: DEVICE_ID, agent: 'dsh', nodeEpoch: NODE_EPOCH, now: () => 1,
  })
}

interface NodeHarness {
  readonly link: FakeLink
  readonly adapter: FakeAdapter
  readonly emitted: EventFrame[]
  readonly sync: ReturnType<typeof createNodeSync>
}

function nodeHarness(
  snapshots: SyncSnapshot[],
  overrides: Partial<{ scanMs: number; scanTimeoutMs: number; ackTimeoutMs: number }> = {},
): NodeHarness {
  const link = new FakeLink()
  const adapter = new FakeAdapter(snapshots)
  const emitted: EventFrame[] = []
  const project = projector()
  const sync = createNodeSync({
    link: link as unknown as NodeLink,
    adapter,
    agents: ['dsh'],
    projector: () => project,
    emit: event => emitted.push(event),
    frame: (sessionId, kind, payload) => ({
      v: 2, type: 'event', deviceId: DEVICE_ID, agent: 'dsh', sessionId,
      nodeEpoch: NODE_EPOCH, seq: 0, ts: 1, kind, payload,
    }),
    highWatermark: () => 7,
    scanMs: overrides.scanMs ?? 20,
    scanTimeoutMs: overrides.scanTimeoutMs ?? 200,
    ackTimeoutMs: overrides.ackTimeoutMs ?? 200,
    now: () => 100,
  })
  cleanups.push(() => sync.dispose())
  return { link, adapter, emitted, sync }
}

function ackFrame(syncId: string, accepted: boolean, version = 1): SyncAckFrame {
  return {
    v: 2, type: 'sync.ack', connectionId: 'conn-1', nodeEpoch: NODE_EPOCH,
    syncId, accepted, version,
    ...(accepted ? {} : { error: 'invalid' as const }),
  }
}

describe('node sync', () => {
  it('发送完整分片与校验和，只有匹配的 sync.ack 才进入 online', async () => {
    const harness = nodeHarness([
      snapshot([sessionRow('s1', 1), sessionRow('s2', 2, true)], { operations: ['prompt'], readAt: 1 }),
    ])
    harness.sync.begin()
    await waitFor(() => harness.link.frames().some(frame => frame.type === 'sync.end'), 'sync.end')
    const frames = harness.link.frames()
    const begin = frames[0]
    if (begin?.type !== 'sync.begin') throw new Error('expected sync.begin')
    expect(begin.scope.agents).toEqual(['dsh'])
    expect(begin.scope.sessions.sort()).toEqual(['s1', 's2'])
    expect(begin.version).toBe(1)
    expect(begin.chunkCount).toBe(1)
    expect(begin.highWatermark).toBe(7)
    expect(harness.sync.syncing).toBe(true)
    expect(harness.link.confirmed).toEqual([])

    const end = frames.find(frame => frame.type === 'sync.end')
    if (end?.type !== 'sync.end') throw new Error('expected sync.end')
    const chunks = frames.flatMap(frame => frame.type === 'sync.chunk' ? [frame.rows] : [])
    expect(end.checksum).toBe(syncChecksum(chunks))

    harness.sync.onFrame(ackFrame(begin.syncId, true))
    await waitFor(() => harness.link.confirmed.length === 1, 'confirm')
    expect(harness.link.confirmed[0]).toBe(begin.syncId)
    expect(harness.sync.syncing).toBe(false)
  })

  it('空清单也显式发送空 sessions 范围', async () => {
    const harness = nodeHarness([snapshot([], { operations: [] })])
    harness.sync.begin()
    await waitFor(() => harness.link.frames().some(frame => frame.type === 'sync.end'), 'sync.end')
    const begin = harness.link.frames()[0]
    if (begin?.type !== 'sync.begin') throw new Error('expected sync.begin')
    expect(begin.scope.sessions).toEqual([])
    expect(begin.chunkCount).toBe(1)
    harness.sync.onFrame(ackFrame(begin.syncId, true))
    await waitFor(() => harness.link.confirmed.length === 1, 'confirm')
  })

  it('被拒绝或超时的 sync.ack 都不得 online，只能重连重试', async () => {
    const rejected = nodeHarness([snapshot([sessionRow('s1', 1)])])
    rejected.sync.begin()
    await waitFor(() => rejected.link.frames().some(frame => frame.type === 'sync.end'), 'sync.end')
    const begin = rejected.link.frames()[0]
    if (begin?.type !== 'sync.begin') throw new Error('expected sync.begin')
    rejected.sync.onFrame(ackFrame(begin.syncId, false))
    await waitFor(() => rejected.link.rejected.length === 1, 'rejection')
    expect(rejected.link.rejected[0]).toBe('sync-rejected')
    expect(rejected.link.confirmed).toEqual([])
    expect(rejected.sync.stale).toBe(true)

    const timedOut = nodeHarness([snapshot([sessionRow('s1', 1)])], { ackTimeoutMs: 20 })
    timedOut.sync.begin()
    await waitFor(() => timedOut.link.rejected.includes('sync-timeout'), 'ack timeout')
    expect(timedOut.link.confirmed).toEqual([])
    expect(timedOut.sync.syncing).toBe(false)
  })

  it('周期扫描只发布差异，静默变化在下一轮可见', async () => {
    const harness = nodeHarness([
      snapshot([sessionRow('s1', 1), sessionRow('s2', 2)], { operations: ['prompt'] }),
      snapshot([sessionRow('s1', 3, true), sessionRow('s3', 4)], { operations: ['prompt'] }),
    ])
    harness.sync.begin()
    await waitFor(() => harness.link.frames().some(frame => frame.type === 'sync.end'), 'sync.end')
    const begin = harness.link.frames()[0]
    if (begin?.type !== 'sync.begin') throw new Error('expected sync.begin')
    harness.sync.onFrame(ackFrame(begin.syncId, true))
    await waitFor(() => harness.link.confirmed.length === 1, 'confirm')

    await waitFor(() => harness.emitted.some(event => event.kind === 'session.removed' && event.sessionId === 's2'), 'removal')
    await waitFor(() => harness.emitted.some(event => event.kind === 'session.updated' && event.sessionId === 's3'), 'addition')
    const updated = harness.emitted.find(event =>
      event.kind === 'session.updated' && event.sessionId === 's1')
    expect(updated?.payload).toMatchObject({ running: true, updatedAt: 3 })
    expect(harness.emitted.filter(event => event.kind === 'session.removed' && event.sessionId === 's2')).toHaveLength(1)

    const before = harness.emitted.length
    await settle(60)
    expect(harness.emitted.length).toBe(before)
  })
})

const identity: FrameIdentity = { deviceId: DEVICE_ID, connectionId: 'conn-1', nodeEpoch: NODE_EPOCH }

class FakeHost implements SyncHost {
  readonly acks: SyncAckFrame[] = []
  readonly closes: Array<{ code: number; reason: string }> = []

  send(frame: SyncAckFrame): void {
    this.acks.push(frame)
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason })
  }
}

interface HubHarness {
  readonly registry: DeviceRegistry
  readonly relay: HubRelay
  readonly sync: ReturnType<typeof createHubSync>
  readonly host: FakeHost
}

function hubHarness(options: Partial<{ deviceMaxBytes: number; hubMaxBytes: number; stagingTimeoutMs: number }> = {}): HubHarness {
  const registry = new DeviceRegistry()
  registry.attach(
    { id: DEVICE_ID, name: 'Mac', agents: ['dsh'] },
    { send: () => {} },
    1,
    { connectionId: 'conn-1', nodeEpoch: NODE_EPOCH },
  )
  const relay = new HubRelay({ registry, now: () => 100 })
  const sync = createHubSync({ relay, now: () => 100, ...options })
  cleanups.push(() => { sync.dispose(); relay.dispose() })
  return { registry, relay, sync, host: new FakeHost() }
}

function capabilityRow(agent: string, capability: Record<string, unknown>): Record<string, unknown> {
  return { agent, capability }
}

function sendSnapshot(
  harness: HubHarness,
  version: number,
  rows: readonly Record<string, unknown>[],
  capabilities: Readonly<Record<string, Record<string, unknown>>> = {},
  overrides: { readonly identity?: FrameIdentity; readonly checksum?: string } = {},
): string {
  const target = overrides.identity ?? identity
  const syncId = `sync-${version}-${target.nodeEpoch}`
  const chunks = buildSyncChunks([
    ...Object.entries(capabilities).map(([agent, capability]) => capabilityRow(agent, capability)),
    ...rows,
  ])
  harness.sync.onFrame(target, {
    v: 2, type: 'sync.begin', syncId,
    nodeEpoch: target.nodeEpoch, connectionId: target.connectionId,
    scope: { agents: ['dsh'], sessions: rows.map(row => String(row.sessionId)) },
    version, chunkCount: chunks.length, highWatermark: 0,
  }, harness.host)
  chunks.forEach((chunk, index) => harness.sync.onFrame(target, {
    v: 2, type: 'sync.chunk', syncId,
    nodeEpoch: target.nodeEpoch, connectionId: target.connectionId,
    index, total: chunks.length, rows: chunk,
  }, harness.host))
  harness.sync.onFrame(target, {
    v: 2, type: 'sync.end', syncId,
    nodeEpoch: target.nodeEpoch, connectionId: target.connectionId,
    checksum: overrides.checksum ?? syncChecksum(chunks),
  }, harness.host)
  return syncId
}

function row(sessionId: string, updatedAt: number, running = false): Record<string, unknown> {
  return { sessionId, agent: 'dsh', running, updatedAt }
}

describe('hub sync', () => {
  it('只在 sync.end 校验通过后原子替换会话行并发布差异', () => {
    const harness = hubHarness()
    const events: EventFrame[] = []
    harness.relay.subscribe(event => events.push(event))
    harness.sync.attach(identity, ['dsh'])
    sendSnapshot(harness, 1, [row('s1', 1), row('s2', 2)], { dsh: { operations: ['prompt'], readAt: 1 } })
    expect(harness.host.acks.at(-1)).toMatchObject({ accepted: true, version: 1 })
    expect(harness.relay.sessions(DEVICE_ID).map(item => item.sessionId).sort()).toEqual(['s1', 's2'])
    expect(harness.relay.capabilities(DEVICE_ID).dsh).toMatchObject({ operations: ['prompt'] })
    expect(harness.sync.isSynced(identity)).toBe(true)

    sendSnapshot(harness, 2, [row('s2', 3, true), row('s3', 4)], { dsh: { operations: ['prompt'] } })
    expect(harness.relay.sessions(DEVICE_ID).map(item => item.sessionId).sort()).toEqual(['s2', 's3'])
    expect(events.filter(event => event.kind === 'session.removed' && event.sessionId === 's1')).toHaveLength(1)
    expect(events.some(event => event.kind === 'session.updated' && event.sessionId === 's3')).toBe(true)
  })

  it('校验失败保留旧索引，绝不部分覆盖', () => {
    const harness = hubHarness()
    harness.sync.attach(identity, ['dsh'])
    sendSnapshot(harness, 1, [row('s1', 1)])
    expect(harness.relay.sessions(DEVICE_ID)).toHaveLength(1)

    sendSnapshot(harness, 2, [row('s2', 2)], {}, { checksum: 'not-the-checksum' })
    expect(harness.host.acks.at(-1)).toMatchObject({ accepted: false, error: 'readback-mismatch' })
    expect(harness.relay.sessions(DEVICE_ID).map(item => item.sessionId)).toEqual(['s1'])
    const status = harness.sync.status(DEVICE_ID)
    expect(status.stale).toBe(true)
    expect(status.syncing).toBe(false)
    expect(harness.sync.isSynced(identity)).toBe(false)
  })

  it('超出单设备/单 hub 暂存预算立即放弃并拒绝', () => {
    const perDevice = hubHarness({ deviceMaxBytes: 32 })
    perDevice.sync.attach(identity, ['dsh'])
    sendSnapshot(perDevice, 1, [row('a-long-session-identifier', 1)])
    expect(perDevice.host.acks.some(ack => ack.error === 'size-limit')).toBe(true)
    expect(perDevice.relay.sessions(DEVICE_ID)).toEqual([])

    const perHub = hubHarness({ deviceMaxBytes: 10_000, hubMaxBytes: 20 })
    perHub.sync.attach(identity, ['dsh'])
    sendSnapshot(perHub, 1, [row('s1', 1)])
    expect(perHub.host.acks.some(ack => ack.error === 'size-limit')).toBe(true)
    expect(perHub.relay.sessions(DEVICE_ID)).toEqual([])
  })

  it('按会话去重：重复丢弃，缺口交给调用方 4409', () => {
    const harness = hubHarness()
    harness.sync.attach(identity, ['dsh'])
    sendSnapshot(harness, 1, [row('s1', 1), row('s2', 1)])
    const event = (sessionId: string, seq: number): EventFrame => ({
      v: 2, type: 'event', deviceId: DEVICE_ID, agent: 'dsh', sessionId, nodeEpoch: NODE_EPOCH,
      seq, ts: 1, kind: 'turn.started', payload: {},
    })
    expect(harness.sync.acceptEvent(identity, event('s1', 1))).toBe('accept')
    expect(harness.sync.acceptEvent(identity, event('s1', 1))).toBe('duplicate')
    expect(harness.sync.acceptEvent(identity, event('s1', 3))).toBe('gap')
    // 不同会话的 seq 相互独立。
    expect(harness.sync.acceptEvent(identity, event('s2', 1))).toBe('accept')
    // 新 epoch 的帧不能冒充当前代次。
    expect(harness.sync.acceptEvent({ ...identity, nodeEpoch: 'epoch-2' }, event('s2', 2))).toBe('not-online')
  })

  it('新 nodeEpoch 丢弃旧能力并重置版本，提交前不发布删除', () => {
    const harness = hubHarness()
    const events: EventFrame[] = []
    harness.relay.subscribe(event => events.push(event))
    harness.sync.attach(identity, ['dsh'])
    sendSnapshot(harness, 5, [row('s1', 1), row('s2', 2)], { dsh: { operations: ['prompt'] } })
    expect(harness.relay.capabilities(DEVICE_ID).dsh).toBeDefined()

    const next: FrameIdentity = { deviceId: DEVICE_ID, connectionId: 'conn-2', nodeEpoch: 'epoch-2' }
    harness.sync.attach(next, ['dsh'])
    expect(harness.relay.capabilities(DEVICE_ID)).toEqual({})
    // 旧会话行保留但 stale；删除通知只能在新提交时发布。
    expect(harness.relay.sessions(DEVICE_ID)).toHaveLength(2)
    expect(events.some(event => event.kind === 'session.removed')).toBe(false)

    // 新 epoch 从 version 1 重新开始。
    sendSnapshot(harness, 1, [row('s2', 3)], { dsh: { operations: [] } }, { identity: next })
    expect(harness.host.acks.at(-1)).toMatchObject({ accepted: true, version: 1 })
    expect(harness.relay.sessions(DEVICE_ID).map(item => item.sessionId)).toEqual(['s2'])
    expect(events.filter(event => event.kind === 'session.removed')).toHaveLength(1)
  })

  it('暂存超时释放分片并标记 stale，之后仍可重新同步', async () => {
    const harness = hubHarness({ stagingTimeoutMs: 20 })
    harness.sync.attach(identity, ['dsh'])
    harness.sync.onFrame(identity, {
      v: 2, type: 'sync.begin', syncId: 'slow', nodeEpoch: NODE_EPOCH, connectionId: 'conn-1',
      scope: { agents: ['dsh'], sessions: [] }, version: 1, chunkCount: 1, highWatermark: 0,
    }, harness.host)
    await settle(40)
    expect(harness.sync.status(DEVICE_ID).stale).toBe(true)
    expect(harness.sync.isSynced(identity)).toBe(false)
    // 超时清空暂存后，新的 begin 不会被旧暂存挡住。
    sendSnapshot(harness, 1, [row('s1', 1)])
    expect(harness.host.acks.at(-1)).toMatchObject({ accepted: true })
    expect(harness.relay.sessions(DEVICE_ID).map(item => item.sessionId)).toEqual(['s1'])
  })
})
