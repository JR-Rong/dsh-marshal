import { describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../src/hub/registry.ts'

const sender = { sent: [] as string[], send(text: string) { this.sent.push(text) } }

describe('DeviceRegistry', () => {
  it('挂载与移除设备', () => {
    const registry = new DeviceRegistry()
    registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, sender, 1000)
    expect(registry.get('mac')?.record.name).toBe('Mac')
    registry.detach('mac')
    expect(registry.get('mac')).toBeUndefined()
  })

  it('列出设备时不带 socket', () => {
    const registry = new DeviceRegistry()
    registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, sender, 1000)
    const [device] = registry.list(1000)
    expect(device).toEqual({ id: 'mac', name: 'Mac', agents: ['dsh'], connectedAt: 1000, lastSeen: 1000 })
  })

  it('超过 TTL 未活动即过期', () => {
    const registry = new DeviceRegistry()
    registry.attach({ id: 'mac', name: 'Mac', agents: [] }, sender, 1000)
    expect(registry.expire(1000 + 90_001, 90_000)).toEqual(['mac'])
    expect(registry.get('mac')).toBeUndefined()
  })

  it('连接代次随槽位保存，旧 sender 的 detachIf 不影响新连接', () => {
    const registry = new DeviceRegistry()
    const oldSender = { send() {} }
    const newSender = { send() {} }
    registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, oldSender, 1000, {
      connectionId: 'conn-old', nodeEpoch: 'epoch-1',
    })
    registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, newSender, 2000, {
      connectionId: 'conn-new', nodeEpoch: 'epoch-1',
    })
    expect(registry.get('mac')?.connectionId).toBe('conn-new')
    expect(registry.detachIf('mac', oldSender)).toBe(false)
    expect(registry.get('mac')?.sender).toBe(newSender)
  })
})
