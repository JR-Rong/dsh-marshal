/**
 * 配置持久化。
 *
 * 原生端用 @aparajita/capacitor-secure-storage（iOS Keychain / Android
 * EncryptedSharedPreferences）；浏览器预览用 localStorage，仅用于开发调试。
 */
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { Capacitor } from '@capacitor/core'
import { MOBILE_THEMES, normalizeTheme, parseConfig, type MarshalConfig, type MobileTheme } from './config.ts'

const STORE_KEY = 'dsh-marshal-mobile.config'
const THEME_KEY = 'dsh-marshal-mobile.theme'
const BRIDGE_KEY = 'dsh-marshal-mobile.bridge'
const PIN_KEY = 'dsh-marshal-mobile.pin-guard'

let bridgeMemory: string | null = null

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
    try { raw = webStorage()?.getItem(STORE_KEY) ?? null } catch { return null }
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

let configWrites = Promise.resolve()

function queueConfigWrite(action: () => Promise<void>): Promise<void> {
  const next = configWrites.then(action)
  configWrites = next.catch(() => {})
  return next
}

export function readTheme(config?: MarshalConfig | null): MobileTheme {
  if (config?.theme !== undefined) return normalizeTheme(config.theme)
  let saved: string | null | undefined
  try { saved = webStorage()?.getItem(THEME_KEY) } catch { /* use config */ }
  return MOBILE_THEMES.find((theme) => theme === saved) ?? normalizeTheme(undefined)
}

export function writeTheme(theme: MobileTheme): Promise<void> {
  return queueConfigWrite(async () => {
    // Paired config is authoritative; the non-secret cache is only for early/unpaired preview.
    const config = await readConfig()
    if (config) await storeConfig({ ...config, theme, updatedAt: Date.now() })
    try {
      const storage = webStorage()
      if (!storage) throw new Error('本机存储不可用')
      storage.setItem(THEME_KEY, theme)
    } catch (error) {
      if (!config) throw error
    }
  })
}

export function writeConfig(config: MarshalConfig): Promise<void> {
  return queueConfigWrite(async () => {
    const current = await readConfig()
    await storeConfig({ ...config, theme: readTheme(current?.theme !== undefined ? current : config) })
  })
}

async function storeConfig(config: MarshalConfig): Promise<void> {
  const serialized = JSON.stringify(config)
  if (isNativeRuntime()) {
    await SecureStorage.setItem(STORE_KEY, serialized)
    return
  }
  const storage = webStorage()
  if (!storage) throw new Error('本机存储不可用')
  storage.setItem(STORE_KEY, serialized)
}

async function readSecret(key: string): Promise<string | null> {
  if (isNativeRuntime()) {
    try { return await SecureStorage.getItem(key) } catch { return null }
  }
  return key === BRIDGE_KEY ? bridgeMemory : null
}

async function writeSecret(key: string, value: string | null): Promise<void> {
  if (key === BRIDGE_KEY) bridgeMemory = value
  if (!isNativeRuntime()) return
  if (value === null) {
    try { await SecureStorage.removeItem(key) } catch { /* already gone */ }
    return
  }
  await SecureStorage.setItem(key, value)
}

export async function readBridgeRecord(): Promise<string | null> {
  const value = await readSecret(BRIDGE_KEY)
  bridgeMemory = value
  return value
}

export async function writeBridgeRecord(value: string | null): Promise<void> {
  await writeSecret(BRIDGE_KEY, value)
}

const INSTALL_KEY = 'dsh-marshal-mobile.installation'

export async function installationId(): Promise<string> {
  const existing = isNativeRuntime()
    ? await readSecret(INSTALL_KEY)
    : (() => { try { return window.sessionStorage.getItem(INSTALL_KEY) } catch { return null } })()
  if (existing) return existing
  const created = crypto.randomUUID()
  if (isNativeRuntime()) await writeSecret(INSTALL_KEY, created)
  else { try { window.sessionStorage.setItem(INSTALL_KEY, created) } catch { /* 这一页内仍返回新值 */ } }
  return created
}

export async function readPinGuard(): Promise<string | null> {
  if (isNativeRuntime()) return readSecret(PIN_KEY)
  try { return window.sessionStorage.getItem(PIN_KEY) } catch { return null }
}

export async function writePinGuard(value: string | null): Promise<void> {
  if (isNativeRuntime()) { await writeSecret(PIN_KEY, value); return }
  try {
    if (value === null) window.sessionStorage.removeItem(PIN_KEY)
    else window.sessionStorage.setItem(PIN_KEY, value)
  } catch { /* 浏览器预览记不住也只影响这一页 */ }
}

export function removeConfig(): Promise<void> {
  return queueConfigWrite(clearConfig)
}

async function clearConfig(): Promise<void> {
  if (isNativeRuntime()) {
    try {
      await SecureStorage.removeItem(STORE_KEY)
    } catch {
      /* 已经不存在也视为成功 */
    }
  }
  webStorage()?.removeItem(STORE_KEY)
  webStorage()?.removeItem(THEME_KEY)
}
