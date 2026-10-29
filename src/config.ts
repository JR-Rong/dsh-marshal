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
  if (typeof value !== 'string' || value.trim() === '') { missing.push(key); return undefined }
  return value.trim()
}

function parseRelay(raw: unknown, key: string): Relay {
  const value = raw ?? 'off'
  if (value !== 'off' && value !== 'remote') throw new Error(`marshal: config.${key} must be "off" or "remote"`)
  return value
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
    if (!hubUrl!.startsWith('wss://')) throw new Error('marshal: config.hubUrl must be a wss:// URL')
    if (token!.length < 16) throw new Error('marshal: config.token must be at least 16 characters')
  } else {
    dashboardToken = requireString(input, 'dashboardToken', missing)
    if (missing.length > 0) throw new Error(`marshal: hub config is missing ${missing.join(', ')}`)
    if (dashboardToken!.length < 16) throw new Error('marshal: config.dashboardToken must be at least 16 characters')
  }

  const privacy = input.privacy ?? 'metadata'
  if (privacy !== 'metadata' && privacy !== 'content') throw new Error('marshal: config.privacy must be "metadata" or "content"')

  const answerTimeoutMs = input.answerTimeoutMs ?? 300_000
  if (typeof answerTimeoutMs !== 'number' || !Number.isFinite(answerTimeoutMs) || answerTimeoutMs <= 0) {
    throw new Error('marshal: config.answerTimeoutMs must be a positive number')
  }

  const deviceName = typeof input.deviceName === 'string' && input.deviceName.trim() !== ''
    ? input.deviceName.trim()
    : hostname

  return {
    role,
    ...(hubUrl === undefined ? {} : { hubUrl }),
    ...(token === undefined ? {} : { token }),
    ...(dashboardToken === undefined ? {} : { dashboardToken }),
    deviceName,
    privacy,
    questionRelay: parseRelay(input.questionRelay, 'questionRelay'),
    answerTimeoutMs,
    approvalRelay: parseRelay(input.approvalRelay, 'approvalRelay'),
    ringBufferMinutes: typeof input.ringBufferMinutes === 'number' ? input.ringBufferMinutes : 15,
    redaction: Array.isArray(input.redaction) ? input.redaction.filter((x): x is string => typeof x === 'string') : [],
    devicesFile: typeof input.devicesFile === 'string' ? input.devicesFile : `${process.env.HOME ?? '.'}/.dsh-marshal/devices.json`,
  }
}
