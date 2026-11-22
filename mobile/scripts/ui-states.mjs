/** 用 mock Hub 截取首页与会话页，验收 Tab 栏与分组列表。 */
import { chromium } from 'playwright-core'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173/'
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots') + '/'

const now = Date.now()
const devices = [
  { id: 'macbook-pro', name: '本机 Mac（rjr）', agents: ['dsh', 'codex'], connectedAt: now - 9e6, lastSeen: now, syncing: false, stale: false },
  { id: 'studio', name: '工作室 Mac', agents: ['claude'], connectedAt: now - 8e7, lastSeen: now - 6e5, syncing: false, stale: false },
]
const roster = [
  { id: 'zai', deviceId: 'macbook-pro', name: '丞相' },
  { id: 'shangshu', deviceId: 'macbook-pro', name: '尚书' },
]
const sessions = [
  { deviceId: 'macbook-pro', agent: 'dsh', sessionId: 's1', running: true, updatedAt: now - 60_000, title: '移动端 Apple 风格重塑' },
  { deviceId: 'macbook-pro', agent: 'dsh', sessionId: 's2', running: false, updatedAt: now - 9e5, title: 'Hub 扫码配对回归' },
  { deviceId: 'macbook-pro', agent: 'codex', sessionId: 's3', running: false, updatedAt: now - 3e6, title: '任务看板验收' },
]

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--hide-scrollbars'] })
const context = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
})

await context.addInitScript(() => {
  try {
    localStorage.setItem('dsh-marshal-mobile.config', JSON.stringify({
      version: 1,
      hubUrl: 'https://hub.example.com',
      token: 'demo-token-0123456789abcdef',
      label: '',
      lock: null,
      updatedAt: Date.now(),
    }))
  } catch {}
})

const page = await context.newPage()
await page.route('https://hub.example.com/marshal/api/**', async (route) => {
  const url = route.request().url()
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  if (url.includes('/api/devices')) return json({ devices })
  if (url.includes('/api/roster')) return json({ agents: roster })
  if (url.includes('/api/sessions')) return json({ sessions })
  if (url.includes('/api/inputs')) return json({ cards: [] })
  if (url.includes('/api/board')) return json({ tasks: [], revisions: {}, receipts: [] })
  if (url.includes('/api/stream')) return new Promise(() => {}) // 保持事件流连接挂起
  return json({})
})

for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme })
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: out + 'home-' + scheme + '.png' })
  await page.getByRole('button', { name: '会话' }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: out + 'sessions-' + scheme + '.png' })
  console.log('shot', scheme)
}

await browser.close()
