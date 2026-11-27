#!/usr/bin/env node
/**
 * 手机端 UI 冒烟（原生控制台）：无头 Chrome + iPhone 尺寸，
 * 用路由拦截伪造 Hub 接口、注入假 EventSource，验证
 * 配置 → 设备 → 会话 → 消息流 → 审批 → 控制项 整条链路。
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const SHOTS = join(ROOT, 'artifacts', 'ui-smoke')
const HUB = 'https://hub.smoke.test'

const devices = {
  devices: [
    { id: 'mac-local', name: '本机 Mac', agents: ['dsh', 'codex'], connectedAt: 1, lastSeen: Date.now(), syncing: false, stale: false },
    { id: 'cloud-box', name: '云端主机', agents: ['dsh'], connectedAt: 2, lastSeen: Date.now() - 60_000, syncing: false, stale: false },
  ],
}

const sessions = {
  sessions: [
    {
      deviceId: 'mac-local', agent: 'dsh', sessionId: 'session-aaa', running: true,
      updatedAt: Date.now() - 60_000, title: 'dsh-marshal手机端',
      counts: { inputTokens: 476500, outputTokens: 151495, cacheReadTokens: 29052032, cacheWriteTokens: 0 },
      capability: {
        operations: ['prompt', 'answer', 'cancel'], ownership: 'attached', revision: 1, runtimeEpoch: 'epoch-1',
        tunables: [
          { id: 'model', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'v0-field-only' },
          { id: 'reasoning', scope: 'next-turn', effect: 'immediate', direction: 'tighten-only', editable: false, reason: 'v0-field-only' },
          { id: 'permission', scope: 'next-session', effect: 'next-session', editable: false, reason: 'v0-tighten-only' },
        ],
      },
    },
    { deviceId: 'mac-local', agent: 'dsh', sessionId: 'session-bbb', running: false, updatedAt: Date.now() - 7_200_000, title: 'CAD 零件簇出图' },
  ],
}

const history = {
  ok: true,
  status: 'confirmed',
  result: {
    completeness: 'complete',
    items: [
      { deviceId: 'mac-local', agent: 'dsh', sessionId: 'session-aaa', seq: 1, ts: Date.now() - 600_000, kind: 'user.message', payload: { text: '把手机端改成直连' } },
      { deviceId: 'mac-local', agent: 'dsh', sessionId: 'session-aaa', seq: 2, ts: Date.now() - 540_000, kind: 'message.completed', payload: { text: '已改为原生界面直连 Hub，不再加载网页。' } },
    ],
  },
}

const controls = {
  models: [
    { id: 'deepseek-account/deepseek-flash', label: 'DeepSeek Account · DeepSeek-V4.1-Flash', efforts: ['off', 'low', 'high', 'max'] },
    { id: 'deepseek-account/deepseek-v4-pro', label: 'DeepSeek Account · DeepSeek-V4-Pro', efforts: ['off', 'low', 'high', 'max'] },
  ],
  current: { model: 'deepseek-account/deepseek-flash', reasoning: 'low' },
}

const groupRooms = [
  { id: 'room-1', title: '手机端验收群', state: 'idle', createdAt: Date.now() - 600_000 },
]

const groupCatalog = [
  {
    id: 'dsh:deepseek-account:deepseek-flash', agent: 'dsh', model: 'deepseek-flash', provider: 'deepseek-account',
    deviceId: 'mac-local', deviceName: '本机 Mac', reasoningEfforts: ['off', 'low', 'high', 'max'],
  },
  {
    id: 'codex:gpt-5', agent: 'codex', model: 'gpt-5', provider: 'openai',
    deviceId: 'mac-local', deviceName: '本机 Mac', reasoningEfforts: [],
  },
]

const groupRoom = {
  id: 'room-1', title: '手机端验收群', state: 'idle', phase: 'idle', mode: 'discussion',
  rounds: 1, revision: 1, moderatorId: 'm1', cleared: false,
  createdAt: Date.now() - 600_000, expiresAt: Date.now() + 3_600_000,
  members: [
    { id: 'm1', name: '主编', model: { agent: 'dsh', model: 'deepseek-flash' }, reasoning: 'low' },
    { id: 'm2', name: '审查', model: { agent: 'codex', model: 'gpt-5' } },
  ],
  messages: [
    { id: 'gm1', author: 'user', text: '请汇总手机端 node 的验收结果', state: 'completed', at: Date.now() - 500_000 },
    { id: 'gm2', author: 'm1', text: '已收到。先核对双端产物、真 Hub 联调与权限边界。', state: 'completed', at: Date.now() - 400_000 },
  ],
  calls: [],
}

const inputs = {
  ok: true,
  runtimeEpoch: 'epoch-1',
  highWatermark: 2,
  cards: [
    {
      requestId: 'req-1',
      runtimeEpoch: 'epoch-1',
      title: '需要确认',
      questions: [{ id: 'q1', prompt: '是否继续执行构建？', options: [{ id: 'yes', label: '继续' }, { id: 'no', label: '停止' }] }],
    },
  ],
}

async function main() {
  const { chromium } = await import('playwright-core')
  await mkdir(SHOTS, { recursive: true })
  const browser = await chromium.launch({
    channel: 'chrome', args: ['--disable-breakpad', '--disable-crash-reporter'],
  })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    locale: 'zh-CN', colorScheme: 'dark',
  })
  context.setDefaultTimeout(8000)
  const step = (name) => console.log('  ·', name)
  const page = await context.newPage()
  const button = (name) => page.getByRole('button', { name, exact: true })
  const tab = (name) => page.locator('.tab-item', { has: page.getByText(name, { exact: true }) })
  const category = (name) => page.getByRole('group', { name: '会话类型' }).getByRole('button', { name, exact: true })
  const errors = []
  const commands = []
  page.on('pageerror', (error) => errors.push(String(error)))

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-marshal-token,content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'content-type': 'application/json; charset=utf-8',
  }
  const json = (body) => ({ status: 200, headers: cors, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) })

  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== HUB) return route.abort()
    if (url.pathname === '/') return route.fulfill({ path: join(DIST, 'index.html') })
    if (/^\/assets\/[\w.-]+$/.test(url.pathname)) return route.fulfill({ path: join(DIST, url.pathname) })
    return route.fulfill({ status: 404 })
  })
  await context.route(`${HUB}/marshal/api/devices`, (route) => route.fulfill(json(devices)))
  await context.route(`${HUB}/marshal/api/pairing/redeem`, (route) =>
    route.fulfill(json({ credential: 'mph1.ui-fixture-not-a-real-credential' })))
  await context.route('**/marshal/api/board', (route) => route.fulfill(json({ tasks: [] })))
  await context.route('**/marshal/api/sessions**', (route) => {
    const deviceId = new URL(route.request().url()).searchParams.get('device')
    return route.fulfill(json({ sessions: sessions.sessions.filter((row) => row.deviceId === deviceId) }))
  })
  await context.route('**/marshal/api/history', (route) => route.fulfill(json(history)))
  await context.route('**/marshal/api/roster', (route) => route.fulfill(json({ agents: [] })))
  await context.route('**/marshal/api/watch', (route) => route.fulfill(json({ ok: true })))
  await context.route('**/marshal/api/inputs', (route) => route.fulfill(json(inputs)))
  await context.route('**/marshal/api/discussions**', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}')
      console.log('    discussion →', body.action)
      if (body.action === 'send') {
        return route.fulfill(json({
          room: {
            ...groupRoom,
            messages: [
              ...groupRoom.messages,
              { id: 'gm-send', author: 'user', text: body.text, state: 'completed', at: Date.now() },
            ],
          },
        }))
      }
      if (body.action === 'preview') {
        const input = body.input ?? {}
        const members = (input.members ?? []).map((member, index) => {
          const model = groupCatalog.find((item) => item.id === member.modelId)
          return {
            id: 'p' + index, deviceId: member.deviceId,
            model: { id: member.modelId, agent: model?.agent ?? 'dsh', model: model?.model ?? 'unknown' },
            reasoning: 'low',
          }
        })
        return route.fulfill(json({
          preview: {
            digest: 'digest-smoke', mode: 'discussion', title: input.title, text: input.text,
            members, moderatorId: members[0]?.id ?? '', maxCalls: (members.length + 1) * 3,
            expiresAt: Date.now() + 120_000,
          },
        }))
      }
      if (body.action === 'create') {
        return route.fulfill(json({
          room: {
            ...groupRoom, id: 'room-2', title: '新建验收群', rounds: 0, messages: [],
            moderatorId: 'p0',
            members: [
              { id: 'p0', name: '本机 Mac', model: { agent: 'dsh', model: 'deepseek-flash' }, reasoning: 'low' },
              { id: 'p1', name: '本机 Mac', model: { agent: 'codex', model: 'gpt-5' } },
            ],
          },
        }))
      }
      return route.fulfill(json({ room: groupRoom }))
    }
    const roomId = url.searchParams.get('room')
    return route.fulfill(json(roomId ? { room: groupRoom } : { rooms: groupRooms, catalog: groupCatalog, presets: [] }))
  })

  await context.route('**/marshal/api/command', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    commands.push(body)
    console.log('    command →', body.op)
    if (body.op === 'controls') {
      return route.fulfill(json({ ok: true, status: 'accepted', result: { controls } }))
    }
    if (body.op === 'upload') {
      const args = body.args ?? {}
      return route.fulfill(json({
        ok: true,
        status: 'accepted',
        result: { attachmentId: args.id, bytes: args.size ?? 0, complete: true },
      }))
    }
    return route.fulfill(json({ ok: true, status: 'accepted' }))
  })

  // 假 EventSource：连上后推一段流式回复，再推一个审批请求。
  await page.addInitScript(() => {
    class FakeEventSource {
      constructor() {
        this.onmessage = null
        this.onerror = null
        this.readyState = 1
        window.smokeStream = this
      }
      addEventListener() {}
      close() {}
    }
    window.EventSource = FakeEventSource
  })

  await page.goto(HUB, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { localStorage.clear(); localStorage.removeItem('dsh-marshal-mobile.bridge') })
  await page.reload({ waitUntil: 'networkidle' })

  await page.getByText('连接电脑').waitFor()
  step('配置页')
  await page.screenshot({ path: join(SHOTS, '01-setup.png') })

  await page.locator('details.manual').evaluate((el) => { el.open = true })
  await page.getByText('连接调度中心').waitFor()
  await page.locator('input[type="url"]').first().fill('https://hub.smoke.test')
  await page.locator('input[type="password"]').first().fill('0123456789abcdef0123456789abcdef')
  await page.getByRole('button', { name: '保存并进入' }).click()

  await tab('节点').click()
  await page.locator('.name', { hasText: '本机 Mac' }).first().waitFor()
  step('设备列表')
  await page.screenshot({ path: join(SHOTS, '02-home.png') })

  await tab('会话').click()
  await page.getByRole('combobox', { name: '会话列表主机' }).selectOption('mac-local')
  await page.getByText('dsh-marshal手机端').first().waitFor()
  step('会话列表')
  await page.screenshot({ path: join(SHOTS, '03-sessions.png') })

  await page.getByRole('button', { name: /dsh-marshal手机端/ }).click()
  await page.getByText('把手机端改成直连').waitFor()
  await page.getByText('是否继续执行构建？').waitFor()
  await page.waitForFunction(() => typeof window.smokeStream?.onmessage === 'function')
  for (const [seq, text] of [[11, '正在'], [12, '处理你的请求…']]) {
    await page.evaluate(({ seq, text }) => window.smokeStream.onmessage({ data: JSON.stringify({
      deviceId: 'mac-local', agent: 'dsh', sessionId: 'session-aaa', seq,
      kind: 'message.delta', payload: { itemId: 'smoke-live', text },
    }) }), { seq, text })
    await page.locator('.transcript').getByText(seq === 11 ? text : '正在处理你的请求…', { exact: true }).waitFor()
  }
  step('会话详情（历史 + 审批卡 + 流式）')
  await page.screenshot({ path: join(SHOTS, '04-session.png') })

  await page.locator('.ask .choice').first().click()
  await page.getByRole('button', { name: '提交' }).click()
  await page.getByText('是否继续执行构建？').waitFor({ state: 'hidden' })
  assert.equal(commands.find(command => command.op === 'answer')?.args.requestId, 'req-1')
  step('提交审批')

  // 全功能：选模型、选思考强度、上传附件后发送。
  await page.getByRole('button', { name: /^选择模型/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: /deepseek-v4-pro/i }).click()
  await page.locator('.composer-effort').click()
  // The accessible name also includes descriptive copy; match the label itself.
  await page.getByRole('dialog').getByRole('button')
    .filter({ has: page.getByText('高', { exact: true }) }).click()
  await page.locator('input[data-attachment-picker="2"]').setInputFiles({
    name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.alloc(256 * 1024 + 1, 'a'),
  })
  await page.getByText('notes.txt', { exact: true }).waitFor()
  await page.screenshot({ path: join(SHOTS, '05a-attach.png') })
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('继续')
  const promptRequest = page.waitForRequest(request =>
    request.url() === `${HUB}/marshal/api/command` && request.postDataJSON()?.op === 'prompt')
  await button('发送消息').click()
  const prompt = (await promptRequest).postDataJSON()
  const uploads = commands.filter(command => command.op === 'upload').map(command => command.args)
  assert.deepEqual(uploads.map(args => args.offset), [0, 256 * 1024])
  assert.deepEqual(prompt.args.attachments, [uploads[0].id])
  assert.deepEqual(prompt.args.options, { model: 'deepseek-account/deepseek-v4-pro', reasoning: 'high' })
  step('发送消息（模型/思考/附件）')
  await page.screenshot({ path: join(SHOTS, '05-chat.png') })

  await page.getByRole('button', { name: '控制' }).click()
  await page.getByText(/模型目录（2）/).waitFor()
  await page.getByText(/可调项（/).waitFor()
  step('控制项（模型目录 + 统计 + 未开放项）')
  await page.screenshot({ path: join(SHOTS, '06-controls.png') })

  // 控制项 → 会话 → 会话列表
  await page.locator('.topbar').getByRole('button', { name: '返回' }).click()
  await page.locator('.topbar').getByRole('button', { name: '返回' }).click()
  await category('工单群').click()
  await page.getByText('请先扫描电脑配对码。').waitFor()
  await category('Agent 群聊').click()
  await page.getByText('需要手机配对凭证').waitFor()
  step('群聊未登录提示')
  await page.screenshot({ path: join(SHOTS, '09-groups-login.png') })

  await page.evaluate(() => {
    const key = 'dsh-marshal-mobile.config'
    const raw = localStorage.getItem(key)
    if (!raw) return
    const config = JSON.parse(raw)
    config.token = 'mph1.ui-fixture-not-a-real-credential'
    config.account = {
      cookies: '__Host-marshal-session=smoke; __Host-marshal-csrf=smoke',
      csrf: 'smoke',
      expiresAt: Date.now() + 3_600_000,
      name: '验收账号',
    }
    localStorage.setItem(key, JSON.stringify(config))
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await tab('会话').click()
  await category('Agent 群聊').click()
  await page.getByText('手机端验收群').waitFor()
  step('群聊列表（ticket 会话）')
  await page.screenshot({ path: join(SHOTS, '10-groups.png') })

  await page.getByText('手机端验收群').click()
  await page.getByText('请汇总手机端 node 的验收结果').waitFor()
  step('群聊房间')
  await page.screenshot({ path: join(SHOTS, '11-group-room.png') })

  await page.locator('.composer input').fill('补充一条冒烟消息')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByText('补充一条冒烟消息').waitFor()
  step('群聊发送')

  await page.locator('.topbar').getByRole('button', { name: '返回' }).click()
  await button('新建会话').click()
  await button('继续选择群成员').click()
  await page.getByPlaceholder('群聊标题').fill('新建验收群')
  await page.getByPlaceholder('第一条消息：要讨论/执行什么？').fill('请核对手机端 node 的群聊创建链路')
  await page.getByRole('button', { name: /本机 Mac · DSH/ }).click()
  await page.getByRole('button', { name: /本机 Mac · Codex/ }).click()
  await page.getByRole('button', { name: '预览范围' }).click()
  await page.getByText('确认共享范围').waitFor()
  await page.getByText(/最多 9 次模型调用/).waitFor()
  step('群聊创建预览')
  await page.screenshot({ path: join(SHOTS, '12-group-preview.png') })
  await page.getByRole('button', { name: '确认并开始群聊' }).click()
  await page.getByText('新建验收群').first().waitFor()
  step('群聊创建完成')
  await page.screenshot({ path: join(SHOTS, '13-group-created.png') })

  await page.locator('.topbar').getByRole('button', { name: '返回' }).click()
  await tab('节点').click()
  await button('设置').click()
  await page.getByText('安全').waitFor()
  step('设置')
  await page.screenshot({ path: join(SHOTS, '07-settings.png') })

  await page.getByRole('button', { name: '开启' }).click()
  await page.getByText('设置 6 位 PIN').waitFor()
  for (let i = 0; i < 6; i += 1) await page.getByRole('button', { name: '1', exact: true }).click()
  await page.getByText('再输入一次确认').waitFor()
  for (let i = 0; i < 6; i += 1) await page.getByRole('button', { name: '1', exact: true }).click()
  await page.getByText('已开启，启动需 6 位 PIN').waitFor()
  step('应用锁')
  await page.screenshot({ path: join(SHOTS, '08-lock-enabled.png') })

  // 旧明文令牌链接不再受理；用当前一次性配对码走确认与兑换流程。
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('连接电脑').waitFor()
  await page.locator('details.manual').evaluate((el) => { el.open = true })
  await page.getByText('连接调度中心').waitFor()
  await page.getByPlaceholder('marshal://open?hub=...&token=...').fill(
    `marshal://pair?hub=${encodeURIComponent(HUB)}&code=smoke-code`,
  )
  await page.getByRole('button', { name: '一键导入配对链接' }).click()
  await page.getByRole('dialog', { name: '确认配对' }).getByRole('button', { name: '继续' }).click()
  await tab('节点').click()
  await page.locator('.name', { hasText: '本机 Mac' }).first().waitFor()
  step('一键配对链接导入')
  await page.screenshot({ path: join(SHOTS, '14-onboard-import.png') })

  await browser.close()

  const report = { viewport: '390x844@3x', screens: 15, pageErrors: errors }
  await writeFile(join(SHOTS, 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n')
  if (errors.length > 0) { console.error('页面报错：', errors); process.exitCode = 1; return }
  console.log('UI 冒烟断言通过，pageErrors=0，截图见 artifacts/ui-smoke/')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
  process.exit(1)
})
