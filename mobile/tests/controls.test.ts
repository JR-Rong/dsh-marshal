import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPromptArgs, formatTokens, parseControls, parseUploadReceipt,
  planUploadChunks, randomUuid,
} from '../src/lib/marshal.ts'

test('parseControls 读取命令结果里的 controls', () => {
  const parsed = parseControls({
    controls: {
      models: [
        { id: 'deepseek-account/deepseek-flash', label: 'Flash', efforts: ['off', 'low', 'high'] },
        { id: 'm2', label: '', efforts: ['off', 7] },
      ],
      current: { model: 'deepseek-account/deepseek-flash', reasoning: 'low' },
    },
  })
  assert.deepEqual(parsed, {
    models: [
      { id: 'deepseek-account/deepseek-flash', label: 'Flash', efforts: ['off', 'low', 'high'] },
      { id: 'm2', label: 'm2', efforts: ['off'] },
    ],
    current: { model: 'deepseek-account/deepseek-flash', reasoning: 'low' },
  })
})

test('parseControls 兼容直接对象与缺省 current', () => {
  assert.deepEqual(parseControls({ models: [{ id: 'a', label: 'A', efforts: [] }] }), {
    models: [{ id: 'a', label: 'A', efforts: [] }],
    current: {},
  })
})

test('parseControls 拒绝坏输入', () => {
  assert.equal(parseControls(null), null)
  assert.equal(parseControls('x'), null)
  assert.equal(parseControls([]), null)
  assert.deepEqual(parseControls({ models: [null, { id: '' }, { id: 'ok', label: 'OK' }] }), {
    models: [{ id: 'ok', label: 'OK', efforts: [] }],
    current: {},
  })
})

test('buildPromptArgs 只在有值时带 options / attachments', () => {
  assert.deepEqual(buildPromptArgs('hi'), { text: 'hi' })
  assert.deepEqual(buildPromptArgs('hi', { model: 'm', reasoning: 'low' }), {
    text: 'hi', options: { model: 'm', reasoning: 'low' },
  })
  assert.deepEqual(buildPromptArgs('hi', { model: '', reasoning: ' low ' }), {
    text: 'hi', options: { reasoning: 'low' },
  })
  assert.deepEqual(buildPromptArgs('hi', {}, ['a', 'b']), { text: 'hi', attachments: ['a', 'b'] })
  assert.deepEqual(buildPromptArgs('hi', {}, []), { text: 'hi' })
})

test('planUploadChunks 覆盖全部字节且末片收尾', () => {
  assert.deepEqual(planUploadChunks(0), [{ offset: 0, length: 0 }])
  assert.deepEqual(planUploadChunks(3, 2), [{ offset: 0, length: 2 }, { offset: 2, length: 1 }])
  const size = 600 * 1024
  const chunks = planUploadChunks(size)
  assert.equal(chunks[0].offset, 0)
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.length, 0), size)
  assert.ok(chunks.every((chunk) => chunk.length <= 256 * 1024))
  assert.equal(chunks.at(-1)!.offset + chunks.at(-1)!.length, size)
})

test('parseUploadReceipt 校验 attachmentId 与 complete', () => {
  assert.deepEqual(parseUploadReceipt({ attachmentId: 'x', bytes: 3, complete: true }), {
    attachmentId: 'x', bytes: 3, complete: true,
  })
  assert.equal(parseUploadReceipt({ attachmentId: '', bytes: 3, complete: true }), null)
  assert.equal(parseUploadReceipt(null), null)
})

test('formatTokens 用 k/M 缩写', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1500), '1.5k')
  assert.equal(formatTokens(1_000_000), '1M')
  assert.equal(formatTokens(2_350_000), '2.4M')
  assert.equal(formatTokens(undefined), '—')
})

test('randomUuid 产出 UUID v4 形状', () => {
  assert.match(randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
