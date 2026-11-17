import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createEventDeduper, toMarshalEvents } from '../src/adapters/dsh/map.ts'
import type { EventFrame } from '../src/wire/frames.ts'

const frames = readFileSync(new URL('./fixtures/dsh-follow.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line))

const meta = { deviceId: 'mac', agent: 'dsh', sessionId: 's1', nodeEpoch: 'epoch-1' }

describe('toMarshalEvents', () => {
  it('把跟随帧映射成 marshal 事件', () => {
    let seq = 0
    const events = frames.flatMap(frame => toMarshalEvents(frame, meta, () => ++seq))
    expect(events.map(event => event.kind)).toEqual([
      'turn.started', 'reasoning.delta', 'tool.started', 'tool.completed',
      'message.delta', 'message.completed', 'turn.completed',
    ])
    expect(events.every(event => event.type === 'event')).toBe(true)
    expect(events.every(event => event.deviceId === 'mac' && event.sessionId === 's1')).toBe(true)
  })

  it('序号来自 nextSeq，连续递增', () => {
    let seq = 10
    const events = toMarshalEvents(frames[3], meta, () => ++seq)
    expect(events.map(event => event.seq)).toEqual([11])
  })

  it('工具结果取 message 里的 callId 与内容', () => {
    const events = toMarshalEvents(frames[6], meta, () => 1)
    expect(events[0]?.payload).toEqual({
      callId: 'call-1',
      status: 'ok',
      content: [{ type: 'text', text: 'a.txt' }],
    })
  })

  it('工具参数里的交互正文在源端剔除', () => {
    const frame = {
      type: 'event',
      event: {
        type: 'tool/call', seq: 1, time: 1,
        data: {
          turn: 1, step: 1, callId: 'call-1', name: 'ask',
          arguments: { questions: [{ id: 'q1', question: '选哪个？' }], note: 'ok' },
        },
      },
    }
    const events = toMarshalEvents(frame, meta, () => 1)
    expect(events[0]?.payload).toEqual({ callId: 'call-1', tool: 'ask', status: 'running' })
  })

  it('忽略不认识的帧', () => {
    expect(toMarshalEvents({ type: 'heartbeat' }, meta, () => 1)).toEqual([])
    expect(toMarshalEvents({ type: 'event', event: { type: 'todo/write', seq: 9, time: 1, data: {} } }, meta, () => 1)).toEqual([])
    expect(toMarshalEvents(null, meta, () => 1)).toEqual([])
  })
})

function frame(kind: EventFrame['kind'], payload: unknown, sessionId = 's1'): EventFrame {
  return {
    v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId,
    nodeEpoch: 'epoch-1', seq: 1, ts: 1, kind, payload,
  }
}

describe('createEventDeduper', () => {
  it('同一 (callId,status) 的完成态只投递一次', () => {
    const dedupe = createEventDeduper()
    const started = frame('tool.started', { callId: 'call-1', status: 'running' })
    const completed = frame('tool.completed', { callId: 'call-1', status: 'ok' })
    expect(dedupe.accept('s1', started)).toBe(true)
    expect(dedupe.accept('s1', started)).toBe(false)
    expect(dedupe.accept('s1', completed)).toBe(true)
    expect(dedupe.accept('s1', completed)).toBe(false)
    // 同 callId 不同状态是真实状态转换，不能吞掉。
    expect(dedupe.accept('s1', frame('tool.completed', { callId: 'call-1', status: 'error' }))).toBe(true)
  })

  it('重复的回合完成态按 (turnId,state) 去重', () => {
    const dedupe = createEventDeduper()
    const done = frame('turn.completed', { turnId: 't1', state: 'completed' })
    const failed = frame('turn.completed', { turnId: 't1', state: 'failed' })
    expect(dedupe.accept('s1', done)).toBe(true)
    expect(dedupe.accept('s1', done)).toBe(false)
    expect(dedupe.accept('s1', failed)).toBe(true)
    expect(dedupe.accept('s1', frame('turn.started', { turnId: 't1', state: 'running' }))).toBe(true)
  })

  it('会话之间互不影响，增量帧不被去重', () => {
    const dedupe = createEventDeduper()
    const done = frame('tool.completed', { callId: 'call-1', status: 'ok' })
    expect(dedupe.accept('s1', done)).toBe(true)
    expect(dedupe.accept('s2', done)).toBe(true)
    expect(dedupe.accept('s1', frame('message.delta', { itemId: 'i1', text: 'a' }))).toBe(true)
    expect(dedupe.accept('s1', frame('message.delta', { itemId: 'i1', text: 'a' }))).toBe(true)
  })

  it('每会话上限是有界的：最早键会被淘汰', () => {
    const dedupe = createEventDeduper()
    for (let index = 0; index < 1_001; index += 1) {
      expect(dedupe.accept('s1', frame('tool.completed', { callId: `call-${index}`, status: 'ok' }))).toBe(true)
    }
    // 第一条已滑出窗口，可以重新进入；这证明集合没有无限增长到内存失控。
    expect(dedupe.accept('s1', frame('tool.completed', { callId: 'call-0', status: 'ok' }))).toBe(true)
  })
})
