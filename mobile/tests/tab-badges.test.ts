import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTabBadges, formatTabBadge, scheduleBoardPoll } from '../src/lib/tab-badges.ts'
import { createPendingInputs, inputTarget } from '../src/lib/pending-inputs.ts'

const a = { deviceId: 'a', agent: 'codex', sessionId: 'x' }
const b = { ...a, deviceId: 'b' }
const question = { requestId: 'question' }

test('empty tabs and offline status; only active work orders count', () => {
  assert.deepEqual(computeTabBadges([], [], true), { board: 0, sessions: 0, home: false })
  const tasks = ['todo', 'doing', 'attention', 'pending-confirmation', 'done', 'unknown'].map(status => ({ status }))
  assert.deepEqual(computeTabBadges(tasks, [], false), { board: 3, sessions: 0, home: true })
})

test('visible badge labels cap at 99+', () => {
  for (const [count, label] of [[0, ''], [1, '1'], [99, '99'], [100, '99+'], [300, '99+']] as const) {
    assert.equal(formatTabBadge(count), label)
  }
})

test('live input events count across sessions, deduplicate per session and exclude approvals', () => {
  const store = createPendingInputs()
  const target = inputTarget(b)!
  assert.equal(inputTarget({ ...a, sessionId: null }), null)
  store.update(a, question.requestId, question)
  store.update(a, question.requestId, question)
  store.update(target, question.requestId, question)
  store.update(target, 'approval', { requestId: 'approval', approval: { action: 'approve', decisions: [] } })
  assert.equal(store.cards(a).length, 1)
  assert.equal(store.cards(target).length, 2)
  assert.equal(computeTabBadges([], store.waitingCounts(), true).sessions, 2)
  store.update(a, question.requestId)
  assert.equal(computeTabBadges([], store.waitingCounts(), true).sessions, 1)
  store.remove(target)
  assert.equal(computeTabBadges([], store.waitingCounts(), true).sessions, 0)
})

test('reconnect snapshots recover unopened sessions, remove stale cards and preserve live changes', () => {
  const store = createPendingInputs()
  store.update(a, 'stale', { requestId: 'stale' })
  store.beginSnapshot(a)(undefined)
  assert.equal(store.cards(a).length, 1)
  const previous = store.beginSnapshot(a)
  const recoverA = store.beginSnapshot(a)
  const recoverB = store.beginSnapshot(b)
  store.update(a, question.requestId)
  store.update(b, 'new', { requestId: 'new' })
  recoverA([question])
  recoverB([{ requestId: 'missed' }])
  previous([{ requestId: 'old-snapshot' }])
  assert.deepEqual(store.cards(a), [])
  assert.deepEqual(store.cards(b).map(card => card.requestId), ['missed', 'new'])
  const inFlight = store.beginSnapshot(b)
  store.remove(b)
  inFlight([question])
  assert.deepEqual(store.cards(b), [])
})

test('board poll refreshes badges without queued receipts, accelerates awaiting receipt, and pauses when inactive', () => {
  let online = true
  let status = 'todo'
  let badge = 0
  const poll = (queued: boolean, expectedDelay: number) => scheduleBoardPoll(queued, () => online, () => {
    badge = computeTabBadges([{ status }], [], true).board
  }, (callback, delay) => {
    assert.equal(delay, expectedDelay)
    return callback
  })
  const tick = poll(false, 30_000)
  status = 'doing'
  tick()
  assert.equal(badge, 1)
  const receiptTick = poll(true, 3_000)
  status = 'done'
  online = false
  receiptTick()
  assert.equal(badge, 1)
  online = true
  poll(false, 30_000)()
  assert.equal(badge, 0)
})
