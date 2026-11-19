#!/usr/bin/env node
/**
 * 真 Hub 界面联调（只读）：本地静态服务 + /marshal/api 反向代理，
 * 代理侧注入 x-marshal-token，浏览器里不出现真实令牌。
 *
 *   MARSHAL_LIVE_HUB=https://hub.example.com \
 *   MARSHAL_LIVE_TOKEN=<dashboardToken> \
 *   node scripts/ui-live.mjs
 *
 * 只做 devices/sessions/controls/history/inputs/stream；不发送 prompt、不答审批。
 * 截图写到 /tmp/marshal-live-shots/，不提交仓库。
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const SHOTS = '/tmp/marshal-live-shots'
const PORT = 5191
const HUB = (process.env.MARSHAL_LIVE_HUB ?? '').replace(/\/+$/, '')
const TOKEN = process.env.MARSHAL_LIVE_TOKEN ?? ''
const DSH_ORIGIN = (process.env.DSH_ORIGIN ?? 'http://127.0.0.1:64766').replace(/\/+$/, '')
if (!HUB || !TOKEN) {
  console.error('需要 MARSHAL_LIVE_HUB 与 MARSHAL_LIVE_TOKEN')
  process.exit(2)
}
let accountSession = null

/** 用本机 DSH 账号换一张 ticket，再换 Hub cookie；只读群聊用。 */
async function loginAccount() {
  try {
    const local = await fetch(DSH_ORIGIN + '/marshal/account/login', {
      method: 'POST', headers: { 'x-marshal-account': '1', accept: 'application/json' },
    })
    const ticket = await local.json()
    if (!ticket?.ok || typeof ticket.ticket !== 'string') return null
    const login = await fetch(HUB + '/marshal/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: HUB },
      body: JSON.stringify({ ticket: ticket.ticket }),
    })
    const body = await login.json().catch(() => null)
    if (login.status !== 200 || body?.ok !== true || typeof body.csrf !== 'string') return null
    const raw = (login.headers.getSetCookie?.() ?? []).join('; ')
    const session = raw.match(/__Host-marshal-session=([^;,\s]+)/)?.[1]
    if (!session) return null
    return { cookie: '__Host-marshal-session=' + session + '; __Host-marshal-csrf=' + body.csrf, csrf: body.csrf }
  } catch {
    return null
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

async function bodyOf(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname.startsWith('/marshal/api/')) {
        const target = new URL(url.pathname + url.search, HUB)
        const isDiscussion = url.pathname === '/marshal/api/discussions' || url.pathname.startsWith('/marshal/api/discussions/')
        const headers = isDiscussion && accountSession
          ? {
            accept: req.headers.accept ?? 'application/json',
            cookie: accountSession.cookie,
            ...(req.method !== 'GET' && req.method !== 'HEAD'
              ? { origin: HUB, 'x-marshal-csrf': accountSession.csrf }
              : {}),
          }
          : { accept: req.headers.accept ?? 'application/json', 'x-marshal-token': TOKEN }
        if (req.headers['content-type']) headers['content-type'] = req.headers['content-type']
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await bodyOf(req)
        const upstream = await fetch(target, { method: req.method, headers, body })
        const type = upstream.headers.get('content-type') ?? 'application/json'
        res.writeHead(upstream.status, {
          'content-type': type,
          'cache-control': 'no-store',
          ...(type.includes('text/event-stream') ? { connection: 'keep-alive', 'x-accel-buffering': 'no' } : {}),
        })
        if (upstream.body) Readable.fromWeb(upstream.body).pipe(res)
        else res.end()
        return
      }
      const path = url.pathname === '/' ? '/index.html' : url.pathname
      const file = join(DIST, path)
      if (!file.startsWith(DIST) || !existsSync(file)) { res.writeHead(404).end('not found'); return }
      const data = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(data)
    } catch (error) {
      res.writeHead(502).end('proxy error: ' + (error instanceof Error ? error.message : 'unknown'))
    }
  })
  return new Promise((resolveServer) => server.listen(PORT, '127.0.0.1', () => resolveServer(server)))
}

async function main() {
  const playwright = await import('playwright-core').catch(() => null)
  if (!playwright) { console.log('未安装 playwright-core'); return }
  await mkdir(SHOTS, { recursive: true })
  accountSession = await loginAccount()
  console.log('account session:', accountSession ? 'ok' : 'unavailable (group steps skipped)')
  const server = await startServer()
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true, locale: 'zh-CN', colorScheme: 'dark',
  })
  context.setDefaultTimeout(15000)
  const config = JSON.stringify({
    version: 1, hubUrl: 'http://127.0.0.1:' + PORT, token: 'proxy-token-not-real-0000',
    label: 'live', lock: null,
    ...(accountSession ? {
      account: {
        cookies: '__Host-marshal-session=proxy; __Host-marshal-csrf=proxy',
        csrf: 'proxy', expiresAt: Date.now() + 3_600_000, name: '验收账号',
      },
    } : {}),
    updatedAt: Date.now(),
  })
  await context.addInitScript(([key, value]) => { window.localStorage.setItem(key, value) }, ['dsh-marshal-mobile.config', config])
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('response', (response) => {
    const url = response.url()
    if (url.includes('/marshal/api/')) console.log('   api', response.request().method(), new URL(url).pathname, response.status())
  })

  // 真 SSE 长连接不会进入 networkidle，改用 DOM 就绪 + 选择器等待。
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('.device-head').first().waitFor()
  const deviceNames = await page.locator('.device-head .name').allInnerTexts()
  await page.screenshot({ path: join(SHOTS, '01-home-live.png') })
  console.log('devices:', deviceNames.join(' | '))

  await page.locator('.device-head').first().click()
  await page.locator('.session').first().waitFor()
  const sessionCount = await page.locator('.session').count()
  await page.screenshot({ path: join(SHOTS, '02-sessions-live.png') })
  console.log('sessions rendered:', sessionCount)

  await page.locator('.session').first().click()
  await page.locator('.composer-tools').waitFor()
  await page.locator('.composer input').waitFor()
  await page.waitForTimeout(800)
  const stats = await page.locator('.stat-row .chip').allInnerTexts()
  const models = await page.locator('select[aria-label="本次发送模型"] option').count()
  await page.screenshot({ path: join(SHOTS, '03-session-live.png') })
  console.log('session stats:', stats.join(' / ') || '(none)')
  console.log('model options:', models)

  await page.getByRole('button', { name: '控制' }).click()
  await page.getByText(/模型目录（/).waitFor()
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(SHOTS, '04-controls-live.png'), fullPage: true })
  const modelRows = await page.locator('.card .row-between').count()
  console.log('controls rows:', modelRows)

  let groupRooms = []
  let groupMessages = 0
  let groupTitle = ''
  if (accountSession) {
    await page.getByRole('button', { name: '返回' }).first().click()
    await page.getByRole('button', { name: '返回' }).first().click()
    await page.getByRole('button', { name: '返回' }).first().click()
    await page.getByRole('button', { name: '群聊' }).click()
    await page.getByText(/房间（/).waitFor()
    // 等列表真正返回（房间按钮或明确的空态），不要只等标题。
    await page.waitForFunction(() => document.body.innerText.includes('暂无群聊房间') || document.querySelectorAll('.session').length > 0, null, { timeout: 15000 }).catch(() => {})
    groupRooms = await page.locator('.session .copy strong').allInnerTexts()
    await page.screenshot({ path: join(SHOTS, '05-groups-live.png') })
    console.log('group rooms:', groupRooms.length, groupRooms.slice(0, 3).join(' | '))
    if (groupRooms.length > 0) {
      await page.locator('.session').first().click()
      await page.getByText(/内容保留至/).waitFor()
      await page.waitForTimeout(600)
      groupTitle = await page.locator('.topbar .title strong').first().innerText()
      groupMessages = await page.locator('.transcript .msg').count()
      await page.screenshot({ path: join(SHOTS, '06-group-room-live.png') })
      console.log('group room:', groupTitle, 'messages:', groupMessages)
    }
  }

  // 真 SSE 会让 Chromium 的 close 等待；报告落盘后直接退出，避免脚本挂死。
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
  server.close()
  const report = {
    hub: HUB, devices: deviceNames, sessions: sessionCount, stats, modelOptions: models,
    groupRooms, groupTitle, groupMessages, pageErrors: errors, shots: SHOTS,
  }
  await writeFile(join(SHOTS, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('LIVE UI PASS', errors.length ? 'WITH ERRORS: ' + errors.join('; ') : '')
  process.exit(errors.length ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
  setTimeout(() => process.exit(1), 500)
})