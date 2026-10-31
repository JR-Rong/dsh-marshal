import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { toMarshalEvents } from '../src/adapters/dsh/map.ts'

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
      content: [{ type: 'text', text: 'a.txt' }],
      isError: false,
    })
  })

  it('忽略不认识的帧', () => {
    expect(toMarshalEvents({ type: 'heartbeat' }, meta, () => 1)).toEqual([])
    expect(toMarshalEvents({ type: 'event', event: { type: 'todo/write', seq: 9, time: 1, data: {} } }, meta, () => 1)).toEqual([])
    expect(toMarshalEvents(null, meta, () => 1)).toEqual([])
  })
})
