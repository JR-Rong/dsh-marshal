import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.ts'

const base = {
  role: 'node',
  hubUrl: 'wss://hub.example/marshal/uplink',
  token: 'x'.repeat(32),
  deviceId: 'mac-01',
}
const hub = {
  role: 'hub',
  dashboardToken: 'a1b2c3d4'.repeat(4),
  publicOrigin: 'https://marshal.example',
}

describe('parseConfig', () => {
  it('node 缺少 hubUrl 时列出缺失键', () => {
    expect(() => parseConfig({ role: 'node', token: 'x'.repeat(32), deviceId: 'mac' }, 'box')).toThrow(/hubUrl/)
  })

  it('node 缺少 token 时一并列出', () => {
    expect(() => parseConfig({ role: 'node', deviceId: 'mac' }, 'box')).toThrow(/hubUrl, token/)
  })

  it('node 缺少 deviceId 时给出迁移错误', () => {
    expect(() => parseConfig({ role: 'node', hubUrl: base.hubUrl, token: base.token }, 'box'))
      .toThrow(/config\.deviceId is required; v1 configs must be migrated/)
  })

  it('deviceId 与 deviceName 相互独立，显示名不参与身份', () => {
    const config = parseConfig({ ...base, deviceName: 'office-mac' }, 'box')
    expect(config.deviceId).toBe('mac-01')
    expect(config.deviceName).toBe('office-mac')
    expect(parseConfig(base, 'box').deviceName).toBe('box')
  })

  it('hub 必须有 dashboardToken 与 publicOrigin', () => {
    expect(parseConfig(hub, 'box').role).toBe('hub')
    expect(() => parseConfig({ role: 'hub', publicOrigin: hub.publicOrigin }, 'box')).toThrow(/dashboardToken/)
    expect(() => parseConfig({ role: 'hub', dashboardToken: hub.dashboardToken }, 'box')).toThrow(/publicOrigin/)
  })

  it('默认 metadata、两端中继都关、agent 只有 dsh', () => {
    const config = parseConfig(base, 'box')
    expect(config.privacy).toBe('metadata')
    expect(config.questionRelay).toBe('off')
    expect(config.approvalRelay).toBe('off')
    expect(config.answerTimeoutMs).toBe(300_000)
    expect(config.approvalTimeoutMs).toBe(60_000)
    expect(config.ringBufferMinutes).toBe(15)
    expect(config.agents).toEqual(['dsh'])
    expect(config.redaction).toEqual([])
    expect(config.allowDiscussion).toBe(false)
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('hubUrl 必须是 wss://', () => {
    expect(parseConfig(base, 'box').hubUrl).toBe('wss://hub.example/marshal/uplink')
    expect(() => parseConfig({ ...base, hubUrl: 'http://hub/marshal' }, 'box')).toThrow(/wss:\/\/ URL/)
    expect(() => parseConfig({ ...base, hubUrl: 'ws://127.0.0.1:8787/marshal' }, 'box')).toThrow(/wss:\/\/ URL/)
    expect(() => parseConfig({ ...base, hubUrl: 'wss://' }, 'box')).toThrow(/wss:\/\/ URL/)
  })

  it('空串或纯空白的 token 按缺失处理', () => {
    expect(() => parseConfig({ ...base, token: '' }, 'box')).toThrow(/missing token/)
    expect(() => parseConfig({ ...base, token: '   ' }, 'box')).toThrow(/missing token/)
  })

  it('token 至少 16 字符', () => {
    expect(() => parseConfig({ ...base, token: 'short' }, 'box')).toThrow(/at least 16/)
  })

  it('dashboardToken 至少 32 字符、禁止单字符重复与弱口令', () => {
    expect(() => parseConfig({ ...hub, dashboardToken: 'a'.repeat(16) }, 'box')).toThrow(/at least 32/)
    expect(() => parseConfig({ ...hub, dashboardToken: 'z'.repeat(40) }, 'box')).toThrow(/single character/)
    expect(() => parseConfig({ ...hub, dashboardToken: 'changeme'.repeat(5) }, 'box')).toThrow(/weak/)
  })

  it('publicOrigin 只接受裸 HTTPS origin', () => {
    expect(parseConfig(hub, 'box').publicOrigin).toBe('https://marshal.example')
    expect(() => parseConfig({ ...hub, publicOrigin: 'http://marshal.example' }, 'box')).toThrow(/https/)
    expect(() => parseConfig({ ...hub, publicOrigin: 'https://marshal.example/' }, 'box')).toThrow(/trailing slash/)
    expect(() => parseConfig({ ...hub, publicOrigin: 'https://marshal.example/marshal' }, 'box')).toThrow(/path/)
    expect(() => parseConfig({ ...hub, publicOrigin: 'https://marshal.example?x=1' }, 'box')).toThrow(/query/)
    expect(() => parseConfig({ ...hub, publicOrigin: 'https://user:pw@marshal.example' }, 'box')).toThrow(/credentials/)
  })

  it('拒绝未知配置键', () => {
    expect(() => parseConfig({ ...base, device: 'mac' }, 'box')).toThrow(/config\.device is unknown/)
  })

  it('拒绝未知的 privacy', () => {
    expect(() => parseConfig({ ...base, privacy: 'all' }, 'box')).toThrow(/config\.privacy/)
  })

  it('接受 off/notify/remote 三种中继', () => {
    expect(parseConfig({ ...base, questionRelay: 'notify' }, 'box').questionRelay).toBe('notify')
    expect(parseConfig({ ...base, approvalRelay: 'remote' }, 'box').approvalRelay).toBe('remote')
    expect(() => parseConfig({ ...base, questionRelay: 'always' }, 'box')).toThrow(/config\.questionRelay/)
    expect(() => parseConfig({ ...base, approvalRelay: 'always' }, 'box')).toThrow(/config\.approvalRelay/)
  })

  it('ringBufferMinutes 限制在 1..15 的整数', () => {
    expect(() => parseConfig({ ...base, ringBufferMinutes: Number.NaN }, 'box')).toThrow(/config\.ringBufferMinutes/)
    expect(() => parseConfig({ ...base, ringBufferMinutes: -1 }, 'box')).toThrow(/config\.ringBufferMinutes/)
    expect(() => parseConfig({ ...base, ringBufferMinutes: 1.5 }, 'box')).toThrow(/config\.ringBufferMinutes/)
    expect(() => parseConfig({ ...base, ringBufferMinutes: 30 }, 'box')).toThrow(/config\.ringBufferMinutes/)
    expect(parseConfig({ ...base, ringBufferMinutes: 5 }, 'box').ringBufferMinutes).toBe(5)
  })

  it('answerTimeoutMs 与 approvalTimeoutMs 限制在 15s..300s', () => {
    expect(() => parseConfig({ ...base, answerTimeoutMs: Number.NaN }, 'box')).toThrow(/config\.answerTimeoutMs/)
    expect(() => parseConfig({ ...base, answerTimeoutMs: 14_999 }, 'box')).toThrow(/config\.answerTimeoutMs/)
    expect(() => parseConfig({ ...base, answerTimeoutMs: 300_001 }, 'box')).toThrow(/config\.answerTimeoutMs/)
    expect(() => parseConfig({ ...base, approvalTimeoutMs: 1.5 }, 'box')).toThrow(/config\.approvalTimeoutMs/)
    expect(parseConfig({ ...base, approvalTimeoutMs: 20_000 }, 'box').approvalTimeoutMs).toBe(20_000)
  })

  it('agents 非空、唯一且每项非空', () => {
    expect(parseConfig({ ...base, agents: ['dsh', 'codex'] }, 'box').agents).toEqual(['dsh', 'codex'])
    expect(() => parseConfig({ ...base, agents: [] }, 'box')).toThrow(/at least one agent/)
    expect(() => parseConfig({ ...base, agents: ['dsh', 'dsh'] }, 'box')).toThrow(/duplicates/)
    expect(() => parseConfig({ ...base, agents: ['  '] }, 'box')).toThrow(/non-empty/)
  })

  it('redaction 必须是合法正则数组', () => {
    expect(() => parseConfig({ ...base, redaction: 'secret' }, 'box')).toThrow(/config\.redaction/)
    expect(() => parseConfig({ ...base, redaction: ['ok', 1] }, 'box')).toThrow(/config\.redaction\[1\]/)
    expect(() => parseConfig({ ...base, redaction: ['ok', '('] }, 'box'))
      .toThrow(/config\.redaction\[1\] is not a valid RegExp/)
    expect(parseConfig({ ...base, redaction: ['sk-[a-z0-9]+'] }, 'box').redaction)
      .toEqual(['sk-[a-z0-9]+'])
  })

  it('可选 executable 必须是非空字符串', () => {
    expect(parseConfig({ ...base, codexExecutable: '/opt/codex' }, 'box').codexExecutable).toBe('/opt/codex')
    expect(() => parseConfig({ ...base, claudeExecutable: '' }, 'box')).toThrow(/config\.claudeExecutable/)
  })

  it('devicesFile 必须是绝对路径且不展开 ~', () => {
    expect(parseConfig(hub, 'box').devicesFile).toMatch(/[\\/]\.dsh-marshal[\\/]devices\.json$/)
    expect(parseConfig({ ...hub, devicesFile: '/var/lib/marshal/devices.json' }, 'box').devicesFile)
      .toBe('/var/lib/marshal/devices.json')
    expect(() => parseConfig({ ...hub, devicesFile: 'devices.json' }, 'box')).toThrow(/absolute/)
    expect(() => parseConfig({ ...hub, devicesFile: '~/.dsh-marshal/devices.json' }, 'box')).toThrow(/literal "~"/)
  })

  it('allowDiscussion 必须是布尔值', () => {
    expect(parseConfig({ ...base, allowDiscussion: true }, 'box').allowDiscussion).toBe(true)
    expect(() => parseConfig({ ...base, allowDiscussion: 'yes' }, 'box')).toThrow(/config\.allowDiscussion/)
  })

  it('显式 null 不回退到默认值', () => {
    for (const key of [
      'privacy', 'questionRelay', 'approvalRelay', 'answerTimeoutMs', 'approvalTimeoutMs',
      'agents', 'ringBufferMinutes', 'deviceName', 'redaction', 'devicesFile', 'allowDiscussion',
    ]) {
      expect(() => parseConfig({ ...base, [key]: null }, 'box'), key).toThrow(new RegExp(key))
    }
    expect(() => parseConfig({ ...base, deviceId: null }, 'box')).toThrow(/deviceId/)
  })

  it('拒绝未知的 role', () => {
    expect(() => parseConfig({ role: 'server' }, 'box')).toThrow(/role/)
  })
})
