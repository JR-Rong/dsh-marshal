import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.ts'

const base = { role: 'node', hubUrl: 'wss://hub.example/marshal/uplink', token: 'x'.repeat(32) }
const hub = { role: 'hub', dashboardToken: 'd'.repeat(32) }

describe('parseConfig', () => {
  it('node 缺少 hubUrl 时列出缺失键', () => {
    expect(() => parseConfig({ role: 'node', token: 'x'.repeat(32) }, 'box')).toThrow(/hubUrl/)
  })

  it('node 缺少 token 时一并列出', () => {
    expect(() => parseConfig({ role: 'node' }, 'box')).toThrow(/hubUrl, token/)
  })

  it('hub 不需要 hubUrl，但必须有 dashboardToken', () => {
    expect(parseConfig(hub, 'box').role).toBe('hub')
    expect(() => parseConfig({ role: 'hub' }, 'box')).toThrow(/dashboardToken/)
  })

  it('默认 metadata、提问中继与审批中继都关', () => {
    const config = parseConfig(base, 'box')
    expect(config.privacy).toBe('metadata')
    expect(config.questionRelay).toBe('off')
    expect(config.approvalRelay).toBe('off')
    expect(config.answerTimeoutMs).toBe(300_000)
  })

  it('设备名缺省取 hostname', () => {
    expect(parseConfig(base, 'mac-mini').deviceName).toBe('mac-mini')
  })

  it('拒绝非 wss 的 hubUrl', () => {
    expect(() => parseConfig({ ...base, hubUrl: 'http://hub/marshal' }, 'box')).toThrow(/wss/)
  })

  it('拒绝未知的 role', () => {
    expect(() => parseConfig({ role: 'server' }, 'box')).toThrow(/role/)
  })
})
