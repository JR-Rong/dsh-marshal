import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export type Role = 'hub' | 'node'
export type Privacy = 'metadata' | 'content'
export type Relay = 'off' | 'notify' | 'remote'

export interface MarshalConfig {
  readonly role: Role
  readonly hubUrl?: string
  readonly token?: string
  readonly deviceId?: string
  readonly deviceName: string
  readonly dashboardToken?: string
  readonly publicOrigin?: string
  readonly privacy: Privacy
  readonly questionRelay: Relay
  readonly approvalRelay: Relay
  readonly answerTimeoutMs: number
  readonly approvalTimeoutMs: number
  readonly agents: readonly string[]
  readonly codexExecutable?: string
  readonly claudeExecutable?: string
  readonly ringBufferMinutes: number
  readonly redaction: readonly string[]
  readonly allowDiscussion: boolean
  readonly devicesFile: string
}

const KNOWN_KEYS = new Set([
  'role', 'hubUrl', 'token', 'deviceId', 'deviceName', 'dashboardToken', 'publicOrigin',
  'privacy', 'questionRelay', 'approvalRelay', 'answerTimeoutMs', 'approvalTimeoutMs',
  'agents', 'codexExecutable', 'claudeExecutable', 'ringBufferMinutes', 'redaction',
  'allowDiscussion', 'devicesFile',
])

const WEAK_DASHBOARD_TOKENS = new Set([
  'changeme', 'password', 'letmein', 'test', 'secret', 'admin', 'dsh-marshal',
])

const DEFAULT_DEVICES_FILE = join(homedir(), '.dsh-marshal', 'devices.json')
const DEFAULT_AGENTS = ['dsh'] as const

function rejectUnknownKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`marshal: config.${key} is unknown`)
  }
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
    throw new Error('marshal: config.hubUrl must be a wss:// URL')
  }
  // 契约 §3：明文 hub 连接一律拒绝，生产也不允许跳过证书验证。
  if (url.protocol !== 'wss:' || url.hostname === '') {
    throw new Error('marshal: config.hubUrl must be a wss:// URL')
  }
  return value
}

function parsePublicOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('marshal: config.publicOrigin must be an HTTPS origin')
  }
  if (url.protocol !== 'https:') throw new Error('marshal: config.publicOrigin must use https')
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new Error('marshal: config.publicOrigin must not include a path')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('marshal: config.publicOrigin must not include a query or hash')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('marshal: config.publicOrigin must not include credentials')
  }
  if (url.origin !== value) {
    throw new Error('marshal: config.publicOrigin must be a bare origin without a trailing slash')
  }
  return value
}

function parseDashboardToken(value: string): string {
  if (value.length < 32) throw new Error('marshal: config.dashboardToken must be at least 32 characters')
  if (/^(.)\1*$/.test(value)) {
    throw new Error('marshal: config.dashboardToken must not repeat a single character')
  }
  const lowered = value.toLowerCase()
  for (const weak of WEAK_DASHBOARD_TOKENS) {
    if (lowered.includes(weak)) throw new Error('marshal: config.dashboardToken is a known weak value')
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
  if (raw !== 'off' && raw !== 'notify' && raw !== 'remote') {
    throw new Error(`marshal: config.${key} must be "off", "notify" or "remote"`)
  }
  return raw
}

function parseInteger(raw: unknown, key: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`marshal: config.${key} must be an integer between ${min} and ${max}`)
  }
  return raw
}

function parseRedaction(raw: unknown): readonly string[] {
  if (raw === undefined) return Object.freeze([])
  if (!Array.isArray(raw)) throw new Error('marshal: config.redaction must be an array of strings')
  const patterns = raw.map((source, index): string => {
    if (typeof source !== 'string') throw new Error(`marshal: config.redaction[${index}] must be a string`)
    try {
      new RegExp(source, 'gi')
    } catch {
      throw new Error(`marshal: config.redaction[${index}] is not a valid RegExp`)
    }
    return source
  })
  return Object.freeze(patterns)
}

function parseAgents(raw: unknown): readonly string[] {
  if (raw === undefined) return Object.freeze([...DEFAULT_AGENTS])
  if (!Array.isArray(raw)) throw new Error('marshal: config.agents must be an array of strings')
  if (raw.length === 0) throw new Error('marshal: config.agents must list at least one agent')
  const agents: string[] = []
  const seen = new Set<string>()
  raw.forEach((value, index) => {
    if (typeof value !== 'string') throw new Error(`marshal: config.agents[${index}] must be a string`)
    const agent = value.trim()
    if (agent === '') throw new Error(`marshal: config.agents[${index}] must be a non-empty string`)
    if (seen.has(agent)) throw new Error(`marshal: config.agents[${index}] duplicates "${agent}"`)
    seen.add(agent)
    agents.push(agent)
  })
  return Object.freeze(agents)
}

function parseOptionalExecutable(raw: unknown, key: string): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`marshal: config.${key} must be a non-empty string`)
  }
  return raw.trim()
}

function parseBoolean(raw: unknown, key: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (typeof raw !== 'boolean') throw new Error(`marshal: config.${key} must be a boolean`)
  return raw
}

function parseDeviceName(raw: unknown, hostname: string): string {
  if (raw === undefined) return hostname
  if (typeof raw !== 'string') throw new Error('marshal: config.deviceName must be a non-empty string')
  const value = raw.trim()
  return value === '' ? hostname : value
}

function parseDevicesFile(raw: unknown): string {
  // 与 marshal-device CLI 使用同一个解析方式，避免 HOME 缺失时两边落到不同路径。
  if (raw === undefined) return DEFAULT_DEVICES_FILE
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('marshal: config.devicesFile must be a non-empty absolute path')
  }
  const value = raw.trim()
  if (value.startsWith('~')) throw new Error('marshal: config.devicesFile must not use a literal "~"')
  if (!isAbsolute(value)) throw new Error('marshal: config.devicesFile must be an absolute path')
  return value
}

export function parseConfig(raw: unknown, hostname: string): MarshalConfig {
  if (raw === null || typeof raw !== 'object') throw new Error('marshal: config must be an object')
  const input = raw as Record<string, unknown>
  const role = input.role
  if (role !== 'hub' && role !== 'node') throw new Error('marshal: config.role must be "hub" or "node"')
  rejectUnknownKeys(input)

  const missing: string[] = []
  let hubUrl: string | undefined
  let token: string | undefined
  let deviceId: string | undefined
  let dashboardToken: string | undefined
  let publicOrigin: string | undefined

  if (role === 'node') {
    hubUrl = requireString(input, 'hubUrl', missing)
    token = requireString(input, 'token', missing)
    if (missing.length > 0) throw new Error(`marshal: node config is missing ${missing.join(', ')}`)
    hubUrl = parseHubUrl(hubUrl!)
    if (token!.length < 16) throw new Error('marshal: config.token must be at least 16 characters')
    if (input.deviceId === undefined) {
      throw new Error('marshal: config.deviceId is required; v1 configs must be migrated by registering the device (marshal-device add) and setting deviceId')
    }
    deviceId = requireString(input, 'deviceId', missing)
    if (deviceId === undefined) throw new Error('marshal: config.deviceId must be a non-empty string')
  } else {
    dashboardToken = requireString(input, 'dashboardToken', missing)
    publicOrigin = requireString(input, 'publicOrigin', missing)
    if (missing.length > 0) throw new Error(`marshal: hub config is missing ${missing.join(', ')}`)
    dashboardToken = parseDashboardToken(dashboardToken!)
    publicOrigin = parsePublicOrigin(publicOrigin!)
  }

  const privacy = parsePrivacy(input.privacy)
  const questionRelay = parseRelay(input.questionRelay, 'questionRelay')
  const approvalRelay = parseRelay(input.approvalRelay, 'approvalRelay')
  const answerTimeoutMs = parseInteger(input.answerTimeoutMs, 'answerTimeoutMs', 300_000, 15_000, 300_000)
  const approvalTimeoutMs = parseInteger(input.approvalTimeoutMs, 'approvalTimeoutMs', 60_000, 15_000, 300_000)
  const agents = parseAgents(input.agents)
  const codexExecutable = parseOptionalExecutable(input.codexExecutable, 'codexExecutable')
  const claudeExecutable = parseOptionalExecutable(input.claudeExecutable, 'claudeExecutable')
  const deviceName = parseDeviceName(input.deviceName, hostname)
  const ringBufferMinutes = parseInteger(input.ringBufferMinutes, 'ringBufferMinutes', 15, 1, 15)
  const redaction = parseRedaction(input.redaction)
  const allowDiscussion = parseBoolean(input.allowDiscussion, 'allowDiscussion', false)
  const devicesFile = parseDevicesFile(input.devicesFile)

  return Object.freeze({
    role,
    ...(hubUrl === undefined ? {} : { hubUrl }),
    ...(token === undefined ? {} : { token }),
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(dashboardToken === undefined ? {} : { dashboardToken }),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    deviceName,
    privacy,
    questionRelay,
    approvalRelay,
    answerTimeoutMs,
    approvalTimeoutMs,
    agents,
    ...(codexExecutable === undefined ? {} : { codexExecutable }),
    ...(claudeExecutable === undefined ? {} : { claudeExecutable }),
    ringBufferMinutes,
    redaction,
    allowDiscussion,
    devicesFile,
  })
}
