import { homedir } from 'node:os'

export type Role = 'hub' | 'node'
export type Privacy = 'metadata' | 'content'
export type Relay = 'off' | 'remote'

export interface MarshalConfig {
  readonly role: Role
  readonly hubUrl?: string
  readonly token?: string
  readonly dashboardToken?: string
  readonly deviceName: string
  readonly privacy: Privacy
  readonly questionRelay: Relay
  readonly answerTimeoutMs: number
  readonly approvalRelay: Relay
  readonly ringBufferMinutes: number
  readonly redaction: readonly string[]
  readonly devicesFile: string
}

function requireString(raw: Record<string, unknown>, key: string, missing: string[]): string | undefined {
  const value = raw[key]
  if (value === undefined) { missing.push(key); return undefined }
  if (typeof value !== 'string') throw new Error(`marshal: config.${key} must be a non-empty string`)
  if (value.trim() === '') { missing.push(key); return undefined }
  return value.trim()
}

function parseHubUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('marshal: config.hubUrl is not a valid ws(s) URL')
  }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.hostname === '') {
    throw new Error('marshal: config.hubUrl is not a valid ws(s) URL')
  }
  return value
}

function parsePrivacy(raw: unknown): Privacy {
  if (raw === undefined) return 'metadata'
  if (raw !== 'metadata' && raw !== 'content') throw new Error('marshal: config.privacy must be "metadata" or "content"')
  return raw
}

function parseRelay(raw: unknown, key: string): Relay {
  if (raw === undefined) return 'off'
  if (raw !== 'off' && raw !== 'remote') throw new Error(`marshal: config.${key} must be "off" or "remote"`)
  return raw
}

function parsePositiveInteger(raw: unknown, key: string, fallback: number): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`marshal: config.${key} must be a positive integer`)
  }
  return raw
}

function parseRedaction(raw: unknown): readonly string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('marshal: config.redaction must be an array of strings')
  return raw.map((source, index): string => {
    if (typeof source !== 'string') throw new Error(`marshal: config.redaction[${index}] must be a string`)
    try {
      new RegExp(source, 'gi')
    } catch {
      throw new Error(`marshal: config.redaction[${index}] is not a valid RegExp`)
    }
    return source
  })
}

function parseDeviceName(raw: unknown, hostname: string): string {
  if (raw === undefined) return hostname
  if (typeof raw !== 'string') throw new Error('marshal: config.deviceName must be a non-empty string')
  const value = raw.trim()
  return value === '' ? hostname : value
}

function parseDevicesFile(raw: unknown): string {
  // 与 marshal-device CLI 使用同一个解析方式，避免 HOME 缺失时两边落到不同路径。
  if (raw === undefined) return `${homedir()}/.dsh-marshal/devices.json`
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('marshal: config.devicesFile must be a non-empty string')
  return raw
}

export function parseConfig(raw: unknown, hostname: string): MarshalConfig {
  if (raw === null || typeof raw !== 'object') throw new Error('marshal: config must be an object')
  const input = raw as Record<string, unknown>
  const role = input.role
  if (role !== 'hub' && role !== 'node') throw new Error('marshal: config.role must be "hub" or "node"')

  const missing: string[] = []
  let hubUrl: string | undefined
  let token: string | undefined
  let dashboardToken: string | undefined
  if (role === 'node') {
    hubUrl = requireString(input, 'hubUrl', missing)
    token = requireString(input, 'token', missing)
    if (missing.length > 0) throw new Error(`marshal: node config is missing ${missing.join(', ')}`)
    hubUrl = parseHubUrl(hubUrl!)
    if (token!.length < 16) throw new Error('marshal: config.token must be at least 16 characters')
  } else {
    dashboardToken = requireString(input, 'dashboardToken', missing)
    if (missing.length > 0) throw new Error(`marshal: hub config is missing ${missing.join(', ')}`)
    if (dashboardToken!.length < 16) throw new Error('marshal: config.dashboardToken must be at least 16 characters')
  }

  const privacy = parsePrivacy(input.privacy)
  const answerTimeoutMs = parsePositiveInteger(input.answerTimeoutMs, 'answerTimeoutMs', 300_000)
  const deviceName = parseDeviceName(input.deviceName, hostname)
  const questionRelay = parseRelay(input.questionRelay, 'questionRelay')
  const approvalRelay = parseRelay(input.approvalRelay, 'approvalRelay')
  const ringBufferMinutes = parsePositiveInteger(input.ringBufferMinutes, 'ringBufferMinutes', 15)
  const redaction = parseRedaction(input.redaction)
  const devicesFile = parseDevicesFile(input.devicesFile)

  return {
    role,
    ...(hubUrl === undefined ? {} : { hubUrl }),
    ...(token === undefined ? {} : { token }),
    ...(dashboardToken === undefined ? {} : { dashboardToken }),
    deviceName,
    privacy,
    questionRelay,
    answerTimeoutMs,
    approvalRelay,
    ringBufferMinutes,
    redaction,
    devicesFile,
  }
}
