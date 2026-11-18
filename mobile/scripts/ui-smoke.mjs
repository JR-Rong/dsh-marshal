#!/usr/bin/env node
/**
 * 手机端 UI 冒烟：用无头 Chrome 以 iPhone 尺寸跑一遍首页流程，产物截图落 docs/screenshots。
 *
 * 不需要真机与 Hub：健康检查、设备、会话接口都用路由拦截伪造，
 * 目的是验证外壳的布局、错误分支与交互链路，不替代真机验收。
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const SHOTS = join(ROOT, 'docs', 'screenshots')
const PORT = 5188
const HUB = 'https://hub.smoke.test'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const devices = {
  devices: [
    { id: 'rjr-mac-local', name: '本机 Mac（rjr）', agents: ['dsh', 'codex'], connectedAt: 1, lastSeen: Date.now(), syncing: false, stale: false },
    { id: 'account-cloud', name: '云端主机', agents: ['dsh'], connectedAt: 2, lastSeen: Date.now() - 60_000, syncing: false, stale: false },
  ],
}

const sessions = {
  sessions: [
    { deviceId: 'rjr-mac-local', agent: 'dsh', sessionId: 'session-a1b2c3d4-0000', running: true, updatedAt: Date.now() - 30_000, title: 'dsh-marshal手机端' },
    { deviceId: 'rjr-mac-local', agent: 'codex', sessionId: 'session-e5f6a7b8-1111', running: false, updatedAt: Date.now() - 3_600_000, title: 'CAD 零件簇批量出图' },
    { deviceId: 'account-cloud', agent: 'dsh', sessionId: 'session-c9d0e1f2-2222', running: false, updatedAt: Date.now() - 7_200_000, blank: true },
  ],
}

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname === '/' ? '/index.html' : url.pathname
    const file = join(DIST, path)
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  })
  return new Promise((resolveServer) => server.listen(PORT, '127.0.0.1', () => resolveServer(server)))
}

async function loadPlaywright() {
  try {
    return await import('playwright-core')
  } catch {
    return null
  }
}

async function main() {
  const playwright = await loadPlaywright()
  if (!playwright) {
    console.log('未安装 playwright-core，跳过 UI 冒烟')
    return
  }
  await mkdir(SHOTS, { recursive: true })
  const server = await startServer()
  // 用持久化上下文：普通 launch 在本机会卡在临时 profile 目录上。
  const context = await playwright.chromium.launchPersistentContext('/tmp/marshal-ui-profile', {
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    colorScheme: 'dark',
  })

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-marshal-token,content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'content-type': 'application/json; charset=utf-8',
  }
  const json = (body) => ({ status: 200, headers: cors, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) })

  // 设置了 MARSHAL_LIVE_HUB / MARSHAL_LIVE_TOKEN 时，用 Node 侧代理真实 Hub（绕过浏览器 CORS），
  // 这样截图里是真实设备与会话，而不是假数据。
  const liveHub = (process.env.MARSHAL_LIVE_HUB ?? '').replace(/\/+$/, '')
  const liveToken = process.env.MARSHAL_LIVE_TOKEN ?? ''
  const live = Boolean(liveHub && liveToken)
  if (live) console.log('  · 真实 Hub 模式：' + liveHub)

  let liveStatus = 'mock'
  const proxy = async (route) => {
    const url = new URL(route.request().url())
    const target = liveHub + url.pathname + (url.search || '')
    try {
      const response = await fetch(target, { headers: { 'x-marshal-token': liveToken, accept: 'application/json' } })
      const body = await response.text()
      liveStatus = 'live ' + response.status
      await route.fulfill({ status: response.status, headers: cors, contentType: 'application/json; charset=utf-8', body })
    } catch (error) {
      await route.fulfill({ status: 502, headers: cors, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ error: String(error) }) })
    }
  }

  await context.route('**/marshal/health', (route) => live ? proxy(route) : route.fulfill(json({ ok: true })))
  await context.route('**/marshal/api/devices', (route) => live ? proxy(route) : route.fulfill(json(devices)))
  await context.route('**/marshal/api/sessions**', (route) => {
    if (live) return proxy(route)
    const deviceId = new URL(route.request().url()).searchParams.get('device')
    return route.fulfill(json({ sessions: sessions.sessions.filter((row) => row.deviceId === deviceId) }))
  })

  context.setDefaultTimeout(8000)
  const step = (name) => console.log('  ·', name)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle' })

  const webStorage = await page.evaluate(() => {
    localStorage.removeItem('dsh-marshal-mobile.config')
    return true
  })
  if (!webStorage) throw new Error('无法清理本地配置')
  await page.reload({ waitUntil: 'networkidle' })

  await page.getByText('连接调度中心').waitFor({ timeout: 5000 })
  step('首次配置页')
  await page.screenshot({ path: join(SHOTS, '01-setup.png') })

  await page.locator('input[type="url"]').first().fill(live ? liveHub : HUB)
  await page.locator('input[type="password"]').first().fill(live ? liveToken : '0123456789abcdef0123456789abcdef')
  await page.getByRole('button', { name: '先测试连接' }).click()
  await page.getByText(/连接成功/).waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: '保存并进入' }).click()

  await page.getByText('已连接调度中心').waitFor({ timeout: 8000 })
  step('首页仪表盘')
  await page.screenshot({ path: join(SHOTS, live ? '07-live-home.png' : '02-home.png') })

  // 展开设备，看会话列表
  await page.locator('.device .device-head').first().click()
  step('展开设备会话')
  await page.screenshot({ path: join(SHOTS, live ? '08-live-expanded.png' : '03-home-expanded.png') })

  // 设置页
  await page.getByRole('button', { name: '设置' }).click()
  await page.locator('.topbar .title strong').filter({ hasText: '设置' }).waitFor({ timeout: 8000 })
  step('设置页')
  await page.screenshot({ path: join(SHOTS, '04-settings.png') })

  // 应用锁：开启 → 连续两次输入 6 位 PIN（111111）
  await page.getByRole('button', { name: '开启', exact: true }).click()
  await page.getByText('设置 6 位 PIN').waitFor({ timeout: 8000 })
  step('应用锁：设置 PIN')
  for (let i = 0; i < 6; i += 1) await page.getByRole('button', { name: '1', exact: true }).click()
  await page.getByText('再输入一次确认').waitFor({ timeout: 5000 })
  await page.screenshot({ path: join(SHOTS, '05-lock-set.png') })
  for (let i = 0; i < 6; i += 1) await page.getByRole('button', { name: '1', exact: true }).click()
  await page.getByText('已开启，启动时需 6 位 PIN').waitFor({ timeout: 5000 })
  await page.screenshot({ path: join(SHOTS, '06-lock-enabled.png') })

  await context.close()
  server.close()

  const report = {
    mode: live ? `live (${liveStatus})` : 'mock',
    hub: live ? liveHub : HUB,
    viewport: '390x844@3x',
    screens: ['01-setup.png', '02-home.png', '03-home-expanded.png', '04-settings.png', '05-lock-set.png', '06-lock-enabled.png'],
    pageErrors: errors,
  }
  await writeFile(join(SHOTS, 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n')
  if (errors.length > 0) {
    console.error('页面报错：', errors)
    process.exitCode = 1
    return
  }
  console.log('UI 冒烟通过，截图见 docs/screenshots/')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
  // 兜底释放：否则静态服务会把进程挂住，CI 里表现为「卡死」。
  setTimeout(() => process.exit(1), 500)
})
