import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentLabel, parseDevices, parseSessions, sessionTitle, summarize,
} from '../src/lib/hub.ts'

const devicesPayload = {
  devices: [
    {
      id: 'mac-local', name: '本机 Mac', agents: ['dsh', 'codex'], connectedAt: 1, lastSeen: 2,
      syncing: false, stale: false,
    },
    { id: 'laptop', agents: ['dsh'], lastSeen: 3 },
    { id: 42 },
    null,
  ],
}

const sessionsPayload = {
  sessions: [
    { deviceId: 'mac-local', agent: 'dsh', sessionId: 'session-1', running: true, updatedAt: 100, title: '会话一' },
    { deviceId: 'mac-local', agent: 'codex', sessionId: 'session-2', running: false, updatedAt: 90, blank: true },
    { sessionId: 'no-agent' },
    'garbage',
  ],
}

test('parseDevices 丢弃坏行并补默认值', () => {
  const devices = parseDevices(devicesPayload)
  assert.equal(devices.length, 2)
  assert.equal(devices[0].name, '本机 Mac')
  assert.deepEqual(devices[0].agents, ['dsh', 'codex'])
  assert.equal(devices[1].name, 'laptop')
  assert.deepEqual(devices[1].agents, ['dsh'])
})

test('parseDevices 对非对象输入返回空数组', () => {
  assert.deepEqual(parseDevices(null), [])
  assert.deepEqual(parseDevices({ devices: 'nope' }), [])
})

test('parseSessions 丢弃坏行', () => {
  const sessions = parseSessions(sessionsPayload)
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].running, true)
  assert.equal(sessions[1].blank, true)
})

test('summarize 统计设备、会话与运行中数量', () => {
  const devices = parseDevices(devicesPayload)
  const sessions = parseSessions(sessionsPayload)
  const overview = summarize(devices, sessions)
  assert.deepEqual(overview, {
    deviceCount: 2,
    onlineDeviceCount: 2,
    sessionCount: 2,
    runningCount: 1,
  })
})

test('会话标题与 agent 名称规范化', () => {
  assert.equal(sessionTitle({ sessionId: 's', agent: 'dsh', deviceId: '', running: false, updatedAt: 0, title: ' 标题 ' }), '标题')
  assert.equal(sessionTitle({ sessionId: 's', agent: 'dsh', deviceId: '', running: false, updatedAt: 0, blank: true }), '新会话')
  assert.equal(sessionTitle({ sessionId: 's', agent: 'dsh', deviceId: '', running: false, updatedAt: 0 }), '未命名会话')
  assert.equal(agentLabel('dsh'), 'DSH')
  assert.equal(agentLabel('codex'), 'Codex')
  assert.equal(agentLabel('claude'), 'Claude')
  assert.equal(agentLabel('custom'), 'custom')
})
