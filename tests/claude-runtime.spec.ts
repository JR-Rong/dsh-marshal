import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  Query, SDKControlInterruptResponse, SDKMessage, SDKSystemMessage, SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  CLAUDE_RUNTIME_MAX_QUEUED_INPUTS, ClaudeRuntimeError,
  createClaudeRuntime, type ClaudeRuntimeExitReason, type ClaudeRuntimeOptions,
  type ClaudeSdk, type ClaudeSdkQueryParams,
} from '../src/agents/claude/runtime.ts'

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
    session_id: 'session-1',
  }
}

/** 只实现运行时实际使用的成员；`Query` 的其余控制方法对适配器不可见。 */
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

  end(): void {
    this.finished = true
    this.wake()
  }

  close(): void {
    this.closeCalls += 1
    this.end()
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
    this.end()
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

function fakeSdk(): { sdk: ClaudeSdk; queries: FakeQuery[] } {
  const queries: FakeQuery[] = []
  const sdk: ClaudeSdk = {
    query(params: ClaudeSdkQueryParams): Query {
      const query = new FakeQuery(params)
      queries.push(query)
      return query as unknown as Query
    },
    async listSessions() { return [] },
    async getSessionMessages() { return [] },
  }
  return { sdk, queries }
}

interface Harness {
  readonly runtime: ReturnType<typeof createClaudeRuntime>
  readonly queries: FakeQuery[]
  query(): FakeQuery
  exits: ClaudeRuntimeExitReason[]
  errors: unknown[]
  messages: SDKMessage[]
}

function harness(overrides: Partial<ClaudeRuntimeOptions> = {}): Harness {
  const fake = fakeSdk()
  const exits: ClaudeRuntimeExitReason[] = []
  const errors: unknown[] = []
  const messages: SDKMessage[] = []
  const runtime = createClaudeRuntime({
    sdk: fake.sdk,
    generation: 1,
    runtimeEpoch: 'epoch-1',
    initTimeoutMs: 1_000,
    onMessage: message => { messages.push(message) },
    onExit: reason => { exits.push(reason) },
    onError: error => { errors.push(error) },
    ...overrides,
  })
  const query = (): FakeQuery => {
    const first = fake.queries[0]
    if (first === undefined) throw new Error('query was not created')
    return first
  }
  return { runtime, queries: fake.queries, query, exits, errors, messages }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('claude runtime', () => {
  it('waits for system/init before exposing the native session id', async () => {
    const h = harness()
    expect(h.runtime.sessionId()).toBeUndefined()

    h.query().push(initMessage('session-native'))
    const init = await h.runtime.ready()
    expect(init.session_id).toBe('session-native')
    expect(h.runtime.sessionId()).toBe('session-native')
    expect(h.runtime.state).toBe('idle')
    expect(h.messages[0]?.type).toBe('system')
    expect(h.query().params.options?.includePartialMessages).toBe(true)
    expect(h.query().params.options?.abortController).toBeDefined()

    h.runtime.close()
    expect(h.exits).toEqual(['closed'])
  })

  it('pushes user input through the streaming prompt with the caller uuid', async () => {
    const h = harness()
    h.query().push(initMessage('session-native'))
    await h.runtime.ready()

    const prompt = h.query().params.prompt
    if (typeof prompt === 'string') throw new Error('streaming input was not used')
    const iterator = prompt[Symbol.asyncIterator]()

    const firstUuid = randomUUID()
    h.runtime.send('first', firstUuid)
    const first = await iterator.next()
    expect(first.done).toBe(false)
    const firstMessage = first.value as SDKUserMessage
    expect(firstMessage.uuid).toBe(firstUuid)
    expect(firstMessage.message).toEqual({ role: 'user', content: 'first' })
    expect(firstMessage.session_id).toBe('session-native')

    h.runtime.close()
  })

  it('reports closed and busy inputs synchronously before any native call', async () => {
    const h = harness()
    h.query().push(initMessage('session-1'))
    await h.runtime.ready()

    for (let index = 0; index < CLAUDE_RUNTIME_MAX_QUEUED_INPUTS; index += 1) {
      h.runtime.send('queued', randomUUID())
    }
    const busy = (() => {
      try {
        h.runtime.send('overflow', randomUUID())
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(busy).toBeInstanceOf(ClaudeRuntimeError)
    expect(busy).toMatchObject({ code: 'busy' })

    h.runtime.close()
    const closed = (() => {
      try {
        h.runtime.send('after-close', randomUUID())
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(closed).toBeInstanceOf(ClaudeRuntimeError)
    expect(closed).toMatchObject({ code: 'closed' })
    await expect(h.runtime.interrupt(signal())).rejects.toMatchObject({ code: 'closed' })
    expect(h.query().interruptCalls).toBe(0)
  })

  it('closes idempotently and notifies exit exactly once', async () => {
    const h = harness()
    h.query().push(initMessage('session-1'))
    await h.runtime.ready()

    h.runtime.close()
    h.runtime.close()
    expect(h.exits).toEqual(['closed'])
    expect(h.errors).toEqual([])
    expect(h.query().closeCalls).toBe(1)
    expect(h.runtime.closed).toBe(true)
  })

  it('fails init with a timeout instead of inventing a session id', async () => {
    const h = harness({ initTimeoutMs: 5 })
    await expect(h.runtime.ready()).rejects.toMatchObject({ code: 'timeout' })
    expect(h.runtime.sessionId()).toBeUndefined()
    expect(h.runtime.closed).toBe(true)
    expect(h.exits).toEqual(['timeout'])
    expect(h.errors).toHaveLength(1)
  })

  it('turns an iterator failure into one error exit and a failed init', async () => {
    const h = harness()
    const failure = new Error('transport died')
    h.query().fail(failure)
    await expect(h.runtime.ready()).rejects.toMatchObject({ code: 'failed' })
    expect(h.exits).toEqual(['error'])
    expect(h.errors).toEqual([failure])
  })

  it('forwards interrupt to the sdk only after a live runtime', async () => {
    const h = harness()
    h.query().push(initMessage('session-1'))
    await h.runtime.ready()
    h.query().interruptResult = { still_queued: [] }

    const result = await h.runtime.interrupt(signal())
    expect(result).toEqual({ still_queued: [] })
    expect(h.query().interruptCalls).toBe(1)

    h.runtime.close()
  })

  it('changes run state from native session_state_changed frames', async () => {
    const h = harness()
    h.query().push(initMessage('session-1'))
    await h.runtime.ready()
    expect(h.runtime.state).toBe('idle')

    h.query().push(stateMessage('running'))
    h.query().push(stateMessage('requires_action'))
    h.query().push(stateMessage('idle'))
    // 让消息泵把队列消费完。
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.runtime.state).toBe('idle')
    h.runtime.close()
  })
})
