import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DeviceStateError, DeviceStore, migrateLegacyState, readDeviceState, sha256Hex,
  serializeDevicesState, type DeviceRecord, type DevicesState,
} from '../src/hub/devices.ts'

const TOKEN = 'store-token-0123456789abcdef'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-device-store-'))
  dirs.push(dir)
  return join(dir, 'devices.json')
}

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: 'mac',
    name: 'Mac',
    tokenDigest: sha256Hex(TOKEN),
    revoked: false,
    allowContent: false,
    allowInteractions: false,
    allowDiscussion: false,
    policyRevision: 1,
    ...overrides,
  }
}

function writeState(path: string, state: DevicesState): void {
  writeFileSync(path, serializeDevicesState(state), { mode: 0o600 })
}

describe('device state file', () => {
  it('区分缺失、v1 旧表与合法 v2', () => {
    const path = tempPath()
    expect(readDeviceState(path)).toEqual({ kind: 'missing' })

    writeFileSync(path, JSON.stringify({ devices: [{ id: 'mac', name: 'Mac', token: TOKEN }] }))
    const legacy = readDeviceState(path)
    expect(legacy.kind).toBe('legacy')

    writeState(path, { version: 2, devices: [record()] })
    const current = readDeviceState(path)
    expect(current.kind).toBe('current')
  })

  it('不可解析与重复 id/摘要都抛出分类错误，不丢弃条目', () => {
    const path = tempPath()
    writeFileSync(path, '{not json')
    expect(() => readDeviceState(path)).toThrowError(DeviceStateError)

    writeState(path, { version: 2, devices: [record(), record({ name: 'Other' })] })
    try {
      readDeviceState(path)
      throw new Error('expected duplicate id failure')
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceStateError)
      expect((error as DeviceStateError).code).toBe('duplicate-id')
    }

    writeState(path, {
      version: 2,
      devices: [record(), record({ id: 'pc', name: 'PC' })],
    })
    try {
      readDeviceState(path)
      throw new Error('expected duplicate digest failure')
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceStateError)
      expect((error as DeviceStateError).code).toBe('duplicate-digest')
    }
  })

  it('v1 迁移计算摘要且保留 id/name', () => {
    const state = migrateLegacyState([{ id: 'mac', name: 'Mac', token: TOKEN }])
    expect(state.version).toBe(2)
    expect(state.devices[0]).toEqual(record())
  })
})

describe('DeviceStore', () => {
  it('add 只落盘摘要，token 只返回一次，文件权限 0600', () => {
    const path = tempPath()
    writeState(path, { version: 2, devices: [] })
    const store = new DeviceStore(path)
    const added = store.add('mac', 'Mac')
    expect(added.revision).toBe(1)
    expect(added.entry.tokenDigest).toBe(sha256Hex(added.token))
    expect(added.entry.allowContent).toBe(false)
    expect(added.entry.policyRevision).toBe(1)

    const text = readFileSync(path, 'utf8')
    expect(text).toContain(added.entry.tokenDigest)
    expect(text).not.toContain(added.token)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(store.findById('mac')?.name).toBe('Mac')
  })

  it('重复 id 与撤销后的 id 都拒绝再添加', () => {
    const path = tempPath()
    writeState(path, { version: 2, devices: [record()] })
    const store = new DeviceStore(path)
    expect(() => store.add('mac', 'Again')).toThrow(/already exists/)
    store.revoke('mac')
    try {
      store.add('mac', 'Again')
      throw new Error('expected revoked add failure')
    } catch (error) {
      expect((error as DeviceStateError).code).toBe('revoked')
    }
  })

  it('revoke 保留墓碑并单调递增 revision', () => {
    const path = tempPath()
    writeState(path, { version: 2, devices: [record()] })
    const store = new DeviceStore(path)
    const result = store.revoke('mac')
    expect(result.revision).toBe(2)
    expect(result.entry.revoked).toBe(true)
    expect(result.entry.revokedAt).toBeTypeOf('number')
    // 墓碑仍在表里，不能删除。
    expect(store.list()).toHaveLength(1)
    expect(store.findByTokenDigest(sha256Hex(TOKEN))?.revoked).toBe(true)
  })

  it('setPolicy 每次变更递增 revision', () => {
    const path = tempPath()
    writeState(path, { version: 2, devices: [record()] })
    const store = new DeviceStore(path)
    expect(store.setPolicy('mac', { allowContent: true }).revision).toBe(2)
    const second = store.setPolicy('mac', { allowInteractions: true })
    expect(second.revision).toBe(3)
    expect(second.entry.allowContent).toBe(true)
    expect(second.entry.allowInteractions).toBe(true)
    expect(second.entry.allowDiscussion).toBe(false)
  })

  it('reload 读取外部提交，非法文件不改内存状态', () => {
    const path = tempPath()
    writeState(path, { version: 2, devices: [record()] })
    const store = new DeviceStore(path)
    writeState(path, { version: 2, devices: [record({ policyRevision: 5, allowContent: true })] })
    store.reload()
    expect(store.findById('mac')?.policyRevision).toBe(5)

    writeFileSync(path, '{broken')
    expect(() => store.reload()).toThrowError(DeviceStateError)
    expect(store.findById('mac')?.policyRevision).toBe(5)
  })

  it('打破超过 10s 的陈旧锁后仍能写入', () => {
    const path = tempPath()
    writeState(path, { version: 2, devices: [] })
    const lock = `${path}.lock`
    writeFileSync(lock, '{}', { mode: 0o600 })
    const stale = new Date(Date.now() - 11_000)
    utimesSync(lock, stale, stale)
    const store = new DeviceStore(path)
    expect(store.add('mac', 'Mac').entry.id).toBe('mac')
  })

  it('未知设备与空策略变更被拒绝', () => {
    const path = tempPath()
    writeState(path, { version: 2, devices: [record()] })
    const store = new DeviceStore(path)
    expect(() => store.revoke('missing')).toThrow(/unknown device/)
    expect(() => store.setPolicy('mac', {})).toThrow(/no policy change/)
  })
})
