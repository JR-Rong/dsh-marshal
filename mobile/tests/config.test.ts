import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONFIG_VERSION, consoleUrl, hubLabel, makeConfig, normalizeHubUrl, normalizeToken, parseConfig,
} from '../src/lib/config.ts'

test('缺协议时补 https，并裁到 origin', () => {
  const result = normalizeHubUrl('hub.example.com')
  assert.deepEqual(result, { ok: true, value: 'https://hub.example.com' })
})

test('粘贴带 /marshal 的完整地址也能收敛到 origin', () => {
  const result = normalizeHubUrl('https://hub.example.com/marshal?token=abc')
  assert.deepEqual(result, { ok: true, value: 'https://hub.example.com' })
})

test('拒绝非 http(s) 协议', () => {
  const result = normalizeHubUrl('ftp://hub.example.com')
  assert.equal(result.ok, false)
})

test('公网地址强制 https', () => {
  const result = normalizeHubUrl('http://hub.example.com')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /https/)
})

test('本机与局域网允许 http', () => {
  assert.deepEqual(normalizeHubUrl('http://localhost:8080'), { ok: true, value: 'http://localhost:8080' })
  assert.deepEqual(normalizeHubUrl('http://192.168.1.102:48443'), { ok: true, value: 'http://192.168.1.102:48443' })
})

test('拒绝带账号密码的地址', () => {
  assert.equal(normalizeHubUrl('https://user:pass@hub.example.com').ok, false)
})

test('空地址给出明确提示', () => {
  const result = normalizeHubUrl('   ')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /填写/)
})

test('consoleUrl 与 hubLabel', () => {
  assert.equal(consoleUrl('https://hub.example.com/'), 'https://hub.example.com/marshal')
  assert.equal(hubLabel('https://hub.example.com'), 'hub.example.com')
})

test('令牌长度与空白校验', () => {
  assert.equal(normalizeToken('').ok, true)
  assert.equal(normalizeToken('short').ok, false)
  assert.equal(normalizeToken('0123456789abcdef').ok, true)
  assert.equal(normalizeToken('0123 456789abcdef').ok, false)
})

test('parseConfig 丢弃坏数据并保留好数据', () => {
  assert.equal(parseConfig(null), null)
  assert.equal(parseConfig({ version: 99, hubUrl: 'https://h.example' }), null)
  assert.equal(parseConfig({ version: CONFIG_VERSION, hubUrl: 'ftp://x' }), null)
  const good = parseConfig({
    version: CONFIG_VERSION,
    hubUrl: 'https://hub.example.com/marshal',
    token: '0123456789abcdef',
    label: '生产',
    lock: { salt: 'c2FsdA==', hash: 'aGFzaA==', iterations: 210000 },
    updatedAt: 1700000000000,
  })
  assert.ok(good)
  assert.equal(good?.hubUrl, 'https://hub.example.com')
  assert.equal(good?.lock?.iterations, 210000)
})

test('makeConfig 生成当前版本配置', () => {
  const config = makeConfig({ hubUrl: 'https://hub.example.com', token: 't', label: 'x' })
  assert.equal(config.version, CONFIG_VERSION)
  assert.equal(config.lock, null)
})
