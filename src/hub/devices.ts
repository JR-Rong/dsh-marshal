import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

export interface DeviceEntry { readonly id: string; readonly name: string; readonly token: string }

export function loadDevices(path: string): DeviceEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const list = typeof parsed === 'object' && parsed !== null
      ? (parsed as { devices?: unknown }).devices
      : undefined
    if (!Array.isArray(list)) return []
    // 缺字段的条目会让握手阶段的 sha256(undefined) 直接抛错，加载时先剔掉。
    return list.filter((item): item is DeviceEntry =>
      typeof item === 'object' && item !== null
      && typeof (item as { id?: unknown }).id === 'string'
      && typeof (item as { name?: unknown }).name === 'string'
      && typeof (item as { token?: unknown }).token === 'string')
  } catch { return [] }
}

export function findByToken(devices: readonly DeviceEntry[], token: string): DeviceEntry | undefined {
  return devices.find(entry => entry.token === token)
}

/** 供 `marshal-device` CLI（Task 14）使用。 */
export function mintDevice(id: string, name: string): DeviceEntry {
  return { id, name, token: randomBytes(24).toString('base64url') }
}
