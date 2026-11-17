import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountSetup, parseSetupChoice, SetupStore } from '../src/setup.ts'
import { accountCloudRequest } from '../src/node/account.ts'
import { DSH_ACCOUNT_ORIGIN, dshAccountHash } from '../src/hub/account.ts'
import type { MarshalContext } from '../src/dsh-types.ts'
import { createMemoryWeb } from './support/memory.ts'
import { dshStatistics } from '../src/adapters/dsh/statistics.ts'
import { createDshAdapter } from '../src/adapters/dsh/adapter.ts'
import { createDshSurface } from '../src/adapters/dsh/surface.ts'

vi.mock('../src/node/account.ts', async original => ({ ...await original<typeof import('../src/node/account.ts')>(), accountCloudRequest: vi.fn() }))
const cleanup: (() => void)[] = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); vi.restoreAllMocks(); vi.mocked(accountCloudRequest).mockReset() })
const choice = { role: 'node', origin: 'https://hub.example.com', name: '新设备', shareContent: true }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-setup-')); cleanup.push(() => rmSync(dir, { force: true, recursive: true }))
  const store = new SetupStore(join(dir, 'setup.json')), web = createMemoryWeb(), active = vi.fn()
  const account = { origin: DSH_ACCOUNT_ORIGIN, token: 'provider-grant', userId: 'user' }
  let signedIn = true
  const ctx: MarshalContext = { webServer: web.webServer, deepseekAccount: { getPlatformSession: async () => signedIn ? account : null },
    logger: { info() {}, warn() {}, error() {} }, inject(_keys, callback) { callback(ctx) }, effect(fn) { cleanup.push(fn() as () => void) }, on() { return () => {} } }
  vi.mocked(accountCloudRequest).mockResolvedValue({ ok: true, deviceId: 'account-' + 'a'.repeat(32), accountHash: dshAccountHash('user') })
  const mount = () => mountSetup(ctx, {}, active, store)
  mount()
  const request = (body: object, headers = { 'x-marshal-setup': '1' }) => web.request('/marshal/setup', { method: 'POST', headers, body: JSON.stringify(body) })
  return { store, request, active, account, mount, signOut: () => { signedIn = false } }
}

describe('first-run setup', () => {
  it('requires role and a clean HTTPS origin, refuses browser cross-site writes', async () => {
    for (const origin of ['http://hub', 'https://user:pass@hub', 'https://hub/path', 'https://hub?token=x']) expect(() => parseSetupChoice({ ...choice, origin })).toThrow()
    const h = setup()
    expect((await h.request({ action: 'save', choice }, { 'x-marshal-setup': '1', origin: 'https://evil.example' } as any)).statusCode).toBe(403)
    expect(h.store.read()).toBeUndefined()
  })
  it('enrolls without user-entered tokens, persists privately and starts the configured node', async () => {
    const h = setup()
    expect((await h.request({ action: 'status' })).json()).toMatchObject({ ready: false, role: null })
    const saved = await h.request({ action: 'save', choice })
    expect(saved.json()).toMatchObject({ ready: true, role: 'node' })
    const args = vi.mocked(accountCloudRequest).mock.calls[0]![2] as any
    expect(args).toMatchObject({ grant: 'provider-grant', name: '新设备', shareContent: true })
    expect(args).not.toHaveProperty('token')
    expect(statSync(h.store.file).mode & 0o777).toBe(0o600)
    expect(readFileSync(h.store.file, 'utf8')).not.toContain('provider-grant')
    expect(saved.body).not.toContain(h.store.read()!.token)
    expect(h.active.mock.calls[0]?.[1]).toMatchObject({ role: 'node', accountLogin: true, agents: ['dsh', 'codex'], allowDiscussion: true })
    h.mount()
    expect(accountCloudRequest).toHaveBeenCalledTimes(1)
    expect((await h.request({ action: 'save', choice })).statusCode).toBe(409)
  })
  it('persists the same installation credential before a failed request and retries safely', async () => {
    const h = setup()
    vi.mocked(accountCloudRequest).mockRejectedValueOnce(Error('account-unavailable'))
    expect((await h.request({ action: 'save', choice })).json()).toMatchObject({ ready: false, chosen: true })
    const before = h.store.read()!
    await h.request({ action: 'save', choice })
    const after = h.store.read()!
    expect(after.token).toBe(before.token); expect(after.installationId).toBe(before.installationId)
    expect(after.config?.deviceId).toBe('account-' + 'a'.repeat(32))
  })
  it('waits for DSH login, and refuses an account switch during enrollment', async () => {
    const h = setup()
    vi.mocked(accountCloudRequest).mockImplementationOnce(async () => { h.signOut(); return { deviceId: 'account-' + 'a'.repeat(32), accountHash: dshAccountHash('user') } })
    expect((await h.request({ action: 'save', choice })).json()).toMatchObject({ ready: false, code: 'account-required' })
    expect(h.store.read()?.config).toBeUndefined(); expect(h.active).not.toHaveBeenCalled()
    await h.request({ action: 'save', choice }); expect(accountCloudRequest).toHaveBeenCalledTimes(1)
  })
  it('creates a distinct account-bound Hub when center role is selected', async () => {
    const h = setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'user' } } }))
    const response = await h.request({ action: 'save', choice: { ...choice, role: 'hub', origin: 'https://my-center.example' } })
    expect(response.json()).toMatchObject({ ready: true, role: 'hub' })
    expect(accountCloudRequest).not.toHaveBeenCalled()
    expect(h.active.mock.calls[0]?.[1]).toMatchObject({ role: 'hub', dshAccountHash: dshAccountHash('user'), publicOrigin: 'https://my-center.example' })
  })
})

describe('DSH statistics projections', () => {
  const values = { sessionStats: { turns: 2, steps: 3, decodeTokens: 524, decodeMs: 3498 },
    tokenUsage: { uncachedInputTokens: 20655, outputTokens: 524, cacheReadTokens: 9150, cacheWriteTokens: 0 },
    contextPressure: { projectedTokens: 11790, pressureTokens: 11639, contextWindow: 262144 }, secret: 'never forward' }
  it('uses authoritative projections, prefers projected context and rejects invalid numeric data', () => {
    expect(dshStatistics(values)).toMatchObject({ turns: 2, steps: 3, decodeTokens: 524, decodeMs: 3498, contextTokens: 11790 })
    expect(JSON.stringify(dshStatistics(values))).not.toContain('secret')
    expect(dshStatistics({ sessionStats: { turns: NaN, steps: -1 }, tokenUsage: { outputTokens: Infinity } })).toBeUndefined()
    expect(dshStatistics(undefined)).toBeUndefined()
  })
  it('transports counts through the DSH session snapshot without reading history or invoking a model', async () => {
    const prompt = vi.fn()
    const adapter = createDshAdapter(createDshSurface({ list: async () => ({ items: [{ sessionId: 's', running: false, blank: false, updatedAt: 100, projections: { values } }] }), prompt, cancel() {}, async *follow() {} }), { deviceId: 'mac', nodeEpoch: 'epoch' })
    const snapshot = await adapter.snapshot(new AbortController().signal)
    expect(snapshot.find(e => e.kind === 'session.updated')?.payload).toMatchObject({ counts: { turns: 2, steps: 3, inputTokens: 20655 } })
    expect(prompt).not.toHaveBeenCalled()
  })
})
