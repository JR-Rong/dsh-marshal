import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Capacitor } from '@capacitor/core'
import { SecureStorageWeb } from '../node_modules/@aparajita/capacitor-secure-storage/dist/esm/web.js'
import { makeConfig } from '../src/lib/config.ts'
import { readConfig, writeNodePreference } from '../src/lib/storage.ts'
import { createSummaryCapDraft, renderSummaryCap } from '../src/lib/summary-cap.ts'

class ElementStub extends EventTarget {
  children: (ElementStub | string)[] = []
  value = ''
  get valueAsNumber() { return Number(this.value) }
  append(...children: (ElementStub | string)[]) { this.children.push(...children) }
  setAttribute() {}
}

test('Tab 4 quota slider remounts from draft during delayed device refresh and persists newest value in order', async t => {
  const initial = { ...makeConfig({ hubUrl: 'https://hub.example.test' }), dailySummaryCapK: 50 }
  let raw = JSON.stringify(initial)
  const attempts: number[] = []
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  t.mock.method(Capacitor, 'isNativePlatform', () => true)
  // Capacitor uses the web adapter under Node; delay its underlying async write.
  t.mock.method(SecureStorageWeb.prototype, 'internalGetItem', async () => ({ data: raw }))
  t.mock.method(SecureStorageWeb.prototype, 'internalSetItem', async ({ data: value }: { data: string }) => {
    attempts.push(JSON.parse(value).dailySummaryCapK)
    if (attempts.length === 1) {
      firstStarted.resolve()
      await releaseFirst.promise
    }
    raw = value
  })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new ElementStub() } })
  t.after(() => { Reflect.deleteProperty(globalThis, 'document') })

  const model = createSummaryCapDraft()
  const pending: Promise<boolean>[] = []
  const save = (value: number) => {
    pending.push(model.save(value, cap => writeNodePreference({ dailySummaryCapK: cap }), assert.fail))
  }
  const drawSlider = () => (renderSummaryCap(model, initial.dailySummaryCapK, save) as unknown as ElementStub)
    .children[1] as ElementStub
  const move = (slider: ElementStub, value: number) => {
    slider.value = String(value)
    slider.dispatchEvent(new Event('input'))
  }
  const oldSlider = drawSlider()
  move(oldSlider, 90)
  assert.equal(drawSlider().value, '90', 'remount while editing')
  oldSlider.dispatchEvent(new Event('change'))
  await firstStarted.promise
  const refreshedSlider = drawSlider()
  assert.notEqual(refreshedSlider, oldSlider)
  assert.equal(refreshedSlider.value, '90', 'remount while native write is pending')
  move(refreshedSlider, 140)
  refreshedSlider.dispatchEvent(new Event('change'))
  assert.deepEqual(attempts, [90])
  assert.equal(drawSlider().value, '140')

  releaseFirst.resolve()
  assert.deepEqual(await Promise.all(pending), [false, true])
  assert.deepEqual(attempts, [90, 140])
  assert.equal(drawSlider().value, '140')
  assert.deepEqual(model.view(50), { value: 140, status: 'saved' })
  assert.equal(oldSlider.value, '90')
  const stored = await readConfig()
  assert.equal(stored.status, 'ok')
  assert.equal(stored.config.dailySummaryCapK, 140)
})
