import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeDevicesState } from '../src/hub/devices.ts'
import {
  INIT_INTENT_TTL_MS, RecoveryRequiredError, StateDevicesMissingError, ensureInstall,
} from '../src/hub/identity.ts'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(): { dir: string; devicesFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-identity-'))
  dirs.push(dir)
  return { dir, devicesFile: join(dir, 'devices.json') }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function writeEmptyDevices(path: string): void {
  writeFileSync(path, serializeDevicesState({ version: 2, devices: [] }), { mode: 0o600 })
}

describe('ensureInstall', () => {
  it('全新安装创建意图、空 v2 表与身份，并清理意图', () => {
    const { dir, devicesFile } = setup()
    const install = ensureInstall(devicesFile)
    expect(install.initialized).toBe(true)
    expect(install.operatorId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(install.store.list()).toEqual([])
    expect(install.store.file).toBe(devicesFile)

    const identity = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8')) as { operatorId: string }
    expect(identity.operatorId).toBe(install.operatorId)
    expect(existsSync(join(dir, 'init-intent.json'))).toBe(false)
    expect(statSync(join(dir, 'identity.json')).mode & 0o777).toBe(0o600)
    expect(statSync(devicesFile).mode & 0o777).toBe(0o600)
  })

  it('重复启动复用同一 operatorId', () => {
    const { devicesFile } = setup()
    const first = ensureInstall(devicesFile)
    const second = ensureInstall(devicesFile)
    expect(second.initialized).toBe(false)
    expect(second.operatorId).toBe(first.operatorId)
  })

  it('身份存在但设备表缺失是启动失败', () => {
    const { dir, devicesFile } = setup()
    ensureInstall(devicesFile)
    rmSync(devicesFile)
    try {
      ensureInstall(devicesFile)
      throw new Error('expected state-devices-missing')
    } catch (error) {
      expect(error).toBeInstanceOf(StateDevicesMissingError)
      expect((error as StateDevicesMissingError).code).toBe('state-devices-missing')
    }
    // 不自动重建空表。
    expect(existsSync(devicesFile)).toBe(false)
    expect(existsSync(join(dir, 'identity.json'))).toBe(true)
  })

  it('设备表存在但身份缺失时转人工恢复', () => {
    const { devicesFile } = setup()
    writeEmptyDevices(devicesFile)
    try {
      ensureInstall(devicesFile)
      throw new Error('expected recovery-required')
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryRequiredError)
      expect((error as Error).message).toMatch(/identity\.json/)
    }
    expect(existsSync(join(dirname(devicesFile), 'identity.json'))).toBe(false)
  })

  it('v1 设备表不会被普通启动猜测迁移', () => {
    const { devicesFile } = setup()
    writeFileSync(devicesFile, JSON.stringify({ devices: [{ id: 'mac', name: 'Mac', token: 'x'.repeat(32) }] }))
    try {
      ensureInstall(devicesFile)
      throw new Error('expected recovery-required')
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryRequiredError)
      expect((error as Error).message).toMatch(/migrate/)
    }
  })

  it('匹配的初始化意图可完成同一身份，无需另造 operatorId', () => {
    const { dir, devicesFile } = setup()
    const operatorId = randomBytes(32).toString('base64url')
    writeJson(join(dir, 'init-intent.json'), {
      version: 1, operatorId, devicesPath: devicesFile, createdAt: Date.now(),
    })
    writeEmptyDevices(devicesFile)
    const install = ensureInstall(devicesFile)
    expect(install.operatorId).toBe(operatorId)
    expect(install.initialized).toBe(true)
    expect(existsSync(join(dir, 'init-intent.json'))).toBe(false)
    expect(existsSync(join(dir, 'identity.json'))).toBe(true)
  })

  it('意图指向别的设备表时转人工恢复', () => {
    const { dir, devicesFile } = setup()
    writeJson(join(dir, 'init-intent.json'), {
      version: 1,
      operatorId: randomBytes(32).toString('base64url'),
      devicesPath: join(dir, 'other.json'),
      createdAt: Date.now(),
    })
    expect(() => ensureInstall(devicesFile)).toThrowError(RecoveryRequiredError)
  })

  it('过期意图转人工恢复', () => {
    const { dir, devicesFile } = setup()
    writeJson(join(dir, 'init-intent.json'), {
      version: 1,
      operatorId: randomBytes(32).toString('base64url'),
      devicesPath: devicesFile,
      createdAt: Date.now() - INIT_INTENT_TTL_MS - 1,
    })
    expect(() => ensureInstall(devicesFile)).toThrowError(/expired/)
  })

  it('损坏的身份或意图都转人工恢复', () => {
    const identityCase = setup()
    writeFileSync(join(identityCase.dir, 'identity.json'), '{broken')
    expect(() => ensureInstall(identityCase.devicesFile)).toThrowError(RecoveryRequiredError)

    const intentCase = setup()
    writeFileSync(join(intentCase.dir, 'init-intent.json'), '{broken')
    expect(() => ensureInstall(intentCase.devicesFile)).toThrowError(RecoveryRequiredError)
  })
})
