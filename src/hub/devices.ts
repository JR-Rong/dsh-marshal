import { createHash, randomBytes } from 'node:crypto'
import { atomicWriteFile, withFileLock, readTextIfExists } from './state-file.ts'

/** 设备状态文件 v2；v1 只能经 `marshal-device migrate` 显式转换。 */
export const DEVICES_FILE_VERSION = 2 as const

export interface DeviceRecord {
  readonly id: string
  readonly name: string
  /** hex sha256(token)；原文不落盘。 */
  readonly tokenDigest: string
  readonly revoked: boolean
  readonly allowContent: boolean
  readonly allowInteractions: boolean
  readonly allowDiscussion: boolean
  /** 每设备持久单调修订号，从 1 开始，每次策略/撤销变更 +1。 */
  readonly policyRevision: number
  readonly revokedAt?: number
}

export interface DevicesState {
  readonly version: typeof DEVICES_FILE_VERSION
  readonly devices: readonly DeviceRecord[]
  /** 每设备已提交过的最高 revision；已有高水位时可据此发现整表回退。 */
  readonly revisionHighWatermarks?: Readonly<Record<string, number>>
}

export interface LegacyDeviceRecord {
  readonly id: string
  readonly name: string
  readonly token: string
}

export type DeviceStateLoad =
  | { readonly kind: 'missing' }
  | { readonly kind: 'legacy'; readonly devices: readonly LegacyDeviceRecord[] }
  | {
      readonly kind: 'current'
      readonly state: DevicesState
      /** 修订缺失/非法/回退的设备：可启动，但授权不可确认且拒绝新写。 */
      readonly revisionUnconfirmed: readonly string[]
    }

export type DeviceStateErrorCode =
  | 'missing' | 'unreadable' | 'invalid' | 'legacy'
  | 'duplicate-id' | 'duplicate-digest' | 'unknown-device' | 'revoked'
  | 'invalid-policy' | 'recovery-required'

export class DeviceStateError extends Error {
  override readonly name = 'DeviceStateError'
  readonly code: DeviceStateErrorCode

  constructor(code: DeviceStateErrorCode, detail: string) {
    // 错误只带分类与结构信息，绝不拼接 token 或摘要。
    super(`marshal: ${code}: ${detail}`)
    this.code = code
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function emptyDevicesState(): DevicesState {
  return { version: DEVICES_FILE_VERSION, devices: [] }
}

export function serializeDevicesState(state: DevicesState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function assertUnique(records: readonly DeviceRecord[], context: string): void {
  const ids = new Set<string>()
  const digests = new Set<string>()
  for (const record of records) {
    if (ids.has(record.id)) {
      throw new DeviceStateError('duplicate-id', `${context} repeats device id "${record.id}"`)
    }
    ids.add(record.id)
    if (digests.has(record.tokenDigest)) {
      throw new DeviceStateError('duplicate-digest', `${context} repeats a token digest for "${record.id}"`)
    }
    digests.add(record.tokenDigest)
  }
}

interface ValidatedRecord {
  readonly record: DeviceRecord
  readonly revisionUnconfirmed: boolean
}

function validateRecord(value: unknown, index: number): ValidatedRecord {
  if (!isObject(value)) throw new DeviceStateError('invalid', `devices[${index}] is not an object`)
  const { id, name, tokenDigest, revoked, allowContent, allowInteractions, allowDiscussion, policyRevision, revokedAt } = value
  if (!nonEmptyString(id)) throw new DeviceStateError('invalid', `devices[${index}].id must be a non-empty string`)
  if (!nonEmptyString(name)) throw new DeviceStateError('invalid', `devices[${index}].name must be a non-empty string`)
  if (typeof tokenDigest !== 'string' || !/^[0-9a-f]{64}$/.test(tokenDigest)) {
    throw new DeviceStateError('invalid', `devices[${index}].tokenDigest must be a hex sha256`)
  }
  if (typeof revoked !== 'boolean') throw new DeviceStateError('invalid', `devices[${index}].revoked must be a boolean`)
  for (const key of ['allowContent', 'allowInteractions', 'allowDiscussion'] as const) {
    if (typeof value[key] !== 'boolean') {
      throw new DeviceStateError('invalid', `devices[${index}].${key} must be a boolean`)
    }
  }
  // 修订字段异常不拖垮整张表：设备仍在，但授权不可确认，拒绝新写。
  const revisionUnconfirmed = typeof policyRevision !== 'number'
    || !Number.isInteger(policyRevision)
    || policyRevision < 1
  if (revokedAt !== undefined && (typeof revokedAt !== 'number' || !Number.isInteger(revokedAt) || revokedAt < 0)) {
    throw new DeviceStateError('invalid', `devices[${index}].revokedAt must be an integer >= 0`)
  }
  return {
    record: {
      id, name, tokenDigest, revoked,
      allowContent: allowContent as boolean,
      allowInteractions: allowInteractions as boolean,
      allowDiscussion: allowDiscussion as boolean,
      // 占位值只用于内存；任何写盘都会因 unconfirmed 而被拒绝，不会把 0 持久化。
      policyRevision: revisionUnconfirmed ? 0 : policyRevision,
      ...(revokedAt === undefined ? {} : { revokedAt }),
    },
    revisionUnconfirmed,
  }
}

function parseHighWatermarks(value: unknown): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new DeviceStateError('invalid', 'revisionHighWatermarks must be an object')
  const marks: Record<string, number> = {}
  for (const [id, mark] of Object.entries(value)) {
    if (typeof mark !== 'number' || !Number.isInteger(mark) || mark < 0) {
      throw new DeviceStateError('invalid', `revisionHighWatermarks["${id}"] must be an integer >= 0`)
    }
    marks[id] = mark
  }
  return marks
}

function parseCurrent(value: Record<string, unknown>): Extract<DeviceStateLoad, { kind: 'current' }> {
  if (value.version !== DEVICES_FILE_VERSION) {
    throw new DeviceStateError('invalid', `devices file version must be ${DEVICES_FILE_VERSION}`)
  }
  if (!Array.isArray(value.devices)) throw new DeviceStateError('invalid', 'devices must be an array')
  const validated = value.devices.map((item, index) => validateRecord(item, index))
  const devices = validated.map(item => item.record)
  assertUnique(devices, 'devices file')
  const watermarks = parseHighWatermarks(value.revisionHighWatermarks)
  const unconfirmed = new Set<string>()
  validated.forEach((item, index) => {
    if (item.revisionUnconfirmed) unconfirmed.add(item.record.id)
    const mark = watermarks?.[item.record.id]
    // 只有确实存过高水位时才把较低 revision 视为回退；否则不同设备各自递增是正常的。
    if (mark !== undefined && item.record.policyRevision < mark) unconfirmed.add(devices[index]!.id)
  })
  return {
    kind: 'current',
    state: {
      version: DEVICES_FILE_VERSION,
      devices,
      ...(watermarks === undefined ? {} : { revisionHighWatermarks: watermarks }),
    },
    revisionUnconfirmed: [...unconfirmed],
  }
}

function looksLegacy(value: Record<string, unknown>): boolean {
  if (value.version !== undefined && value.version !== 1) return false
  if (!Array.isArray(value.devices)) return false
  return value.devices.every(item => isObject(item)
    && typeof item.id === 'string'
    && typeof item.name === 'string'
    && typeof item.token === 'string')
}

function parseLegacy(value: Record<string, unknown>): readonly LegacyDeviceRecord[] {
  const devices = value.devices
  if (!Array.isArray(devices)) throw new DeviceStateError('invalid', 'legacy devices must be an array')
  const seen = new Set<string>()
  return devices.map((item, index): LegacyDeviceRecord => {
    if (!isObject(item)
      || !nonEmptyString(item.id) || !nonEmptyString(item.name) || !nonEmptyString(item.token)) {
      throw new DeviceStateError('invalid', `legacy devices[${index}] is incomplete`)
    }
    if (seen.has(item.id)) throw new DeviceStateError('duplicate-id', `legacy devices repeat id "${item.id}"`)
    seen.add(item.id)
    return { id: item.id, name: item.name, token: item.token }
  })
}

/**
 * 读取并分类设备表：缺失、v1 旧表、结构合法的 v2。
 * 无法读取/解析/结构非法都抛错，绝不静默丢弃条目。
 */
export function readDeviceState(path: string): DeviceStateLoad {
  let text: string | undefined
  try {
    text = readTextIfExists(path)
  } catch {
    throw new DeviceStateError('unreadable', `cannot read ${path}`)
  }
  if (text === undefined) return { kind: 'missing' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new DeviceStateError('unreadable', `${path} is not valid JSON`)
  }
  if (!isObject(parsed)) throw new DeviceStateError('invalid', `${path} must contain an object`)
  if (parsed.version === DEVICES_FILE_VERSION) return parseCurrent(parsed)
  if (looksLegacy(parsed)) return { kind: 'legacy', devices: parseLegacy(parsed) }
  throw new DeviceStateError('invalid', `${path} is not a v1 or v2 device table`)
}

/** v1 → v2 的纯转换；不写盘，也不改动旧 token 原文。 */
export function migrateLegacyState(devices: readonly LegacyDeviceRecord[]): DevicesState {
  const migrated = devices.map((device): DeviceRecord => ({
    id: device.id,
    name: device.name,
    tokenDigest: sha256Hex(device.token),
    revoked: false,
    allowContent: false,
    allowInteractions: false,
    allowDiscussion: false,
    policyRevision: 1,
  }))
  assertUnique(migrated, 'migrated device table')
  return { version: DEVICES_FILE_VERSION, devices: migrated }
}

export interface PolicyChanges {
  readonly allowContent?: boolean
  readonly allowInteractions?: boolean
  readonly allowDiscussion?: boolean
}

export interface DeviceMutation {
  readonly entry: DeviceRecord
  readonly revision: number
}

export interface DeviceAddition extends DeviceMutation {
  /** 只在此处返回一次；调用方必须只展示、不持久化。 */
  readonly token: string
}

export interface DeviceStoreOptions {
  /** 仅用于 revokedAt；锁的陈旧判定始终使用墙钟。 */
  readonly now?: () => number
}

/**
 * 进程间共享的设备表写者。每次变更都在锁内重读整表、校验版本与唯一性，
 * 成功后原子替换；写盘失败时内存状态保持旧值。
 */
export class DeviceStore {
  private state: DevicesState
  private readonly now: () => number
  /** 修订异常设备：可启动但授权不可确认，任何整表写入都会拒绝以保留原始证据。 */
  private unconfirmed = new Set<string>()

  constructor(private readonly path: string, options: DeviceStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.state = this.load()
  }

  get file(): string { return this.path }

  reload(): void {
    this.state = this.load()
  }

  list(): readonly DeviceRecord[] { return [...this.state.devices] }

  /** 该设备是否因修订缺失/非法/回退而不能确认授权。 */
  isRecoveryRequired(id: string): boolean { return this.unconfirmed.has(id) }

  recoveryRequired(): readonly string[] { return [...this.unconfirmed] }

  findById(id: string): DeviceRecord | undefined {
    return this.state.devices.find(device => device.id === id)
  }

  findByTokenDigest(digest: string): DeviceRecord | undefined {
    return this.state.devices.find(device => device.tokenDigest === digest)
  }

  add(id: string, name: string): DeviceAddition {
    if (id === '') throw new DeviceStateError('invalid', 'device id must not be blank')
    return this.mutate(state => {
      const existing = state.devices.find(device => device.id === id)
      if (existing !== undefined) {
        throw existing.revoked
          ? new DeviceStateError('revoked', `device "${id}" is revoked and cannot be re-added`)
          : new DeviceStateError('duplicate-id', `device "${id}" already exists`)
      }
      const token = randomBytes(32).toString('base64url')
      const entry: DeviceRecord = {
        id,
        name: name === '' ? id : name,
        tokenDigest: sha256Hex(token),
        revoked: false,
        allowContent: false,
        allowInteractions: false,
        allowDiscussion: false,
        policyRevision: 1,
      }
      return {
        state: { version: DEVICES_FILE_VERSION, devices: [...state.devices, entry] },
        result: { entry, revision: entry.policyRevision, token },
      }
    })
  }

  revoke(id: string): DeviceMutation {
    return this.mutate(state => {
      const index = state.devices.findIndex(device => device.id === id)
      if (index === -1) throw new DeviceStateError('unknown-device', `unknown device "${id}"`)
      const current = state.devices[index]
      if (current === undefined) throw new DeviceStateError('unknown-device', `unknown device "${id}"`)
      if (current.revoked) throw new DeviceStateError('revoked', `device "${id}" is already revoked`)
      const entry: DeviceRecord = {
        ...current,
        revoked: true,
        revokedAt: this.now(),
        policyRevision: current.policyRevision + 1,
      }
      const devices = [...state.devices]
      devices[index] = entry
      return { state: { version: DEVICES_FILE_VERSION, devices }, result: { entry, revision: entry.policyRevision } }
    })
  }

  setPolicy(id: string, changes: PolicyChanges): DeviceMutation {
    const keys = (['allowContent', 'allowInteractions', 'allowDiscussion'] as const)
      .filter(key => changes[key] !== undefined)
    if (keys.length === 0) throw new DeviceStateError('invalid-policy', 'no policy change requested')
    return this.mutate(state => {
      const index = state.devices.findIndex(device => device.id === id)
      if (index === -1) throw new DeviceStateError('unknown-device', `unknown device "${id}"`)
      const current = state.devices[index]
      if (current === undefined) throw new DeviceStateError('unknown-device', `unknown device "${id}"`)
      if (current.revoked) throw new DeviceStateError('revoked', `device "${id}" is revoked`)
      const entry: DeviceRecord = {
        ...current,
        ...(changes.allowContent === undefined ? {} : { allowContent: changes.allowContent }),
        ...(changes.allowInteractions === undefined ? {} : { allowInteractions: changes.allowInteractions }),
        ...(changes.allowDiscussion === undefined ? {} : { allowDiscussion: changes.allowDiscussion }),
        policyRevision: current.policyRevision + 1,
      }
      const devices = [...state.devices]
      devices[index] = entry
      return { state: { version: DEVICES_FILE_VERSION, devices }, result: { entry, revision: entry.policyRevision } }
    })
  }

  private load(): DevicesState {
    const loaded = readDeviceState(this.path)
    if (loaded.kind === 'missing') throw new DeviceStateError('missing', `device table ${this.path} is missing`)
    if (loaded.kind === 'legacy') {
      throw new DeviceStateError(
        'legacy',
        `device table ${this.path} is v1; run "marshal-device migrate" and point devicesFile at the new file`,
      )
    }
    this.unconfirmed = new Set(loaded.revisionUnconfirmed)
    return loaded.state
  }

  /** 已有高水位只能升不能降；新写入的 revision 同时推进高水位。 */
  private withWatermarks(state: DevicesState): DevicesState {
    const marks: Record<string, number> = { ...(state.revisionHighWatermarks ?? {}) }
    for (const entry of state.devices) {
      marks[entry.id] = Math.max(marks[entry.id] ?? entry.policyRevision, entry.policyRevision)
    }
    return { ...state, revisionHighWatermarks: marks }
  }

  private assertWritable(): void {
    if (this.unconfirmed.size === 0) return
    const ids = [...this.unconfirmed].join(', ')
    throw new DeviceStateError(
      'recovery-required',
      `device authorization is unconfirmable for ${ids}; repair policyRevision before writing`,
    )
  }

  private mutate<T>(fn: (state: DevicesState) => { state: DevicesState; result: T }): T {
    return withFileLock(this.path, () => {
      // 锁内重读：并发的 CLI/另一个 hub 写者可能已经提交了更新。
      const current = this.load()
      this.assertWritable()
      const next = fn(current)
      // 写入前再确认目标行没有被锁外修改成修订异常。
      this.assertWritable()
      const committed = this.withWatermarks(next.state)
      atomicWriteFile(this.path, serializeDevicesState(committed))
      this.state = committed
      return next.result
    })
  }
}
