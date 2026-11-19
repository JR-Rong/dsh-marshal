import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffMessages, historyToMessage, type TranscriptMessage } from '../src/lib/transcript.ts'

function message(id: string, text: string, open = false): TranscriptMessage {
  return { id, role: 'assistant', text, open, at: 1 }
}

test('流式追加只产生增量更新，不要求整表重建', () => {
  const before = [message('a', '你')]
  const after = [message('a', '你好', true), message('b', '工具', false)]
  const diff = diffMessages(before, after)
  assert.equal(diff.kind, 'incremental')
  if (diff.kind !== 'incremental') return
  assert.deepEqual(diff.updates, [{ index: 0, text: '你好', open: true }])
  assert.equal(diff.appends.length, 1)
  assert.equal(diff.appends[0].id, 'b')
})

test('历史被替换时才整表重建', () => {
  const diff = diffMessages([message('a', '旧')], [message('b', '新')])
  assert.equal(diff.kind, 'rebuild')
})

test('历史条目映射保留原文', () => {
  const mapped = historyToMessage({ kind: 'user.message', seq: 3, ts: 10, payload: { text: '你好', itemId: 'm1' } })
  assert.equal(mapped?.text, '你好')
  assert.equal(mapped?.role, 'user')
  assert.equal(historyToMessage({ kind: 'message.delta', payload: { text: '' } }), null)
})
