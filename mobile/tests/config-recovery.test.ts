import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeConfig, parseConfig } from '../src/lib/config.ts'
import { ConfigReadError, readConfig, updateConfig, writeNodePreference, writeTheme } from '../src/lib/storage.ts'

const key = 'dsh-marshal-mobile.config'
const legacy = makeConfig({ hubUrl: 'https://hub.example.test', label: '旧配置' })

for (const fault of ['getItem throws', 'malformed JSON', 'invalid parsed config']) {
  test(`config writes fail closed when ${fault}`, async t => {
    const existing = JSON.stringify({ ...legacy, privacyMode: 'metadata' })
    const items = new Map([[key, existing]])
    let readable = false
    const setItem = t.mock.fn((k: string, value: string) => { items.set(k, value) })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
      getItem: (k: string) => {
        if (k === key && !readable) {
          if (fault === 'getItem throws') throw new Error('storage unavailable')
          return fault === 'malformed JSON' ? '{"privacyMode":"metadata"' : '{"version":0,"privacyMode":"metadata"}'
        }
        return items.get(k) ?? null
      },
      setItem,
    } } })
    t.after(() => { Reflect.deleteProperty(globalThis, 'window') })

    assert.equal((await readConfig()).status, 'error')
    const change = t.mock.fn(() => ({ ...legacy, privacyMode: 'content' as const }))
    await assert.rejects(updateConfig(change), ConfigReadError)
    await assert.rejects(writeTheme('dark'), ConfigReadError)
    await assert.rejects(writeNodePreference({ dailySummaryCapK: 150 }), ConfigReadError)
    assert.equal(change.mock.callCount(), 0)
    assert.equal(setItem.mock.callCount(), 0)
    assert.equal(items.get(key), existing)

    readable = true
    const saved = await updateConfig(change)
    assert.equal(saved.privacyMode, 'metadata')
    assert.equal(parseConfig(JSON.parse(items.get(key)!))?.privacyMode, 'metadata')
  })
}

test('confirmed missing config can initialize; old configs and privacy fields round-trip', async t => {
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, value: string) => { items.set(k, value) },
  } } })
  t.after(() => { Reflect.deleteProperty(globalThis, 'window') })
  assert.deepEqual(await readConfig(), { status: 'missing' })
  await updateConfig(current => { assert.equal(current, null); return legacy })
  assert.equal(parseConfig(JSON.parse(items.get(key)!))?.label, '旧配置')
  await writeNodePreference({ tightenPrivacy: true })
  assert.equal(parseConfig(JSON.parse(items.get(key)!))?.privacyMode, 'metadata')
})
