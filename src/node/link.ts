import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { CONTRACT_REVISION, CLOSE_CODES, encodeFrame, type EventFrame } from '../wire/frames.ts'
import { OFFLINE_QUEUE_MAX_BYTES, OFFLINE_QUEUE_MAX_ITEMS } from '../wire/limits.ts'

/** 断线期间最多缓存多少帧，超出后丢最旧的。 */
const DEFAULT_BUFFER_LIMIT = OFFLINE_QUEUE_MAX_ITEMS

/** 断线缓存的字节上限：1000 个 1 MiB 帧会吃掉 1 GiB，必须再按体积封顶。 */
const DEFAULT_BUFFER_BYTES = OFFLINE_QUEUE_MAX_BYTES

/** 重连等待的上限：指数退避在此基础上叠加抖动。 */
const MAX_BACKOFF_MS = 30_000
const BASE_BACKOFF_MS = 500

/** 主动 ping 的间隔；对端连续一个周期没有 pong 就认定连接已死。 */
const DEFAULT_HEARTBEAT_MS = 30_000

/** 连接稳定这么久之后把退避计数清零，避免偶发一次断线就让下次重连等满上限。 */
const STABLE_RESET_MS = 30_000

/**
 * 终态：重拨不会成功，停下等显式 start()。
 * 4400 也是终态：帧/协议不匹配是配置错误，重拨只会无限循环。
 * 4409（连接被同设备新连接替换）可重试：下一次拨号会拿到新的槽位。
 */
const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([4400, 4401, 4403, 4406, 4408])

/** 运行实例 epoch：进程内共享，普通网络重连不变。 */
export const NODE_EPOCH = randomUUID()

/** hub 收到 hello 后回的确认帧：只有它到达才算握手完成。 */
const HELLO_ACK_TYPE = 'hello.ack'

export interface NodeLinkOptions {
  readonly url: string
  readonly token: string
  readonly deviceId: string
  readonly deviceName: string
  readonly agents: readonly string[]
  readonly bufferLimit?: number
  /** 断线缓存的总字节上限，默认 8 MiB。 */
  readonly maxBufferedBytes?: number
  readonly heartbeatMs?: number
  /** 重连退避上限，默认 30s；主要给测试缩短等待。 */
  readonly maxBackoffMs?: number
  /** 连接稳定多久后清零退避计数，默认 30s。 */
  readonly stableMs?: number
  readonly onFrame?: (text: string) => void
  readonly onOnline?: () => void
  /** onFrame 或底层 socket 抛错时的可选出口；不传就静默，绝不外抛。 */
  readonly onError?: (error: unknown) => void
}

export class NodeLink {
  private socket: WebSocket | undefined
  private readonly queue: string[] = []
  private queueBytes = 0
  /** hello.ack 之前就到的下行帧：握手确认后再按序交给 onFrame。 */
  private readonly pendingInbound: string[] = []
  private pendingBytes = 0
  private attempts = 0
  private timer: NodeJS.Timeout | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private stableTimer: NodeJS.Timeout | undefined
  /** 显式 close/dispose 之后不再拨号；这是终态。 */
  private closed = false
  /** 是否希望保持连接：4401 后清零进 stopped，但 start() 能重新拉起。 */
  private active = false
  /** 当前连接是否已经收到 hello.ack。 */
  private acked = false
  private droppedCount = 0

  constructor(private readonly options: NodeLinkOptions) {}

  get buffered(): number { return this.queue.length }
  get dropped(): number { return this.droppedCount }

  /** 幂等：已连接、连接中或正在等待重连时都不会再拨号。 */
  start(): void {
    if (this.closed) return
    this.active = true
    if (this.socket !== undefined || this.timer !== undefined) return
    this.dial()
  }

  /** 停止拨号与心跳；可重复调用，不会留下定时器或新的重连。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.active = false
    this.clearTimer()
    this.clearStableTimer()
    this.stopHeartbeat()
    this.pendingInbound.length = 0
    this.pendingBytes = 0
    this.queue.length = 0
    this.queueBytes = 0
    this.acked = false
    const socket = this.socket
    this.socket = undefined
    socket?.close()
  }

  /** close 的别名，便于直接当作 dispose 回调。 */
  dispose(): void { this.close() }

  sendRaw(text: string): void {
    // 关掉之后没有消费者了；再排队只会把快照/尾巴事件永久攒在内存里。
    if (this.closed) return
    // 握手完成且没有更早的积压帧时才直发，否则排队，避免越过队首。
    if (this.acked && this.queue.length === 0 && this.socket !== undefined && this.trySend(this.socket, text)) return
    this.enqueue(text)
  }

  sendEvent(frame: EventFrame): void { this.sendRaw(encodeFrame(frame)) }

  private enqueue(text: string): void {
    this.queue.push(text)
    this.queueBytes += Buffer.byteLength(text, 'utf8')
    const limit = this.limit()
    const bytes = this.limitBytes()
    while (this.queue.length > limit || this.queueBytes > bytes) {
      const dropped = this.queue.shift()
      if (dropped === undefined) break
      this.queueBytes = Math.max(0, this.queueBytes - Buffer.byteLength(dropped, 'utf8'))
      this.droppedCount += 1
    }
  }

  private limit(): number {
    // bufferLimit 可能来自直接构造（不经过配置校验），负值会让下面的 while 无法收敛。
    return Math.max(0, this.options.bufferLimit ?? DEFAULT_BUFFER_LIMIT)
  }

  private limitBytes(): number {
    return Math.max(0, this.options.maxBufferedBytes ?? DEFAULT_BUFFER_BYTES)
  }

  private dial(): void {
    if (this.closed || !this.active) return
    // 任何时刻只允许一个 socket：定时器与手动 start 撞车也在这里拦住。
    if (this.socket !== undefined) return
    const ws = new WebSocket(this.options.url, { headers: { authorization: `Bearer ${this.options.token}` } })
    this.socket = ws
    this.acked = false

    ws.on('open', () => {
      if (this.socket !== ws) { ws.close(); return }
      // hello 必须先于任何缓冲事件，hub 只认首帧 hello；它发不出去就换一条连接。
      const hello = encodeFrame({
        v: 2, type: 'hello', contractRevision: CONTRACT_REVISION,
        deviceId: this.options.deviceId, deviceName: this.options.deviceName,
        nodeEpoch: NODE_EPOCH, agents: [...this.options.agents], features: [],
      })
      if (!this.trySend(ws, hello)) { ws.close(); return }
      this.startHeartbeat(ws)
      // 不在 socket open 时报告在线：只有合法 hello.ack 才代表握手完成。
    })
    ws.on('message', data => this.receive(ws, String(data)))
    ws.on('close', (code: number) => {
      // 迟到的 close 属于已被替换的旧连接：它只负责自己，不碰新连接的心跳、定时器和 socket。
      if (this.socket !== ws) return
      this.socket = undefined
      this.acked = false
      this.pendingInbound.length = 0
      this.pendingBytes = 0
      this.stopHeartbeat()
      this.clearStableTimer()
      if (this.closed) return
      if (TERMINAL_CLOSE_CODES.has(code)) {
        // 鉴权/撤销/协议不兼容重拨没有意义：停下进 stopped，等显式 start()。
        this.active = false
        this.attempts = 0
        this.clearTimer()
        this.reportError(new Error(`marshal: link closed with terminal code ${code}`))
        return
      }
      this.retry()
    })
    ws.on('error', error => {
      // close 随后到达并触发重试；这里只把原因交给可选回调，不让它变成 uncaught。
      if (this.socket === ws) this.reportError(error)
    })
    // hub 在升级前用 401 表示设备 token 不对；这不是暂时故障，重拨只会一直失败。
    ws.on('unexpected-response', (_request, response) => {
      response.resume()
      if (this.socket !== ws) return
      this.socket = undefined
      this.acked = false
      this.pendingInbound.length = 0
      this.pendingBytes = 0
      this.stopHeartbeat()
      this.clearStableTimer()
      if (this.closed) return
      if (response.statusCode === 401) {
        this.active = false
        this.attempts = 0
        this.clearTimer()
        this.reportError(new Error('marshal: hub rejected device token (401)'))
        return
      }
      this.retry()
    })
  }

  private receive(ws: WebSocket, text: string): void {
    if (this.socket !== ws) return
    if (this.acked) { this.deliver(text); return }
    const ack = this.helloAckOf(text)
    if (ack === 'valid') {
      this.acked = true
      this.startStableTimer(ws)
      const pending = this.pendingInbound.splice(0)
      this.pendingBytes = 0
      for (const buffered of pending) this.deliver(buffered)
      this.flush(ws)
      // 只有合法 hello.ack 之后才算在线；同步由上层在 onOnline 里发起。
      try { this.options.onOnline?.() } catch (error) { this.reportError(error) }
      return
    }
    if (ack !== 'none') {
      // 设备/实例或契约修订不匹配时握手永远无法完成：直接按终态关闭。
      ws.close(
        ack === 'version' ? CLOSE_CODES.VERSION_UNSUPPORTED : CLOSE_CODES.DEVICE_MISMATCH,
        ack === 'version' ? 'version-unsupported' : 'device-mismatch',
      )
      return
    }
    // ack 之前 hub 不该下发业务帧；先攒着，确认握手后按原序放行。
    this.pendingInbound.push(text)
    this.pendingBytes += Buffer.byteLength(text, 'utf8')
    const limit = this.limit()
    const bytes = this.limitBytes()
    while (this.pendingInbound.length > limit || this.pendingBytes > bytes) {
      const dropped = this.pendingInbound.shift()
      if (dropped === undefined) break
      this.pendingBytes = Math.max(0, this.pendingBytes - Buffer.byteLength(dropped, 'utf8'))
      this.droppedCount += 1
    }
  }

  /** 只有 type/设备/实例/契约修订全部匹配的 hello.ack 才能完成握手。 */
  private helloAckOf(text: string): 'valid' | 'version' | 'identity' | 'none' {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) return 'none'
      const frame = parsed as {
        type?: unknown
        v?: unknown
        deviceId?: unknown
        nodeEpoch?: unknown
        contractRevision?: unknown
      }
      if (frame.type !== HELLO_ACK_TYPE) return 'none'
      if (frame.v !== 2 || frame.contractRevision !== CONTRACT_REVISION) return 'version'
      if (frame.deviceId !== this.options.deviceId || frame.nodeEpoch !== NODE_EPOCH) return 'identity'
      return 'valid'
    } catch { return 'none' }
  }

  /**
   * 只在握手完成且仍然 OPEN 时发送；任何一帧发不出去就停下，
   * 该帧留在队首，等下一次连接补发，不会被算成已发。
   */
  private flush(ws: WebSocket): void {
    if (this.socket !== ws || !this.acked) return
    while (this.queue.length > 0) {
      const text = this.queue[0]
      if (text === undefined) return
      if (!this.trySend(ws, text)) return
      this.queue.shift()
      this.queueBytes = Math.max(0, this.queueBytes - Buffer.byteLength(text, 'utf8'))
    }
  }

  /** send 在 CLOSING/CLOSED 上可能同步抛错，这里统一吞成 false。 */
  private trySend(ws: WebSocket, text: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    try { ws.send(text); return true } catch { return false }
  }

  private deliver(text: string): void {
    const onFrame = this.options.onFrame
    if (onFrame === undefined) return
    // 上层回调的异常不能变成 uncaught，更不能打断后续帧。
    try { onFrame(text) } catch (error) { this.reportError(error) }
  }

  private reportError(error: unknown): void {
    try { this.options.onError?.(error) } catch { /* onError 自己抛错也不再外抛 */ }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat()
    let alive = true
    ws.on('pong', () => { alive = true })
    const interval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (!alive) { ws.terminate(); return }
      alive = false
      ws.ping()
    }, this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
    // 不因为心跳定时器拖住进程退出。
    interval.unref()
    this.heartbeat = interval
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === undefined) return
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  /** 稳定超过 stableMs 才清零退避；连接一断该定时器随 close 一起清掉。 */
  private startStableTimer(ws: WebSocket): void {
    this.clearStableTimer()
    const timer = setTimeout(() => {
      this.stableTimer = undefined
      if (this.socket === ws && this.acked) this.attempts = 0
    }, this.options.stableMs ?? STABLE_RESET_MS)
    timer.unref()
    this.stableTimer = timer
  }

  private clearStableTimer(): void {
    if (this.stableTimer === undefined) return
    clearTimeout(this.stableTimer)
    this.stableTimer = undefined
  }

  private retry(): void {
    if (this.closed || !this.active) return
    const max = Math.max(0, this.options.maxBackoffMs ?? MAX_BACKOFF_MS)
    const base = Math.min(max, BASE_BACKOFF_MS * 2 ** this.attempts)
    const delay = base * (0.5 + Math.random() / 2)
    this.attempts += 1
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.dial()
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
