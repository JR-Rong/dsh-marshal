import { describe, expect, it } from 'vitest'
import type { SettleResult } from '../src/adapters/types.ts'
import { OwnershipError } from '../src/agents/ownership.ts'
import type { SpawnFn, SupervisorChild } from '../src/agents/supervisor.ts'
import type {
  NativeInputClaim, NativeInputDecision, NativeInputPort,
} from '../src/agents/types.ts'
import { createCodexAdapter, type CodexAdapterOptions } from '../src/agents/codex/adapter.ts'
import type { CodexThread, CodexTurn } from '../src/agents/codex/protocol.ts'

function signal(): AbortSignal {
  return new AbortController().signal
}

class FakeStream {
  writable = true
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>()

  constructor(private readonly onWrite?: (chunk: string) => void) {}

  on(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event)
    if (list === undefined) return this
    this.listeners.set(event, list.filter(item => item !== listener))
    return this
  }

  write(chunk: string | Uint8Array): boolean {
    this.onWrite?.(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }

  end(): void {
    this.writable = false
  }

  emitData(chunk: Buffer | string): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    for (const listener of [...(this.listeners.get('data') ?? [])]) listener(buffer)
  }
}

let nextPid = 4_000

class FakeChild implements SupervisorChild {
  readonly pid = nextPid++
  readonly input: FakeStream
  readonly output: FakeStream
  readonly stderr = new FakeStream()
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>()

  constructor(onWrite: (chunk: string) => void) {
    this.input = new FakeStream(onWrite)
    this.output = new FakeStream()
  }

  get stdin(): NodeJS.WritableStream | null {
    return this.input as unknown as NodeJS.WritableStream
  }

  get stdout(): NodeJS.ReadableStream | null {
    return this.output as unknown as NodeJS.ReadableStream
  }

  on(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event)
    if (list === undefined) return this
    this.listeners.set(event, list.filter(item => item !== listener))
    return this
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    return true
  }

  emitExit(code: number | null = 0): void {
    for (const listener of [...(this.listeners.get('exit') ?? [])]) listener(code, null)
  }
}

interface ServerRequest {
  readonly id: number
  readonly method: string
  readonly params: Record<string, unknown>
}

interface ServerNotification {
  readonly method: string
  readonly params: unknown
}

/** 假的 `codex app-server --stdio`：按行解析请求，同步回包。 */
class FakeCodexServer {
  readonly child: FakeChild
  readonly requests: ServerRequest[] = []
  readonly notifications: ServerNotification[] = []
  /** 服务端请求的应答（无 method 的入站记录）。 */
  readonly responses: Record<string, unknown>[] = []
  threads: CodexThread[] = []
  historyTurns: readonly CodexTurn[] = []
  version = '0.166.0'
  createdThreadId = 'new-1'
  forkedThreadId = 'fork-1'
  turnId = 'turn-1'
  turnStarts = 0
  interrupts = 0
  resumes = 0
  forks = 0
  goal: { objective: string } | null = null
  /** 为 pending 测试挂起 goal/set 响应，直到 releaseGoalSet 显式放行。 */
  holdGoalSet = false
  private pendingGoalSet: { readonly id: number; readonly params: Record<string, unknown> } | undefined
  private buffer = ''

  constructor() {
    this.child = new FakeChild(chunk => this.consume(chunk))
  }

  send(value: unknown): void {
    this.child.output.emitData(`${JSON.stringify(value)}\n`)
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params })
  }

  private respond(id: number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result })
  }

  private fail(id: number, code: number): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message: 'error' } })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    const record = JSON.parse(line) as Record<string, unknown>
    const method = record.method
    if (typeof method !== 'string') {
      this.responses.push(record)
      return
    }
    if (record.id === undefined) {
      this.notifications.push({ method, params: record.params })
      return
    }
    if (typeof record.id !== 'number') return
    const id = record.id
    const params = (record.params ?? {}) as Record<string, unknown>
    this.requests.push({ id, method, params })
    switch (method) {
      case 'initialize':
        this.respond(id, { userAgent: `codex/${this.version} (linux; x86_64)` })
        return
      case 'thread/list': {
        const limit = typeof params.limit === 'number' ? params.limit : this.threads.length
        this.respond(id, { data: this.threads.slice(0, Math.max(0, limit)) })
        return
      }
      case 'thread/start':
        this.respond(id, { thread: { id: this.createdThreadId } })
        return
      case 'thread/fork':
        this.forks += 1
        this.respond(id, { thread: { id: this.forkedThreadId } })
        return
      case 'thread/resume':
        this.resumes += 1
        this.respond(id, { thread: { id: typeof params.threadId === 'string' ? params.threadId : '' } })
        return
      case 'thread/turns/list':
        this.respond(id, { data: [...this.historyTurns] })
        return
      case 'turn/start':
        this.turnStarts += 1
        this.respond(id, { turn: { id: this.turnId, status: 'inProgress' } })
        return
      case 'turn/interrupt':
        this.interrupts += 1
        this.respond(id, {})
        return
      case 'thread/goal/get':
        this.respond(id, { goal: this.goal })
        return
      case 'thread/goal/set': {
        if (this.holdGoalSet) {
          this.pendingGoalSet = { id, params }
          return
        }
        this.goal = { objective: typeof params.objective === 'string' ? params.objective : '' }
        this.respond(id, { goal: this.goal })
        return
      }
      case 'thread/goal/clear':
        this.goal = null
        this.respond(id, { cleared: true })
        return
      default:
        this.fail(id, -32601)
    }
  }

  /** 放行被 holdGoalSet 挂起的写入，并按真实 set 语义回包。 */
  releaseGoalSet(): void {
    const held = this.pendingGoalSet
    if (held === undefined) return
    this.pendingGoalSet = undefined
    this.goal = { objective: typeof held.params.objective === 'string' ? held.params.objective : '' }
    this.respond(held.id, { goal: this.goal })
  }
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

/** 等适配器的异步应答写出到假服务端。 */
async function waitForResponse(server: FakeCodexServer, id: unknown): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = server.responses.find(item => item.id === id)
    if (found !== undefined) return found
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`no server response for id ${String(id)}`)
}

interface Harness {
  readonly adapter: ReturnType<typeof createCodexAdapter>
  readonly servers: FakeCodexServer[]
  server(): FakeCodexServer
}

function harness(overrides: Partial<CodexAdapterOptions> = {}): Harness {
  const servers: FakeCodexServer[] = []
  const spawn: SpawnFn = () => {
    const server = new FakeCodexServer()
    servers.push(server)
    return server.child
  }
  const adapter = createCodexAdapter({
    deviceId: 'device-1',
    nodeEpoch: 'node-epoch-1',
    runtimeEpoch: 'epoch-1',
    // 默认关闭交互中继：既有用例不含原生审批/提问。
    questionRelay: 'off',
    approvalRelay: 'off',
    binary: {
      ok: true,
      entry: { command: '/opt/codex', args: ['app-server', '--stdio'], source: 'config' },
    },
    spawn,
    now: () => 1_700_000_000_000,
    requestTimeoutMs: 500,
    handshakeTimeoutMs: 500,
    probeTimeoutMs: 500,
    ...overrides,
  })
  const server = (): FakeCodexServer => {
    const first = servers[0]
    if (first === undefined) throw new Error('codex server was not spawned')
    return first
  }
  return { adapter, servers, server }
}

describe('codex adapter', () => {
  it('probes the pinned version and reports foreign-unknown ownership', async () => {
    const h = harness()
    const result = await h.adapter.probe(signal())
    expect(result.ok).toBe(true)
    expect(result.version).toBe('0.166.0')
    expect(result.capability?.ownership).toBe('foreign-unknown')
    expect(result.capability?.observe).toEqual({ history: true, follow: 'stream' })
    expect([...(result.capability?.operations ?? [])]).toEqual(['create', 'fork'])
    expect(h.adapter.health().state).toBe('ready')
    expect(h.server().notifications.map(item => item.method)).toContain('initialized')
    await h.adapter.stop()
  })

  it('fails closed on an unsupported codex version', async () => {
    const h = harness()
    h.server().version = '0.9.0'
    const result = await h.adapter.probe(signal())
    expect(result.ok).toBe(false)
    expect(result.unavailable?.reason).toBe('version-unsupported')
    expect(h.adapter.health().state).toBe('failed')
    await h.adapter.stop()
  })

  it('lists every thread page as rows without preview or title', async () => {
    const h = harness()
    h.server().threads = [
      { id: 's1', status: { type: 'active', activeFlags: [] }, updatedAt: 1_700_000_000, preview: 'x' },
      { id: 's2' },
    ]
    const listed = await h.adapter.list(signal())
    expect(listed.completeness).toBe('complete')
    expect(listed.rows).toEqual([
      { sessionId: 's1', running: true, updatedAt: 1_700_000_000_000, blank: false },
      { sessionId: 's2', running: false, updatedAt: 0, blank: true },
    ])
    const snapshot = await h.adapter.syncSnapshot(signal())
    expect(snapshot.capabilities).toHaveLength(1)
    expect(snapshot.capabilities[0]?.agent).toBe('codex')
    expect(snapshot.capabilities[0]?.capability.ownership).toBe('foreign-unknown')
    await h.adapter.stop()
  })

  it('never acquires an external session by resuming it', async () => {
    const h = harness()
    await h.adapter.start(signal())
    const port = h.adapter.ownershipPort
    if (port === undefined) throw new Error('ownership port missing')
    const error = await port.acquire('external-1', signal()).catch(reason => reason)
    expect(error).toBeInstanceOf(OwnershipError)
    expect(error).toMatchObject({ code: 'ownership-unverified' })
    expect(h.server().resumes).toBe(0)
    expect(port.ownership('external-1')).toBe('foreign-unknown')
    await h.adapter.stop()
  })

  it('drives a managed session from create to prompt and interrupt', async () => {
    const h = harness()
    const create = h.adapter.createSession
    const port = h.adapter.ownershipPort
    if (create === undefined || port === undefined) throw new Error('v1 ports missing')

    const created = await create({ requestId: 'req-create', cwd: '/tmp/workspace' }, signal())
    expect(created).toEqual({ sessionId: 'new-1', runtimeEpoch: 'epoch-1' })

    const acquired = await port.acquire('new-1', signal())
    expect(acquired).toMatchObject({ state: 'ours-idle', wire: 'ours' })
    expect(acquired.evidence?.mechanism).toBe('managed-thread')
    expect(h.server().resumes).toBe(1)

    const before = h.adapter.capabilities('new-1')
    expect(before.ownership).toBe('ours')
    expect(before.operations.has('prompt')).toBe(true)
    expect(before.operations.has('interrupt')).toBe(false)
    expect(before.unavailable?.interrupt).toBe('no-atomic-turn-binding')

    const prompted = await h.adapter.prompt({
      sessionId: 'new-1',
      text: 'hello',
      requestId: 'req-prompt',
      runtimeEpoch: 'epoch-1',
    }, signal())
    expect(prompted).toEqual({ accepted: true, runtimeEpoch: 'epoch-1', turnId: 'turn-1' })
    expect(h.server().turnStarts).toBe(1)
    expect(h.adapter.capabilities('new-1').operations.has('interrupt')).toBe(true)

    await expect(h.adapter.interrupt({
      sessionId: 'new-1',
      turnId: 'turn-1',
      runtimeEpoch: 'other-epoch',
      requestId: 'req-interrupt',
    }, signal())).rejects.toMatchObject({ code: 'stale-connection' })

    const interrupted = await h.adapter.interrupt({
      sessionId: 'new-1',
      turnId: 'turn-1',
      runtimeEpoch: 'epoch-1',
      requestId: 'req-interrupt',
    }, signal())
    expect(interrupted).toEqual({ accepted: true, runtimeEpoch: 'epoch-1', turnId: 'turn-1' })
    expect(h.server().interrupts).toBe(1)
    await h.adapter.stop()
  })

  it('rejects prompt on an unowned session before calling turn/start', async () => {
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
    expect(h.server().turnStarts).toBe(0)
    await h.adapter.stop()
  })

  it('keeps native steer closed until expectedTurnId is verified', async () => {
    const h = harness()
    await expect(h.adapter.steer({
      sessionId: 's1',
      turnId: 'turn-1',
      runtimeEpoch: 'epoch-1',
      text: 'more',
      requestId: 'req-steer',
    }, signal())).rejects.toMatchObject({ code: 'unsupported' })
    expect(h.servers).toHaveLength(0)
    await h.adapter.stop()
  })

  it('maps history turns into privacy-ready events', async () => {
    const h = harness()
    h.server().historyTurns = [{
      id: 'turn-9',
      status: 'completed',
      items: [
        { id: 'm1', type: 'agentMessage', text: 'done' },
        { id: 'r1', type: 'reasoning', content: [{ text: 'thinking' }], summary: [] },
        { id: 'c1', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a.txt', status: 'completed' },
      ],
    }]
    const page = await h.adapter.history({ sessionId: 's1', limit: 10 }, signal())
    expect(page.completeness).toBe('complete')
    expect(page.items.map(item => item.kind)).toEqual([
      'turn.started', 'message.completed', 'reasoning.delta', 'tool.completed', 'turn.completed',
    ])
    expect(page.items[1]?.payload).toMatchObject({ itemId: 'm1', text: 'done' })
    expect(page.items[3]?.payload).toMatchObject({ callId: 'c1', status: 'ok', content: 'a.txt' })
    expect(page.items[4]?.payload).toMatchObject({ turnId: 'turn-9', state: 'completed' })
    await h.adapter.stop()
  })

  it('streams mapped notifications to followers', async () => {
    const h = harness()
    const controller = new AbortController()
    await h.adapter.start(controller.signal)
    const create = h.adapter.createSession
    if (create === undefined) throw new Error('createSession missing')
    const created = await create({ requestId: 'req-create' }, controller.signal)

    const iterator = h.adapter.follow(created.sessionId, controller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    // 让生成器先注册监听；peer 已就绪，剩下的只是微任务。
    await new Promise(resolve => setTimeout(resolve, 0))
    h.server().notify('item/agentMessage/delta', {
      threadId: created.sessionId,
      itemId: 'item-1',
      delta: 'hello',
    })

    const next = await pending
    if (next.done) throw new Error('follow ended before the delta arrived')
    expect(next.value.kind).toBe('message.delta')
    expect(next.value.payload).toMatchObject({ itemId: 'item-1', text: 'hello' })

    controller.abort()
    await iterator.return?.()
    await h.adapter.stop()
  })

  it('validates create cwd before spawning side effects', async () => {
    const h = harness()
    await h.adapter.start(signal())
    const create = h.adapter.createSession
    if (create === undefined) throw new Error('createSession missing')
    await expect(create({ requestId: 'req-create', cwd: 'relative/dir' }, signal()))
      .rejects.toMatchObject({ code: 'invalid-args' })
    expect(h.server().requests.filter(item => item.method === 'thread/start')).toHaveLength(0)
    await h.adapter.stop()
  })

  it('rejects forking an unknown parent and records the real new identity', async () => {
    const h = harness()
    h.server().threads = [{ id: 's1' }]
    await h.adapter.start(signal())
    const fork = h.adapter.forkSession
    if (fork === undefined) throw new Error('forkSession missing')

    await expect(fork({ requestId: 'req-fork-1', parentSessionId: 'missing' }, signal()))
      .rejects.toMatchObject({ code: 'session-unknown' })
    expect(h.server().forks).toBe(0)

    const forked = await fork({ requestId: 'req-fork-2', parentSessionId: 's1' }, signal())
    expect(forked).toEqual({ sessionId: 'fork-1', runtimeEpoch: 'epoch-1', parentSessionId: 's1' })
    expect(h.server().forks).toBe(1)
    await h.adapter.stop()
  })

  it('relays a native approval of an owned session and answers with the mapped decision', async () => {
    const relay = new StubInputPort()
    relay.decision = { decision: 'answer', value: 'accept' }
    const h = harness({ questionRelay: 'remote', approvalRelay: 'remote', inputRelay: relay })
    const create = h.adapter.createSession
    const port = h.adapter.ownershipPort
    if (create === undefined || port === undefined) throw new Error('v1 ports missing')
    const created = await create({ requestId: 'req-create' }, signal())
    await port.acquire(created.sessionId, signal())

    h.server().send({
      jsonrpc: '2.0',
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: created.sessionId, itemId: 'item-1', command: 'ls -la' },
    })
    const response = await waitForResponse(h.server(), 77)
    expect(response.result).toEqual({ decision: 'accept' })
    expect(relay.claims).toHaveLength(1)
    expect(relay.claims[0]).toMatchObject({
      kind: 'approval', sessionId: created.sessionId, runtimeEpoch: 'epoch-1',
    })
    expect(relay.claims[0]?.approval).toMatchObject({ action: '运行命令', detail: 'ls -la' })
    expect(relay.claims[0]?.nativeExpiry).toBeUndefined()
    await h.adapter.stop()
  })

  it('declines a native approval of an external session without claiming', async () => {
    const relay = new StubInputPort()
    relay.decision = { decision: 'answer', value: 'accept' }
    const h = harness({ questionRelay: 'remote', approvalRelay: 'remote', inputRelay: relay })
    await h.adapter.start(signal())
    h.server().send({
      jsonrpc: '2.0',
      id: 78,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'external-1', itemId: 'item-1', command: 'ls' },
    })
    const response = await waitForResponse(h.server(), 78)
    expect(response.result).toEqual({ decision: 'decline' })
    expect(relay.claims).toHaveLength(0)
    await h.adapter.stop()
  })

  it('exposes answer/cancel only with a relay and a remote policy', async () => {
    const off = harness()
    expect(off.adapter.capabilities('new-1').operations.has('answer')).toBe(false)
    expect(off.adapter.capabilities('new-1').unavailable?.answer).toBe('interaction-relay-unavailable')
    await off.adapter.stop()

    const relayed = harness({
      questionRelay: 'remote', approvalRelay: 'remote', inputRelay: new StubInputPort(),
    })
    const capability = relayed.adapter.capabilities('new-1')
    expect(capability.operations.has('answer')).toBe(false)
    expect(capability.unavailable?.answer).toBe('interaction-relay-unavailable')
    const probed = await relayed.adapter.probe(signal())
    expect([...(probed.capability?.operations ?? [])].sort()).toEqual(['answer', 'cancel', 'create', 'fork'])
    expect(probed.capability?.unavailable?.answer).toBeUndefined()
    expect(probed.capability?.unavailable?.cancel).toBeUndefined()
    await relayed.adapter.stop()
  })

  it('routes answer and cancel commands to the interaction port', async () => {
    const relay = new StubInputPort()
    const h = harness({ questionRelay: 'remote', approvalRelay: 'remote', inputRelay: relay })
    const answers = [{ id: 'accept', selectedOptionIds: [] }]

    await expect(h.adapter.execute({
      op: 'answer', target: { sessionId: 'new-1' }, args: { requestId: 'a-1', answers },
    })).resolves.toEqual({ accepted: true })
    expect(relay.answerCalls).toEqual([{
      sessionId: 'new-1', requestId: 'a-1', value: { answers },
    }])

    relay.answerResult = 'expired'
    await expect(h.adapter.execute({
      op: 'answer', target: { sessionId: 'new-1' }, args: { requestId: 'a-2', answers },
    })).rejects.toMatchObject({ code: 'expired' })

    await expect(h.adapter.execute({
      op: 'cancel', target: { sessionId: 'new-1' }, args: { requestId: 'a-3' },
    })).resolves.toEqual({ cancelled: true })
    expect(relay.cancelCalls).toEqual([{ sessionId: 'new-1', requestId: 'a-3' }])

    relay.cancelResult = 'unknown'
    await expect(h.adapter.execute({
      op: 'cancel', target: { sessionId: 'new-1' }, args: { requestId: 'a-4' },
    })).rejects.toMatchObject({ code: 'unknown' })
    await h.adapter.stop()
  })

  it('rejects answer/cancel when no interaction port is wired', async () => {
    const h = harness()
    await expect(h.adapter.execute({
      op: 'answer', target: { sessionId: 'new-1' }, args: { requestId: 'a-1', answers: [] },
    })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(h.adapter.execute({
      op: 'cancel', target: { sessionId: 'new-1' }, args: { requestId: 'a-1' },
    })).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('advertises configure/acquire for a managed owned session with authorized goal', async () => {
    const h = harness({ contentAuthorized: () => true })
    const create = h.adapter.createSession
    const port = h.adapter.ownershipPort
    if (create === undefined || port === undefined) throw new Error('v1 ports missing')
    const created = await create({ requestId: 'req-create' }, signal())
    await port.acquire(created.sessionId, signal())

    const capability = h.adapter.capabilities(created.sessionId)
    expect(capability.operations.has('configure')).toBe(true)
    expect(capability.operations.has('acquire')).toBe(true)
    expect(capability.unavailable?.configure).toBeUndefined()
    expect(capability.unavailable?.acquire).toBeUndefined()
    expect(capability.settingsRevision).toBe(0)
    expect(capability.runtimeEpoch).toBe('epoch-1')
    expect(capability.tunables.find(item => item.id === 'goal')?.editable).toBe(true)
    // 目录没有模型/等级：除 goal 外的字段保持只读。
    expect(capability.tunables.filter(item => item.id !== 'goal').every(item => !item.editable)).toBe(true)

    // 没有 contentAuthorized 时同一会话的 goal 仍不可编辑。
    const closed = harness()
    const closedCreate = closed.adapter.createSession
    const closedPort = closed.adapter.ownershipPort
    if (closedCreate === undefined || closedPort === undefined) throw new Error('v1 ports missing')
    const un = await closedCreate({ requestId: 'req-create' }, signal())
    await closedPort.acquire(un.sessionId, signal())
    const ungoal = closed.adapter.capabilities(un.sessionId).tunables.find(item => item.id === 'goal')
    expect(ungoal?.editable).toBe(false)
    expect(ungoal?.reason).toBe('privacy-readback-unavailable')

    await closed.adapter.stop()
    await h.adapter.stop()
  })

  it('keeps acquire/configure off for an unmanaged session', () => {
    const h = harness()
    const capability = h.adapter.capabilities('external-1')
    expect(capability.operations.has('acquire')).toBe(false)
    expect(capability.operations.has('configure')).toBe(false)
    expect(capability.unavailable?.acquire).toBe('ownership-unverified')
    expect(capability.unavailable?.configure).toBe('ownership-unverified')
    expect(capability.settingsRevision).toBe(0)
    expect(capability.runtimeEpoch).toBe('epoch-1')
  })

  it('follows a managed session with an initial capability frame', async () => {
    const h = harness()
    const controller = new AbortController()
    const create = h.adapter.createSession
    if (create === undefined) throw new Error('createSession missing')
    const created = await create({ requestId: 'req-create' }, controller.signal)

    const iterator = h.adapter.follow(created.sessionId, controller.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) throw new Error('follow ended before the capability frame')
    expect(first.value.kind).toBe('capability.changed')
    expect(first.value.payload).toMatchObject({ settingsRevision: 0, runtimeEpoch: 'epoch-1' })

    controller.abort()
    await iterator.return?.()
    await h.adapter.stop()
  })

  it('publishes capability.changed with pending while a configure readback waits', async () => {
    const h = harness({ contentAuthorized: () => true })
    const controller = new AbortController()
    const create = h.adapter.createSession
    const port = h.adapter.ownershipPort
    const settingsPort = h.adapter.settingsPort
    if (create === undefined || port === undefined || settingsPort === undefined) {
      throw new Error('v1 ports missing')
    }
    const created = await create({ requestId: 'req-create' }, controller.signal)
    await port.acquire(created.sessionId, controller.signal)

    const iterator = h.adapter.follow(created.sessionId, controller.signal)[Symbol.asyncIterator]()
    const initial = await iterator.next()
    if (initial.done) throw new Error('follow ended before the capability frame')
    expect(initial.value.kind).toBe('capability.changed')

    // 让跟随生成器注册观察者，再启动会被挂起的 configure。
    const pendingNext = iterator.next()
    await new Promise(resolve => setTimeout(resolve, 0))
    h.server().holdGoalSet = true
    const configure = settingsPort.configure({
      sessionId: created.sessionId,
      field: 'goal',
      value: { objective: 'do X' },
      expectedRevision: 0,
      runtimeEpoch: 'epoch-1',
      contentAuthorized: true,
    }, controller.signal)
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (h.server().requests.some(item => item.method === 'thread/goal/set')) break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(h.server().requests.some(item => item.method === 'thread/goal/set')).toBe(true)

    // 等待期内的原生通知触发能力广播；pending 只暴露字段与状态。
    h.server().notify('thread/goal/updated', {
      threadId: created.sessionId,
      goal: { objective: 'do X' },
    })
    const pendingFrame = await pendingNext
    if (pendingFrame.done) throw new Error('follow ended before the pending capability')
    // 先放行写入，避免断言失败时留下未结算的等待。
    h.server().releaseGoalSet()

    expect(pendingFrame.value.kind).toBe('capability.changed')
    const pendingPayload = pendingFrame.value.payload as Record<string, unknown>
    expect(pendingPayload.settingsRevision).toBe(1)
    expect(pendingPayload.pending).toEqual({ field: 'goal', status: 'pending' })
    expect(JSON.stringify(pendingPayload)).not.toContain('do X')

    const result = await configure
    expect(result.status).toBe('confirmed')
    const confirmedFrame = await iterator.next()
    if (confirmedFrame.done) throw new Error('follow ended before the confirmed capability')
    expect(confirmedFrame.value.kind).toBe('capability.changed')
    const confirmedPayload = confirmedFrame.value.payload as Record<string, unknown>
    expect(confirmedPayload.pending).toBeUndefined()
    expect(confirmedPayload.settingsRevision).toBe(1)

    controller.abort()
    await iterator.return?.()
    await h.adapter.stop()
  })
})
