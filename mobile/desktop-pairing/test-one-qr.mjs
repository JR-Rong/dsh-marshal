import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const here = import.meta.dirname
const root = path.resolve(here, '..')
const code = fs.readFileSync(path.join(here, 'marshal-phone-connect.js'), 'utf8')
const qr = fs.readFileSync(path.join(root, 'node_modules/qrcode-generator/dist/qrcode.js'), 'utf8')
const block = code.replace('/* __QRCODE_LIB__ */', () => qr)
const html = '<!doctype html><html><head><base href="http://app.test/">'
  + '<style>body{background:#151719;color:#eee;height:100vh}.header{display:flex;gap:8px;padding:12px}</style>'
  + '</head><body>'
  + '<div id="cross"><div>跨设备群聊</div><div class="header"><button>重新连接</button></div></div>'
  + '<script>' + block + '</scr' + 'ipt></body></html>'

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
let issued = 0
await page.route('http://app.test/marshal/api/pairing', (route) => {
  issued += 1
  const code = 'code-' + issued
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      code,
      expiresAt: Date.now() + 60_000,
      url: 'marshal://pair?code=' + code + '&hub=' + encodeURIComponent('https://hub.example'),
    }),
  })
})
await page.setContent(html, { waitUntil: 'load' })
await page.locator('#marshal-phone-connect-inline').waitFor({ timeout: 5000 })
await page.locator('#marshal-phone-connect-inline').click()
await page.locator('#marshal-phone-connect-modal').waitFor({ timeout: 5000 })
await page.waitForFunction(() => (document.querySelector('[data-status]')?.textContent ?? '').includes('剩余'), null, { timeout: 5000 })
const svg = await page.locator('[data-qr] svg').innerHTML()
console.log('status', await page.locator('[data-status]').innerText())
console.log('has secret field', /token|ticket|dashboard/i.test(svg))
console.log('errors', errors)
await browser.close()
