import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDshAdapter } from '../src/adapters/dsh/adapter.ts'
import type { AskUserQuestionAnswerLike, AskUserQuestionRequestLike, MarshalContext, UserQuestionLike } from '../src/dsh-types.ts'
import { openJournal, type Journal } from '../src/node/journal.ts'
import { createQuestionRelay, parseAnswers, type QuestionRelay } from '../src/node/questions.ts'
import { createFollower, runCommand } from '../src/node/runner.ts'
import type { NodeLink } from '../src/node/link.ts'
import type { EventFrame, Frame } from '../src/wire/frames.ts'

const questions = [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }]

const dirs: string[] = []
const journals: Journal[] = []

/** journal 是副作用命令的硬依赖：测试必须用隔离的临时状态，不能碰真实 $HOME。 */
function isolatedJournal(): Journal {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-questions-'))
  dirs.push(dir)
  const journal = openJournal({
    file: join(dir, 'journal.json'),
    keyFile: join(dir, 'journal.key'),
    initFile: join(dir, 'journal.init'),
  })
  journals.push(journal)
  return journal
}

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Handler = (request: AskUserQuestionRequestLike, next: () => Promise<AskUserQuestionAnswerLike>) => Promise<AskUserQuestionAnswerLike>

interface HarnessOptions {
  readonly questions?: readonly UserQuestionLike[]
  readonly send?: (event: EventFrame) => void
  readonly next?: () => Promise<AskUserQuestionAnswerLike>
}

function harness(timeoutMs = 50, options: HarnessOptions = {}) {
  const sent: EventFrame[] = []
  let handler: Handler | undefined
  const ctx: Pick<MarshalContext, 'on'> = {
    on(_event, fn) {
      handler = fn
      // 故意不在这里清空 handler：dispose 之后仍要能调用捕获的 handler。
      return () => {}
    },
  }
  let seq = 0
  const relay = createQuestionRelay({
    ctx,
    timeoutMs,
    send: options.send ?? (event => sent.push(event)),
    frame: (sessionId, kind, payload): EventFrame => ({
      v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId, nodeEpoch: 'epoch-1',
      seq: ++seq, ts: 1, kind, payload,
    }),
  })
  const request = (signal?: AbortSignal): AskUserQuestionRequestLike => ({
    questions: options.questions ?? questions,
    agent: { session: { id: 's1' } },
    ...(signal === undefined ? {} : { signal }),
  })
  const next = options.next ?? (() => Promise.reject(new Error('fell through to local')))
  const ask = (signal?: AbortSignal): Promise<AskUserQuestionAnswerLike> => {
    const fn = handler
    if (fn === undefined) throw new Error('relay did not subscribe')
    return fn(request(signal), next)
  }
  return { relay, sent, ask, request, captured: () => handler }
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

  it('选中不在 options 里的标签返回 invalid 且仍可继续作答', async () => {
    const h = harness()
    const pending = h.ask()
    const requestId = requestIdOf(h.sent[0])
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['Z'] }] })).toBe('invalid')
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['A'] }] })).toBe('ok')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
  })

  it('多题请求缺一题返回 invalid，补齐后才结算', async () => {
    const twoQuestions = [
      { id: 'q1', question: '第一个', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: '第二个', options: [{ label: 'C' }, { label: 'D' }] },
    ]
    const h = harness(50, { questions: twoQuestions })
    const pending = h.ask()
    const requestId = requestIdOf(h.sent[0])
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['A'] }] })).toBe('invalid')
    const full = { answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['C'] }] }
    expect(h.relay.settle('s1', requestId, full)).toBe('ok')
    await expect(pending).resolves.toEqual(full)
  })

  it('multiSelect 题接受多个标签', async () => {
    const h = harness(50, {
      questions: [{ id: 'q1', question: '选多个', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }],
    })
    const pending = h.ask()
    const requestId = requestIdOf(h.sent[0])
    const answers = { answers: [{ id: 'q1', selected: ['A', 'B'] }] }
    expect(h.relay.settle('s1', requestId, answers)).toBe('ok')
    await expect(pending).resolves.toEqual(answers)
  })

  it('非 multiSelect 题拒绝多个标签', async () => {
    const h = harness()
    const pending = h.ask()
    const requestId = requestIdOf(h.sent[0])
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['A', 'B'] }] })).toBe('invalid')
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['A'] }] })).toBe('ok')
    await pending
  })

  it('重复问题 id 直接交回本地且不发 input.requested', async () => {
    const h = harness(10_000, {
      questions: [
        { id: 'q1', question: '第一次', options: [{ label: 'A' }] },
        { id: 'q1', question: '第二次', options: [{ label: 'B' }] },
      ],
      next: async () => ({ answers: [] }),
    })
    await expect(h.ask()).resolves.toEqual({ answers: [] })
    expect(h.sent).toEqual([])
  })

  it('发送抛错时经 next 交回本地并清空 pending', async () => {
    const h = harness(10_000, {
      send: event => {
        // 先记下事件再抛错，测试才能拿到 requestId 验证 pending 已删除。
        h.sent.push(event)
        throw new Error('send failed')
      },
      next: async () => ({ answers: [] }),
    })
    await expect(h.ask()).resolves.toEqual({ answers: [] })
    expect(h.sent.map(event => event.kind)).toEqual(['input.requested'])
    const requestId = requestIdOf(h.sent[0])
    expect(h.relay.settle('s1', requestId, { answers: [{ id: 'q1', selected: ['A'] }] })).toBe('unknown')
  })

  it('dispose 之后调用捕获的 handler 不再创建 pending', async () => {
    const h = harness(10_000, { next: async () => ({ answers: [] }) })
    const fn = h.captured()
    if (fn === undefined) throw new Error('relay did not subscribe')
    h.relay.dispose()
    await expect(fn(h.request(), async () => ({ answers: [] }))).resolves.toEqual({ answers: [] })
    expect(h.sent).toEqual([])
    expect(h.relay.settle('s1', 'q-any', { answers: [{ id: 'q1', selected: ['A'] }] })).toBe('unknown')
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
      deviceId: 'mac',
      nodeEpoch: 'epoch-1',
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

    const command = (commandId: string, answers: unknown): Frame => ({
      v: 2, type: 'command', commandId, idempotencyKey: commandId + '-key', operatorId: 'op-1',
      issuedAt: Date.now(), deadline: Date.now() + 1_000,
      op: 'answer',
      target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' },
      args: { requestId, answers },
      connectionId: 'conn-1', nodeEpoch: 'epoch-1',
    })
    const received: Frame[] = []
    const journal = isolatedJournal()
    const link = {
      sendRaw(text: string) { received.push(JSON.parse(text) as Frame) },
      get handshake() {
        return { connectionId: 'conn-1', nodeEpoch: 'epoch-1', serverTimeOffset: 0 }
      },
    } as unknown as NodeLink
    const follower = createFollower({ adapter, send: () => {}, logger: { warn() {} } })
    const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 1))

    // 线上 args.answers 是数组（设计 §7.2），适配器负责包成 DSH 的 `{ answers }`。
    runCommand(link, adapter, follower, command('c1', [{ id: 'q1', selected: ['A'] }]), 'mac', journal)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
    await flush()
    expect(received[0]).toMatchObject({ type: 'ack', commandId: 'c1', status: 'accepted', result: { accepted: true } })

    runCommand(link, adapter, follower, command('c2', [{ id: 'q1', selected: ['B'] }]), 'mac', journal)
    await flush()
    expect(received[1]).toMatchObject({ type: 'ack', commandId: 'c2', status: 'rejected', code: 'unknown' })
    relay.dispose()
  })
})
