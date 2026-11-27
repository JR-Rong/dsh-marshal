import assert from 'node:assert/strict'
import test from 'node:test'
import { MarshalApi } from '../src/lib/marshal.ts'
import { categorizeSession, filterSessionsByCategory, initialWizardState, moveWizardStep, selectWizardHost,
  validateWizardState, WELCOME_STARTERS, sessionCenterRoute, groupBackCategory, roomRetryId, createGroupRequests,
  beginCreateAttempt, finishCreateAttempt, canCloseCreateSheet, isWelcomeEmpty, isUnconfirmedEmpty,
  fillWelcomeStarter, shouldTriggerOlderHistory, preserveScrollAnchor, mergeTranscriptSnapshot,
  appendTranscriptDelta, historyPageProgress, buildEffortSheetOptions, formatThoughtSummary } from '../src/lib/chat-ui.ts'

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

test('older history needs an upward gesture near the top and an available cursor', () => {
  const base = { loading: false, hasCursor: true }
  const check = (gesture: Parameters<typeof shouldTriggerOlderHistory>[0]) => shouldTriggerOlderHistory(gesture)
  assert.equal(check({ ...base, scrollTop: 8, prevScrollTop: 9 }), true)
  assert.equal(check({ ...base, scrollTop: 9, prevScrollTop: 10 }), false)
  assert.equal(check({ ...base, scrollTop: 8, prevScrollTop: 8 }), false)
  assert.equal(check({ ...base, scrollTop: 8, prevScrollTop: 7 }), false)
  assert.equal(check({ ...base, scrollTop: 2, deltaY: -13 }), true)
  assert.equal(check({ ...base, scrollTop: 2, deltaY: -12 }), false)
  assert.equal(check({ ...base, scrollTop: 3, deltaY: -40 }), false)
  assert.equal(check({ ...base, scrollTop: -1, touchPullDy: 29 }), true)
  assert.equal(check({ ...base, scrollTop: 0, touchPullDy: 28 }), false)
  assert.equal(check({ ...base, scrollTop: 0, touchPullDy: -40, deltaY: 40 }), false)
  assert.equal(check({ ...base, scrollTop: 0, deltaY: -40, loading: true }), false)
  assert.equal(check({ ...base, scrollTop: 0, deltaY: -40, hasCursor: false }), false)
})

test('prepending adds only the height difference and clamps to the start', () => {
  assert.equal(preserveScrollAnchor(600, 880, 17), 297)
  assert.equal(preserveScrollAnchor(600, 600, 17), 17)
  assert.equal(preserveScrollAnchor(600, 580, 17), 0)
})

const reply = { id: 'a', role: 'assistant', text: 'AB', open: false, at: 1000 }

test('snapshot first: real subsequent SSE deltas are preserved even when repeating snapshot text', () => {
  const [snapshot] = mergeTranscriptSnapshot([{ ...reply, text: 'foo ' }], [])
  const delta = appendTranscriptDelta(snapshot, 'foo ')
  assert.equal(delta.text, 'foo foo ')
  assert.equal(delta.open, true)
  assert.equal(appendTranscriptDelta(delta, 'bar').text, 'foo foo bar')
})

test('SSE first: a later snapshot merges the same item, keeps subsequent deltas, and closes on completed snapshot', () => {
  const live = appendTranscriptDelta({ ...reply, text: '', at: 2000 }, 'A')
  const reason = { ...reply, role: 'reason', text: '推理', at: 2000 }
  const merged = mergeTranscriptSnapshot([reply], [live, reason])
  assert.equal(merged.length, 2)
  assert.equal(merged[0].text, 'AB')
  assert.equal(merged[0].open, true)
  assert.equal(appendTranscriptDelta(merged[0], 'B').text, 'AB')
  assert.equal(appendTranscriptDelta(appendTranscriptDelta(merged[0], 'B'), 'C').text, 'ABC')
  assert.deepEqual(merged[1], reason)
  const full = appendTranscriptDelta(live, 'BC')
  assert.equal(mergeTranscriptSnapshot([reply], [full])[0].text, 'ABC')
  const completed = mergeTranscriptSnapshot([{ ...reply, text: 'AB final', completed: true }], [live])[0]
  assert.equal(completed.text, 'AB final')
  assert.equal(completed.open, false)
  assert.equal(completed.completed, true)
  const emptySnapshot = mergeTranscriptSnapshot([], [live])
  assert.deepEqual(emptySnapshot, [live])
  assert.equal(isWelcomeEmpty('ready', 0, emptySnapshot.length, false), false)
})

test('latest window keeps older messages ahead of the window and new SSE after it', () => {
  const row = (at: number) => ({ ...reply, id: String(at), at })
  const keys = (rows: ReturnType<typeof row>[]) => rows.map(r => r.id)
  assert.deepEqual(keys(mergeTranscriptSnapshot([row(41), row(42)], [row(39), row(40), row(43)])),
    ['39', '40', '41', '42', '43'])
  const older = { ...row(40), at: 100 } // Some adapters timestamp at fetch time.
  const paged = mergeTranscriptSnapshot([older, row(41)], [row(41), row(42)], { prepend: true })
  assert.deepEqual(keys(mergeTranscriptSnapshot([row(41), row(42), row(43)], paged)), ['40', '41', '42', '43'])
})

test('snapshot acknowledges local user bubbles only when not older than the send, while live events match directly', () => {
  const local = { ...reply, id: 'local-1', role: 'user', text: '重复提问', at: 1000, retryKey: 'retry', failed: true }
  const another = { ...local, id: 'local-2' }
  const olderRemote = { ...reply, id: 'remote-old', role: 'user', text: local.text, at: 500 }
  const withOlder = mergeTranscriptSnapshot([olderRemote], [local])
  assert.deepEqual(withOlder, [olderRemote, local])
  const remote = { ...reply, id: 'remote-1', role: 'user', text: local.text, at: 1000 }
  const merged = mergeTranscriptSnapshot([remote], [local, another])
  assert.deepEqual(merged, [remote, another])
  assert.deepEqual(mergeTranscriptSnapshot([remote], merged), merged)
  assert.deepEqual(mergeTranscriptSnapshot([remote], [local], { prepend: true }), [remote, local])
  const liveAck = mergeTranscriptSnapshot([{ ...olderRemote, id: 'remote-live' }], [local], { liveEvent: true })
  assert.equal(liveAck.length, 1)
  assert.equal(liveAck[0].id, 'remote-live')
})

test('stalled and cycling pagination stop automatic loading without reporting all history loaded', () => {
  const stalled = { cursor: null, reachedStart: false, notice: '历史分页未推进，已暂停加载' }
  assert.deepEqual(historyPageProgress('x', 'x', 'complete', new Set()), stalled)
  assert.deepEqual(historyPageProgress('y', 'x', 'unconfirmed', new Set(['x'])), stalled)
  assert.deepEqual(historyPageProgress('x', 'y', 'unconfirmed', new Set()), { cursor: 'y', reachedStart: false, notice: '' })
  assert.deepEqual(historyPageProgress('x', undefined, 'complete', new Set()), { cursor: null, reachedStart: true, notice: '' })
  assert.equal(historyPageProgress('x', undefined, 'unconfirmed', new Set()).reachedStart, false)
})

test('effort sheet returns a single ordered list filtered by model capability, with a text badge', () => {
  const rows = buildEffortSheetOptions(['high', 'off', 'low', 'medium', 'low'], 'high')
  assert.deepEqual(rows.map(({ label, badge }) => [label, badge]), [
    ['关闭', ''], ['低', ''], ['中', ''], ['高', '当前'],
  ])
  assert.deepEqual(buildEffortSheetOptions(['medium'], 'off').map(({ id, badge }) => [id, badge]), [['medium', '']])
  assert.deepEqual(buildEffortSheetOptions([], 'off'), [])
  assert.doesNotMatch(JSON.stringify(rows), /[\u2713\u2611]/u)
})

test('thought summary distinguishes streaming, elapsed and saved completion time', () => {
  assert.equal(formatThoughtSummary({ open: true, at: 1000 }, 6000), '正在深度思考…')
  assert.equal(formatThoughtSummary({ open: false, at: 1000 }, 6000), '已深度思考 ›')
  assert.equal(formatThoughtSummary({ open: false, at: 1000, endedAt: 6000 }, 20_000), '已深度思考 5 秒 ›')
  assert.equal(formatThoughtSummary({ open: false, at: 1000, endedAt: 1000 }), '已深度思考 ›')
  assert.equal(formatThoughtSummary({ open: false, endedAt: 1000 }), '已深度思考 ›')
  assert.equal(formatThoughtSummary({ open: false }), '已深度思考 ›')
})

for (const status of [401, 403]) for (const source of ['poll', 'send']) {
  test(`${source} ${status}: room recovery`, async t => {
    const room = { id: 'room' }
    const state = { room, groupBusy: false }
    let stopped = false
    const requests = createGroupRequests(state, () => { stopped = true })
    const api = new MarshalApi({ hubUrl: 'https://hub.example', token: 'mph1.test' })
    const send = Promise.withResolvers<Response>()
    const refresh = Promise.withResolvers<Response>()
    const denied = new Response('{}', { status })
    let response = send.promise
    t.mock.method(globalThis, 'fetch', () => response)
    const post = () => api.discussionAction({ action: 'send', roomId: room.id })
    const accept = (result: { ok: boolean; error?: string }) => requests.accept(result, () => {})
    const old = requests.run(async current => { const result = await post(); if (current()) accept(result) }, () => {})
    if (source === 'poll') {
      response = Promise.resolve(denied)
      accept(await api.discussion(room.id))
    } else { send.resolve(denied); await old }
    assert.deepEqual(state, { room: null, groupBusy: false })
    assert.ok(stopped)
    response = refresh.promise
    const retry = requests.run(async current => {
      const result = await api.discussion(room.id)
      assert.ok(current() && accept(result) && result.ok)
      state.room = result.data
    }, () => {})
    send.resolve(Response.json({ room }))
    await old
    assert.equal(state.groupBusy, true)
    refresh.resolve(Response.json({ room }))
    await retry
    assert.deepEqual(state, { room, groupBusy: false })
    response = Promise.resolve(Response.json({ room }))
    assert.ok((await post()).ok)
  })
}
