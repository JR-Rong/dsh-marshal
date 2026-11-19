import {
  el, clear, button, toast, formatTime, type Child,
} from './lib/dom.ts'
import {
  DEFAULT_HUB, consoleUrl, hubLabel, normalizeHubUrl, normalizeToken, makeConfig, CONFIG_VERSION,
  type MarshalConfig,
} from './lib/config.ts'
import {
  MarshalApi, agentLabel, sessionTitle, can, approvalChoices,
  type Capability, type DeviceRow, type InputCard, type MemoryEntry, type RosterAgent,
  type SessionRow, type Target, type TaskCard,
} from './lib/marshal.ts'
import { openEventStream, type StreamHandle, type StreamFrame } from './lib/sse.ts'
import { readConfig, writeConfig, removeConfig } from './lib/storage.ts'
import {
  createLock, verifyPin, isValidPin, applyPinFailure, clearPinGuard, pinWaitMs, type LockRecord, type PinGuard,
} from './lib/lock.ts'
import {
  setupChrome, inNativeShell, openExternal, vibrate, exitApp,
  watchNetwork, watchDeepLinks, watchBackButton, watchAppState,
} from './lib/native.ts'
import { decideDeepLink, parsePairingLink } from './lib/deeplink.ts'
import { resolveSettingsToken, SETTINGS_TOKEN_PLACEHOLDER } from './lib/settings-token.ts'
import { reduceActivity, type LockPhase } from './lib/activity.ts'
import { SESSION_PAGE_SIZE, sliceSessions } from './lib/sessions.ts'
import { createSingleFlight } from './lib/single-flight.ts'
import { acceptEventSeq, historyToMessage, type TranscriptMessage } from './lib/transcript.ts'
import { APP_TITLE, APP_VERSION, CLIENT_ONLY_NOTE } from './lib/version.ts'

type View = 'booting' | 'setup' | 'lock' | 'home' | 'sessions' | 'session' | 'controls' | 'groups' | 'settings' | 'tasks' | 'memory'

type Role = TranscriptMessage['role']
type Message = TranscriptMessage

interface UiState {
  view: View
  config: MarshalConfig | null
  api: MarshalApi | null
  devices: DeviceRow[]
  sessions: SessionRow[]
  deviceId: string | null
  session: SessionRow | null
  capability: Capability | undefined
  running: boolean
  messages: Message[]
  cards: InputCard[]
  busy: boolean
  statusText: string
  online: boolean
  historyCursor: string | null
  roomsError: string
  rooms: Record<string, unknown>[]
  lockPurpose: 'unlock' | 'set-new' | 'set-confirm' | 'disable'
  pinDraft: string
  pinError: string
  tasks: TaskCard[]
  memories: MemoryEntry[]
  roster: RosterAgent[]
  groupRoom: Record<string, unknown> | null
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
  running: false,
  messages: [],
  cards: [],
  busy: false,
  statusText: '',
  online: true,
  historyCursor: null,
  roomsError: '',
  rooms: [],
  lockPurpose: 'unlock',
  pinDraft: '',
  pinError: '',
  tasks: [],
  memories: [],
  roster: [],
  groupRoom: null,
}

let stream: StreamHandle | null = null
let subscriptionId: string | null = null
let lastSeq = 0
let disposeBack: (() => void) | null = null
let draft = ''
let sessionUnlocked = false
let pendingHubUrl: string | null = null
let sessionQuery = ''
const sessionLimits = new Map<string, number>()
let pinGuard: PinGuard = clearPinGuard()
let lockPhase: LockPhase = 'unlocked'
let seenInactive = false
const answerGate = createSingleFlight()
let advancedLogin = false

const rootNode = (): HTMLElement => {
  const node = document.getElementById('app')
  if (!node) throw new Error('缺少 #app 容器')
  return node
}

function render(): void {
  const app = rootNode()
  clear(app)
  app.className = 'app screen-' + state.view
  for (const child of screenChildren()) app.append(child as Node)
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
    case 'settings': return settingsView()
    case 'tasks': return tasksView()
    case 'memory': return memoryView()
  }
}

function brand(): HTMLElement {
  return el('div', { class: 'brand' },
    el('div', { class: 'mark', text: '调' }),
    el('div', {},
      el('h1', { text: '调度官' }),
      el('p', { text: '手机端 · 直连调度中心' }),
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
  state.view = 'booting'
  render()
  void setupChrome()
  const config = await readConfig()
  state.config = config
  if (!config) {
    sessionUnlocked = true
    lockPhase = 'unlocked'
    state.view = 'setup'
    render()
  } else if (config.lock) {
    sessionUnlocked = false
    lockPhase = 'locked'
    state.view = 'lock'
    state.lockPurpose = 'unlock'
    render()
  } else {
    sessionUnlocked = true
    lockPhase = 'unlocked'
    await enterApp()
  }
  await watchNetwork((online) => {
    state.online = online
    if (state.view === 'home' || state.view === 'sessions') render()
  })
  await watchDeepLinks((url) => { void onDeepLink(url) })
  await watchAppState((active) => {
    const next = reduceActivity(lockPhase, Boolean(state.config?.lock), active, seenInactive)
    lockPhase = next.phase
    seenInactive = next.seenInactive
    if (lockPhase === 'locked' && state.view !== 'lock') showLock()
  })
  await registerBackButton()
  window.addEventListener('pageshow', (event) => { if (event.persisted) void registerBackButton() })
}

function appIsLocked(): boolean {
  return Boolean(state.config?.lock) && !sessionUnlocked
}

function showLock(): void {
  sessionUnlocked = false
  lockPhase = 'locked'
  pinBuffer = ''
  state.lockPurpose = 'unlock'
  state.pinError = ''
  state.view = 'lock'
  render()
}

async function onDeepLink(url: string): Promise<void> {
  if (appIsLocked()) return
  const pairing = parsePairingLink(url)
  if (pairing) {
    if (pairing.hubUrl && state.config?.hubUrl && state.config.hubUrl !== pairing.hubUrl) {
      pendingHubUrl = pairing.hubUrl
      render()
      return
    }
    if (pairing.hubUrl && !state.config) {
      state.config = makeConfig({ hubUrl: pairing.hubUrl })
    }
    await redeemPairing(pairing.code)
    return
  }
  const decision = decideDeepLink({
    url,
    locked: appIsLocked(),
    configuredHub: state.config?.hubUrl ?? null,
  })
  if (decision.action === 'ignore' || decision.action === 'same') {
    if (decision.action === 'same') toast('已是当前 Hub')
    return
  }
  if (decision.action === 'invalid') { toast(decision.error, 'error'); return }
  if (decision.action === 'prefill') {
    state.config = makeConfig({ hubUrl: decision.hubUrl })
    state.view = 'setup'
    render()
    toast('已从链接填入 Hub 地址')
    return
  }
  pendingHubUrl = decision.hubUrl
  render()
}

async function confirmPendingHub(): Promise<void> {
  const hubUrl = pendingHubUrl
  const config = state.config
  pendingHubUrl = null
  if (!hubUrl || !config) { render(); return }
  const next: MarshalConfig = { ...config, hubUrl, token: '', updatedAt: Date.now() }
  try { await writeConfig(next) } catch (error) {
    toast(error instanceof Error ? error.message : '保存失败', 'error')
    return
  }
  stream?.close()
  stream = null
  state.config = next
  state.api = null
  state.view = 'setup'
  advancedLogin = true
  render()
  toast('Hub 已更换，请重新填写令牌')
}

async function redeemPairing(code: string): Promise<void> {
  const hubUrl = state.config?.hubUrl
  if (!hubUrl) { toast('先填写 Hub 地址', 'error'); state.view = 'setup'; render(); return }
  const api = new MarshalApi({ hubUrl, token: '' })
  const result = await api.redeemPairing(code, '手机')
  if (!result.ok) { toast(result.message, 'error'); return }
  const next: MarshalConfig = {
    ...(state.config ?? makeConfig({ hubUrl })),
    version: CONFIG_VERSION,
    hubUrl,
    token: result.data.credential,
    updatedAt: Date.now(),
  }
  await writeConfig(next)
  state.config = next
  if (next.lock && !sessionUnlocked) { showLock(); return }
  await enterApp()
}

async function registerBackButton(): Promise<void> {
  disposeBack?.()
  disposeBack = await watchBackButton(() => {
    const parent: Partial<Record<View, View>> = {
      settings: 'home', sessions: 'home', session: 'sessions', controls: 'session', groups: 'home',
      tasks: 'home', memory: 'home',
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
  void registerPhonePush()
}

async function registerPhonePush(): Promise<void> {
  const api = state.api
  if (!api || !inNativeShell()) return
  try {
    const plugin = await import('marshal-push')
    const token = await plugin.MarshalPush.token()
    if (!token?.token || !token.provider) return
    await api.registerPush({ provider: token.provider, token: token.token, ...(token.liveToken ? { liveToken: token.liveToken } : {}) })
  } catch {
    /* 没有推送插件或 Hub 未配置时保持安静 */
  }
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
  void loadRoster()
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
  lastSeq = 0
  draft = ''
  state.view = 'session'
  state.statusText = '正在订阅…'
  render()

  const target = targetOf(state.session)
  const subscribed = await api.subscribe(target)
  subscriptionId = subscribed.ok ? subscribed.data : null

  const [history, inputs] = await Promise.all([
    api.history(target, 40),
    api.inputs(target),
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
  const seq = acceptEventSeq(lastSeq, event.seq)
  if (!seq.accept) return
  lastSeq = seq.lastSeq
  switch (kind) {
    case 'capability.changed':
      state.capability = payload as unknown as Capability
      if (state.view === 'session' || state.view === 'controls') render()
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
    case 'message.completed': {
      const before = state.messages.map((message) => ({ ...message }))
      closeOpenMessages()
      patchTranscript(before)
      return
    }
    case 'turn.started': state.running = true; renderKeepingComposer(); return
    case 'turn.completed': state.running = false; closeOpenMessages(); renderKeepingComposer(); return
    case 'tool.started': {
      const before = state.messages.map((message) => ({ ...message }))
      state.messages.push({ id: String(event.seq), role: 'tool', text: '▶ ' + String(payload.name ?? payload.tool ?? 'tool'), open: false, at: Date.now() })
      patchTranscript(before); return
    }
    case 'tool.completed': {
      const before = state.messages.map((message) => ({ ...message }))
      state.messages.push({ id: String(event.seq), role: 'tool', text: String(payload.content ?? '').slice(0, 400), open: false, at: Date.now() })
      patchTranscript(before); return
    }
    case 'user.message': {
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (text && !state.messages.some((m) => m.role === 'user' && m.text === text)) {
        const before = state.messages.map((message) => ({ ...message }))
        state.messages.push({ id: String(event.seq), role: 'user', text, open: false, at: Date.now() })
        patchTranscript(before)
      }
      return
    }
    default: return
  }
}

function appendDelta(id: string, role: Role, text: string): void {
  const before = state.messages.map((message) => ({ ...message }))
  const existing = state.messages.find((m) => m.id === id && m.role === role)
  if (existing) {
    existing.text += text
    existing.open = true
  } else {
    state.messages.push({ id, role, text, open: true, at: Date.now() })
  }
  if (state.view !== 'session') return
  patchTranscript(before)
}

function patchTranscript(before: Message[]): void {
  const root = document.getElementById('transcript')
  if (!root) { render(); return }
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-key]')]
  if (nodes.length !== before.length) { renderKeepingComposer(); return }
  for (let index = 0; index < state.messages.length; index += 1) {
    const message = state.messages[index]
    if (!message) continue
    const node = nodes[index]
    if (!node || index >= before.length) {
      const created = messageNode(message)
      created.dataset.key = message.role + ':' + message.id
      root.append(created)
      continue
    }
    const previous = before[index]
    if (!previous || previous.id !== message.id || previous.role !== message.role) {
      renderKeepingComposer()
      return
    }
    if (previous.text !== message.text || previous.open !== message.open) {
      const body = node.querySelector('.msg-body')
      if (body) body.textContent = message.text
      node.classList.toggle('streaming', message.open)
    }
  }
  root.querySelector('.empty')?.remove()
}

function renderKeepingComposer(): void {
  const input = document.getElementById('composer')
  const focused = document.activeElement === input
  const selection = input instanceof HTMLInputElement
    ? { start: input.selectionStart, end: input.selectionEnd }
    : null
  render()
  const next = document.getElementById('composer')
  if (focused && next instanceof HTMLInputElement) {
    next.focus()
    if (selection?.start !== null && selection?.end !== null && selection) {
      next.setSelectionRange(selection.start, selection.end)
    }
  }
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
  if (!api || !session) return
  const text = draft.trim()
  if (!text) return
  draft = ''
  state.messages.push({ id: 'local-' + Date.now(), role: 'user', text, open: false, at: Date.now() })
  render()
  const result = await api.command('prompt', targetOf(session), { text })
  if (!result.ok) {
    toast(result.message, 'error')
    return
  }
}

async function answerCard(card: InputCard, answers: Array<{ id: string; selectedOptionIds: string[]; text?: string }>): Promise<void> {
  const api = state.api
  const session = state.session
  if (!api || !session) return
  await answerGate.run(card.requestId, async () => {
    const result = await api.command('answer', targetOf(session), { requestId: card.requestId, answers })
    if (!result.ok) {
      toast(result.error === 'unknown' ? '结果未知，未当作成功' : result.message, 'error')
      render()
      return
    }
    state.cards = state.cards.filter((entry) => entry.requestId !== card.requestId)
    toast('已提交')
    render()
  })
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

function asNodes(children: Child[]): Node[] {
  const nodes: Node[] = []
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    nodes.push(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
  }
  return nodes
}

function pendingHubCard(): HTMLElement | null {
  if (!pendingHubUrl) return null
  return el('div', { class: 'card' },
    el('h2', { text: '更改 Hub？' }),
    el('p', { class: 'empty', text: '链接要求连接到 ' + pendingHubUrl + '。确认后会清除已保存的令牌。' }),
    el('div', { class: 'choices' },
      button('确认更改', () => { void confirmPendingHub() }, { class: 'primary' }),
      button('取消', () => { pendingHubUrl = null; render() }),
    ),
  )
}

function setupView(): Child[] {
  const hubInput = el('input', {
    type: 'url', inputmode: 'url', autocomplete: 'url',
    placeholder: DEFAULT_HUB || 'https://hub.example.com',
    value: state.config?.hubUrl ?? DEFAULT_HUB,
  }) as HTMLInputElement
  const codeInput = el('input', {
    type: 'text', autocomplete: 'off', placeholder: '粘贴配对码或 marshal://pair 链接',
  }) as HTMLInputElement
  const pairResult = el('p', { class: 'empty', text: '在已登录的电脑上打开「手机配对」，用系统相机扫描二维码。' })
  const tokenInput = el('input', {
    type: 'password', autocomplete: 'off', placeholder: '管理令牌（高级）', value: '',
  }) as HTMLInputElement
  const result = el('p', { class: 'empty', text: '' })

  return [
    brand(),
    pendingHubCard(),
    el('div', { class: 'card' },
      el('h2', { text: '扫码配对' }),
      el('div', { class: 'form' },
        el('div', { class: 'field' }, el('label', { text: 'Hub 地址' }), hubInput),
        el('div', { class: 'field' }, el('label', { text: '配对码' }), codeInput),
        button('配对并进入', () => {
          const hub = normalizeHubUrl(hubInput.value)
          if (!hub.ok) { pairResult.textContent = hub.error; return }
          state.config = { ...(state.config ?? makeConfig({ hubUrl: hub.value })), hubUrl: hub.value }
          const link = parsePairingLink(codeInput.value.trim())
          const code = link?.code ?? codeInput.value.trim()
          if (!code) { pairResult.textContent = '请粘贴配对码'; return }
          void redeemPairing(code)
        }, { class: 'primary block' }),
        pairResult,
      ),
    ),
    el('div', { class: 'card' },
      button(advancedLogin ? '收起管理令牌' : '高级：使用管理令牌', () => { advancedLogin = !advancedLogin; render() }, { class: 'block ghost' }),
      ...(advancedLogin ? [el('div', { class: 'form' },
        el('div', { class: 'field' },
          el('label', { text: '管理令牌' }),
          tokenInput,
          el('small', { text: '只在无法扫码时使用。已保存的令牌不会回填到这里。' }),
        ),
        button('先测试连接', () => { void testSetup(hubInput, tokenInput, result) }, { class: 'block' }),
        button('保存并进入', () => { void saveSetup(hubInput, tokenInput, result) }, { class: 'primary block' }),
        result,
      )] : []),
    ),
    el('p', { class: 'notice', text: CLIENT_ONLY_NOTE }),
  ]
}

function readSetup(hubInput: HTMLInputElement, tokenInput: HTMLInputElement):
  { ok: true; hubUrl: string; token: string } | { ok: false; error: string } {
  const hub = normalizeHubUrl(hubInput.value)
  if (!hub.ok) return { ok: false, error: hub.error }
  const token = normalizeToken(tokenInput.value)
  if (!token.ok) return { ok: false, error: token.error }
  if (!token.value) return { ok: false, error: '请填写管理令牌' }
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
  if (config.lock && !sessionUnlocked) { showLock(); return }
  await enterApp()
}

function homeView(): Child[] {
  const config = state.config
  if (!config) { state.view = 'setup'; return setupView() }
  const header = topbar('调度官', hubLabel(config.hubUrl), [
    button('任务', () => { state.view = 'tasks'; void loadTasks() }, { class: 'icon-button' }),
    button('记忆', () => { state.view = 'memory'; void loadMemory() }, { class: 'icon-button' }),
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
    pendingHubCard(),
    ...banners,
    el('div', { class: 'card' },
      el('h2', { text: '设备' }),
      ...(rows.length > 0 ? rows : [el('p', { class: 'empty', text: '暂无设备在线。' })]),
    ),
    el('div', { class: 'foot', text: 'v' + APP_VERSION + ' · 直连客户端，不承载 hub/node' }),
  ]
}

function agentCapability(device: DeviceRow | undefined, agent: string): Capability | undefined {
  return device?.capabilities?.[agent]
}

function sessionsView(): Child[] {
  const device = state.devices.find((entry) => entry.id === state.deviceId)
  const header = topbar(device?.name ?? '会话', '选择会话', [backButton('home')])
  const search = el('input', {
    id: 'session-search',
    type: 'search',
    placeholder: '搜索会话',
    value: sessionQuery,
    onInput: (event: Event) => {
      sessionQuery = (event.target as HTMLInputElement).value
      const list = document.getElementById('session-list')
      if (!list) { render(); return }
      list.replaceChildren(...asNodes(sessionSections(device)))
    },
  }) as HTMLInputElement
  return [
    header,
    el('div', { class: 'card' },
      search,
      el('div', { id: 'session-list' }, ...sessionSections(device)),
    ),
  ]
}

function sessionSections(device: DeviceRow | undefined): Child[] {
  const groups = new Map<string, SessionRow[]>()
  for (const row of state.sessions) {
    const list = groups.get(row.agent) ?? []
    list.push(row)
    groups.set(row.agent, list)
  }
  const named = state.roster.filter((agent) => !device || agent.deviceId === device.id)
  for (const agent of named) {
    if (!groups.has(agent.agent)) groups.set(agent.agent, [])
  }
  const sections: Child[] = []
  if (groups.size === 0) {
    sections.push(el('p', { class: 'empty', text: state.statusText || '这台设备暂无会话。' }))
  }
  for (const [agent, rows] of groups) {
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    const limit = sessionLimits.get(agent) ?? SESSION_PAGE_SIZE
    const page = sliceSessions(rows, sessionQuery, limit)
    const rosterName = named.find((item) => item.agent === agent)?.name
    const title = (rosterName && rosterName !== agent ? rosterName + ' · ' : '') + agentLabel(agent)
    const canCreate = !agentCapability(device, agent)?.operations || can(agentCapability(device, agent), 'create')
    sections.push(el('div', { class: 'agent-group' },
      el('div', { class: 'row-between' },
        el('h3', { class: 'agent-title', text: title + ' · ' + page.total + ' 个会话' }),
        canCreate ? button('新会话', () => { void createSession(device?.id ?? state.deviceId ?? '', agent) }, { class: 'icon-button' }) : null,
      ),
      ...page.shown.map((row) => el('div', { class: 'session-row' },
        el('button', {
          class: 'session',
          onClick: () => { vibrate(); void openSession(state.deviceId ?? row.deviceId, row) },
        },
        el('span', { class: 'dot' + (row.running ? ' online' : '') }),
        el('span', { class: 'copy' },
          el('strong', { text: sessionTitle(row) }),
          el('span', { text: formatTime(row.updatedAt) }),
        ),
        el('span', { class: 'state' + (row.running ? ' running' : ''), text: row.running ? '运行中' : '空闲' }),
        ),
        (!row.capability?.operations || can(row.capability, 'fork'))
          ? button('分叉', () => { void forkSession(row) }, { class: 'icon-button' })
          : null,
      )),
      page.hasMore ? button('加载更多', () => {
        sessionLimits.set(agent, limit + SESSION_PAGE_SIZE)
        const list = document.getElementById('session-list')
        if (list) list.replaceChildren(...asNodes(sessionSections(device)))
      }, { class: 'block ghost' }) : null,
    ))
  }
  return sections
}

async function createSession(deviceId: string, agent: string): Promise<void> {
  const api = state.api
  if (!api || !deviceId || state.busy) return
  state.busy = true
  const result = await api.command('create', { deviceId, agent, sessionId: null }, {})
  state.busy = false
  if (!result.ok) { toast(result.message, 'error'); return }
  toast('已创建会话')
  const device = state.devices.find((entry) => entry.id === deviceId)
  if (device) await openDevice(device)
}

async function forkSession(row: SessionRow): Promise<void> {
  const api = state.api
  if (!api || state.busy) return
  state.busy = true
  const result = await api.command('fork', { deviceId: row.deviceId, agent: row.agent, sessionId: row.sessionId }, {})
  state.busy = false
  if (!result.ok) { toast(result.message, 'error'); return }
  toast('已分叉会话')
  const device = state.devices.find((entry) => entry.id === row.deviceId)
  if (device) await openDevice(device)
}

function messageNode(message: Message): HTMLElement {
  const cls = 'msg msg-' + message.role
  const node = el('div', { class: cls + (message.open ? ' streaming' : '') },
    el('div', { class: 'msg-role', text: ({
      user: '我', assistant: '智能体', reason: '思考', tool: '工具', system: '系统',
    } as const)[message.role] }),
    el('div', { class: 'msg-body', text: message.text }),
  )
  node.dataset.key = message.role + ':' + message.id
  return node
}

function cardNode(card: InputCard): HTMLElement {
  if (card.approval) {
    return el('div', { class: 'card ask' },
      el('h2', { text: '审批：' + card.approval.action }),
      ...(card.approval.detail ? [el('p', { class: 'tool', text: card.approval.detail })] : []),
      el('div', { class: 'choices' },
        ...approvalChoices(card.approval.decisions).map((decision) => {
          const node = button(decision.label, () => {
            node.disabled = true
            void answerCard(card, [{ id: decision.id, selectedOptionIds: [] }])
          })
          return node
        }),
        ...(approvalChoices(card.approval.decisions).length === 0
          ? [el('p', { class: 'empty', text: '没有可安全表达的本机决定' })]
          : []),
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
    ),
  )
}

function sessionView(): Child[] {
  const session = state.session
  if (!session) { state.view = 'sessions'; return sessionsView() }
  const header = topbar(sessionTitle(session), agentLabel(session.agent) + ' · ' + (state.running ? '运行中' : '空闲'), [
    backButton('sessions'),
    button('控制', () => { state.view = 'controls'; render() }, { class: 'icon-button' }),
    state.running ? button('中断', () => { void interrupt() }, { class: 'icon-button danger' }) : null,
  ])

  const input = el('input', {
    id: 'composer',
    type: 'text', placeholder: '发消息给 ' + agentLabel(session.agent) + '…', value: draft,
    onInput: (event: Event) => { draft = (event.target as HTMLInputElement).value },
  }) as HTMLInputElement
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') { void sendPrompt(); render() }
  })

  return [
    header,
    state.cards.length > 0 ? el('div', {}, ...state.cards.map(cardNode)) : null,
    el('div', { id: 'transcript', class: 'transcript' },
      state.historyCursor ? button('加载更早消息', () => { void loadOlder() }, { class: 'block ghost' }) : null,
      ...state.messages.map(messageNode),
      ...(state.messages.length === 0 ? [el('p', { class: 'empty', text: '暂无消息。' })] : []),
    ),
    el('div', { class: 'composer' }, input, button('发送', () => { void sendPrompt(); render() }, { class: 'primary' })),
  ]
}

function controlsView(): Child[] {
  const session = state.session
  const capability = state.capability
  const tunables = capability?.tunables ?? []
  return [
    topbar('控制项', session ? sessionTitle(session) : '未选择会话', [backButton('session')]),
    el('div', { class: 'card' },
      el('h2', { text: '能力' }),
      el('p', { class: 'empty', text: '操作：' + (capability?.operations ?? []).join(' / ').replace(/^$/, '未知') }),
      el('p', { class: 'empty', text: '写权：' + (capability?.ownership ?? '未知') + ' · 版本 ' + String(capability?.revision ?? '-') }),
      ...(capability?.runtimeEpoch ? [el('p', { class: 'empty', text: '运行时：' + String(capability.runtimeEpoch) })] : []),
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
    el('p', { class: 'notice', text: 'Hub 当前把模型、思考强度等标为只读（v0-field-only），手机端如实呈现，不做假开关。' }),
  ]
}

async function loadRooms(): Promise<void> {
  const api = state.api
  if (!api) return
  state.roomsError = ''
  const result = await api.discussions()
  if (!result.ok) {
    state.roomsError = result.error === 'unauthorized'
      ? '此 Hub 的群聊只对账号登录开放，令牌不可用；请在本机「调度官」插件里使用群聊。'
      : result.message
    if (state.view === 'groups') render()
    return
  }
  state.rooms = result.data.rooms as Record<string, unknown>[]
  if (state.view === 'groups') render()
}

async function openRoom(roomId: string): Promise<void> {
  const api = state.api
  if (!api) return
  const result = await api.discussion(roomId)
  if (!result.ok) { toast(result.message, 'error'); return }
  state.groupRoom = result.data
  if (state.view === 'groups') render()
}

function groupsView(): Child[] {
  const header = topbar('群聊', 'Agent 工作群', [backButton('home')])
  if (state.groupRoom) {
    const room = state.groupRoom
    const messages = Array.isArray(room.messages) ? room.messages as Array<{ text?: string; author?: string }> : []
    const roomId = String(room.id ?? '')
    return [
      header,
      el('div', { class: 'card' },
        button('全部房间', () => { state.groupRoom = null; render() }, { class: 'ghost block' }),
        el('h2', { text: String(room.title ?? '群聊') }),
        ...(messages.length === 0 ? [el('p', { class: 'empty', text: '暂无消息。' })] : []),
        ...messages.map((message) => el('p', { text: (message.author ? message.author + '：' : '') + String(message.text ?? '') })),
      ),
      roomId ? groupComposer(roomId) : null,
    ]
  }
  if (state.roomsError) {
    return [header, el('div', { class: 'card' }, el('p', { class: 'empty', text: state.roomsError }))]
  }
  if (state.rooms.length === 0) {
    return [header, el('div', { class: 'card' }, el('p', { class: 'empty', text: '暂无群聊房间。' }))]
  }
  return [header, el('div', { class: 'card' },
    ...state.rooms.map((room) => {
      const id = String(room.id ?? room.roomId ?? '')
      return el('button', {
        class: 'session',
        onClick: () => { if (id) void openRoom(id) },
      },
      el('span', { class: 'copy' },
        el('strong', { text: String((room.title ?? room.name ?? id) || '未命名房间') }),
        el('span', { text: String(room.state ?? room.status ?? '') }),
      ))
    }),
  )]
}

function settingsView(): Child[] {
  const config = state.config
  if (!config) { state.view = 'setup'; return setupView() }
  const hubInput = el('input', { type: 'url', inputmode: 'url', autocomplete: 'url', value: config.hubUrl }) as HTMLInputElement
  const tokenInput = el('input', { type: 'password', autocomplete: 'off', value: '', placeholder: SETTINGS_TOKEN_PLACEHOLDER }) as HTMLInputElement
  const result = el('p', { class: 'empty', text: '' })

  const lockRow = config.lock
    ? el('div', { class: 'row-between' },
      el('div', { class: 'label' }, el('strong', { text: '应用锁' }), el('span', { text: '已开启，启动需 6 位 PIN' })),
      button('关闭', () => { disableLock() }, { class: 'icon-button danger' }))
    : el('div', { class: 'row-between' },
      el('div', { class: 'label' }, el('strong', { text: '应用锁' }), el('span', { text: '开启后每次启动要输 6 位 PIN' })),
      button('开启', () => { openLockSetup() }, { class: 'icon-button' }))

  return [
    topbar('设置', hubLabel(config.hubUrl), [backButton('home')]),
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
    el('div', { class: 'card' }, el('h2', { text: '安全' }), lockRow),
    el('div', { class: 'card' },
      el('h2', { text: '关于' }),
      el('p', { class: 'empty', text: APP_TITLE + ' · v' + APP_VERSION + ' · ' + (inNativeShell() ? '原生壳' : '浏览器预览') }),
      el('p', { class: 'notice', text: CLIENT_ONLY_NOTE }),
      el('div', { class: 'form' },
        button('在浏览器中打开 Hub', () => { void openExternal(consoleUrl(config.hubUrl)) }, { class: 'block' }),
        button('清除本地数据', () => { void wipeData() }, { class: 'block danger' }),
      ),
    ),
  ]
}

async function testSettings(hubInput: HTMLInputElement, tokenInput: HTMLInputElement, result: HTMLElement): Promise<void> {
  const config = state.config
  if (!config) return
  const hub = normalizeHubUrl(hubInput.value)
  if (!hub.ok) { result.textContent = hub.error; return }
  const token = resolveSettingsToken({ typed: tokenInput.value, saved: config.token, previousHub: config.hubUrl, nextHub: hub.value })
  if (!token.ok) { result.textContent = token.error; return }
  result.textContent = '正在连接…'
  const devices = await new MarshalApi({ hubUrl: hub.value, token: token.token }).devices()
  result.textContent = devices.ok ? '连接成功：' + devices.data.length + ' 台设备。' : devices.message
}

async function saveSettings(hubInput: HTMLInputElement, tokenInput: HTMLInputElement, result: HTMLElement): Promise<void> {
  const config = state.config
  if (!config) return
  const hub = normalizeHubUrl(hubInput.value)
  if (!hub.ok) { result.textContent = hub.error; return }
  const token = resolveSettingsToken({ typed: tokenInput.value, saved: config.token, previousHub: config.hubUrl, nextHub: hub.value })
  if (!token.ok) { result.textContent = token.error; return }
  const next: MarshalConfig = { ...config, hubUrl: hub.value, token: token.token, updatedAt: Date.now() }
  try {
    await writeConfig(next)
  } catch (error) {
    result.textContent = '保存失败：' + (error instanceof Error ? error.message : '未知错误')
    return
  }
  state.config = next
  toast('已保存')
  if (next.lock && !sessionUnlocked) { showLock(); return }
  await enterApp()
}

async function wipeData(): Promise<void> {
  await removeConfig()
  stream?.close()
  stream = null
  state.config = null
  state.api = null
  state.devices = []
  state.sessions = []
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
    const wait = pinWaitMs(pinGuard, Date.now())
    if (wait > 0) {
      state.pinError = '尝试过多，请等待 ' + Math.ceil(wait / 1000) + ' 秒'
      render()
      return
    }
    const ok = await verifyPin(pin, config.lock)
    if (!ok) {
      pinGuard = applyPinFailure(pinGuard, Date.now())
      state.pinError = 'PIN 不正确，请等待 ' + Math.ceil(pinWaitMs(pinGuard, Date.now()) / 1000) + ' 秒'
      render()
      return
    }
    pinGuard = clearPinGuard()
    if (purpose === 'disable') {
      await persistLock(null)
      sessionUnlocked = true
      lockPhase = 'unlocked'
      state.view = 'settings'
      render()
      toast('应用锁已关闭')
      return
    }
    state.pinError = ''
    sessionUnlocked = true
    lockPhase = 'unlocked'
    seenInactive = false
    await enterApp()
  }

  const press = (digit: string): void => {
    if (pinWaitMs(pinGuard, Date.now()) > 0) {
      state.pinError = '尝试过多，请等待 ' + Math.ceil(pinWaitMs(pinGuard, Date.now()) / 1000) + ' 秒'
      render()
      return
    }
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

async function loadTasks(): Promise<void> {
  const api = state.api
  if (!api) return
  const result = await api.tasks()
  state.tasks = result.ok ? result.data : []
  state.statusText = result.ok ? '' : result.message
  if (state.view === 'tasks') render()
}

async function loadMemory(): Promise<void> {
  const api = state.api
  if (!api) return
  const result = await api.memory()
  state.memories = result.ok ? result.data : []
  state.statusText = result.ok ? '' : result.message
  if (state.view === 'memory') render()
}

function tasksView(): Child[] {
  const title = el('input', { type: 'text', placeholder: '新任务标题' }) as HTMLInputElement
  return [
    topbar('任务', '可编辑', [backButton('home')]),
    el('div', { class: 'card' },
      el('div', { class: 'form' },
        title,
        button('添加', () => {
          const text = title.value.trim()
          if (!text || !state.api) return
          void state.api.taskWrite({ action: 'create', title: text }).then((result) => {
            if (!result.ok) { toast(result.message, 'error'); return }
            state.tasks = result.data
            render()
          })
        }, { class: 'primary block' }),
      ),
      ...(state.tasks.length === 0 ? [el('p', { class: 'empty', text: state.statusText || '暂无任务。' })] : []),
      ...state.tasks.map((task) => el('div', { class: 'row-between' },
        el('div', { class: 'label' },
          el('strong', { text: task.title }),
          el('span', { text: task.status === 'todo' ? '待办' : task.status === 'doing' ? '进行中' : '完成' }),
        ),
        el('div', { class: 'choices' },
          button(task.status === 'todo' ? '开始' : task.status === 'doing' ? '完成' : '待办', () => {
            const status = task.status === 'todo' ? 'doing' : task.status === 'doing' ? 'done' : 'todo'
            void state.api?.taskWrite({ action: 'move', id: task.id, status }).then((result) => {
              if (!result || !result.ok) { toast(result && !result.ok ? result.message : '失败', 'error'); return }
              state.tasks = result.data
              render()
            })
          }, { class: 'icon-button' }),
        ),
      )),
    ),
  ]
}

function memoryView(): Child[] {
  return [
    topbar('记忆', '只读', [backButton('home')]),
    el('div', { class: 'card' },
      ...(state.memories.length === 0 ? [el('p', { class: 'empty', text: state.statusText || '暂无记忆。' })] : []),
      ...state.memories.map((entry) => el('div', { class: 'row-between' },
        el('div', { class: 'label' },
          el('strong', { text: entry.agent || '记忆' }),
          el('span', { text: entry.text }),
        ),
      )),
    ),
  ]
}

async function loadRoster(): Promise<void> {
  const api = state.api
  if (!api) return
  const result = await api.roster()
  if (result.ok) state.roster = result.data
}

function groupComposer(roomId: string): HTMLElement {
  const input = el('input', { type: 'text', placeholder: '发到群里…' }) as HTMLInputElement
  return el('div', { class: 'composer' },
    input,
    button('发送', () => {
      const text = input.value.trim()
      const room = state.groupRoom
      const members = Array.isArray(room?.members) ? room.members as Array<{ id?: string }> : []
      const recipient = typeof members[0]?.id === 'string' ? members[0].id : 'moderator'
      if (!text || !state.api) return
      void state.api.discussionAction({
        action: 'send', roomId, text, recipient, key: 'm-' + Date.now().toString(36),
      }).then((result) => {
        if (!result.ok) { toast(result.message, 'error'); return }
        state.groupRoom = result.data.room as Record<string, unknown> ?? result.data
        input.value = ''
        render()
      })
    }, { class: 'primary' }),
  )
}
