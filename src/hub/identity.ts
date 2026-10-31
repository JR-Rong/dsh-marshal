import { existsSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import {
  DeviceStore, DeviceStateError, emptyDevicesState,
  readDeviceState, serializeDevicesState, type DeviceStateLoad, type DevicesState,
} from './devices.ts'
import { atomicWriteFile, ensurePrivateDir, readTextIfExists } from './state-file.ts'

/** operatorId 是 hub 安装的持久 owner 身份，跨登录/重启/token 轮换稳定。 */
export const IDENTITY_VERSION = 1 as const
export const INIT_INTENT_VERSION = 1 as const
/** 初始化意图超过一天仍未完成，按过期意图转人工恢复。 */
export const INIT_INTENT_TTL_MS = 24 * 60 * 60 * 1000

export interface IdentityRecord {
  readonly version: typeof IDENTITY_VERSION
  readonly operatorId: string
}

export interface InitIntent {
  readonly version: typeof INIT_INTENT_VERSION
  readonly operatorId: string
  readonly devicesPath: string
  readonly createdAt: number
}

export interface InstallResult {
  readonly operatorId: string
  readonly store: DeviceStore
  /** 本次调用完成了全新初始化（设备表按空表落盘）。 */
  readonly initialized: boolean
}

/** 契约 §6：已初始化安装的身份/授权状态不可自动重建。 */
export class RecoveryRequiredError extends Error {
  override readonly name = 'RecoveryRequiredError'
  readonly code = 'recovery-required' as const

  constructor(detail: string) {
    super(`marshal: recovery-required: ${detail}`)
  }
}

/** 契约 §3：operator 身份存在而设备表缺失是启动失败，不是空表。 */
export class StateDevicesMissingError extends Error {
  override readonly name = 'StateDevicesMissingError'
  readonly code = 'state-devices-missing' as const

  constructor(path: string) {
    super(`marshal: state-devices-missing: ${path} is missing for an initialized install`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validOperatorId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(value)
}

function readJson(path: string, label: string): unknown | undefined {
  let text: string | undefined
  try {
    text = readTextIfExists(path)
  } catch {
    throw new RecoveryRequiredError(`${label} is unreadable; restore it from a trusted backup`)
  }
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new RecoveryRequiredError(`${label} is not valid JSON; restore it from a trusted backup`)
  }
}

function parseIdentity(value: unknown): IdentityRecord {
  if (!isObject(value) || value.version !== IDENTITY_VERSION || !validOperatorId(value.operatorId)) {
    throw new RecoveryRequiredError('identity.json is corrupt; restore it from a trusted backup')
  }
  return { version: IDENTITY_VERSION, operatorId: value.operatorId }
}

function parseIntent(value: unknown): InitIntent {
  if (!isObject(value)
    || value.version !== INIT_INTENT_VERSION
    || !validOperatorId(value.operatorId)
    || typeof value.devicesPath !== 'string'
    || value.devicesPath === ''
    || typeof value.createdAt !== 'number'
    || !Number.isInteger(value.createdAt)
    || value.createdAt < 0) {
    throw new RecoveryRequiredError('init-intent.json is corrupt; inspect the state directory before retrying')
  }
  return {
    version: INIT_INTENT_VERSION,
    operatorId: value.operatorId,
    devicesPath: value.devicesPath,
    createdAt: value.createdAt,
  }
}

function writeIdentity(path: string, operatorId: string): void {
  const record: IdentityRecord = { version: IDENTITY_VERSION, operatorId }
  atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`, 0o600)
}

function writeIntent(path: string, intent: InitIntent): void {
  atomicWriteFile(path, `${JSON.stringify(intent, null, 2)}\n`, 0o600)
}

function writeEmptyDevices(path: string): void {
  atomicWriteFile(path, serializeDevicesState(emptyDevicesState()), 0o600)
}

function removeIntent(path: string): void {
  try { unlinkSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function completeIntent(
  devicesPath: string,
  intent: InitIntent,
  identity: IdentityRecord | undefined,
  current: DevicesState | undefined,
): InstallResult {
  if (intent.devicesPath !== devicesPath) {
    throw new RecoveryRequiredError(
      `init intent targets ${intent.devicesPath}, not ${devicesPath}; inspect the state directory before retrying`,
    )
  }
  if (Date.now() - intent.createdAt > INIT_INTENT_TTL_MS) {
    throw new RecoveryRequiredError('init intent has expired; inspect the state directory before retrying')
  }
  if (identity !== undefined && identity.operatorId !== intent.operatorId) {
    throw new RecoveryRequiredError('init intent and identity.json disagree on operatorId; restore a trusted pair')
  }
  const intentPath = join(dirname(devicesPath), 'init-intent.json')
  const identityPath = join(dirname(devicesPath), 'identity.json')
  const initialized = identity === undefined
  if (current === undefined) writeEmptyDevices(devicesPath)
  if (identity === undefined) writeIdentity(identityPath, intent.operatorId)
  removeIntent(intentPath)
  const store = new DeviceStore(devicesPath)
  return { operatorId: intent.operatorId, store, initialized }
}

function initializeFresh(devicesPath: string, intentPath: string, identityPath: string): InstallResult {
  const operatorId = randomBytes(32).toString('base64url')
  const intent: InitIntent = {
    version: INIT_INTENT_VERSION,
    operatorId,
    devicesPath,
    createdAt: Date.now(),
  }
  // 顺序固定：意图 → 空 v2 表 → 身份 → 清理意图。中途崩溃只能凭匹配意图续完。
  writeIntent(intentPath, intent)
  writeEmptyDevices(devicesPath)
  writeIdentity(identityPath, operatorId)
  removeIntent(intentPath)
  return { operatorId, store: new DeviceStore(devicesPath), initialized: true }
}

/**
 * hub 启动与 `marshal-device` 共用的初始化入口。
 * 只有所有状态都不存在时才新建安装；其余组合按契约 §3/§4 失败或转人工恢复。
 */
export function ensureInstall(devicesFile: string): InstallResult {
  const devicesPath = resolve(devicesFile)
  const dir = dirname(devicesPath)
  ensurePrivateDir(dir)
  const identityPath = join(dir, 'identity.json')
  const intentPath = join(dir, 'init-intent.json')

  const identityRaw = readJson(identityPath, 'identity.json')
  const identity = identityRaw === undefined ? undefined : parseIdentity(identityRaw)
  const intentRaw = readJson(intentPath, 'init-intent.json')
  const intent = intentRaw === undefined ? undefined : parseIntent(intentRaw)

  let loaded: DeviceStateLoad
  try {
    loaded = readDeviceState(devicesPath)
  } catch (error) {
    if (error instanceof DeviceStateError) throw error
    throw new RecoveryRequiredError('device table cannot be read; inspect the state directory')
  }
  const current = loaded.kind === 'current' ? loaded.state : undefined

  if (intent !== undefined) {
    if (loaded.kind === 'legacy') {
      throw new RecoveryRequiredError('init intent cannot complete over a v1 device table; run "marshal-device migrate"')
    }
    return completeIntent(devicesPath, intent, identity, current)
  }

  if (identity === undefined && loaded.kind === 'missing') {
    return initializeFresh(devicesPath, intentPath, identityPath)
  }
  if (identity === undefined) {
    const hint = loaded.kind === 'legacy'
      ? ' the table is still v1: run "marshal-device migrate" and point devicesFile at the new file'
      : ' restore the matching identity.json from a trusted backup'
    throw new RecoveryRequiredError(`device state exists but identity.json is missing;${hint}`)
  }
  if (loaded.kind === 'missing') throw new StateDevicesMissingError(devicesPath)
  if (loaded.kind === 'legacy') {
    throw new RecoveryRequiredError(
      'device table is still v1; run "marshal-device migrate" and point devicesFile at the new file',
    )
  }
  // 身份已存在时只接受结构完好的 v2 表；缺失/损坏在上面的分支已按启动失败处理。
  if (!existsSync(identityPath)) throw new RecoveryRequiredError('identity.json disappeared during startup')
  const store = new DeviceStore(devicesPath)
  return { operatorId: identity.operatorId, store, initialized: false }
}
