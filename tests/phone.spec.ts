import { describe, expect, it } from 'vitest'
import { createPhoneHub, controllerCommandAllowed, forwardPhoneState, hubHttpOrigin, pushProviderReady } from '../src/hub/phone.ts'
import type { DeviceRecord } from '../src/hub/devices.ts'

const OWNER = 'a'.repeat(64)

function node(digest: string, revoked = false): DeviceRecord {
  return {
    id: 'node-1', name: '书房电脑', tokenDigest: digest, revoked,
    allowContent: true, allowInteractions: true, allowDiscussion: true, policyRevision: 1,
  }
}

describe('手机配对', () => {
  it('一次性配对码绑定账号，Hub 只留凭证哈希', () => {
    let clock = 1_000
    const hub = createPhoneHub({ now: () => clock, ownerHash: OWNER })
    const issued = hub.issuePairing(OWNER, 'https://hub.example.com')
    expect(issued.url.startsWith('marshal://pair?code=')).toBe(true)
    const first = hub.redeem(issued.code, '我的手机')
    expect(first.credential.length).toBeGreaterThan(20)
    expect(JSON.stringify(hub.listControllers())).not.toContain(first.credential)
    expect(hub.listControllers()[0]?.tokenDigest).toHaveLength(64)
    expect(() => hub.redeem(issued.code, '第二台')).toThrow(/unknown/)
    clock += 120_000
    const expired = hub.issuePairing(OWNER, 'https://hub.example.com')
    clock += 61_000
    expect(() => hub.redeem(expired.code, '迟到')).toThrow(/expired|unknown/)
  })

  it('拒绝跨账号领取和访问', () => {
    const hub = createPhoneHub({ ownerHash: OWNER })
    expect(() => hub.issuePairing('b'.repeat(64), 'https://hub.example.com')).toThrow(/cross-account/)
    const issued = hub.issuePairing(OWNER, 'https://hub.example.com')
    const phone = hub.redeem(issued.code, '手机')
    const other = createPhoneHub({ ownerHash: 'c'.repeat(64) })
    expect(other.authenticate(phone.credential).ok).toBe(false)
    const moved = createPhoneHub({ ownerHash: 'd'.repeat(64) })
    expect(moved.authenticate(phone.credential).code).toBe('unauthorized')
    expect(hub.authenticate(phone.credential).ok).toBe(true)
    hub.revoke(phone.deviceId)
    expect(hub.authenticate(phone.credential)).toEqual({ ok: false, code: 'revoked' })
  })

  it('手机可改任务板，记忆只读；节点才能推送记忆', () => {
    const hub = createPhoneHub({ ownerHash: OWNER })
    const phone = hub.redeem(hub.issuePairing(OWNER, 'https://hub.example.com').code, '手机')
    const auth = hub.authenticate(phone.credential)
    const tasks = hub.writeTasks(auth, { action: 'create', title: '买菜' })
    expect(tasks[0]?.title).toBe('买菜')
    const moved = hub.writeTasks(auth, { action: 'move', id: tasks[0]!.id, status: 'doing' })
    expect(moved[0]?.status).toBe('doing')
    expect(() => hub.writeMemory(auth, [{ id: 'm', text: '秘密' }])).toThrow(/read-only/)
    expect(hub.authenticate('node-secret').ok).toBe(false)
  })

  it('节点凭证可以转发任务、记忆和花名册', () => {
    const digest = createDigest('node-secret')
    const hub = createPhoneHub({ ownerHash: OWNER, findNode: (value) => value === digest ? node(digest) : undefined })
    const auth = hub.authenticate('node-secret')
    expect(auth.ok).toBe(true)
    hub.writeTasks(auth, { action: 'snapshot', tasks: [{ id: 't1', title: '来自电脑', status: 'todo' }] })
    hub.writeMemory(auth, [{ id: 'mem', agent: '丞相', text: '只读记忆' }])
    hub.writeRoster(auth, [{ deviceId: 'node-1', agent: 'dsh', name: '丞相' }])
    const phone = hub.redeem(hub.issuePairing(OWNER, 'https://hub.example.com').code, '手机')
    const reader = hub.authenticate(phone.credential)
    expect(hub.readMemory(reader)[0]?.text).toBe('只读记忆')
    expect(hub.readRoster(reader)[0]?.name).toBe('丞相')
    expect(hub.tasksFor(reader)[0]?.title).toBe('来自电脑')
    expect(() => hub.writeMemory(reader, [])).toThrow(/read-only/)
  })

  it('控制端只能做聊天、一次审批和中断', () => {
    expect(controllerCommandAllowed('prompt', { text: '你好' })).toBe(true)
    expect(controllerCommandAllowed('interrupt', { runtimeEpoch: 'e' })).toBe(true)
    expect(controllerCommandAllowed('create', {})).toBe(true)
    expect(controllerCommandAllowed('configure', { field: 'model' })).toBe(false)
    expect(controllerCommandAllowed('answer', { answers: [{ id: 'allow-once' }] })).toBe(true)
    expect(controllerCommandAllowed('answer', { answers: [{ id: 'allow-always' }] })).toBe(false)
  })

  it('推送没配密钥时不发送，也不写入密钥', async () => {
    const hub = createPhoneHub({ ownerHash: OWNER, push: { apns: { keyId: 'PLACEHOLDER', teamId: '', bundleId: '', keyPath: '' } } })
    const phone = hub.redeem(hub.issuePairing(OWNER, 'https://hub.example.com').code, '手机')
    const auth = hub.authenticate(phone.credential)
    hub.registerPush(auth, { provider: 'apns', token: 'device-token' })
    const result = await hub.notify({ kind: 'approval', title: '审批', body: '需要确认' })
    expect(result[0]?.delivered).toBe(false)
    expect(result[0]?.reason).toBe('unconfigured')
    expect(pushProviderReady({ fcm: { projectId: 'p', clientEmail: 'a@b.c', privateKeyPath: '/tmp/key.pem' } }, 'fcm')).toBe(true)
  })
})

describe('节点转发', () => {
  it('把 wss Hub 转成 https，并分别提交三份快照', async () => {
    expect(hubHttpOrigin('wss://hub.example.com/marshal')).toBe('https://hub.example.com')
    const calls: string[] = []
    const result = await forwardPhoneState({
      hubHttpOrigin: 'https://hub.example.com',
      token: 'node-secret',
      tasks: [{ id: 't', title: 'a' }],
      memory: [{ id: 'm', text: '只读' }],
      roster: [{ deviceId: 'd', agent: 'dsh', name: '丞相' }],
      fetch: async (url) => {
        calls.push(String(url))
        return new Response('{}', { status: 200 })
      },
    })
    expect(result).toEqual({ tasks: true, memory: true, roster: true })
    expect(calls).toEqual([
      'https://hub.example.com/marshal/api/tasks',
      'https://hub.example.com/marshal/api/memory',
      'https://hub.example.com/marshal/api/roster',
    ])
  })
})

function createDigest(value: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
