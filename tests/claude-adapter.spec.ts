import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  GetSessionMessagesOptions, ListSessionsOptions, Query, SDKControlInterruptResponse, SDKMessage,
  SDKSessionInfo, SDKSystemMessage, SDKUserMessage, SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { EventFrame } from '../src/wire/frames.ts'
import type { SettleResult } from '../src/adapters/types.ts'
import { OwnershipError } from '../src/agents/ownership.ts'
import type {
  NativeInputClaim, NativeInputDecision, NativeInputPort,
} from '../src/agents/types.ts'
import {
  createClaudeAdapter, type ClaudeAdapterOptions,
} from '../src/agents/claude/adapter.ts'
import type { ClaudeSdk, ClaudeSdkQueryParams } from '../src/agents/claude/runtime.ts'

function signal(): AbortSignal {
  return new AbortController().signal
}

function initMessage(sessionId: string): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '2.0.0',
    cwd: '/tmp/workspace',
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: sessionId,
  }
}

function stateMessage(state: 'idle' | 'running' | 'requires_action'): SDKMessage {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: randomUUID(),
    session_id: 'session-created',
  }
}

function sessionInfo(sessionId: string, summary = '', lastModified = 1_700_000_000_000): SDKSessionInfo {
  return { sessionId, summary, lastModified }
}

function historyMessage(
  type: SessionMessage['type'],
  content: unknown[],
  uuid: string,
): SessionMessage {
  return {
    type,
    uuid,
    session_id: 'session-1',
    message: { role: type === 'assistant' ? 'assistant' : 'user', content },
    parent_tool_use_id: null,
    parent_agent_id: null,
  }
}

/** 只实现适配器用到的 `Query` 成员；其余控制方法适配器不可见。 */
class FakeQuery {
  readonly params: ClaudeSdkQueryParams
  readonly pushed: SDKMessage[] = []
  closeCalls = 0
  interruptCalls = 0
  interruptResult: SDKControlInterruptResponse | undefined
  private failure: unknown
  private finished = false
  private waiter: (() => void) | undefined

  constructor(params: ClaudeSdkQueryParams) {
    this.params = params
  }

  push(message: SDKMessage): void {
    if (this.finished) return
    this.pushed.push(message)
    this.wake()
  }

  fail(error: unknown): void {
    this.failure = error
    this.finished = true
    this.wake()
  }

  close(): void {
    this.closeCalls += 1
    this.finished = true
    this.wake()
  }

  async interrupt(): Promise<SDKControlInterruptResponse | undefined> {
    this.interruptCalls += 1
    return this.interruptResult
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    for (;;) {
      if (this.failure !== undefined) {
        const error = this.failure
        this.failure = undefined
        throw error
      }
      const message = this.pushed.shift()
      if (message !== undefined) return { done: false, value: message }
      if (this.finished) return { done: true, value: undefined }
      await new Promise<void>(resolve => { this.waiter = resolve })
    }
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.finished = true
    return { done: true, value: undefined }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }
}

/** 假的 SDK 面：`query` 只被 create/fork 调用，读接口只列 JSONL。 */
class FakeClaudeSdk implements ClaudeSdk {
  readonly queries: FakeQuery[] = []
  sessions: SDKSessionInfo[] = []
  readonly history = new Map<string, SessionMessage[]>()
  createdSessionId = 'session-created'
  forkedSessionId = 'session-forked'
  autoInit = true
  listCalls = 0
  historyCalls = 0

  query(params: ClaudeSdkQueryParams): Query {
    const sessionId = params.options?.forkSession === true
      ? this.forkedSessionId
      : this.createdSessionId
    const query = new FakeQuery(params)
    this.queries.push(query)
    if (this.autoInit) queueMicrotask(() => { query.push(initMessage(sessionId)) })
    return query as unknown as Query
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SDKSessionInfo[]> {
    this.listCalls += 1
    const offset = options.offset ?? 0
    const limit = options.limit ?? this.sessions.length
    return this.sessions.slice(offset, offset + limit)
  }

  async getSessionMessages(
    sessionId: string,
    options: GetSessionMessagesOptions = {},
  ): Promise<SessionMessage[]> {
    this.historyCalls += 1
    const messages = this.history.get(sessionId) ?? []
    const offset = options.offset ?? 0
    const limit = options.limit ?? messages.length
    return messages.slice(offset, offset + limit)
  }
}

interface Harness {
  readonly adapter: ReturnType<typeof createClaudeAdapter>
  readonly sdk: FakeClaudeSdk
  query(): FakeQuery
}

/** 最小内存中继：记录 claim/answer/cancel，并按预设决定立即结算。 */
class StubInputPort implements NativeInputPort {
  readonly claims: NativeInputClaim[] = []
  readonly answerCalls: { sessionId: string; requestId: string; value: unknown }[] = []
  readonly cancelCalls: { sessionId: string; requestId: string }[] = []
  decision: NativeInputDecision = { decision: 'decline' }
  answerResult: SettleResult = 'ok'
  cancelResult: SettleResult = 'ok'

  async claim(input: NativeInputClaim, _signal: AbortSignal): Promise<NativeInputDecision> {
    this.claims.push(input)
    return this.decision
  }

  answer(sessionId: string, requestId: string, value: unknown): SettleResult {
    this.answerCalls.push({ sessionId, requestId, value })
    return this.answerResult
  }

  cancel(sessionId: string, requestId: string): SettleResult {
    this.cancelCalls.push({ sessionId, requestId })
    return this.cancelResult
  }

  snapshot(): readonly unknown[] { return [] }
  revalidate(): void {}
  invalidate(): void {}
  dispose(): void {}
}

function harness(overrides: Partial<ClaudeAdapterOptions> = {}): Harness {
  const sdk = new FakeClaudeSdk()
  const adapter = createClaudeAdapter({
    deviceId: 'device-1',
    nodeEpoch: 'node-epoch-1',
    runtimeEpoch: 'epoch-1',
    // 默认关闭交互中继：既有用例不含原生审批/提问。
    questionRelay: 'off',
    approvalRelay: 'off',
    sdk,
    now: () => 1_700_000_000_000,
    initTimeoutMs: 500,
    probeTimeoutMs: 500,
    ...overrides,
  })
  const query = (): FakeQuery => {
    const first = sdk.queries[0]
    if (first === undefined) throw new Error('claude query was not created')
    return first
  }
  return { adapter, sdk, query }
}

async function collect(iterable: AsyncIterable<EventFrame>): Promise<EventFrame[]> {
  const events: EventFrame[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('claude adapter', () => {
  it('probes with read-only listSessions and never creates a query', async () => {
    const h = harness()
    const result = await h.adapter.probe(signal())
    expect(result.ok).toBe(true)
    expect(result.capability?.ownership).toBe('foreign-unknown')
    expect([...(result.capability?.operations ?? [])]).toEqual(['create', 'fork'])
    expect(result.capability?.observe).toEqual({ history: true, follow: 'stream' })
    expect(h.sdk.queries).toHaveLength(0)
    expect(h.sdk.listCalls).toBe(1)
    expect(h.adapter.health().state).toBe('ready')
    await h.adapter.stop()
  })

  it('lists rows without summary, title, first prompt or cwd', async () => {
    const h = harness()
    h.sdk.sessions = [
      { ...sessionInfo('s1', 'secret title', 1_700_000_000_123), firstPrompt: 'secret prompt', customTitle: 'secret custom', cwd: '/secret/path' },
      sessionInfo('s2', '  '),
    ]
    const listed = await h.adapter.list(signal())
    expect(listed.completeness).toBe('complete')
    expect(listed.rows).toEqual([
      { sessionId: 's1', running: false, updatedAt: 1_700_000_000_123, blank: false },
      { sessionId: 's2', running: false, updatedAt: 1_700_000_000_000, blank: true },
    ])
    const serialized = JSON.stringify(listed.rows)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('/secret/path')
    expect(h.sdk.queries).toHaveLength(0)
    await h.adapter.stop()
  })

  it('walks every list page and marks exactly full last pages as unconfirmed', async () => {
    const h = harness()
    h.sdk.sessions = Array.from({ length: 150 }, (_, index) => sessionInfo(`s${index}`))
    const listed = await h.adapter.list(signal())
    expect(listed.rows).toHaveLength(150)
    expect(listed.completeness).toBe('complete')
    expect(h.sdk.listCalls).toBe(2)

    h.sdk.sessions = Array.from({ length: 100 }, (_, index) => sessionInfo(`p${index}`))
    const full = await h.adapter.list(signal())
    expect(full.rows).toHaveLength(100)
    // 满页后还要再读一页确认终止；第二页为空才 complete。
    expect(full.completeness).toBe('complete')
    expect(h.sdk.listCalls).toBe(4)
    await h.adapter.stop()
  })

  it('never acquires an external session and keeps it read-only', async () => {
    const h = harness()
    await h.adapter.start(signal())
    const port = h.adapter.ownershipPort
    if (port === undefined) throw new Error('ownership port missing')

    const error = await port.acquire('external-1', signal()).catch(reason => reason)
    expect(error).toBeInstanceOf(OwnershipError)
    expect(error).toMatchObject({ code: 'ownership-unverified' })
    expect(port.ownership('external-1')).toBe('foreign-unknown')
    expect(h.sdk.queries).toHaveLength(0)

    const capability = h.adapter.capabilities('external-1')
    expect(capability.ownership).toBe('foreign-unknown')
    expect(capability.operations.has('prompt')).toBe(false)
    expect(capability.observe).toEqual({ history: true, follow: 'none' })
    expect(capability.unavailable?.prompt).toBe('ownership-unverified')
    await h.adapter.stop()
  })

  it('drives a managed session from create through acquire, prompt and interrupt', async () => {
    const h = harness()
    const create = h.adapter.createSession
    const port = h.adapter.ownershipPort
    if (create === undefined || port === undefined) throw new Error('v1 ports missing')

    const created = await create({ requestId: 'req-create', cwd: '/tmp/workspace' }, signal())
    expect(created).toEqual({ sessionId: 'session-created', runtimeEpoch: 'epoch-1' })
    expect(h.sdk.queries).toHaveLength(1)

    const acquired = await port.acquire('session-created', signal())
    expect(acquired).toMatchObject({ state: 'ours-idle', wire: 'ours' })
    expect(acquired.evidence?.mechanism).toBe('managed-query')

    const before = h.adapter.capabilities('session-created')
    expect(before.ownership).toBe('ours')
    expect(before.operations.has('prompt')).toBe(true)
    expect(before.operations.has('interrupt')).toBe(false)
    expect(before.unavailable?.interrupt).toBe('no-atomic-turn-binding')

    const prompted = await h.adapter.prompt({
      sessionId: 'session-created',
      text: 'hello',
      requestId: 'req-prompt',
      runtimeEpoch: 'epoch-1',
    }, signal())
    if (prompted.turnId === undefined) throw new Error('turn id missing')
    expect(prompted).toMatchObject({ accepted: true, runtimeEpoch: 'epoch-1' })
    expect(prompted.turnId.startsWith('claude-turn:')).toBe(true)

    const query = h.query()
    const prompt = query.params.prompt
    if (typeof prompt === 'string') throw new Error('streaming input expected')
    const iterator = prompt[Symbol.asyncIterator]()
    const delivered = await iterator.next()
    if (delivered.done) throw new Error('user message was not delivered')
    const message = delivered.value as SDKUserMessage
    expect(message.message).toEqual({ role: 'user', content: 'hello' })
    expect(message.uuid).toBe(prompted.turnId.slice('claude-turn:'.length))

    const busy = await h.adapter.prompt({
      sessionId: 'session-created',
      text: 'again',
      requestId: 'req-prompt-2',
      runtimeEpoch: 'epoch-1',
    }, signal()).catch(reason => reason)
    expect(busy).toBeInstanceOf(OwnershipError)
    expect(busy).toMatchObject({ code: 'writer-busy' })

    expect(h.adapter.capabilities('session-created').operations.has('interrupt')).toBe(true)
    const interrupted = await h.adapter.interrupt({
      sessionId: 'session-created',
      turnId: prompted.turnId,
      runtimeEpoch: 'epoch-1',
      requestId: 'req-interrupt',
    }, signal())
    expect(interrupted).toEqual({
      accepted: true, runtimeEpoch: 'epoch-1', turnId: prompted.turnId,
    })
    expect(query.interruptCalls).toBe(1)

    await expect(h.adapter.interrupt({
      sessionId: 'session-created',
      turnId: prompted.turnId,
      runtimeEpoch: 'other-epoch',
      requestId: 'req-interrupt-2',
    }, signal())).rejects.toMatchObject({ code: 'stale-connection' })

    // 发现 API 没有运行态，但受管 Query 有：行不能和事件流说相反的话。
    h.sdk.sessions = [sessionInfo('session-created')]
    const listed = await h.adapter.list(signal())
    expect(listed.rows).toEqual([
      { sessionId: 'session-created', running: true, updatedAt: 1_700_000_000_000, blank: true },
    ])
    await h.adapter.stop()
  })

  it('advertises acquire only for managed sessions and carries epoch metadata', async () => {
    const h = harness()
    const create = h.adapter.createSession
    if (create === undefined) throw new Error('createSession missing')
    const created = await create({ requestId: 'req-create' }, signal())

    const managed = h.adapter.capabilities(created.sessionId)
    expect(managed.operations.has('acquire')).toBe(true)
    expect(managed.unavailable?.acquire).toBeUndefined()
    expect(managed.settingsRevision).toBe(0)
    expect(managed.runtimeEpoch).toBe('epoch-1')

    const foreign = h.adapter.capabilities('external-1')
    expect(foreign.operations.has('acquire')).toBe(false)
    expect(foreign.unavailable?.acquire).toBe('ownership-unverified')
    expect(foreign.settingsRevision).toBe(0)
    expect(foreign.runtimeEpoch).toBe('epoch-1')
    await h.adapter.stop()
  })

  it('yields the current capability before following a managed session', async () => {
    const h = harness()
    const create = h.adapter.createSession
    if (create === undefined) throw new Error('createSession missing')
    const created = await create({ requestId: 'req-create' }, signal())

    const controller = new AbortController()
    const iterator = h.adapter.follow(created.sessionId, controller.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) throw new Error('follow ended before the initial capability')
    expect(first.value.kind).toBe('capability.changed')
    expect(first.value.sessionId).toBe(created.sessionId)
    const payload = first.value.payload as Record<string, unknown>
    expect(payload).toMatchObject({
      settingsRevision: 0,
      runtimeEpoch: 'epoch-1',
    })
    expect(payload.operations).toContain('acquire')
    controller.abort()
    await iterator.return?.()

    // 外部会话没有可订阅通道：既不宣传能力，也不产生任何初始帧。
    const foreign = await collect(h.adapter.follow('external-1', signal()))
    expect(foreign).toEqual([])
    await h.adapter.stop()
  })

  it('rejects prompt and steer on unowned sessions before any native call', async () => {
    const h = harness()
    await h.adapter.start(signal())
    const error = await h.adapter.prompt({
      sessionId: 'external-1',
      text: 'hello',
      requestId: 'req-prompt',
      runtimeEpoch: 'epoch-1',
    }, signal()).catch(reason => reason)
    expect(error).toBeInstanceOf(OwnershipError)
    expect(error).toMatchObject({ code: 'ownership-unverified' })

    await expect(h.adapter.steer({
      sessionId: 'external-1',
      turnId: 't1',
      text: 'more',
      requestId: 'req-steer',
      runtimeEpoch: 'epoch-1',
    }, signal())).rejects.toMatchObject({ code: 'unsupported' })
    expect(h.sdk.queries).toHaveLength(0)
    await h.adapter.stop()
  })

  it('validates create cwd and fork parent before spawning', async () => {
    const h = harness()
    const create = h.adapter.createSession
    const fork = h.adapter.forkSession
    if (create === undefined || fork === undefined) throw new Error('v1 ports missing')

    await expect(create({ requestId: 'req-create', cwd: 'relative/dir' }, signal()))
      .rejects.toMatchObject({ code: 'invalid-args' })
    expect(h.sdk.queries).toHaveLength(0)

    h.sdk.sessions = [sessionInfo('parent-1')]
    await expect(fork({ requestId: 'req-fork-1', parentSessionId: 'missing' }, signal()))
      .rejects.toMatchObject({ code: 'session-unknown' })
    expect(h.sdk.queries).toHaveLength(0)

    const forked = await fork({ requestId: 'req-fork-2', parentSessionId: 'parent-1' }, signal())
    expect(forked).toEqual({
      sessionId: 'session-forked', runtimeEpoch: 'epoch-1', parentSessionId: 'parent-1',
    })
    expect(h.sdk.queries).toHaveLength(1)
    await h.adapter.stop()
  })

  it('projects history through read-only pagination without titles', async () => {
    const h = harness()
    h.sdk.history.set('session-1', [
      historyMessage('user', [{ type: 'text', text: 'question' }], 'u1'),
      historyMessage('assistant', [{ type: 'text', text: 'answer' }], 'a1'),
    ])
    const page = await h.adapter.history({ sessionId: 'session-1', limit: 10 }, signal())
    expect(page.completeness).toBe('complete')
    expect(page.items.map(item => item.kind)).toEqual([
      'turn.started', 'message.completed', 'turn.completed',
    ])
    expect(page.items[1]?.payload).toMatchObject({ text: 'answer' })
    expect(h.sdk.queries).toHaveLength(0)

    await expect(h.adapter.history({ sessionId: 'session-1', cursor: 'not-a-cursor' }, signal()))
      .rejects.toBeInstanceOf(RangeError)
    await h.adapter.stop()
  })

  it('streams managed events to followers and ends them on runtime death', async () => {
    const h = harness()
    const controller = new AbortController()
    const create = h.adapter.createSession
    const port = h.adapter.ownershipPort
    if (create === undefined || port === undefined) throw new Error('v1 ports missing')
    const created = await create({ requestId: 'req-create' }, controller.signal)
    await port.acquire(created.sessionId, controller.signal)

    const iterator = h.adapter.follow(created.sessionId, controller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    // 让生成器先注册监听。
    await new Promise(resolve => setTimeout(resolve, 0))
    h.query().push(stateMessage('running'))

    const next = await pending
    if (next.done) throw new Error('follow ended before the state event')
    expect(next.value.kind).toBe('session.updated')
    expect(next.value.payload).toMatchObject({ running: true, ownership: 'ours' })

    const death = iterator.next()
    h.query().fail(new Error('transport died'))
    const failedEvent = await death
    if (failedEvent.done) throw new Error('follow ended before the crash event')
    expect(failedEvent.value.kind).toBe('error')
    expect(failedEvent.value.payload).toMatchObject({ code: 'agent-crashed' })

    const updatedEvent = await iterator.next()
    if (updatedEvent.done) throw new Error('follow ended before the terminal session.updated')
    expect(updatedEvent.value.kind).toBe('session.updated')
    expect(updatedEvent.value.payload).toMatchObject({ running: false })

    const ended = await iterator.next()
    expect(ended.done).toBe(true)

    const capability = h.adapter.capabilities(created.sessionId)
    expect(capability.observe.follow).toBe('none')
    expect(capability.unavailable?.prompt).toBe('terminal-failure')
    await h.adapter.stop()
  })

  it('reports only privacy-safe keys in snapshots', async () => {
    const h = harness()
    h.sdk.sessions = [{
      ...sessionInfo('s1', 'secret title'),
      firstPrompt: 'secret prompt',
      cwd: '/secret/path',
    }]
    const snapshot = await h.adapter.syncSnapshot(signal())
    expect(snapshot.rows).toEqual([
      { sessionId: 's1', running: false, updatedAt: 1_700_000_000_000, blank: false },
    ])
    expect(snapshot.capabilities).toHaveLength(1)
    const payload = snapshot.capabilities[0]?.capability
    expect(payload?.ownership).toBe('foreign-unknown')
    expect(JSON.stringify(snapshot)).not.toContain('secret')

    const frames = await h.adapter.snapshot(signal())
    expect(frames.map(item => item.kind)).toEqual(['session.updated', 'capability.changed'])
    expect(JSON.stringify(frames)).not.toContain('secret')

    await h.adapter.stop()
    expect(h.adapter.health().state).toBe('stopped')
  })

  it('does not install canUseTool when no interaction relay is configured', async () => {
    const h = harness()
    const create = h.adapter.createSession
    if (create === undefined) throw new Error('createSession missing')
    await create({ requestId: 'req-create' }, signal())
    expect(h.query().params.options?.canUseTool).toBeUndefined()
    await h.adapter.stop()
  })

  it('routes native AskUserQuestion through the interaction port', async () => {
    const relay = new StubInputPort()
    relay.decision = {
      decision: 'answer',
      value: { answers: [{ id: 'q1', selected: ['Postgres'] }] },
    }
    const h = harness({ questionRelay: 'remote', approvalRelay: 'remote', inputRelay: relay })
    const create = h.adapter.createSession
    const port = h.adapter.ownershipPort
    if (create === undefined || port === undefined) throw new Error('v1 ports missing')
    const created = await create({ requestId: 'req-create' }, signal())
    await port.acquire(created.sessionId, signal())

    const canUseTool = h.query().params.options?.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool missing')
    const input = {
      questions: [{
        question: '选哪个数据库？',
        multiSelect: false,
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
      }],
    }
    const result = await canUseTool('AskUserQuestion', input, {
      signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'ctl-1',
    })

    expect(relay.claims).toHaveLength(1)
    expect(relay.claims[0]).toMatchObject({
      kind: 'question', sessionId: created.sessionId, runtimeEpoch: 'epoch-1',
    })
    expect(relay.claims[0]?.questions).toEqual([{
      id: 'q1',
      question: '选哪个数据库？',
      multiSelect: false,
      options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    }])
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { '选哪个数据库？': 'Postgres' } },
    })
    if (result === null || result.behavior !== 'allow') throw new Error('expected allow')
    expect('updatedPermissions' in result).toBe(false)

    const capability = h.adapter.capabilities(created.sessionId)
    expect(capability.operations.has('answer')).toBe(true)
    expect(capability.operations.has('cancel')).toBe(true)
    expect(capability.unavailable?.answer).toBeUndefined()
    expect(h.adapter.nativeInputPort).toBe(relay)
    await h.adapter.stop()
  })

  it('denies tool calls for sessions that are not ours without claiming', async () => {
    const relay = new StubInputPort()
    relay.decision = { decision: 'answer', value: 'accept' }
    const h = harness({ questionRelay: 'remote', approvalRelay: 'remote', inputRelay: relay })
    const create = h.adapter.createSession
    if (create === undefined) throw new Error('createSession missing')
    await create({ requestId: 'req-create' }, signal())

    const canUseTool = h.query().params.options?.canUseTool
    if (canUseTool === undefined) throw new Error('canUseTool missing')
    const result = await canUseTool('Bash', { command: 'ls' }, {
      signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'ctl-1',
    })
    expect(result).toMatchObject({ behavior: 'deny' })
    expect(relay.claims).toHaveLength(0)
    expect(h.adapter.capabilities('session-created').operations.has('answer')).toBe(false)
    await h.adapter.stop()
  })

  it('routes answer and cancel commands to the interaction port', async () => {
    const relay = new StubInputPort()
    const h = harness({ questionRelay: 'remote', approvalRelay: 'remote', inputRelay: relay })
    const answers = [{ id: 'q1', selectedOptionIds: ['q1o1'] }]

    await expect(h.adapter.execute({
      op: 'answer', target: { sessionId: 'session-created' }, args: { requestId: 'q-1', answers },
    })).resolves.toEqual({ accepted: true })
    expect(relay.answerCalls).toEqual([{
      sessionId: 'session-created', requestId: 'q-1', value: { answers },
    }])

    relay.answerResult = 'decision-invalid'
    await expect(h.adapter.execute({
      op: 'answer', target: { sessionId: 'session-created' }, args: { requestId: 'q-2', answers },
    })).rejects.toMatchObject({ code: 'decision-invalid' })

    await expect(h.adapter.execute({
      op: 'cancel', target: { sessionId: 'session-created' }, args: { requestId: 'q-3' },
    })).resolves.toEqual({ cancelled: true })
    expect(relay.cancelCalls).toEqual([{ sessionId: 'session-created', requestId: 'q-3' }])

    relay.cancelResult = 'session-mismatch'
    await expect(h.adapter.execute({
      op: 'cancel', target: { sessionId: 'session-created' }, args: { requestId: 'q-4' },
    })).rejects.toMatchObject({ code: 'session-mismatch' })
    await h.adapter.stop()
  })
})
