import type { SyncCapabilityDocument, SyncSessionRow } from '../adapters/types.ts'
import type { EventFrame } from '../wire/frames.ts'
import {
  AgentUnavailableError, type AgentAdapter, type AgentHealth, type AgentHostSnapshot,
  type AgentSnapshotReport, type UnavailableCause,
} from './types.ts'
import {
  unavailableCapability, type AgentEntry, type AgentRegistry,
} from './registry.ts'

/**
 * AgentHost 只做进程内路由与汇总：
 *
 * - 只读：snapshotAll 逐个 adapter try/catch，失败者只降低自己（无行、能力带
 *   不可用原因），其他 adapter 照常返回；健康状态以 registry 记录为准。
 * - 控制：execute/follow 按 agent 路由，未知 agent 明确拒绝。
 * - **没有**远端写入口。真正的写命令仍必须由现有 node runner 完成身份、
 *   期限、journal、privacy 与 ACK 处理；Host 不能绕过 runner/journal/privacy
 *   被直接调用去执行远端命令。`execute` 只是 runner 已经受理之后的适配器分派点。
 */

export type AgentHostErrorCode = 'agent-unknown' | 'host-disposed'

export class AgentHostError extends Error {
  override readonly name = 'AgentHostError'
  readonly code: AgentHostErrorCode
  readonly agent: string | undefined

  constructor(code: AgentHostErrorCode, agent?: string) {
    super(agent === undefined ? `marshal: ${code}` : `marshal: ${code}: ${agent}`)
    this.code = code
    this.agent = agent
  }
}

export type AgentCommand = Parameters<AgentAdapter['execute']>[0]

export interface AgentHostOptions {
  readonly registry: AgentRegistry
}

export interface AgentHost {
  readonly agents: readonly string[]
  readonly disposed: boolean
  health(): readonly AgentHealth[]
  healthOf(agent: string): AgentHealth | undefined
  snapshotAll(signal: AbortSignal): Promise<AgentHostSnapshot>
  execute(agent: string, command: AgentCommand): Promise<unknown>
  follow(agent: string, sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame>
  /** 幂等：第一次之后的调用返回同一个 Promise；停止所有 adapter 子进程。 */
  dispose(): Promise<void>
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason
}

/** 只取样例给出的稳定原因，绝不把 Error.message 写进能力文档。 */
function causeOf(error: unknown): UnavailableCause {
  return error instanceof AgentUnavailableError
    ? error.unavailable
    : { reason: 'snapshot-failed' }
}

function unavailableDocument(agent: string, cause: UnavailableCause): SyncCapabilityDocument {
  return { agent, capability: unavailableCapability(cause) }
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const { registry } = options
  let disposed = false
  let disposePromise: Promise<void> | undefined

  const resolveHealth = (entry: AgentEntry): AgentHealth => {
    const recorded = registry.healthOf(entry.agent)
    if (recorded !== undefined
      && (recorded.state === 'unavailable'
        || recorded.state === 'failed'
        || recorded.state === 'stopped')) {
      return recorded
    }
    try {
      // adapter.health() 是实时诊断；读取失败只降低这一项。
      const reported = entry.adapter.health()
      return {
        ...reported,
        agent: entry.agent,
        runtimeEpoch: entry.adapter.runtimeEpoch,
      }
    } catch {
      const base: AgentHealth = recorded ?? {
        agent: entry.agent,
        runtimeEpoch: entry.adapter.runtimeEpoch,
        state: entry.state,
        updatedAt: entry.updatedAt,
      }
      return { ...base, state: 'unavailable', unavailable: { reason: 'health-failed' } }
    }
  }

  const requireAgent = (agent: string): AgentEntry => {
    if (disposed) throw new AgentHostError('host-disposed', agent)
    const entry = registry.entries().find(item => item.agent === agent)
    if (entry === undefined) throw new AgentHostError('agent-unknown', agent)
    return entry
  }

  return {
    get agents(): readonly string[] {
      return registry.list()
    },

    get disposed(): boolean {
      return disposed
    },

    health(): readonly AgentHealth[] {
      return registry.entries().map(resolveHealth)
    },

    healthOf(agent: string): AgentHealth | undefined {
      if (disposed && !registry.has(agent)) return undefined
      const entry = registry.entries().find(item => item.agent === agent)
      return entry === undefined ? undefined : resolveHealth(entry)
    },

    async snapshotAll(signal: AbortSignal): Promise<AgentHostSnapshot> {
      if (disposed) throw new AgentHostError('host-disposed')
      throwIfAborted(signal)

      const rows: SyncSessionRow[] = []
      const capabilities: SyncCapabilityDocument[] = []
      const reports: AgentSnapshotReport[] = []
      let complete = true

      // 逐个采集，单个 adapter 的失败只影响它自己的报告。
      for (const entry of registry.entries()) {
        throwIfAborted(signal)
        try {
          const snapshot = await entry.adapter.syncSnapshot(signal)
          if (snapshot.completeness !== 'complete') complete = false

          const ownRows = [...snapshot.rows]
          const ownCapabilities = snapshot.capabilities.filter(item => item.agent === entry.agent)
          if (ownCapabilities.length === 0) {
            const fallback = registry.capabilityDocument(entry.agent)
            ownCapabilities.push(fallback ?? {
              agent: entry.agent,
              capability: { unavailable: { adapter: 'capability-unavailable' } },
            })
          }

          rows.push(...ownRows)
          capabilities.push(...ownCapabilities)
          registry.markReady(entry.agent)
          reports.push({
            agent: entry.agent,
            state: 'ready',
            rows: ownRows,
            capabilities: ownCapabilities,
            completeness: snapshot.completeness,
          })
        } catch (error) {
          // 调用方中止不是 adapter 故障，不能吞掉。
          if (signal.aborted) throw error
          const cause = causeOf(error)
          const document = unavailableDocument(entry.agent, cause)
          complete = false
          registry.markUnavailable(entry.agent, cause)
          capabilities.push(document)
          reports.push({
            agent: entry.agent,
            state: 'unavailable',
            rows: [],
            capabilities: [document],
            completeness: 'unconfirmed',
            unavailable: cause,
          })
        }
      }

      return {
        rows,
        capabilities,
        completeness: complete ? 'complete' : 'unconfirmed',
        agents: reports,
      }
    },

    execute(agent: string, command: AgentCommand): Promise<unknown> {
      let entry: AgentEntry
      try {
        entry = requireAgent(agent)
      } catch (error) {
        return Promise.reject(error)
      }
      return entry.adapter.execute(command)
    },

    follow(agent: string, sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame> {
      const entry = requireAgent(agent)
      return entry.adapter.follow(sessionId, signal)
    },

    dispose(): Promise<void> {
      if (disposePromise !== undefined) return disposePromise
      disposed = true
      disposePromise = (async () => {
        for (const entry of registry.entries()) {
          try {
            await entry.adapter.stop()
          } catch {
            // 一个 adapter 停止失败不能阻止其它进程清理。
          }
          registry.setState(entry.agent, 'stopped', { reason: 'disposed' })
        }
      })()
      return disposePromise
    },
  }
}
