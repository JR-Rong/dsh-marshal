import { describe, expect, it } from 'vitest'
import { createPrivacyProjector } from '../src/node/privacy.ts'
import { createSeqAllocator, withPublicSeq } from '../src/node/seq.ts'
import type { EventFrame, MarshalKind } from '../src/wire/frames.ts'

function projector(privacy: 'metadata' | 'content' = 'metadata') {
  return createPrivacyProjector({
    privacy,
    allowContent: privacy === 'content',
    questionRelay: 'off',
    approvalRelay: 'off',
    allowInteractions: false,
    redaction: [],
    deviceId: 'mac',
    agent: 'dsh',
    nodeEpoch: 'epoch-1',
    now: () => 100,
  })
}

function event(kind: MarshalKind, payload: unknown, patch: Partial<EventFrame> = {}): EventFrame {
  return {
    v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1',
    nodeEpoch: 'epoch-1', seq: 999, ts: 10, kind, payload, ...patch,
  }
}

describe('public seq after projection', () => {
  it('被投影丢弃的帧不占号，公开 seq 从 1 连续递增', () => {
    const p = projector()
    const allocator = createSeqAllocator()
    const out: EventFrame[] = []
    // turn.started 缺 turnId 会被丢弃，不能留下空号。
    const frames = [
      event('turn.started', {}),
      event('session.updated', { running: true, updatedAt: 1 }),
      event('message.delta', { itemId: 'i1', text: 'x' }),
    ]
    for (const frame of frames) {
      for (const projected of p.event(frame)) out.push(withPublicSeq(allocator, projected))
    }
    expect(out.map(frame => frame.seq)).toEqual([1, 2])
  })

  it('分片帧在投影后拿到连续 seq', () => {
    const p = projector('content')
    const allocator = createSeqAllocator()
    const chunks = p.event(event('message.delta', { itemId: 'i1', text: '😀中文'.repeat(60_000) }))
    expect(chunks.length).toBeGreaterThan(1)
    const seqs = chunks.map(chunk => withPublicSeq(allocator, chunk).seq)
    expect(seqs).toEqual(chunks.map((_chunk, index) => index + 1))
  })

  it('seq 按 (deviceId, agent, sessionId, nodeEpoch) 独立计数', () => {
    const allocator = createSeqAllocator()
    expect(withPublicSeq(allocator, event('session.updated', {}))).toMatchObject({ seq: 1 })
    expect(withPublicSeq(allocator, event('session.updated', {}))).toMatchObject({ seq: 2 })
    expect(withPublicSeq(allocator, event('session.updated', {}, { nodeEpoch: 'epoch-2' }))).toMatchObject({ seq: 1 })
    expect(withPublicSeq(allocator, event('session.updated', {}, { sessionId: 's2' }))).toMatchObject({ seq: 1 })
  })
})
