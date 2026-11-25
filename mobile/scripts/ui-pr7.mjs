/** Mock-only acceptance check: npm run build && node scripts/ui-pr7.mjs. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const origin = 'https://pr7-mobile.test'
const now = Date.now()
const devices = [{ id: 'node-a', name: '测试电脑', agents: ['codex'], lastSeen: now }]
const sessions = ['甲', '乙'].map((title, i) => ({ deviceId: 'node-a', agent: 'codex', sessionId: `S${i}`, title }))
let revision = 1
let status = 'todo'
let title = '测试工单'
let cards = [[], Array.from({ length: 100 }, (_, i) => ({ requestId: `q${i}` }))]
let receipt
const pendingWrite = Promise.withResolvers()
let roomMessage = ''
let rejectRoomList = false
let roomTitle = '测试讨论室'
let holdOldRoomList = false
const oldRoomList = Promise.withResolvers()
const replacementRoomList = Promise.withResolvers()
const oldCatalog = [{
  id: 'codex:old-model', agent: 'codex', model: '旧凭证模型', deviceId: 'node-a', deviceName: '测试电脑',
}]
const edits = []
const errors = []

const browser = await chromium.launch({ channel: 'chrome', args: ['--disable-breakpad', '--disable-crash-reporter'] })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' })
  page.setDefaultTimeout(5000)
  page.on('pageerror', error => errors.push(error.message))
  await page.clock.install()
  await page.addInitScript(() => {
    if (!localStorage.getItem('dsh-marshal-mobile.config')) {
      localStorage.setItem('dsh-marshal-mobile.config', JSON.stringify({
        version: 1, hubUrl: location.origin, token: 'mph1.ui-fixture-not-a-real-credential', label: '', lock: null, updatedAt: Date.now(),
        account: { cookies: 'fixture=mock', csrf: 'mock', expiresAt: Date.now() + 3600_000 },
      }))
    }
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); if (url.endsWith('/stream')) window.mockStream = this }
      close() {}
    }
  })
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    const json = body => route.fulfill({ json: body })
    switch (url.pathname) {
      case '/marshal/api/devices': return json({ devices })
      case '/marshal/api/sessions': return json({ sessions })
      case '/marshal/api/roster': return json({ agents: [{ id: 'codex', deviceId: 'node-a', name: '测试成员' }] })
      case '/marshal/api/inputs': return json({ cards: cards[Number(route.request().postDataJSON().target.sessionId.slice(1))] })
      case '/marshal/api/board': {
        if (route.request().method() === 'GET') return json({ tasks: [{ id: 'task', title, status, deviceId: 'node-a', revision }], revisions: { 'node-a': revision }, receipts: receipt ? [receipt] : [] })
        const body = route.request().postDataJSON()
        edits.push(body)
        if (edits.length === 1) {
          return route.fulfill({ status: 503, json: {} })
        }
        if (edits.length === 2) {
          title = '他端修改'; revision++
          return json({ code: 'conflict' })
        }
        if (edits.length === 3) {
          await pendingWrite.promise
          receipt = { id: 'queued-edit', deviceId: 'node-a', action: 'edit', state: 'queued' }
          return json({ code: 'queued', commandId: receipt.id })
        }
        if (body.action !== 'edit') return json({ code: 'unsupported' })
        title = body.title; revision++
        receipt = { id: 'applied-edit', deviceId: 'node-a', action: 'edit', state: 'applied' }
        return json({ code: 'queued', commandId: receipt.id })
      }
      case '/marshal/api/history': return json({ result: { items: [] } })
      case '/marshal/api/command': return json({ ok: true, status: 'accepted', result: {} })
      case '/marshal/api/discussions': {
        const detail = url.searchParams.has('room')
        if (!detail) {
          if (route.request().headers().authorization === 'Bearer mph1.replacement-fixture') {
            await replacementRoomList.promise
            return route.fulfill({ status: 403, json: { code: 'unauthorized' } })
          }
          if (rejectRoomList) return route.fulfill({ status: 401, json: { code: 'unauthorized' } })
          if (holdOldRoomList) {
            await oldRoomList.promise
            return json({ rooms: [{ id: 'stale', title: '旧凭证迟到房间', state: 'idle' }], catalog: oldCatalog })
          }
        }
        const room = { id: 'room', title: roomTitle, state: 'idle',
          messages: roomMessage ? [{ id: 'message', author: 'user', text: roomMessage }] : [] }
        return json(detail ? { room } : { rooms: [room], catalog: oldCatalog })
      }
      case '/marshal/api/memory': return json({ entries: [] })
      case '/': return route.fulfill({ path: 'dist/index.html' })
      default: return /^\/assets\/[\w.-]+$/.test(url.pathname)
        ? route.fulfill({ path: 'dist' + url.pathname }) : json({})
    }
  })
  const screen = name => page.locator(`.screen-${name}`).waitFor()
  const tab = label => page.locator('.tab-item', { hasText: label })
  const button = label => page.getByRole('button', { name: label, exact: true })
  const badge = (label, text) => tab(label).getByText(text, { exact: true }).waitFor()
  await page.goto(origin)
  await screen('board')
  await badge('会话', '99+')
  await page.emulateMedia({ colorScheme: 'dark' })
  assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).colorScheme), 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).colorScheme), 'light')
  assert.deepEqual(await page.locator('.tab-label').allTextContents(), ['工单', '会话', '智能体', '节点'])
  for (const item of await page.locator('.tab-item').all()) {
    assert.ok((await item.boundingBox()).height >= 44)
    assert.ok(await item.locator('svg').count())
    assert.ok(await item.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 12)
  }

  const card = page.locator('.ticket-card').first()
  const drawer = page.getByRole('dialog')
  const add = button('新建编排工单')
  assert.ok(await add.locator('svg').count())
  const size = await add.boundingBox()
  assert.ok(size.width >= 44 && size.height >= 44)
  for (const theme of ['deepseek', 'white', 'dark', 'codex']) {
    await page.locator('html').evaluate((el, name) => { el.dataset.theme = name }, theme)
    assert.equal(await card.evaluate(el => getComputedStyle(el).backgroundColor.startsWith('rgb(')), true)
  }
  await page.locator('html').evaluate(el => { el.dataset.theme = 'system' })
  await card.click()
  await button('查看工单讨论 · 尚未关联群聊 ›').click()
  await screen('ticketGroup')
  await page.getByText(/没有已同步的群聊关联/).waitFor()
  await button('工单详情').click()
  assert.equal(await drawer.getByRole('heading', { name: '测试工单' }).count(), 1)
  await button('编辑标题').click()
  const draft = page.locator('#ticket-edit-title')
  await draft.fill('我的草稿')
  await button('保存标题').click()
  await drawer.getByText(/Hub 返回异常/).waitFor()
  await button('保存标题').click()
  await drawer.getByText(/看板已被别的修改抢先/).waitFor()
  assert.equal(await draft.inputValue(), '我的草稿')
  await button('确认新修订并保存').click()
  await button('关闭').click()
  await card.click()
  assert.equal(await button('确认完成').isDisabled(), true)
  assert.equal(edits.length, 3)
  pendingWrite.resolve()
  await drawer.getByText(/等待回执/).waitFor()
  assert.equal(await button('确认完成').isDisabled(), true)
  receipt = undefined
  await page.clock.fastForward(31_000)
  await drawer.getByText(/未找到回执/).waitFor()
  assert.equal(await button('确认完成').isEnabled(), true)
  assert.deepEqual(edits.map(({ baseRevision, title }) => [baseRevision, title]), [[1, '我的草稿'], [1, '我的草稿'], [2, '我的草稿']])

  assert.notEqual(await drawer.evaluate(el => getComputedStyle(el, '::backdrop').backdropFilter), 'none')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches), true)
  assert.equal(await drawer.evaluate(el => getComputedStyle(el, '::backdrop').backdropFilter), 'none')
  await page.keyboard.press('Escape')
  await drawer.waitFor({ state: 'detached' })
  assert.equal(await card.evaluate(el => document.activeElement === el), true)

  await add.click()
  await page.locator('#ticket-device').selectOption('node-a')
  await page.locator('#ticket-template').selectOption('research')
  await page.locator('#ticket-title').fill('新编排')
  await page.locator('#ticket-description').fill('需求说明')
  await button('创建工单').click()
  await drawer.getByText(/未启用|不支持/).waitFor()
  assert.deepEqual(edits[3], { action: 'create', deviceId: 'node-a', baseRevision: 2,
    template: 'research', title: '新编排', detail: '需求说明' })
  await button('关闭').click()
  assert.equal(await page.locator('.ticket-card').count(), 1)
  await card.click()
  await button('删除工单').click()
  assert.equal(edits.length, 4)
  await button('确认删除工单').click()
  await drawer.getByText(/未启用|不支持/).waitFor()
  assert.deepEqual(edits[4], { action: 'delete', deviceId: 'node-a', taskId: 'task', baseRevision: 2 })
  await button('关闭').click()

  await tab('智能体').click()
  await page.getByText('测试成员', { exact: true }).waitFor()
  await button('记忆与星系').click()
  assert.equal(await page.locator('#memory-galaxy').count(), 1)
  status = 'doing'
  await page.clock.fastForward(31_000)
  await badge('工单', '1')

  await tab('会话').click()
  await page.getByText('甲', { exact: true }).click()
  await screen('session')
  await button('控制').click()
  await screen('controls')
  await page.locator('.topbar').getByRole('button', { name: '返回' }).click()
  await page.locator('.topbar').getByRole('button', { name: '返回' }).click()
  await screen('sessions')
  await badge('会话', '99+')
  cards = [[], [{ requestId: 'missed-during-disconnect' }]]
  await page.evaluate(() => {
    window.mockStream.dispatchEvent(new MessageEvent('reset', { data: '{}' }))
  })
  await badge('会话', '1')
  await page.evaluate(() => {
    window.mockStream.onmessage({ data: JSON.stringify({
      deviceId: 'node-a', agent: 'codex', sessionId: 'S1', kind: 'input.requested', payload: { requestId: 'live-other-session' },
    }) })
  })
  await badge('会话', '2')
  const category = name => page.getByRole('group', { name: '会话类型' }).getByRole('button', { name, exact: true })
  await category('工单群').click()
  await page.getByText('暂无已关联群聊的工单。').waitFor()
  assert.equal(await category('工单群').getAttribute('aria-pressed'), 'true')
  await category('单聊').click()
  await screen('sessions')
  assert.equal(await category('单聊').getAttribute('aria-pressed'), 'true')
  await category('Agent 群聊').click()
  assert.equal(await category('Agent 群聊').getAttribute('aria-pressed'), 'true')
  await screen('groups')
  await page.getByText('测试讨论室', { exact: true }).waitFor()
  rejectRoomList = true
  await button('刷新群聊').click()
  await page.getByText(/令牌被 Hub 拒绝/).waitFor()
  assert.equal(await page.getByText('测试讨论室', { exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-marshal-mobile.config')).account?.csrf), 'mock')
  rejectRoomList = false
  roomTitle = '鉴权恢复后的讨论室'
  await button('刷新群聊').click()
  await page.getByText(roomTitle, { exact: true }).waitFor()
  await page.getByText(/令牌被 Hub 拒绝/).waitFor({ state: 'hidden' })
  await page.getByText(roomTitle, { exact: true }).click()
  await screen('groupRoom')
  await page.locator('.topbar').getByText(roomTitle, { exact: true }).waitFor()
  // Current Hub has no ticket-room association. Exercise the composer renderer
  // shared by real discussion rooms and the ticket-group route.
  const composer = page.locator('.composer input')
  await composer.fill('正在输入的问题')
  const original = await composer.elementHandle()
  await composer.evaluate(input => input.setSelectionRange(2, 4))
  await composer.dispatchEvent('compositionstart', { data: '工' })
  roomMessage = '轮询收到的消息'
  await page.clock.fastForward(4_500)
  await page.locator('.transcript').getByText(roomMessage).waitFor()
  assert.deepEqual(await original.evaluate(input => [input === document.activeElement, input.value, input.selectionStart, input.selectionEnd]),
    [true, '正在输入的问题', 2, 4])
  await composer.dispatchEvent('compositionend', { data: '工' })
  await page.locator('.topbar').getByRole('button', { name: '返回' }).click()
  await button('新建会话').click()
  await button('继续选择群成员').click()
  await screen('groupNew')
  await page.getByText('旧凭证模型', { exact: true }).waitFor()
  await page.locator('.topbar').getByRole('button', { name: '返回' }).click()
  await page.getByText(roomTitle, { exact: true }).waitFor()
  holdOldRoomList = true
  const listUrl = `${origin}/marshal/api/discussions`
  const started = page.waitForRequest(request => request.url() === listUrl)
  await button('刷新群聊').click()
  await started
  await tab('节点').click()
  await button('设置').click()
  await page.getByText('高级：管理令牌', { exact: true }).click()
  await page.locator('input[type="password"]').fill('mph1.replacement-fixture')
  await button('保存').click()
  await screen('board')
  await tab('会话').click()
  await page.getByText('读取群聊…', { exact: true }).waitFor()
  assert.equal(await page.getByText(roomTitle, { exact: true }).count(), 0)
  replacementRoomList.resolve()
  await page.getByText(/拒绝了 App 的来源（403）/).waitFor()
  await page.getByText('暂无群聊房间。').waitFor()
  assert.equal(await page.getByText(roomTitle, { exact: true }).count(), 0)
  const staleResponse = page.waitForResponse(response => response.url() === listUrl && response.status() === 200)
  oldRoomList.resolve()
  await (await staleResponse).finished()
  // Let the app consume the response body before checking the rendered list.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.getByText('旧凭证迟到房间', { exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-marshal-mobile.config')).account?.csrf), 'mock')
  await button('新建会话').click()
  await button('继续选择群成员').click()
  await screen('groupNew')
  await page.getByText('暂无可用模型；请返回群聊列表刷新。').waitFor()
  assert.equal(await page.getByText('旧凭证模型', { exact: true }).count(), 0)
  await page.locator('.topbar').getByRole('button', { name: '返回' }).click()
  await screen('groups')
  await tab('智能体').click()
  await screen('agents')
  await button('成员与预设').click()
  await page.getByRole('button', { name: /测试成员/ }).waitFor()
  await button('记忆与星系').click()
  await page.getByRole('button', { name: '记忆与星系', pressed: true }).waitFor()
  await tab('节点').click()
  await button('设置').click()
  await screen('settings')
  await page.locator('[data-choice="codex"]').click()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'codex')
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('dsh-marshal-mobile.config')).theme === 'codex')
  await page.reload()
  await screen('board')
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'codex')
  assert.deepEqual(errors, [])
  console.log('PR7 mock UI assertions passed: navigation, badges, polling, edit conflict, group auth recovery and credential isolation, theme persistence; pageErrors=0')
} finally {
  await browser.close()
}
