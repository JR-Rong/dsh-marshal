import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decideDeepLink } from '../src/lib/deeplink.ts'
import { resolveSettingsToken, SETTINGS_TOKEN_PLACEHOLDER } from '../src/lib/settings-token.ts'
import { reduceActivity } from '../src/lib/activity.ts'
import { applyPinFailure, pinWaitMs, clearPinGuard, PIN_MAX_ATTEMPTS } from '../src/lib/lock.ts'

const configured = 'https://hub.example.com'
const attacker = 'https://evil.example'

test('锁屏时忽略深链，不改地址也不跳设置', () => {
  const decision = decideDeepLink({
    url: 'marshal://open?hub=' + encodeURIComponent(attacker),
    locked: true,
    configuredHub: configured,
  })
  assert.deepEqual(decision, { action: 'ignore' })
})

test('已配置 Hub 时，不同地址必须先确认', () => {
  const decision = decideDeepLink({
    url: 'marshal://open?hub=' + encodeURIComponent(attacker),
    locked: false,
    configuredHub: configured,
  })
  assert.deepEqual(decision, { action: 'confirm', hubUrl: attacker })
})

test('尚未配置时只预填地址', () => {
  const decision = decideDeepLink({
    url: 'marshal://open?hub=' + encodeURIComponent('hub.example.com/marshal'),
    locked: false,
    configuredHub: null,
  })
  assert.deepEqual(decision, { action: 'prefill', hubUrl: configured })
})

test('相同 Hub 不打断当前页面', () => {
  const decision = decideDeepLink({
    url: 'marshal://open?hub=' + encodeURIComponent(configured),
    locked: false,
    configuredHub: configured,
  })
  assert.deepEqual(decision, { action: 'same' })
})

test('非法深链静默忽略，坏地址给出错误', () => {
  assert.deepEqual(decideDeepLink({ url: 'not a url', locked: false, configuredHub: null }), { action: 'ignore' })
  const bad = decideDeepLink({
    url: 'marshal://open?hub=' + encodeURIComponent('http://hub.example.com'),
    locked: false,
    configuredHub: null,
  })
  assert.equal(bad.action, 'invalid')
})

test('设置页令牌输入永远是空的', () => {
  assert.equal(SETTINGS_TOKEN_PLACEHOLDER.includes('留空'), true)
  const kept = resolveSettingsToken({ typed: '', saved: 'a'.repeat(20), previousHub: configured, nextHub: configured })
  assert.deepEqual(kept, { ok: true, token: 'a'.repeat(20) })
})

test('更换 Hub 时不沿用已保存令牌', () => {
  const changed = resolveSettingsToken({ typed: '', saved: 'a'.repeat(20), previousHub: configured, nextHub: attacker })
  assert.equal(changed.ok, false)
  const typed = resolveSettingsToken({
    typed: 'b'.repeat(20), saved: 'a'.repeat(20), previousHub: configured, nextHub: attacker,
  })
  assert.deepEqual(typed, { ok: true, token: 'b'.repeat(20) })
})

test('回到前台仍保持锁定', () => {
  const background = reduceActivity('unlocked', true, false, false)
  assert.deepEqual(background, { phase: 'locked', seenInactive: true })
  const foreground = reduceActivity(background.phase, true, true, background.seenInactive)
  assert.equal(foreground.phase, 'locked')
})

test('没有应用锁时前后台都不锁', () => {
  const background = reduceActivity('unlocked', false, false, false)
  assert.equal(background.phase, 'unlocked')
  const foreground = reduceActivity(background.phase, false, true, background.seenInactive)
  assert.equal(foreground.phase, 'unlocked')
})

test('错误 PIN 指数退避，达到次数后进入长锁定', () => {
  let guard = clearPinGuard()
  const start = 1_000_000
  guard = applyPinFailure(guard, start)
  assert.equal(pinWaitMs(guard, start), 1_000)
  guard = applyPinFailure(guard, start + 1_000)
  assert.equal(pinWaitMs(guard, start + 1_000), 2_000)
  for (let count = guard.failures; count < PIN_MAX_ATTEMPTS; count += 1) {
    guard = applyPinFailure(guard, start + 10_000)
  }
  assert.ok(pinWaitMs(guard, start + 10_000) >= 60_000)
  assert.equal(pinWaitMs(clearPinGuard(), start), 0)
})

test('壳不再放行任意导航，Android 关闭备份', () => {
  const config = readFileSync(new URL('../capacitor.config.ts', import.meta.url), 'utf8')
  assert.equal(config.includes('allowNavigation'), false)
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
  assert.match(manifest, /android:allowBackup="false"/)
  const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
  const rules = gitignore.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  assert.equal(rules.includes('dist/'), false)
  assert.equal(rules.includes('/dist/'), true)
})

test('原生插件的 JS 入口已入库', () => {
  const pkg = JSON.parse(readFileSync(new URL('../plugins/marshal-stream/package.json', import.meta.url), 'utf8')) as { types: string; module: string }
  assert.equal(existsSync(new URL('../plugins/marshal-stream/' + pkg.types, import.meta.url)), true)
  assert.equal(existsSync(new URL('../plugins/marshal-stream/' + pkg.module, import.meta.url)), true)
})
