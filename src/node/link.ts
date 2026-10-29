import { WebSocket } from 'ws'
import { encodeFrame, type EventFrame } from '../wire/frames.ts'

/** 断线期间最多缓存多少帧，超出后丢最旧的。 */
const DEFAULT_BUFFER_LIMIT = 1000

/** 重连等待的上限：指数退避在此基础上叠加抖动。 */
const MAX_BACKOFF_MS = 30_000
const BASE_BACKOFF_MS = 500

/** 主动 ping 的间隔；对端连续一个周期没有 pong 就认定连接已死。 */
const DEFAULT_HEARTBEAT_MS = 30_000

export interface NodeLinkOptions {
  readonly url: string
  readonly token: string
  readonly device: string
  readonly agents: readonly string[]
  readonly bufferLimit?: number
  readonly heartbeatMs?: number
  readonly onFrame?: (text: string) => void
  readonly onOnline?: () => void
}

export class NodeLink {
  private socket: WebSocket | undefined
  private readonly queue: string[] = []
  private attempts = 0
  private timer: NodeJS.Timeout | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private closed = false
  private droppedCount = 0

  constructor(private readonly options: NodeLinkOptions) {}

  get buffered(): number { return this.queue.length }
  get dropped(): number { return this.droppedCount }

  start(): void { this.dial() }

  /** 停止拨号与心跳；可重复调用，不会留下定时器或新的重连。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.clearTimer()
    this.stopHeartbeat()
    const socket = this.socket
    this.socket = undefined
    socket?.close()
  }

  /** close 的别名，便于直接当作 dispose 回调。 */
  dispose(): void { this.close() }

  sendEvent(frame: EventFrame): void {
    const text = encodeFrame(frame)
    if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(text); return }
    this.queue.push(text)
    // bufferLimit 可能来自直接构造（不经过配置校验），负值会让下面的 while 无法收敛。
    const limit = Math.max(0, this.options.bufferLimit ?? DEFAULT_BUFFER_LIMIT)
    while (this.queue.length > limit) {
      this.queue.shift()
      this.droppedCount += 1
    }
  }

  private dial(): void {
    if (this.closed) return
    const ws = new WebSocket(this.options.url, { headers: { authorization: `Bearer ${this.options.token}` } })
    this.socket = ws

    ws.on('open', () => {
      this.attempts = 0
      // hello 必须先于任何缓冲事件，hub 只认首帧 hello。
      ws.send(encodeFrame({
        v: 1, type: 'hello', device: this.options.device,
        token: this.options.token, agents: [...this.options.agents],
      }))
      this.flush(ws)
      this.startHeartbeat(ws)
      if (ws.readyState === WebSocket.OPEN) this.options.onOnline?.()
    })
    ws.on('message', data => this.options.onFrame?.(String(data)))
    ws.on('close', () => {
      this.stopHeartbeat()
      // 旧连接迟到的 close 不能抹掉已经换上的新连接。
      if (this.socket === ws) this.socket = undefined
      this.retry()
    })
    ws.on('error', () => { /* close 随后到达，由 close 触发重试 */ })
  }

  /** 只在仍然 OPEN 时发送；没发出去的留在队列里等下一次连接。 */
  private flush(ws: WebSocket): void {
    while (this.queue.length > 0 && ws.readyState === WebSocket.OPEN) {
      const text = this.queue[0]
      if (text === undefined) return
      ws.send(text)
      this.queue.shift()
    }
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

  private retry(): void {
    if (this.closed) return
    const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempts)
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
