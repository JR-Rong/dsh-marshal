import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeConfig, MOBILE_THEMES, normalizeTheme, parseConfig } from '../src/lib/config.ts'
import { readConfig, readTheme, writeConfig, writeTheme } from '../src/lib/storage.ts'

const legacy = makeConfig({ hubUrl: 'https://hub.example.test' })

test('theme normalization preserves official values and defaults invalid/legacy values to system', () => {
  assert.deepEqual(MOBILE_THEMES, ['system', 'deepseek', 'white', 'dark', 'codex'])
  assert.equal(parseConfig(legacy)?.theme, undefined)
  for (const value of [undefined, null, '', 'oled', 'DARK', { theme: 'dark' }, 123]) {
    assert.equal(normalizeTheme(value), 'system')
    assert.equal(parseConfig({ ...legacy, theme: value })?.theme, undefined)
  }
  for (const theme of MOBILE_THEMES) {
    assert.equal(normalizeTheme(theme), theme)
    assert.equal(parseConfig({ ...legacy, theme })?.theme, theme)
  }
})

test('theme persists before pairing, is adopted by the first config, and survives rapid switching and subsequent config writes', async (t) => {
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value) },
    },
  } })
  t.after(() => { Reflect.deleteProperty(globalThis, 'window') })

  assert.equal(readTheme(), 'system')
  assert.equal(readTheme({ ...legacy, theme: 'dark' }), 'dark')
  items.set('dsh-marshal-mobile.theme', 'invalid')
  assert.equal(readTheme(), 'system')
  await writeTheme('deepseek')
  assert.equal(items.get('dsh-marshal-mobile.theme'), 'deepseek')
  assert.equal(readTheme(), 'deepseek')
  assert.equal(await readConfig(), null)
  await writeConfig(legacy)
  assert.equal((await readConfig())?.theme, 'deepseek')
  await Promise.all([writeTheme('dark'), writeTheme('codex'), writeConfig({ ...legacy, label: 'test' })])
  assert.equal(readTheme(), 'codex')
  assert.equal((await readConfig())?.theme, 'codex')
  assert.equal((await readConfig())?.label, 'test')
  await writeTheme('system')
  assert.equal((await readConfig())?.theme, 'system')
})

test('paired native theme survives a stale cache after a failed cache write and restart', async (t) => {
  const { Capacitor } = await import('@capacitor/core')
  const secure = new Map([['capacitor-storage_dsh-marshal-mobile.config', JSON.stringify({ ...legacy, theme: 'dark' })]])
  t.mock.method(Capacitor, 'isNativePlatform', () => true)
  // In Node the plugin uses its web adapter; give that adapter a separate fake
  // store that stands in for the keychain, not the failing preference cache.
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => secure.get(key) ?? null,
    setItem: (key: string, value: string) => { secure.set(key, value) },
  } })
  t.after(() => { Reflect.deleteProperty(globalThis, 'localStorage') })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { getItem: () => 'dark', setItem: () => { throw new Error('cache unavailable') } },
  } })
  t.after(() => { Reflect.deleteProperty(globalThis, 'window') })
  await writeTheme('codex')
  const restarted = await import('../src/lib/storage.ts?restart')
  assert.equal(restarted.readTheme(), 'dark')
  assert.equal(restarted.readTheme(await restarted.readConfig()), 'codex')
  await restarted.writeConfig({ ...legacy, theme: 'dark', label: 'updated' })
  assert.equal((await restarted.readConfig())?.theme, 'codex')
})
