import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { commandNeedsPoll } from '../src/lib/marshal.ts'
import { nextPinGuard } from '../src/lib/lock.ts'

const root = new URL('../', import.meta.url)

test('navigation, mixed content, cleartext and backup are closed', () => {
  const config = readFileSync(new URL('./capacitor.config.ts', root), 'utf8')
  const manifest = readFileSync(new URL('./android/app/src/main/AndroidManifest.xml', root), 'utf8')
  const project = readFileSync(new URL('./ios/App/App.xcodeproj/project.pbxproj', root), 'utf8')
  assert.equal(config.includes('allowNavigation'), false)
  assert.equal(config.includes('allowMixedContent'), false)
  assert.equal(manifest.includes('android:usesCleartextTraffic="false"'), true)
  assert.equal(manifest.includes('android:allowBackup="false"'), true)
  assert.equal(manifest.includes('android.permission.POST_NOTIFICATIONS'), true)
  assert.equal(project.includes('LiveActivity'), true)
  assert.equal(project.includes('App.entitlements'), true)
})

test('202 and unknown outcomes still need a status poll', () => {
  assert.equal(commandNeedsPoll({ status: 'pending-confirmation' }), true)
  assert.equal(commandNeedsPoll({ status: 'outcome-unknown' }), true)
  assert.equal(commandNeedsPoll({ status: 'accepted' }), false)
})

test('PIN backoff is a value that can be stored and resumed', () => {
  const first = nextPinGuard(0, 1_000)
  const stored = JSON.parse(JSON.stringify(first)) as { failures: number; until: number }
  assert.equal(stored.failures, 1)
  assert.equal(stored.until, 2_000)
  const fifth = nextPinGuard(4, 10_000)
  assert.ok(fifth.until - 10_000 >= 60_000)
})
