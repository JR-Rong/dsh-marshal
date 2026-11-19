import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPairing, parseUnifiedPairing } from '../src/lib/bridge.ts'

const token = (ch: string) => ch.repeat(64)

function unified(overrides: Record<string, unknown> = {}): string {
  const payload = {
    v: 1,
    hub: 'https://hub.example.com',
    hubToken: token('h'),
    ticket: 'k'.repeat(43),
    bridge: 'ws://127.0.0.1:1234/ios/v1',
    bridgeToken: 'b'.repeat(43),
    ...overrides,
  }
  return 'marshal://setup?payload=' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

test('parseUnifiedPairing 解析一码并分类', () => {
  const link = unified()
  assert.equal(classifyPairing(link), 'unified')
  const parsed = parseUnifiedPairing(link)
  assert.ok(parsed)
  assert.equal(parsed.hub, 'https://hub.example.com')
  assert.equal(parsed.hubToken.length, 64)
  assert.equal(parsed.ticket?.length, 43)
  assert.equal(parsed.bridge, 'ws://127.0.0.1:1234/ios/v1')
  assert.equal(parsed.bridgeToken.length, 43)
})

test('parseUnifiedPairing 拒绝缺字段/坏地址', () => {
  assert.equal(parseUnifiedPairing(unified({ hub: 'ftp://bad' })), null)
  assert.equal(parseUnifiedPairing(unified({ bridge: 'http://bad' })), null)
  assert.equal(parseUnifiedPairing(unified({ hubToken: 'short' })), null)
  assert.equal(parseUnifiedPairing('marshal://setup?payload=not-base64'), null)
  assert.equal(classifyPairing(unified({ bridge: 'http://bad' })), 'hub')
})
