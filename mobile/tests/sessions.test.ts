import assert from 'node:assert/strict'
import test from 'node:test'
import { ALL_DEVICES_ID, SESSION_PAGE_SIZE, matchSession, sliceSessions, sortSessions } from '../src/lib/sessions.ts'
import { TOOL_OUTPUT_PREVIEW_LIMIT, extractPayloadText, historyToMessage } from '../src/lib/transcript.ts'
import type { SessionRow } from '../src/lib/marshal.ts'

function row(partial: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  return {
    deviceId: 'm5',
    agent: 'dsh',
    running: false,
    updatedAt: 0,
    ...partial,
  }
}

test('sliceSessions sorts newest-first BEFORE slicing so newer Codex/Claude/DSH sessions are never dropped', () => {
  const rows: SessionRow[] = [
    ...Array.from({ length: 80 }, (_, index) => row({
      sessionId: `old-dsh-${index}`,
      agent: 'dsh',
      title: `旧会话 ${index}`,
      updatedAt: 1_000 + index,
    })),
    ...Array.from({ length: 12 }, (_, index) => row({
      sessionId: `new-codex-${index}`,
      agent: 'codex',
      title: `最新 Codex ${index}`,
      updatedAt: 50_000 + index,
    })),
    ...Array.from({ length: 3 }, (_, index) => row({
      sessionId: `new-claude-${index}`,
      agent: 'claude',
      title: `最新 Claude ${index}`,
      updatedAt: 60_000 + index,
    })),
  ]

  const page = sliceSessions(rows, '', 10)
  assert.equal(page.total, 95)
  assert.equal(page.filteredTotal, 95)
  assert.equal(page.hasMore, true)
  assert.equal(page.shown.length, 10)
  assert.deepEqual(page.shown.slice(0, 3).map((item) => item.sessionId), [
    'new-claude-2',
    'new-claude-1',
    'new-claude-0',
  ])
  assert.equal(page.shown[3]?.sessionId, 'new-codex-11')
  assert.deepEqual(page.agentCounts, [['dsh', 80], ['codex', 12], ['claude', 3]])
})

test('sliceSessions filters by agent while preserving full agentCounts and matches device names', () => {
  const rows: SessionRow[] = [
    row({ deviceId: 'dev-a', agent: 'dsh', sessionId: 's1', title: 'Alpha', updatedAt: 100 }),
    row({ deviceId: 'dev-b', agent: 'codex', sessionId: 's2', title: 'Beta', updatedAt: 300 }),
    row({ deviceId: 'dev-b', agent: 'claude', sessionId: 's3', title: 'Gamma', updatedAt: 200 }),
  ]
  const names: Record<string, string> = { 'dev-a': 'Company', 'dev-b': 'M5 Mac' }

  const codexOnly = sliceSessions(rows, '', SESSION_PAGE_SIZE, 'codex', (id) => names[id] ?? '')
  assert.equal(codexOnly.total, 3)
  assert.equal(codexOnly.filteredTotal, 1)
  assert.deepEqual(codexOnly.shown.map((item) => item.sessionId), ['s2'])
  assert.deepEqual(codexOnly.agentCounts, [['dsh', 1], ['codex', 1], ['claude', 1]])

  const byDevice = sliceSessions(rows, 'm5', SESSION_PAGE_SIZE, '', (id) => names[id] ?? '')
  assert.deepEqual(byDevice.shown.map((item) => item.sessionId), ['s2', 's3'])
  assert.equal(matchSession(rows[0]!, 'company', 'Company'), true)
  assert.equal(ALL_DEVICES_ID, '__all__')
})

test('sortSessions breaks timestamp ties with running status then sessionId', () => {
  const sorted = sortSessions([
    row({ sessionId: 'b', updatedAt: 500, running: false }),
    row({ sessionId: 'a', updatedAt: 500, running: false }),
    row({ sessionId: 'c', updatedAt: 500, running: true }),
  ])
  assert.deepEqual(sorted.map((item) => item.sessionId), ['c', 'a', 'b'])
})

test('transcript helper extracts tool.completed text/content blocks without [object Object] and preserves up to 8000 chars', () => {
  const longText = 'x'.repeat(2500)
  const fromPrivacyText = historyToMessage({
    kind: 'tool.completed',
    seq: 1,
    ts: 10,
    payload: { callId: 'call-1', status: 'ok', text: longText },
  })
  assert.equal(fromPrivacyText?.id, 'call-1')
  assert.equal(fromPrivacyText?.text, '完成：' + longText)

  const fromContentBlocks = historyToMessage({
    kind: 'tool.completed',
    seq: 2,
    ts: 20,
    payload: { callId: 'call-2', status: 'error', content: [{ type: 'text', text: 'line-1' }, { type: 'text', text: 'line-2' }] },
  })
  assert.equal(fromContentBlocks?.text, '失败：line-1\nline-2')

  const oversized = 'y'.repeat(TOOL_OUTPUT_PREVIEW_LIMIT + 50)
  const capped = historyToMessage({
    kind: 'tool.completed',
    seq: 3,
    ts: 30,
    payload: { callId: 'call-3', status: 'ok', text: oversized },
  })
  assert.ok(capped?.text.startsWith('完成：' + 'y'.repeat(TOOL_OUTPUT_PREVIEW_LIMIT)))
  assert.ok(capped?.text.includes(`共 ${oversized.length} 字`))

  assert.equal(extractPayloadText({ cmd: 'git status' }).includes('git status'), true)
  assert.equal(extractPayloadText({ cmd: 'git status' }).includes('[object Object]'), false)
})
