/**
 * 原生能力封装。所有调用都在浏览器预览里安全降级，方便用无头浏览器验收 UI。
 */
import { Capacitor } from '@capacitor/core'

export function inNativeShell(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

/** 状态栏、启动图等壳层初始化。失败不阻塞业务。 */
export async function setupChrome(): Promise<void> {
  if (!inNativeShell()) return
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    await StatusBar.setStyle({ style: Style.Dark })
    if (Capacitor.getPlatform() === 'android') await StatusBar.setBackgroundColor({ color: '#151719' })
  } catch {
    /* 插件缺失不致命 */
  }
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen')
    await SplashScreen.hide()
  } catch {
    /* 同上 */
  }
  try {
    const { Keyboard } = await import('@capacitor/keyboard')
    await Keyboard.setResizeMode({ mode: 'body' as never })
  } catch {
    /* 同上 */
  }
}

/** 网络状态监听；返回取消函数。 */
export async function watchNetwork(onChange: (online: boolean) => void): Promise<() => void> {
  if (!inNativeShell()) {
    const handler = () => onChange(navigator.onLine)
    window.addEventListener('online', handler)
    window.addEventListener('offline', handler)
    return () => {
      window.removeEventListener('online', handler)
      window.removeEventListener('offline', handler)
    }
  }
  try {
    const { Network } = await import('@capacitor/network')
    const status = await Network.getStatus()
    onChange(status.connected)
    const handle = await Network.addListener('networkStatusChange', (next) => onChange(next.connected))
    return () => {
      void handle.remove()
    }
  } catch {
    return () => undefined
  }
}

/**
 * 深链 marshal://open?hub=...&ticket=...；返回取消函数。
 * 冷启动时 appUrlOpen 可能早于监听器注册，补一次 getLaunchUrl，并按 URL 去重。
 */
export async function watchDeepLinks(onUrl: (url: string) => void): Promise<() => void> {
  if (!inNativeShell()) return () => undefined
  try {
    const { App } = await import('@capacitor/app')
    let lastUrl = ''
    const emit = (url: string): void => {
      if (!url || url === lastUrl) return
      lastUrl = url
      onUrl(url)
    }
    const handle = await App.addListener('appUrlOpen', (event) => {
      if (typeof event.url === 'string') emit(event.url)
    })
    void App.getLaunchUrl().then((launch) => {
      if (launch && typeof launch.url === 'string') emit(launch.url)
    }).catch(() => { /* 没有启动 URL 就算了 */ })
    return () => {
      void handle.remove()
    }
  } catch {
    return () => undefined
  }
}

/** 硬件返回键；只有外壳自己消费时才调用 onConsume 返回 true。 */
export async function watchBackButton(onConsume: () => boolean): Promise<() => void> {
  if (!inNativeShell()) return () => undefined
  try {
    const { App } = await import('@capacitor/app')
    const handle = await App.addListener('backButton', () => {
      onConsume()
    })
    return () => {
      void handle.remove()
    }
  } catch {
    return () => undefined
  }
}

/**
 * 进入调度官控制台。
 *
 * 与浏览器版加载同一个 Hub 页面：会话续跑、提问、审批、讨论群聊、控制项、
 * 历史与上传全部由 Hub 页面提供，手机端不做任何服务端逻辑。
 */
export function enterConsole(url: string): void {
  window.location.assign(url)
}

/** 退出应用（Android 返回键在首页时使用）。 */
export async function exitApp(): Promise<void> {
  if (!inNativeShell()) return
  try {
    const { App } = await import('@capacitor/app')
    await App.exitApp()
  } catch {
    /* 浏览器预览里什么都不做 */
  }
}

/** 打开系统浏览器（用于「在浏览器中打开」，例如排障）。 */
export async function openExternal(url: string): Promise<void> {
  // 原生壳里直接交给系统浏览器；Capacitor 的 App 插件没有 openUrl。
  window.open(url, '_blank', 'noopener')
}

/** 震动反馈（可选，浏览器里静默跳过）。 */
export function vibrate(): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(8)
  } catch {
    /* 设备不支持就算了 */
  }
}
