import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { acceptEventSeq } from '../src/lib/transcript.ts'
import { noteStreamDrop, noteStreamOpen, nextResumeCursor, shouldReconnectStream } from '../src/lib/stream.ts'
import { createUtf8Decoder } from '../src/lib/utf8.ts'
import { approvalChoices } from '../src/lib/marshal.ts'
import { createSingleFlight } from '../src/lib/single-flight.ts'
import { MarshalApi } from '../src/lib/marshal.ts'
import { SESSION_PAGE_SIZE, sliceSessions } from '../src/lib/sessions.ts'
import type { SessionRow } from '../src/lib/marshal.ts'

test('seq 0 的能力变更不被去重吞掉', () => {
  let last = 0
  const first = acceptEventSeq(last, 0)
  assert.equal(first.accept, true)
  last = first.lastSeq
  const live = acceptEventSeq(last, 4)
  assert.equal(live.accept, true)
  last = live.lastSeq
  const capability = acceptEventSeq(last, 0)
  assert.equal(capability.accept, true)
  assert.equal(capability.lastSeq, 4)
  assert.equal(acceptEventSeq(last, 4).accept, false)
  assert.equal(acceptEventSeq(last, 5).lastSeq, 5)
})

test('干净关闭也重连，成功连接后退避归零', () => {
  assert.equal(shouldReconnectStream({ event: 'end', closed: false, reconnect: true }), true)
  assert.equal(shouldReconnectStream({ event: 'error', closed: false, reconnect: true }), true)
  assert.equal(shouldReconnectStream({ event: 'end', closed: true, reconnect: true }), false)
  assert.equal(shouldReconnectStream({ event: 'message', closed: false, reconnect: true }), false)
  let attempt = 0
  const first = noteStreamDrop(attempt)
  const second = noteStreamDrop(first.attempt)
  assert.ok(second.delayMs > first.delayMs)
  attempt = noteStreamOpen()
  const after = noteStreamDrop(attempt)
  assert.equal(after.attempt, 1)
  assert.equal(after.delayMs, first.delayMs)
})

test('重连游标优先用 SSE id，其次用 reset 的 cursor', () => {
  let cursor: string | null = null
  cursor = nextResumeCursor(cursor, { event: 'reset', data: { cursor: 'epoch:3', replay: { cursor: 'epoch:2' } } })
  assert.equal(cursor, 'epoch:3')
  cursor = nextResumeCursor(cursor, { event: 'message', id: 'epoch:4', data: { seq: 9 } })
  assert.equal(cursor, 'epoch:4')
  cursor = nextResumeCursor(cursor, { event: 'message', data: { seq: 10 } })
  assert.equal(cursor, 'epoch:4')
})

test('UTF-8 多字节被拆到两个块时仍能拼回', () => {
  const decoder = createUtf8Decoder()
  const bytes = new TextEncoder().encode('你好')
  const split = 4
  assert.equal(decoder.push(bytes.slice(0, split)), '你')
  assert.equal(decoder.push(bytes.slice(split)), '好')
  const broken = createUtf8Decoder()
  assert.equal(broken.push(bytes.slice(0, 1)), '')
  assert.equal(broken.push(bytes.slice(1, 3)), '你')
})

test('审批只呈现 Hub 给的选项，不追加拒绝', () => {
  const choices = approvalChoices([
    { id: 'allow-once', label: '允许这一次' },
    { id: 'allow-always', label: '总是允许' },
  ])
  assert.deepEqual(choices.map((item) => item.id), ['allow-once'])
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
  assert.equal(source.includes("id: 'decline'"), false)
  assert.equal(source.includes('id: "decline"'), false)
})

test('同一张审批卡的重复点击只发送一次', async () => {
  const gate = createSingleFlight()
  let calls = 0
  const first = gate.run('card-1', async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const second = gate.run('card-1', async () => { calls += 1 })
  await Promise.all([first, second])
  assert.equal(calls, 1)
  await gate.run('card-1', async () => { calls += 1 })
  assert.equal(calls, 2)
})

test('202 和未知结果不是成功', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false, status: 'outcome-unknown', code: 'outcome-unknown',
  }), { status: 202, headers: { 'content-type': 'application/json' } })
  try {
    const api = new MarshalApi({ hubUrl: 'https://hub.example.com', token: 't'.repeat(16) })
    const result = await api.command('answer', { deviceId: 'd', agent: 'a', sessionId: 's' }, { requestId: 'r', answers: [] })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, 'unknown')
  } finally {
    globalThis.fetch = original
  }
})

test('已受理的命令仍然成功', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true, status: 'accepted', result: { sessionId: 'new-1' },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const api = new MarshalApi({ hubUrl: 'https://hub.example.com', token: 't'.repeat(16) })
    const result = await api.command('create', { deviceId: 'd', agent: 'codex', sessionId: null }, {})
    assert.equal(result.ok, true)
    if (result.ok) assert.equal((result.data.result as { sessionId: string }).sessionId, 'new-1')
  } finally {
    globalThis.fetch = original
  }
})

test('HTTP 200 但状态未知不算成功', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, status: 'unknown' }), { status: 200 })
  try {
    const api = new MarshalApi({ hubUrl: 'https://hub.example.com', token: 't'.repeat(16) })
    const result = await api.command('answer', { deviceId: 'd', agent: 'a', sessionId: 's' }, {})
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, 'unknown')
  } finally {
    globalThis.fetch = original
  }
})

function row(index: number, agent = 'dsh'): SessionRow {
  return {
    deviceId: 'mac', agent, sessionId: 's' + index, running: false, updatedAt: index,
    title: index % 2 === 0 ? '修复登录 ' + index : '其它 ' + index,
  }
}

test('会话列表按页展开，并按标题搜索', () => {
  const rows = Array.from({ length: 45 }, (_, index) => row(index))
  const first = sliceSessions(rows, '', SESSION_PAGE_SIZE)
  assert.equal(first.shown.length, 40)
  assert.equal(first.hasMore, true)
  const more = sliceSessions(rows, '', SESSION_PAGE_SIZE * 2)
  assert.equal(more.shown.length, 45)
  assert.equal(more.hasMore, false)
  const found = sliceSessions(rows, '修复登录', SESSION_PAGE_SIZE)
  assert.ok(found.shown.length > 0)
  assert.ok(found.shown.every((item) => item.title?.includes('修复登录')))
  assert.equal(sliceSessions(rows, '不存在的词', SESSION_PAGE_SIZE).shown.length, 0)
})
