import { describe, expect, it } from 'vitest'
import type {
  Capability, Operation, SnapshotCompleteness, SyncSnapshot,
} from '../src/adapters/types.ts'
import type { EventFrame } from '../src/wire/frames.ts'
import { createAgentRegistry } from '../src/agents/registry.ts'
import { AgentHostError, createAgentHost } from '../src/agents/host.ts'
import type {
  AgentAdapter, AgentHealth, AgentListResult, AgentState, ControlResult, HistoryPage,
  HistoryRequest, InterruptRequest, ProbeResult, PromptRequest, SteerRequest,
} from '../src/agents/types.ts'
import { AgentUnavailableError } from '../src/agents/types.ts'

function capability(): Capability {
  return {
    observe: { history: false, follow: 'stream' },
    operations: new Set<Operation>(['prompt']),
    ownership: 'unverified',
    reasoning: true,
    toolDetail: 'none',
    promptFidelity: 'native',
    tunables: [],
  }
}

function snapshotFor(agent: string, sessionIds: readonly string[]): SyncSnapshot {
  return {
    rows: sessionIds.map(sessionId => ({
      sessionId, running: false, updatedAt: 1, blank: false,
    })),
    capabilities: [{ agent, capability: { ownership: 'unverified' } }],
    completeness: 'complete',
  }
}

interface FakeAgentOptions {
  readonly state?: AgentState
  readonly stopError?: Error
}

class FakeAgent implements AgentAdapter {
  readonly runtimeEpoch = 'epoch-1'
  readonly snapshotCompleteness: SnapshotCompleteness = 'complete'
  readonly calls: string[] = []
  private readonly state: AgentState
  private readonly stopError: Error | undefined

  constructor(
    readonly agent: string,
    private readonly snapshotImpl: (signal: AbortSignal) => Promise<SyncSnapshot>,
    options: FakeAgentOptions = {},
  ) {
    this.state = options.state ?? 'ready'
    this.stopError = options.stopError
  }

  capabilities(_sessionId: string): Capability {
    return capability()
  }

  async syncSnapshot(signal: AbortSignal): Promise<SyncSnapshot> {
    return await this.snapshotImpl(signal)
  }

  async snapshot(_signal: AbortSignal): Promise<readonly EventFrame[]> {
    return []
  }

  async *follow(sessionId: string, _signal: AbortSignal): AsyncIterable<EventFrame> {
    yield this.frame(sessionId, 'message.completed', { text: 'ok' })
  }

  frame(sessionId: string, kind: EventFrame['kind'], payload: unknown): EventFrame {
    return {
      v: 2, type: 'event', deviceId: 'dev', agent: this.agent, sessionId,
      nodeEpoch: 'epoch-1', seq: 1, ts: 0, kind, payload,
    }
  }

  async execute(command: { op: string; target: { sessionId: string }; args?: unknown }): Promise<unknown> {
    this.calls.push(`execute:${command.op}`)
    return { ok: true, agent: this.agent }
  }

  async probe(_signal: AbortSignal): Promise<ProbeResult> {
    return { ok: true, at: 0, runtimeEpoch: this.runtimeEpoch }
  }

  async start(_signal: AbortSignal): Promise<void> {
    this.calls.push('start')
  }

  async stop(): Promise<void> {
    this.calls.push('stop')
    if (this.stopError !== undefined) throw this.stopError
  }

  health(): AgentHealth {
    return {
      agent: this.agent,
      runtimeEpoch: this.runtimeEpoch,
      state: this.state,
      updatedAt: 0,
    }
  }

  async list(_signal: AbortSignal): Promise<AgentListResult> {
    return { rows: [], completeness: 'complete' }
  }

  async history(_request: HistoryRequest, _signal: AbortSignal): Promise<HistoryPage> {
    return { items: [], completeness: 'complete' }
  }

  async *observe(_sessionId: string, _signal: AbortSignal): AsyncIterable<EventFrame> {
    // 只读观察在 T01 不接真实协议。
  }

  async prompt(_request: PromptRequest, _signal: AbortSignal): Promise<ControlResult> {
    return { accepted: true, runtimeEpoch: this.runtimeEpoch }
  }

  async steer(_request: SteerRequest, _signal: AbortSignal): Promise<ControlResult> {
    return { accepted: true, runtimeEpoch: this.runtimeEpoch }
  }

  async interrupt(_request: InterruptRequest, _signal: AbortSignal): Promise<ControlResult> {
    return { accepted: true, runtimeEpoch: this.runtimeEpoch }
  }
}

function command(op = 'prompt'): { op: string; target: { sessionId: string }; args: unknown } {
  return { op, target: { sessionId: 's1' }, args: {} }
}

describe('AgentHost snapshot isolation', () => {
  it('one failing adapter does not remove other agents or their rows', async () => {
    const registry = createAgentRegistry()
    const codex = new FakeAgent('codex', async () => snapshotFor('codex', ['s1', 's2']))
    const claude = new FakeAgent('claude', async () => { throw new Error('boom') })
    registry.register(codex)
    registry.register(claude)
    const host = createAgentHost({ registry })

    const snapshot = await host.snapshotAll(new AbortController().signal)

    expect(snapshot.rows.map(row => row.sessionId)).toEqual(['s1', 's2'])
    expect(snapshot.completeness).toBe('unconfirmed')
    expect(snapshot.agents.find(item => item.agent === 'codex')?.rows).toHaveLength(2)
    expect(snapshot.agents.find(item => item.agent === 'claude')?.rows).toEqual([])
    expect(snapshot.capabilities.find(item => item.agent === 'codex')?.capability)
      .toEqual({ ownership: 'unverified' })
    expect(snapshot.capabilities.find(item => item.agent === 'claude')?.capability)
      .toEqual({ unavailable: { adapter: 'snapshot-failed' } })
  })

  it('records the unavailable reason in health for only the failing agent', async () => {
    const registry = createAgentRegistry()
    registry.register(new FakeAgent('codex', async () => snapshotFor('codex', ['s1'])))
    registry.register(new FakeAgent('claude', async () => { throw new Error('boom') }))
    const host = createAgentHost({ registry })

    await host.snapshotAll(new AbortController().signal)

    expect(host.healthOf('codex')?.state).toBe('ready')
    const failed = host.healthOf('claude')
    expect(failed?.state).toBe('unavailable')
    expect(failed?.unavailable).toEqual({ reason: 'snapshot-failed' })
    expect(host.health().map(item => item.agent)).toEqual(['codex', 'claude'])
  })

  it('keeps an adapter-supplied stable unavailable reason', async () => {
    const registry = createAgentRegistry()
    registry.register(new FakeAgent('claude', async () => {
      throw new AgentUnavailableError({ reason: 'auth-required' })
    }))
    const host = createAgentHost({ registry })

    const snapshot = await host.snapshotAll(new AbortController().signal)
    expect(snapshot.capabilities[0]?.capability).toEqual({ unavailable: { adapter: 'auth-required' } })
    expect(host.healthOf('claude')?.unavailable?.reason).toBe('auth-required')
  })

  it('honours an aborted snapshot signal instead of reporting adapter failure', async () => {
    const registry = createAgentRegistry()
    registry.register(new FakeAgent('codex', async () => snapshotFor('codex', ['s1']), { state: 'starting' }))
    const host = createAgentHost({ registry })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))

    await expect(host.snapshotAll(controller.signal)).rejects.toThrow('cancelled')
    expect(host.healthOf('codex')?.state).toBe('starting')
  })
})

describe('AgentHost routing', () => {
  it('routes execute and follow to the named adapter', async () => {
    const registry = createAgentRegistry()
    const codex = new FakeAgent('codex', async () => snapshotFor('codex', []))
    registry.register(codex)
    const host = createAgentHost({ registry })

    await expect(host.execute('codex', command('interrupt'))).resolves.toEqual({ ok: true, agent: 'codex' })
    expect(codex.calls).toContain('execute:interrupt')

    const events: EventFrame[] = []
    for await (const event of host.follow('codex', 's1', new AbortController().signal)) {
      events.push(event)
    }
    expect(events).toHaveLength(1)
    expect(events[0]?.agent).toBe('codex')
    expect(events[0]?.sessionId).toBe('s1')
  })

  it('rejects unknown agents explicitly for both execute and follow', async () => {
    const registry = createAgentRegistry()
    registry.register(new FakeAgent('codex', async () => snapshotFor('codex', [])))
    const host = createAgentHost({ registry })

    await expect(host.execute('missing', command())).rejects.toMatchObject({
      name: 'AgentHostError',
      code: 'agent-unknown',
      agent: 'missing',
    })

    let thrown: unknown
    try {
      host.follow('missing', 's1', new AbortController().signal)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AgentHostError)
    expect((thrown as AgentHostError).code).toBe('agent-unknown')
  })
})

describe('AgentHost dispose', () => {
  it('stops every adapter once and rejects later calls', async () => {
    const registry = createAgentRegistry()
    const codex = new FakeAgent('codex', async () => snapshotFor('codex', []))
    const claude = new FakeAgent('claude', async () => snapshotFor('claude', []))
    registry.register(codex)
    registry.register(claude)
    const host = createAgentHost({ registry })

    await host.dispose()
    await host.dispose()

    expect(codex.calls.filter(item => item === 'stop')).toHaveLength(1)
    expect(claude.calls.filter(item => item === 'stop')).toHaveLength(1)
    expect(host.disposed).toBe(true)
    expect(host.healthOf('codex')?.state).toBe('stopped')

    await expect(host.execute('codex', command())).rejects.toMatchObject({ code: 'host-disposed' })
    await expect(host.snapshotAll(new AbortController().signal))
      .rejects.toMatchObject({ code: 'host-disposed' })
    expect(() => host.follow('codex', 's1', new AbortController().signal))
      .toThrow(AgentHostError)
  })

  it('a failing stop does not block cleanup of the other adapters', async () => {
    const registry = createAgentRegistry()
    const codex = new FakeAgent('codex', async () => snapshotFor('codex', []))
    const claude = new FakeAgent('claude', async () => snapshotFor('claude', []), {
      stopError: new Error('stop failed'),
    })
    registry.register(claude)
    registry.register(codex)
    const host = createAgentHost({ registry })

    await expect(host.dispose()).resolves.toBeUndefined()
    expect(codex.calls).toContain('stop')
    expect(claude.calls).toContain('stop')
    expect(host.healthOf('claude')?.state).toBe('stopped')
    expect(host.healthOf('codex')?.state).toBe('stopped')
  })
})
