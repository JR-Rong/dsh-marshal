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
