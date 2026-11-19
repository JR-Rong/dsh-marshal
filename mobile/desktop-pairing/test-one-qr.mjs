import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const here = import.meta.dirname
const root = path.resolve(here, '..')
const code = fs.readFileSync(path.join(here, 'marshal-phone-connect.js'), 'utf8')
const qr = fs.readFileSync(path.join(root, 'node_modules/qrcode-generator/dist/qrcode.js'), 'utf8')
const block = code
  .replace('/* __QRCODE_LIB__ */', () => qr)
  .replace('"__HUB__"', JSON.stringify('https://hub.example.com'))
  .replace('"__TOKEN__"', JSON.stringify('t'.repeat(64)))
const html = '<!doctype html><html><head><base href="http://app.test/">'
  + '<style>body{background:#151719;color:#eee;height:100vh}.header{display:flex;gap:8px;padding:12px}</style>'
  + '</head><body>'
  + '<div id="cross"><div>跨设备群聊</div><div class="header"><button>重新连接</button></div></div>'
  + '<script>' + block + '</scr' + 'ipt></body></html>'

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
await page.route('http://app.test/marshal/account/login', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ ok: true, ticket: 'k'.repeat(43), expiresAt: Date.now() + 60000 }),
}))
await page.route('http://app.test/remote-bridge/pair/token', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ token: 'b'.repeat(43), url: 'ws://127.0.0.1:1234/ios/v1?token=' + 'b'.repeat(43), expiresAt: Date.now() + 30000 }),
}))
await page.setContent(html, { waitUntil: 'load' })
await page.locator('#marshal-phone-connect-inline').waitFor({ timeout: 5000 })
await page.evaluate(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text } } })
})
await page.locator('#marshal-phone-connect-inline').click()
await page.locator('#marshal-phone-connect-modal').waitFor({ timeout: 5000 })
await page.waitForFunction(() => (document.querySelector('[data-status]')?.textContent ?? '').includes('DSH'), null, { timeout: 5000 })
console.log('status', await page.locator('[data-status]').innerText())
console.log('qr', await page.locator('[data-qr] svg').count())
await page.locator('[data-copy]').click()
await page.waitForTimeout(300)
const link = await page.evaluate(() => window.__copied)
console.log('link prefix', String(link).slice(0, 30))
const url = new URL(link)
const payload = JSON.parse(Buffer.from(url.searchParams.get('payload'), 'base64url').toString('utf8'))
console.log('payload', {
  hub: payload.hub,
  hubTokenLen: payload.hubToken?.length,
  ticketLen: payload.ticket?.length,
  bridge: payload.bridge,
  bridgeTokenLen: payload.bridgeToken?.length,
})
console.log('bridge token stripped', !payload.bridge.includes('?token='))
console.log('errors', errors)
await browser.close()
