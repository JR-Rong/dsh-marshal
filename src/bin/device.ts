#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { mintDevice, type DeviceEntry } from '../hub/devices.ts'

const file = process.env.MARSHAL_DEVICES_FILE ?? `${homedir()}/.dsh-marshal/devices.json`
const [rawId, rawName] = process.argv.slice(2)
if (rawId === undefined || rawId === '-h' || rawId === '--help') {
  console.error('usage: marshal-device <device-id> [display-name]')
  process.exit(rawId === undefined ? 1 : 0)
}
const id = rawId.trim()
if (id === '') {
  console.error('marshal-device: device id must not be blank')
  process.exit(1)
}
const name = rawName?.trim() || id

let devices: DeviceEntry[] = []
try {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const list = typeof parsed === 'object' && parsed !== null
    ? (parsed as { devices?: unknown }).devices
    : undefined
  if (!Array.isArray(list)) {
    // 文件存在但结构不对时绝不能当成空表重写：那会静默丢掉所有已签发的 token。
    console.error(`marshal-device: ${file} has no devices array`)
    process.exit(1)
  }
  devices = list.filter((item): item is DeviceEntry =>
    typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error(`marshal-device: cannot read ${file}: ${(error as Error).message}`)
    process.exit(1)
  }
}
if (devices.some(device => device.id === id)) {
  console.error(`device ${id} already exists in ${file}`)
  process.exit(1)
}

const entry = mintDevice(id, name)
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, `${JSON.stringify({ devices: [...devices, entry] }, null, 2)}\n`, { mode: 0o600 })
// mode 只在创建时生效；已存在的文件也要收紧，避免 token 留在 0644。
chmodSync(file, 0o600)
console.log(`device ${id} added to ${file}`)
console.log(`token (shown once): ${entry.token}`)
