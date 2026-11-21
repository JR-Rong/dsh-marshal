import { randomUUID } from 'node:crypto'
import type { SyncCapabilityDocument, SyncSnapshot } from '../adapters/types.ts'
import type { LoggerLike } from '../dsh-types.ts'
import { encodeFrame, type EventFrame, type Frame, type SyncAckFrame } from '../wire/frames.ts'
import {
  SYNC_ACK_TIMEOUT_MS, SYNC_SCAN_INTERVAL_MS, SYNC_SCAN_TIMEOUT_MS,
  buildSyncChunks, syncChecksum,
} from '../wire/sync.ts'
import type { NodeLink } from './link.ts'
import type { PrivacyProjector } from './privacy.ts'

/** 单个 agent 的同步源；失败只降级该 agent，不影响其它源的采集。 */
export interface NodeSyncSource {
  readonly agent: string
  syncSnapshot(signal: AbortSignal): Promise<SyncSnapshot>
  /** 能力属于具体会话；agent 默认值不能覆盖其所有权或设置回读。 */
  sessionCapability?(sessionId: string): Record<string, unknown>
}

export interface NodeSyncOptions {
  readonly link: NodeLink
  readonly sources: readonly NodeSyncSource[]
  /** hello 声明的全部 agent；空集合也必须显式发送。 */
  readonly agents: readonly string[]
  /** 每个 agent 独立取当前投影器：握手收紧后旧能力行不能继续外发。 */
  readonly projector: (agent: string) => PrivacyProjector
  /** 已投影并分配公开 seq 的事件出口。 */
  readonly emit: (event: EventFrame) => void
  /** 适配器内部 seq 的帧工厂；投影层会覆盖公开 seq。agent 必须来自行本身。 */
  readonly frame: (agent: string, sessionId: string, kind: EventFrame['kind'], payload: unknown) => EventFrame
  /** 公开序列高水位；与快照使用同一序列。 */
  readonly highWatermark?: () => number
  readonly now?: () => number
  readonly scanMs?: number
  readonly scanTimeoutMs?: number
  readonly ackTimeoutMs?: number
  readonly logger?: Pick<LoggerLike, 'warn'>
}

export interface NodeSync {
  /** hello.ack 后启动一次完整同步；同一时间只保留一个在途同步。 */
  begin(): void
  /** 断线/卸载：中止采集、扫描与等待，绝不在旧连接上继续。 */
  abort(): void
  /** index 把已解码的 sync.ack 交给这里；只接受当前在途 syncId。 */
  onFrame(frame: Frame): void
  /** 所有已投影出站事件回灌，扫描据此避免用旧清单覆盖更新的增量状态。 */
  observe(event: EventFrame): void
  readonly stale: boolean
  readonly syncing: boolean
  dispose(): void
}

type Row = Record<string, unknown>

interface Inflight {
  readonly syncId: string
  readonly abort: AbortController
  ackTimer?: ReturnType<typeof setTimeout> | undefined
}

interface Waiter {
  readonly syncId: string
  resolve: (ack: SyncAckFrame) => void
  reject: (error: unknown) => void
}

interface GatheredSource {
  readonly agent: string
  /** 失败（不是整体期限/abort）时为 undefined。 */
  readonly snapshot: SyncSnapshot | undefined
}

interface Gathered {
  readonly sources: readonly GatheredSource[]
  /** 任一源失败或其自身清单不完整。 */
  readonly completeness: 'complete' | 'unconfirmed'
}

interface ProjectedGather {
  readonly rows: readonly Row[]
  readonly capabilities: readonly SyncCapabilityDocument[]
}

const SYNC_TIMEOUT = Symbol('sync-timeout')

function stableCapability(document: Record<string, unknown> | undefined): string {
  if (document === undefined) return ''
  const { readAt: _readAt, stale: _stale, ...rest } = document
  return JSON.stringify(rest)
}

function isSessionRow(row: unknown): row is Row {
  return typeof row === 'object' && row !== null && !Array.isArray(row)
    && typeof (row as Row).sessionId === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameRow(previous: Row | undefined, next: Row): boolean {
  if (previous === undefined) return false
  return previous.running === next.running
    && previous.updatedAt === next.updatedAt
    && previous.title === next.title
    && JSON.stringify(previous.counts ?? {}) === JSON.stringify(next.counts ?? {})
    && (previous.blank ?? false) === (next.blank ?? false)
}

/** 内部键必须带 agent：两个 agent 的同一 sessionId 不是同一个会话。 */
function rowKey(agent: string, sessionId: string): string {
  return `${agent}\u0000${sessionId}`
}

function rowAgent(row: Row): string | undefined {
  return typeof row.agent === 'string' && row.agent !== '' ? row.agent : undefined
}

export function createNodeSync(options: NodeSyncOptions): NodeSync {
  const scanMs = Math.max(1, options.scanMs ?? SYNC_SCAN_INTERVAL_MS)
  const scanTimeoutMs = Math.max(1, options.scanTimeoutMs ?? SYNC_SCAN_TIMEOUT_MS)
  const ackTimeoutMs = Math.max(1, options.ackTimeoutMs ?? SYNC_ACK_TIMEOUT_MS)
  const { link } = options
  const knownAgents = new Set(options.agents)

  let disposed = false
  let infight: Inflight | undefined
  let waiter: Waiter | undefined
  let scanTimer: ReturnType<typeof setInterval> | undefined
  let scanning = false
  let version = 0
  let stale = false
  let stalePublished = false
  const staleAgents = new Set<string>()
  /** 最近一次完整提交的会话行（按 agent+sessionId 键）与逐 agent 能力文档。 */
  let lastRows = new Map<string, Row>()
  const lastCapability = new Map<string, Record<string, unknown>>()
  /** 每个会话最近一次增量事件时间；用于阻止旧扫描覆盖更新的运行态/删除。 */
  const lastEventTs = new Map<string, number>()

  const report = (error: unknown): void => {
    const name = error === SYNC_TIMEOUT
      ? 'sync-timeout'
      : error instanceof Error && error.name !== '' ? error.name : 'error'
    try { options.logger?.warn(`marshal: sync failed: ${name}`) } catch {}
  }

  /** 能力文档只能声明本源 agent 或配置里的 agent；其它名字整份丢弃。 */
  const capabilityAgent = (agent: string, source: string): string | undefined => {
    if (agent === source || knownAgents.has(agent)) return agent
    return undefined
  }

  /**
   * 采集有硬期限：超过 10s 不求部分结果，直接按 SYNC_TIMEOUT 处理。
   * 单个源的异常只把该 agent 标记为不可用，不让其它 agent 一起失败。
   */
  const gather = async (timeoutMs: number, parentSignal?: AbortSignal): Promise<Gathered> => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onParentAbort: (() => void) | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      if (parentSignal?.aborted) {
        abort.abort()
        reject(SYNC_TIMEOUT)
        return
      }
      onParentAbort = () => {
        abort.abort()
        reject(SYNC_TIMEOUT)
      }
      parentSignal?.addEventListener('abort', onParentAbort, { once: true })
      timer = setTimeout(() => {
        abort.abort()
        reject(SYNC_TIMEOUT)
      }, timeoutMs)
    })
    deadline.catch(() => {})
    try {
      const sources = await Promise.race([
        Promise.all(options.sources.map(async (source): Promise<GatheredSource> => {
          try {
            return { agent: source.agent, snapshot: await source.syncSnapshot(abort.signal) }
          } catch {
            return { agent: source.agent, snapshot: undefined }
          }
        })),
        deadline,
      ])
      const completeness = sources.every(item =>
        item.snapshot !== undefined && item.snapshot.completeness === 'complete')
        ? 'complete' as const
        : 'unconfirmed' as const
      return { sources, completeness }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onParentAbort !== undefined) parentSignal?.removeEventListener('abort', onParentAbort)
    }
  }

  const clearScan = (): void => {
    if (scanTimer === undefined) return
    clearInterval(scanTimer)
    scanTimer = undefined
  }

  const clearAck = (): void => {
    const current = infight
    if (current?.ackTimer !== undefined) clearTimeout(current.ackTimer)
    if (current !== undefined) current.ackTimer = undefined
    const pending = waiter
    waiter = undefined
    // abort/失败时让等待者立刻结束；成功路径上 Promise 已 resolve，重复 reject 无副作用。
    pending?.reject(SYNC_TIMEOUT)
  }

  const fail = (reason: string): void => {
    stale = true
    clearAck()
    infight = undefined
    link.rejectSync(reason)
  }

  const emitCapability = (agent: string, sessionId: string, payload: Record<string, unknown>): void => {
    try { options.emit(options.frame(agent, sessionId, 'capability.changed', payload)) } catch (error) { report(error) }
  }

  const sessionCapability = (agent: string, sessionId: string, fallback: Record<string, unknown>): Record<string, unknown> => {
    const source = options.sources.find(item => item.agent === agent)
    try { return source?.sessionCapability?.(sessionId) ?? fallback } catch { return fallback }
  }

  const sessionsOfAgent = (agent: string, rows: ReadonlyMap<string, Row>): string[] => {
    const sessions: string[] = []
    for (const row of rows.values()) {
      if (rowAgent(row) !== agent) continue
      if (typeof row.sessionId === 'string' && row.sessionId !== '') sessions.push(row.sessionId)
    }
    return sessions
  }

  /** 逐 agent 广播 stale；绝不把某个 agent 的能力行发给另一个 agent 的会话。 */
  const publishCapability = (flag: boolean): void => {
    for (const [agent, capability] of lastCapability) {
      for (const sessionId of sessionsOfAgent(agent, lastRows)) {
        emitCapability(agent, sessionId, { ...sessionCapability(agent, sessionId, capability), stale: flag })
      }
    }
    stalePublished = flag
  }

  /**
   * 不完整轮次里只更新失败 agent 的不可用能力；不产生会话删除/运行态差异，
   * 让页面看到“该 agent 当前不可观察”，而不是“会话都被删了”。
   */
  const publishUnavailable = (gathered: Gathered): void => {
    for (const item of gathered.sources) {
      if (item.snapshot !== undefined) continue
      const capability = { unavailable: { adapter: 'capability-unavailable' } }
      const changed = stableCapability(capability) !== stableCapability(lastCapability.get(item.agent))
      lastCapability.set(item.agent, capability)
      if (!changed) continue
      const payload = { ...capability, stale: true }
      for (const sessionId of sessionsOfAgent(item.agent, lastRows)) {
        emitCapability(item.agent, sessionId, payload)
      }
    }
  }

  const projectGathered = (gathered: Gathered): ProjectedGather => {
    const rows: Row[] = []
    const capabilities: SyncCapabilityDocument[] = []
    for (const item of gathered.sources) {
      const projector = options.projector(item.agent)
      const snapshot = item.snapshot
      if (snapshot === undefined) {
        const document: SyncCapabilityDocument = {
          agent: item.agent,
          capability: { unavailable: { adapter: 'capability-unavailable' } },
        }
        capabilities.push(document)
        const projected = projector.syncRow({
          agent: document.agent,
          capability: { ...document.capability, stale: true },
        })
        if (projected !== undefined) rows.push(projected)
        continue
      }
      for (const row of snapshot.rows) {
        // agent 由来源注入，不能相信适配器行里的同名字段。
        const projected = projector.syncRow({ ...row, agent: item.agent })
        if (projected !== undefined) rows.push(projected)
      }
      for (const document of snapshot.capabilities) {
        const agent = capabilityAgent(document.agent, item.agent)
        if (agent === undefined) continue
        capabilities.push({ agent, capability: document.capability })
        const projected = projector.syncRow({
          agent,
          // Fresh snapshots replace pre-disconnect capabilities. The sync ACK
          // barrier, not the previous connection's stale flag, gates writes.
          capability: { ...document.capability },
        })
        if (projected !== undefined) rows.push(projected)
      }
    }
    return { rows, capabilities }
  }

  const waitAck = (syncId: string): Promise<SyncAckFrame> => {
    const promise = new Promise<SyncAckFrame>((resolve, reject) => {
      waiter = { syncId, resolve, reject }
      const current = infight
      if (current !== undefined) {
        current.ackTimer = setTimeout(() => {
          if (waiter?.syncId === syncId) waiter = undefined
          reject(SYNC_TIMEOUT)
        }, ackTimeoutMs)
      } else {
        waiter = undefined
        reject(SYNC_TIMEOUT)
      }
    })
    // Guard against synchronous sendControl failures rejecting ackPromise before `await ackPromise`.
    promise.catch(() => {})
    return promise
  }

  const run = async (syncId: string, flowVersion: number, signal: AbortController): Promise<void> => {
    try {
      const gathered = await gather(scanTimeoutMs, signal.signal)
      if (disposed || signal.signal.aborted || infight?.syncId !== syncId) return
      // 可达源自身列表不完整时仍不能提交，否则会把未列出的会话当成删除。
      // 单源失败不同：该 agent 以不可用能力占位，其它 agent 仍可正常同步。
      const listingIncomplete = gathered.sources.some(item =>
        item.snapshot !== undefined && item.snapshot.completeness !== 'complete')
      if (listingIncomplete) {
        fail('sync-incomplete')
        return
      }
      const binding = link.handshake
      if (binding === undefined || link.state !== 'syncing') { fail('sync-incomplete'); return }

      const projected = projectGathered(gathered)
      const chunks = buildSyncChunks(projected.rows)
      const sessions = chunks.flat().filter(isSessionRow)
        .flatMap(row => typeof row.sessionId === 'string' ? [row.sessionId] : [])
      const begin = {
        v: 2 as const, type: 'sync.begin' as const, syncId,
        nodeEpoch: binding.nodeEpoch, connectionId: binding.connectionId,
        scope: { agents: [...options.agents], sessions: [...new Set(sessions)] },
        version: flowVersion, chunkCount: chunks.length,
        highWatermark: options.highWatermark?.() ?? 0,
      }
      link.sendControl(encodeFrame(begin))
      for (const [index, rows] of chunks.entries()) {
        link.sendControl(encodeFrame({
          v: 2, type: 'sync.chunk', syncId,
          nodeEpoch: binding.nodeEpoch, connectionId: binding.connectionId,
          index, total: chunks.length, rows,
        }))
      }
      const ackPromise = waitAck(syncId)
      link.sendControl(encodeFrame({
        v: 2, type: 'sync.end', syncId,
        nodeEpoch: binding.nodeEpoch, connectionId: binding.connectionId,
        checksum: syncChecksum(chunks),
      }))
      const ack = await ackPromise
      if (disposed || signal.signal.aborted || infight?.syncId !== syncId) return
      if (!ack.accepted) { fail('sync-rejected'); return }
      if (ack.version !== undefined && ack.version !== flowVersion) { fail('sync-version-mismatch'); return }
      // 提交成功才允许进入 online；此前队列一直关闭。
      const next = new Map<string, Row>()
      for (const row of chunks.flat()) {
        if (!isSessionRow(row) || typeof row.sessionId !== 'string') continue
        const agent = rowAgent(row)
        if (agent === undefined) continue
        next.set(rowKey(agent, row.sessionId), row)
      }
      lastRows = next
      for (const document of projected.capabilities) {
        lastCapability.set(document.agent, document.capability)
      }
      stale = false
      stalePublished = false
      staleAgents.clear()
      clearAck()
      infight = undefined
      link.confirmSync(syncId)
      startScan()
    } catch (error) {
      if (disposed || signal.signal.aborted || infight?.syncId !== syncId) return
      // 超时/发送失败/ACK 丢失都不得放开写入。
      if (error === SYNC_TIMEOUT) fail('sync-timeout')
      else { stale = true; clearAck(); infight = undefined; link.rejectSync('sync-failed') }
      report(error)
    }
  }

  const begin = (): void => {
    if (disposed || infight !== undefined) return
    if (link.state !== 'syncing') return
    clearScan()
    version += 1
    const syncId = randomUUID()
    const abort = new AbortController()
    infight = { syncId, abort }
    if (!link.beginSync(syncId)) {
      infight = undefined
      return
    }
    void run(syncId, version, abort).catch(report)
  }

  const scan = async (): Promise<void> => {
    if (disposed || scanning || !link.online) return
    scanning = true
    const scanStartedAt = (options.now ?? Date.now)()
    try {
      const gathered = await gather(scanTimeoutMs)
      if (disposed || !link.online) return
      const unavailable = new Set(gathered.sources.filter(item =>
        item.snapshot === undefined || item.snapshot.completeness !== 'complete').map(item => item.agent))
      for (const agent of unavailable) {
        if (staleAgents.has(agent)) continue
        const fallback = lastCapability.get(agent) ?? {}
        for (const sessionId of sessionsOfAgent(agent, lastRows)) {
          emitCapability(agent, sessionId, { ...sessionCapability(agent, sessionId, fallback), stale: true })
        }
      }
      publishUnavailable(gathered)
      // 不可用源保留自己的旧行；健康源仍正常发现、更新和删除会话。
      const projected = projectGathered({
        sources: gathered.sources.filter(item => !unavailable.has(item.agent)), completeness: 'complete',
      })
      const next = new Map<string, Row>()
      for (const row of projected.rows) {
        if (!isSessionRow(row) || typeof row.sessionId !== 'string') continue
        const agent = rowAgent(row)
        if (agent === undefined) continue
        next.set(rowKey(agent, row.sessionId), row)
      }
      // 先把差异全部算完，再一次性发事件；扫描中断不会产生半套 diff。
      const merged = new Map<string, Row>()
      for (const [key, row] of lastRows) {
        if (unavailable.has(rowAgent(row) ?? '')) merged.set(key, row)
      }
      const changed: Row[] = []
      for (const [key, row] of next) {
        const previous = lastRows.get(key)
        if (previous === undefined) {
          merged.set(key, row)
          changed.push(row)
          continue
        }
        if (sameRow(previous, row)) {
          merged.set(key, previous)
          continue
        }
        const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : 0
        const previousAt = typeof previous.updatedAt === 'number' ? previous.updatedAt : 0
        // DSH updatedAt 是最近输入时间；完成回合未必改变它。等时快照仍可修正运行态，
        // 但扫描开始之后的增量优先，避免迟到清单清掉刚开始的新回合。
        if (updatedAt >= previousAt && (lastEventTs.get(key) ?? -1) < scanStartedAt) {
          merged.set(key, row)
          changed.push(row)
        } else {
          merged.set(key, previous)
        }
      }
      const removed: Row[] = []
      for (const [key, previous] of lastRows) {
        if (unavailable.has(rowAgent(previous) ?? '')) continue
        if (next.has(key)) continue
        // 扫描期间到达的增量已证明会话仍存在：旧清单不能覆盖它。
        if ((lastEventTs.get(key) ?? 0) > scanStartedAt) merged.set(key, previous)
        else removed.push(previous)
      }
      for (const previous of removed) {
        const agent = rowAgent(previous)
        const sessionId = previous.sessionId
        if (agent === undefined || typeof sessionId !== 'string') continue
        try { options.emit(options.frame(agent, sessionId, 'session.removed', {})) } catch (error) { report(error) }
      }
      for (const row of changed) {
        const agent = rowAgent(row)
        const sessionId = row.sessionId
        if (agent === undefined || typeof sessionId !== 'string') continue
        try {
          options.emit(options.frame(agent, sessionId, 'session.updated', {
            running: row.running,
            updatedAt: row.updatedAt,
            blank: row.blank,
            title: row.title,
            counts: row.counts,
          }))
        } catch (error) { report(error) }
      }
      lastRows = merged
      // 能力变更按 agent 独立比较；只扇出该 agent 的会话。
      for (const document of projected.capabilities) {
        const capabilityChanged = stableCapability(document.capability)
          !== stableCapability(lastCapability.get(document.agent))
        lastCapability.set(document.agent, document.capability)
        if (!capabilityChanged && !staleAgents.has(document.agent) && !stalePublished) continue
        for (const sessionId of sessionsOfAgent(document.agent, merged)) {
          emitCapability(document.agent, sessionId, {
            ...sessionCapability(document.agent, sessionId, document.capability), stale: false,
          })
        }
      }
      stale = unavailable.size > 0
      stalePublished = false
      staleAgents.clear()
      for (const agent of unavailable) staleAgents.add(agent)
    } catch (error) {
      stale = true
      if (!stalePublished) publishCapability(true)
      if (error !== SYNC_TIMEOUT) report(error)
    } finally {
      scanning = false
    }
  }

  function startScan(): void {
    clearScan()
    const timer = setInterval(() => { void scan().catch(report) }, scanMs)
    timer.unref()
    scanTimer = timer
  }

  return {
    begin,
    abort(): void {
      const current = infight
      infight = undefined
      current?.abort.abort()
      clearAck()
      clearScan()
      if (!disposed) stale = true
    },
    onFrame(frame: Frame): void {
      if (frame.type !== 'sync.ack') return
      const current = waiter
      if (current === undefined || current.syncId !== frame.syncId) return
      current.resolve(frame)
    },
    observe(event: EventFrame): void {
      if (disposed) return
      const at = (options.now ?? Date.now)()
      const key = rowKey(event.agent, event.sessionId)
      if (event.kind === 'session.updated') {
        const previous = lastRows.get(key)
        const payload = isRecord(event.payload) ? event.payload : {}
        // 事件可省略字段：保留最近一次已知值，不能把 unknown 变成 false/0。
        const merged: Row = {
          ...(previous ?? {}),
          sessionId: event.sessionId,
          agent: event.agent,
        }
        if (payload.running !== undefined) merged.running = payload.running
        if (payload.updatedAt !== undefined) merged.updatedAt = payload.updatedAt
        if (payload.blank !== undefined) merged.blank = payload.blank
        if (payload.title !== undefined) merged.title = payload.title
        if (payload.counts !== undefined) merged.counts = payload.counts
        lastRows.set(key, merged)
        lastEventTs.set(key, at)
        return
      }
      if (event.kind === 'session.removed') {
        lastRows.delete(key)
        lastEventTs.set(key, at)
        return
      }
      if (event.kind === 'turn.started' || event.kind === 'turn.completed') {
        const previous = lastRows.get(key)
        if (previous === undefined) return
        const payload = isRecord(event.payload) ? event.payload : {}
        if (event.kind === 'turn.started') {
          if (previous.running !== true) lastRows.set(key, { ...previous, running: true })
        } else {
          // 与 hub 一致：只有非 running 终态才落 running=false，不凭空发明状态。
          const state = typeof payload.state === 'string' ? payload.state : 'completed'
          if (state !== 'running' && previous.running !== false) {
            lastRows.set(key, { ...previous, running: false })
          }
        }
        lastEventTs.set(key, at)
        return
      }
      // capability.changed 始终绑定会话；agent 清单的比较基线只由 syncSnapshot 更新。
    },
    get stale(): boolean { return stale },
    get syncing(): boolean { return infight !== undefined },
    dispose(): void {
      if (disposed) return
      disposed = true
      const current = infight
      infight = undefined
      current?.abort.abort()
      clearAck()
      clearScan()
    },
  }
}
