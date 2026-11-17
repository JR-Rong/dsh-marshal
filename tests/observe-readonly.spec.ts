import { describe, expect, it } from 'vitest'
import type {
  Capability, Operation, SnapshotCompleteness, SyncSnapshot,
} from '../src/adapters/types.ts'
import type { EventFrame } from '../src/wire/frames.ts'
import type {
  AgentAdapter, AgentHealth, AgentListResult, ControlResult, HistoryPage, HistoryRequest,
  InterruptRequest, ProbeResult, PromptRequest, SteerRequest,
} from '../src/agents/types.ts'
import {
  createOwnershipCoordinator, type OwnershipCoordinator,
} from '../src/agents/ownership.ts'
import { createFollower } from '../src/node/runner.ts'

interface Calls {
  history: number
  observe: number
  follow: number
  acquire: number
  prompt: number
  configure: number
  start: number
  nativeStart: number
  execute: number
}

/** 只读路径必须完全不触发 acquire/prompt/configure/start；计数是断言证据。 */
class ReadOnlyAgent implements AgentAdapter {
  readonly agent = 'fake'
  readonly runtimeEpoch = 'epoch-1'
  readonly snapshotCompleteness: SnapshotCompleteness = 'complete'
  readonly coordinator: OwnershipCoordinator = createOwnershipCoordinator({
    runtimeEpoch: 'epoch-1', holder: 'read-only-test',
  })
  readonly calls: Calls = {
    history: 0, observe: 0, follow: 0, acquire: 0, prompt: 0, configure: 0,
    start: 0, nativeStart: 0, execute: 0,
  }
  followSignal: AbortSignal | undefined
  private historyAvailable = true

  capabilities(sessionId: string): Capability {
    return {
      observe: { history: this.historyAvailable, follow: 'stream' },
      operations: new Set<Operation>(['prompt']),
      ownership: this.coordinator.ownership(sessionId),
      reasoning: false,
      toolDetail: 'none',
      promptFidelity: 'none',
      tunables: [],
    }
  }

  syncSnapshot(_signal: AbortSignal): Promise<SyncSnapshot> {
    return Promise.resolve({
      rows: [{ sessionId: 's1', running: false, updatedAt: 1, blank: false }],
      capabilities: [{
        agent: this.agent,
        capability: {
          observe: { history: this.historyAvailable, follow: 'stream' },
          ownership: this.coordinator.ownership('s1'),
        },
      }],
      completeness: 'complete',
    })
  }

  snapshot(_signal: AbortSignal): Promise<readonly EventFrame[]> {
    return Promise.resolve([this.frame('s1', 'message.completed', { text: 'snapshot' })])
  }

  async *follow(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame> {
    this.calls.follow += 1
    this.followSignal = signal
    yield this.frame(sessionId, 'message.completed', { text: 'ready' })
    await new Promise<void>(resolve => {
      if (signal.aborted) { resolve(); return }
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  frame(sessionId: string, kind: EventFrame['kind'], payload: unknown): EventFrame {
    return {
      v: 2, type: 'event', deviceId: 'dev', agent: this.agent, sessionId,
      nodeEpoch: 'epoch-1', seq: 1, ts: 0, kind, payload,
    }
  }

  execute(_command: { op: string; target: { sessionId: string }; args?: unknown }): Promise<unknown> {
    this.calls.execute += 1
    return Promise.resolve({ accepted: true })
  }

  probe(_signal: AbortSignal): Promise<ProbeResult> {
    return Promise.resolve({ ok: true, at: 0, runtimeEpoch: this.runtimeEpoch })
  }

  start(_signal: AbortSignal): Promise<void> {
    this.calls.start += 1
    this.calls.nativeStart += 1
    return Promise.resolve()
  }

  stop(): Promise<void> {
    return Promise.resolve()
  }

  health(): AgentHealth {
    return {
      agent: this.agent, runtimeEpoch: this.runtimeEpoch, state: 'ready', updatedAt: 0,
    }
  }

  list(_signal: AbortSignal): Promise<AgentListResult> {
    return Promise.resolve({ rows: [], completeness: 'complete' })
  }

  history(request: HistoryRequest, signal: AbortSignal): Promise<HistoryPage> {
    this.calls.history += 1
    if (signal.aborted) return Promise.reject(signal.reason)
    return Promise.resolve({
      items: [this.frame(request.sessionId, 'message.completed', { text: 'history' })],
      completeness: 'complete',
    })
  }

  async *observe(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame> {
    this.calls.observe += 1
    if (signal.aborted) return
    yield this.frame(sessionId, 'message.completed', { text: 'observed' })
  }

  async prompt(request: PromptRequest, signal: AbortSignal): Promise<ControlResult> {
    this.calls.prompt += 1
    if (signal.aborted) return Promise.reject(signal.reason)
    // 写入口必须显式经过所有权协调器；只读观察不会留下 ours。
    this.coordinator.beginPrompt(request.sessionId)
    const turnId = `turn-${this.calls.prompt}`
    this.coordinator.bindTurn(request.sessionId, turnId)
    return Promise.resolve({ accepted: true, runtimeEpoch: this.runtimeEpoch, turnId })
  }

  steer(request: SteerRequest, signal: AbortSignal): Promise<ControlResult> {
    if (signal.aborted) return Promise.reject(signal.reason)
    this.coordinator.authorizeControl(request.sessionId, request.turnId)
    return Promise.resolve({ accepted: true, runtimeEpoch: this.runtimeEpoch, turnId: request.turnId })
  }

  interrupt(request: InterruptRequest, signal: AbortSignal): Promise<ControlResult> {
    if (signal.aborted) return Promise.reject(signal.reason)
    this.coordinator.authorizeControl(request.sessionId, request.turnId)
    return Promise.resolve({ accepted: true, runtimeEpoch: this.runtimeEpoch, turnId: request.turnId })
  }

  /** 设置/取得写权的可观察替身：只读路径不应触发它们。 */
  async acquire(sessionId: string) {
    this.calls.acquire += 1
    return await this.coordinator.acquire(sessionId, async () => ({
      sessionId,
      mechanism: 'test-lock',
      holder: 'read-only-test',
      runtimeEpoch: this.runtimeEpoch,
      acquiredAt: 0,
      invalidatesOn: ['process-exit'],
    }))
  }

  configure(sessionId: string): void {
    this.calls.configure += 1
    this.coordinator.beginConfigure(sessionId)
    this.coordinator.endConfigure(sessionId)
  }

  setHistory(available: boolean): void {
    this.historyAvailable = available
  }
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('observe is read-only', () => {
  it('history and observe never acquire, prompt, configure or start native work', async () => {
    const agent = new ReadOnlyAgent()
    const signal = new AbortController().signal

    const page = await agent.history({ sessionId: 's1' }, signal)
    expect(page.items).toHaveLength(1)
    expect(page.completeness).toBe('complete')

    const observed: EventFrame[] = []
    for await (const event of agent.observe('s1', signal)) observed.push(event)
    expect(observed).toHaveLength(1)

    expect(agent.calls).toMatchObject({
      history: 1, observe: 1, acquire: 0, prompt: 0, configure: 0, start: 0, nativeStart: 0,
    })
    expect(agent.coordinator.state('s1')).toBe('foreign-unknown')
    expect(agent.coordinator.ownership('s1')).toBe('foreign-unknown')
    expect(agent.coordinator.controlReason('s1')).toBe('ownership-unverified')

    // 只读成功不能变成写权：prompt 仍然被拒绝为 ownership-unverified。
    await expect(agent.prompt({
      sessionId: 's1', text: 'hello', requestId: 'r1', runtimeEpoch: agent.runtimeEpoch,
    }, signal)).rejects.toMatchObject({ name: 'OwnershipError', code: 'ownership-unverified' })
    expect(agent.coordinator.state('s1')).toBe('foreign-unknown')
  })

  it('keeps history and follow capability fields independent', () => {
    const agent = new ReadOnlyAgent()
    expect(agent.capabilities('s1').observe).toEqual({ history: true, follow: 'stream' })
    agent.setHistory(false)
    expect(agent.capabilities('s1').observe).toEqual({ history: false, follow: 'stream' })
    agent.setHistory(true)
    expect(agent.capabilities('s1').observe).toEqual({ history: true, follow: 'stream' })
  })
})

describe('follower reference counting', () => {
  it('shares one native follow and aborts only after the last unsubscribe', async () => {
    const agent = new ReadOnlyAgent()
    const sent: EventFrame[] = []
    const follower = createFollower({
      adapter: agent,
      send: event => sent.push(event),
      logger: { warn() {} },
    })

    expect(follower.subscribe('s1', 'sub-a', 'caller-1')).toBe('ok')
    await flush()
    expect(agent.calls.follow).toBe(1)

    expect(follower.subscribe('s1', 'sub-b', 'caller-1')).toBe('ok')
    await flush()
    expect(agent.calls.follow).toBe(1)

    // 同一 subscriptionId 不能交给另一个调用者。
    expect(follower.subscribe('s1', 'sub-a', 'caller-2')).toBe('conflict')
    expect(follower.subscribe('s1', 'sub-a', 'caller-1')).toBe('ok')
    expect(follower.unsubscribe('s1', 'sub-a', 'caller-2')).toBe(false)

    expect(follower.unsubscribe('s1', 'sub-a', 'caller-1')).toBe(true)
    await flush()
    expect(agent.followSignal?.aborted).toBe(false)
    expect(follower.has('s1')).toBe(true)
    expect(agent.calls.follow).toBe(1)

    expect(follower.unsubscribe('s1', 'sub-b', 'caller-1')).toBe(true)
    await flush()
    expect(agent.followSignal?.aborted).toBe(true)
    expect(follower.has('s1')).toBe(false)
    expect(sent).toHaveLength(1)
  })
})
