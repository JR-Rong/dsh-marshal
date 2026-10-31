import { randomUUID } from 'node:crypto'
import type { SyncSnapshot } from '../adapters/types.ts'
import type { LoggerLike } from '../dsh-types.ts'
import { encodeFrame, type EventFrame, type Frame, type SyncAckFrame } from '../wire/frames.ts'
import {
  SYNC_ACK_TIMEOUT_MS, SYNC_SCAN_INTERVAL_MS, SYNC_SCAN_TIMEOUT_MS,
  buildSyncChunks, syncChecksum,
} from '../wire/sync.ts'
import type { NodeLink } from './link.ts'
import type { PrivacyProjector } from './privacy.ts'

export interface NodeSyncOptions {
  readonly link: NodeLink
  readonly adapter: {
    readonly agent: string
    syncSnapshot(signal: AbortSignal): Promise<SyncSnapshot>
  }
  /** hello 声明的全部 agent；空集合也必须显式发送。 */
  readonly agents: readonly string[]
  /** 每次取当前投影器：握手收紧后旧能力行不能继续外发。 */
  readonly projector: () => PrivacyProjector
  /** 已投影并分配公开 seq 的事件出口。 */
  readonly emit: (event: EventFrame) => void
  /** 适配器内部 seq 的帧工厂；投影层会覆盖公开 seq。 */
  readonly frame: (sessionId: string, kind: EventFrame['kind'], payload: unknown) => EventFrame
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
    && (previous.blank ?? false) === (next.blank ?? false)
}

export function createNodeSync(options: NodeSyncOptions): NodeSync {
  const scanMs = Math.max(1, options.scanMs ?? SYNC_SCAN_INTERVAL_MS)
  const scanTimeoutMs = Math.max(1, options.scanTimeoutMs ?? SYNC_SCAN_TIMEOUT_MS)
  const ackTimeoutMs = Math.max(1, options.ackTimeoutMs ?? SYNC_ACK_TIMEOUT_MS)
  const { link, adapter } = options

  let disposed = false
  let infight: Inflight | undefined
  let waiter: Waiter | undefined
  let scanTimer: ReturnType<typeof setInterval> | undefined
  let scanning = false
  let version = 0
  let stale = false
  let stalePublished = false
  /** 最近一次完整提交的会话行与能力文档，扫描只对这些做差分。 */
  let lastRows = new Map<string, Row>()
  let lastCapability: Record<string, unknown> | undefined
  /** 每个会话最近一次增量事件时间；用于阻止旧扫描覆盖更新的运行态/删除。 */
  const lastEventTs = new Map<string, number>()

  const report = (error: unknown): void => {
    const name = error instanceof Error && error.name !== '' ? error.name : 'error'
    options.logger?.warn(`marshal: sync failed: ${name}`)
  }

  /** 采集有硬期限：超过 10s 不求部分结果，直接按 stale 处理。 */
  const gather = async (timeoutMs: number): Promise<SyncSnapshot> => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort()
        reject(SYNC_TIMEOUT)
      }, timeoutMs)
    })
    try {
      return await Promise.race([adapter.syncSnapshot(abort.signal), deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
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

  const publishCapability = (flag: boolean): void => {
    const capability = lastCapability
    if (capability === undefined) return
    const payload = { ...capability, stale: flag }
    for (const row of lastRows.values()) {
      const sessionId = row.sessionId
      if (typeof sessionId !== 'string') continue
      try { options.emit(options.frame(sessionId, 'capability.changed', payload)) } catch (error) { report(error) }
    }
    stalePublished = flag
  }

  const projectRows = (snapshot: SyncSnapshot): Row[] => {
    const projector = options.projector()
    const rows: Row[] = []
    for (const row of snapshot.rows) {
      const projected = projector.syncRow({ ...row, agent: adapter.agent })
      if (projected !== undefined) rows.push(projected)
    }
    for (const item of snapshot.capabilities) {
      const projected = projector.syncRow({
        agent: item.agent,
        capability: { ...item.capability, ...(stale ? { stale: true } : {}) },
      })
      if (projected !== undefined) rows.push(projected)
    }
    return rows
  }

  const waitAck = (syncId: string): Promise<SyncAckFrame> =>
    new Promise<SyncAckFrame>((resolve, reject) => {
      waiter = { syncId, resolve, reject }
      const current = infight
      if (current !== undefined) {
        current.ackTimer = setTimeout(() => {
          waiter = undefined
          reject(SYNC_TIMEOUT)
        }, ackTimeoutMs)
      } else {
        reject(SYNC_TIMEOUT)
      }
    })

  const run = async (syncId: string, flowVersion: number, signal: AbortController): Promise<void> => {
    const snapshot = await gather(scanTimeoutMs)
    if (disposed || signal.signal.aborted || infight?.syncId !== syncId) return
    if (snapshot.completeness !== 'complete') {
      // 分页没有终止证据：不能把残缺清单当全量提交，否则会误删会话。
      fail('sync-incomplete')
      return
    }
    const binding = link.handshake
    if (binding === undefined || link.state !== 'syncing') { fail('sync-incomplete'); return }

    const chunks = buildSyncChunks(projectRows(snapshot))
    const sessions = chunks.flat().filter(isSessionRow)
      .flatMap(row => typeof row.sessionId === 'string' ? [row.sessionId] : [])
    const begin = {
      v: 2 as const, type: 'sync.begin' as const, syncId,
      nodeEpoch: binding.nodeEpoch, connectionId: binding.connectionId,
      scope: { agents: [...options.agents], sessions: [...new Set(sessions)] },
      version: flowVersion, chunkCount: chunks.length,
      highWatermark: options.highWatermark?.() ?? 0,
    }
    try {
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
      if (disposed || infight?.syncId !== syncId) return
      if (!ack.accepted) { fail('sync-rejected'); return }
      if (ack.version !== undefined && ack.version !== flowVersion) { fail('sync-version-mismatch'); return }
      // 提交成功才允许进入 online；此前队列一直关闭。
      const next = new Map<string, Row>()
      for (const row of chunks.flat()) {
        if (isSessionRow(row) && typeof row.sessionId === 'string') next.set(row.sessionId, row)
      }
      lastRows = next
      for (const item of snapshot.capabilities) {
        if (item.agent === adapter.agent) lastCapability = item.capability
      }
      stale = false
      stalePublished = false
      clearAck()
      infight = undefined
      link.confirmSync(syncId)
      startScan()
    } catch (error) {
      if (disposed || infight?.syncId !== syncId) return
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
    void run(syncId, version, abort)
  }

  const scan = async (): Promise<void> => {
    if (disposed || scanning || !link.online) return
    scanning = true
    const scanStartedAt = (options.now ?? Date.now)()
    try {
      const snapshot = await gather(scanTimeoutMs)
      if (disposed || !link.online) return
      if (snapshot.completeness !== 'complete') {
        // 不完整清单不能产生删除/运行态差异；只标 stale。
        if (!stale) { stale = true; if (!stalePublished) publishCapability(true) }
        return
      }
      const next = new Map<string, Row>()
      const projector = options.projector()
      for (const row of snapshot.rows) {
        const projected = projector.syncRow({ ...row, agent: adapter.agent })
        if (projected !== undefined && typeof projected.sessionId === 'string') {
          next.set(projected.sessionId, projected)
        }
      }
      // 先把差异全部算完，再一次性发事件；扫描中断不会产生半套 diff。
      const merged = new Map<string, Row>()
      const changed: Row[] = []
      for (const [sessionId, row] of next) {
        const previous = lastRows.get(sessionId)
        if (previous === undefined) {
          merged.set(sessionId, row)
          changed.push(row)
          continue
        }
        if (sameRow(previous, row)) {
          merged.set(sessionId, previous)
          continue
        }
        const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : 0
        const previousAt = typeof previous.updatedAt === 'number' ? previous.updatedAt : 0
        // 只有快照确实更新时才覆盖；相同或更旧的清单让位给增量。
        if (updatedAt > previousAt) {
          merged.set(sessionId, row)
          changed.push(row)
        } else {
          merged.set(sessionId, previous)
        }
      }
      const removed: string[] = []
      for (const [sessionId, previous] of lastRows) {
        if (next.has(sessionId)) continue
        // 扫描期间到达的增量已证明会话仍存在：旧清单不能覆盖它。
        if ((lastEventTs.get(sessionId) ?? 0) > scanStartedAt) merged.set(sessionId, previous)
        else removed.push(sessionId)
      }
      const capability = snapshot.capabilities.find(item => item.agent === adapter.agent)?.capability
      const capabilityChanged = stableCapability(capability) !== stableCapability(lastCapability)
      for (const sessionId of removed) {
        try { options.emit(options.frame(sessionId, 'session.removed', {})) } catch (error) { report(error) }
      }
      for (const row of changed) {
        const sessionId = row.sessionId
        if (typeof sessionId !== 'string') continue
        try {
          options.emit(options.frame(sessionId, 'session.updated', {
            running: row.running,
            updatedAt: row.updatedAt,
            blank: row.blank,
          }))
        } catch (error) { report(error) }
      }
      lastRows = merged
      if (capability !== undefined) {
        lastCapability = capability
        // readAt 每次扫描都变；只在能力实质变化时广播完整能力快照。
        if (capabilityChanged) {
          const payload = { ...capability, ...(stale ? { stale: true } : {}) }
          for (const sessionId of next.keys()) {
            try { options.emit(options.frame(sessionId, 'capability.changed', payload)) } catch (error) { report(error) }
          }
        }
      }
      if (stale) {
        stale = false
        if (stalePublished) publishCapability(false)
      }
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
    const timer = setInterval(() => { void scan() }, scanMs)
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
      if (event.kind === 'session.updated') {
        const previous = lastRows.get(event.sessionId)
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
        lastRows.set(event.sessionId, merged)
        lastEventTs.set(event.sessionId, at)
        return
      }
      if (event.kind === 'session.removed') {
        lastRows.delete(event.sessionId)
        lastEventTs.set(event.sessionId, at)
        return
      }
      if (event.kind === 'turn.started' || event.kind === 'turn.completed') {
        const previous = lastRows.get(event.sessionId)
        if (previous === undefined) return
        const payload = isRecord(event.payload) ? event.payload : {}
        if (event.kind === 'turn.started') {
          if (previous.running !== true) lastRows.set(event.sessionId, { ...previous, running: true })
        } else {
          // 与 hub 一致：只有非 running 终态才落 running=false，不凭空发明状态。
          const state = typeof payload.state === 'string' ? payload.state : 'completed'
          if (state !== 'running' && previous.running !== false) {
            lastRows.set(event.sessionId, { ...previous, running: false })
          }
        }
        lastEventTs.set(event.sessionId, at)
        return
      }
      if (event.kind === 'capability.changed' && isRecord(event.payload)) {
        const capability = isRecord(event.payload.capability)
          ? event.payload.capability
          : event.payload
        const { stale: _stale, ...rest } = capability
        lastCapability = rest
      }
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
