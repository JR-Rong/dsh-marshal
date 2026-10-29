import { describe, expect, it } from 'vitest'
import { createDshAdapter } from '../src/adapters/dsh/adapter.ts'
import type { AskUserQuestionAnswerLike, AskUserQuestionRequestLike, MarshalContext } from '../src/dsh-types.ts'
import { createQuestionRelay, parseAnswers, type QuestionRelay } from '../src/node/questions.ts'
import { createFollower, runCommand } from '../src/node/runner.ts'
import type { NodeLink } from '../src/node/link.ts'
import type { EventFrame, Frame } from '../src/wire/frames.ts'

const questions = [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }]

type Handler = (request: AskUserQuestionRequestLike, next: () => Promise<AskUserQuestionAnswerLike>) => Promise<AskUserQuestionAnswerLike>

function harness(timeoutMs = 50) {
  const sent: EventFrame[] = []
  let handler: Handler | undefined
  const ctx: Pick<MarshalContext, 'on'> = {
    on(_event, fn) {
      handler = fn
      return () => { handler = undefined }
    },
  }
  let seq = 0
  const relay = createQuestionRelay({
    ctx,
    timeoutMs,
    send: event => sent.push(event),
    frame: (sessionId, kind, payload): EventFrame => ({
      v: 1, type: 'event', device: 'mac', agent: 'dsh', sessionId, seq: ++seq, ts: 't', kind, payload,
    }),
  })
  const ask = (signal?: AbortSignal): Promise<AskUserQuestionAnswerLike> => {
    const fn = handler
    if (fn === undefined) throw new Error('relay did not subscribe')
    return fn(
      { questions, agent: { session: { id: 's1' } }, ...(signal === undefined ? {} : { signal }) },
      () => Promise.reject(new Error('fell through to local')),
    )
  }
  return { relay, sent, ask }
}

/** input.requested 由 handler 同步发出，ask() 返回时第一帧已经在 sent 里。 */
function requestIdOf(event: EventFrame | undefined): string {
  if (event === undefined) throw new Error('no event emitted')
  return (event.payload as { requestId: string }).requestId
}

describe('question relay', () => {
  it('发 input.requested 并等远端答案', async () => {
    const h = harness()
    const pending = h.ask()
    const requested = h.sent[0]
    expect(requested?.kind).toBe('input.requested')
    const requestId = requestIdOf(requested)
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['A'] }] })).toBe('ok')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
    expect(h.sent.map(event => event.kind)).toEqual(['input.requested', 'input.resolved'])
    expect((h.sent[1]?.payload as { outcome: string }).outcome).toBe('remote')
  })

  it('同一请求第二次结算返回 unknown', async () => {
    const h = harness()
    const pending = h.ask()
    const requestId = requestIdOf(h.sent[0])
    h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['A'] }] })
    await pending
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['A'] }] })).toBe('unknown')
  })

  it('会话不匹配返回 session-mismatch 且仍在等待', async () => {
    const h = harness()
    const pending = h.ask()
    const requestId = requestIdOf(h.sent[0])
    expect(h.relay.settle('other', requestId, { answers: [{ id: 'q1', selected: ['A'] }] })).toBe('session-mismatch')
    h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['A'] }] })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
  })

  it('形状不对时返回 invalid 且仍在等待', async () => {
    const h = harness()
    const pending = h.ask()
    const requestId = requestIdOf(h.sent[0])
    expect(h.relay.settle('s1', requestId, { answers: [] })).toBe('invalid')
    h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['B'] }] })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['B'] }] })
  })

  it('超时后交回本地应答者', async () => {
    const h = harness(5)
    await expect(h.ask()).rejects.toThrow(/fell through/)
    expect(h.sent.map(event => event.kind)).toEqual(['input.requested', 'input.resolved'])
    expect((h.sent[1]?.payload as { outcome: string }).outcome).toBe('timeout')
  })

  it('abort 后发出 local 并交回本地', async () => {
    const h = harness(10_000)
    const abort = new AbortController()
    const pending = h.ask(abort.signal)
    const requestId = requestIdOf(h.sent[0])
    abort.abort()
    await expect(pending).rejects.toThrow(/fell through/)
    expect(h.sent.map(event => event.kind)).toEqual(['input.requested', 'input.resolved'])
    expect((h.sent[1]?.payload as { outcome: string }).outcome).toBe('local')
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['A'] }] })).toBe('unknown')
  })

  it('dispose 结束等待但不发 input.resolved，且可重复调用', async () => {
    const h = harness(10_000)
    const pending = h.ask()
    const requestId = requestIdOf(h.sent[0])
    h.relay.dispose()
    await expect(pending).rejects.toThrow(/fell through/)
    expect(h.sent.map(event => event.kind)).toEqual(['input.requested'])
    h.relay.dispose()
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['A'] }] })).toBe('unknown')
  })

  it('parseAnswers 要求每个问题恰好一次', () => {
    expect(parseAnswers({ answers: [{ id: 'q1', selected: ['A'] }] }, ['q1'])).toEqual({
      answers: [{ id: 'q1', selected: ['A'] }],
    })
    expect(parseAnswers({ answers: [{ id: 'q1', selected: ['A'] }, { id: 'q1', selected: ['B'] }] }, ['q1'])).toBeUndefined()
    expect(parseAnswers({ answers: [{ id: 'q1', selected: 'A' }] }, ['q1'])).toBeUndefined()
    expect(parseAnswers({ answers: [{ id: 'q2', selected: ['A'] }] }, ['q1'])).toBeUndefined()
    expect(parseAnswers({ answers: [{ id: 'q1', selected: ['A'], custom: 1 }] }, ['q1'])).toBeUndefined()
    expect(parseAnswers({ answers: [] }, ['q1'])).toBeUndefined()
    expect(parseAnswers(null, ['q1'])).toBeUndefined()
  })
})

describe('question relay end to end', () => {
  it('answer 指令经适配器结算后回 ack，重复回答回 unknown', async () => {
    const sent: EventFrame[] = []
    let handler: Handler | undefined
    const ctx: Pick<MarshalContext, 'on'> = {
      on(_event, fn) {
        handler = fn
        return () => { handler = undefined }
      },
    }
    const surface = {
      list: async () => [{ sessionId: 's1', running: false, blank: false, updatedAt: 1 }],
      follow: async function* () {},
      prompt: async () => ({ accepted: true }),
      cancel: async () => ({ cancelled: true }),
    }
    let relay: QuestionRelay | undefined
    const adapter = createDshAdapter(surface, {
      device: 'mac',
      answers: {
        settle: (sessionId, requestId, answers) => relay?.settle(sessionId, requestId, answers) ?? 'unknown',
      },
    })
    relay = createQuestionRelay({
      ctx,
      timeoutMs: 1_000,
      send: event => sent.push(event),
      frame: adapter.frame,
    })

    const fn = handler
    if (fn === undefined) throw new Error('relay did not subscribe')
    const pending = fn(
      { questions, agent: { session: { id: 's1' } } },
      () => Promise.reject(new Error('fell through to local')),
    )
    const requestId = requestIdOf(sent[0])

    const command = (id: string, answers: unknown): Frame => ({
      v: 1, type: 'command', id, idempotencyKey: id + '-key', deadline: Date.now() + 1_000,
      op: 'answer',
      target: { device: 'mac', agent: 'dsh', sessionId: 's1' },
      args: { requestId, answers },
    })
    const received: Frame[] = []
    const link = { sendRaw(text: string) { received.push(JSON.parse(text) as Frame) } } as unknown as NodeLink
    const follower = createFollower({ adapter, send: () => {}, logger: { warn() {} } })
    const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 1))

    runCommand(link, adapter, follower, command('c1', { answers: [{ id: 'q1', selected: ['A'] }] }), 'mac')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
    await flush()
    expect(received[0]).toMatchObject({ type: 'ack', id: 'c1', ok: true, result: { accepted: true } })

    runCommand(link, adapter, follower, command('c2', { answers: [{ id: 'q1', selected: ['B'] }] }), 'mac')
    await flush()
    expect(received[1]).toMatchObject({ type: 'ack', id: 'c2', ok: false, code: 'unknown' })
    relay.dispose()
  })
})
