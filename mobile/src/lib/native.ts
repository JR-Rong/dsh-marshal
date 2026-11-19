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

/** 深链 marshal://open?hub=...；返回取消函数。 */
export async function watchDeepLinks(onUrl: (url: string) => void): Promise<() => void> {
  if (!inNativeShell()) return () => undefined
  try {
    const { App } = await import('@capacitor/app')
    const handle = await App.addListener('appUrlOpen', (event) => {
      if (typeof event.url === 'string') onUrl(event.url)
    })
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

/** 打开系统浏览器。壳内不导航到外部页面。 */
export async function openExternal(url: string): Promise<void> {
  if (inNativeShell()) {
    try {
      const { Browser } = await import('@capacitor/browser')
      await Browser.open({ url })
      return
    } catch {
      /* 插件缺失时退回系统打开 */
    }
  }
  window.open(url, '_blank', 'noopener')
}

/** 前后台切换。浏览器预览用页面可见性近似。 */
export async function watchAppState(onChange: (active: boolean) => void): Promise<() => void> {
  if (!inNativeShell()) {
    const handler = (): void => { onChange(document.visibilityState !== 'hidden') }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }
  try {
    const { App } = await import('@capacitor/app')
    const handle = await App.addListener('appStateChange', (next) => { onChange(next.isActive) })
    return () => { void handle.remove() }
  } catch {
    return () => undefined
  }
}

/** 震动反馈（可选，浏览器里静默跳过）。 */
export function vibrate(): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(8)
  } catch {
    /* 设备不支持就算了 */
  }
}
