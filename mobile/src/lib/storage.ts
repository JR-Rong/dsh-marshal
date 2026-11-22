/**
 * 配置持久化。
 *
 * 原生端用 @aparajita/capacitor-secure-storage（iOS Keychain / Android
 * EncryptedSharedPreferences）；浏览器预览用 localStorage，仅用于开发调试。
 */
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { Capacitor } from '@capacitor/core'
import { MOBILE_THEMES, normalizeTheme, parseConfig, normalizeDailySummaryCapK, tightenPrivacyMode, type MarshalConfig, type MobileTheme } from './config.ts'

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

export type ConfigReadResult = { status: 'ok'; config: MarshalConfig }
  | { status: 'missing' }
  | { status: 'error'; error: ConfigReadError }

export class ConfigReadError extends Error {
  constructor(cause: unknown) {
    super('无法读取本机配置，未覆盖已保存的数据。请恢复本机存储后重试。', { cause })
  }
}

export async function readConfig(): Promise<ConfigReadResult> {
  try {
    let raw = isNativeRuntime() ? await SecureStorage.getItem(STORE_KEY) : null
    // Legacy web fallback is only safe after a confirmed native miss.
    if (raw === null) raw = window.localStorage.getItem(STORE_KEY)
    if (raw === null) return { status: 'missing' }
    const config = parseConfig(JSON.parse(raw))
    if (!config) throw new Error('Invalid config')
    return { status: 'ok', config }
  } catch (error) {
    return { status: 'error', error: new ConfigReadError(error) }
  }
}

let configWrites = Promise.resolve()

function queueConfigWrite<T>(action: () => Promise<T>): Promise<T> {
  const next = configWrites.then(action)
  configWrites = next.then(() => {}, () => {})
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
    const config = await changeConfig(current => current && { ...current, theme, updatedAt: Date.now() })
    try {
      const storage = webStorage()
      if (!storage) throw new Error('本机存储不可用')
      storage.setItem(THEME_KEY, theme)
    } catch (error) {
      if (!config) throw error
    }
  })
}

async function changeConfig<T extends MarshalConfig | null>(change: (current: Readonly<MarshalConfig> | null) => T): Promise<T> {
  const result = await readConfig()
  if (result.status === 'error') throw result.error
  const current = result.status === 'ok' ? result.config : null
  const privacy = current?.privacyMode
  const next = change(current)
  if (next) {
    if (privacy === 'metadata' || next.privacyMode === 'metadata') next.privacyMode = tightenPrivacyMode(privacy)
    await storeConfig(next)
  }
  return next
}

export function updateConfig(change: (current: Readonly<MarshalConfig> | null) => MarshalConfig): Promise<MarshalConfig> {
  return queueConfigWrite(() => changeConfig(current => {
    const next = change(current)
    return { ...next, theme: next.theme ?? readTheme(current) }
  }))
}

export function writeNodePreference(change: { tightenPrivacy: true } | { dailySummaryCapK: number }): Promise<MarshalConfig> {
  return updateConfig(current => {
    if (!current) throw new Error('未找到本机配置')
    return { ...current, updatedAt: Date.now(), ...('tightenPrivacy' in change
      ? { privacyMode: tightenPrivacyMode(current.privacyMode) }
      : { dailySummaryCapK: normalizeDailySummaryCapK(change.dailySummaryCapK) }) }
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
