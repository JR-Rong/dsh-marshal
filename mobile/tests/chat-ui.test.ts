import assert from 'node:assert/strict'
import test from 'node:test'
import { categorizeSession, filterSessionsByCategory, initialWizardState, moveWizardStep, selectWizardHost,
  validateWizardState, WELCOME_STARTERS, sessionCenterRoute, groupBackCategory, roomRetryId,
  beginCreateAttempt, finishCreateAttempt, canCloseCreateSheet, isWelcomeEmpty, isUnconfirmedEmpty,
  fillWelcomeStarter } from '../src/lib/chat-ui.ts'

test('ticket-linked rooms take priority over both kinds; categories are exclusive', () => {
  const rows = [
    { id: 'a', kind: 'single' }, { id: 'b', kind: 'group' },
    { id: 'c', kind: 'group', ticketRoom: true }, { id: 'd', kind: 'single', ticketRoom: true },
  ] as const
  assert.deepEqual(rows.map(categorizeSession), ['single', 'group', 'ticketRoom', 'ticketRoom'])
  assert.deepEqual(filterSessionsByCategory(rows, 'single'), [rows[0]])
  assert.deepEqual(filterSessionsByCategory(rows, 'group'), [rows[1]])
  assert.deepEqual(filterSessionsByCategory(rows, 'ticketRoom'), rows.slice(2))
})

test('single wizard requires a host and its engine before the optional cwd step', () => {
  const start = initialWizardState()
  assert.equal(start.mode, 'single')
  assert.equal(start.step, 'host')
  assert.deepEqual(Object.keys(validateWizardState(start)), ['deviceId', 'engineOrAgentId'])
  assert.equal(moveWizardStep(start, 'agent'), start)
  const host = selectWizardHost(start, 'host-a')
  assert.equal(host.mode, 'single')
  assert.deepEqual(moveWizardStep(host, 'agent'), { ...host, step: 'agent' })
  assert.equal(moveWizardStep(host, 'cwd'), host)
  const ready = { ...host, engineOrAgentId: 'codex' }
  assert.deepEqual(moveWizardStep(ready, 'cwd'), { ...ready, step: 'cwd' })
  assert.deepEqual(validateWizardState(ready), {})
  assert.deepEqual(validateWizardState({ ...ready, cwd: '/workspace' }), {})
  assert.ok(validateWizardState({ ...ready, engineOrAgentId: ' ' }).engineOrAgentId)
  assert.ok(validateWizardState({ ...ready, cwd: 'x'.repeat(4097) }).cwd)
  assert.deepEqual(selectWizardHost({ ...ready, cwd: '/workspace' }, 'host-b'), {
    ...start, deviceId: 'host-b', cwd: undefined,
  })
})

test('group wizard delegates without requiring single-session fields', () => {
  const group = initialWizardState('group')
  assert.deepEqual(group, { mode: 'group' })
  assert.deepEqual(validateWizardState(group), {})
  assert.equal(moveWizardStep(group, 'cwd'), group)
})

test('welcome has exactly three distinct prompts', () => {
  assert.equal(WELCOME_STARTERS.length, 3)
  assert.equal(new Set(WELCOME_STARTERS).size, 3)
})

test('legacy groups entry selects Agent groups; room back preserves the ticket segment', () => {
  assert.deepEqual(sessionCenterRoute(), { view: 'groups', category: 'group' })
  assert.deepEqual(sessionCenterRoute('single'), { view: 'sessions', category: 'single' })
  assert.deepEqual(sessionCenterRoute(groupBackCategory('groupRoom', 'ticketRoom')), { view: 'groups', category: 'ticketRoom' })
  assert.deepEqual(sessionCenterRoute(groupBackCategory('groupNew', 'single')), { view: 'groups', category: 'group' })
})

test('failed ticket-room load can retry its requested ID, but not while busy or already loaded', () => {
  const requestedId = 'ticket-room-a'
  assert.equal(roomRetryId(null, requestedId, true), null)
  assert.equal(roomRetryId(null, requestedId, false), requestedId)
  assert.equal(roomRetryId({ id: requestedId }, requestedId, false), null)
  assert.equal(roomRetryId(null, null, false), null)
})

test('create blocks dismissal in flight and reuses the key after ambiguous failure or reopening', () => {
  const keys = new Map<string, string>()
  const pending = beginCreateAttempt(keys, 'same-request', () => 'first-key')
  assert.equal(canCloseCreateSheet(pending), false)
  const unknown = finishCreateAttempt(keys, 'same-request', pending, false)
  assert.equal(canCloseCreateSheet(unknown), true)
  assert.equal(unknown.key, pending.key)
  const retried = beginCreateAttempt(keys, 'same-request', () => 'second-key')
  assert.equal(retried.key, pending.key)
  assert.equal(canCloseCreateSheet(retried), false)
  assert.equal(canCloseCreateSheet(finishCreateAttempt(keys, 'same-request', retried, true)), true)
  assert.equal(beginCreateAttempt(keys, 'same-request', () => 'second-key').key, 'second-key')
})

test('welcome only appears after history confirms the session is empty', () => {
  assert.equal(isWelcomeEmpty('loading', 0, 0, false), false)
  assert.equal(isWelcomeEmpty('error', 0, 0, false), false)
  assert.equal(isWelcomeEmpty('ready', 0, 0, false), true)
  assert.equal(isWelcomeEmpty('ready', 1, 0, false), false)
  assert.equal(isWelcomeEmpty('ready', 0, 1, false), false)
  assert.equal(isWelcomeEmpty('ready', 0, 0, true), false)
  assert.equal(isUnconfirmedEmpty('unconfirmed', 0, false), true)
  assert.equal(isUnconfirmedEmpty('complete', 0, false), false)
  assert.equal(isUnconfirmedEmpty('unconfirmed', 0, true), false)
})

test('welcome suggestions populate both the composer and draft and focus the input', () => {
  for (const starter of WELCOME_STARTERS) {
    let focused = false
    const input = { value: '', focus() { focused = true } }
    const draft = fillWelcomeStarter(input, starter)
    assert.equal(input.value, starter)
    assert.equal(draft, starter)
    assert.equal(focused, true)
  }
})
