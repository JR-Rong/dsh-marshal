import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideDeepLink, linkCarriesSecret, parsePairingLink } from '../src/lib/deeplink.ts'
import { pinDelay } from '../src/lib/lock.ts'

test('a locked phone ignores a hub deep link', () => {
  const decision = decideDeepLink({
    url: 'marshal://open?hub=https%3A%2F%2Fevil.example',
    locked: true,
    configuredHub: 'https://hub.example',
  })
  assert.equal(decision.action, 'ignore')
})

test('secret pairing links are ignored even when the phone is unlocked', () => {
  assert.equal(linkCarriesSecret('marshal://setup?payload=abc'), true)
  assert.equal(linkCarriesSecret('marshal://open?hub=https%3A%2F%2Fhub.example&token=secret'), true)
  const decision = decideDeepLink({
    url: 'marshal://open?hub=https%3A%2F%2Fevil.example&token=secret',
    locked: false,
    configuredHub: 'https://hub.example',
  })
  assert.equal(decision.action, 'ignore')
})

test('a pair link keeps only the code and the hub', () => {
  const parsed = parsePairingLink('marshal://pair?code=abc123&hub=https%3A%2F%2Fhub.example')
  assert.deepEqual(parsed, { code: 'abc123', hubUrl: 'https://hub.example' })
})

test('the fifth wrong PIN waits at least a minute', () => {
  assert.equal(pinDelay(1), 1_000)
  assert.equal(pinDelay(2), 2_000)
  assert.ok(pinDelay(5) >= 60_000)
})
