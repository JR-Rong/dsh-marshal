import { describe, expect, it } from 'vitest'
import type { NativeInputClaim, NativeInputDecision, NativeInputPort, RelayPolicy } from '../src/agents/types.ts'
import { createInteractionRelay } from '../src/node/interactions.ts'
import { createPrivacyProjector } from '../src/node/privacy.ts'
import type { EventFrame } from '../src/wire/frames.ts'

const DEVICE = 'mac'
const AGENT = 'codex'
const SESSION = 's1'
const EPOCH = 'epoch-1'

const questionClaim = (extra: Record<string, unknown> = {}): NativeInputClaim => ({
  kind: 'question',
  sessionId: SESSION,
  runtimeEpoch: EPOCH,
  questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }],
  ...extra,
} as NativeInputClaim)

const approvalClaim = (extra: Record<string, unknown> = {}): NativeInputClaim => ({
  kind: 'approval',
  sessionId: SESSION,
  runtimeEpoch: EPOCH,
  approval: {
    action: '运行命令',
    decisions: [
      { id: 'accept', label: '允许一次' },
      { id: 'decline', label: '拒绝' },
      { id: 'cancel', label: '取消' },
    ],
  },
  ...extra,
} as NativeInputClaim)

function wire(id: string, selectedOptionIds: string[], text?: string): unknown {
  return { answers: [{ id, selectedOptionIds, ...(text === undefined ? {} : { text }) }] }
}

interface HarnessOptions {
  readonly questionRelay?: RelayPolicy
  readonly approvalRelay?: RelayPolicy
  readonly allowInteractions?: boolean
  readonly questionTimeoutMs?: number
  readonly approvalTimeoutMs?: number
  readonly send?: (event: EventFrame) => void
}

function harness(options: HarnessOptions = {}) {
  const questionRelay = options.questionRelay ?? 'remote'
  const approvalRelay = options.approvalRelay ?? 'remote'
  const allowInteractions = options.allowInteractions ?? true
  const sent: EventFrame[] = []
  let clock = { now: 1_000_000, mono: 0 }
  let revision = 1
  let available = true
  let owned = true
  let seq = 0

  const projector = createPrivacyProjector({
    privacy: 'metadata',
    allowContent: false,
    questionRelay,
    approvalRelay,
    allowInteractions,
    redaction: [],
    deviceId: DEVICE,
    agent: AGENT,
    nodeEpoch: 'node-epoch-1',
    now: () => 1,
  })

  const relay: NativeInputPort = createInteractionRelay({
    questionRelay,
    approvalRelay,
    questionTimeoutMs: options.questionTimeoutMs ?? 10_000,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 10_000,
    projector,
    runtimeEpoch: EPOCH,
    send: options.send ?? (event => sent.push(event)),
    frame: (sessionId, kind, payload): EventFrame => ({
      v: 2, type: 'event', deviceId: DEVICE, agent: AGENT, sessionId, nodeEpoch: 'node-epoch-1',
      seq: ++seq, ts: 1, kind, payload,
    }),
    authorization: () => ({
      operatorId: 'op-1', policyRevision: revision, allowInteractions, content: false,
    }),
    available: () => available,
    stillOwned: () => owned,
    deviceId: DEVICE,
    agent: AGENT,
    now: () => clock.now,
    monoNow: () => clock.mono,
  })

  return {
    relay,
    sent,
    claim: (input: NativeInputClaim, signal?: AbortSignal): Promise<NativeInputDecision> =>
      relay.claim(input, signal ?? new AbortController().signal),
    setClock: (next: { now: number; mono: number }): void => { clock = next },
    setRevision: (next: number): void => { revision = next },
    setAvailable: (next: boolean): void => { available = next },
    setOwned: (next: boolean): void => { owned = next },
  }
}

function requestIdOf(event: EventFrame | undefined): string {
  if (event === undefined) throw new Error('no event emitted')
  return (event.payload as { requestId: string }).requestId
}

function payloadOf(event: EventFrame | undefined): Record<string, unknown> {
  if (event === undefined) throw new Error('no event emitted')
  return event.payload as Record<string, unknown>
}

describe('interaction relay policy', () => {
  it('off 不建卡不发事件，立即保守拒绝', async () => {
    const h = harness({ questionRelay: 'off', approvalRelay: 'off' })
    await expect(h.claim(questionClaim())).resolves.toEqual({ decision: 'decline' })
    await expect(h.claim(approvalClaim())).resolves.toEqual({ decision: 'decline' })
    expect(h.sent).toEqual([])
  })

  it('notify 只发无正文 waitKind，立即保守拒绝', async () => {
    const h = harness({ questionRelay: 'notify', approvalRelay: 'notify' })
    await expect(h.claim(questionClaim())).resolves.toEqual({ decision: 'decline' })
    expect(h.sent.map(event => event.kind)).toEqual(['session.updated'])
    const payload = payloadOf(h.sent[0])
    expect(payload.waitKind).toBe('question')
    expect(payload.questions).toBeUndefined()
    expect(payload.approval).toBeUndefined()
    expect(payload.acceptOnceEligible).toBeUndefined()
    expect(payload.requestId).toBeUndefined()

    await expect(h.claim(approvalClaim())).resolves.toEqual({ decision: 'decline' })
    expect(h.sent).toHaveLength(2)
    expect(payloadOf(h.sent[1]).waitKind).toBe('approval')
  })

  it('remote 但 hub 未 allowInteractions 按 off 处理', async () => {
    const h = harness({ allowInteractions: false })
    await expect(h.claim(questionClaim())).resolves.toEqual({ decision: 'decline' })
    await expect(h.claim(approvalClaim())).resolves.toEqual({ decision: 'decline' })
    expect(h.sent).toEqual([])
  })
})

describe('question relay', () => {
  it('remote 发随机 requestId 的可答卡，answer 后一次性结算', async () => {
    const h = harness()
    const pending = h.claim(questionClaim())
    expect(h.sent.map(event => event.kind)).toEqual(['input.requested'])
    const payload = payloadOf(h.sent[0])
    expect(payload.kind).toBe('question')
    expect(payload.sessionId).toBe(SESSION)
    expect(payload.runtimeEpoch).toBe(EPOCH)
    expect(payload.acceptOnceEligible).toBe(true)
    expect(payload.expiresAt).toBe(1_010_000)
    const requestId = requestIdOf(h.sent[0])
    expect(requestId).toMatch(/^q-[0-9a-f-]{36}$/)

    // 另一张卡的 requestId 必须不同，不能从原生 id/序号推导。
    const other = h.claim(questionClaim())
    other.catch(() => {})
    expect(requestIdOf(h.sent[1])).not.toBe(requestId)

    expect(h.relay.answer(SESSION, requestId, wire('q1', ['q1o1']))).toBe('ok')
    await expect(pending).resolves.toEqual({
      decision: 'answer',
      value: { answers: [{ id: 'q1', selected: ['A'] }] },
    })
    expect(h.sent.map(event => event.kind)).toEqual([
      'input.requested', 'input.requested', 'input.resolved',
    ])
    const resolved = payloadOf(h.sent[2])
    expect(resolved).toEqual({ requestId, state: 'answered' })
    expect(JSON.stringify(resolved)).not.toContain('A')
  })

  it('非法问题答案返回 invalid 且不消耗请求', async () => {
    const h = harness()
    const pending = h.claim(questionClaim())
    const requestId = requestIdOf(h.sent[0])
    // 未知选项、缺必答、重复答案项都属于非法形状。
    expect(h.relay.answer(SESSION, requestId, wire('q1', ['Z']))).toBe('invalid')
    expect(h.relay.answer(SESSION, requestId, { answers: [] })).toBe('invalid')
    expect(h.relay.answer(SESSION, requestId, {
      answers: [{ id: 'q1', selectedOptionIds: ['q1o1'] }, { id: 'q1', selectedOptionIds: ['q1o2'] }],
    })).toBe('invalid')
    expect(h.relay.snapshot(SESSION)).toHaveLength(1)
    expect(h.relay.answer(SESSION, requestId, wire('q1', ['q1o2']))).toBe('ok')
    await expect(pending).resolves.toEqual({
      decision: 'answer',
      value: { answers: [{ id: 'q1', selected: ['B'] }] },
    })
  })

  it('secret 问题降级为无正文卡，伪造答案返回 decision-invalid', async () => {
    const secret = [{
      id: 'q1', question: '口令？', secret: true, options: [{ label: 'A' }],
    }]
    const h = harness()
    await expect(h.claim(questionClaim({ questions: secret }))).resolves.toEqual({ decision: 'decline' })
    expect(h.sent.map(event => event.kind)).toEqual(['input.requested'])
    const payload = payloadOf(h.sent[0])
    expect(payload.reason).toBe('secret-local-only')
    expect(payload.questions).toBeUndefined()
    expect(payload.acceptOnceEligible).toBe(false)
    expect(h.relay.answer(SESSION, requestIdOf(h.sent[0]), wire('q1', ['q1o1']))).toBe('decision-invalid')
  })

  it('超时按拒绝结束并发出 expired', async () => {
    const h = harness({ questionTimeoutMs: 5 })
    await expect(h.claim(questionClaim())).resolves.toEqual({ decision: 'decline' })
    expect(h.sent.map(event => event.kind)).toEqual(['input.requested', 'input.resolved'])
    expect(payloadOf(h.sent[1]).state).toBe('expired')
    expect(h.relay.answer(SESSION, requestIdOf(h.sent[0]), wire('q1', ['q1o1']))).toBe('unknown')
  })

  it('abort 立即结束等待并发出 cancelled，决定为 decline', async () => {
    const h = harness()
    const abort = new AbortController()
    const pending = h.claim(questionClaim(), abort.signal)
    const requestId = requestIdOf(h.sent[0])
    abort.abort()
    await expect(pending).resolves.toEqual({ decision: 'decline' })
    expect(h.sent.map(event => event.kind)).toEqual(['input.requested', 'input.resolved'])
    expect(payloadOf(h.sent[1]).state).toBe('cancelled')
    expect(h.relay.answer(SESSION, requestId, wire('q1', ['q1o1']))).toBe('unknown')
  })

  it('回答入口同步检查到期', async () => {
    const h = harness()
    const pending = h.claim(questionClaim())
    pending.catch(() => {})
    h.setClock({ now: 1_010_000, mono: 10_000 })
    expect(h.relay.answer(SESSION, requestIdOf(h.sent[0]), wire('q1', ['q1o1']))).toBe('expired')
    expect(payloadOf(h.sent[1]).state).toBe('expired')
  })
})

describe('approval relay', () => {
  it('只接受本卡决策 id 的单项答案', async () => {
    const h = harness()
    const pending = h.claim(approvalClaim())
    expect(h.sent.map(event => event.kind)).toEqual(['input.requested'])
    const payload = payloadOf(h.sent[0])
    expect(payload.kind).toBe('approval')
    expect(payload.acceptOnceEligible).toBe(true)
    const approval = payload.approval as { action: string; decisions: { id: string }[] }
    expect(approval.decisions.map(item => item.id)).toEqual(['accept', 'decline', 'cancel'])
    const requestId = requestIdOf(h.sent[0])
    expect(requestId).toMatch(/^a-[0-9a-f-]{36}$/)

    // 伪造 id、额外选项、文本与多项答案都不能消耗请求。
    expect(h.relay.answer(SESSION, requestId, wire('always-allow', []))).toBe('invalid')
    expect(h.relay.answer(SESSION, requestId, wire('accept', ['q1o1']))).toBe('invalid')
    expect(h.relay.answer(SESSION, requestId, wire('accept', [], 'yes'))).toBe('invalid')
    expect(h.relay.answer(SESSION, requestId, {
      answers: [
        { id: 'accept', selectedOptionIds: [] },
        { id: 'decline', selectedOptionIds: [] },
      ],
    })).toBe('invalid')
    expect(h.relay.snapshot(SESSION)).toHaveLength(1)

    expect(h.relay.answer(SESSION, requestId, wire('accept', []))).toBe('ok')
    await expect(pending).resolves.toEqual({ decision: 'answer', value: 'accept' })
    expect(payloadOf(h.sent[1])).toEqual({ requestId, state: 'answered' })
  })

  it('decline/cancel 分别结算为拒绝与取消', async () => {
    const declined = harness()
    const declinedPending = declined.claim(approvalClaim())
    const declinedId = requestIdOf(declined.sent[0])
    expect(declined.relay.answer(SESSION, declinedId, wire('decline', []))).toBe('ok')
    await expect(declinedPending).resolves.toEqual({ decision: 'decline' })
    expect(payloadOf(declined.sent[1])).toEqual({ requestId: declinedId, state: 'declined' })

    const cancelled = harness()
    const cancelledPending = cancelled.claim(approvalClaim())
    const cancelledId = requestIdOf(cancelled.sent[0])
    expect(cancelled.relay.answer(SESSION, cancelledId, wire('cancel', []))).toBe('ok')
    await expect(cancelledPending).resolves.toEqual({ decision: 'cancel' })
    expect(payloadOf(cancelled.sent[1])).toEqual({ requestId: cancelledId, state: 'cancelled' })
  })
})

describe('claims, ownership and transport', () => {
  it('available() 为 false 时拒绝新认领，已有卡仍可作答', async () => {
    const h = harness()
    h.setAvailable(false)
    await expect(h.claim(questionClaim())).resolves.toEqual({ decision: 'decline' })
    expect(h.sent).toEqual([])

    h.setAvailable(true)
    const pending = h.claim(questionClaim())
    const requestId = requestIdOf(h.sent[0])
    h.setAvailable(false)
    // 断线只暂停新认领/远端作答；已认领请求按原期限在 node 内继续等。
    expect(h.relay.answer(SESSION, requestId, wire('q1', ['q1o1']))).toBe('ok')
    await expect(pending).resolves.toEqual({
      decision: 'answer',
      value: { answers: [{ id: 'q1', selected: ['A'] }] },
    })
  })

  it('写权丢失时拒绝认领，并在作答时作废旧卡', async () => {
    const h = harness()
    h.setOwned(false)
    await expect(h.claim(questionClaim())).resolves.toEqual({ decision: 'decline' })
    expect(h.sent).toEqual([])

    h.setOwned(true)
    const pending = h.claim(questionClaim())
    pending.catch(() => {})
    const requestId = requestIdOf(h.sent[0])
    h.setOwned(false)
    expect(h.relay.answer(SESSION, requestId, wire('q1', ['q1o1']))).toBe('decision-invalid')
    expect(h.sent.map(event => event.kind)).toEqual(['input.requested', 'input.resolved'])
    expect(payloadOf(h.sent[1]).state).toBe('invalidated')
  })

  it('策略修订变化后 revalidate 一次性作废旧卡', async () => {
    const h = harness()
    const pending = h.claim(questionClaim())
    const requestId = requestIdOf(h.sent[0])
    h.setRevision(2)
    h.relay.revalidate()
    await expect(pending).resolves.toEqual({ decision: 'decline' })
    expect(payloadOf(h.sent[1]).state).toBe('invalidated')
    // 旧卡不能靠迟到的答案复活。
    expect(h.relay.answer(SESSION, requestId, wire('q1', ['q1o1']))).toBe('decision-invalid')
  })

  it('invalidate 结束等待且快照不再恢复', async () => {
    const h = harness()
    const pending = h.claim(questionClaim())
    pending.catch(() => {})
    const requestId = requestIdOf(h.sent[0])
    h.relay.invalidate()
    expect(h.relay.snapshot(SESSION)).toEqual([])
    expect(payloadOf(h.sent[1]).state).toBe('invalidated')
    expect(h.relay.answer(SESSION, requestId, wire('q1', ['q1o1']))).toBe('unknown')
  })
})

describe('snapshot and native expiry', () => {
  it('快照沿用原始到期时刻重投影，不延长等待', async () => {
    const h = harness()
    const pending = h.claim(questionClaim())
    pending.catch(() => {})
    const requested = payloadOf(h.sent[0])
    const cards = h.relay.snapshot(SESSION)
    expect(cards).toHaveLength(1)
    const card = cards[0] as Record<string, unknown>
    expect(card.requestId).toBe(requested.requestId)
    expect(card.expiresAt).toBe(requested.expiresAt)
    expect(card.acceptOnceEligible).toBe(true)
    expect(h.relay.snapshot('other')).toEqual([])
  })

  it('node-clock 早于配置期限时收紧 expiresAt', async () => {
    const h = harness()
    const pending = h.claim(questionClaim({ nativeExpiry: { kind: 'node-clock', atMs: 1_003_000 } }))
    pending.catch(() => {})
    expect(payloadOf(h.sent[0]).expiresAt).toBe(1_003_000)
    h.relay.dispose()
  })

  it('foreign-clock 扣除不确定度后取最早可能截止', async () => {
    const h = harness()
    const pending = h.claim(questionClaim({
      nativeExpiry: {
        kind: 'foreign-clock', atMs: 9_000, foreignNowMs: 1_000, uncertaintyMs: 500,
      },
    }))
    pending.catch(() => {})
    // createdAt 1_000_000 + (9000 - 1000 - 500) = 1_007_500，早于 10s 上限。
    expect(payloadOf(h.sent[0]).expiresAt).toBe(1_007_500)
    h.relay.dispose()
  })

  it('无法验证的期限形状不认领远端请求', async () => {
    for (const nativeExpiry of [{ kind: 'weird' }, 123, { durationMs: 5_000 }]) {
      const h = harness()
      await expect(h.claim(questionClaim({ nativeExpiry }))).resolves.toEqual({ decision: 'decline' })
      expect(h.sent).toEqual([])
    }
  })
})
