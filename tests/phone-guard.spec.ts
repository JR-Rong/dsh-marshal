import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceStore, emptyDevicesState, serializeDevicesState } from '../src/hub/devices.ts'
import { registerMarshalRoutes } from '../src/hub/api.ts'
import { createPhoneHub } from '../src/hub/phone.ts'
import { PAGE_HTML } from '../src/hub/page.ts'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { HubRelay } from '../src/hub/relay.ts'
import { createMemoryWeb, type MemoryWeb } from './support/memory.ts'

const TOKEN = 'test-dashboard-token-0123456789abcdef'
const ORIGIN = 'https://marshal.example'

function freshStore(): DeviceStore {
  const path = join(mkdtempSync(join(tmpdir(), 'marshal-guard-')), 'devices.json')
  writeFileSync(path, serializeDevicesState(emptyDevicesState()), { mode: 0o600 })
  return new DeviceStore(path)
}

describe('phone guard', () => {
  let web: MemoryWeb | undefined
  let routes: { dispose(): void } | undefined
  afterEach(() => { routes?.dispose(); web = undefined })

  it('refuses operator reads for a node credential', async () => {
    const devices = freshStore()
    const node = devices.add('mac', 'Mac')
    const phone = createPhoneHub({
      store: devices,
      findNode: (digest) => devices.findByTokenDigest(digest),
    })
    const registry = new DeviceRegistry()
    const relay = new HubRelay({ registry, now: Date.now, hubEpoch: 'hub-test' })
    web = createMemoryWeb()
    routes = registerMarshalRoutes({
      webServer: web.webServer, registry, relay, requireToken: TOKEN, publicOrigin: ORIGIN,
      deviceStore: devices, phone, loginFailureDelayMs: 0,
    })
    const pairing = await web.request('/marshal/api/pairing', {
      method: 'POST',
      headers: { authorization: 'Bearer mnd1.' + node.token, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(pairing.statusCode).toBe(403)
    const denied = await web.request('/marshal/api/sessions', {
      headers: { authorization: 'Bearer mnd1.' + node.token },
    })
    expect(denied.statusCode).toBe(401)
    const history = await web.request('/marshal/api/history', {
      method: 'POST',
      headers: { authorization: 'Bearer mnd1.' + node.token, 'content-type': 'application/json' },
      body: JSON.stringify({ target: { deviceId: 'mac', agent: 'dsh', sessionId: 's' }, limit: 10 }),
    })
    expect(history.statusCode).toBe(401)
    const issued = phone.issuePairing('account-a', ORIGIN)
    const redeemed = phone.redeem(issued.code, '我的手机', 'install-guard')
    const allowed = await web.request('/marshal/api/sessions', {
      headers: { authorization: 'Bearer ' + redeemed.credential },
    })
    expect(allowed.statusCode).not.toBe(401)
  })

  it('drops phone memory on withdrawal, a changed grant, a disconnect, or a stale projection', async () => {
    const devices = freshStore()
    const node = devices.add('mac', 'Mac')
    devices.setPolicy('mac', { allowContent: true })
    let now = 5000
    const registry = new DeviceRegistry()
    let connectionId = 'connection-1'
    const attach = () => registry.attach({ id: 'mac', name: 'Mac', agents: ['dsh'] }, { send() {} }, now,
      { connectionId, nodeEpoch: 'node-test' })
    attach()
    const relay = new HubRelay({ registry, now: () => now, hubEpoch: 'hub-test' })
    const phone = createPhoneHub({
      store: devices, now: () => now,
      findNode: digest => devices.findByTokenDigest(digest),
      nodeConnection: id => registry.get(id)?.connectionId,
      accountOwnerForNode: () => 'account-a',
    })
    web = createMemoryWeb()
    routes = registerMarshalRoutes({
      webServer: web.webServer, registry, relay, requireToken: TOKEN, publicOrigin: ORIGIN,
      phone, loginFailureDelayMs: 0,
    })
    const client = phone.redeem(phone.issuePairing('account-a', ORIGIN).code, 'Phone', 'test-install')
    const other = phone.redeem(phone.issuePairing('account-b', ORIGIN).code, 'Other phone', 'other-install')
    const channel = web
    const path = '/marshal/api/memory'
    const put = (body: unknown) => channel.request(path, {
      method: 'POST', headers: { authorization: 'Bearer mnd1.' + node.token, 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId, policyRevision: devices.findById('mac')?.policyRevision, ...(body as object) }),
    })
    const get = async (credential = client.credential) => JSON.parse((await channel.request(path, {
      headers: { authorization: 'Bearer ' + credential },
    })).body).entries as unknown[]
    const published = { entries: [{ id: 'memory', layer: 'global', text: 'approved' }] }

    const post = await put(published)
    expect(post.statusCode).toBe(200)
    expect(JSON.parse(post.body)).toEqual({ ok: true })
    expect(await get()).toHaveLength(1)
    expect(await get(other.credential)).toEqual([])
    await put({ code: 'unavailable' })
    expect(await get()).toHaveLength(1)
    await put({ code: 'withheld' })
    expect(await get()).toEqual([])

    await put(published)
    devices.setPolicy('mac', { allowContent: false })
    await put(published)
    expect(await get()).toEqual([])
    devices.setPolicy('mac', { allowContent: true })
    expect(await get()).toEqual([])
    await put(published)
    devices.setPolicy('mac', { allowContent: false })
    devices.setPolicy('mac', { allowContent: true })
    expect(await get()).toEqual([])

    await put(published)
    registry.detach('mac')
    expect(await get()).toEqual([])
    connectionId = 'connection-2'
    attach()
    await put({ ...published, connectionId: 'connection-1' })
    expect(await get()).toEqual([])
    await put(published)
    expect(await get()).toHaveLength(1)
    connectionId = 'connection-3'
    attach()
    expect(await get()).toEqual([])
    await put(published)
    now += 45_000
    expect(await get()).toEqual([])
  })

  it('closes streams on revoke and keeps the phone row', () => {
    const devices = freshStore()
    const phone = createPhoneHub({ store: devices, now: () => 1_000 })
    const issued = phone.issuePairing('account-a', ORIGIN)
    const redeemed = phone.redeem(issued.code, '我的手机', 'install-revoke')
    let closed = false
    phone.attachStream(redeemed.record.id, () => { closed = true })
    phone.revoke(redeemed.record.id)
    expect(closed).toBe(true)
    const again = new DeviceStore(devices.file)
    expect(again.findById(redeemed.record.id)?.revoked).toBe(true)
    expect(readFileSync(devices.file, 'utf8')).not.toContain(redeemed.credential)
  })

  it('shows a revoke button on the hub page', () => {
    expect(PAGE_HTML).toContain('吊销')
    expect(PAGE_HTML).toContain('/marshal/api/phones/revoke')
  })
})
