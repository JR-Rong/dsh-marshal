import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceStore, emptyDevicesState, phoneTokenDigest, serializeDevicesState, sha256Hex } from '../src/hub/devices.ts'
import { createPhoneHub, controllerCommandAllowed, onceDecisionIds, pairingRefreshDelay, parseBearer } from '../src/hub/phone.ts'
import { deliverPush } from '../src/hub/push-send.ts'
import { applyBoardCommand, boardCapabilities, forwardBody, readPhoneFaces } from '../src/node/phone-sync.ts'

function store(): DeviceStore {
  const path = join(mkdtempSync(join(tmpdir(), 'marshal-phone-')), 'devices.json')
  writeFileSync(path, serializeDevicesState(emptyDevicesState()), { mode: 0o600 })
  return new DeviceStore(path)
}

describe('phone credentials', () => {
  it('keeps a node token out of phone auth and operator reads', () => {
    const devices = store()
    const node = devices.add('mac', 'Mac')
    const hub = createPhoneHub({
      store: devices,
      findNode: (digest) => devices.findByTokenDigest(digest),
    })
    expect(parseBearer('Bearer mnd1.' + node.token)?.kind).toBe('node')
    expect(hub.authenticate(node.token).ok).toBe(false)
    const nodeAuth = hub.authenticateNode(node.token)
    expect(nodeAuth.ok).toBe(true)
    hub.writeTasks({ ok: true, device: nodeAuth.ok ? nodeAuth.device : node.entry }, { tasks: [] })
    expect(hub.tasksFor('mac')).toEqual([])
    hub.writeTasks(nodeAuth, { read: true, tasks: [{ id: 't1', title: '写报告', status: 'todo', revision: 1 }] })
    hub.writeTasks(nodeAuth, { tasks: [] })
    expect(hub.tasksFor('mac').map((task) => task.title)).toEqual(['写报告'])
  })

  it('rotates the credential when the same phone pairs again and closes its stream', () => {
    let clock = 1_000
    const devices = store()
    const hub = createPhoneHub({ store: devices, now: () => clock })
    const issued = hub.issuePairing('account-a', 'https://hub.example')
    expect(issued.url.startsWith('marshal://pair?code=')).toBe(true)
    expect(issued.url.includes('token')).toBe(false)
    const first = hub.redeem(issued.code, '我的手机', 'install-1')
    let closed = false
    hub.attachStream(first.record.id, () => { closed = true })
    const again = hub.issuePairing('account-a', 'https://hub.example')
    const second = hub.redeem(again.code, '我的手机', 'install-1')
    expect(second.record.id).toBe(first.record.id)
    expect(second.credential).not.toBe(first.credential)
    expect(closed).toBe(true)
    const secret = first.credential.slice('mph1.'.length)
    expect(hub.authenticate(secret).ok).toBe(false)
    expect(devices.findByTokenDigest(sha256Hex(secret))).toBeUndefined()
    expect(devices.findByTokenDigest(phoneTokenDigest(secret))).toBeUndefined()
    expect(hub.authenticate(second.credential.slice('mph1.'.length)).ok).toBe(true)
    expect(devices.findByTokenDigest(phoneTokenDigest(second.credential.slice('mph1.'.length)))?.role).toBe('phone')
  })

  it('does not revive a revoked phone when the same installation pairs again', () => {
    const devices = store()
    const hub = createPhoneHub({ store: devices, now: () => 5_000 })
    const issued = hub.issuePairing('account-a', 'https://hub.example')
    const first = hub.redeem(issued.code, '我的手机', 'install-revoked')
    hub.revoke(first.record.id)
    const again = hub.issuePairing('account-a', 'https://hub.example')
    expect(() => hub.redeem(again.code, '我的手机', 'install-revoked')).toThrow()
    expect(devices.findById(first.record.id)?.revoked).toBe(true)
  })

  it('allows accept, decline and cancel, and refuses a persistent grant', () => {
    const command = onceDecisionIds({
      requestId: 'cmd',
      approval: {
        action: '运行命令',
        decisions: [
          { id: 'accept', label: '允许一次' },
          { id: 'decline', label: '拒绝' },
          { id: 'cancel', label: '取消' },
          { id: 'acceptForSession', label: '本会话内允许' },
        ],
      },
    })
    const widening = onceDecisionIds({
      requestId: 'wide',
      approval: {
        action: '请求扩大权限',
        decisions: [
          { id: 'decline', label: '拒绝' },
          { id: 'cancel', label: '取消' },
        ],
      },
    })
    const question = onceDecisionIds({ requestId: 'q', questions: [{ id: 'session-1' }] })
    const answer = (id: string) => ({ requestId: 'x', answers: [{ id: 'row', selectedOptionIds: [id] }] })
    expect(command?.allowedIds.has('accept')).toBe(true)
    expect(command?.allowedIds.has('decline')).toBe(true)
    expect(command?.allowedIds.has('cancel')).toBe(true)
    expect(command?.allowedIds.has('acceptForSession')).toBe(false)
    expect(controllerCommandAllowed('answer', answer('accept'), command ?? undefined)).toBe(true)
    expect(controllerCommandAllowed('answer', answer('decline'), command ?? undefined)).toBe(true)
    expect(controllerCommandAllowed('answer', answer('cancel'), command ?? undefined)).toBe(true)
    expect(controllerCommandAllowed('answer', answer('acceptForSession'), command ?? undefined)).toBe(false)
    expect(controllerCommandAllowed('answer', answer('decline'), widening ?? undefined)).toBe(true)
    expect(controllerCommandAllowed('answer', answer('cancel'), widening ?? undefined)).toBe(true)
    expect(controllerCommandAllowed('answer', answer('accept'), widening ?? undefined)).toBe(false)
    expect(controllerCommandAllowed('answer', { requestId: 'q', answers: [{ id: 'session-1', selectedOptionIds: ['session-1'] }] }, question ?? undefined)).toBe(true)
  })

  it('keeps each device revision, maps description, and caps the command queue', () => {
    const devices = store()
    const node = devices.add('mac', 'Mac')
    const hub = createPhoneHub({ store: devices, now: () => 5_000, findNode: (digest) => devices.findByTokenDigest(digest) })
    const nodeAuth = hub.authenticateNode(node.token)
    expect(nodeAuth.ok).toBe(true)
    if (!nodeAuth.ok) return
    hub.writeTasks(nodeAuth, { read: true, revision: 4, tasks: [{ id: 't', title: '报告', description: '正文' }] })
    expect(hub.tasksFor('mac')[0]?.detail).toBe('正文')
    expect(hub.revisions()).toEqual({ mac: 4 })
    hub.writeTasks(nodeAuth, { read: true, revision: 4, tasks: [] })
    expect(hub.tasksFor('mac')).toEqual([])
    expect(hub.revisions().mac).toBe(4)
    const issued = hub.issuePairing('account-a', 'https://hub.example')
    const phone = hub.redeem(issued.code, '我的手机', 'install-board')
    const auth = hub.authenticate(phone.credential.slice('mph1.'.length))
    expect(auth.ok).toBe(true)
    if (!auth.ok) return
    for (let index = 0; index < 32; index += 1) hub.writeTasks(auth, { deviceId: 'mac', action: 'create', title: 'n' + index, baseRevision: 4 })
    expect(() => hub.writeTasks(auth, { deviceId: 'mac', action: 'create', title: 'overflow', baseRevision: 4 })).toThrow()
    expect(() => hub.writeTasks(auth, { deviceId: '../etc', action: 'create', title: 'bad', baseRevision: 4 })).toThrow()
    const card = onceDecisionIds({ approval: { decisions: [{ id: 'accept', label: '允许一次' }, { id: 'decline', label: '拒绝' }] } })
    if (!card) throw new Error('card')
    hub.rememberCard('req-1', card)
    const again = createPhoneHub({ store: devices, now: () => 5_000, findNode: (digest) => devices.findByTokenDigest(digest) })
    expect(again.cardFor('req-1')?.allowedIds.has('decline')).toBe(true)
    hub.watch(auth, 'mac|dsh|s1')
    hub.unwatch(auth, 'mac|dsh|s1')
    expect(hub.watchedBy(phone.record.id).size).toBe(0)
  })

  it('does not mark a push delivered when the key is missing', async () => {
    const result = await deliverPush({
      config: undefined,
      deviceId: 'phone-1',
      target: { provider: 'apns', token: 'abc' },
      notice: { kind: 'approval', title: '审批', body: '一次', dedupeKey: 'approval:1' },
    })
    expect(result).toEqual({ delivered: false, reason: 'unconfigured' })
  })

  it('invalidates the previous code when the desktop QR rotates', () => {
    const devices = store()
    const hub = createPhoneHub({ store: devices, now: () => 5_000 })
    const first = hub.issuePairing('account-a', 'https://hub.example')
    const second = hub.issuePairing('account-a', 'https://hub.example', first.code)
    expect(second.code).not.toBe(first.code)
    expect(second.url.includes('token')).toBe(false)
    expect(() => hub.redeem(first.code, '我的手机', 'install-2')).toThrow()
    expect(hub.redeem(second.code, '我的手机', 'install-2').record.role).toBe('phone')
    expect(pairingRefreshDelay(second.expiresAt, 5_000)).toBe(55_000)
  })

  it('omits a face the node could not read', () => {
    expect(forwardBody({ tasks: [{ id: 'a' }], memory: null, roster: null })).toEqual({ read: true, tasks: [{ id: 'a' }] })
  })

  it('reads a real snapshot and refuses edit until DSH advertises it', async () => {
    const host = {
      board: {
        snapshot: () => ({ revision: 3, tasks: [{ id: 't', title: '报告', status: 'todo' }] }),
        apply: () => ({ revision: 4, tasks: [] }),
      },
    }
    expect(boardCapabilities(host.board).apply).toEqual([])
    const faces = await readPhoneFaces(host, true)
    expect(faces.tasks).toEqual([{ id: 't', title: '报告', status: 'todo' }])
    expect(faces.memory).toBeNull()
    expect(await applyBoardCommand(host, { id: 'c1', action: 'edit', baseRevision: 3, taskId: 't', title: '新标题' })).toEqual({ ok: false, code: 'unsupported' })
    const ready = {
      board: {
        ...host.board,
        capabilities: () => ({ revision: true, apply: ['edit'] as const }),
        apply: () => ({ revision: 4, tasks: [{ id: 't', title: '新标题' }] }),
      },
    }
    expect((await applyBoardCommand(ready, { id: 'c1', action: 'edit', baseRevision: 3, taskId: 't', title: '新标题' })).ok).toBe(true)
  })
})
