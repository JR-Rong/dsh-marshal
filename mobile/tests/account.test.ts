import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPreviewInput, buildSendPayload, extractSetCookie, extractTicket, matchCookie, parseLoginBody,
  parseOnboardLink, ticketFingerprint,
  parsePreview, parseRoom, parseRoomList,
} from '../src/lib/account.ts'
import { parseConfig } from '../src/lib/config.ts'

test('parseLoginBody 读取 csrf/expiresAt/account', () => {
  assert.deepEqual(parseLoginBody({
    ok: true,
    csrf: 'csrf-token',
    expiresAt: 1795000000000,
    account: { accountHash: 'a'.repeat(64), name: '我的调度空间' },
  }), {
    csrf: 'csrf-token',
    expiresAt: 1795000000000,
    accountHash: 'a'.repeat(64),
    name: '我的调度空间',
  })
  assert.equal(parseLoginBody({ ok: false, csrf: 'x', expiresAt: 1 }), null)
  assert.equal(parseLoginBody({ ok: true, csrf: '', expiresAt: 1 }), null)
  assert.equal(parseLoginBody({ ok: true, csrf: 'x', expiresAt: 0 }), null)
})

test('extractSetCookie 兼容数组、字符串与逗号拼接', () => {
  assert.equal(extractSetCookie({
    'set-cookie': ['__Host-marshal-session=a; Path=/; Secure', '__Host-marshal-csrf=b; Path=/; Secure'],
  }), '__Host-marshal-session=a; Path=/; Secure; __Host-marshal-csrf=b; Path=/; Secure')
  assert.equal(extractSetCookie({
    'Set-Cookie': '__Host-marshal-session=a; Path=/; Secure, __Host-marshal-csrf=b; Path=/; Secure',
  }), '__Host-marshal-session=a; Path=/; Secure, __Host-marshal-csrf=b; Path=/; Secure')
  assert.equal(extractSetCookie({}), '')
})

test('matchCookie 只取目标 cookie 值', () => {
  const raw = '__Host-marshal-session=abc.def-123; Path=/; Secure; __Host-marshal-csrf=csrf_456; Path=/'
  assert.equal(matchCookie(raw, '__Host-marshal-session'), 'abc.def-123')
  assert.equal(matchCookie(raw, '__Host-marshal-csrf'), 'csrf_456')
  assert.equal(matchCookie(raw, 'missing'), undefined)
})

test('parseRoomList 过滤坏行并规范 catalog', () => {
  const parsed = parseRoomList({
    rooms: [
      { id: 'r1', title: '群一', state: 'idle', createdAt: 1 },
      { id: '', title: '坏' },
      null,
    ],
    catalog: [
      { id: 'dsh:m', agent: 'dsh', model: 'm', provider: 'p', deviceId: 'mac', deviceName: 'M5', reasoningEfforts: ['low', 7] },
      { id: 'bad' },
    ],
  })
  assert.equal(parsed.rooms.length, 1)
  assert.equal(parsed.rooms[0].title, '群一')
  assert.equal(parsed.catalog.length, 1)
  assert.deepEqual(parsed.catalog[0].reasoningEfforts, ['low'])
})

test('parseRoom 规范成员、消息与调用', () => {
  const room = parseRoom({
    id: 'room-1', title: '工作群', state: 'idle', rounds: 1, revision: 3, moderatorId: 'm1',
    members: [{ id: 'm1', name: '主持', model: { agent: 'dsh', model: 'flash' }, reasoning: 'low' }],
    messages: [
      { id: 'msg1', author: 'user', text: '你好', state: 'completed', at: 10 },
      { id: 'msg2', author: 'm1', text: '', state: 'failed', error: 'boom' },
    ],
    calls: [{ turnId: 'msg2', memberId: 'm1', state: 'failed' }],
    cleared: false, createdAt: 1, expiresAt: 2,
  })
  assert.equal(room?.members[0].name, '主持')
  assert.equal(room?.messages.length, 2)
  assert.equal(room?.messages[1].error, 'boom')
  assert.equal(room?.calls[0].state, 'failed')
  assert.equal(room?.cleared, false)
  assert.equal(parseRoom({ id: '' }), null)
})

test('buildSendPayload 固定 recipient=moderator', () => {
  assert.deepEqual(buildSendPayload('r', 'hi', 'key-1'), {
    action: 'send', roomId: 'r', text: 'hi', recipient: 'moderator', key: 'key-1',
  })
})

test('parseConfig 保留/校验 account 会话', () => {
  const good = parseConfig({
    version: 1, hubUrl: 'https://hub.example.com', token: '0123456789abcdef', lock: null,
    account: { cookies: '__Host-marshal-session=a; __Host-marshal-csrf=b', csrf: 'b', expiresAt: 1795000000000, name: '账号' },
    updatedAt: 1,
  })
  assert.equal(good?.account?.csrf, 'b')
  assert.equal(good?.account?.name, '账号')
  const bad = parseConfig({
    version: 1, hubUrl: 'https://hub.example.com', token: '',
    account: { cookies: 'x\ny', csrf: 'b', expiresAt: 1 },
  })
  assert.equal(bad?.account, undefined)
})
test('parsePreview 读取 preview 的 digest/members/maxCalls', () => {
  const preview = parsePreview({
    preview: {
      digest: 'd'.repeat(64), mode: 'discussion', title: '群', text: '首条',
      members: [
        { id: 'p0', deviceId: 'mac', model: { id: 'dsh:m', agent: 'dsh', model: 'm' }, reasoning: 'low' },
        { id: 'p1', deviceId: 'mac', model: { id: 'codex:g', agent: 'codex', model: 'g' } },
      ],
      moderatorId: 'p0', maxCalls: 9, expiresAt: 1,
    },
  })
  assert.equal(preview?.digest.length, 64)
  assert.equal(preview?.members.length, 2)
  assert.equal(preview?.members[0].model.id, 'dsh:m')
  assert.equal(preview?.maxCalls, 9)
  assert.equal(parsePreview({ preview: { digest: '' } }), null)
})

test('buildPreviewInput 组装 moderator/members', () => {
  assert.deepEqual(buildPreviewInput({
    title: ' 群 ', text: ' 首条 ',
    members: [{ deviceId: 'mac', modelId: 'dsh:m' }, { deviceId: 'mac', modelId: 'codex:g' }],
  }), {
    mode: 'discussion', title: ' 群 ', text: ' 首条 ', moderator: 0,
    members: [
      { deviceId: 'mac', modelId: 'dsh:m', profile: {} },
      { deviceId: 'mac', modelId: 'codex:g', profile: {} },
    ],
  })
})
test('extractTicket 支持裸 ticket 与 marshal 深链', () => {
  assert.equal(extractTicket('  abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG  '), 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')
  assert.equal(extractTicket('marshal://open?hub=https%3A%2F%2Fh.example&ticket=abc_123-def'), 'abc_123-def')
  assert.equal(extractTicket('https://x/?ticket=abc_123'), 'abc_123')
  assert.equal(extractTicket(''), '')
})
test('parseOnboardLink 解析 hub/token/ticket', () => {
  assert.deepEqual(parseOnboardLink('marshal://open?hub=https%3A%2F%2Fh.example&token=abcdefghijklmnop&ticket=xyz_123'), {
    hub: 'https://h.example', token: 'abcdefghijklmnop', ticket: 'xyz_123',
  })
  assert.deepEqual(parseOnboardLink('marshal://open?hub=https%3A%2F%2Fh.example'), { hub: 'https://h.example' })
  assert.equal(parseOnboardLink('https://h.example/?token=x'), null)
  assert.equal(parseOnboardLink('marshal://open'), null)
})
test('ticketFingerprint 稳定且能区分不同 ticket', () => {
  const a = ticketFingerprint('t'.repeat(43))
  const b = ticketFingerprint('u'.repeat(43))
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.equal(a, ticketFingerprint('t'.repeat(43)))
  assert.notEqual(a, b)
})
