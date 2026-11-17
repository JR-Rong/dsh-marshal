import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAccountLogin, dshAccountHash, DSH_ACCOUNT_ORIGIN } from '../src/hub/account.ts'
import { registerMarshalRoutes, DESKTOP_SESSION_COOKIE } from '../src/hub/api.ts'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { HubRelay } from '../src/hub/relay.ts'
import { mountAccountConnection } from '../src/node/account.ts'
import { parseConfig } from '../src/config.ts'
import type { MarshalContext } from '../src/dsh-types.ts'
import { createMemoryWeb } from './support/memory.ts'
import { runInNewContext } from 'node:vm'
import { DESKTOP_PAGE_HTML } from '../src/hub/page.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureInstall } from '../src/hub/identity.ts'

const owner = dshAccountHash('owner-1'), ORIGIN = 'https://marshal.example'
const cleanups: (() => void)[] = []
afterEach(() => { for (const stop of cleanups.splice(0)) stop() })
const profile = (id = 'owner-1') => Response.json({ code: 0, data: { biz_code: 0, biz_data: { id, id_profile: { name: '测试用户' } } } })

describe('DSH account identity and login', () => {
  it('automatically enrolls only verified owners; retries preserve policy and revoked devices stay revoked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'marshal-enroll-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const install = ensureInstall(join(dir, 'devices.json')), web = createMemoryWeb(), registry = new DeviceRegistry()
    const relay = new HubRelay({ registry, now: Date.now, hubEpoch: 'enroll-test' })
    let providerId = 'owner-1'
    const accountLogin = createAccountLogin(owner, { fetch: async () => profile(providerId) })
    cleanups.push(registerMarshalRoutes({ webServer: web.webServer, registry, relay, accountLogin, deviceStore: install.store, operatorId: install.operatorId, requireToken: 'test-token', publicOrigin: ORIGIN, loginFailureDelayMs: 0 }).dispose)
    const input = { grant: 'private-grant', installationId: '12345678-1234-1234-1234-123456789abc', tokenDigest: 'a'.repeat(64), name: 'New Mac', shareContent: true }
    let attempt = 0
    const enroll = (body = input, headers = {}) => web.request('/marshal/account/enroll', { method: 'POST', remoteAddress: '127.0.0.' + ++attempt, headers, body: JSON.stringify(body) })
    expect((await enroll(input, { origin: ORIGIN })).statusCode).toBe(403)
    expect((await enroll({ ...input, userId: 'owner-1' } as any)).statusCode).toBe(400)
    providerId = 'someone-else'; expect((await enroll()).json()).toMatchObject({ code: 'account-mismatch' })
    providerId = 'owner-1'
    const result = await enroll(), id = result.json<{ deviceId: string }>().deviceId
    expect(result.statusCode).toBe(200); expect(result.body).not.toContain('private-grant'); expect(result.body).not.toContain(input.tokenDigest)
    expect(install.store.findById(id)).toMatchObject({ allowContent: true, allowDiscussion: true, allowInteractions: false })
    install.store.setPolicy(id, { allowContent: false, allowDiscussion: false })
    expect((await enroll()).json()).toMatchObject({ deviceId: id, allowContent: false, allowDiscussion: false })
    expect((await enroll({ ...input, tokenDigest: 'b'.repeat(64) })).json()).toMatchObject({ code: 'duplicate-id' })
    install.store.revoke(id); expect((await enroll()).json()).toMatchObject({ code: 'revoked' })
  })
  it('verifies the official provider, issues a one-use expiring ticket and never returns the grant', async () => {
    let now = 1000
    const provider = vi.fn<typeof fetch>(async () => profile())
    const service = createAccountLogin(owner, { fetch: provider, now: () => now })
    const first = await service.exchange('private-grant')
    expect(provider.mock.calls[0]?.[0]).toBe(DSH_ACCOUNT_ORIGIN + '/auth-api/v0/users/current')
    expect(provider.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', headers: { 'x-dsh-auth-token': 'private-grant' } })
    expect(JSON.stringify(first)).not.toContain('private-grant')
    expect(service.consume(first.ticket)).toEqual({ accountHash: owner, name: '测试用户' })
    expect(service.consume(first.ticket)).toBeUndefined()
    const expired = await service.exchange('private-grant')
    now = expired.expiresAt
    expect(service.consume(expired.ticket)).toBeUndefined()
    service.dispose()
    await expect(service.exchange('private-grant')).rejects.toMatchObject({ code: 'account-unavailable' })
  })
  it.each([
    ['other account', () => profile('other-account'), 'account-mismatch'],
    ['signed out', () => Response.json({ code: 40003 }), 'account-required'],
    ['invalid identity', () => Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 1 } } }), 'account-unavailable'],
    ['oversize', () => new Response('x'.repeat(65537)), 'account-unavailable'],
    ['provider outage', () => { throw Error('secret provider message') }, 'account-unavailable'],
  ] as const)('fails closed on %s', async (_label, response, code) => {
    const service = createAccountLogin(owner, { fetch: async () => response() })
    await expect(service.exchange('private-grant')).rejects.toMatchObject({ code, message: 'marshal: ' + code })
  })
  it('bounds concurrent verification and refuses malformed grants before contacting provider', async () => {
    let resolve!: () => void
    const wait = new Promise<void>(done => { resolve = done })
    const provider = vi.fn<typeof fetch>(async () => { await wait; return profile() })
    const service = createAccountLogin(owner, { fetch: provider })
    for (const grant of ['', 'with space', 'x'.repeat(8193)]) await expect(service.exchange(grant)).rejects.toMatchObject({ code: 'account-required' })
    expect(provider).not.toHaveBeenCalled()
    const requests = Array.from({ length: 4 }, () => service.exchange('grant').catch(error => error))
    await expect(service.exchange('grant')).rejects.toMatchObject({ code: 'rate-limited' })
    service.dispose(); resolve()
    expect((await Promise.all(requests)).every(value => value.code === 'account-unavailable')).toBe(true)
  })
  it('shares tickets between Host exchange and desktop login, rejects token fallback, wrong Origin and replay', async () => {
    const web = createMemoryWeb(), registry = new DeviceRegistry()
    const relay = new HubRelay({ registry, now: Date.now, hubEpoch: 'account-test' })
    const accountLogin = createAccountLogin(owner, { fetch: async () => profile() })
    for (const desktopEmbed of [false, true]) cleanups.push(registerMarshalRoutes({ webServer: web.webServer,
      registry, relay, accountLogin, desktopEmbed, requireToken: 'old-dashboard-token', publicOrigin: ORIGIN, loginFailureDelayMs: 0 }).dispose)
    expect((await web.request('/marshal/desktop')).body).toContain('var accountMode = true;')
    const exchange = (body: object, headers = {}) => web.request('/marshal/account/exchange', { method: 'POST', body: JSON.stringify(body), headers })
    expect((await exchange({ grant: 'grant' }, { origin: ORIGIN })).statusCode).toBe(403)
    expect((await exchange({ grant: 'grant', userId: 'owner-1' })).statusCode).toBe(400)
    const ticket = (await exchange({ grant: 'grant' })).json<{ ticket: string }>().ticket
    const login = (body: object, origin = ORIGIN) => web.request('/marshal/desktop/login', { method: 'POST', headers: { origin }, body: JSON.stringify(body) })
    expect((await login({ ticket }, 'https://evil.example')).statusCode).toBe(403)
    expect((await login({ token: 'old-dashboard-token' })).statusCode).toBe(400)
    const signed = await login({ ticket })
    expect(signed.statusCode).toBe(200)
    expect(signed.json()).toMatchObject({ account: { accountHash: owner }, workspaceName: '我的调度空间' })
    expect(signed.cookies()[0]).toContain('HttpOnly')
    expect(signed.cookies()[0]).toContain('Partitioned')
    expect((await login({ ticket })).statusCode).toBe(401)
    const cookie = `${DESKTOP_SESSION_COOKIE}=${signed.cookie(DESKTOP_SESSION_COOKIE)}`
    expect((await web.request('/marshal/desktop/api/session', { headers: { cookie } })).json()).toMatchObject({ account: { accountHash: owner } })
    expect((await web.request('/marshal/api/session', { headers: { cookie } })).statusCode).toBe(401)
  })
  it('local Host exposes only status to its exact desktop origin and handles signed-out state', async () => {
    const web = createMemoryWeb()
    let signedIn = true
    const ctx: MarshalContext = { webServer: web.webServer, logger: { info() {}, warn() {}, error() {} },
      deepseekAccount: { async getPlatformSession() { return signedIn ? { origin: DSH_ACCOUNT_ORIGIN, token: 'secret', userId: 'owner-1' } : null } },
      inject(_services, callback) { callback(ctx) }, effect(setup) { cleanups.push(setup() as () => void) }, on() { return () => {} } }
    mountAccountConnection(ctx, parseConfig({ role: 'node', accountLogin: true, deviceId: 'mac', token: 'device-token-0123456789', hubUrl: 'wss://marshal.example/marshal/uplink' }, 'host'))
    const status = (origin: string, extra = true) => web.request('/marshal/account/status', { method: 'POST', headers: { origin, ...(extra ? { 'x-marshal-account': '1' } : {}) } })
    expect((await status('https://evil.example')).statusCode).toBe(403)
    expect((await status('dsh-app://app', false)).statusCode).toBe(403)
    expect((await status('dsh-app://app')).json()).toEqual({ ok: true, accountHash: owner })
    expect((await web.request('/marshal/account/status', { method: 'POST', headers: { 'x-marshal-account': '1' } })).statusCode).toBe(200)
    expect((await web.request('/marshal/account/status', { method: 'POST', remoteAddress: '192.168.1.100', headers: { 'x-marshal-account': '1' } })).statusCode).toBe(403)
    expect((await web.request('/marshal/account/status', { method: 'POST', remoteAddress: '192.168.1.100', headers: { origin: 'dsh-app://app', 'x-marshal-account': '1' } })).statusCode).toBe(403)
    expect((await web.request('/marshal/account/status', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'x-marshal-account': '1' } })).statusCode).toBe(403)
    signedIn = false
    expect((await status('dsh-app://app')).json()).toEqual({ ok: false, code: 'account-required', accountHash: null })
  })
  it('requires a configured owner on an account-enabled private Hub', () => {
    expect(() => parseConfig({ role: 'hub', accountLogin: true }, 'host')).toThrow()
    expect(() => createAccountLogin('client-supplied-username')).toThrow()
  })
  it('hides token input, waits for native account verification and ignores late login after logout', async () => {
    const nodes = new Map<string, any>()
    const element = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', value: '', focus() {}, querySelector: () => ({}) })
      return nodes.get(id)
    }
    let finish!: (value: unknown) => void
    const fetcher = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const browser = { location: { origin: ORIGIN }, document: { getElementById: element }, fetch: fetcher,
      setInterval() {}, window: { addEventListener() {} }, enterApp: vi.fn() }
    runInNewContext(DESKTOP_PAGE_HTML.split('<script>')[1]!.split('</script>')[0]!.replace('var accountMode = false;', 'var accountMode = true;'), browser)
    expect(fetcher).not.toHaveBeenCalled()
    expect(element('loginForm').hidden).toBe(true)
    expect(element('accountLogin').hidden).toBe(false)
    browser.enterApp = vi.fn()
    const pending = runInNewContext("loginWithAccount({ticket:'one-use-ticket'})", browser)
    await runInNewContext("logoutAccount('已退出')", browser)
    finish({ ok: true, json: async () => ({ csrf: 'csrf', account: { accountHash: owner } }) })
    await pending
    expect(browser.enterApp).not.toHaveBeenCalled()
    expect(element('appView').hidden).toBe(true)
  })
})
