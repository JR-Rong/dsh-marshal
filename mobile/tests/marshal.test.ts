import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MarshalApi, agentLabel, can, decisionIsSafe, parseCards, parseDevices, parseSessions, sameTarget, sessionTitle,
} from '../src/lib/marshal.ts'

const devicesPayload = {
  devices: [
    {
      id: 'mac', name: '本机 Mac', agents: ['dsh', 'codex'], connectedAt: 1, lastSeen: 2,
      syncing: false, stale: false,
      capabilities: { dsh: { operations: ['prompt', 'answer'], ownership: 'attached', revision: 1 } },
    },
    { id: 'box', agents: ['dsh'], lastSeen: 3 },
    { id: 42 },
    null,
  ],
}

const sessionsPayload = {
  sessions: [
    { deviceId: 'mac', agent: 'dsh', sessionId: 's1', running: true, updatedAt: 100, title: '会话一' },
    { deviceId: 'mac', agent: 'codex', sessionId: 's2', running: false, updatedAt: 90, blank: true },
    { deviceId: 'mac', agent: 'dsh', sessionId: 's3', running: false, updatedAt: 80,
      capability: { operations: ['prompt'], runtimeEpoch: 'e1', tunables: [{ id: 'model', editable: false }] } },
    { sessionId: 'no-agent' },
  ],
}

test('parseDevices 丢弃坏行并保留能力文档', () => {
  const rows = parseDevices(devicesPayload)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, '本机 Mac')
  assert.deepEqual(rows[0].agents, ['dsh', 'codex'])
  assert.equal(rows[0].capabilities?.dsh.operations?.[0], 'prompt')
  assert.equal(rows[1].name, 'box')
})

test('parseDevices 对非对象输入返回空数组', () => {
  assert.deepEqual(parseDevices(null), [])
  assert.deepEqual(parseDevices({ devices: 'nope' }), [])
})

test('parseSessions 保留能力文档与运行态', () => {
  const rows = parseSessions(sessionsPayload)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].running, true)
  assert.equal(rows[1].blank, true)
  assert.equal(rows[2].capability?.runtimeEpoch, 'e1')
})

test('会话标题与 agent 名称规范化', () => {
  assert.equal(sessionTitle({ sessionId: 'a', agent: 'dsh', deviceId: 'd', running: false, updatedAt: 0, title: ' 标题 ' }), '标题')
  assert.equal(sessionTitle({ sessionId: 'a', agent: 'dsh', deviceId: 'd', running: false, updatedAt: 0, blank: true }), '新会话')
  assert.equal(sessionTitle({ sessionId: 'a', agent: 'dsh', deviceId: 'd', running: false, updatedAt: 0 }), '未命名会话')
  assert.equal(agentLabel('dsh'), 'DSH')
  assert.equal(agentLabel('claude'), 'Claude')
  assert.equal(agentLabel('other'), 'other')
})

test('sameTarget 必须 device+agent+session 全等', () => {
  const base = { deviceId: 'd', agent: 'a', sessionId: 's' }
  assert.equal(sameTarget(base, { ...base }), true)
  assert.equal(sameTarget(base, { ...base, agent: 'b' }), false)
  assert.equal(sameTarget(base, { ...base, sessionId: null }), false)
})

test('can 只认能力文档里的操作列表', () => {
  assert.equal(can({ operations: ['prompt'] }, 'prompt'), true)
  assert.equal(can({ operations: ['prompt'] }, 'interrupt'), false)
  assert.equal(can(undefined, 'prompt'), false)
})

test('审批选项过滤「总是/记住/会话内」语义', () => {
  assert.equal(decisionIsSafe({ id: 'accept', label: '允许这一次' }), true)
  assert.equal(decisionIsSafe({ id: 'decline', label: '拒绝' }), true)
  assert.equal(decisionIsSafe({ id: 'cancel', label: '取消' }), true)
  assert.equal(decisionIsSafe({ id: 'allow-once', label: '允许这一次' }), false)
  assert.equal(decisionIsSafe({ id: 'allow-always', label: '总是允许' }), false)
  assert.equal(decisionIsSafe({ id: 'x', label: '会话内都允许' }), false)
  assert.equal(decisionIsSafe({ id: "don't ask again", label: '别再问' }), false)
})

test('parseCards 丢弃坏卡并规范问题与审批', () => {
  const cards = parseCards([
    {
      requestId: 'r1', title: '确认',
      questions: [{ id: 'q1', prompt: '继续？', options: [{ id: 'yes', label: '继续' }, { bad: 1 }] }, { noId: true }],
    },
    {
      requestId: 'r2',
      approval: { action: '执行命令', detail: 'rm -rf', decisions: [{ id: 'accept', label: '允许' }, { id: 'always', label: '总是允许' }, { id: 'decline', label: '拒绝' }] },
    },
    { requestId: '' },
    'junk',
  ])
  assert.equal(cards.length, 2)
  assert.equal(cards[0].questions?.length, 1)
  assert.equal(cards[0].questions?.[0].options?.length, 1)
  assert.equal(cards[1].approval?.action, '执行命令')
  assert.equal(cards[1].approval?.decisions.length, 2)
})

test('parseCards 对非数组输入返回空', () => {
  assert.deepEqual(parseCards(undefined), [])
  assert.deepEqual(parseCards({}), [])
})

test('手机按成员 ID 展示花名册，旧的通用路由占位不成为成员', async (t) => {
  const api = new MarshalApi({ hubUrl: 'https://hub.example', token: 'mph1.fixture' })
  t.mock.method(api, 'request', async () => ({
    ok: true, data: { agents: [
      { id: 'member-a', deviceId: 'mac-a', name: '同名成员' },
      { id: 'member-b', deviceId: 'mac-b', name: '同名成员' },
      { agent: 'dsh', deviceId: 'mac-a', name: '旧占位' },
    ] },
  }))
  assert.deepEqual(await api.roster(), {
    ok: true, data: [
      { id: 'member-a', deviceId: 'mac-a', name: '同名成员' },
      { id: 'member-b', deviceId: 'mac-b', name: '同名成员' },
    ],
  })
})

test('手机仅把明确入队的结果视为已接收，展示 Hub 返回的版本和回执', async (t) => {
  const api = new MarshalApi({ hubUrl: 'https://hub.example', token: 'mph1.fixture' })
  let response: Record<string, unknown> = { ok: true, code: 'queued', commandId: 'task-command' }
  t.mock.method(api, 'request', async () => ({ ok: true, data: response }))
  assert.deepEqual(await api.boardWrite({}), { ok: true, data: { commandId: 'task-command' } })
  response = { code: 'unsupported' }
  assert.equal((await api.boardWrite({})).ok, false)
  response = {
    tasks: [], revisions: { 'mac-a': 7 },
    receipts: [{ id: 'task-command', deviceId: 'mac-a', action: 'move', state: 'rejected', code: 'conflict' }],
  }
  assert.deepEqual(await api.board(), { ok: true, data: response })
})
