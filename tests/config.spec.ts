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

  it('拒绝非 ws(s) 的 hubUrl', () => {
    expect(() => parseConfig({ ...base, hubUrl: 'http://hub/marshal' }, 'box')).toThrow(/not a valid ws\(s\) URL/)
    expect(() => parseConfig({ ...base, hubUrl: 'wss://' }, 'box')).toThrow(/not a valid ws\(s\) URL/)
  })

  it('接受 ws:// 与 wss:// 的 hubUrl', () => {
    expect(parseConfig(base, 'box').hubUrl).toBe('wss://hub.example/marshal/uplink')
    expect(parseConfig({ ...base, hubUrl: 'ws://127.0.0.1:8787/marshal' }, 'box').hubUrl)
      .toBe('ws://127.0.0.1:8787/marshal')
  })

  it('空串或纯空白的 token 按缺失处理', () => {
    expect(() => parseConfig({ ...base, token: '' }, 'box')).toThrow(/missing token/)
    expect(() => parseConfig({ ...base, token: '   ' }, 'box')).toThrow(/missing token/)
  })

  it('空串或纯空白的 hubUrl 按缺失处理', () => {
    expect(() => parseConfig({ ...base, hubUrl: '   ' }, 'box')).toThrow(/missing hubUrl/)
  })

  it('拒绝未知的 privacy', () => {
    expect(() => parseConfig({ ...base, privacy: 'all' }, 'box')).toThrow(/config\.privacy/)
  })

  it('拒绝未知的 relay', () => {
    expect(() => parseConfig({ ...base, questionRelay: 'always' }, 'box')).toThrow(/config\.questionRelay/)
    expect(() => parseConfig({ ...base, approvalRelay: 'always' }, 'box')).toThrow(/config\.approvalRelay/)
  })

  it('ringBufferMinutes 必须是有限正整数', () => {
    expect(() => parseConfig({ ...base, ringBufferMinutes: Number.NaN }, 'box')).toThrow(/config\.ringBufferMinutes/)
    expect(() => parseConfig({ ...base, ringBufferMinutes: -1 }, 'box')).toThrow(/config\.ringBufferMinutes/)
    expect(() => parseConfig({ ...base, ringBufferMinutes: 1.5 }, 'box')).toThrow(/config\.ringBufferMinutes/)
    expect(parseConfig({ ...base, ringBufferMinutes: 30 }, 'box').ringBufferMinutes).toBe(30)
  })

  it('answerTimeoutMs 必须是有限正整数', () => {
    expect(() => parseConfig({ ...base, answerTimeoutMs: Number.NaN }, 'box')).toThrow(/config\.answerTimeoutMs/)
    expect(() => parseConfig({ ...base, answerTimeoutMs: 0 }, 'box')).toThrow(/config\.answerTimeoutMs/)
    expect(() => parseConfig({ ...base, answerTimeoutMs: 1.5 }, 'box')).toThrow(/config\.answerTimeoutMs/)
  })

  it('redaction 必须是字符串数组', () => {
    expect(() => parseConfig({ ...base, redaction: 'secret' }, 'box')).toThrow(/config\.redaction/)
    expect(() => parseConfig({ ...base, redaction: ['ok', 1] }, 'box')).toThrow(/config\.redaction\[1\]/)
    expect(parseConfig(base, 'box').redaction).toEqual([])
  })

  it('redaction 每项都必须是合法正则', () => {
    expect(() => parseConfig({ ...base, redaction: ['ok', '('] }, 'box'))
      .toThrow(/config\.redaction\[1\] is not a valid RegExp/)
    expect(parseConfig({ ...base, redaction: ['sk-[a-z0-9]+'] }, 'box').redaction)
      .toEqual(['sk-[a-z0-9]+'])
  })

  it('显式 null 不回退到默认值', () => {
    for (const key of ['privacy', 'questionRelay', 'approvalRelay', 'answerTimeoutMs', 'ringBufferMinutes', 'deviceName', 'redaction', 'devicesFile']) {
      expect(() => parseConfig({ ...base, [key]: null }, 'box'), key).toThrow(new RegExp(key))
    }
  })

  it('拒绝未知的 role', () => {
    expect(() => parseConfig({ role: 'server' }, 'box')).toThrow(/role/)
  })
})
