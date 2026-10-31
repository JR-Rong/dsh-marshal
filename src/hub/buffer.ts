/**
 * hub 侧有界历史 EventBuffer（V1-T08）。
 *
 * 只缓存允许回放的 kind；`input.requested`/`input.resolved` 与载荷里出现的
 * 交互、审批、答案、密钥键一律拒收，避免结构化派生副本绕过 kind 白名单。
 *
 * 存储按 hub 接收顺序排列：全局数组保存连续游标 `n`（1 起），`head` 前移到
 * 最旧存活项，压缩时才丢弃 tombstone；每个会话另有一条只存游标号的 FIFO，
 * 淘汰不会扫描全局数组，也不会重复序列化事件。所有读取/计数/追加都先按
 * 接收时间清理过期项，事件自身的 `ts` 不参与保留窗计算。
 */

import { MARSHAL_KINDS, type EventFrame, type MarshalKind } from '../wire/frames.ts'

export const BUFFER_SESSION_EVENT_MAX = 2_000
export const BUFFER_SESSION_BYTES_MAX = 8 * 1024 * 1024
export const BUFFER_HUB_BYTES_MAX = 64 * 1024 * 1024
export const BUFFER_TTL_MS = 15 * 60 * 1000
/** 单次 read 的条数上限。 */
export const BUFFER_REPLAY_MAX = 1_000
/** 单次 read 的字节上限。 */
export const BUFFER_REPLAY_BYTES_MAX = 4 * 1024 * 1024

const NON_CACHEABLE_KINDS: ReadonlySet<MarshalKind> = new Set([
  'input.requested',
  'input.resolved',
])

/** 允许进入历史的 kind 白名单；与 MARSHAL_KINDS 保持同步。 */
export const CACHEABLE_KINDS: ReadonlySet<MarshalKind> = new Set(
  MARSHAL_KINDS.filter((kind) => !NON_CACHEABLE_KINDS.has(kind)),
)

export function isCacheableKind(kind: string): kind is MarshalKind {
  return CACHEABLE_KINDS.has(kind as MarshalKind)
}

const CURSOR_INDEX = /^(0|[1-9][0-9]*)$/

/**
 * 解析 `${hubEpoch}:${n}`。epoch 不匹配、格式非法、负数、非整数或超出安全
 * 整数范围都返回 undefined，调用方按未知游标（gap/reset）处理。
 */
export function parseBufferCursor(cursor: string, hubEpoch: string): number | undefined {
  const prefix = `${hubEpoch}:`
  if (!cursor.startsWith(prefix)) return undefined
  const text = cursor.slice(prefix.length)
  if (!CURSOR_INDEX.test(text)) return undefined
  const n = Number(text)
  if (!Number.isSafeInteger(n) || n < 0) return undefined
  return n
}

export interface BufferedEvent {
  readonly cursor: string
  readonly event: EventFrame
  readonly receivedAt: number
  readonly bytes: number
}

export interface BufferAppendResult {
  readonly accepted: boolean
  /** 仅 accepted 时给出。 */
  readonly cursor?: string
  /** 本次 append 触发的淘汰条数（含入口处的过期清理）。 */
  readonly dropped: number
}

export interface BufferReadResult {
  readonly events: readonly BufferedEvent[]
  /** 读完后的高水位，可直接回给客户端。 */
  readonly cursor: string
  /** 请求游标已过期/未知/跨 epoch/超出高水位。 */
  readonly gap: boolean
  /** 累计已淘汰条数（>= 缺口数量），用于报告回放缺口。 */
  readonly dropped: number
  /** 到达条数/字节预算而截断。 */
  readonly truncated: boolean
}

export interface BufferSize {
  readonly events: number
  readonly bytes: number
  readonly sessions: number
}

export interface EventBufferOptions {
  readonly hubEpoch: string
  readonly now?: () => number
  readonly sessionEventMax?: number
  readonly sessionBytesMax?: number
  readonly hubBytesMax?: number
  readonly ttlMs?: number
  readonly replayMax?: number
  readonly replayBytesMax?: number
}

export interface EventBuffer {
  /** 非法 kind/信封/载荷或已 dispose 时 accepted=false，不分配游标。 */
  append(event: EventFrame): BufferAppendResult
  /** cursor 省略 = 从当前高水位之后（只用于 live 对齐，不重放）；有 cursor 则返回其后事件。 */
  read(cursor: string | undefined): BufferReadResult
  /** 先 evict 过期项。 */
  size(): BufferSize
  /** 当前高水位游标；空缓冲为 `${hubEpoch}:0`。 */
  cursor(): string
  /** 内容授权收紧：删除该设备全部缓存事件，返回删除条数。 */
  purgeDevice(deviceId: string): number
  clear(): void
  dispose(): void
}

const FORBIDDEN_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'secret',
  'answer',
  'answers',
  'selectedOptionIds',
  'decisions',
  'questions',
  'approval',
])

const PAYLOAD_MAX_DEPTH = 4
const PAYLOAD_MAX_KEYS = 64
/** 会话 FIFO / 全局数组的惰性压缩阈值。 */
const COMPACT_MIN = 1_024

interface BufferedEntry {
  readonly n: number
  readonly cursor: string
  readonly deviceId: string
  readonly sessionKey: string
  readonly receivedAt: number
  readonly bytes: number
  /** 淘汰后置空，压缩时丢弃，避免辅助索引继续持有大对象。 */
  event: EventFrame | null
}

interface SessionState {
  readonly key: string
  head: number
  ns: number[]
  count: number
  bytes: number
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * 扫描 payload 的键。深度超过上限、单层对象键数超过上限、或出现交互/答案/
 * 密钥键即不安全；`text` 不在禁用列表内，`message.delta`/`tool.output` 正常。
 */
function isSafePayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return true
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: payload, depth: 0 },
  ]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    const item = current.value
    if (item === null || typeof item !== 'object') continue
    if (current.depth > PAYLOAD_MAX_DEPTH) return false
    const keys = Object.keys(item)
    if (!Array.isArray(item) && keys.length > PAYLOAD_MAX_KEYS) return false
    for (const key of keys) {
      if (FORBIDDEN_PAYLOAD_KEYS.has(key)) return false
      const child: unknown = (item as Record<string, unknown>)[key]
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child, depth: current.depth + 1 })
      }
    }
  }
  return true
}

function isCacheableEvent(value: unknown): value is EventFrame {
  if (!isPlainRecord(value)) return false
  if (value.v !== 2 || value.type !== 'event') return false
  if (!isNonEmptyString(value.deviceId)) return false
  if (!isNonEmptyString(value.agent)) return false
  if (!isNonEmptyString(value.sessionId)) return false
  if (!isNonEmptyString(value.nodeEpoch)) return false
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 0) return false
  if (typeof value.ts !== 'number' || !Number.isFinite(value.ts) || value.ts < 0) return false
  if (typeof value.kind !== 'string' || !isCacheableKind(value.kind)) return false
  if (!Object.hasOwn(value, 'payload') || value.payload === undefined) return false
  return isSafePayload(value.payload)
}

class HubEventBuffer implements EventBuffer {
  private readonly hubEpoch: string
  private readonly clock: () => number
  private readonly sessionEventMax: number
  private readonly sessionBytesMax: number
  private readonly hubBytesMax: number
  private readonly ttlMs: number
  private readonly replayMax: number
  private readonly replayBytesMax: number

  private entries: BufferedEntry[] = []
  /** entries 中第一个仍可能存活（或尚未压缩的 tombstone）的下标。 */
  private head = 0
  /** entries[0] 对应的游标号；entries 为空时等于 nextN。 */
  private baseN = 1
  /** 下一个可分配的游标号。clear/dispose 也不回退，避免旧游标复用。 */
  private nextN = 1
  /** 已淘汰的最高游标号；严格小于它的请求游标必定有缺口。 */
  private evictedMax = 0
  /** clear 明确的失效边界（含）；旧游标即使等于边界也必须 reset。 */
  private purgedThrough = -1
  private droppedTotal = 0
  private hubBytes = 0
  private liveCount = 0
  private lastReceivedAt = Number.NEGATIVE_INFINITY
  private readonly sessions = new Map<string, SessionState>()
  private disposed = false

  constructor(options: EventBufferOptions) {
    this.hubEpoch = options.hubEpoch
    this.clock = options.now ?? (() => Date.now())
    this.sessionEventMax = options.sessionEventMax ?? BUFFER_SESSION_EVENT_MAX
    this.sessionBytesMax = options.sessionBytesMax ?? BUFFER_SESSION_BYTES_MAX
    this.hubBytesMax = options.hubBytesMax ?? BUFFER_HUB_BYTES_MAX
    this.ttlMs = options.ttlMs ?? BUFFER_TTL_MS
    this.replayMax = options.replayMax ?? BUFFER_REPLAY_MAX
    this.replayBytesMax = options.replayBytesMax ?? BUFFER_REPLAY_BYTES_MAX
  }

  append(event: EventFrame): BufferAppendResult {
    if (this.disposed) return { accepted: false, dropped: 0 }
    const now = this.clock()
    const startDropped = this.droppedTotal
    this.evictExpired(now)

    const raw: unknown = event
    let valid = false
    try {
      valid = isCacheableEvent(raw)
    } catch {
      valid = false
    }
    if (!valid) return { accepted: false, dropped: this.droppedTotal - startDropped }

    let bytes: number
    try {
      // 每次 append 只序列化一次，仅用于计算字节数；缓存保留原对象引用。
      const text = JSON.stringify(event)
      if (typeof text !== 'string') {
        return { accepted: false, dropped: this.droppedTotal - startDropped }
      }
      bytes = Buffer.byteLength(text, 'utf8')
    } catch {
      return { accepted: false, dropped: this.droppedTotal - startDropped }
    }

    const n = this.nextN
    this.nextN += 1
    const cursor = `${this.hubEpoch}:${n}`
    if (this.head >= this.entries.length) {
      // 没有可复用的槽位（全部已淘汰/尚未压缩），直接从新的基址开始。
      this.entries = []
      this.head = 0
      this.baseN = n
    }
    const receivedAt = Math.max(now, this.lastReceivedAt)
    this.lastReceivedAt = receivedAt
    const sessionKey = `${event.deviceId}\u0000${event.agent}\u0000${event.sessionId}`
    const entry: BufferedEntry = {
      n, cursor, deviceId: event.deviceId, sessionKey, receivedAt, bytes, event,
    }
    this.entries.push(entry)

    let session = this.sessions.get(sessionKey)
    if (session === undefined) {
      session = { key: sessionKey, head: 0, ns: [], count: 0, bytes: 0 }
      this.sessions.set(sessionKey, session)
    }
    session.ns.push(n)
    session.count += 1
    session.bytes += bytes
    this.liveCount += 1
    this.hubBytes += bytes

    while (session.count > this.sessionEventMax || session.bytes > this.sessionBytesMax) {
      if (!this.evictSessionOldest(session)) break
    }
    while (this.hubBytes > this.hubBytesMax) {
      if (!this.evictGlobalOldest()) break
    }
    this.compact()

    return { accepted: true, cursor, dropped: this.droppedTotal - startDropped }
  }

  read(cursor: string | undefined): BufferReadResult {
    if (this.disposed) {
      return {
        events: [], cursor: `${this.hubEpoch}:0`, gap: true,
        dropped: this.droppedTotal, truncated: false,
      }
    }
    this.evictExpired(this.clock())

    const lastAssigned = this.nextN - 1
    const current = this.displayCursor()
    let requestN: number
    if (cursor === undefined) {
      // 只做 live 对齐：不重放任何历史。
      requestN = lastAssigned
    } else {
      const parsed = parseBufferCursor(cursor, this.hubEpoch)
      if (
        parsed === undefined
        || parsed < this.evictedMax
        || parsed <= this.purgedThrough
        || parsed > lastAssigned
      ) {
        return {
          events: [], cursor: current, gap: true,
          dropped: this.droppedTotal, truncated: false,
        }
      }
      requestN = parsed
    }

    const events: BufferedEvent[] = []
    let bytes = 0
    let truncated = false
    for (let n = requestN + 1; n <= lastAssigned; n += 1) {
      const entry = this.entryAt(n)
      if (entry === undefined || entry.event === null) {
        // 游标校验保证其后的号段没有空洞；防御性转为 reset，避免静默丢内容。
        return {
          events: [], cursor: current, gap: true,
          dropped: this.droppedTotal, truncated: false,
        }
      }
      if (events.length >= this.replayMax || bytes + entry.bytes > this.replayBytesMax) {
        truncated = true
        break
      }
      const event = entry.event
      events.push({
        cursor: entry.cursor, event, receivedAt: entry.receivedAt, bytes: entry.bytes,
      })
      bytes += entry.bytes
    }

    const last = events[events.length - 1]
    let resultCursor: string
    if (last !== undefined) resultCursor = last.cursor
    else if (cursor !== undefined) resultCursor = `${this.hubEpoch}:${requestN}`
    else resultCursor = current

    return {
      events, cursor: resultCursor, gap: false,
      dropped: this.droppedTotal, truncated,
    }
  }

  size(): BufferSize {
    if (this.disposed) return { events: 0, bytes: 0, sessions: 0 }
    this.evictExpired(this.clock())
    return { events: this.liveCount, bytes: this.hubBytes, sessions: this.sessions.size }
  }

  cursor(): string {
    if (this.disposed) return `${this.hubEpoch}:0`
    this.evictExpired(this.clock())
    return this.displayCursor()
  }

  purgeDevice(deviceId: string): number {
    if (this.disposed || deviceId.length === 0) return 0
    this.evictExpired(this.clock())
    let deleted = 0
    // 内容授权收紧是低频管理操作；这里允许一次顺序扫描，不暴露为读取 API。
    for (let index = this.head; index < this.entries.length; index += 1) {
      const entry = this.entries[index]
      if (entry === undefined || entry.event === null) continue
      if (entry.deviceId !== deviceId) continue
      this.evictEntry(entry)
      deleted += 1
    }
    this.compact()
    return deleted
  }

  clear(): void {
    if (this.disposed) return
    this.evictExpired(this.clock())
    const lastAssigned = this.nextN - 1
    this.droppedTotal += this.liveCount
    if (lastAssigned > this.evictedMax) this.evictedMax = lastAssigned
    if (lastAssigned > 0 && lastAssigned > this.purgedThrough) {
      this.purgedThrough = lastAssigned
    }
    this.entries = []
    this.head = 0
    this.baseN = this.nextN
    this.sessions.clear()
    this.liveCount = 0
    this.hubBytes = 0
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.entries = []
    this.head = 0
    this.baseN = this.nextN
    this.sessions.clear()
    this.liveCount = 0
    this.hubBytes = 0
  }

  private displayCursor(): string {
    if (this.liveCount === 0) return `${this.hubEpoch}:0`
    return `${this.hubEpoch}:${this.nextN - 1}`
  }

  private entryAt(n: number): BufferedEntry | undefined {
    const index = n - this.baseN
    if (index < 0 || index >= this.entries.length) return undefined
    return this.entries[index]
  }

  private advanceHead(): void {
    while (this.head < this.entries.length) {
      const entry = this.entries[this.head]
      if (entry !== undefined && entry.event !== null) return
      this.head += 1
    }
  }

  /** 按接收时间从全局头部清理到期项；没有新 append 也会执行。 */
  private evictExpired(now: number): void {
    for (;;) {
      this.advanceHead()
      const entry = this.entries[this.head]
      if (entry === undefined) break
      if (now - entry.receivedAt < this.ttlMs) break
      this.evictEntry(entry)
    }
    this.compact()
  }

  /** 淘汰会话最旧项；返回 false 表示队列已空。 */
  private evictSessionOldest(session: SessionState): boolean {
    while (session.head < session.ns.length) {
      const n = session.ns[session.head]
      if (n === undefined) {
        session.head += 1
        continue
      }
      const entry = this.entryAt(n)
      if (entry === undefined || entry.event === null) {
        session.head += 1
        continue
      }
      this.evictEntry(entry)
      return true
    }
    return false
  }

  /** 淘汰全局最旧存活项；返回 false 表示缓冲已空。 */
  private evictGlobalOldest(): boolean {
    this.advanceHead()
    const entry = this.entries[this.head]
    if (entry === undefined || entry.event === null) return false
    this.evictEntry(entry)
    return true
  }

  /**
   * 唯一淘汰入口：清空事件引用、扣减全局/会话计数，并把游标号从会话 FIFO
   * 头部移除。调用方保证该事件是所属会话的最旧存活项。
   */
  private evictEntry(entry: BufferedEntry): void {
    if (entry.event === null) return
    entry.event = null
    this.liveCount -= 1
    this.hubBytes -= entry.bytes
    this.droppedTotal += 1
    if (entry.n > this.evictedMax) this.evictedMax = entry.n

    const session = this.sessions.get(entry.sessionKey)
    if (session === undefined) return
    if (session.ns[session.head] === entry.n) {
      session.head += 1
      session.count -= 1
      session.bytes -= entry.bytes
      if (session.count <= 0) {
        this.sessions.delete(entry.sessionKey)
      } else if (session.head > COMPACT_MIN && session.head * 2 >= session.ns.length) {
        session.ns = session.ns.slice(session.head)
        session.head = 0
      }
      return
    }
    // 正常路径不会到达：会话 FIFO 与全局接收顺序一致，待淘汰项必在队首。
    // 防御性移除，保证异常输入下索引也不会泄漏引用。
    const index = session.ns.indexOf(entry.n, session.head)
    if (index < 0) return
    session.ns.splice(index, 1)
    session.count -= 1
    session.bytes -= entry.bytes
    if (session.count <= 0) this.sessions.delete(entry.sessionKey)
  }

  /** 丢弃头部 tombstone；只在超过阈值时复制数组，避免每条事件都 splice。 */
  private compact(): void {
    if (this.head >= this.entries.length) {
      if (this.entries.length > 0) {
        this.entries = []
        this.head = 0
        this.baseN = this.nextN
      }
      return
    }
    if (this.head > COMPACT_MIN && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head)
      const first = this.entries[0]
      this.baseN = first === undefined ? this.nextN : first.n
      this.head = 0
    }
  }
}

export function createEventBuffer(options: EventBufferOptions): EventBuffer {
  return new HubEventBuffer(options)
}
