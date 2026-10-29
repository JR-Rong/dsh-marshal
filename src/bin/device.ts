#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { mintDevice, type DeviceEntry } from '../hub/devices.ts'

const file = process.env.MARSHAL_DEVICES_FILE ?? `${homedir()}/.dsh-marshal/devices.json`
const [id, name = id] = process.argv.slice(2)
if (id === undefined) {
  console.error('usage: marshal-device <device-id> [display-name]')
  process.exit(1)
}

let devices: DeviceEntry[] = []
try {
  devices = (JSON.parse(readFileSync(file, 'utf8')) as { devices?: DeviceEntry[] }).devices ?? []
} catch { devices = [] }
if (devices.some(device => device.id === id)) {
  console.error(`device ${id} already exists in ${file}`)
  process.exit(1)
}

const entry = mintDevice(id, name ?? id)
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, `${JSON.stringify({ devices: [...devices, entry] }, null, 2)}\n`, { mode: 0o600 })
console.log(`device ${id} added to ${file}`)
console.log(`token (shown once): ${entry.token}`)
