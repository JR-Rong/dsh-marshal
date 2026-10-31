import { describe, expect, it } from 'vitest'
import {
  BUFFER_HUB_BYTES_MAX,
  BUFFER_REPLAY_BYTES_MAX,
  BUFFER_REPLAY_MAX,
  BUFFER_SESSION_BYTES_MAX,
  BUFFER_SESSION_EVENT_MAX,
  BUFFER_TTL_MS,
  CACHEABLE_KINDS,
  createEventBuffer,
  isCacheableKind,
  parseBufferCursor,
  type EventBuffer,
  type EventBufferOptions,
} from '../src/hub/buffer.ts'
import { MARSHAL_KINDS, type EventFrame } from '../src/wire/frames.ts'

const HUB = 'hub-1'

let nextSeq = 0

function makeEvent(overrides: Partial<Record<keyof EventFrame, unknown>> = {}): EventFrame {
  nextSeq += 1
  return {
    v: 2,
    type: 'event',
    deviceId: 'dev-a',
    agent: 'dsh',
    sessionId: 's1',
    nodeEpoch: 'node-1',
    seq: nextSeq,
    ts: 1_000,
    kind: 'message.delta',
    payload: { text: 'hi' },
    ...overrides,
  } as EventFrame
}

type BufferOverrides = Omit<EventBufferOptions, 'hubEpoch'> & { readonly hubEpoch?: string }

function makeBuffer(overrides: BufferOverrides = {}): EventBuffer {
  return createEventBuffer({ hubEpoch: HUB, ...overrides } as EventBufferOptions)
}

function appendEvent(
  buffer: EventBuffer,
  overrides: Partial<Record<keyof EventFrame, unknown>> = {},
): string {
  const result = buffer.append(makeEvent(overrides))
  expect(result.accepted).toBe(true)
  return result.cursor ?? ''
}

describe('EventBuffer 常量与 kind 白名单', () => {
  it('导出与契约一致的预算常量', () => {
    expect(BUFFER_SESSION_EVENT_MAX).toBe(2_000)
    expect(BUFFER_SESSION_BYTES_MAX).toBe(8 * 1024 * 1024)
    expect(BUFFER_HUB_BYTES_MAX).toBe(64 * 1024 * 1024)
    expect(BUFFER_TTL_MS).toBe(15 * 60 * 1000)
    expect(BUFFER_REPLAY_MAX).toBe(1_000)
    expect(BUFFER_REPLAY_BYTES_MAX).toBe(4 * 1024 * 1024)
    expect(CACHEABLE_KINDS.size).toBe(MARSHAL_KINDS.length - 2)
    expect(CACHEABLE_KINDS.has('input.requested')).toBe(false)
    expect(CACHEABLE_KINDS.has('input.resolved')).toBe(false)
    expect(isCacheableKind('input.requested')).toBe(false)
    expect(isCacheableKind('input.resolved')).toBe(false)
    expect(isCacheableKind('message.delta')).toBe(true)
    expect(isCacheableKind('tool.output')).toBe(true)
    expect(isCacheableKind('not.a.kind')).toBe(false)
  })

  it('拒绝 input.requested/input.resolved，接受带 text 的 message.delta', () => {
    const buffer = makeBuffer()
    for (const kind of ['input.requested', 'input.resolved'] as const) {
      const result = buffer.append(makeEvent({ kind }))
      expect(result.accepted).toBe(false)
      expect(result.cursor).toBeUndefined()
    }
    expect(buffer.cursor()).toBe(`${HUB}:0`)
    expect(buffer.size().events).toBe(0)

    const accepted = buffer.append(makeEvent({ kind: 'message.delta', payload: { text: 'hello' } }))
    expect(accepted.accepted).toBe(true)
    expect(accepted.cursor).toBe(`${HUB}:1`)
    expect(buffer.size().events).toBe(1)
  })

  it('payload 顶层或嵌套出现交互/答案/密钥键时拒收', () => {
    const forbidden = [
      'secret', 'answer', 'answers', 'selectedOptionIds', 'decisions', 'questions', 'approval',
    ]
    for (const key of forbidden) {
      const buffer = makeBuffer()
      const top = buffer.append(makeEvent({ kind: 'tool.output', payload: { [key]: 'sentinel' } }))
      expect(top.accepted).toBe(false)

      const nested = buffer.append(makeEvent({
        kind: 'tool.output',
        payload: { items: [{ meta: { [key]: 'sentinel' } }] },
      }))
      expect(nested.accepted).toBe(false)
      expect(buffer.size().events).toBe(0)
    }
  })

  it('message.delta/tool.output 的 text 不被误伤', () => {
    const buffer = makeBuffer()
    expect(buffer.append(makeEvent({ kind: 'message.delta', payload: { text: 'delta' } })).accepted)
      .toBe(true)
    expect(buffer.append(makeEvent({ kind: 'tool.output', payload: { text: 'output' } })).accepted)
      .toBe(true)
  })

  it('拒绝非法信封', () => {
    const buffer = makeBuffer()
    const invalid: unknown[] = [
      null,
      [],
      'event',
      { ...makeEvent(), v: 1 },
      { ...makeEvent(), type: 'hello' },
      { ...makeEvent(), deviceId: '' },
      { ...makeEvent(), agent: '' },
      { ...makeEvent(), sessionId: '' },
      { ...makeEvent(), nodeEpoch: '' },
      { ...makeEvent(), seq: -1 },
      { ...makeEvent(), seq: 1.5 },
      { ...makeEvent(), ts: -1 },
      { ...makeEvent(), ts: Number.POSITIVE_INFINITY },
      { ...makeEvent(), kind: 'unknown.kind' },
      { ...makeEvent(), payload: undefined },
      new Date(),
    ]
    for (const value of invalid) {
      const result = buffer.append(value as EventFrame)
      expect(result.accepted).toBe(false)
      expect(result.cursor).toBeUndefined()
    }
    expect(buffer.size().events).toBe(0)

    const first = buffer.append(makeEvent())
    expect(first.cursor).toBe(`${HUB}:1`)
  })

  it('拒收过深或过宽的载荷，避免绕过键扫描', () => {
    const buffer = makeBuffer()
    let deep: unknown = { leaf: 1 }
    for (let i = 0; i < 6; i += 1) deep = { nested: deep }
    expect(buffer.append(makeEvent({ payload: deep })).accepted).toBe(false)

    const wide: Record<string, number> = {}
    for (let i = 0; i < 65; i += 1) wide[`k${i}`] = i
    expect(buffer.append(makeEvent({ payload: wide })).accepted).toBe(false)
  })
})

describe('EventBuffer 游标回放', () => {
  it('解析 hubEpoch:cursor', () => {
    expect(parseBufferCursor(`${HUB}:0`, HUB)).toBe(0)
    expect(parseBufferCursor(`${HUB}:12`, HUB)).toBe(12)
    for (const bad of [`other:1`, `${HUB}:-1`, `${HUB}:1.5`, `${HUB}:abc`, `${HUB}:`, '1']) {
      expect(parseBufferCursor(bad, HUB)).toBeUndefined()
    }
  })

  it('append 3 条后从 0 回放，读完的 cursor 前进；当前 cursor 返回空', () => {
    const buffer = makeBuffer()
    const c1 = appendEvent(buffer)
    const c2 = appendEvent(buffer)
    const c3 = appendEvent(buffer)
    expect([c1, c2, c3]).toEqual([`${HUB}:1`, `${HUB}:2`, `${HUB}:3`])

    const replayed = buffer.read(`${HUB}:0`)
    expect(replayed.gap).toBe(false)
    expect(replayed.truncated).toBe(false)
    expect(replayed.events.map((entry) => entry.cursor)).toEqual([c1, c2, c3])
    expect(replayed.cursor).toBe(c3)
    expect(replayed.dropped).toBe(0)
    expect(replayed.events.every((entry) => entry.bytes > 0)).toBe(true)

    const caughtUp = buffer.read(replayed.cursor)
    expect(caughtUp.gap).toBe(false)
    expect(caughtUp.events).toHaveLength(0)
    expect(caughtUp.cursor).toBe(c3)

    const live = buffer.read(undefined)
    expect(live.gap).toBe(false)
    expect(live.events).toHaveLength(0)
    expect(live.cursor).toBe(c3)
  })

  it('跨 epoch、超出高水位或格式非法的游标都是 gap', () => {
    const buffer = makeBuffer()
    appendEvent(buffer)
    expect(buffer.read('other-epoch:0').gap).toBe(true)
    expect(buffer.read(`${HUB}:9`).gap).toBe(true)
    expect(buffer.read('garbage').gap).toBe(true)
    expect(buffer.read('garbage').cursor).toBe(`${HUB}:1`)
  })

  it('按条数预算截断并返回最后一条的 cursor', () => {
    const buffer = makeBuffer({ replayMax: 2 })
    appendEvent(buffer)
    appendEvent(buffer)
    appendEvent(buffer)

    const first = buffer.read(`${HUB}:0`)
    expect(first.events).toHaveLength(2)
    expect(first.truncated).toBe(true)
    expect(first.cursor).toBe(`${HUB}:2`)

    const rest = buffer.read(first.cursor)
    expect(rest.gap).toBe(false)
    expect(rest.events).toHaveLength(1)
    expect(rest.truncated).toBe(false)
    expect(rest.cursor).toBe(`${HUB}:3`)
  })

  it('按字节预算截断', () => {
    const buffer = makeBuffer({ replayBytesMax: 500 })
    appendEvent(buffer, { payload: { text: 'z'.repeat(100) } })
    appendEvent(buffer, { payload: { text: 'z'.repeat(100) } })

    const result = buffer.read(`${HUB}:0`)
    expect(result.events).toHaveLength(1)
    expect(result.truncated).toBe(true)
    expect(result.cursor).toBe(`${HUB}:1`)
  })
})

describe('EventBuffer 会话上限', () => {
  it('同一会话超过条数时淘汰最旧，其他会话不受影响', () => {
    const buffer = makeBuffer({ sessionEventMax: 3 })
    appendEvent(buffer, { sessionId: 's1' })
    appendEvent(buffer, { sessionId: 's1' })
    appendEvent(buffer, { sessionId: 's1' })
    appendEvent(buffer, { sessionId: 's1' })

    const size = buffer.size()
    expect(size.events).toBe(3)
    expect(size.sessions).toBe(1)

    const old = buffer.read(`${HUB}:0`)
    expect(old.gap).toBe(true)
    expect(old.events).toHaveLength(0)
    expect(old.dropped).toBeGreaterThanOrEqual(1)

    const replay = buffer.read(`${HUB}:1`)
    expect(replay.gap).toBe(false)
    expect(replay.events.map((entry) => entry.cursor)).toEqual([
      `${HUB}:2`, `${HUB}:3`, `${HUB}:4`,
    ])

    appendEvent(buffer, { sessionId: 's2' })
    expect(buffer.size().events).toBe(4)
    const other = buffer.read(`${HUB}:4`)
    expect(other.events).toHaveLength(1)
    expect(other.events[0]?.event.sessionId).toBe('s2')
  })

  it('会话字节上限单独淘汰最旧项', () => {
    const buffer = makeBuffer({ sessionBytesMax: 700 })
    for (let i = 0; i < 3; i += 1) {
      appendEvent(buffer, { payload: { text: 'y'.repeat(200) } })
    }
    const size = buffer.size()
    expect(size.events).toBeGreaterThan(0)
    expect(size.events).toBeLessThan(3)
    expect(size.bytes).toBeLessThanOrEqual(700)
    expect(size.sessions).toBe(1)
  })
})

describe('EventBuffer hub 总字节上限', () => {
  it('超过 hub 预算时淘汰全局最旧项并报告 dropped', () => {
    const buffer = makeBuffer({ hubBytesMax: 400 })
    let lastDropped = 0
    for (let i = 0; i < 6; i += 1) {
      lastDropped = buffer.append(makeEvent({ payload: { text: 'x'.repeat(120) } })).dropped
    }
    const size = buffer.size()
    expect(size.bytes).toBeLessThanOrEqual(400)
    expect(size.events).toBeGreaterThanOrEqual(1)
    expect(lastDropped).toBeGreaterThan(0)
    expect(buffer.read(`${HUB}:0`).gap).toBe(true)
  })
})

describe('EventBuffer 保留窗', () => {
  it('按接收时间过期，事件 ts 很新也不能延长；无 append 也会清理', () => {
    let now = 1_000_000
    const buffer = makeBuffer({ ttlMs: 100, now: () => now })
    const first = buffer.append(makeEvent({ ts: now + 1_000_000_000 }))
    expect(first.accepted).toBe(true)
    const cursor = first.cursor ?? ''
    appendEvent(buffer, { ts: now + 1_000_000_000 })

    now += 50
    expect(buffer.size().events).toBe(2)

    now += 51
    expect(buffer.read(cursor).gap).toBe(true)
    expect(buffer.size().events).toBe(0)
    expect(buffer.size().bytes).toBe(0)
    expect(buffer.cursor()).toBe(`${HUB}:0`)
  })

  it('仅调用 read 也会先清理过期项', () => {
    let now = 5_000
    const buffer = makeBuffer({ ttlMs: 100, now: () => now })
    const cursor = appendEvent(buffer, { ts: now + 1_000_000_000 })
    appendEvent(buffer, { ts: now + 1_000_000_000 })
    now += 101
    expect(buffer.read(cursor).gap).toBe(true)
    expect(buffer.size().events).toBe(0)
  })
})

describe('EventBuffer purge/clear/dispose', () => {
  it('purgeDevice 只删除该设备并让旧游标 gap', () => {
    const buffer = makeBuffer()
    appendEvent(buffer, { deviceId: 'dev-a' })
    appendEvent(buffer, { deviceId: 'dev-a' })
    appendEvent(buffer, { deviceId: 'dev-b', sessionId: 's2' })
    expect(buffer.size().events).toBe(3)

    expect(buffer.purgeDevice('dev-a')).toBe(2)
    expect(buffer.size().events).toBe(1)
    expect(buffer.size().sessions).toBe(1)

    expect(buffer.read(`${HUB}:0`).gap).toBe(true)
    expect(buffer.read(`${HUB}:1`).gap).toBe(true)

    const remaining = buffer.read(`${HUB}:2`)
    expect(remaining.gap).toBe(false)
    expect(remaining.events.map((entry) => entry.event.deviceId)).toEqual(['dev-b'])
    expect(buffer.purgeDevice('missing')).toBe(0)
  })

  it('clear 后旧游标 gap，游标号继续单调递增', () => {
    const buffer = makeBuffer()
    appendEvent(buffer)
    appendEvent(buffer)
    const old = buffer.cursor()
    expect(old).toBe(`${HUB}:2`)

    buffer.clear()
    expect(buffer.size()).toEqual({ events: 0, bytes: 0, sessions: 0 })
    expect(buffer.cursor()).toBe(`${HUB}:0`)
    expect(buffer.read(old).gap).toBe(true)
    expect(buffer.read(`${HUB}:0`).gap).toBe(true)

    const next = appendEvent(buffer)
    expect(next).toBe(`${HUB}:3`)
    expect(buffer.cursor()).toBe(`${HUB}:3`)
    expect(buffer.read(old).gap).toBe(true)
    expect(buffer.read(`${HUB}:3`).events).toHaveLength(0)
  })

  it('dispose 后 append 拒收、read gap、size 归零', () => {
    const buffer = makeBuffer()
    const old = appendEvent(buffer)
    buffer.dispose()

    const result = buffer.append(makeEvent())
    expect(result.accepted).toBe(false)
    expect(result.cursor).toBeUndefined()
    expect(buffer.size()).toEqual({ events: 0, bytes: 0, sessions: 0 })
    expect(buffer.cursor()).toBe(`${HUB}:0`)

    const read = buffer.read(old)
    expect(read.gap).toBe(true)
    expect(read.events).toHaveLength(0)
    expect(buffer.purgeDevice('dev-a')).toBe(0)
  })
})
