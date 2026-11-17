import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { HubRelay } from '../src/hub/relay.ts'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { createDshSurface } from '../src/adapters/dsh/surface.ts'
import { turnToEvents } from '../src/agents/codex/map.ts'
import { dshHistoryEvents } from '../src/adapters/dsh/map.ts'
import { createPrivacyProjector } from '../src/node/privacy.ts'
import type { EventFrame, HistoryResultFrame } from '../src/wire/frames.ts'

const native = runInNewContext(readFileSync(new URL('../client/native.js', import.meta.url), 'utf8') + '\nmarshalNative()', {
  crypto: { randomUUID }, setTimeout, clearTimeout,
})
const target = { deviceId: 'mac', agent: 'codex', sessionId: 'original' }
const event = (kind: EventFrame['kind'], payload: unknown): EventFrame => ({ v: 2, type: 'event', ...target, nodeEpoch: 'epoch', seq: 1, ts: 1, kind, payload })

describe('native session adapter', () => {
  it('uses native Codex turn times instead of the history read time', () => {
    let seq = 0;
    const entries = turnToEvents({ id: 't', status: 'completed', startedAt: 100, completedAt: 106, items: [] }, { ...target, nodeEpoch: 'epoch' }, () => ++seq, { runtimeEpoch: 'runtime' });
    expect(entries.map(e => e.ts)).toEqual([100000, 106000]);
  })
  it('preserves transcript roles and authoritative completion without doubling streamed text', () => {
    const frames = [event('turn.started', { turnId: 't' }), event('user.message', { itemId: 'u', text: 'question' }),
      event('message.delta', { itemId: 'a', text: 'hel' }), event('message.delta', { itemId: 'a', text: 'lo' }),
      event('message.completed', { itemId: 'a', text: 'hello' }), event('turn.completed', { turnId: 't', state: 'completed' })]
    const entries = native.projectTranscript(frames)
    expect(entries.filter((entry: any) => entry.event.type === 'user/message')[0].event.data.content[0].text).toBe('question')
    expect(entries.filter((entry: any) => entry.event.type === 'assistant/message')).toHaveLength(1)
    expect(entries.find((entry: any) => entry.event.type === 'assistant/message').event.data.message.content[0].text).toBe('hello')
    expect(entries.find((entry: any) => entry.event.type === 'assistant/message').event.data).toMatchObject({ stream: [], message: { source: { provider: '', model: '' } } })
    expect(entries.map((entry: any) => entry.event.seq)).toEqual(entries.map((_: any, index: number) => index))
  })
  it('keeps native tool fields valid and joins privacy chunks into one user message', () => {
    const entries = native.projectTranscript([event('user.message', { itemId: 'u', text: 'first', chunkIndex: 0 }), event('user.message', { itemId: 'u', text: 'last', chunkIndex: 1 }), event('tool.started', { callId: 'c', tool: 'shell', arguments: { cmd: 'pwd' } }), event('tool.completed', { callId: 'c', content: [{ type: 'text', text: 'result' }] })]);
    expect(entries.filter((e: any) => e.event.type === 'user/message')).toHaveLength(1);
    expect(entries.find((e: any) => e.event.type === 'user/message').event.data.content[0].text).toBe('firstlast');
    expect(entries.find((e: any) => e.event.type === 'tool/call').event.data.arguments).toBe(JSON.stringify({ cmd: 'pwd' }));
    expect(entries.find((e: any) => e.event.type === 'tool/result').event.data.message).toMatchObject({ source: { callId: 'c' }, content: [{ type: 'text', text: 'result' }] });
  })
  it('binds only its namespaced instance, routes original identity and releases references', async () => {
    const originalTransport = {}; const release = vi.fn(); const nativeSession: any = { remote: originalTransport, openState: 'idle',
      installWindow: vi.fn(), handleRunning: vi.fn(), handleBlank: vi.fn(), getSnapshot: vi.fn(), beginSubmission: vi.fn() }
    const reference = { binding: { session: nativeSession }, release }
    const ctx = { sessions: { binding: () => undefined, retainAgentScope: vi.fn((_id: string) => reference) } }
    const invoke = vi.fn(async () => ({ ok: true, status: 'confirmed' }))
    const bridge = native.createSessionBridge(ctx, target, invoke)
    expect(ctx.sessions.retainAgentScope.mock.calls[0]?.[0]).toContain('marshal-view:')
    expect(bridge.target).toEqual(target)
    expect((await nativeSession.remote.session.prompt({ content: [{ type: 'image' }], requestId: 'r' })).ok).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
    expect((await nativeSession.remote.session.prompt({ content: [{ type: 'text', text: 'continue' }], requestId: 'r' })).ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith('prompt', { text: 'continue', requestId: 'r' })
    bridge.dispose(); bridge.dispose(); expect(release).toHaveBeenCalledOnce()
    expect(Object.keys(originalTransport)).toEqual([])
  })
  it('does not publish a late prompt reply into another selected conversation', async () => {
    const session: any = { remote: {}, openState: 'idle', installWindow() {}, handleRunning() {}, handleBlank() {}, getSnapshot() {}, beginSubmission() {} };
    const local = vi.fn(); let resolve!: (value: unknown) => void;
    const ctx = { sessions: { binding() {}, retainAgentScope: () => ({ binding: { session }, release() {} }) } };
    const bridge = native.createSessionBridge(ctx, target, () => new Promise(r => { resolve = r }), local);
    const sending = session.remote.session.prompt({ content: [{ type: 'text', text: 'test' }], requestId: 'r' });
    bridge.dispose(); resolve({ ok: true, status: 'confirmed' }); await sending;
    expect(local).not.toHaveBeenCalled();
  })
  it('rejects incompatible native session shapes without opening history or invoking a model', () => {
    const release = vi.fn()
    expect(() => native.createSessionBridge({ sessions: { binding() {}, retainAgentScope: () => ({ binding: { session: {} }, release }) } }, target, vi.fn())).toThrow('接口已变化')
    expect(release).toHaveBeenCalledOnce()
  })
})

describe('read-only history transport', () => {
  it('correlates the full target and connection, and never caches bodies as command status', async () => {
    const registry = new DeviceRegistry(), sent: string[] = []
    registry.attach({ id: 'mac', name: 'mac', agents: ['codex'] }, { send: text => sent.push(text) }, 0, { connectionId: 'conn', nodeEpoch: 'epoch' })
    const relay = new HubRelay({ registry, now: Date.now })
    try {
      const input = { op: 'observe' as const, target, args: { kind: 'history', limit: 10 }, idempotencyKey: 'read1' }
      const waiting = relay.command(input)
      const command = JSON.parse(sent[0]!)
      const frame: HistoryResultFrame = { v: 2, type: 'history.result', commandId: command.commandId, connectionId: 'conn', nodeEpoch: 'epoch', target,
        items: [event('message.completed', { itemId: 'a', text: 'history' })], completeness: 'complete' }
      const origin = { deviceId: 'mac', connectionId: 'conn', nodeEpoch: 'epoch' }
      relay.settleHistory({ ...frame, target: { ...target, sessionId: 'another' } }, origin)
      relay.settleHistory({ ...frame, connectionId: 'stale' }, origin)
      relay.settleHistory(frame, origin)
      const outcome = await waiting
      expect(outcome).toMatchObject({ ok: true, history: { items: [{ payload: { text: 'history' } }] } })
      expect(await relay.command(input)).not.toHaveProperty('history')
      expect(relay.historyRead(undefined)).toMatchObject({ events: [] })
    } finally { relay.dispose() }
  })
  it('reads and pages DSH records without prompting, and closes the temporary follower', async () => {
    let closed = 0
    const page = vi.fn(async (_request: unknown) => ({ records: [{ type: 'event', event: { seq: 0 } }], hasMore: false }))
    const prompt = vi.fn()
    const surface = createDshSurface({ list: async () => ({ items: [] }), prompt, cancel() {}, page,
      async *follow() { try { yield { type: 'snapshot', cursor: 20, records: [{ type: 'event', event: { seq: 10 } }], hasMore: true }; } finally { closed++ } },
    })
    const first = await surface.history!({ sessionId: 's', limit: 3 }, new AbortController().signal)
    expect(first).toMatchObject({ events: [{ seq: 10 }], nextCursor: '[20,10]' })
    expect(closed).toBe(1)
    await surface.history!({ sessionId: 's', cursor: first.nextCursor! }, new AbortController().signal)
    expect(page.mock.calls[0]?.[0]).toMatchObject({ throughSeq: 20, beforeSeq: 10, address: { sessionId: 's' } })
    expect(prompt).not.toHaveBeenCalled()
  })
  it('exposes only human user messages, with the same redaction policy as live content', () => {
    const items = dshHistoryEvents([{ type: 'user/message', surfaceOp: 'append', seq: 0, time: 1,
      data: { id: 'u', content: [{ type: 'text', text: 'password=secret hello' }], source: { kind: 'user' } } },
    { type: 'user/message', surfaceOp: 'append', seq: 1, time: 2, data: { content: [], source: { kind: 'system' } } }],
    { ...target, nodeEpoch: 'epoch' }, () => 0)
    expect(items).toHaveLength(1)
    const projector = createPrivacyProjector({ privacy: 'content', allowContent: true, questionRelay: 'off', approvalRelay: 'off', allowInteractions: false, redaction: [], deviceId: 'mac', agent: 'codex' })
    expect(JSON.stringify(projector.event(items[0]!))).not.toContain('secret')
  })
})
