/**
 * SSE 通道。
 *
 * 原生端走本地插件 marshal-stream（iOS URLSession / Android HttpURLConnection），
 * 绕开 WebView 的同源限制；浏览器预览退化为 EventSource（仅用于开发调试）。
 */
import { Capacitor } from '@capacitor/core'
import { MarshalStream } from 'marshal-stream'

export interface StreamFrame {
  /** SSE 事件名：message（默认）/ reset / error */
  event: string
  data: unknown
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
}

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

  if (!isNative()) {
    // 浏览器里没有原生通道，只能靠同源/CORS；测试时会注入假 EventSource。
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

  const start = async (): Promise<void> => {
    if (closed) return
    handle = await MarshalStream.addListener('message', (message) => {
      if (message.event === 'error') {
        onError?.(message.data)
        scheduleReconnect()
        return
      }
      onFrame({ event: message.event || 'message', data: parseData(message.data) })
    })
    await MarshalStream.open({ url, token })
  }

  const scheduleReconnect = (): void => {
    if (closed || !reconnect) return
    attempt += 1
    const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5))
    retryTimer = setTimeout(() => {
      void (async () => {
        try {
          await handle?.remove()
          await MarshalStream.close()
        } catch {
          /* 清干净即可 */
        }
        await start()
      })()
    }, delay)
  }

  await start()

  return {
    close() {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      void handle?.remove()
      void MarshalStream.close()
    },
  }
}
