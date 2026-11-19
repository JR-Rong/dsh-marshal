/**
 * SSE 通道。
 *
 * 原生端走本地插件 marshal-stream（iOS URLSession / Android HttpURLConnection），
 * 绕开 WebView 的同源限制；浏览器预览退化为 EventSource（仅用于开发调试）。
 */
import { Capacitor } from '@capacitor/core'
import { MarshalStream } from 'marshal-stream'
import { nextResumeCursor, noteStreamDrop, noteStreamOpen, shouldReconnectStream } from './stream.ts'

export interface StreamFrame {
  /** SSE 事件名：message（默认）/ reset / error */
  event: string
  data: unknown
  id?: string
}

export interface StreamHandle {
  close(): void
}

export interface StreamOptions {
  url: string
  token: string
  onFrame: (frame: StreamFrame) => void
  onError?: (message: string) => void
  /** 断开后是否自动重连，默认 true。 */
  reconnect?: boolean
  /** 多路流各自的 id。缺省时自动分配，互不影响。 */
  id?: string
}

let streamSerial = 0

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

function parseData(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export async function openEventStream(options: StreamOptions): Promise<StreamHandle> {
  const { url, token, onFrame, onError, reconnect = true } = options
  const id = options.id ?? 's' + String(++streamSerial)

  if (!isNative()) {
    const source = new EventSource(url)
    const forward = (event: string) => (message: MessageEvent) => {
      onFrame({ event, data: parseData(String(message.data)) })
    }
    source.onmessage = forward('message')
    source.addEventListener('reset', forward('reset'))
    source.onerror = () => onError?.('SSE 断开')
    return { close: () => source.close() }
  }

  let closed = false
  let handle: { remove: () => Promise<void> } | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let lastEventId: string | null = null

  const start = async (): Promise<void> => {
    if (closed) return
    handle = await MarshalStream.addListener('message', (message) => {
      if (message.streamId && message.streamId !== id) return
      if (message.event === 'open') {
        attempt = noteStreamOpen()
        return
      }
      if (shouldReconnectStream({ event: message.event, closed, reconnect })) {
        if (message.event === 'error') onError?.(message.data || 'SSE 断开')
        scheduleReconnect()
        return
      }
      const frame: StreamFrame = {
        event: message.event || 'message',
        data: parseData(message.data),
        ...(message.id ? { id: message.id } : {}),
      }
      lastEventId = nextResumeCursor(lastEventId, frame)
      onFrame(frame)
    })
    await MarshalStream.open({
      url,
      token,
      id,
      ...(lastEventId ? { lastEventId } : {}),
    })
  }

  const scheduleReconnect = (): void => {
    if (!shouldReconnectStream({ event: 'end', closed, reconnect }) || retryTimer) return
    const next = noteStreamDrop(attempt)
    attempt = next.attempt
    retryTimer = setTimeout(() => {
      retryTimer = null
      void (async () => {
        try {
          await handle?.remove()
          await MarshalStream.close({ id })
        } catch {
          /* 清干净即可 */
        }
        await start()
      })()
    }, next.delayMs)
  }

  await start()

  return {
    close() {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      void handle?.remove()
      void MarshalStream.close({ id })
    },
  }
}
