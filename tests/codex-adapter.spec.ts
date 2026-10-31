import { describe, expect, it } from 'vitest'
import { OwnershipError } from '../src/agents/ownership.ts'
import type { SpawnFn, SupervisorChild } from '../src/agents/supervisor.ts'
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
    if (typeof method !== 'string') return
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
      default:
        this.fail(id, -32601)
    }
  }
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
})
