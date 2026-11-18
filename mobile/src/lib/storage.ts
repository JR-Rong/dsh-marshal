/**
 * 配置持久化。
 *
 * 原生端用 @aparajita/capacitor-secure-storage（iOS Keychain / Android
 * EncryptedSharedPreferences）；浏览器预览用 localStorage，仅用于开发调试。
 */
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { Capacitor } from '@capacitor/core'
import { parseConfig, type MarshalConfig } from './config.ts'

const STORE_KEY = 'dsh-marshal-mobile.config'

export function isNativeRuntime(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

function webStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export async function readConfig(): Promise<MarshalConfig | null> {
  let raw: string | null = null
  if (isNativeRuntime()) {
    try {
      raw = await SecureStorage.getItem(STORE_KEY)
    } catch {
      raw = null
    }
  }
  if (raw === null) {
    const fallback = webStorage()
    raw = fallback ? fallback.getItem(STORE_KEY) : null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return parseConfig(parsed)
}

export async function writeConfig(config: MarshalConfig): Promise<void> {
  const serialized = JSON.stringify(config)
  if (isNativeRuntime()) {
    await SecureStorage.setItem(STORE_KEY, serialized)
    return
  }
  const storage = webStorage()
  if (!storage) throw new Error('本机存储不可用')
  storage.setItem(STORE_KEY, serialized)
}

export async function removeConfig(): Promise<void> {
  if (isNativeRuntime()) {
    try {
      await SecureStorage.removeItem(STORE_KEY)
    } catch {
      /* 已经不存在也视为成功 */
    }
  }
  webStorage()?.removeItem(STORE_KEY)
}
