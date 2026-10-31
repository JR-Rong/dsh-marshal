import { describe, expect, it } from 'vitest'
import { decodeFrame, encodeFrame, FrameError, MAX_FRAME_BYTES } from '../src/wire/frames.ts'

const event = {
  v: 1 as const, type: 'event' as const, device: 'mac', agent: 'dsh',
  sessionId: 's1', seq: 7, ts: '2026-10-29T00:00:00.000Z',
  kind: 'tool.started' as const, payload: { name: 'bash', args: { cmd: 'ls' } },
}

describe('frames', () => {
  it('往返编解码保持内容', () => {
    expect(decodeFrame(encodeFrame(event))).toEqual(event)
  })

  it('拒绝未知 kind', () => {
    const bad = JSON.stringify({ ...event, kind: 'thinking.raw' })
    expect(() => decodeFrame(bad)).toThrow(FrameError)
  })

  it('拒绝缺少 target 的指令', () => {
    const bad = JSON.stringify({ v: 1, type: 'command', id: 'c1', idempotencyKey: 'k1', deadline: 1, op: 'prompt' })
    expect(() => decodeFrame(bad)).toThrow(/target/)
  })

  it('拒绝超过上限的帧', () => {
    const huge = JSON.stringify({ ...event, payload: 'x'.repeat(MAX_FRAME_BYTES) })
    expect(() => decodeFrame(huge)).toThrow(/too large/)
  })

  it('拒绝非 JSON', () => {
    expect(() => decodeFrame('not json')).toThrow(FrameError)
  })

  it('拒绝错误的协议版本', () => {
    const bad = JSON.stringify({ ...event, v: 2 })
    expect(() => decodeFrame(bad)).toThrow(FrameError)
    expect(() => decodeFrame(bad)).toThrow(/v/)
  })

  it('拒绝未知 type', () => {
    const bad = JSON.stringify({ ...event, type: 'bogus' })
    expect(() => decodeFrame(bad)).toThrow(FrameError)
    expect(() => decodeFrame(bad)).toThrow(/bogus/)
  })

  it('拒绝超过上限的出站帧', () => {
    const huge = { ...event, payload: { blob: 'x'.repeat(MAX_FRAME_BYTES) } }
    expect(() => encodeFrame(huge)).toThrow(FrameError)
    expect(() => encodeFrame(huge)).toThrow(new RegExp(String(MAX_FRAME_BYTES)))
  })
})
