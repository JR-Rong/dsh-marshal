import {
  el, clear, button, toast, formatTime, type Child,
} from './lib/dom.ts'
import {
  DEFAULT_HUB, consoleUrl, hubLabel, normalizeHubUrl, normalizeToken, makeConfig, CONFIG_VERSION,
  type MarshalConfig,
} from './lib/config.ts'
import {
  MarshalApi, agentLabel, sessionTitle, sameTarget, can, formatTokens, buildPromptArgs, randomUuid,
  type Capability, type DeviceRow, type InputCard, type SessionRow, type Target, type SessionControls,
} from './lib/marshal.ts'
import {
  AccountApi, buildPreviewInput, buildSendPayload, extractTicket, loginWithTicket, parseOnboardLink, parseRoom, ticketFingerprint,
  type DiscussionCatalogItem, type DiscussionRoom, type GroupPreview, type RoomSummary,
} from './lib/account.ts'
import type { AccountSession } from './lib/config.ts'
import { openEventStream, type StreamHandle, type StreamFrame } from './lib/sse.ts'
import { hasStoredBridge, openBridgeWorkbench, saveBridgeDevice } from './bridge/workbench.ts'
import { classifyPairing, pairBridge, parsePairPayload, parseUnifiedPairing, type UnifiedPairing } from './lib/bridge.ts'
import { openQrScanner } from './lib/scanner.ts'
import { readConfig, writeConfig, removeConfig } from './lib/storage.ts'
import { createLock, verifyPin, isValidPin, type LockRecord } from './lib/lock.ts'
import {
  setupChrome, inNativeShell, openExternal, vibrate, exitApp,
  watchNetwork, watchDeepLinks, watchBackButton,
} from './lib/native.ts'
import { APP_TITLE, APP_VERSION, CLIENT_ONLY_NOTE } from './lib/version.ts'
import { initTheme, readTheme, setTheme, THEMES } from './lib/theme.ts'

type View = 'booting' | 'setup' | 'lock' | 'home' | 'sessions' | 'session' | 'controls' | 'groups' | 'groupRoom' | 'groupNew' | 'settings'

type Role = 'user' | 'assistant' | 'reason' | 'tool' | 'system'

interface Message {
  id: string
  role: Role
  text: string
  open: boolean
  at: number
}

interface PendingAttachment {
  key: string
  name: string
  mime: string
  size: number
  status: 'uploading' | 'ready' | 'error'
  attachmentId?: string
  error?: string
}

interface UiState {
  view: View
  config: MarshalConfig | null
  api: MarshalApi | null
  devices: DeviceRow[]
  sessions: SessionRow[]
  deviceId: string | null
  session: SessionRow | null
  capability: Capability | undefined
  controls: SessionControls | null
  modelChoice: string
  effortChoice: string
  attachments: PendingAttachment[]
  uploading: boolean
  running: boolean
  messages: Message[]
  cards: InputCard[]
  busy: boolean
  statusText: string
  online: boolean
  historyCursor: string | null
  account: AccountSession | null
  accountBusy: boolean
  pendingDeepLink: string | null
  roomList: RoomSummary[]
  catalog: DiscussionCatalogItem[]
  room: DiscussionRoom | null
  groupBusy: boolean
  groupError: string
  groupDraft: string
  groupTitle: string
  groupText: string
  groupSelected: string[]
  groupPreview: GroupPreview | null
  roomsError: string
  rooms: Record<string, unknown>[]
  lockPurpose: 'unlock' | 'set-new' | 'set-confirm' | 'disable'
  pinDraft: string
  pinError: string
}

const state: UiState = {
  view: 'booting',
  config: null,
  api: null,
  devices: [],
  sessions: [],
  deviceId: null,
  session: null,
  capability: undefined,
  controls: null,
  modelChoice: '',
  effortChoice: '',
  attachments: [],
  uploading: false,
  running: false,
  messages: [],
  cards: [],
  busy: false,
  statusText: '',
  online: true,
  historyCursor: null,
  account: null,
  accountBusy: false,
  pendingDeepLink: null,
  roomList: [],
  catalog: [],
  room: null,
  groupBusy: false,
  groupError: '',
  groupDraft: '',
  groupTitle: '',
  groupText: '',
  groupSelected: [],
  groupPreview: null,
  roomsError: '',
  rooms: [],
  lockPurpose: 'unlock',
  pinDraft: '',
  pinError: '',
}

let stream: StreamHandle | null = null
let subscriptionId: string | null = null
let lastSeq = 0
let disposeBack: (() => void) | null = null
let draft = ''

const rootNode = (): HTMLElement => {
  const node = document.getElementById('app')
  if (!node) throw new Error('缺少 #app 容器')
  return node
}

function render(): void {
  if (state.view !== 'groupRoom') stopGroupPoll()
  const app = rootNode()
  clear(app)
  app.className = 'app screen-' + state.view
  for (const child of screenChildren()) {
    // 浏览器 append(null) 会渲染出 "null" 字样，必须先过滤空槽位。
    if (child === null || child === undefined || child === false) continue
    app.append(child as Node)
  }
}

function screenChildren(): Child[] {
  switch (state.view) {
    case 'booting': return [brand(), el('p', { class: 'empty', text: '正在读取本机配置…' })]
    case 'setup': return setupView()
    case 'lock': return lockView()
    case 'home': return homeView()
    case 'sessions': return sessionsView()
    case 'session': return sessionView()
    case 'controls': return controlsView()
    case 'groups': return groupsView()
    case 'groupRoom': return groupRoomView()
    case 'groupNew': return groupNewView()
    case 'settings': return settingsView()
  }
}

function brand(): HTMLElement {
  return el('div', { class: 'brand' },
    el('div', { class: 'mark', text: '调' }),
    el('div', {},
      el('h1', { text: '调度官' }),
      el('p', { text: '手机端 node · 直连调度中心' }),
    ),
  )
}

function themeCard(): HTMLElement {
  const current = readTheme()
  return el('div', { class: 'card' },
    el('h2', { text: '主题色' }),
    el('p', { class: 'empty', text: '只改强调色，界面仍是深色；选择会记住。' }),
    el('div', { class: 'theme-row' },
      ...THEMES.map((option) => el('button', {
        class: 'theme-option' + (option.id === current ? ' selected' : ''),
        onClick: () => { setTheme(option.id); render() },
      },
      el('span', { class: 'theme-swatch ' + option.id }),
      el('span', { text: option.label }),
      )),
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

function backButton(to: View, label = '返回'): HTMLButtonElement {
  return button(label, () => { state.view = to; render() }, { class: 'icon-button' })
}

/* ------------------------------ 启动 ------------------------------ */

export async function start(): Promise<void> {
  initTheme()
  state.view = 'booting'
  render()
  void setupChrome()
  const config = await readConfig()
  state.config = config
  state.account = config?.account && config.account.expiresAt > Date.now() ? config.account : null
  if (!config) {
    state.view = 'setup'
    render()
  } else if (config.lock) {
    state.view = 'lock'
    render()
  } else {
    await enterApp()
  }
  // 已配对 DSH 的手机，下次打开直接进入 agent-first 工作台；有应用锁时不抢在解锁前打开。
  if (!config?.lock) {
    setTimeout(() => { if (hasStoredBridge()) openDshWorkbench() }, 250)
  }
  await watchNetwork((online) => {
    state.online = online
    if (state.view === 'home' || state.view === 'sessions') render()
  })
  await watchDeepLinks((url) => { void handleDeepLink(url) })
  await registerBackButton()
  window.addEventListener('pageshow', (event) => { if (event.persisted) void registerBackButton() })
}

async function registerBackButton(): Promise<void> {
  disposeBack?.()
  disposeBack = await watchBackButton(() => {
    const parent: Partial<Record<View, View>> = {
      settings: 'home', sessions: 'home', session: 'sessions', controls: 'session', groups: 'home', groupRoom: 'groups', groupNew: 'groups',
    }
    const to = parent[state.view]
    if (to) { state.view = to; render(); return true }
    if (state.view === 'lock' || state.view === 'setup') return false
    void exitApp()
    return true
  })
}

async function enterApp(): Promise<void> {
  const config = state.config
  if (!config) { state.view = 'setup'; render(); return }
  state.api = new MarshalApi(config)
  state.view = 'home'
  state.statusText = '正在连接…'
  render()
  await refreshDevices()
  await openStream()
}

async function openStream(): Promise<void> {
  const api = state.api
  if (!api || !api.token) return
  stream?.close()
  stream = await openEventStream({
    url: api.streamUrl(),
    token: api.token,
    onFrame: (frame) => { void onFrame(frame) },
    onError: (message) => {
      state.statusText = '事件流断开：' + message
      if (state.view === 'home') render()
    },
  })
}

async function refreshDevices(): Promise<void> {
  const api = state.api
  if (!api) return
  const result = await api.devices()
  if (!result.ok) {
    state.statusText = result.message
    if (result.error === 'unauthorized') { state.view = 'setup'; render(); return }
    if (state.view === 'home' || state.view === 'sessions') render()
    return
  }
  state.devices = result.data
  state.statusText = result.data.length === 0 ? '暂无设备在线' : '已连接调度中心'
  if (state.view === 'home') render()
}

async function openDevice(device: DeviceRow): Promise<void> {
  const api = state.api
  if (!api) return
  state.deviceId = device.id
  state.sessions = []
  state.view = 'sessions'
  state.statusText = '读取会话…'
  render()
  const result = await api.sessions(device.id)
  if (!result.ok) { state.statusText = result.message; render(); return }
  state.sessions = result.data
  state.statusText = ''
  render()
}

/* ------------------------------ 会话 ------------------------------ */

async function openSession(deviceId: string, row: SessionRow): Promise<void> {
  const api = state.api
  if (!api) return
  const previous = state.session
  if (previous) void api.unsubscribe(targetOf(previous), subscriptionId)
  state.session = { ...row, deviceId }
  state.capability = row.capability
  state.running = row.running
  state.messages = []
  state.cards = []
  state.historyCursor = null
  state.controls = null
  state.modelChoice = ''
  state.effortChoice = ''
  state.attachments = []
  state.uploading = false
  state.busy = false
  lastSeq = 0
  draft = ''
  state.view = 'session'
  state.statusText = '正在订阅…'
  render()

  const target = targetOf(state.session)
  const subscribed = await api.subscribe(target)
  subscriptionId = subscribed.ok ? subscribed.data : null

  const [history, inputs, controls] = await Promise.all([
    api.history(target, 40),
    api.inputs(target),
    api.controls(target),
  ])
  if (!history.ok) {
    state.statusText = history.message
  } else {
    state.messages = history.data.items.map(historyToMessage).filter((m): m is Message => m !== null)
    state.historyCursor = history.data.nextCursor ?? null
    state.statusText = ''
  }
  if (inputs.ok) {
    state.cards = inputs.data
  }
  if (controls.ok) {
    state.controls = controls.data
  }
  // 能力文档以 sessions 列表为准，读一次刷新。
  const sessions = await api.sessions(row.deviceId)
  if (sessions.ok) {
    const fresh = sessions.data.find((item) => item.agent === row.agent && item.sessionId === row.sessionId)
    if (fresh) {
      state.session = { ...fresh, deviceId: row.deviceId }
      state.capability = fresh.capability
      state.running = fresh.running
    }
  }
  render()
}

function targetOf(row: SessionRow): Target {
  return { deviceId: row.deviceId, agent: row.agent, sessionId: row.sessionId }
}

export function historyToMessage(item: { kind: string; payload?: Record<string, unknown>; seq?: number; ts?: number }): Message | null {
  const payload = item.payload ?? {}
  const at = typeof item.ts === 'number' ? item.ts : Date.now()
  const id = (typeof payload.itemId === 'string' ? payload.itemId : 'seq-' + String(item.seq ?? Math.random()))
  const text = typeof payload.text === 'string' ? payload.text : ''
  switch (item.kind) {
    case 'user.message': return { id, role: 'user', text, open: false, at }
    case 'message.delta':
    case 'message.completed': return text ? { id, role: 'assistant', text, open: false, at } : null
    case 'reasoning.delta': return text ? { id, role: 'reason', text, open: false, at } : null
    case 'tool.started': return { id, role: 'tool', text: '▶ ' + String(payload.name ?? payload.tool ?? 'tool'), open: false, at }
    case 'tool.completed': return { id, role: 'tool', text: (payload.isError === true ? '✗ ' : '✓ ') + String(payload.content ?? '').slice(0, 400), open: false, at }
    case 'turn.completed': return { id, role: 'system', text: '回合完成（' + String(payload.state ?? 'completed') + '）', open: false, at }
    default: return null
  }
}

async function onFrame(frame: StreamFrame): Promise<void> {
  if (frame.event === 'reset') {
    await refreshDevices()
    if (state.session) await reloadTranscript()
    return
  }
  const event = frame.data as Record<string, unknown> | null
  if (!event || typeof event !== 'object') return
  if (typeof event.deviceId !== 'string') return
  const target = state.session ? targetOf(state.session) : null
  const kind = typeof event.kind === 'string' ? event.kind : ''
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>

  if (kind === 'session.updated' || kind === 'session.removed') {
    if (state.view === 'sessions' && state.deviceId === event.deviceId) {
      const api = state.api
      if (api) {
        const result = await api.sessions(state.deviceId)
        if (result.ok) { state.sessions = result.data; render() }
      }
    }
    return
  }
  if (!target) return
  if (event.deviceId !== target.deviceId || event.agent !== target.agent || event.sessionId !== target.sessionId) return
  if (typeof event.seq === 'number') {
    if (event.seq <= lastSeq) return
    lastSeq = event.seq
  }
  switch (kind) {
    case 'capability.changed':
      state.capability = payload as unknown as Capability
      return
    case 'input.requested': {
      const card = payload as unknown as InputCard
      if (typeof card.requestId === 'string') {
        state.cards = [...state.cards.filter((entry) => entry.requestId !== card.requestId), card]
        render()
      }
      return
    }
    case 'input.resolved': {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
      state.cards = state.cards.filter((card) => card.requestId !== requestId)
      render()
      return
    }
    case 'message.delta':
    case 'reasoning.delta': {
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (!text) return
      appendDelta(String(payload.itemId ?? event.seq ?? 'd'), kind === 'reasoning.delta' ? 'reason' : 'assistant', text)
      return
    }
    case 'message.completed': closeOpenMessages(); return
    case 'turn.started': state.running = true; render(); return
    case 'turn.completed': state.running = false; closeOpenMessages(); render(); return
    case 'tool.started':
      state.messages.push({ id: String(event.seq), role: 'tool', text: '▶ ' + String(payload.name ?? payload.tool ?? 'tool'), open: false, at: Date.now() })
      render(); return
    case 'tool.completed':
      state.messages.push({ id: String(event.seq), role: 'tool', text: String(payload.content ?? '').slice(0, 400), open: false, at: Date.now() })
      render(); return
    case 'user.message': {
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (text && !state.messages.some((m) => m.role === 'user' && m.text === text)) {
        state.messages.push({ id: String(event.seq), role: 'user', text, open: false, at: Date.now() })
        render()
      }
      return
    }
    default: return
  }
}

function appendDelta(id: string, role: Role, text: string): void {
  const existing = state.messages.find((m) => m.id === id && m.role === role)
  if (existing) {
    existing.text += text
    existing.open = true
  } else {
    state.messages.push({ id, role, text, open: true, at: Date.now() })
  }
  if (state.view === 'session') render()
}

function closeOpenMessages(): void {
  for (const message of state.messages) message.open = false
}

async function reloadTranscript(): Promise<void> {
  const api = state.api
  if (!api || !state.session) return
  const result = await api.history(targetOf(state.session), 40)
  if (result.ok) {
    state.messages = result.data.items.map(historyToMessage).filter((m): m is Message => m !== null)
    state.historyCursor = result.data.nextCursor ?? null
    render()
  }
}

async function loadOlder(): Promise<void> {
  const api = state.api
  if (!api || !state.session || !state.historyCursor) return
  const result = await api.history(targetOf(state.session), 40, state.historyCursor)
  if (!result.ok) { toast(result.message, 'error'); return }
  const older = result.data.items.map(historyToMessage).filter((m): m is Message => m !== null)
  state.messages = [...older, ...state.messages]
  state.historyCursor = result.data.nextCursor ?? null
  render()
}

async function sendPrompt(): Promise<void> {
  const api = state.api
  const session = state.session
  if (!api || !session || state.busy) return
  const text = draft.trim()
  if (!text) return
  if (state.attachments.some((entry) => entry.status === 'uploading')) {
    toast('附件还在上传，请稍候', 'error')
    return
  }
  const attachmentIds = state.attachments
    .filter((entry) => entry.status === 'ready' && entry.attachmentId)
    .map((entry) => entry.attachmentId as string)
  const options = {
    ...(state.modelChoice ? { model: state.modelChoice } : {}),
    ...(state.effortChoice ? { reasoning: state.effortChoice } : {}),
  }
  const args = buildPromptArgs(text, options, attachmentIds)
  const pending: Message = { id: 'local-' + Date.now(), role: 'user', text, open: false, at: Date.now() }
  draft = ''
  state.busy = true
  state.messages.push(pending)
  render()
  const result = await api.command('prompt', targetOf(session), args)
  state.busy = false
  if (!result.ok) {
    state.messages = state.messages.filter((message) => message.id !== pending.id)
    if (!draft) draft = text
    toast(result.message, 'error')
    render()
    return
  }
  state.attachments = []
  state.uploading = false
  render()
}

/* ------------------------------ 全功能：模型 / 附件 / 忽略 ------------------------------ */

function updateAttachment(key: string, patch: Partial<PendingAttachment>): void {
  state.attachments = state.attachments.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry))
}

function removeAttachment(key: string): void {
  state.attachments = state.attachments.filter((entry) => entry.key !== key)
  state.uploading = state.attachments.some((entry) => entry.status === 'uploading')
  render()
}

async function handleFiles(files: FileList | File[] | null): Promise<void> {
  const api = state.api
  const session = state.session
  if (!api || !session || !files || files.length === 0) return
  const room = 8 - state.attachments.length
  if (room <= 0) {
    toast('最多 8 个附件', 'error')
    return
  }
  for (const file of Array.from(files).slice(0, room)) {
    if (file.size > 10 * 1024 * 1024) {
      toast(file.name + ' 超过 10 MB', 'error')
      continue
    }
    const key = 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
    const mime = file.type || 'application/octet-stream'
    state.attachments = [...state.attachments, { key, name: file.name, mime, size: file.size, status: 'uploading' }]
    state.uploading = true
    render()
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const result = await api.upload(targetOf(session), { name: file.name, mime, bytes })
      if (result.ok) {
        updateAttachment(key, { status: 'ready', attachmentId: result.data.attachmentId })
      } else {
        updateAttachment(key, { status: 'error', error: result.message })
        toast(result.message, 'error')
      }
    } catch (error) {
      updateAttachment(key, { status: 'error', error: error instanceof Error ? error.message : '上传失败' })
      toast('附件上传失败', 'error')
    }
    state.uploading = state.attachments.some((entry) => entry.status === 'uploading')
    render()
  }
}

function effectiveEfforts(controls: SessionControls | null, modelChoice: string): string[] {
  if (!controls) return []
  const id = modelChoice || controls.current.model
  return controls.models.find((model) => model.id === id)?.efforts ?? []
}

function shortModelLabel(label: string): string {
  const short = label.split('·').pop()?.trim()
  return short && short.length > 0 ? short : label
}

function effortLabel(effort: string): string {
  const labels: Record<string, string> = { off: '关闭', low: '低', medium: '中', high: '高', max: '最高' }
  return labels[effort] ?? effort
}

async function refreshControls(notify = false): Promise<void> {
  const api = state.api
  const session = state.session
  if (!api || !session) return
  const result = await api.controls(targetOf(session))
  if (result.ok) {
    state.controls = result.data
    if (state.modelChoice && !result.data?.models.some((model) => model.id === state.modelChoice)) {
      state.modelChoice = ''
      state.effortChoice = ''
    }
    if (notify) toast('模型列表已刷新')
  } else if (notify) {
    toast(result.message, 'error')
  }
  if (state.view === 'session' || state.view === 'controls') render()
}

function openControls(): void {
  state.view = 'controls'
  render()
  void refreshControls()
}

async function cancelCard(card: InputCard): Promise<void> {
  const api = state.api
  const session = state.session
  if (!api || !session) return
  if (!can(state.capability, 'cancel')) {
    toast('当前会话不支持忽略待答', 'error')
    return
  }
  const result = await api.cancelRequest(targetOf(session), card.requestId)
  if (!result.ok) {
    toast(result.message, 'error')
    return
  }
  state.cards = state.cards.filter((entry) => entry.requestId !== card.requestId)
  toast('已忽略该请求')
  render()
}

async function answerCard(card: InputCard, answers: Array<{ id: string; selectedOptionIds: string[]; text?: string }>): Promise<void> {
  const api = state.api
  const session = state.session
  if (!api || !session) return
  const result = await api.command('answer', targetOf(session), { requestId: card.requestId, answers })
  if (!result.ok) { toast(result.message, 'error'); return }
  state.cards = state.cards.filter((entry) => entry.requestId !== card.requestId)
  toast('已提交')
  render()
}

async function interrupt(): Promise<void> {
  const api = state.api
  const session = state.session
  if (!api || !session) return
  const epoch = state.capability?.runtimeEpoch
  if (typeof epoch !== 'string' || !can(state.capability, 'interrupt')) {
    toast('当前会话不支持远端中断', 'error')
    return
  }
  const result = await api.command('interrupt', targetOf(session), { runtimeEpoch: epoch })
  if (!result.ok) toast(result.message, 'error')
}

/* ------------------------------ 视图 ------------------------------ */

function setupView(): Child[] {
  const hubInput = el('input', {
    type: 'url', inputmode: 'url', autocomplete: 'url',
    placeholder: DEFAULT_HUB || 'https://hub.example.com',
    value: state.config?.hubUrl ?? DEFAULT_HUB,
  }) as HTMLInputElement
  const tokenInput = el('input', {
    type: 'password', autocomplete: 'off', placeholder: '管理令牌（dashboardToken）',
    value: state.config?.token ?? '',
  }) as HTMLInputElement
  const result = el('p', { class: 'empty', text: '令牌只保存在本机安全存储，用于直连调度中心。' })

  const test = button('先测试连接', () => { void testSetup(hubInput, tokenInput, result) }, { class: 'block' })
  const save = button('保存并进入', () => { void saveSetup(hubInput, tokenInput, result) }, { class: 'primary block' })
  const pairInput = el('input', {
    type: 'text', autocomplete: 'off',
    placeholder: 'marshal://open?hub=...&token=...',
  }) as HTMLInputElement

  const manual = el('details', { class: 'manual' },
    el('summary', { text: '手动配置（高级）' }),
    el('div', { class: 'card' },
      el('h2', { text: '连接调度中心' }),
      el('div', { class: 'form' },
        el('div', { class: 'field' }, el('label', { text: 'Hub 地址' }), hubInput),
        el('div', { class: 'field' },
          el('label', { text: '管理令牌' }),
          tokenInput,
          el('small', { text: '存于 iOS Keychain / Android EncryptedSharedPreferences' }),
        ),
        el('div', { class: 'field' },
          el('label', { text: '一键配对链接（可选）' }),
          pairInput,
          el('small', { text: '也可直接扫 Hub「手机连接」二维码。' }),
        ),
        button('一键导入配对链接', () => {
          void (async () => {
            const raw = pairInput.value.trim()
            if (!raw) { result.textContent = '请粘贴配对链接'; return }
            result.textContent = '正在按配对链接配置…'
            await handleDeepLink(raw)
          })()
        }, { class: 'block' }),
        test, save, result,
      ),
    ),
    el('p', { class: 'notice', text: 'DSH 工作台手动配对：' }),
    button('打开 DSH 工作台（手动输入）', openDshWorkbench, { class: 'block' }),
  )

  return [
    brand(),
    el('div', { class: 'card setup-pair' },
      el('div', { class: 'setup-pair-icon', text: '📷' }),
      el('h2', { text: '连接电脑' }),
      el('p', { class: 'empty', text: '用摄像头扫电脑「跨设备」页的二维码，自动完成配对。' }),
      button('扫码配对', scanPairing, { class: 'primary block scan-button' }),
      el('p', { class: 'notice', text: 'Hub「手机连接」与 DSH「配对 iPhone」的二维码都能扫。' }),
      ...(hasStoredBridge() ? [button('打开已配对的 DSH 工作台', openDshWorkbench, { class: 'block' })] : []),
    ),
    themeCard(),
    manual,
    el('p', { class: 'notice', text: CLIENT_ONLY_NOTE }),
  ]
}

function readSetup(hubInput: HTMLInputElement, tokenInput: HTMLInputElement):
  { ok: true; hubUrl: string; token: string } | { ok: false; error: string } {
  const hub = normalizeHubUrl(hubInput.value)
  if (!hub.ok) return { ok: false, error: hub.error }
  const token = normalizeToken(tokenInput.value)
  if (!token.ok) return { ok: false, error: token.error }
  return { ok: true, hubUrl: hub.value, token: token.value }
}

async function testSetup(hubInput: HTMLInputElement, tokenInput: HTMLInputElement, result: HTMLElement): Promise<void> {
  const parsed = readSetup(hubInput, tokenInput)
  if (!parsed.ok) { result.textContent = parsed.error; return }
  result.textContent = '正在连接…'
  const api = new MarshalApi({ hubUrl: parsed.hubUrl, token: parsed.token })
  const devices = await api.devices()
  if (!devices.ok) { result.textContent = devices.message; return }
  result.textContent = '连接成功：' + devices.data.length + ' 台设备。'
}

async function saveSetup(hubInput: HTMLInputElement, tokenInput: HTMLInputElement, result: HTMLElement): Promise<void> {
  const parsed = readSetup(hubInput, tokenInput)
  if (!parsed.ok) { result.textContent = parsed.error; return }
  const previous = state.config
  const hubChanged = previous?.hubUrl !== parsed.hubUrl
  const config: MarshalConfig = {
    ...(previous ?? makeConfig({ hubUrl: parsed.hubUrl })),
    version: CONFIG_VERSION,
    hubUrl: parsed.hubUrl,
    token: parsed.token,
    ...(hubChanged ? { account: null } : {}),
    updatedAt: Date.now(),
  }
  try {
    await writeConfig(config)
  } catch (error) {
    result.textContent = '保存失败：' + (error instanceof Error ? error.message : '未知错误')
    return
  }
  state.config = config
  state.account = config.account ?? null
  await enterApp()
}

function openDshWorkbench(): void {
  openBridgeWorkbench({
    onClose: () => { /* 覆盖层自己移除；底层保持原界面 */ },
    onOpenHubGroups: () => {
      if (!state.account) { toast('请先配对 Hub 群聊账号', 'error'); return }
      state.view = 'groups'
      void loadRooms()
    },
    onHubPairLink: (raw) => { void handleDeepLink(raw) },
    onUnifiedPairLink: (raw) => { void handleDeepLink(raw) },
  })
}

/** One QR: pair the DSH bridge first, then apply the Hub half, then open the workbench. */
async function applyUnifiedPairing(payload: UnifiedPairing): Promise<void> {
  let bridgeReady = false
  try {
    const device = await pairBridge({ token: payload.bridgeToken, url: payload.bridge })
    saveBridgeDevice(device)
    bridgeReady = true
  } catch (error) {
    toast('DSH 工作台配对失败：' + (error instanceof Error ? error.message : '未知错误'), 'error')
  }
  const params = new URLSearchParams({ hub: payload.hub, token: payload.hubToken })
  if (payload.ticket) params.set('ticket', payload.ticket)
  await handleDeepLink('marshal://open?' + params.toString())
  if (bridgeReady) openDshWorkbench()
}

async function handleScannedPairing(text: string): Promise<void> {
  const raw = text.trim()
  if (!raw) return
  const kind = classifyPairing(raw)
  if (kind === 'unified') {
    const unified = parseUnifiedPairing(raw)
    if (unified) { await applyUnifiedPairing(unified); return }
  }
  if (kind === 'hub') { await handleDeepLink(raw); return }
  if (kind !== 'bridge') {
    toast('这个二维码不是配对链接，请扫「跨设备」页的码', 'error')
    return
  }
  try {
    const payload = parsePairPayload(raw)
    const device = await pairBridge(payload)
    saveBridgeDevice(device)
    openDshWorkbench()
  } catch (error) {
    toast(error instanceof Error ? error.message : '配对失败', 'error')
  }
}

function scanPairing(): void {
  openQrScanner({
    onResult: (text) => { void handleScannedPairing(text) },
  })
}

function homeView(): Child[] {
  const config = state.config
  if (!config) { state.view = 'setup'; return setupView() }
  const header = topbar('调度官', hubLabel(config.hubUrl), [
    button('扫码', scanPairing, { class: 'icon-button' }),
    button('群聊', () => { state.view = 'groups'; void loadRooms() }, { class: 'icon-button' }),
    button('设置', () => { state.view = 'settings'; render() }, { class: 'icon-button' }),
  ])
  const banners: Child[] = []
  if (!state.online) banners.push(el('div', { class: 'banner', text: '设备离线：网络恢复后会自动刷新。' }))
  if (state.statusText) banners.push(el('div', { class: 'banner', text: state.statusText }))

  const rows = state.devices.map((device) => el('button', {
    class: 'device-head card-tap',
    onClick: () => { vibrate(); void openDevice(device) },
  },
  el('span', { class: 'dot' + (device.stale ? '' : ' online') }),
  el('span', { class: 'name', text: device.name }),
  el('span', { class: 'chip', text: device.agents.map(agentLabel).join(' / ') || '无 agent' }),
  ))

  return [
    header,
    ...banners,
    el('div', { class: 'card' },
      el('h2', { text: 'DSH 工作台' }),
      el('p', { class: 'empty', text: '按智能体查看会话、任务看板；配对 DSH 远程桥后可用。' }),
      button('进入 DSH 工作台', openDshWorkbench, { class: 'primary block' }),
    ),
    el('div', { class: 'card' },
      el('h2', { text: '设备' }),
      ...(rows.length > 0 ? rows : [el('p', { class: 'empty', text: '暂无设备在线。' })]),
    ),
    el('div', { class: 'foot', text: 'v' + APP_VERSION + ' · 手机端 node · 出站直连，不承载 hub' }),
  ]
}

function sessionsView(): Child[] {
  const device = state.devices.find((entry) => entry.id === state.deviceId)
  const header = topbar(device?.name ?? '会话', '选择会话', [backButton('home')])
  const groups = new Map<string, SessionRow[]>()
  for (const row of state.sessions) {
    const list = groups.get(row.agent) ?? []
    list.push(row)
    groups.set(row.agent, list)
  }
  const sections: Child[] = []
  if (groups.size === 0) {
    sections.push(el('p', { class: 'empty', text: state.statusText || '这台设备暂无会话。' }))
  }
  for (const [agent, rows] of groups) {
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    sections.push(el('div', { class: 'agent-group' },
      el('h3', { class: 'agent-title', text: agentLabel(agent) + ' · ' + rows.length + ' 个会话' }),
      ...rows.slice(0, 40).map((row) => el('button', {
        class: 'session',
        onClick: () => { vibrate(); void openSession(state.deviceId ?? row.deviceId, row) },
      },
      el('span', { class: 'dot' + (row.running ? ' online' : '') }),
      el('span', { class: 'copy' },
        el('strong', { text: sessionTitle(row) }),
        el('span', { text: formatTime(row.updatedAt) }),
      ),
      el('span', { class: 'state' + (row.running ? ' running' : ''), text: row.running ? '运行中' : '空闲' }),
      )),
    ))
  }
  return [header, el('div', { class: 'card' }, ...sections)]
}

function messageNode(message: Message): HTMLElement {
  const cls = 'msg msg-' + message.role
  return el('div', { class: cls + (message.open ? ' streaming' : '') },
    el('div', { class: 'msg-role', text: ({
      user: '我', assistant: '智能体', reason: '思考', tool: '工具', system: '系统',
    } as const)[message.role] }),
    el('div', { class: 'msg-body', text: message.text }),
  )
}

function cardNode(card: InputCard): HTMLElement {
  if (card.approval) {
    return el('div', { class: 'card ask' },
      el('h2', { text: '审批：' + card.approval.action }),
      ...(card.approval.detail ? [el('p', { class: 'tool', text: card.approval.detail })] : []),
      el('div', { class: 'choices' },
        ...card.approval.decisions.map((decision) => button(decision.label, () => {
          void answerCard(card, [{ id: decision.id, selectedOptionIds: [] }])
        })),
        button('拒绝', () => { void answerCard(card, [{ id: 'decline', selectedOptionIds: [] }]) }, { class: 'danger' }),
        can(state.capability, 'cancel')
          ? button('忽略此请求', () => { void cancelCard(card) }, { class: 'ghost' })
          : null,
      ),
    )
  }
  const selections = new Map<string, Set<string>>()
  const questionNodes = (card.questions ?? []).map((question) => {
    const optionButtons = (question.options ?? []).map((option) => {
      const node = button(option.label, () => {
        const picked = new Set(question.multi ? (selections.get(question.id) ?? []) : [])
        if (question.multi && picked.has(option.id)) picked.delete(option.id)
        else { picked.clear(); picked.add(option.id) }
        selections.set(question.id, picked)
        for (const entry of optionButtons) {
          const id = entry.dataset.optionId ?? ''
          entry.classList.toggle('picked', picked.has(id))
        }
      }, { class: 'choice' })
      node.dataset.optionId = option.id
      return node
    })
    return el('div', { class: 'question' },
      el('p', { text: question.prompt ?? '请选择' }),
      el('div', { class: 'choices' }, ...optionButtons),
    )
  })
  return el('div', { class: 'card ask' },
    el('h2', { text: card.title ?? '需要你回答' }),
    ...questionNodes,
    el('div', { class: 'choices' },
      button('提交', () => {
        const answers = (card.questions ?? []).map((question) => ({
          id: question.id,
          selectedOptionIds: Array.from(selections.get(question.id) ?? []),
        }))
        void answerCard(card, answers)
      }, { class: 'primary' }),
      can(state.capability, 'cancel')
        ? button('忽略此请求', () => { void cancelCard(card) }, { class: 'ghost' })
        : null,
    ),
  )
}

function sessionStatChips(): Child[] {
  const counts = state.session?.counts ?? {}
  const rows: Array<[string, number | undefined]> = [
    ['输入', counts.inputTokens],
    ['输出', counts.outputTokens],
    ['缓存读', counts.cacheReadTokens],
  ]
  const chips = rows
    .filter(([, value]) => typeof value === 'number' && value > 0)
    .map(([label, value]) => el('span', { class: 'chip', text: label + ' ' + formatTokens(value) }))
  return chips.length > 0 ? [el('div', { class: 'stat-row' }, ...chips)] : []
}

function optionNode(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = label
  return node
}

function statRow(label: string, value: number | undefined): HTMLElement | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return el('div', { class: 'row-between' },
    el('div', { class: 'label' }, el('strong', { text: label }), el('span', { text: String(value) })),
    el('span', { class: 'chip', text: formatTokens(value) }),
  )
}

function sessionView(): Child[] {
  const session = state.session
  if (!session) { state.view = 'sessions'; return sessionsView() }
  const header = topbar(sessionTitle(session), agentLabel(session.agent) + ' · ' + (state.running ? '运行中' : '空闲'), [
    backButton('sessions'),
    button('控制', () => { openControls() }, { class: 'icon-button' }),
    can(state.capability, 'interrupt')
      ? button('中断', () => { void interrupt() }, { class: 'icon-button danger' })
      : null,
  ])

  const controls = state.controls
  const modelSelect = el('select', { class: 'mini-select', 'aria-label': '本次发送模型' }) as HTMLSelectElement
  modelSelect.append(optionNode('', '沿用会话模型'))
  for (const model of controls?.models ?? []) modelSelect.append(optionNode(model.id, shortModelLabel(model.label)))
  modelSelect.value = state.modelChoice
  modelSelect.addEventListener('change', () => {
    state.modelChoice = modelSelect.value
    const allowed = effectiveEfforts(state.controls, state.modelChoice)
    if (state.effortChoice && !allowed.includes(state.effortChoice)) state.effortChoice = ''
    render()
  })

  const efforts = effectiveEfforts(controls, state.modelChoice)
  const effortSelect = el('select', { class: 'mini-select', 'aria-label': '本次发送思考强度' }) as HTMLSelectElement
  effortSelect.append(optionNode('', '默认思考'))
  for (const effort of efforts) effortSelect.append(optionNode(effort, effortLabel(effort)))
  effortSelect.value = state.effortChoice
  effortSelect.disabled = efforts.length === 0
  effortSelect.addEventListener('change', () => { state.effortChoice = effortSelect.value })

  const fileInput = el('input', { type: 'file', multiple: true, hidden: true, accept: '*/*' }) as HTMLInputElement
  fileInput.addEventListener('change', () => {
    // 先拷成普通数组再清空 input；FileList 是活引用，清空 value 会把它一起清掉。
    const files = fileInput.files ? Array.from(fileInput.files) : []
    fileInput.value = ''
    void handleFiles(files)
  })

  const attachmentChips = state.attachments.length > 0
    ? [el('div', { class: 'attach-row' },
        ...state.attachments.map((entry) => el('span', {
          class: 'attach-chip' + (entry.status === 'error' ? ' error' : ''),
        },
        el('span', {
          text: entry.name + (entry.status === 'uploading' ? ' · 上传中' : entry.status === 'error' ? ' · 失败' : ''),
        }),
        button('×', () => { removeAttachment(entry.key) }, { class: 'chip-x', 'aria-label': '移除 ' + entry.name }),
        )),
      )]
    : []

  const tools = el('div', { class: 'composer-tools' },
    modelSelect,
    effortSelect,
    button(state.uploading ? '上传中…' : '附件', () => { fileInput.click() }, {
      class: 'icon-button', disabled: state.uploading || state.attachments.length >= 8,
    }),
    fileInput,
    controls === null ? button('读取模型', () => { void refreshControls(true) }, { class: 'icon-button' }) : null,
  )

  const input = el('input', {
    type: 'text', placeholder: '发消息给 ' + agentLabel(session.agent) + '…', value: draft,
    onInput: (event: Event) => { draft = (event.target as HTMLInputElement).value },
  }) as HTMLInputElement
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') { void sendPrompt(); render() }
  })

  const send = button(state.busy ? '发送中…' : '发送', () => { void sendPrompt() }, {
    class: 'primary', disabled: state.busy || state.uploading,
  })

  return [
    header,
    ...sessionStatChips(),
    state.cards.length > 0 ? el('div', {}, ...state.cards.map(cardNode)) : null,
    el('div', { class: 'transcript' },
      state.historyCursor ? button('加载更早消息', () => { void loadOlder() }, { class: 'block ghost' }) : null,
      ...state.messages.map(messageNode),
      ...(state.messages.length === 0 ? [el('p', { class: 'empty', text: '暂无消息。' })] : []),
    ),
    el('div', { class: 'composer-wrap' },
      ...attachmentChips,
      tools,
      el('div', { class: 'composer' }, input, send),
    ),
  ]
}

function controlsView(): Child[] {
  const session = state.session
  const capability = state.capability
  const controls = state.controls
  const current = controls?.current ?? {}
  const tunables = capability?.tunables ?? []
  const counts = session?.counts ?? {}
  const unavailable = capability?.unavailable
  const unavailableRows: Array<[string, string]> = Array.isArray(unavailable)
    ? unavailable.map((key) => [key, '未开放'])
    : Object.entries(unavailable ?? {})

  return [
    topbar('控制项', session ? sessionTitle(session) : '未选择会话', [
      backButton('session'),
      button('刷新', () => { void refreshControls(true) }, { class: 'icon-button' }),
    ]),
    el('div', { class: 'card' },
      el('h2', { text: '本次发送' }),
      el('p', { class: 'empty', text: '模型：' + (state.modelChoice || current.model || '沿用会话默认') }),
      el('p', { class: 'empty', text: '思考强度：' + (state.effortChoice || current.reasoning || '默认') }),
      el('p', { class: 'notice', text: '模型与思考强度按「本次发送」生效；回会话页用下拉选择。' }),
    ),
    el('div', { class: 'card' },
      el('h2', { text: '模型目录（' + (controls?.models.length ?? 0) + '）' }),
      ...(controls === null
        ? [el('p', { class: 'empty', text: '尚未读取到模型列表。' })]
        : controls.models.length === 0
          ? [el('p', { class: 'empty', text: '此会话未上报模型目录。' })]
          : [
            ...controls.models.slice(0, 12).map((model) => el('div', { class: 'row-between' },
              el('div', { class: 'label' },
                el('strong', { text: model.label }),
                el('span', { text: model.id + (model.efforts.length > 0 ? ' · ' + model.efforts.map(effortLabel).join(' / ') : '') }),
              ),
              el('span', { class: 'chip' + (model.id === current.model ? ' on' : ''), text: model.id === current.model ? '当前' : '可选' }),
            )),
            ...(controls.models.length > 12
              ? [el('p', { class: 'notice', text: '另有 ' + (controls.models.length - 12) + ' 个模型，可在会话页下拉框选择。' })]
              : []),
          ]),
    ),
    el('div', { class: 'card' },
      el('h2', { text: '会话统计' }),
      ...(Object.keys(counts).length === 0
        ? [el('p', { class: 'empty', text: '此会话未上报统计。' })]
        : [
          statRow('输入 token', counts.inputTokens),
          statRow('输出 token', counts.outputTokens),
          statRow('缓存读', counts.cacheReadTokens),
          statRow('缓存写', counts.cacheWriteTokens),
        ].filter((row): row is HTMLElement => row !== null)),
    ),
    el('div', { class: 'card' },
      el('h2', { text: '能力' }),
      el('p', { class: 'empty', text: '操作：' + (capability?.operations ?? []).join(' / ').replace(/^$/, '未知') }),
      el('p', { class: 'empty', text: '写权：' + (capability?.ownership ?? '未知') + ' · 版本 ' + String(capability?.revision ?? '-') }),
      ...(capability?.runtimeEpoch ? [el('p', { class: 'empty', text: '运行时：' + String(capability.runtimeEpoch) })] : []),
      ...(unavailableRows.length > 0
        ? [el('p', { class: 'notice', text: 'Hub 未开放：' + unavailableRows.map(([key, reason]) => key + '（' + reason + '）').join('、') })]
        : []),
    ),
    el('div', { class: 'card' },
      el('h2', { text: '可调项（' + tunables.length + '）' }),
      ...(tunables.length === 0
        ? [el('p', { class: 'empty', text: '此会话未上报可调项。' })]
        : tunables.map((tunable) => el('div', { class: 'row-between' },
          el('div', { class: 'label' },
            el('strong', { text: tunable.id }),
            el('span', { text: [tunable.scope, tunable.effect].filter(Boolean).join(' · ') || '—' }),
          ),
          el('span', { class: 'chip' + (tunable.editable ? ' on' : ''), text: tunable.editable ? '可改' : (tunable.reason ?? '只读') }),
        ))),
    ),
    el('p', { class: 'notice', text: '模型/思考强度走「本次发送」参数；持久可调项被 Hub 标为只读时，手机端不越权。' }),
  ]
}

/* ------------------------------ 群聊（账号 ticket） ------------------------------ */

let groupPoll: ReturnType<typeof setInterval> | null = null

function stopGroupPoll(): void {
  if (groupPoll) { clearInterval(groupPoll); groupPoll = null }
}

function startGroupPoll(): void {
  stopGroupPoll()
  groupPoll = setInterval(() => {
    if (state.view === 'groupRoom') void refreshRoom(true)
  }, 4_000)
}

function groupStateLabel(value: string): string {
  if (value === 'idle') return '空闲'
  if (value === 'running') return '进行中'
  if (value === 'closed') return '已结束'
  return value || '未知'
}

function accountUsable(): boolean {
  return !!state.account && state.account.expiresAt > Date.now()
}

const LAST_TICKET_KEY = 'dsh-marshal-mobile.last-ticket'

function readLastTicket(): { fp: string; at: number } | null {
  try {
    const raw = window.localStorage.getItem(LAST_TICKET_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as { fp?: unknown; at?: unknown }
    if (typeof value.fp !== 'string' || typeof value.at !== 'number') return null
    return { fp: value.fp, at: value.at }
  } catch {
    return null
  }
}

function writeLastTicket(fp: string, at: number): void {
  try { window.localStorage.setItem(LAST_TICKET_KEY, JSON.stringify({ fp, at })) } catch { /* 存不下就算了 */ }
}

/**
 * 一键配对深链：marshal://open?hub=...&token=...&ticket=...
 * 有 token 就直接配好 Hub 并进主界面；有 ticket 再顺带登录群聊。
 * 应用锁未解除时只暂存整条链接，解锁后重放，不能绕过锁。
 */
async function handleDeepLink(raw: string): Promise<void> {
  const unified = parseUnifiedPairing(raw)
  if (unified) { await applyUnifiedPairing(unified); return }
  const parsed = parseOnboardLink(raw)
  if (!parsed) return
  if (state.config?.lock && state.view === 'lock') {
    state.pendingDeepLink = raw
    toast('解锁后完成配对')
    return
  }
  if (parsed.ticket) {
    // 冷启动时 getLaunchUrl 与 appUrlOpen 可能把同一张 ticket 送两遍；ticket 只能用一次。
    const fp = ticketFingerprint(parsed.ticket)
    const last = readLastTicket()
    if (last && last.fp === fp && Date.now() - last.at < 24 * 60 * 60_000) {
      toast('这张 ticket 已处理过；请到电脑端点「刷新二维码」重新生成', 'error')
      return
    }
    writeLastTicket(fp, Date.now())
  }
  let hub: string | undefined
  if (parsed.hub !== undefined) {
    const normalized = normalizeHubUrl(parsed.hub)
    if (!normalized.ok) { toast(normalized.error, 'error'); return }
    hub = normalized.value
  }
  let token: string | undefined
  if (parsed.token !== undefined) {
    const normalized = normalizeToken(parsed.token)
    if (!normalized.ok) { toast(normalized.error, 'error'); return }
    token = normalized.value
  }
  if (!state.config && !hub) {
    toast('配对链接缺少 Hub 地址', 'error')
    return
  }
  const next = state.config ?? makeConfig({ hubUrl: hub as string })
  const hubChanged = hub !== undefined && next.hubUrl !== hub
  if (hub !== undefined) next.hubUrl = hub
  if (token !== undefined) next.token = token
  if (hubChanged) next.account = null
  next.updatedAt = Date.now()
  if (hub !== undefined || token !== undefined) {
    try {
      await writeConfig(next)
    } catch {
      toast('配对信息保存失败', 'error')
    }
    state.config = next
    state.account = next.account ?? null
  }
  if (token !== undefined) {
    await enterApp()
    if (state.view === 'setup') {
      toast('Hub 拒绝了管理令牌，请核对配对二维码', 'error')
      return
    }
    if (parsed.ticket) {
      const ok = await loginTicket(parsed.ticket)
      if (!ok) { state.view = 'home'; render() }
    }
    toast('配对完成')
    return
  }
  if (parsed.ticket) {
    if (!state.config) {
      toast('请先填入 Hub 地址', 'error')
      state.view = 'setup'
      render()
      return
    }
    const ok = await loginTicket(parsed.ticket)
    if (!ok) {
      state.view = state.config.token ? 'home' : 'setup'
      render()
    }
    return
  }
  if (hub !== undefined) {
    state.view = 'setup'
    render()
    toast('已从链接填入 Hub 地址')
  }
}

async function loginTicket(ticket: string): Promise<boolean> {
  const config = state.config
  if (!config) { toast('请先配置 Hub 地址', 'error'); return false }
  if (state.accountBusy) return false
  state.accountBusy = true
  if (state.view === 'settings') render()
  const result = await loginWithTicket(config.hubUrl, ticket)
  state.accountBusy = false
  if (!result.ok) {
    toast(result.message, 'error')
    if (state.view === 'settings') render()
    return false
  }
  const next: MarshalConfig = { ...config, account: result.data, updatedAt: Date.now() }
  try {
    await writeConfig(next)
  } catch {
    toast('登录成功，但本机保存失败', 'error')
  }
  state.config = next
  state.account = result.data
  toast('群聊账号已登录')
  state.view = 'groups'
  render()
  await loadRooms()
  return true
}

async function clearAccount(message?: string): Promise<void> {
  const config = state.config
  state.account = null
  state.room = null
  state.roomList = []
  state.catalog = []
  stopGroupPoll()
  if (config?.account) {
    const next: MarshalConfig = { ...config, account: null, updatedAt: Date.now() }
    try { await writeConfig(next) } catch { /* 清除本地为准 */ }
    state.config = next
  }
  if (message) toast(message, 'error')
  if (state.view === 'groups' || state.view === 'groupRoom' || state.view === 'settings') render()
}

async function logoutAccount(): Promise<void> {
  const config = state.config
  const account = state.account
  if (config && account) {
    try { await new AccountApi(config.hubUrl, account).logout() } catch { /* 本地退出即可 */ }
  }
  await clearAccount()
  toast('已退出群聊账号')
}

async function loadRooms(notify = false): Promise<void> {
  const config = state.config
  if (!config) { state.view = 'setup'; render(); return }
  if (!accountUsable()) {
    state.groupError = state.account ? '账号会话已过期，请重新生成 ticket。' : '群聊需要先用账号 ticket 登录。'
    state.roomList = []
    state.catalog = []
    if (state.view === 'groups') render()
    return
  }
  const account = state.account as AccountSession
  state.groupBusy = true
  state.groupError = ''
  if (state.view === 'groups') render()
  const result = await new AccountApi(config.hubUrl, account).list()
  state.groupBusy = false
  if (!result.ok) {
    state.groupError = result.message
    if (result.error === 'unauthorized' || result.error === 'expired') {
      await clearAccount('账号会话已失效，请重新生成 ticket')
      return
    }
    if (state.view === 'groups') render()
    return
  }
  state.roomList = result.data.rooms
  state.catalog = result.data.catalog
  if (notify) toast('群聊已刷新')
  if (state.view === 'groups') render()
}

async function openRoom(roomId: string): Promise<void> {
  const config = state.config
  const account = state.account
  if (!config || !account) return
  stopGroupPoll()
  state.room = null
  state.groupError = ''
  state.groupDraft = ''
  state.view = 'groupRoom'
  state.groupBusy = true
  render()
  const result = await new AccountApi(config.hubUrl, account).room(roomId)
  state.groupBusy = false
  if (!result.ok) {
    state.groupError = result.message
    if (result.error === 'unauthorized' || result.error === 'expired') {
      await clearAccount('账号会话已失效，请重新生成 ticket')
      return
    }
    render()
    return
  }
  state.room = result.data
  render()
  startGroupPoll()
}

async function refreshRoom(silent = false): Promise<void> {
  const config = state.config
  const account = state.account
  const room = state.room
  if (!config || !account || !room || state.groupBusy) return
  if (!silent) { state.groupBusy = true; render() }
  const result = await new AccountApi(config.hubUrl, account).room(room.id)
  if (!silent) state.groupBusy = false
  if (!result.ok) {
    if (result.error === 'unauthorized' || result.error === 'expired') {
      await clearAccount('账号会话已失效，请重新生成 ticket')
      return
    }
    if (!silent) { toast(result.message, 'error'); render() }
    return
  }
  if (state.room?.id === result.data.id) {
    state.room = result.data
    if (state.view === 'groupRoom') render()
  }
}

async function sendGroupMessage(): Promise<void> {
  const config = state.config
  const account = state.account
  const room = state.room
  if (!config || !account || !room || state.groupBusy) return
  const text = state.groupDraft.trim()
  if (!text) return
  if (room.state !== 'idle' || room.cleared || room.rounds >= 3) {
    toast('此群当前不可发送', 'error')
    return
  }
  state.groupBusy = true
  render()
  const result = await new AccountApi(config.hubUrl, account).action(buildSendPayload(room.id, text, randomUuid()))
  state.groupBusy = false
  if (!result.ok) {
    toast(result.message, 'error')
    render()
    return
  }
  state.groupDraft = ''
  const updated = result.data.room ? parseRoom(result.data.room) : null
  if (updated) state.room = updated
  else await refreshRoom(true)
  render()
}

async function stopRoom(): Promise<void> {
  const config = state.config
  const account = state.account
  const room = state.room
  if (!config || !account || !room) return
  state.groupBusy = true
  render()
  const result = await new AccountApi(config.hubUrl, account).action({ action: 'stop', roomId: room.id })
  state.groupBusy = false
  if (!result.ok) { toast(result.message, 'error'); render(); return }
  const updated = result.data.room ? parseRoom(result.data.room) : null
  if (updated) state.room = updated
  else await refreshRoom(true)
  toast('已请求停止')
  render()
}

function groupsView(): Child[] {
  const config = state.config
  if (!config) { state.view = 'setup'; return setupView() }
  const account = state.account
  const header = topbar('群聊', account?.name || '账号 ticket 会话', [
    backButton('home'),
    button('刷新', () => { void loadRooms(true) }, { class: 'icon-button' }),
    accountUsable() ? button('新建', () => { openGroupNew() }, { class: 'icon-button' }) : null,
  ])
  if (!account || account.expiresAt <= Date.now()) {
    return [
      header,
      el('div', { class: 'card' },
        el('h2', { text: '需要账号 ticket' }),
        el('p', { class: 'empty', text: state.groupError || '群聊接口只认账号 cookie。请在电脑上运行 npm run ticket，手机扫码或粘贴 ticket。' }),
        button('去设置登录', () => { state.view = 'settings'; render() }, { class: 'primary block' }),
      ),
      el('p', { class: 'notice', text: 'ticket 由电脑端 DSH 用当前账号向 Hub 换取，60 秒有效、只能用一次。' }),
    ]
  }
  const banners: Child[] = []
  if (state.groupError) banners.push(el('div', { class: 'banner error', text: state.groupError }))
  const rooms = state.roomList.map((room) => el('button', {
    class: 'session',
    onClick: () => { void openRoom(room.id) },
  },
  el('span', { class: 'dot' + (room.state === 'running' ? ' online' : '') }),
  el('span', { class: 'copy' },
    el('strong', { text: room.title }),
    el('span', { text: groupStateLabel(room.state) + ' · ' + formatTime(room.createdAt) }),
  ),
  el('span', { class: 'state' + (room.state === 'running' ? ' running' : ''), text: groupStateLabel(room.state) }),
  ))
  return [
    header,
    ...banners,
    el('div', { class: 'card' },
      el('h2', { text: '房间（' + state.roomList.length + '）' }),
      ...(rooms.length > 0 ? rooms : [el('p', { class: 'empty', text: state.groupBusy ? '读取群聊…' : '暂无群聊房间。' })]),
    ),
    el('p', { class: 'notice', text: '账号会话到期：' + new Date(account.expiresAt).toLocaleString('zh-CN') + '；到期后重新生成 ticket。' }),
  ]
}

function groupMessageNode(room: DiscussionRoom, message: DiscussionRoom['messages'][number]): HTMLElement {
  const member = room.members.find((entry) => entry.id === message.author)
  const author = message.author === 'user' ? '我' : member ? member.name + ' · ' + member.model.agent : message.author
  const stateLabel = message.state === 'streaming' ? '正在生成' : message.state === 'failed' ? '失败' : ''
  return el('div', { class: 'msg ' + (message.author === 'user' ? 'msg-user' : message.state === 'failed' ? 'msg-system' : 'msg-assistant') },
    el('div', { class: 'msg-role', text: author + (stateLabel ? ' · ' + stateLabel : '') + (message.at ? ' · ' + formatTime(message.at) : '') }),
    el('div', { class: 'msg-body', text: message.text || message.error || '（空）' }),
  )
}

function groupRoomView(): Child[] {
  const room = state.room
  const config = state.config
  const account = state.account
  if (!config || !account || !accountUsable()) {
    state.view = 'groups'
    return groupsView()
  }
  const header = topbar(room ? room.title : '群聊', room ? groupStateLabel(room.state) + ' · 第 ' + room.rounds + '/3 轮' : '读取中…', [
    button('房间列表', () => { stopGroupPoll(); state.view = 'groups'; render() }, { class: 'icon-button' }),
    button('刷新', () => { void refreshRoom() }, { class: 'icon-button' }),
    room && room.state !== 'closed' ? button('停止', () => { void stopRoom() }, { class: 'icon-button danger' }) : null,
  ])
  if (!room) {
    return [header, el('div', { class: 'card' }, el('p', { class: 'empty', text: state.groupError || '读取群聊…' }))]
  }
  const members = room.members.map((member) => el('span', {
    class: 'chip' + (member.id === room.moderatorId ? ' on' : ''),
    text: member.name + ' · ' + member.model.agent + (member.id === room.moderatorId ? ' · 主持' : ''),
  }))
  const composable = room.state === 'idle' && !room.cleared && room.rounds < 3
  const input = el('input', {
    type: 'text',
    placeholder: room.cleared ? '正文已清除，不可发送' : room.state !== 'idle' ? '群聊进行中，等汇总后可继续' : room.rounds >= 3 ? '已达 3 轮上限' : '补充问题，由主持人继续组织…',
    value: state.groupDraft,
    disabled: !composable,
    maxlength: 8192,
    onInput: (event: Event) => { state.groupDraft = (event.target as HTMLInputElement).value },
  }) as HTMLInputElement
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter' && composable) void sendGroupMessage()
  })
  const send = button(state.groupBusy ? '发送中…' : '发送', () => { void sendGroupMessage() }, {
    class: 'primary',
    disabled: !composable || state.groupBusy,
  })
  return [
    header,
    ...(state.groupError ? [el('div', { class: 'banner error', text: state.groupError })] : []),
    el('div', { class: 'stat-row' }, ...members),
    el('p', { class: 'notice', text: '内容保留至 ' + (room.expiresAt ? new Date(room.expiresAt).toLocaleTimeString('zh-CN') : '—') + (room.cleared ? ' · 正文已清除' : '') }),
    el('div', { class: 'transcript' },
      ...room.messages.map((message) => groupMessageNode(room, message)),
      ...(room.messages.length === 0 ? [el('p', { class: 'empty', text: '暂无群聊消息。' })] : []),
    ),
    el('div', { class: 'composer-wrap' },
      el('div', { class: 'composer' }, input, send),
    ),
  ]
}


function openGroupNew(): void {
  if (!accountUsable()) { toast('请先用账号 ticket 登录', 'error'); return }
  state.groupTitle = ''
  state.groupText = ''
  state.groupSelected = []
  state.groupPreview = null
  state.groupError = ''
  state.view = 'groupNew'
  render()
  if (state.catalog.length === 0) {
    void loadRooms().then(() => { if (state.view === 'groupNew') render() })
  }
}

function toggleGroupChoice(id: string): void {
  if (state.groupSelected.includes(id)) {
    state.groupSelected = state.groupSelected.filter((entry) => entry !== id)
  } else if (state.groupSelected.length >= 4) {
    toast('最多选 4 个成员', 'error')
  } else {
    state.groupSelected = [...state.groupSelected, id]
  }
  state.groupPreview = null
  render()
}

function chosenCatalog(): DiscussionCatalogItem[] {
  return state.groupSelected
    .map((id) => state.catalog.find((item) => item.id === id))
    .filter((item): item is DiscussionCatalogItem => item !== undefined)
}

async function previewGroup(): Promise<void> {
  const config = state.config
  const account = state.account
  if (!config || !account || state.groupBusy) return
  const chosen = chosenCatalog()
  if (chosen.length < 2) { toast('至少选 2 个成员', 'error'); return }
  const title = state.groupTitle.trim()
  const text = state.groupText.trim()
  if (!title) { toast('请填写群聊标题', 'error'); return }
  if (!text) { toast('请填写第一条消息', 'error'); return }
  state.groupBusy = true
  render()
  const input = buildPreviewInput({
    title,
    text,
    members: chosen.map((item) => ({ deviceId: item.deviceId, modelId: item.id })),
  })
  const result = await new AccountApi(config.hubUrl, account).preview(input)
  state.groupBusy = false
  if (!result.ok) {
    toast(result.message, 'error')
    if (result.error === 'unauthorized' || result.error === 'expired') {
      await clearAccount('账号会话已失效，请重新生成 ticket')
      return
    }
    render()
    return
  }
  state.groupPreview = result.data
  render()
}

async function createGroup(): Promise<void> {
  const config = state.config
  const account = state.account
  const preview = state.groupPreview
  if (!config || !account || !preview || state.groupBusy) return
  state.groupBusy = true
  render()
  const result = await new AccountApi(config.hubUrl, account).create(preview.digest)
  state.groupBusy = false
  if (!result.ok) {
    toast(result.message, 'error')
    if (result.error === 'unauthorized' || result.error === 'expired') {
      await clearAccount('账号会话已失效，请重新生成 ticket')
      return
    }
    render()
    return
  }
  state.room = result.data
  state.groupPreview = null
  state.view = 'groupRoom'
  state.groupDraft = ''
  render()
  startGroupPoll()
  void loadRooms()
  toast('群聊已创建')
}

function groupNewView(): Child[] {
  const config = state.config
  const account = state.account
  if (!config || !account || account.expiresAt <= Date.now()) {
    state.view = 'groups'
    return groupsView()
  }
  const header = topbar('新建群聊', '账号 ticket 会话 · 讨论模式', [
    button('返回', () => { state.view = 'groups'; render() }, { class: 'icon-button' }),
  ])
  const titleInput = el('input', {
    type: 'text', value: state.groupTitle, placeholder: '群聊标题', maxlength: 200,
    onInput: (event: Event) => { state.groupTitle = (event.target as HTMLInputElement).value; state.groupPreview = null },
  }) as HTMLInputElement
  const textInput = el('textarea', {
    rows: 3, value: state.groupText, placeholder: '第一条消息：要讨论/执行什么？', maxlength: 8192,
    onInput: (event: Event) => { state.groupText = (event.target as HTMLTextAreaElement).value; state.groupPreview = null },
  }) as HTMLTextAreaElement
  const chosen = chosenCatalog()
  const catalogRows = state.catalog.map((item) => {
    const picked = state.groupSelected.includes(item.id)
    return el('button', {
      class: 'session' + (picked ? ' picked' : ''),
      onClick: () => { toggleGroupChoice(item.id) },
    },
    el('span', { class: 'dot' + (picked ? ' online' : '') }),
    el('span', { class: 'copy' },
      el('strong', { text: (picked ? '✓ ' : '') + item.deviceName + ' · ' + agentLabel(item.agent) }),
      el('span', { text: item.model + (item.reasoningEfforts.length > 0 ? ' · 思考：' + item.reasoningEfforts.map(effortLabel).join(' / ') : '') }),
    ),
    )
  })
  const preview = state.groupPreview
  const previewNode = preview
    ? el('div', { class: 'card' },
      el('h2', { text: '确认共享范围' }),
      el('p', { class: 'notice', text: '下面的内容与本群后续回复会交给所选设备及其模型服务。每位成员使用独立、无工具的讨论环境。' }),
      el('pre', { class: 'tool', text: preview.text }),
      ...preview.members.map((member) => {
        const model = state.catalog.find((item) => item.id === member.model.id)
        return el('div', { class: 'row-between' },
          el('div', { class: 'label' },
            el('strong', { text: (model?.deviceName ?? member.deviceId) + ' · ' + member.model.agent + ' / ' + member.model.model }),
            el('span', { text: (member.id === preview.moderatorId ? '主持人' : '成员') + (member.reasoning ? ' · 思考：' + effortLabel(member.reasoning) : '') }),
          ),
          el('span', { class: 'chip', text: member.id === preview.moderatorId ? '主持' : '参与' }),
        )
      }),
      el('p', { class: 'banner', text: '确认后会立即开始群聊，最多 ' + preview.maxCalls + ' 次模型调用。' }),
      button(state.groupBusy ? '创建中…' : '确认并开始群聊', () => { void createGroup() }, {
        class: 'primary block', disabled: state.groupBusy,
      }),
    )
    : null
  return [
    header,
    ...(state.groupError ? [el('div', { class: 'banner error', text: state.groupError })] : []),
    el('div', { class: 'card' },
      el('h2', { text: '内容' }),
      el('div', { class: 'form' },
        el('div', { class: 'field' }, el('label', { text: '标题' }), titleInput),
        el('div', { class: 'field' }, el('label', { text: '第一条消息' }), textInput),
      ),
    ),
    el('div', { class: 'card' },
      el('h2', { text: '成员（已选 ' + chosen.length + '/4 · 第一项为主持人）' }),
      ...(catalogRows.length > 0 ? catalogRows : [el('p', { class: 'empty', text: '暂无可用模型；请返回群聊列表刷新。' })]),
      el('div', { class: 'choices' },
        button(state.groupBusy ? '读取中…' : '预览范围', () => { void previewGroup() }, {
          class: 'primary', disabled: state.groupBusy || chosen.length < 2,
        }),
      ),
    ),
    previewNode,
    el('p', { class: 'notice', text: '讨论模式：每位成员独立、无工具；主持人自动分工、收集回复并汇总。最多 3 轮。' }),
  ]
}

function settingsView(): Child[] {
  const config = state.config
  if (!config) { state.view = 'setup'; return setupView() }
  const hubInput = el('input', { type: 'url', inputmode: 'url', autocomplete: 'url', value: config.hubUrl }) as HTMLInputElement
  const tokenInput = el('input', { type: 'password', autocomplete: 'off', value: config.token, placeholder: '管理令牌' }) as HTMLInputElement
  const result = el('p', { class: 'empty', text: '' })
  const ticketInput = el('input', {
    type: 'text', autocomplete: 'off',
    placeholder: '粘贴电脑端 npm run ticket 生成的 ticket / 深链',
    value: '',
  }) as HTMLInputElement
  const accountResult = el('p', { class: 'empty', text: '' })
  const account = state.account && state.account.expiresAt > Date.now() ? state.account : null
  const accountCard = account
    ? el('div', { class: 'card' },
      el('h2', { text: '群聊账号' }),
      el('div', { class: 'row-between' },
        el('div', { class: 'label' },
          el('strong', { text: '已登录' }),
          el('span', { text: (account.name ? account.name + ' · ' : '') + '到期 ' + new Date(account.expiresAt).toLocaleString('zh-CN') }),
        ),
        el('span', { class: 'chip on', text: 'ticket 会话' }),
      ),
      el('p', { class: 'notice', text: '群聊只认账号 cookie；退出后需重新生成 ticket。' }),
      button('退出群聊账号', () => { void logoutAccount() }, { class: 'block danger' }),
    )
    : el('div', { class: 'card' },
      el('h2', { text: '群聊账号（ticket）' }),
      el('p', { class: 'empty', text: state.groupError || '群聊接口只认账号 cookie，管理令牌不够。' }),
      el('div', { class: 'form' },
        el('div', { class: 'field' },
          el('label', { text: '配对链接 / 账号 ticket' }),
          ticketInput,
          el('small', { text: '电脑端 npm run onboard 生成一键配对链接；npm run ticket 只生成群聊 ticket（60 秒、一次）。' }),
        ),
        button(state.accountBusy ? '处理中…' : '用配对链接 / ticket 登录', () => {
          void (async () => {
            const raw = ticketInput.value.trim()
            if (/^marshal:\/\//i.test(raw)) {
              accountResult.textContent = '正在按配对链接配置…'
              await handleDeepLink(raw)
              accountResult.textContent = '配对链接已处理'
              return
            }
            const ticket = extractTicket(raw)
            if (!ticket) { accountResult.textContent = '请粘贴配对链接或 ticket'; return }
            accountResult.textContent = '正在登录…'
            const ok = await loginTicket(ticket)
            if (!ok) accountResult.textContent = '登录失败，请看下方提示。'
          })()
        }, { class: 'primary block', disabled: state.accountBusy }),
        accountResult,
      ),
    )

  const lockRow = config.lock
    ? el('div', { class: 'row-between' },
      el('div', { class: 'label' }, el('strong', { text: '应用锁' }), el('span', { text: '已开启，启动需 6 位 PIN' })),
      button('关闭', () => { disableLock() }, { class: 'icon-button danger' }))
    : el('div', { class: 'row-between' },
      el('div', { class: 'label' }, el('strong', { text: '应用锁' }), el('span', { text: '开启后每次启动要输 6 位 PIN' })),
      button('开启', () => { openLockSetup() }, { class: 'icon-button' }))

  return [
    topbar('设置', hubLabel(config.hubUrl), [backButton('home')]),
    themeCard(),
    el('div', { class: 'card' },
      el('h2', { text: '连接' }),
      el('div', { class: 'form' },
        el('div', { class: 'field' }, el('label', { text: 'Hub 地址' }), hubInput),
        el('div', { class: 'field' }, el('label', { text: '管理令牌' }), tokenInput,
          el('small', { text: '存于 iOS Keychain / Android EncryptedSharedPreferences' })),
        button('测试连接', () => { void testSettings(hubInput, tokenInput, result) }, { class: 'block' }),
        button('保存', () => { void saveSettings(hubInput, tokenInput, result) }, { class: 'primary block' }),
        result,
      ),
    ),
    accountCard,
    el('div', { class: 'card' }, el('h2', { text: '安全' }), lockRow),
    el('div', { class: 'card' },
      el('h2', { text: '节点' }),
      el('div', { class: 'row-between' },
        el('div', { class: 'label' }, el('strong', { text: '角色' }), el('span', { text: 'node（手机侧）' })),
        el('span', { class: 'chip on', text: '只出站' }),
      ),
      el('div', { class: 'row-between' },
        el('div', { class: 'label' }, el('strong', { text: '连接' }), el('span', { text: 'HTTPS 直连 Hub · 原生 SSE' })),
        el('span', { class: 'chip', text: '无入站端口' }),
      ),
      el('p', { class: 'notice', text: '手机端只向 Hub 发起连接，不承载 hub，也不代替电脑执行会话。' }),
    ),
    el('div', { class: 'card' },
      el('h2', { text: '关于' }),
      el('p', { class: 'empty', text: APP_TITLE + ' · v' + APP_VERSION + ' · ' + (inNativeShell() ? '原生壳' : '浏览器预览') }),
      el('p', { class: 'notice', text: CLIENT_ONLY_NOTE }),
      el('div', { class: 'form' },
        button('浏览器打开 Hub（群聊/账号登录）', () => { void openExternal(consoleUrl(config.hubUrl)) }, { class: 'block' }),
        button('清除本地数据', () => { void wipeData() }, { class: 'block danger' }),
      ),
    ),
  ]
}

async function testSettings(hubInput: HTMLInputElement, tokenInput: HTMLInputElement, result: HTMLElement): Promise<void> {
  const parsed = readSetup(hubInput, tokenInput)
  if (!parsed.ok) { result.textContent = parsed.error; return }
  result.textContent = '正在连接…'
  const devices = await new MarshalApi({ hubUrl: parsed.hubUrl, token: parsed.token }).devices()
  result.textContent = devices.ok ? '连接成功：' + devices.data.length + ' 台设备。' : devices.message
}

async function saveSettings(hubInput: HTMLInputElement, tokenInput: HTMLInputElement, result: HTMLElement): Promise<void> {
  const config = state.config
  if (!config) return
  const parsed = readSetup(hubInput, tokenInput)
  if (!parsed.ok) { result.textContent = parsed.error; return }
  const hubChanged = parsed.hubUrl !== config.hubUrl
  const next: MarshalConfig = {
    ...config,
    hubUrl: parsed.hubUrl,
    token: parsed.token,
    ...(hubChanged ? { account: null } : {}),
    updatedAt: Date.now(),
  }
  try {
    await writeConfig(next)
  } catch (error) {
    result.textContent = '保存失败：' + (error instanceof Error ? error.message : '未知错误')
    return
  }
  state.config = next
  if (hubChanged) state.account = null
  toast('已保存')
  await enterApp()
}

async function wipeData(): Promise<void> {
  await removeConfig()
  stream?.close()
  stream = null
  stopGroupPoll()
  state.config = null
  state.api = null
  state.devices = []
  state.sessions = []
  state.account = null
  state.room = null
  state.roomList = []
  state.catalog = []
  state.groupError = ''
  state.view = 'setup'
  render()
  toast('本地数据已清除')
}

/* ------------------------------ 应用锁 ------------------------------ */

function openLockSetup(): void {
  state.lockPurpose = 'set-new'
  state.pinDraft = ''
  state.pinError = ''
  pinBuffer = ''
  state.view = 'lock'
  render()
}

function disableLock(): void {
  if (!state.config?.lock) return
  state.lockPurpose = 'disable'
  state.pinError = ''
  pinBuffer = ''
  state.view = 'lock'
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
      if (!isValidPin(pin)) { state.pinError = 'PIN 需要 6 位数字'; render(); return }
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
      await persistLock(await createLock(pin))
      state.pinDraft = ''
      state.view = 'settings'
      render()
      toast('应用锁已开启')
      return
    }
    if (!config.lock) { state.view = 'home'; render(); return }
    const ok = await verifyPin(pin, config.lock)
    if (!ok) { state.pinError = 'PIN 不正确'; render(); return }
    if (purpose === 'disable') {
      await persistLock(null)
      state.view = 'settings'
      render()
      toast('应用锁已关闭')
      return
    }
    state.pinError = ''
    await enterApp()
    const pending = state.pendingDeepLink
    state.pendingDeepLink = null
    if (pending) await handleDeepLink(pending)
  }

  const press = (digit: string): void => {
    if (pinBuffer.length >= 6) return
    pinBuffer += digit
    refreshDots()
    if (pinBuffer.length === 6) void finish()
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
  refreshDots()
  return [el('div', { class: 'lock' },
    brand(),
    dots,
    message,
    el('div', { class: 'keypad' },
      ...keys.map((digit) => el('button', { text: digit, onClick: () => press(digit) })),
      el('button', { class: 'plain', text: '取消', onClick: () => { pinBuffer = ''; refreshDots() } }),
      el('button', { text: '0', onClick: () => press('0') }),
      el('button', { class: 'plain', text: '删除', onClick: () => { pinBuffer = pinBuffer.slice(0, -1); refreshDots() } }),
    ),
  )]
}

export { sameTarget }
export type { SessionRow }
