import { test } from 'node:test'
import assert from 'node:assert/strict'
import { livePhaseAfterApproval } from '../src/lib/live.ts'

test('resolving an approval updates a running Live Activity instead of ending it', () => {
  assert.deepEqual(livePhaseAfterApproval(true), { title: '运行中', phase: 'run', end: false })
  assert.deepEqual(livePhaseAfterApproval(false), { title: '已处理', phase: 'done', end: true })
})
