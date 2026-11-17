import { afterEach, describe, expect, it } from 'vitest'
import { registerMarshalRoutes, SESSION_COOKIE, DESKTOP_SESSION_COOKIE, DESKTOP_CSRF_COOKIE } from '../src/hub/api.ts'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { HubRelay } from '../src/hub/relay.ts'
import { createMemoryWeb } from './support/memory.ts'
import { runInNewContext } from 'node:vm'
import { PAGE_HTML, DESKTOP_PAGE_HTML } from '../src/hub/page.ts'

const TOKEN = 'desktop-test-token-0123456789abcdef'
const ORIGIN = 'https://marshal.example'
const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose() })

function start() {
  const web = createMemoryWeb()
  const registry = new DeviceRegistry()
  const relay = new HubRelay({ registry, now: Date.now, hubEpoch: 'desktop-test' })
  for (const desktopEmbed of [false, true]) {
    const routes = registerMarshalRoutes({ webServer: web.webServer, registry, relay,
      desktopEmbed, requireToken: TOKEN, publicOrigin: ORIGIN, loginFailureDelayMs: 0 })
    disposers.push(() => routes.dispose())
  }
  return web
}

describe('Desktop 内嵌管理面板', () => {
  it.each([PAGE_HTML, DESKTOP_PAGE_HTML])('浏览器原生 window.status 字符串属性不阻断登录页初始化', async (html) => {
    const nodes = new Map<string, { hidden: boolean; textContent: string; value: string; focus(): void; querySelector(): object }>()
    const element = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', value: '', focus() {}, querySelector: () => ({}) })
      return nodes.get(id)!
    }
    let windowStatus = ''
    const browser = {
      location: { origin: ORIGIN }, document: { getElementById: element },
      fetch: async () => ({ ok: false, status: 401 }), setInterval() {}, window: { addEventListener() {} },
      get status() { return windowStatus }, set status(value) { windowStatus = String(value) },
    }
    runInNewContext(html.split('<script>')[1]!.split('</script>')[0]!, browser)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(element('loginView').hidden).toBe(false)
    expect(element('appView').hidden).toBe(true)
    expect(windowStatus).toBe('')
  })

  it('只允许 DSH 桌面嵌入，页面所有请求使用独立命名空间', async () => {
    const web = start()
    const desktop = await web.request('/marshal/desktop')
    expect(desktop.statusCode).toBe(200)
    expect(desktop.header('content-security-policy')).toBe('frame-ancestors dsh-app://app')
    expect(desktop.header('x-frame-options')).toBeUndefined()
    expect(desktop.body).toContain('/marshal/desktop/login')
    expect(desktop.body).toContain('/marshal/desktop/api/stream')
    expect(desktop.body).not.toMatch(/\/marshal\/(?!desktop\/)/)
    expect(desktop.body).toContain(DESKTOP_CSRF_COOKIE)
    expect((await web.request('/marshal')).header('x-frame-options')).toBe('DENY')
  })

  it('分区会话支持内嵌登录，且与外部网页会话隔离', async () => {
    const web = start()
    const login = async (path: string, origin = ORIGIN) => web.request(path, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
    })
    expect((await login('/marshal/desktop/login', 'dsh-app://app')).statusCode).toBe(403)
    const embedded = await login('/marshal/desktop/login')
    expect(embedded.statusCode).toBe(200)
    for (const cookie of embedded.cookies()) {
      expect(cookie).toContain('Secure; SameSite=None; Partitioned')
      expect(cookie).not.toContain('Domain')
    }
    expect(embedded.cookies()[0]).toContain('HttpOnly')
    const session = embedded.cookie(DESKTOP_SESSION_COOKIE)!
    expect((await web.request('/marshal/desktop/api/session', {
      headers: { cookie: `${DESKTOP_SESSION_COOKIE}=${session}` },
    })).statusCode).toBe(200)
    expect((await web.request('/marshal/api/session', {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    })).statusCode).toBe(401)
    const external = await login('/marshal/login')
    expect((await web.request('/marshal/desktop/api/session', {
      headers: { cookie: `${DESKTOP_SESSION_COOKIE}=${external.cookie(SESSION_COOKIE)}` },
    })).statusCode).toBe(401)
  })

  it('内嵌写操作仍要求 Origin 和 CSRF，退出撤销 SSE 并清除分区 cookie', async () => {
    const web = start()
    const login = await web.request('/marshal/desktop/login', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
    })
    const session = login.cookie(DESKTOP_SESSION_COOKIE)!
    const csrf = login.cookie(DESKTOP_CSRF_COOKIE)!
    const headers = { cookie: `${DESKTOP_SESSION_COOKIE}=${session}; ${DESKTOP_CSRF_COOKIE}=${csrf}`,
      origin: ORIGIN, 'content-type': 'application/json' }
    expect((await web.request('/marshal/desktop/logout', { method: 'POST', headers, body: '{}' })).statusCode).toBe(403)
    expect((await web.request('/marshal/desktop/logout', {
      method: 'POST', headers: { ...headers, origin: 'https://evil.example', 'x-marshal-csrf': csrf }, body: '{}',
    })).statusCode).toBe(403)
    const stream = web.start('/marshal/desktop/api/stream', { headers })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(stream.res.statusCode).toBe(200)
    const logout = await web.request('/marshal/desktop/logout', {
      method: 'POST', headers: { ...headers, 'x-marshal-csrf': csrf }, body: '{}',
    })
    expect(logout.statusCode).toBe(200)
    expect(logout.cookies().every(cookie => cookie.includes('Partitioned') && cookie.includes('Max-Age=0'))).toBe(true)
    expect(stream.res.writableEnded).toBe(true)
    expect((await web.request('/marshal/desktop/api/session', { headers })).statusCode).toBe(401)
  })
})
