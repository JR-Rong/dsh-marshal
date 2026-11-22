import assert from 'node:assert/strict'
import test from 'node:test'
import { MarshalApi } from '../src/lib/marshal.ts'
import { filterTickets, parseDiffPreview, reduceTicketNavigation, ticketStageIndex, TICKET_TEMPLATES,
  ticketBackAction, TicketWrites, ticketWriteBlocked, ticketWriteKey, type Ticket } from '../src/lib/tickets.ts'

const tickets: Ticket[] = ['todo', 'pending-confirmation', 'attention', 'review', 'doing', 'running', 'done', '待确认'].map((status, index) => ({
  status, id: `TKT-${index}`, deviceId: 'host-a', title: index ? '验收' : 'Mobile delivery', detail: index ? '' : '检查离线状态', revision: 3,
  ...(index === 0 ? { template: 'pr-review' } : {}),
}))

test('ticket filters map legacy and orchestration statuses', () => {
  assert.deepEqual(filterTickets(tickets, 'all', ''), tickets)
  assert.deepEqual(filterTickets(tickets, 'attention', '').map(t => t.status), ['todo', 'pending-confirmation', 'attention', 'review', '待确认'])
  assert.deepEqual(filterTickets(tickets, 'running', '').map(t => t.status), ['doing', 'running'])
  assert.deepEqual(filterTickets(tickets, 'done', '').map(t => t.status), ['done'])
})

test('search matches title, detail, ID and official template, intersecting the segment', () => {
  for (const query of ['  MOBILE  ', '离线', 'ＴＫＴ-０', '对抗', 'pr-review', 'mobile 离线']) {
    assert.deepEqual(filterTickets(tickets, 'attention', query), [tickets[0]])
  }
  assert.deepEqual(filterTickets(tickets, 'running', '对抗'), [])
  assert.equal(new Set(TICKET_TEMPLATES.map(t => t.id)).size, 5)
})

test('status derives design, coding, review and acceptance steps', () => {
  assert.deepEqual(tickets.map(t => ticketStageIndex(t.status)), [0, 3, 3, 2, 1, 1, 3, 3])
  assert.equal(ticketStageIndex('unknown'), 0)
})

test('current Hub task snapshot has no template or room linkage', async t => {
  const api = new MarshalApi({ hubUrl: 'https://hub.example', token: 'mph1.fixture' })
  const data = { tasks: [tickets[6]], revisions: { 'host-a': 3 }, receipts: [] }
  t.mock.method(api, 'request', async () => ({ ok: true, data }))
  assert.deepEqual(await api.board(), { ok: true, data })
})

test('preview recognizes fenced and bare unified diff and changed-file lists', () => {
  const diff = '需求\n```diff\n--- old.txt\n+++ new.txt\n@@ -1 +1 @@\n-old\n+new\n```\n其他说明'
  assert.deepEqual(parseDiffPreview(diff).lines.map(line => line.type), ['file', 'file', 'hunk', 'remove', 'add'])
  assert.deepEqual(parseDiffPreview('diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-x\n+y').lines.map(line => line.type), ['file', 'hunk', 'remove', 'add'])
  assert.deepEqual(parseDiffPreview('@@ -1 +1 @@\n--- old\n+++ new').lines.map(line => line.type), ['hunk', 'remove', 'add'])
  assert.deepEqual(parseDiffPreview('### 变更文件：\n- `src/x.ts`\n- README.md\n\n说明').lines,
    [{ type: 'file', text: 'src/x.ts' }, { type: 'file', text: 'README.md' }])
  assert.deepEqual(parseDiffPreview('需求\n- 调整页面\n- 验证功能'), { lines: [], truncated: false })
  assert.deepEqual(parseDiffPreview('Changed files:\n- `src/工单.ts`\n- docs/release notes.md\nDockerfile\n\n验收').lines,
    ['src/工单.ts', 'docs/release notes.md', 'Dockerfile'].map(text => ({ type: 'file', text })))
  assert.deepEqual(parseDiffPreview('M\tsrc/工单.ts\nA\tdocs/release notes.md\nD\tDockerfile').lines,
    ['src/工单.ts', 'docs/release notes.md', 'Dockerfile'].map(text => ({ type: 'file', text })))
  assert.deepEqual(parseDiffPreview('@@ -1,2 +1,2 @@\n old context\n-old\n+new').lines.map(line => line.type),
    ['hunk', 'context', 'remove', 'add'])
  assert.deepEqual(parseDiffPreview('变更文件：\n- 工单\n- Dockerfile', 6),
    { lines: [{ type: 'file', text: '工单' }], truncated: true })
})

test('Android back consumes an open sheet first, then returns from the discussion', () => {
  assert.equal(ticketBackAction(true, false), 'close-sheet')
  assert.equal(ticketBackAction(true, true), 'close-sheet')
  assert.equal(ticketBackAction(false, true), 'return-to-ticket')
  assert.equal(ticketBackAction(false, false), undefined)
})

test('in-flight operation survives closing and reopening the same ticket', () => {
  const writes = new TicketWrites()
  const ticket = { deviceId: 'a', id: 'x' }
  const operation = ticketWriteKey(ticket.deviceId, ticket.id)
  let nav = reduceTicketNavigation({ view: 'list' }, { type: 'open', ticket })
  const attempt = writes.begin(operation)!
  nav = reduceTicketNavigation(nav, { type: 'close' })
  nav = reduceTicketNavigation(nav, { type: 'open', ticket })
  assert.equal(nav.view, 'detail')
  writes.refreshed() // A poll cannot clear a still-submitting request.
  assert.equal(writes.begin(operation), undefined)
  assert.ok(writes.begin(ticketWriteKey('b', 'x')))
  writes.finish(operation, attempt, { commandId: 'receipt-1' })
  assert.equal(writes.begin(operation), undefined)
  writes.refreshed()
  assert.equal(writes.begin(operation, 'queued'), undefined)
  // The refreshed board no longer includes the Hub receipt.
  assert.equal(ticketWriteBlocked(writes.get(operation)), false)
  assert.ok(writes.begin(operation))
})

test('failed writes retain a visible error and wait for a fresh board after conflict', async t => {
  const api = new MarshalApi({ hubUrl: 'https://hub.example', token: 'mph1.fixture' })
  const request = t.mock.method(api, 'request', async () => ({ ok: true, data: { code: 'conflict' } }))
  const writes = new TicketWrites()
  const body = { action: 'edit', deviceId: 'a', taskId: 'x', baseRevision: 4, title: '编辑' }
  const key = ticketWriteKey(body.deviceId, body.taskId)
  for (const code of ['conflict', 'unsupported']) {
    request.mock.mockImplementation(async () => ({ ok: true, data: { code } }))
    const attempt = writes.begin(key)!
    const result = await api.boardWrite(body)
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
    writes.finish(key, attempt, { notice: result.message })
    assert.equal(writes.get(key)?.notice, result.message)
    assert.equal(writes.begin(key), undefined)
    writes.refreshed()
    assert.equal(writes.get(key)?.notice, result.message)
    assert.equal(ticketWriteBlocked(writes.get(key)), false)
  }
  assert.deepEqual(request.mock.calls.map(call => call.arguments), [
    ['/marshal/api/board', { body }], ['/marshal/api/board', { body }],
  ])
})

test('48 KiB UTF-8 budget includes separators and does not split multi-byte text', () => {
  const max = 48 * 1024
  const diff = '```diff\n@@ -1 +1 @@\n-old\n+' + '🙂'.repeat(max) + '\n```'
  const preview = parseDiffPreview(diff)
  assert.equal(preview.truncated, true)
  assert.deepEqual(preview.lines.map(line => line.type), ['hunk', 'remove', 'add'])
  const text = preview.lines.map(line => line.text).join('\n')
  assert.doesNotMatch(text, /\uFFFD/)
  assert.ok(Buffer.byteLength(text) <= max && Buffer.byteLength(text) > max - 4)
  assert.deepEqual(parseDiffPreview('```diff\n+🙂\n```', 5), { lines: [{ type: 'add', text: '+🙂' }], truncated: false })
  assert.deepEqual(parseDiffPreview('```diff\n+🙂\n```', 4), { lines: [{ type: 'add', text: '+' }], truncated: true })
})

test('ticket group returns to the same device and ticket pair, then back to the list', () => {
  const list = { view: 'list' } as const
  const ticket = { deviceId: 'host-b', id: 'TKT-1' }
  assert.equal(reduceTicketNavigation(list, { type: 'enter-group' }), list)
  const detail = reduceTicketNavigation(list, { type: 'open', ticket })
  const group = reduceTicketNavigation(detail, { type: 'enter-group' })
  assert.deepEqual(group, { view: 'group', ticket })
  assert.deepEqual(reduceTicketNavigation(group, { type: 'back' }), detail)
  assert.deepEqual(reduceTicketNavigation(detail, { type: 'back' }), list)
  assert.deepEqual(reduceTicketNavigation(group, { type: 'close' }), list)
})
