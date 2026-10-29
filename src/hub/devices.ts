import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

export interface DeviceEntry { readonly id: string; readonly name: string; readonly token: string }

export function loadDevices(path: string): DeviceEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { devices?: DeviceEntry[] }
    return parsed.devices ?? []
  } catch { return [] }
}

export function findByToken(devices: readonly DeviceEntry[], token: string): DeviceEntry | undefined {
  return devices.find(entry => entry.token === token)
}

/** 供 `marshal-device` CLI（Task 14）使用。 */
export function mintDevice(id: string, name: string): DeviceEntry {
  return { id, name, token: randomBytes(24).toString('base64url') }
}
