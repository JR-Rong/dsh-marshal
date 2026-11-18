import {
  el, clear, button, toast, formatTime, type Child,
} from './lib/dom.ts'
import {
  DEFAULT_HUB, consoleUrl, hubLabel, normalizeHubUrl, normalizeToken, makeConfig, CONFIG_VERSION,
  type MarshalConfig,
} from './lib/config.ts'
import {
  fetchDevices, fetchSessions, pingHub, summarize, sessionTitle, agentLabel,
  type HubDevice, type HubSession,
} from './lib/hub.ts'
import { readConfig, writeConfig, removeConfig } from './lib/storage.ts'
import { createLock, verifyPin, isValidPin, type LockRecord } from './lib/lock.ts'
import {
  setupChrome, enterConsole, inNativeShell, openExternal, vibrate, exitApp,
  watchNetwork, watchDeepLinks, watchBackButton,
} from './lib/native.ts'
import { APP_TITLE, APP_VERSION, CLIENT_ONLY_NOTE } from './lib/version.ts'

type Screen = 'booting' | 'setup' | 'home' | 'settings' | 'lock'
type HubStatus = 'unknown' | 'ok' | 'unauth' | 'error'

interface UiState {
  screen: Screen
  config: MarshalConfig | null
  devices: HubDevice[]
  sessions: HubSession[]
  loading: boolean
  status: HubStatus
  statusText: string
  lastSync: number
  online: boolean
  expanded: Set<string>
  /** 设置页里的令牌草稿，避免每次按键就重绘。 */
  editing: boolean
  /** 应用锁当前用途：解锁 / 设置新锁 / 确认新锁 / 验证后关闭。 */
  lockPurpose: 'unlock' | 'set-new' | 'set-confirm' | 'disable'
  /** 设置新锁时第一次输入的 PIN（只存在内存）。 */
  pinDraft: string
  pinError: string
}

const state: UiState = {
  screen: 'booting',
  config: null,
  devices: [],
  sessions: [],
  loading: false,
  status: 'unknown',
  statusText: '尚未连接',
  lastSync: 0,
  online: true,
  expanded: new Set<string>(),
  editing: false,
  lockPurpose: 'unlock',
  pinDraft: '',
  pinError: '',
}

const root = (): HTMLElement => {
  const node = document.getElementById('app')
  if (!node) throw new Error('缺少 #app 容器')
  return node
}

const refreshTimers: Array<ReturnType<typeof setInterval>> = []
function everyVisibleHome(): void {
  if (refreshTimers.length > 0) return
  refreshTimers.push(setInterval(() => {
    if (state.screen === 'home' && document.visibilityState === 'visible' && !state.loading) void refresh()
  }, 20_000))
}

/* ------------------------------ 启动 ------------------------------ */

export async function start(): Promise<void> {
  state.screen = 'booting'
  render()
  void setupChrome()
  const config = await readConfig()
  state.config = config
  if (!config) {
    state.screen = 'setup'
    render()
  } else if (config.lock) {
    state.screen = 'lock'
    render()
  } else {
    state.screen = 'home'
    render()
    void refresh()
  }
  everyVisibleHome()

  await watchNetwork((online) => {
    state.online = online
    if (state.screen === 'home') render()
  })
  await watchDeepLinks((url) => {
    try {
      const parsed = new URL(url)
      const hub = parsed.searchParams.get('hub')
      if (!hub) return
      const normalized = normalizeHubUrl(hub)
      if (!normalized.ok) {
        toast(normalized.error, 'error')
        return
      }
      state.config = state.config ?? makeConfig({ hubUrl: normalized.value })
      state.config.hubUrl = normalized.value
      state.screen = 'setup'
      render()
      toast('已从链接填入 Hub 地址')
    } catch {
      /* 非法深链直接忽略 */
    }
  })
  await registerBackButton()
  // 从控制台返回时 WebView 可能走 BFCache 恢复页面，此时需要重新挂上返回键监听。
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) void registerBackButton()
  })
}

let disposeBack: (() => void) | null = null

async function registerBackButton(): Promise<void> {
  disposeBack?.()
  disposeBack = await watchBackButton(() => {
    if (state.screen === 'settings') {
      state.screen = state.config ? 'home' : 'setup'
      render()
      return true
    }
    if (state.screen === 'lock' || state.screen === 'setup') return false
    void exitApp()
    return true
  })
}

/**
 * 离开外壳进入控制台前，先摘掉返回键监听：
 * 否则 Capacitor 认为 JS 有人处理返回键，Android 的 WebView 历史回退会失效。
 */
function openConsole(url: string): void {
  disposeBack?.()
  disposeBack = null
  enterConsole(url)
}

/* ------------------------------ 渲染 ------------------------------ */

function render(): void {
  const app = root()
  clear(app)
  app.className = 'app screen-' + state.screen
  for (const child of screenChildren()) app.append(child as Node)
  installPullToRefresh(app)
}

function screenChildren(): Child[] {
  switch (state.screen) {
    case 'booting': return bootView()
    case 'setup': return setupView()
    case 'home': return homeView()
    case 'settings': return settingsView()
    case 'lock': return lockView()
  }
}

function bootView(): Child[] {
  return [
    brand(),
    el('p', { class: 'empty', text: '正在读取本机配置…' }),
  ]
}

function brand(): HTMLElement {
  return el('div', { class: 'brand' },
    el('div', { class: 'mark', text: '调' }),
    el('div', {},
      el('h1', { text: '调度官' }),
      el('p', { text: '手机端 · 只作客户端' }),
    ),
  )
}

function topbar(title: string, subtitle: string, actions: Child[]): HTMLElement {
  return el('div', { class: 'topbar' },
    el('div', { class: 'title' },
      el('strong', { text: title }),
      el('span', { text: subtitle }),
    ),
    el('div', { class: 'actions' }, ...actions),
  )
}

/* ------------------------------ 首次设置 ------------------------------ */

function setupView(): Child[] {
  const hubInput = el('input', {
    id: 'hubUrl', type: 'url', inputmode: 'url', autocomplete: 'url',
    placeholder: DEFAULT_HUB || 'https://hub.example.com',
    value: state.config?.hubUrl ?? DEFAULT_HUB,
  }) as HTMLInputElement
  const tokenInput = el('input', {
    id: 'token', type: 'password', autocomplete: 'off',
    placeholder: '管理令牌（dashboardToken）',
    value: state.config?.token ?? '',
  }) as HTMLInputElement
  const result = el('p', { class: 'empty', text: '令牌只保存在本机安全存储，用于读取设备与会话。' })
  const submit = button('保存并进入', () => void saveSetup(hubInput, tokenInput, result), { class: 'primary block' })
  const test = button('先测试连接', () => void testSetup(hubInput, tokenInput, result), { class: 'block' })

  return [
    brand(),
    el('div', { class: 'card' },
      el('h2', { text: '连接调度中心' }),
      el('div', { class: 'form' },
        el('div', { class: 'field' },
          el('label', { text: 'Hub 地址', for: 'hubUrl' }),
          hubInput,
          el('small', { text: '填 Hub 的源地址即可，例如 https://hub.example.com。' }),
        ),
        el('div', { class: 'field' },
          el('label', { text: '管理令牌', for: 'token' }),
          tokenInput,
          el('small', { text: '在电脑端 marshal 配置里的 dashboardToken；至少 16 位。' }),
        ),
        test,
        submit,
        result,
      ),
    ),
    el('p', { class: 'notice', text: CLIENT_ONLY_NOTE }),
  ]
}

function readSetupInputs(hubInput: HTMLInputElement, tokenInput: HTMLInputElement):
  { ok: true; hubUrl: string; token: string } | { ok: false; error: string } {
  const hub = normalizeHubUrl(hubInput.value)
  if (!hub.ok) return { ok: false, error: hub.error }
  const token = normalizeToken(tokenInput.value)
  if (!token.ok) return { ok: false, error: token.error }
  return { ok: true, hubUrl: hub.value, token: token.value }
}

async function testSetup(hubInput: HTMLInputElement, tokenInput: HTMLInputElement, result: HTMLElement): Promise<void> {
  const parsed = readSetupInputs(hubInput, tokenInput)
  if (!parsed.ok) {
    result.textContent = parsed.error
    result.className = 'empty'
    return
  }
  result.textContent = '正在连接…'
  const health = await pingHub(parsed.hubUrl)
  if (!health.ok) {
    result.textContent = health.message
    return
  }
  if (!parsed.token) {
    result.textContent = 'Hub 可达。填上管理令牌即可读取设备。'
    return
  }
  const devices = await fetchDevices(parsed.hubUrl, parsed.token)
  if (!devices.ok) {
    result.textContent = devices.message
    return
  }
  const open = devices.data.filter((device) => !device.stale).length
  result.textContent = `连接成功：${devices.data.length} 台设备（${open} 台在线）。`
}

async function saveSetup(hubInput: HTMLInputElement, tokenInput: HTMLInputElement, result: HTMLElement): Promise<void> {
  const parsed = readSetupInputs(hubInput, tokenInput)
  if (!parsed.ok) {
    result.textContent = parsed.error
    return
  }
  const config: MarshalConfig = {
    ...(state.config ?? makeConfig({ hubUrl: parsed.hubUrl })),
    version: CONFIG_VERSION,
    hubUrl: parsed.hubUrl,
    token: parsed.token,
    updatedAt: Date.now(),
  }
  try {
    await writeConfig(config)
  } catch (error) {
    result.textContent = '保存失败：' + (error instanceof Error ? error.message : '未知错误')
    return
  }
  state.config = config
  state.editing = false
  state.screen = 'home'
  state.statusText = '正在连接…'
  render()
  toast('配置已保存')
  void refresh()
}

/* ------------------------------ 首页 ------------------------------ */

function deviceSessionList(device: HubDevice): Child[] {
  const rows = state.sessions.filter((session) => session.deviceId === device.id)
  if (rows.length === 0) return [el('p', { class: 'empty', text: '这台设备暂无可观察的会话。' })]
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  return rows.slice(0, 12).map((session) => el('button', {
    class: 'session',
    onClick: () => {
      vibrate()
      if (state.config) openConsole(consoleUrl(state.config.hubUrl))
    },
  },
  el('span', { class: 'dot' + (session.running ? ' online' : '') }),
  el('span', { class: 'copy' },
    el('strong', { text: sessionTitle(session) }),
    el('span', { text: agentLabel(session.agent) + ' · ' + formatTime(session.updatedAt) }),
  ),
  el('span', { class: 'state' + (session.running ? ' running' : ''), text: session.running ? '运行中' : '空闲' }),
  ))
}

function deviceCard(device: HubDevice): HTMLElement {
  const expanded = state.expanded.has(device.id)
  const sessions = state.sessions.filter((session) => session.deviceId === device.id)
  const running = sessions.filter((session) => session.running).length
  const head = el('button', {
    class: 'device-head',
    onClick: () => {
      if (state.expanded.has(device.id)) state.expanded.delete(device.id)
      else state.expanded.add(device.id)
      render()
    },
  },
  el('span', { class: 'dot' + (device.stale ? '' : ' online') }),
  el('span', { class: 'name', text: device.name }),
  el('span', { class: 'chip', text: expanded ? '收起' : '展开' }),
  )
  const chips = el('div', { class: 'device-meta' },
    ...device.agents.map((agent) => el('span', { class: 'chip on', text: agentLabel(agent) })),
    sessions.length > 0 ? el('span', { class: 'chip', text: sessions.length + ' 会话' }) : null,
    running > 0 ? el('span', { class: 'chip on', text: running + ' 运行中' }) : null,
  )
  const body = expanded ? deviceSessionList(device) : []
  return el('div', { class: 'device' }, head, chips, ...body)
}

function homeView(): Child[] {
  const config = state.config
  if (!config) {
    state.screen = 'setup'
    return setupView()
  }
  const overview = summarize(state.devices, state.sessions)
  const statusDot = state.status === 'ok' ? ' online' : state.status === 'unauth' ? ' offline' : state.status === 'error' ? ' warn' : ''
  const statusText = state.loading && state.status === 'unknown' ? '正在连接…' : state.statusText

  const header = topbar('调度官', hubLabel(config.hubUrl), [
    el('button', {
      class: 'icon-button', 'aria-label': '锁定',
      text: '锁定',
      onClick: () => {
        if (!config.lock) {
          toast('先在设置里开启应用锁')
          return
        }
        state.screen = 'lock'
        render()
      },
    }),
    el('button', {
      class: 'icon-button', 'aria-label': '设置', text: '设置',
      onClick: () => {
        state.screen = 'settings'
        render()
      },
    }),
  ])

  const banners: Child[] = []
  if (!state.online) banners.push(el('div', { class: 'banner', text: '设备离线：已切到只读缓存，网络恢复后会自动重连。' }))
  if (state.status === 'error' || state.status === 'unauth') {
    banners.push(el('div', { class: 'banner error', text: statusText }))
  }

  const status = el('div', { class: 'card' },
    el('div', { class: 'status-line' },
      el('span', { class: 'dot' + statusDot }),
      el('strong', { text: statusText }),
    ),
    el('div', { class: 'metrics' },
      metric(String(overview.onlineDeviceCount), '在线设备'),
      metric(String(overview.sessionCount), '可见会话'),
      metric(String(overview.runningCount), '运行中'),
    ),
    el('p', { class: 'empty', text: '上次同步：' + (state.lastSync ? formatTime(state.lastSync) : '尚未同步') }),
  )

  const deviceCardList = state.devices.length > 0
    ? state.devices.map(deviceCard)
    : [el('p', { class: 'empty', text: state.loading ? '正在读取设备…' : '暂无设备在线。请在电脑端确认 marshal 节点已连接。' })]

  return [
    header,
    ...banners,
    status,
    el('div', { class: 'card' },
      el('h2', { text: '设备' }),
      ...deviceCardList,
    ),
    el('div', { class: 'cta' },
      button('进入调度官', () => {
        vibrate()
        openConsole(consoleUrl(config.hubUrl))
      }, { class: 'primary block' }),
      el('p', { class: 'notice', text: '「进入调度官」打开的是 Hub 的完整控制台：会话续跑、提问与审批、讨论群聊、控制项、历史与上传，与浏览器版同一份功能。' }),
    ),
    el('div', { class: 'foot', text: 'v' + APP_VERSION + ' · 客户端模式，不承载 hub/node' }),
  ]
}

function metric(value: string, label: string): HTMLElement {
  return el('div', { class: 'metric' },
    el('strong', { text: value }),
    el('span', { text: label }),
  )
}

/* ------------------------------ 设置 ------------------------------ */

function settingsView(): Child[] {
  const config = state.config
  const header = topbar('设置', config ? hubLabel(config.hubUrl) : '未配置', [
    el('button', {
      class: 'icon-button', text: '返回',
      onClick: () => { state.screen = config ? 'home' : 'setup'; render() },
    }),
  ])
  if (!config) {
    return [header, el('p', { class: 'empty', text: '还没有配置 Hub。' })]
  }

  const hubInput = el('input', { type: 'url', inputmode: 'url', autocomplete: 'url', value: config.hubUrl }) as HTMLInputElement
  const tokenInput = el('input', { type: 'password', autocomplete: 'off', value: config.token, placeholder: '管理令牌' }) as HTMLInputElement
  const result = el('p', { class: 'empty', text: '' })
  const save = button('保存', () => void saveSettings(hubInput, tokenInput, result), { class: 'primary block' })
  const test = button('测试连接', () => void testSettings(hubInput, tokenInput, result), { class: 'block' })

  const lockRow = config.lock
    ? el('div', { class: 'row-between' },
      el('div', { class: 'label' }, el('strong', { text: '应用锁' }), el('span', { text: '已开启，启动时需 6 位 PIN' })),
      button('关闭', () => void disableLock(), { class: 'icon-button danger' }),
    )
    : el('div', { class: 'row-between' },
      el('div', { class: 'label' }, el('strong', { text: '应用锁' }), el('span', { text: '开启后每次启动都要输入 6 位 PIN' })),
      button('开启', () => { void openLockSetup() }, { class: 'icon-button' }),
    )

  return [
    header,
    el('div', { class: 'card' },
      el('h2', { text: '连接' }),
      el('div', { class: 'form' },
        el('div', { class: 'field' }, el('label', { text: 'Hub 地址' }), hubInput),
        el('div', { class: 'field' },
          el('label', { text: '管理令牌' }),
          tokenInput,
          el('small', { text: '令牌保存在本机安全存储：iOS Keychain / Android EncryptedSharedPreferences。' }),
        ),
        test, save, result,
      ),
    ),
    el('div', { class: 'card' }, el('h2', { text: '安全' }), lockRow),
    el('div', { class: 'card' },
      el('h2', { text: '关于' }),
      el('div', { class: 'row-between' },
        el('div', { class: 'label' }, el('strong', { text: APP_TITLE }), el('span', { text: 'v' + APP_VERSION + ' · ' + (inNativeShell() ? '原生壳' : '浏览器预览') })),
      ),
      el('p', { class: 'notice', text: CLIENT_ONLY_NOTE }),
      el('div', { class: 'form' },
        button('在浏览器中打开 Hub', () => void openExternal(consoleUrl(config.hubUrl)), { class: 'block' }),
        button('清除本地数据', () => void wipeData(), { class: 'block danger' }),
      ),
    ),
  ]
}

async function saveSettings(hubInput: HTMLInputElement, tokenInput: HTMLInputElement, result: HTMLElement): Promise<void> {
  const config = state.config
  if (!config) return
  const hub = normalizeHubUrl(hubInput.value)
  if (!hub.ok) { result.textContent = hub.error; return }
  const token = normalizeToken(tokenInput.value)
  if (!token.ok) { result.textContent = token.error; return }
  const next: MarshalConfig = { ...config, hubUrl: hub.value, token: token.value, updatedAt: Date.now() }
  try {
    await writeConfig(next)
  } catch (error) {
    result.textContent = '保存失败：' + (error instanceof Error ? error.message : '未知错误')
    return
  }
  state.config = next
  render()
  toast('已保存')
  void refresh()
}

async function testSettings(hubInput: HTMLInputElement, tokenInput: HTMLInputElement, result: HTMLElement): Promise<void> {
  const hub = normalizeHubUrl(hubInput.value)
  if (!hub.ok) { result.textContent = hub.error; return }
  const token = normalizeToken(tokenInput.value)
  if (!token.ok) { result.textContent = token.error; return }
  result.textContent = '正在连接…'
  const health = await pingHub(hub.value)
  if (!health.ok) { result.textContent = health.message; return }
  if (!token.value) { result.textContent = 'Hub 可达。'; return }
  const devices = await fetchDevices(hub.value, token.value)
  if (!devices.ok) { result.textContent = devices.message; return }
  result.textContent = `连接成功：${devices.data.length} 台设备。`
}

async function wipeData(): Promise<void> {
  const config = state.config
  if (!config) return
  await removeConfig()
  state.config = null
  state.devices = []
  state.sessions = []
  state.status = 'unknown'
  state.statusText = '尚未连接'
  state.screen = 'setup'
  render()
  toast('本地数据已清除')
}

/* ------------------------------ 应用锁 ------------------------------ */

function openLockSetup(): void {
  state.lockPurpose = 'set-new'
  state.pinDraft = ''
  state.pinError = ''
  pinBuffer = ''
  state.screen = 'lock'
  render()
}

function disableLock(): void {
  if (!state.config?.lock) return
  state.lockPurpose = 'disable'
  state.pinError = ''
  pinBuffer = ''
  state.screen = 'lock'
  render()
}

async function persistLock(lock: LockRecord | null): Promise<void> {
  const config = state.config
  if (!config) return
  const next: MarshalConfig = { ...config, lock, updatedAt: Date.now() }
  await writeConfig(next)
  state.config = next
}

let pinBuffer = ''
function lockView(): Child[] {
  const dots = el('div', { class: 'pin-dots' })
  const title = ({
    unlock: '输入 6 位 PIN 解锁',
    'set-new': '设置 6 位 PIN',
    'set-confirm': '再输入一次确认',
    disable: '输入当前 PIN 以关闭应用锁',
  } as const)[state.lockPurpose]
  const message = el('p', { class: 'empty', text: state.pinError || title })

  const refreshDots = (): void => {
    clear(dots)
    for (let index = 0; index < 6; index += 1) {
      dots.append(el('span', { class: 'pin-dot' + (index < pinBuffer.length ? ' filled' : '') }))
    }
  }

  const finish = async (): Promise<void> => {
    const config = state.config
    if (!config) return
    const purpose = state.lockPurpose
    const pin = pinBuffer
    pinBuffer = ''
    if (purpose === 'set-new') {
      if (!isValidPin(pin)) {
        state.pinError = 'PIN 需要 6 位数字'
        render()
        return
      }
      state.pinDraft = pin
      state.lockPurpose = 'set-confirm'
      state.pinError = ''
      render()
      return
    }
    if (purpose === 'set-confirm') {
      if (pin !== state.pinDraft) {
        state.pinError = '两次输入不一致，请重来'
        state.pinDraft = ''
        state.lockPurpose = 'set-new'
        render()
        return
      }
      try {
        const record = await createLock(pin)
        await persistLock(record)
        state.pinDraft = ''
        state.screen = 'settings'
        render()
        toast('应用锁已开启')
      } catch (error) {
        state.pinError = error instanceof Error ? error.message : '开启失败'
        render()
      }
      return
    }
    const record = config.lock
    if (!record) {
      state.screen = 'home'
      render()
      return
    }
    const ok = await verifyPin(pin, record)
    if (!ok) {
      state.pinError = 'PIN 不正确'
      render()
      return
    }
    if (purpose === 'disable') {
      await persistLock(null)
      state.screen = 'settings'
      render()
      toast('应用锁已关闭')
      return
    }
    state.pinError = ''
    state.screen = 'home'
    render()
    void refresh()
  }

  const press = (digit: string): void => {
    if (pinBuffer.length >= 6) return
    pinBuffer += digit
    refreshDots()
    if (pinBuffer.length === 6) void finish()
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
  const keypad = el('div', { class: 'keypad' },
    ...keys.map((digit) => el('button', { text: digit, onClick: () => press(digit) })),
    el('button', { class: 'plain', text: '取消', onClick: () => { pinBuffer = ''; refreshDots() } }),
    el('button', { text: '0', onClick: () => press('0') }),
    el('button', { class: 'plain', text: '删除', onClick: () => { pinBuffer = pinBuffer.slice(0, -1); refreshDots() } }),
  )

  refreshDots()
  return [
    el('div', { class: 'lock' },
      brand(),
      dots,
      message,
      keypad,
    ),
  ]
}

/* ------------------------------ 刷新 ------------------------------ */

async function refresh(): Promise<void> {
  const config = state.config
  if (!config) return
  if (state.loading) return
  state.loading = true
  state.statusText = '正在连接…'
  // 只在首页重绘：设置页里有未提交的输入，不能被后台刷新冲掉。
  if (state.screen === 'home') render()
  try {
    const health = await pingHub(config.hubUrl)
    if (!health.ok) {
      state.status = 'error'
      state.statusText = health.message
      return
    }
    if (!config.token) {
      state.status = 'unauth'
      state.statusText = '还没有管理令牌，只能打开控制台手动登录'
      state.devices = []
      state.sessions = []
      return
    }
    const devices = await fetchDevices(config.hubUrl, config.token)
    if (!devices.ok) {
      state.status = devices.error === 'unauthorized' ? 'unauth' : 'error'
      state.statusText = devices.message
      return
    }
    state.devices = devices.data
    const batches = await Promise.all(devices.data.map((device) => fetchSessions(config.hubUrl, config.token, device.id)))
    const sessions: HubSession[] = []
    const seen = new Set<string>()
    let failures = 0
    for (const batch of batches) {
      if (!batch.ok) {
        failures += 1
        continue
      }
      for (const row of batch.data) {
        const key = row.deviceId + '\u0000' + row.agent + '\u0000' + row.sessionId
        if (seen.has(key)) continue
        seen.add(key)
        sessions.push(row)
      }
    }
    state.sessions = sessions
    state.status = 'ok'
    state.statusText = failures === 0 ? '已连接调度中心' : `已连接（${failures} 台设备会话读取失败）`
    state.lastSync = Date.now()
  } catch (error) {
    state.status = 'error'
    state.statusText = error instanceof Error ? error.message : '连接失败'
  } finally {
    state.loading = false
    if (state.screen === 'home') render()
  }
}

/* ------------------------------ 下拉刷新 ------------------------------ */

let pullStart: number | null = null
function installPullToRefresh(app: HTMLElement): void {
  if (app.dataset.pull === 'on') return
  app.dataset.pull = 'on'
  app.addEventListener('touchstart', (event) => {
    if (window.scrollY > 0 || state.screen !== 'home') return
    pullStart = event.touches[0]?.clientY ?? null
  }, { passive: true })
  app.addEventListener('touchend', (event) => {
    if (pullStart === null) return
    const end = event.changedTouches[0]?.clientY ?? pullStart
    const delta = end - pullStart
    pullStart = null
    if (delta > 70) {
      vibrate()
      void refresh()
    }
  }, { passive: true })
}

/** 让测试与深链可以外部触发一次刷新。 */
export function triggerRefresh(): void {
  void refresh()
}

export function currentScreen(): Screen {
  return state.screen
}
