import { describe, expect, it } from 'vitest'
import type { AskUserQuestionAnswerLike, AskUserQuestionRequestLike, MarshalContext, UserQuestionLike } from '../src/dsh-types.ts'
import {
  InputTable, mapAnswer, readNativeExpiry, resolveDeadline, stillAuthorized,
  type InputAuthorization, type PendingInput,
} from '../src/node/inputs.ts'
import type { CardMapping, PrivacyProjector } from '../src/node/privacy.ts'
import { createPrivacyProjector } from '../src/node/privacy.ts'
import { createQuestionRelay } from '../src/node/questions.ts'
import type { EventFrame } from '../src/wire/frames.ts'

const questions: readonly UserQuestionLike[] = [
  { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
]

function mapping(overrides: Partial<{
  required: boolean
  multi: boolean
  custom: boolean
  options: Map<string, string>
}> = {}): CardMapping {
  return {
    questions: new Map([['q1', {
      nativeId: 'native-q1',
      required: overrides.required ?? true,
      multi: overrides.multi ?? false,
      custom: overrides.custom ?? true,
      options: overrides.options ?? new Map([['q1o1', 'A'], ['q1o2', 'B']]),
    }]]),
  }
}

function pendingEntry(
  table: InputTable,
  requestId: string,
  overrides: Partial<PendingInput> = {},
): PendingInput {
  const entry: PendingInput = {
    deviceId: 'mac',
    agent: 'dsh',
    runtimeEpoch: 'epoch-1',
    sessionId: 's1',
    requestId,
    questions,
    mapping: mapping(),
    authorization: {
      relay: 'remote', operatorId: 'op-1', policyRevision: 1,
      allowInteractions: true, content: false,
    },
    expiresAt: 2_000,
    monoDeadline: 1_000,
    settled: false,
    finish() {},
    ...overrides,
  }
  table.add(entry)
  return entry
}

describe('readNativeExpiry', () => {
  it('没有任何期限字段时返回 none', () => {
    expect(readNativeExpiry({})).toBe('none')
    expect(readNativeExpiry(null)).toBe('none')
    expect(readNativeExpiry({ questions: [] })).toBe('none')
  })

  it('接受 node-clock/foreign-clock 的已验证形状', () => {
    expect(readNativeExpiry({ nativeExpiry: { kind: 'node-clock', atMs: 1_000 } }))
      .toEqual({ kind: 'node-clock', atMs: 1_000 })
    expect(readNativeExpiry({
      expires_at: { kind: 'foreign-clock', atMs: 5_000, foreignNowMs: 1_000, uncertaintyMs: 200 },
    })).toEqual({ kind: 'foreign-clock', atMs: 5_000, foreignNowMs: 1_000, uncertaintyMs: 200 })
  })

  it('数值、相对时长与未知形状都不可验证', () => {
    expect(readNativeExpiry({ expiresAt: 1_000 })).toBe('unverifiable')
    expect(readNativeExpiry({ deadline: { durationMs: 5_000 } })).toBe('unverifiable')
    expect(readNativeExpiry({ nativeExpiry: { kind: 'relative', atMs: 1 } })).toBe('unverifiable')
    expect(readNativeExpiry({ nativeExpiry: { kind: 'node-clock', atMs: 1, extra: 2 } })).toBe('unverifiable')
    expect(readNativeExpiry({
      nativeExpiry: { kind: 'foreign-clock', atMs: 1, foreignNowMs: 0, uncertaintyMs: -1 },
    })).toBe('unverifiable')
    expect(readNativeExpiry({
      nativeExpiry: { kind: 'foreign-clock', atMs: Number.NaN, foreignNowMs: 0, uncertaintyMs: 0 },
    })).toBe('unverifiable')
  })
})

describe('resolveDeadline', () => {
  const base = { createdAt: 1_000, timeoutMs: 10_000, now: 1_000, monoNow: 100 }

  it('无原生期限只用配置上限', () => {
    expect(resolveDeadline({ ...base, native: 'none' })).toEqual({
      expiresAt: 11_000, monoDeadline: 10_100,
    })
  })

  it('node-clock 取 min，早于/晚于都正确', () => {
    expect(resolveDeadline({ ...base, native: { kind: 'node-clock', atMs: 5_000 } }))
      .toEqual({ expiresAt: 5_000, monoDeadline: 4_100 })
    expect(resolveDeadline({ ...base, native: { kind: 'node-clock', atMs: 50_000 } }))
      .toEqual({ expiresAt: 11_000, monoDeadline: 10_100 })
  })

  it('foreign-clock 扣除不确定度后取最早可能截止', () => {
    expect(resolveDeadline({
      ...base,
      native: { kind: 'foreign-clock', atMs: 6_000, foreignNowMs: 1_000, uncertaintyMs: 500 },
    })).toEqual({ expiresAt: 5_500, monoDeadline: 4_600 })
  })

  it('unverifiable/畸形输入一律 undefined', () => {
    expect(resolveDeadline({ ...base, native: 'unverifiable' })).toBeUndefined()
    expect(resolveDeadline({ ...base, createdAt: Number.NaN, native: 'none' })).toBeUndefined()
    expect(resolveDeadline({ ...base, timeoutMs: -1, native: 'none' })).toBeUndefined()
    expect(resolveDeadline({ ...base, now: Number.POSITIVE_INFINITY, native: 'none' })).toBeUndefined()
    expect(resolveDeadline({ ...base, native: { kind: 'node-clock', atMs: 1.5 } })).toBeUndefined()
  })

  it('单调期限只由认领时的 monoNow 与剩余时间决定，墙钟回拨不延长', () => {
    const claimed = resolveDeadline({ ...base, now: 5_000, monoNow: 200, native: 'none' })
    // 墙钟回拨到 0：剩余时间变大，但 monoDeadline 已经是固定值，不能重算。
    expect(claimed?.monoDeadline).toBe(200 + 6_000)
    expect(claimed?.expiresAt).toBe(11_000)
  })
})

describe('stillAuthorized', () => {
  const snapshot: InputAuthorization = {
    relay: 'remote', operatorId: 'op-1', policyRevision: 1,
    allowInteractions: true, content: false,
  }

  it('要求当前 remote + allowInteractions 且身份/修订一致', () => {
    expect(stillAuthorized(snapshot, snapshot)).toBe(true)
    expect(stillAuthorized(snapshot, { ...snapshot, relay: 'off' })).toBe(false)
    expect(stillAuthorized(snapshot, { ...snapshot, allowInteractions: false })).toBe(false)
    expect(stillAuthorized(snapshot, { ...snapshot, operatorId: 'op-2' })).toBe(false)
    expect(stillAuthorized(snapshot, { ...snapshot, policyRevision: 2 })).toBe(false)
    expect(stillAuthorized(snapshot, undefined)).toBe(false)
    expect(stillAuthorized(undefined, snapshot)).toBe(false)
  })
})

describe('InputTable', () => {
  it('拒绝重复 requestId，并按密钥读写', () => {
    const table = new InputTable()
    const entry = pendingEntry(table, 'r1')
    expect(table.size).toBe(1)
    expect(table.add(entry)).toBe(false)
    expect(table.get('mac', 'dsh', 's1', 'r1')).toBe(entry)
    expect(table.get('mac', 'dsh', 's2', 'r1')).toBeUndefined()
    expect(table.find('r1')).toBe(entry)
    table.remove(entry)
    expect(table.size).toBe(0)
  })

  it('invalidateAll 只结束一次', () => {
    const table = new InputTable()
    let finished = 0
    pendingEntry(table, 'r1', { finish: () => { finished += 1 } })
    table.invalidateAll('invalidated')
    expect(finished).toBe(1)
    expect(table.size).toBe(0)
    expect(table.find('r1')).toBeUndefined()
  })
})

describe('mapAnswer', () => {
  const wire = (id: string, selectedOptionIds: string[], text?: string) => ({
    answers: [{ id, selectedOptionIds, ...(text === undefined ? {} : { text }) }],
  })

  it('把稳定选项 ID 映射回原始 label', () => {
    expect(mapAnswer(wire('q1', ['q1o2']), mapping())).toEqual({
      answers: [{ id: 'native-q1', selected: ['B'] }],
    })
  })

  it('未知选项 ID、重复选项、重复问题、缺题/多题都拒绝', () => {
    expect(mapAnswer(wire('q1', ['nope']), mapping())).toBeUndefined()
    expect(mapAnswer(wire('q1', ['q1o1', 'q1o1']), mapping())).toBeUndefined()
    expect(mapAnswer({ answers: [{ id: 'q1', selectedOptionIds: ['q1o1'] }, { id: 'q1', selectedOptionIds: ['q1o2'] }] }, mapping()))
      .toBeUndefined()
    expect(mapAnswer({ answers: [] }, mapping())).toBeUndefined()
    expect(mapAnswer({ answers: [{ id: 'q1', selectedOptionIds: ['q1o1'] }, { id: 'q2', selectedOptionIds: [] }] }, mapping()))
      .toBeUndefined()
  })

  it('单选最多一个，多选接受多个', () => {
    expect(mapAnswer(wire('q1', ['q1o1', 'q1o2']), mapping())).toBeUndefined()
    expect(mapAnswer(wire('q1', ['q1o1', 'q1o2']), mapping({ multi: true }))).toEqual({
      answers: [{ id: 'native-q1', selected: ['A', 'B'] }],
    })
  })

  it('必答且无选项无文本时拒绝；自由文本仅在 custom 时允许', () => {
    expect(mapAnswer(wire('q1', []), mapping())).toBeUndefined()
    expect(mapAnswer(wire('q1', [], '自定义'), mapping())).toEqual({
      answers: [{ id: 'native-q1', selected: [], custom: '自定义' }],
    })
    expect(mapAnswer(wire('q1', [], '自定义'), mapping({ custom: false }))).toBeUndefined()
    expect(mapAnswer(wire('q1', [], '自定义'), mapping({ required: false }))).toEqual({
      answers: [{ id: 'native-q1', selected: [], custom: '自定义' }],
    })
  })

  it('自由文本按 UTF-8 字节上限拒绝', () => {
    expect(mapAnswer(wire('q1', [], 'x'.repeat(4_096)), mapping())).toBeDefined()
    expect(mapAnswer(wire('q1', [], 'x'.repeat(4_097)), mapping())).toBeUndefined()
  })
})

function projector(): PrivacyProjector {
  return createPrivacyProjector({
    privacy: 'metadata',
    allowContent: false,
    questionRelay: 'remote',
    approvalRelay: 'off',
    allowInteractions: true,
    redaction: [],
    deviceId: 'mac',
    agent: 'dsh',
    nodeEpoch: 'epoch-1',
    now: () => 1,
  })
}

function harness(timeoutMs = 1_000) {
  const sent: EventFrame[] = []
  let handler: ((request: AskUserQuestionRequestLike, next: () => Promise<AskUserQuestionAnswerLike>) => Promise<AskUserQuestionAnswerLike>) | undefined
  const ctx: Pick<MarshalContext, 'on'> = {
    on(_event, fn) { handler = fn; return () => {} },
  }
  let clock = { now: 1_000, mono: 10 }
  let auth: InputAuthorization = {
    relay: 'remote', operatorId: 'op-1', policyRevision: 1,
    allowInteractions: true, content: false,
  }
  let seq = 0
  const relay = createQuestionRelay({
    ctx,
    timeoutMs,
    projector: projector(),
    runtimeEpoch: 'epoch-1',
    send: event => sent.push(event),
    frame: (sessionId, kind, payload): EventFrame => ({
      v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId, nodeEpoch: 'epoch-1',
      seq: ++seq, ts: 1, kind, payload,
    }),
    authorization: () => auth,
    available: () => true,
    now: () => clock.now,
    monoNow: () => clock.mono,
    deviceId: 'mac',
    agent: 'dsh',
  })
  const ask = (): Promise<AskUserQuestionAnswerLike> => {
    const fn = handler
    if (fn === undefined) throw new Error('relay did not subscribe')
    return fn({ questions, agent: { session: { id: 's1' } } }, () => Promise.reject(new Error('local')))
  }
  return {
    relay,
    sent,
    ask,
    setClock: (next: { now: number; mono: number }) => { clock = next },
    setPolicyRevision: (revision: number) => { auth = { ...auth, policyRevision: revision } },
  }
}

function requestIdOf(event: EventFrame | undefined): string {
  if (event === undefined) throw new Error('no event emitted')
  return (event.payload as { requestId: string }).requestId
}

describe('question relay input table integration', () => {
  it('快照返回当前有效卡，过期后不返回且只结算一次', () => {
    const h = harness()
    const first = h.ask()
    const second = h.ask()
    first.catch(() => {})
    second.catch(() => {})
    expect(h.relay.snapshot('s1')).toHaveLength(2)
    h.setClock({ now: 5_000, mono: 5_000 })
    expect(h.relay.snapshot('s1')).toHaveLength(0)
    expect(h.sent.filter(event => event.kind === 'input.resolved')).toHaveLength(2)
    expect(h.relay.snapshot('s1')).toHaveLength(0)
  })

  it('授权修订变化时快照排除并作废旧卡', () => {
    const h = harness()
    const pending = h.ask()
    pending.catch(() => {})
    h.setPolicyRevision(2)
    expect(h.relay.snapshot('s1')).toHaveLength(0)
    const state = (h.sent[1]?.payload as { state: string }).state
    expect(state).toBe('invalidated')
    expect(h.relay.settle('s1', requestIdOf(h.sent[0]), {
      answers: [{ id: 'q1', selectedOptionIds: ['q1o1'] }],
    })).toBe('unknown')
  })

  it('同一请求只接受一次合法答案', () => {
    const h = harness()
    const pending = h.ask()
    const requestId = requestIdOf(h.sent[0])
    const wire = { answers: [{ id: 'q1', selectedOptionIds: ['q1o1'] }] }
    expect(h.relay.settle('s1', requestId, wire)).toBe('ok')
    expect(h.relay.settle('s1', requestId, wire)).toBe('unknown')
    return expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
  })

  it('墙钟回拨但单调期限已到时拒绝回答', () => {
    const h = harness()
    const pending = h.ask()
    pending.catch(() => {})
    const requestId = requestIdOf(h.sent[0])
    h.setClock({ now: 0, mono: 2_000 })
    expect(h.relay.settle('s1', requestId, {
      answers: [{ id: 'q1', selectedOptionIds: ['q1o1'] }],
    })).toBe('expired')
    expect((h.sent[1]?.payload as { state: string }).state).toBe('expired')
  })

  it('无效答案不消耗请求', () => {
    const h = harness()
    const pending = h.ask()
    const requestId = requestIdOf(h.sent[0])
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selectedOptionIds: ['nope'] }] }))
      .toBe('invalid')
    expect(h.relay.snapshot('s1')).toHaveLength(1)
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selectedOptionIds: ['q1o1'] }] }))
      .toBe('ok')
    return expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
  })
})
