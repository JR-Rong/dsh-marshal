import {
  type EventFrame, type SyncAckFrame, type SyncBeginFrame, type SyncChunkFrame, type SyncEndFrame,
  type WireErrorCode,
} from '../wire/frames.ts'
import { SYNC_STAGING_DEVICE_MAX_BYTES, SYNC_STAGING_HUB_MAX_BYTES } from '../wire/limits.ts'
import { SYNC_STAGING_TIMEOUT_MS, syncChecksum } from '../wire/sync.ts'
import {
  publicCapability, type CommitRow, type FrameIdentity, type HubRelay,
} from './relay.ts'

/** hub 只需要回 ack 或关闭当前连接；不直接依赖 ws 实现。 */
export interface SyncHost {
  send(frame: SyncAckFrame): void
  close(code: number, reason: string): void
}

export type EventVerdict = 'accept' | 'duplicate' | 'gap' | 'not-online'

export interface DeviceSyncStatus {
  readonly syncing: boolean
  readonly stale: boolean
}

export interface HubSync {
  /** hello 通过后调用：同 epoch 保留旧索引并标 stale，新 epoch 丢弃旧能力。 */
  attach(identity: FrameIdentity, agents: readonly string[]): void
  /** 当前连接断开：释放暂存区，旧索引保留但标记 stale。 */
  detach(identity: FrameIdentity): void
  /** sync.begin/chunk/end；只接受当前连接/代次，且必须按顺序。 */
  onFrame(identity: FrameIdentity, frame: SyncBeginFrame | SyncChunkFrame | SyncEndFrame, host: SyncHost): void
  /** 屏障之后的事件去重；gap 由调用方以 4409 sync-gap 关闭。 */
  acceptEvent(identity: FrameIdentity, event: EventFrame): EventVerdict
  /** 只有收到匹配的 accepted sync.ack 后这里才为 true。 */
  isSynced(identity: FrameIdentity): boolean
  status(deviceId: string): DeviceSyncStatus
  dispose(): void
}

interface DeviceState {
  readonly identity: FrameIdentity
  agents: ReadonlySet<string>
  attached: boolean
  online: boolean
  stale: boolean
}

interface Staging {
  readonly identity: FrameIdentity
  readonly syncId: string
  readonly version: number
  readonly chunkCount: number
  readonly highWatermark: number
  readonly chunks: unknown[][]
  received: number
  bytes: number
  timer: ReturnType<typeof setTimeout>
}

interface ParsedCommit {
  readonly rows: CommitRow[]
  readonly capabilities: Record<string, Record<string, unknown>>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined
}

function safeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function indexCounts(value: unknown): Readonly<Record<string, number>> | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const out: Record<string, number> = {}
  let seen = 0
  for (const [key, item] of Object.entries(record)) {
    if (seen >= 16) break
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0) {
      out[key.slice(0, 32)] = item
      seen += 1
    }
  }
  return seen === 0 ? undefined : out
}

/** 只接受明确枚举的元数据行；任何无法识别的行都让整次提交失败，避免部分替换。 */
function parseCommit(rows: readonly unknown[], agents: ReadonlySet<string>, now: number): ParsedCommit | undefined {
  const out: CommitRow[] = []
  const capabilities: Record<string, Record<string, unknown>> = {}
  for (const raw of rows) {
    const row = asRecord(raw)
    if (row === undefined) return undefined
    if (row.capability !== undefined) {
      const agent = safeString(row.agent, 64)
      const capability = asRecord(row.capability)
      if (agent === undefined || capability === undefined || !agents.has(agent)) return undefined
      const clean = publicCapability(capability)
      if (clean === undefined) return undefined
      capabilities[agent] = clean
      continue
    }
    const sessionId = safeString(row.sessionId, 128)
    const agent = safeString(row.agent, 64)
    if (sessionId === undefined || agent === undefined || !agents.has(agent)) return undefined
    const running = typeof row.running === 'boolean' ? row.running : false
    const updatedAt = safeInt(row.updatedAt) ?? now
    const blank = typeof row.blank === 'boolean' ? row.blank : undefined
    const ownership = safeString(row.ownership, 32)
    const counts = indexCounts(row.counts)
    out.push({
      agent, sessionId, running, updatedAt,
      ...(blank === undefined ? {} : { blank }),
      ...(ownership === undefined ? {} : { ownership }),
      ...(counts === undefined ? {} : { counts }),
    })
  }
  return { rows: out, capabilities }
}

/**
 * 每设备同步协调器：暂存分片、校验预算/校验和，再原子提交到 relay。
 * 失败时只释放暂存区，旧索引保留并标 stale；绝不部分覆盖。
 */
export function createHubSync(options: {
  readonly relay: HubRelay
  readonly now: () => number
  readonly logger?: { warn(message: unknown): void }
  readonly stagingTimeoutMs?: number
  readonly deviceMaxBytes?: number
  readonly hubMaxBytes?: number
}): HubSync {
  const relay = options.relay
  const now = options.now
  const stagingTimeoutMs = Math.max(1, options.stagingTimeoutMs ?? SYNC_STAGING_TIMEOUT_MS)
  const deviceMaxBytes = Math.max(1, options.deviceMaxBytes ?? SYNC_STAGING_DEVICE_MAX_BYTES)
  const hubMaxBytes = Math.max(1, options.hubMaxBytes ?? SYNC_STAGING_HUB_MAX_BYTES)

  const states = new Map<string, DeviceState>()
  const staging = new Map<string, Staging>()
  const versions = new Map<string, number>()
  const lastSeq = new Map<string, number>()
  let hubBytes = 0
  let disposed = false

  const seqPrefix = (deviceId: string): string => `${deviceId}\u0000`
  const versionKey = (identity: FrameIdentity): string =>
    `${identity.deviceId}\u0000${identity.nodeEpoch}`

  const identityMatches = (state: DeviceState | undefined, identity: FrameIdentity): boolean =>
    state !== undefined
    && state.identity.deviceId === identity.deviceId
    && state.identity.connectionId === identity.connectionId
    && state.identity.nodeEpoch === identity.nodeEpoch

  const abortStaging = (deviceId: string): void => {
    const current = staging.get(deviceId)
    if (current === undefined) return
    clearTimeout(current.timer)
    staging.delete(deviceId)
    hubBytes = Math.max(0, hubBytes - current.bytes)
  }

  const markStale = (deviceId: string): void => {
    const state = states.get(deviceId)
    if (state !== undefined) state.stale = true
  }

  const sendAck = (
    host: SyncHost,
    identity: FrameIdentity,
    syncId: string,
    accepted: boolean,
    error?: WireErrorCode,
    version?: number,
  ): void => {
    host.send({
      v: 2, type: 'sync.ack',
      connectionId: identity.connectionId,
      nodeEpoch: identity.nodeEpoch,
      syncId, accepted,
      ...(version === undefined ? {} : { version }),
      ...(error === undefined ? {} : { error }),
    })
  }

  const reject = (
    host: SyncHost,
    identity: FrameIdentity,
    syncId: string,
    error: WireErrorCode,
  ): void => {
    markStale(identity.deviceId)
    sendAck(host, identity, syncId, false, error)
  }

  const expire = (deviceId: string, syncId: string): void => {
    const current = staging.get(deviceId)
    if (current === undefined || current.syncId !== syncId) return
    abortStaging(deviceId)
    markStale(deviceId)
    options.logger?.warn(`marshal: sync-staging-timeout: device ${deviceId}`)
  }

  const begin = (state: DeviceState, identity: FrameIdentity, frame: SyncBeginFrame, host: SyncHost): void => {
    if (staging.has(identity.deviceId)) {
      // 重复 begin：旧暂存与本次都无法证明完整，全部释放。
      abortStaging(identity.deviceId)
      reject(host, identity, frame.syncId, 'invalid')
      return
    }
    if (frame.version < 1) {
      reject(host, identity, frame.syncId, 'invalid')
      return
    }
    const lastVersion = versions.get(versionKey(identity)) ?? 0
    if (frame.version <= lastVersion) {
      reject(host, identity, frame.syncId, 'invalid')
      return
    }
    for (const agent of frame.scope.agents) {
      if (!state.agents.has(agent)) {
        reject(host, identity, frame.syncId, 'invalid')
        return
      }
    }
    // 新的屏障开始即关闭写门：提交失败时旧索引只能 stale 只读，不能继续接命令。
    state.online = false
    state.stale = true
    const timer = setTimeout(() => { expire(identity.deviceId, frame.syncId) }, stagingTimeoutMs)
    timer.unref()
    staging.set(identity.deviceId, {
      identity: { ...identity }, syncId: frame.syncId, version: frame.version,
      chunkCount: frame.chunkCount, highWatermark: frame.highWatermark,
      chunks: [], received: 0, bytes: 0, timer,
    })
  }

  const chunk = (identity: FrameIdentity, frame: SyncChunkFrame, host: SyncHost): void => {
    const current = staging.get(identity.deviceId)
    if (current === undefined || current.syncId !== frame.syncId
      || current.identity.connectionId !== identity.connectionId
      || current.identity.nodeEpoch !== identity.nodeEpoch) {
      if (current !== undefined && current.syncId === frame.syncId) abortStaging(identity.deviceId)
      reject(host, identity, frame.syncId, 'invalid')
      return
    }
    if (frame.total !== current.chunkCount || frame.index !== current.received) {
      abortStaging(identity.deviceId)
      reject(host, identity, frame.syncId, 'invalid')
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify(frame.rows), 'utf8')
    if (current.bytes + bytes > deviceMaxBytes || hubBytes + bytes > hubMaxBytes) {
      abortStaging(identity.deviceId)
      reject(host, identity, frame.syncId, 'size-limit')
      return
    }
    current.chunks.push(frame.rows)
    current.received += 1
    current.bytes += bytes
    hubBytes += bytes
  }

  const end = (state: DeviceState, identity: FrameIdentity, frame: SyncEndFrame, host: SyncHost): void => {
    const current = staging.get(identity.deviceId)
    if (current === undefined || current.syncId !== frame.syncId
      || current.identity.connectionId !== identity.connectionId
      || current.identity.nodeEpoch !== identity.nodeEpoch) {
      if (current !== undefined && current.syncId === frame.syncId) abortStaging(identity.deviceId)
      reject(host, identity, frame.syncId, 'invalid')
      return
    }
    if (current.received !== current.chunkCount) {
      abortStaging(identity.deviceId)
      reject(host, identity, frame.syncId, 'invalid')
      return
    }
    if (frame.checksum === undefined || frame.checksum !== syncChecksum(current.chunks)) {
      abortStaging(identity.deviceId)
      reject(host, identity, frame.syncId, 'readback-mismatch')
      return
    }
    const parsed = parseCommit(current.chunks.flat(), state.agents, now())
    if (parsed === undefined) {
      abortStaging(identity.deviceId)
      reject(host, identity, frame.syncId, 'invalid')
      return
    }
    const committed = relay.commitDevice({
      deviceId: identity.deviceId,
      nodeEpoch: identity.nodeEpoch,
      version: current.version,
      rows: parsed.rows,
      capabilities: parsed.capabilities,
    })
    if (!committed) {
      abortStaging(identity.deviceId)
      reject(host, identity, frame.syncId, 'stale-connection')
      return
    }
    const version = current.version
    abortStaging(identity.deviceId)
    versions.set(versionKey(identity), version)
    state.online = true
    state.stale = false
    sendAck(host, identity, frame.syncId, true, undefined, version)
  }

  return {
    attach(identity, agents) {
      if (disposed) return
      const previous = states.get(identity.deviceId)
      const changedEpoch = previous !== undefined && previous.identity.nodeEpoch !== identity.nodeEpoch
      abortStaging(identity.deviceId)
      if (changedEpoch) {
        // 新 epoch 不与旧 seq 比大小；旧能力立即失效，旧会话行保留到新提交。
        const prefix = seqPrefix(identity.deviceId)
        for (const key of [...lastSeq.keys()]) if (key.startsWith(prefix)) lastSeq.delete(key)
        for (const key of [...versions.keys()]) if (key.startsWith(prefix)) versions.delete(key)
      }
      relay.beginEpoch(identity.deviceId, identity.nodeEpoch)
      states.set(identity.deviceId, {
        identity: { ...identity },
        agents: new Set(agents),
        attached: true,
        online: false,
        // 普通重连也必须重新完成同步；旧数据在提交前一直标记 stale。
        stale: true,
      })
    },

    detach(identity) {
      const state = states.get(identity.deviceId)
      if (!identityMatches(state, identity) || state === undefined) return
      abortStaging(identity.deviceId)
      state.attached = false
      state.online = false
      state.stale = true
    },

    onFrame(identity, frame, host) {
      if (disposed) return
      const state = states.get(identity.deviceId)
      if (!identityMatches(state, identity) || state === undefined || !state.attached) {
        sendAck(host, identity, frame.syncId, false, 'stale-connection')
        return
      }
      switch (frame.type) {
        case 'sync.begin': begin(state, identity, frame, host); return
        case 'sync.chunk': chunk(identity, frame, host); return
        case 'sync.end': end(state, identity, frame, host); return
      }
    },

    acceptEvent(identity, event) {
      const state = states.get(identity.deviceId)
      if (!identityMatches(state, identity) || state?.online !== true) return 'not-online'
      if (event.nodeEpoch !== identity.nodeEpoch) return 'not-online'
      const key = [
        identity.deviceId, event.agent, event.sessionId, identity.nodeEpoch,
      ].join('\u0000')
      const last = lastSeq.get(key)
      if (last !== undefined) {
        if (event.seq <= last) return 'duplicate'
        if (event.seq > last + 1) return 'gap'
      }
      // 首次见到的会话以快照屏障为基线，不把 barrier 之前的 seq 当缺口。
      lastSeq.set(key, event.seq)
      return 'accept'
    },

    isSynced(identity) {
      const state = states.get(identity.deviceId)
      return identityMatches(state, identity) && state?.online === true
    },

    status(deviceId) {
      const state = states.get(deviceId)
      if (state === undefined) return { syncing: false, stale: false }
      return {
        syncing: staging.has(deviceId) || (state.attached && !state.online),
        stale: state.stale,
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const deviceId of [...staging.keys()]) abortStaging(deviceId)
      states.clear()
      lastSeq.clear()
      versions.clear()
      hubBytes = 0
    },
  }
}
