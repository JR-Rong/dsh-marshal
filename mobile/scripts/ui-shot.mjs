/** 用本机 Chrome 截取手机端首屏，验收 Apple 风格浅/深色外观。 */
import { chromium } from 'playwright-core'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173/'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots') + '/'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--hide-scrollbars', '--force-device-scale-factor=2'],
})

const context = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
})
const page = await context.newPage()

for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme })
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.screenshot({ path: OUT + 'apple-' + scheme + '.png', fullPage: false })
  console.log('shot', scheme, await page.title())
}

await browser.close()
