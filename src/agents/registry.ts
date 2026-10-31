import type {
  AgentAdapter, AgentHealth, AgentState, ProbeResult, UnavailableCause,
} from './types.ts'
import type { Capability, SyncCapabilityDocument } from '../adapters/types.ts'

/**
 * 每个 agent 独立记录：状态、稳定原因、最近探测与最近能力文档。
 * 任何单条记录的操作失败都不改变其它记录；这里不做全局重建。
 */

export type AgentRegistryErrorCode = 'agent-duplicate'

export class AgentRegistryError extends Error {
  override readonly name = 'AgentRegistryError'
  readonly code: AgentRegistryErrorCode
  readonly agent: string

  constructor(code: AgentRegistryErrorCode, agent: string) {
    super(`marshal: ${code}: ${agent}`)
    this.code = code
    this.agent = agent
  }
}

export interface AgentEntry {
  readonly agent: string
  readonly runtimeEpoch: string
  readonly adapter: AgentAdapter
  readonly state: AgentState
  readonly reason?: UnavailableCause
  readonly capability?: Capability
  readonly lastProbe?: ProbeResult
  readonly updatedAt: number
}

export interface AgentRegistry {
  register(adapter: AgentAdapter): void
  unregister(agent: string): boolean
  has(agent: string): boolean
  get(agent: string): AgentAdapter | undefined
  list(): readonly string[]
  entries(): readonly AgentEntry[]
  health(): readonly AgentHealth[]
  healthOf(agent: string): AgentHealth | undefined
  setState(agent: string, state: AgentState, reason?: UnavailableCause): boolean
  markReady(agent: string, capability?: Capability): boolean
  markUnavailable(agent: string, cause: UnavailableCause): boolean
  recordProbe(agent: string, result: ProbeResult): boolean
  recordCapability(agent: string, capability: Capability): boolean
  capabilityDocument(agent: string): SyncCapabilityDocument | undefined
}

interface Record_ {
  readonly adapter: AgentAdapter
  state: AgentState
  reason: UnavailableCause | undefined
  capability: Capability | undefined
  lastProbe: ProbeResult | undefined
  updatedAt: number
}

/** 把通用 Capability 序列化成 wire 能力文档；字段与会话级投影白名单保持一致。 */
export function toCapabilityDocument(capability: Capability): Record<string, unknown> {
  return {
    observe: { history: capability.observe.history, follow: capability.observe.follow },
    operations: [...capability.operations],
    ownership: capability.ownership,
    reasoning: capability.reasoning,
    toolDetail: capability.toolDetail,
    promptFidelity: capability.promptFidelity,
    tunables: capability.tunables,
    ...(capability.unavailable === undefined ? {} : { unavailable: capability.unavailable }),
  }
}

/** 失败 agent 的能力文档只能带稳定原因码；detail 留在本机 health。 */
export function unavailableCapability(cause: UnavailableCause): Record<string, unknown> {
  return { unavailable: { adapter: cause.reason } }
}

export interface AgentRegistryOptions {
  readonly now?: () => number
}

export function createAgentRegistry(options: AgentRegistryOptions = {}): AgentRegistry {
  const now = options.now ?? Date.now
  const items = new Map<string, Record_>()

  const healthOf = (agent: string): AgentHealth | undefined => {
    const item = items.get(agent)
    if (item === undefined) return undefined
    return {
      agent,
      runtimeEpoch: item.adapter.runtimeEpoch,
      state: item.state,
      updatedAt: item.updatedAt,
      ...(item.reason === undefined ? {} : { unavailable: item.reason }),
      ...(item.capability === undefined ? {} : { capability: item.capability }),
      ...(item.lastProbe === undefined ? {} : { lastProbe: item.lastProbe }),
    }
  }

  const touch = (agent: string, item: Record_): void => {
    item.updatedAt = now()
    items.set(agent, item)
  }

  return {
    register(adapter: AgentAdapter): void {
      const existing = items.get(adapter.agent)
      if (existing !== undefined) {
        if (existing.adapter === adapter) return
        throw new AgentRegistryError('agent-duplicate', adapter.agent)
      }
      items.set(adapter.agent, {
        adapter,
        state: 'starting',
        reason: undefined,
        capability: undefined,
        lastProbe: undefined,
        updatedAt: now(),
      })
    },

    unregister(agent: string): boolean {
      return items.delete(agent)
    },

    has(agent: string): boolean {
      return items.has(agent)
    },

    get(agent: string): AgentAdapter | undefined {
      return items.get(agent)?.adapter
    },

    list(): readonly string[] {
      return [...items.keys()]
    },

    entries(): readonly AgentEntry[] {
      return [...items.entries()].map(([agent, item]) => ({
        agent,
        runtimeEpoch: item.adapter.runtimeEpoch,
        adapter: item.adapter,
        state: item.state,
        updatedAt: item.updatedAt,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
        ...(item.capability === undefined ? {} : { capability: item.capability }),
        ...(item.lastProbe === undefined ? {} : { lastProbe: item.lastProbe }),
      }))
    },

    health(): readonly AgentHealth[] {
      return [...items.keys()].flatMap(agent => {
        const health = healthOf(agent)
        return health === undefined ? [] : [health]
      })
    },

    healthOf,

    setState(agent: string, state: AgentState, reason?: UnavailableCause): boolean {
      const item = items.get(agent)
      if (item === undefined) return false
      item.state = state
      item.reason = reason
      touch(agent, item)
      return true
    },

    markReady(agent: string, capability?: Capability): boolean {
      const item = items.get(agent)
      if (item === undefined) return false
      item.state = 'ready'
      item.reason = undefined
      if (capability !== undefined) item.capability = capability
      touch(agent, item)
      return true
    },

    markUnavailable(agent: string, cause: UnavailableCause): boolean {
      const item = items.get(agent)
      if (item === undefined) return false
      item.state = 'unavailable'
      item.reason = cause
      touch(agent, item)
      return true
    },

    recordProbe(agent: string, result: ProbeResult): boolean {
      const item = items.get(agent)
      if (item === undefined) return false
      item.lastProbe = result
      if (result.ok) {
        item.state = 'ready'
        item.reason = undefined
        if (result.capability !== undefined) item.capability = result.capability
      } else {
        item.state = 'unavailable'
        item.reason = result.unavailable ?? { reason: 'probe-failed' }
        if (result.capability !== undefined) item.capability = result.capability
      }
      touch(agent, item)
      return true
    },

    recordCapability(agent: string, capability: Capability): boolean {
      const item = items.get(agent)
      if (item === undefined) return false
      item.capability = capability
      touch(agent, item)
      return true
    },

    capabilityDocument(agent: string): SyncCapabilityDocument | undefined {
      const item = items.get(agent)
      if (item?.capability === undefined) return undefined
      return { agent, capability: toCapabilityDocument(item.capability) }
    },
  }
}
