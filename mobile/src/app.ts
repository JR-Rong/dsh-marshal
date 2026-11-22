import {
  el, clear, button, toast, formatTime, type Child,
} from './lib/dom.ts'
import {
  DEFAULT_HUB, consoleUrl, hubLabel, normalizeHubUrl, normalizeToken, makeConfig, CONFIG_VERSION,
  MOBILE_THEMES, type MarshalConfig, type MobileTheme,
} from './lib/config.ts'
import {
  MarshalApi, agentLabel, sessionTitle, sameTarget, can, formatTokens, buildPromptArgs, newIdempotencyKey, decisionIsSafe, parseCards,
  type BoardReceipt, type Capability, type DeviceRow, type InputCard, type RosterEntry, type SessionRow, type Target, type SessionControls,
} from './lib/marshal.ts'
import {
  AccountApi, buildPreviewInput, buildSendPayload, extractTicket, loginWithTicket, parseOnboardLink, parsePreview, parseRoom, parseRoomList,
  type DiscussionCatalogItem, type DiscussionRoom, type GroupPreview, type RoomSummary,
} from './lib/account.ts'
import type { AccountSession } from './lib/config.ts'
import { openEventStream, type StreamHandle, type StreamFrame } from './lib/sse.ts'
import { sliceSessions, SESSION_PAGE_SIZE } from './lib/sessions.ts'
import { acceptEventSeq } from './lib/transcript.ts'
import { hasStoredBridge, loadBridgeDevice, openBridgeWorkbench, saveBridgeDevice } from './bridge/workbench.ts'
import { classifyPairing, pairBridge, parsePairPayload, parseUnifiedPairing } from './lib/bridge.ts'
import { openQrScanner } from './lib/scanner.ts'
import { ConfigReadError, installationId, readConfig, readPinGuard, removeConfig, updateConfig, writePinGuard, readTheme, writeTheme, writeNodePreference } from './lib/storage.ts'
import { createConnectivity } from './lib/connectivity.ts'
import { createSummaryCapDraft, renderSummaryCap } from './lib/summary-cap.ts'
import { buildMemoryGraph, CLARITY_LABELS, GALAXY_NODE_LIMIT, layoutMemoryGalaxy, MEMORY_KIND_META, MEMORY_LAYERS,
  toGalaxyNodes, type GalaxyNode } from './lib/memory-galaxy.ts'
import { initialGalaxyCamera, mountGalaxyCanvas } from './lib/memory-galaxy-canvas.ts'
import { createLock, pinDelay, verifyPin, isValidPin, type LockRecord } from './lib/lock.ts'
import { decideDeepLink, linkCarriesSecret, parsePairingLink } from './lib/deeplink.ts'
import { livePhaseAfterApproval } from './lib/live.ts'
import { resolveSettingsToken, SETTINGS_TOKEN_PLACEHOLDER } from './lib/settings-token.ts'
import {
  setupChrome, inNativeShell, openExternal, vibrate, exitApp,
  watchNetwork, watchDeepLinks, watchBackButton,
} from './lib/native.ts'
import { computeTabBadges, formatTabBadge, scheduleBoardPoll } from './lib/tab-badges.ts'
import { createPendingInputs, inputTarget, inputTargetKey } from './lib/pending-inputs.ts'
import { APP_TITLE, APP_VERSION, CLIENT_ONLY_NOTE } from './lib/version.ts'

import { filterSessionsByCategory, initialWizardState, moveWizardStep, selectWizardHost, validateWizardState,
  sessionCenterRoute, groupBackCategory, roomRetryId, beginCreateAttempt, finishCreateAttempt, canCloseCreateSheet,
  isWelcomeEmpty, isUnconfirmedEmpty, fillWelcomeStarter, shouldTriggerOlderHistory, preserveScrollAnchor,
  mergeTranscriptSnapshot, appendTranscriptDelta, historyPageProgress, transcriptMessageKey,
  EFFORT_META, buildEffortSheetOptions, formatThoughtSummary,
  WELCOME_STARTERS, type HistoryStatus, type SessionCategory, type WizardStep } from './lib/chat-ui.ts'

import { TICKET_TEMPLATES, filterTickets, ticketFilter, ticketStageIndex, parseDiffPreview, reduceTicketNavigation,
  TicketWrites, ticketBackAction, ticketWriteBlocked, ticketWriteKey,
  type Ticket, type TicketRef, type TicketFilter, type TicketNavigation, type TicketWriteState } from './lib/tickets.ts'

type View = 'booting' | 'setup' | 'lock' | 'home' | 'sessions' | 'session' | 'controls' | 'groups' | 'groupRoom' | 'ticketGroup' | 'groupNew' | 'settings' | 'board' | 'agents' | 'memory'

type Role = 'user' | 'assistant' | 'reason' | 'tool' | 'system'

interface Message {
  id: string
  role: Role
  text: string
  open: boolean
  at: number
  endedAt?: number
  snapshotText?: string
  snapshotPrefix?: string
  streamText?: string
  completed?: boolean
  toolTitle?: string
  failed?: boolean
  retryKey?: string
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
let lastNodeEpoch: unknown
let pendingInputs = createPendingInputs()
let inputRecovery = 0
let disposeBack: (() => void) | null = null
let draft = ''

const rootNode = (): HTMLElement => {
  const node = document.getElementById('app')
  if (!node) throw new Error('缺少 #app 容器')
  return node
}

const TAB_ITEMS = [
  { view: 'board', label: '工单', icon: 'board' },
  { view: 'sessions', label: '会话', icon: 'chat' },
  { view: 'agents', label: '智能体', icon: 'agents' },
  { view: 'home', label: '节点', icon: 'device' },
] as const

const TAB_VIEWS: ReadonlySet<View> = new Set(TAB_ITEMS.map((item) => item.view))

function tabIcon(kind: string): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const paths: Record<string, string> = {
    plus: 'M12 5v14 M5 12h14',
    down: 'm6 9 6 6 6-6',
    thought: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
    send: 'M12 20V4 M5 11l7-7 7 7',
    stop: 'M7 7h10v10H7Z',
    terminal: 'M3 5h18v14H3Z M7 9l3 3-3 3 M13 15h4',
    copy: 'M8 8h12v13H8Z M16 4H4v13',
    device: 'M8 3.5h8a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z M10.5 17.5h3',
    chat: 'M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v6A2.5 2.5 0 0 1 17 15H9l-4.5 3.5v-12Z',
    board: 'M4.5 5.5h15v6h-15z M4.5 15h7v4h-7z M14.5 15h5v4h-5z',
    agents: 'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1Z M3 13a3 3 0 0 0 0-6 M21 13a3 3 0 0 0 0-6',
  }
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', paths[kind] ?? paths.device)
  svg.append(path)
  return svg
}

function tabBar(): HTMLElement {
  const badges = computeTabBadges(boardTasks, pendingInputs.waitingCounts(), state.online && !hubUnavailable)
  return el('nav', { class: 'tabbar', 'aria-label': '主导航' },
    ...TAB_ITEMS.map(({ view, label, icon }) => {
      const active = view === state.view || (view === 'sessions' && (state.view === 'groups' || state.view === 'ticketGroup'))
      const count = view === 'board' ? badges.board : view === 'sessions' ? badges.sessions : 0
      const offline = view === 'home' && badges.home
      return el('button', {
        type: 'button', class: 'tab-item' + (active ? ' active' : ''),
        'aria-current': active ? 'page' : undefined,
        'aria-label': label + (offline ? '，离线' : count ? `，${count} 项${view === 'board' ? '待确认或进行中' : '待回答'}` : ''),
        onClick: () => { vibrate(); switchTab(view) },
      },
      el('span', { class: 'tab-symbol' }, tabIcon(icon),
        count ? el('span', { class: 'tab-badge', 'aria-hidden': 'true', text: formatTabBadge(count) }) : null,
        offline ? el('span', { class: 'tab-badge offline', 'aria-hidden': 'true' }) : null,
      ),
      el('span', { class: 'tab-label', text: label }))
    }),
  )
}

function refreshTabBar(): void {
  rootNode().querySelector('.tabbar')?.replaceWith(tabBar())
}

function switchTab(view: View): void {
  if (view === state.view) return
  if (state.view === 'ticketGroup') {
    ticketGroupOpen++
    ticketNav = reduceTicketNavigation(ticketNav, { type: 'close' })
    state.room = null
    state.groupBusy = false
  }
  if (view === 'home') { state.view = 'home'; render(); void refreshDevices(); return }
  if (view === 'sessions') {
    showSessionCategory(sessionCategory)
    return
  }
  if (view === 'board') { state.view = 'board'; render(); void loadBoard(); return }
  if (view === 'agents') {
    state.view = 'agents'
    render()
    if (agentsSegment === 'memory') void loadMemory()
    else void refreshDevices()
  }
}

function render(prependHistory = false): void {
  clearTimeout(connectivityExpiry)
  clearTimeout(connectivityRefresh)
  if (state.view !== 'home') { privacyConfirming = false; sliderDragging = false }
  disposeGalaxy?.()
  disposeGalaxy = undefined
  if (composerSheet && (state.view !== 'session' || composerSheet.session !== sessionGeneration)) composerSheet.close()
  if (chatSheet && state.view !== chatSheet.view) chatSheet.dismiss()
  if (appConfirmation && (appLocked() || state.view !== appConfirmation.view)) appConfirmation.cancel()
  if (state.view !== 'groupRoom' && state.view !== 'ticketGroup') stopGroupPoll()
  if (!showingMemory()) { clearTimeout(memoryPoll); memoryLoad++ }
  const app = rootNode()
  const segment = document.activeElement
  const segmentGroup = segment?.matches('[aria-pressed="true"]') && app.contains(segment)
    ? segment.closest('[role="group"]')?.getAttribute('aria-label') : null
  const previous = state.view === 'session' && renderedSession === sessionGeneration
    ? app.querySelector<HTMLElement>('.transcript') : null
  const prevTop = previous?.scrollTop ?? 0
  const prevHeight = previous?.scrollHeight ?? 0
  const followBottom = previous && prevHeight - previous.clientHeight - prevTop <= 24
  const anchor = prependHistory && previous ? [...previous.querySelectorAll<HTMLElement>('[data-msg]')]
    .find(node => node.getBoundingClientRect().bottom > previous.getBoundingClientRect().top) : null
  const anchorY = anchor && previous ? anchor.getBoundingClientRect().top - previous.getBoundingClientRect().top : 0
  const activeInput = previous && app.querySelector<HTMLInputElement>('.session-composer input[type="text"]')
  const selection = activeInput && activeInput === document.activeElement
    ? [activeInput.selectionStart, activeInput.selectionEnd] as const : null
  clear(app)
  const withTabs = TAB_VIEWS.has(state.view) || state.view === 'ticketGroup' || state.view === 'groups'
  app.className = 'app screen-' + state.view + (withTabs ? ' has-tabs' : '')
  app.append(el('p', { id: 'config-read-error', class: 'banner warn', role: 'status', hidden: !configReadError, text: configReadError }))
  for (const child of screenChildren()) {
    // 浏览器 append(null) 会渲染出 "null" 字样，必须先过滤空槽位。
    if (child === null || child === undefined || child === false) continue
    app.append(child as Node)
  }
  const transcript = state.view === 'session' ? app.querySelector<HTMLElement>('.transcript') : null
  if (transcript) {
    const nextAnchor = anchor && [...transcript.querySelectorAll<HTMLElement>('[data-msg]')]
      .find(node => node.dataset.msg === anchor.dataset.msg)
    transcript.scrollTop = prependHistory && previous
      ? nextAnchor ? nextAnchor.getBoundingClientRect().top - transcript.getBoundingClientRect().top - anchorY
        : preserveScrollAnchor(prevHeight, transcript.scrollHeight, prevTop)
      : !previous || followBottom ? transcript.scrollHeight : prevTop
    bindHistoryScroll(transcript)
    renderedSession = sessionGeneration
    if (selection) {
      const input = app.querySelector<HTMLInputElement>('.session-composer input[type="text"]')
      input?.focus({ preventScroll: true })
      input?.setSelectionRange(...selection)
    }
  }
  if (withTabs) app.append(tabBar())
  if (segmentGroup) [...app.querySelectorAll('[role="group"]')].find(group => group.getAttribute('aria-label') === segmentGroup)
    ?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true })
  if (state.view === 'board') { refreshTicketList(); updateTicketSheet() }
  scheduleConnectivityExpiry()
}

function screenChildren(): Child[] {
  switch (state.view) {
    case 'booting': return [brand(), configReadError
      ? button('重试读取本机配置', () => { void start() }, { class: 'primary block' })
      : el('p', { class: 'empty', text: '正在读取本机配置…' })]
    case 'setup': return setupView()
    case 'lock': return lockView()
    case 'home': return homeView()
    case 'sessions': return sessionsView()
    case 'session': return sessionView()
    case 'controls': return controlsView()
    case 'groups': return groupsView()
    case 'groupRoom': return groupRoomView()
    case 'ticketGroup': return ticketGroupView()
    case 'groupNew': return groupNewView()
    case 'settings': return settingsView()
    case 'board': return boardView()
    case 'agents': return agentsView()
    case 'memory': return memoryView()
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 直接复用仓库 plugin-build/icon.svg 的品牌标记：Marshal 蓝底 + 三阶信号条 + 顶灯。 */
function logoMark(): HTMLElement {
  const wrap = el('span', { class: 'mark', 'aria-hidden': 'true' })
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 64 64')
  const rect = document.createElementNS(SVG_NS, 'rect')
  rect.setAttribute('width', '64')
  rect.setAttribute('height', '64')
  rect.setAttribute('rx', '15')
  rect.setAttribute('fill', '#1F6FEB')
  const bars = document.createElementNS(SVG_NS, 'path')
  bars.setAttribute('d', 'M16 42h32M20 34h24M24 26h16')
  bars.setAttribute('stroke', '#FFFFFF')
  bars.setAttribute('stroke-width', '4')
  bars.setAttribute('stroke-linecap', 'round')
  const beacon = document.createElementNS(SVG_NS, 'circle')
  beacon.setAttribute('cx', '32')
  beacon.setAttribute('cy', '17')
  beacon.setAttribute('r', '4')
  beacon.setAttribute('fill', '#FFFFFF')
  svg.append(rect, bars, beacon)
  wrap.append(svg)
  return wrap
}

function brand(): HTMLElement {
  return el('div', { class: 'brand' },
    logoMark(),
    el('div', {},
      el('h1', { text: '调度官' }),
      el('p', { text: '手机端 node · 直连调度中心' }),
    ),
  )
}

const THEME_LABELS: Record<MobileTheme, string> = {
  system: '跟随系统', deepseek: 'DeepSeek 蓝', white: '纯粹白', dark: '曜石黑', codex: 'Codex 紫',
}
let mobileTheme: MobileTheme = 'system'

function applyTheme(theme: MobileTheme): void {
  mobileTheme = theme
  document.documentElement.dataset.theme = theme
}

function themeCard(): HTMLElement {
  const choices = el('div', { class: 'theme-options', role: 'group', 'aria-label': '外观主题' })
  for (const theme of MOBILE_THEMES) {
    choices.append(el('button', { type: 'button', 'data-choice': theme, 'aria-pressed': String(mobileTheme === theme), onClick: () => {
      if (mobileTheme === theme) return
      applyTheme(theme)
      for (const node of choices.querySelectorAll('button')) {
        node.setAttribute('aria-pressed', String(node.dataset.choice === theme))
      }
      void writeTheme(theme).catch(error => {
        reportConfigReadError(error)
        toast('外观预览已应用，但未能保存', 'error')
      })
    } }, el('span', { class: 'theme-swatch', 'aria-hidden': 'true' }), THEME_LABELS[theme]))
  }
  return el('section', { class: 'card' }, el('h2', { text: '外观' }), choices)
}

function topbar(title: string, subtitle: string, actions: Child[], back?: HTMLButtonElement): HTMLElement {
  return el('div', { class: 'topbar' + (back ? ' has-back' : '') },
    back ?? null,
    el('div', { class: 'title' },
      el('strong', { text: title }),
      el('span', { text: subtitle }),
    ),
    el('div', { class: 'actions' }, ...actions),
  )
}

function backChevron(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M14.5 5.5 8 12l6.5 6.5')
  svg.append(path)
  return svg
}

/** iOS 导航栏返回：左侧圆形 chevron，语义标签「返回」。 */
function backButton(to: View | (() => void)): HTMLButtonElement {
  const node = button('', typeof to === 'function' ? to : () => { state.view = to; render() }, { class: 'back-button', 'aria-label': '返回' })
  node.append(backChevron())
  return node
}

/* ------------------------------ 启动 ------------------------------ */

export async function start(): Promise<void> {
  state.view = 'booting'
  configReadError = ''
  applyTheme(readTheme())
  state.online = navigator.onLine
  render()
  void setupChrome()
  const stored = await readConfig()
  if (stored.status === 'error') {
    configReadError = stored.error.message
    render()
    return
  }
  const config = stored.status === 'ok' ? stored.config : null
  applyTheme(readTheme(config))
  state.config = config
  state.account = config?.account && config.account.expiresAt > Date.now() ? config.account : null
  function onNetwork(online: boolean): void {
    const reconnected = online && !state.online
    state.online = online
    if (!online) {
      connectivity.invalidate()
      state.statusText = '连接状态未确认。'
    }
    redrawConnectivity()
    if (reconnected && state.api && !appLocked()) {
      void refreshDevices()
      void recoverPendingInputs(state.api)
      void loadBoard(true)
    }
  }
  let networkDispose: (() => void) | undefined
  let networkGeneration = 0
  const onForeground = () => {
    if (document.hidden || connectivityPaused) return
    if (showingConnectivity()) {
      redrawConnectivity()
      void refreshDevices()
    }
    scheduleBoardRefresh()
  }
  const bindNetwork = async () => {
    const generation = ++networkGeneration
    document.addEventListener('visibilitychange', onForeground)
    const dispose = await watchNetwork(online => {
      if (generation === networkGeneration) onNetwork(online)
    })
    if (generation === networkGeneration) networkDispose = dispose
    else dispose()
  }
  window.addEventListener('pagehide', () => {
    networkGeneration++
    networkDispose?.()
    networkDispose = undefined
    document.removeEventListener('visibilitychange', onForeground)
    connectivityPaused = true
    connectivity.invalidate()
    clearTimeout(connectivityExpiry)
    clearTimeout(connectivityRefresh)
  })
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return
    connectivityPaused = false
    const wasOnline = state.online
    onNetwork(navigator.onLine)
    void bindNetwork()
    if (wasOnline && state.online) void refreshDevices()
  })
  await bindNetwork()
  if (!config) {
    state.view = 'setup'
    render()
  } else if (config.lock) {
    state.view = 'lock'
    render()
  } else {
    await enterApp()
  }
  await loadBridgeDevice()
  void watchForegroundLock()
  // 局域网工作台默认关闭，也不盖在锁屏上。
  if (config?.lanBridge && !config.lock && state.view !== 'lock') {
    setTimeout(() => { if (hasStoredBridge()) openDshWorkbench() }, 250)
  }
  await watchDeepLinks((url) => { void handleDeepLink(url) })
  await registerBackButton()
  window.addEventListener('pageshow', (event) => { if (event.persisted) void registerBackButton() })
}

async function registerBackButton(): Promise<void> {
  disposeBack?.()
  disposeBack = await watchBackButton(() => {
    if (appConfirmation) { appConfirmation.cancel(); return true }
    if (composerSheet) { composerSheet.close(); return true }
    if (chatSheet) { chatSheet.close(); return true }
    if (state.view === 'groupRoom' || state.view === 'groupNew') { returnToGroups(); return true }
    const ticketBack = ticketBackAction(Boolean(rootNode().querySelector('.ticket-sheet[open]')), state.view === 'ticketGroup')
    if (ticketBack === 'close-sheet') { closeTicketSheet(); return true }
    if (ticketBack === 'return-to-ticket') { returnToTicket(); return true }
    const parent: Partial<Record<View, View>> = {
      settings: 'home', sessions: 'home', session: 'sessions', controls: 'session', groups: groupsParent, memory: 'home',
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
  closeMainStream()
  subscriptionId = null
  state.api = new MarshalApi(config)
  roster = []
  state.session = null
  sessionGeneration++
  olderRequest = null
  pendingInputs = createPendingInputs()
  state.devices = []
  state.sessions = []
  state.deviceId = null
  hubUnavailable = false
  connectivity.stream('reset')
  resetTicketBoard()
  agentsSegment = 'members'
  boardTasks = []
  boardRevisions = {}
  boardReceipts = []
  memoryEntries = []
  memoryMember = null
  memoryLayer = 'all'
  memoryMode = 'galaxy'
  selectedMemory = ''
  Object.assign(galaxyCamera, initialGalaxyCamera())
  state.view = 'board'
  state.statusText = '正在连接…'
  render()
  await Promise.all([refreshDevices(), loadBoard()])
  void recoverPendingInputs(state.api)
  await openStream()
  void registerDevicePush()
}

async function registerDevicePush(): Promise<void> {
  const api = phoneApi()
  if (!api) return
  try {
    const plugin = await import('marshal-stream')
    const events = plugin.MarshalStream as unknown as { addListener(name: string, cb: () => void): Promise<unknown>; pushToken?: () => Promise<{ ok?: boolean; provider?: string; token?: string; liveToken?: string; liveTokens?: Record<string, string> }> }
    if (!pushListening) {
      pushListening = true
      await events.addListener('pushToken', () => { void registerDevicePush() })
      await events.addListener('liveToken', () => { void registerDevicePush() })
    }
    const token = await events.pushToken?.()
    if (!token || token.ok !== true || !token.token || (token.provider !== 'apns' && token.provider !== 'fcm' && token.provider !== 'huawei')) return
    await api.registerPush(token.provider, token.token, token.liveToken, token.provider === 'apns' ? token.liveTokens ?? {} : undefined)
  } catch { /* 浏览器预览没有推送插件 */ }
}

let pushListening = false

async function showLive(title: string, phase: string, session = phase, end = false): Promise<void> {
  try {
    const plugin = await import('marshal-stream')
    const native = plugin.MarshalStream as unknown as { startLiveActivity?: (options: { title: string; phase: string; session: string; end: boolean }) => Promise<void> }
    await native.startLiveActivity?.({ title, phase, session, end })
  } catch { /* 浏览器没有 Live Activity */ }
}

let mainStreamGeneration = 0
function closeMainStream(): void {
  mainStreamGeneration++
  stream?.close()
  stream = null
  connectivity.stream('close')
}

async function openStream(): Promise<void> {
  const api = state.api
  if (!api || !api.token) return
  const generation = ++mainStreamGeneration
  const current = () => state.api === api && generation === mainStreamGeneration
  const onError = (message: string) => {
    if (!current()) return
    connectivity.stream('error')
    state.statusText = '事件流断开：' + message
    redrawConnectivity()
  }
  try {
    const opened = await openEventStream({
      url: api.streamUrl(),
      token: api.token,
      onFrame: (frame) => { if (current()) void onFrame(frame) },
      onOpen: () => {
        if (!current()) return
        connectivity.stream('open')
        state.statusText = '正在检查连接状态…'
        redrawConnectivity()
        void refreshDevices()
      },
      onError,
    })
    if (current()) stream = opened
    else opened.close()
  } catch {
    onError('未能开启事件流')
  }
}

const connectivity = createConnectivity()
let connectivityExpiry: ReturnType<typeof setTimeout> | undefined
let connectivityRefresh: ReturnType<typeof setTimeout> | undefined
let connectivityPaused = false
let privacyConfirming = false
let sliderDragging = false
function showingConnectivity(): boolean {
  return state.view === 'home' || (state.view === 'agents' && agentsSegment === 'members')
}

function redrawConnectivity(): void {
  if (connectivityPaused) return
  if (showingConnectivity()) {
    if (state.view === 'home' && state.config && (privacyConfirming || sliderDragging || document.activeElement?.id === 'summary-cap')) {
      const card = rootNode().querySelector<HTMLElement>('#node-topology-card')
      if (card) {
        card.replaceWith(nodeTopologyCard(state.config))
        scheduleConnectivityExpiry()
        refreshTabBar()
        return
      }
    }
    render()
    const memberStatus = activeMemberStatus
    if (memberStatus) memberStatus.node.textContent = memberHostText(memberStatus.member)
  } else if (state.view === 'board') { refreshTicketList(); updateTicketSheet(); refreshTabBar() }
  else refreshTabBar()
}

function scheduleConnectivityExpiry(): void {
  clearTimeout(connectivityExpiry)
  clearTimeout(connectivityRefresh)
  if (!showingConnectivity() || connectivityPaused || document.hidden) return
  const now = Date.now()
  const { expiry } = connectivity.snapshot(now)
  if (Number.isFinite(expiry)) {
    const remaining = Math.max(0, expiry - now)
    connectivityExpiry = setTimeout(redrawConnectivity, remaining)
    if (state.online && state.api) {
      const refreshDelay = Math.max(1_000, Math.min(30_000, remaining - 5_000))
      connectivityRefresh = setTimeout(() => {
        if (showingConnectivity() && !connectivityPaused && !document.hidden && state.online && state.api) {
          void refreshDevices()
        }
      }, refreshDelay)
    }
  }
}

async function refreshDevices(): Promise<void> {
  const api = state.api
  if (!api || !state.online || connectivityPaused) return
  const probe = connectivity.beginProbe()
  const result = await api.devices()
  if (state.api !== api || !connectivity.accepts(probe)) return
  if (!result.ok) {
    connectivity.invalidate()
    hubUnavailable = true
    state.statusText = result.message
    if (result.error === 'unauthorized') { state.view = 'setup'; render(); return }
    redrawConnectivity()
    return
  }
  hubUnavailable = false
  connectivity.devices(Date.now())
  state.devices = result.data
  state.statusText = ''
  redrawConnectivity()
  const named = await api.roster()
  if (state.api !== api || !connectivity.accepts(probe)) return
  roster = named.ok ? named.data : roster
  connectivity.roster(named.ok ? Date.now() : null)
  if (state.view === 'sessions' && !state.deviceId) {
    const first = state.devices.find((entry) => !entry.stale)
    if (first) { void openDevice(first); return }
    render()
    return
  }
  redrawConnectivity()
}

async function openDevice(device: DeviceRow): Promise<void> {
  const api = state.api
  if (!api) return
  sessionCategory = 'single'
  state.deviceId = device.id
  state.sessions = []
  state.view = 'sessions'
  state.statusText = '读取会话…'
  render()
  const result = await api.sessions(device.id)
  if (state.api !== api || state.deviceId !== device.id) return
  if (result.ok) state.sessions = result.data
  if (state.view === 'sessions') {
    state.statusText = result.ok ? '' : result.message
    render()
  }
}

/* ------------------------------ 会话 ------------------------------ */

let historyStatus: HistoryStatus = 'loading'
let historyItemCount = 0
let historyError = ''
let historyRequest = 0
let olderRequest: object | null = null
let sessionGeneration = 0
let renderedSession = -1
let reachedHistoryStart = false
let historyPageNotice = ''
const visitedHistoryCursors = new Set<string>()
const transcriptChunks = new Map<string, Map<number, string>>()
const expandedMessages = new Set<string>()
const historyScrollPositions = new WeakMap<HTMLElement, number>()
let composerSheet: { session: number; close: () => void } | null = null
let receivedLiveCapability = false
let receivedLiveRunning = false

async function openSession(deviceId: string, row: SessionRow): Promise<void> {
  const api = state.api
  if (!api) return
  const previous = state.session
  if (previous) {
    void api.unsubscribe(targetOf(previous), subscriptionId)
    void api.unwatchSession(targetOf(previous))
  }
  const opened = state.session = { ...row, deviceId }
  state.capability = row.capability
  state.running = row.running
  receivedLiveCapability = false
  receivedLiveRunning = false
  state.messages = []
  state.historyCursor = null
  historyStatus = 'loading'
  historyItemCount = 0
  historyRequest++
  sessionGeneration++
  olderRequest = null
  reachedHistoryStart = false
  historyPageNotice = ''
  visitedHistoryCursors.clear()
  transcriptChunks.clear()
  expandedMessages.clear()
  state.controls = null
  state.modelChoice = ''
  state.effortChoice = ''
  state.attachments = []
  state.uploading = false
  state.busy = false
  lastSeq = 0
  lastNodeEpoch = undefined
  draft = ''
  state.view = 'session'
  state.statusText = '正在订阅…'
  render()

  const target = targetOf(state.session)
  void api.watchSession(target)
  const subscribed = await api.subscribe(target)
  if (state.api !== api || state.session !== opened) {
    if (subscribed.ok) void api.unsubscribe(target, subscribed.data)
    return
  }
  subscriptionId = subscribed.ok ? subscribed.data : null

  const [, , controls] = await Promise.all([
    reloadTranscript(),
    loadPendingInputs(api, target),
    api.controls(target),
  ])
  if (state.api !== api || state.session !== opened) return
  if (controls.ok) {
    state.controls = controls.data
  }
  // 能力文档以 sessions 列表为准，读一次刷新。
  const sessions = await api.sessions(deviceId)
  if (state.api !== api || state.session !== opened) return
  if (sessions.ok) {
    if (state.deviceId === deviceId) state.sessions = sessions.data
    const fresh = sessions.data.find((item) => item.agent === row.agent && item.sessionId === row.sessionId)
    if (fresh) {
      state.session = { ...fresh, deviceId: row.deviceId }
      if (!receivedLiveCapability) state.capability = fresh.capability
      if (!receivedLiveRunning) state.running = fresh.running
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
  const stableId = payload.itemId ?? (item.kind.startsWith('tool.') ? payload.callId : payload.turnId)
  const id = typeof stableId === 'string' ? stableId : 'seq-' + String(item.seq ?? Math.random())
  const text = typeof payload.text === 'string' ? payload.text : ''
  switch (item.kind) {
    case 'user.message': return { id, role: 'user', text, open: false, at }
    case 'message.delta': return text ? { id, role: 'assistant', text, open: false, at } : null
    case 'message.completed': return text ? { id, role: 'assistant', text, open: false, at, completed: true } : null
    case 'reasoning.delta': return text ? { id, role: 'reason', text, open: false, at } : null
    case 'tool.started': return { id, role: 'tool', text: '开始：' + String(payload.name ?? payload.tool ?? '工具'), toolTitle: String(payload.name ?? payload.tool ?? '工具调用'), open: false, at }
    case 'tool.completed': return { id, role: 'tool', text: (payload.isError === true || payload.status === 'error' ? '失败：' : '完成：') + String(payload.content ?? '').slice(0, 400), toolTitle: String(payload.name ?? payload.tool ?? '工具结果'), open: false, at, completed: true }
    case 'turn.completed': return { id, role: 'system', text: '回合完成（' + String(payload.state ?? 'completed') + '）', open: false, at }
    default: return null
  }
}

function historyMessages(items: Parameters<typeof historyToMessage>[0][]): Message[] {
  const messages = new Map<string, Message>()
  for (const item of items) {
    const message = historyToMessage(item)
    if (!message) continue
    const key = transcriptMessageKey(message)
    const previous = messages.get(key)
    if (previous && (item.kind === 'reasoning.delta' || item.kind === 'message.delta'
      || ((item.kind === 'user.message' || item.kind === 'message.completed') && Number(item.payload?.chunkIndex) > 0))) {
      previous.text += message.text
      if (message.role === 'reason' && typeof item.ts === 'number') previous.endedAt = item.ts
    } else {
      if (previous) message.at = previous.at
      if (previous?.toolTitle && message.toolTitle === '工具结果') message.toolTitle = previous.toolTitle
      messages.set(key, message)
    }
  }
  return [...messages.values()]
}

async function loadPendingInputs(api: MarshalApi, target: Target, isCurrent?: () => boolean): Promise<boolean> {
  const commit = pendingInputs.beginSnapshot(target)
  const result = await api.inputs(target)
  if (state.api !== api || (isCurrent && !isCurrent())) return false
  commit(result.ok ? result.data : undefined)
  refreshPendingInputs(target)
  return result.ok || result.error !== 'unauthorized'
}

function refreshPendingInputs(target?: Target): void {
  if (target && state.view === 'session' && state.session && sameTarget(target, state.session)) render()
  else refreshTabBar()
}

async function recoverPendingInputs(api: MarshalApi): Promise<void> {
  const recovery = ++inputRecovery
  const current = () => state.api === api && recovery === inputRecovery && !appLocked()
  const known = pendingInputs.knownTargets()
  const result = await api.sessions()
  if (!current() || !result.ok) return
  const targets = new Set(result.data.map(inputTargetKey))
  for (const target of known) {
    if (!targets.has(inputTargetKey(target))) {
      pendingInputs.remove(target)
      refreshPendingInputs(target)
    }
  }
  // Limit simultaneous RPCs even on installations with a large session index.
  // Older Hubs accept only operator credentials on /inputs. Never retry with
  // another credential or clear the live cache on denial.
  let next = 0
  if (api.token.startsWith('mph1.') && result.data.length) {
    if (!await loadPendingInputs(api, targetOf(result.data[next++]), current)) return
  }
  await Promise.all(Array.from({ length: Math.min(4, result.data.length - next) }, async () => {
    while (current() && next < result.data.length) await loadPendingInputs(api, targetOf(result.data[next++]), current)
  }))
}

async function onFrame(frame: StreamFrame): Promise<void> {
  if (frame.event === 'reset') {
    if (state.api && !appLocked()) void recoverPendingInputs(state.api)
    if (state.view === 'session') void reloadTranscript()
    await refreshDevices()
    return
  }
  const event = frame.data as Record<string, unknown> | null
  if (!event || typeof event !== 'object') return
  if (typeof event.deviceId !== 'string') return
  const target = state.session ? targetOf(state.session) : null
  const kind = typeof event.kind === 'string' ? event.kind : ''
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>

  const eventTarget = inputTarget(event)
  if (eventTarget && kind === 'session.removed') {
    pendingInputs.remove(eventTarget)
    refreshPendingInputs(eventTarget)
  }
  if (eventTarget && (kind === 'input.requested' || kind === 'input.resolved')) {
    const requestId = payload.requestId
    if (typeof requestId !== 'string' || !requestId) return
    const card = kind === 'input.requested' ? parseCards([payload])[0] : undefined
    if (kind === 'input.requested' && !card) return
    pendingInputs.update(eventTarget, requestId, card)
    if (target && sameTarget(target, eventTarget)) {
      if (card?.approval) void showLive('待审批', 'approval', eventTarget.sessionId)
      if (!card) {
        const phase = livePhaseAfterApproval(state.running)
        void showLive(phase.title, phase.phase, eventTarget.sessionId, phase.end)
      }
    }
    refreshPendingInputs(eventTarget)
    return
  }
  if (kind === 'session.updated' || kind === 'session.removed') {
    if (state.view === 'sessions' && state.deviceId === event.deviceId) {
      const api = state.api
      const deviceId = state.deviceId
      if (api && deviceId) {
        const result = await api.sessions(deviceId)
        if (state.api !== api || state.deviceId !== deviceId || state.view !== 'sessions') return
        if (result.ok) { state.sessions = result.data; render() }
      }
    }
    return
  }
  if (!target) return
  if (event.deviceId !== target.deviceId || event.agent !== target.agent || event.sessionId !== target.sessionId) return
  if (event.nodeEpoch !== lastNodeEpoch) {
    lastNodeEpoch = event.nodeEpoch
    lastSeq = 0
    transcriptChunks.clear()
  }
  const seq = acceptEventSeq(lastSeq, event.seq)
  if (!seq.accept) return
  lastSeq = seq.lastSeq
  const ts = typeof event.ts === 'number' ? event.ts : undefined
  const transcriptEvent = { kind, payload, ts, seq: typeof event.seq === 'number' ? event.seq : undefined }
  if ((kind === 'user.message' || kind === 'message.completed')
    && typeof payload.itemId === 'string' && typeof payload.text === 'string'
    && typeof payload.chunkCount === 'number' && payload.chunkCount > 1
    && typeof payload.chunkIndex === 'number' && payload.chunkIndex >= 0 && payload.chunkIndex < payload.chunkCount) {
    const key = `${kind}:${payload.itemId}`
    const parts = payload.chunkIndex === 0 ? new Map<number, string>() : transcriptChunks.get(key)
    if (!parts) return
    parts.set(payload.chunkIndex, payload.text)
    if (parts.size < payload.chunkCount) { transcriptChunks.set(key, parts); return }
    transcriptChunks.delete(key)
    transcriptEvent.payload = { ...payload, text: [...parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part).join('') }
  }
  switch (kind) {
    case 'capability.changed':
      receivedLiveCapability = true
      state.capability = payload as unknown as Capability
      if (state.view === 'session') render()
      return
    case 'message.delta':
    case 'reasoning.delta': {
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (!text) return
      const id = typeof payload.itemId === 'string' ? payload.itemId : 'seq-' + String(event.seq ?? 'd')
      appendDelta(id, kind === 'reasoning.delta' ? 'reason' : 'assistant', text, ts ?? Date.now())
      return
    }
    case 'message.completed': {
      const message = historyToMessage(transcriptEvent)
      if (message) {
        const current = state.messages.find(entry => transcriptMessageKey(entry) === transcriptMessageKey(message))
        message.completed = true
        if (current) Object.assign(current, message, { at: current.at, snapshotText: undefined, streamText: undefined })
        else state.messages = mergeTranscriptSnapshot([message], state.messages)
      }
      closeOpenMessages()
      if (state.view === 'session') render()
      return
    }
    case 'turn.started':
    case 'turn.completed': {
      receivedLiveRunning = true
      const running = state.running = kind === 'turn.started'
      if (!running) closeOpenMessages()
      void showLive(running ? '运行中' : '已结束', running ? 'run-start' : 'run-finish', target.sessionId ?? 'run', !running)
      if (state.view === 'session') render()
      return
    }
    case 'tool.started':
    case 'tool.completed':
    case 'user.message': {
      const message = historyToMessage(transcriptEvent)
      if (!message || !message.text) return
      if (message.role === 'tool') {
        const current = state.messages.find(entry => transcriptMessageKey(entry) === transcriptMessageKey(message))
        if (current) {
          if (message.completed || !current.completed) current.text = message.text
          if (message.completed) current.completed = true
          if (message.toolTitle !== '工具结果') current.toolTitle = message.toolTitle
        } else state.messages = mergeTranscriptSnapshot([message], state.messages, { liveEvent: true })
      } else state.messages = mergeTranscriptSnapshot([message], state.messages, { liveEvent: true })
      if (state.view === 'session') render()
      return
    }
    default: return
  }
}

function appendDelta(id: string, role: Role, text: string, at: number): void {
  const existing = state.messages.find((m) => m.id === id && m.role === role)
  if (existing) {
    if (existing.completed) return
    Object.assign(existing, appendTranscriptDelta(existing, text))
  } else {
    state.messages = mergeTranscriptSnapshot([{ id, role, text, open: true, at, streamText: text }], state.messages)
  }
  if (state.view !== 'session') return
  const transcript = rootNode().querySelector<HTMLElement>('.transcript')
  const key = transcriptMessageKey({ id, role })
  const node = existing && transcript && [...transcript.querySelectorAll<HTMLElement>('[data-msg]')]
    .find(entry => entry.dataset.msg === key)
  const body = node && node.querySelector('.msg-body')
  if (body && existing && transcript && node?.classList.contains('streaming')) {
    const follow = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 24
    body.textContent = existing.text
    if (follow) transcript.scrollTop = transcript.scrollHeight
  } else render()
}

function closeOpenMessages(): void {
  const now = Date.now()
  for (const message of state.messages) {
    if (message.open) message.endedAt = now
    message.open = false
  }
}

async function reloadTranscript(): Promise<void> {
  const api = state.api
  const session = state.session
  if (!api || !session) return
  const request = ++historyRequest
  const generation = sessionGeneration
  olderRequest = null
  historyStatus = 'loading'
  state.statusText = ''
  if (state.view === 'session') render()
  const result = await api.history(targetOf(session), 40)
  if (request !== historyRequest || generation !== sessionGeneration || state.api !== api) return
  if (result.ok) {
    historyItemCount = result.data.items.length
    state.messages = mergeTranscriptSnapshot(historyMessages(result.data.items), state.messages)
    state.historyCursor = result.data.nextCursor ?? null
    visitedHistoryCursors.clear()
    historyPageNotice = ''
    reachedHistoryStart = result.data.completeness === 'complete' && !state.historyCursor && state.messages.length > 0
  }
  const unconfirmedEmpty = result.ok && state.messages.length === 0
    && isUnconfirmedEmpty(result.data.completeness, historyItemCount, Boolean(state.historyCursor))
  historyStatus = result.ok && !unconfirmedEmpty ? 'ready' : 'error'
  historyError = !result.ok ? result.message : unconfirmedEmpty ? '暂时无法确认会话历史。' : ''
  if (state.view === 'session') render()
}

function bindHistoryScroll(transcript: HTMLElement): void {
  historyScrollPositions.set(transcript, transcript.scrollTop)
  let touchY: number | undefined
  const check = (gesture: { prevScrollTop?: number; deltaY?: number; touchPullDy?: number }) => {
    if (!transcript.isConnected || !shouldTriggerOlderHistory({ ...gesture, scrollTop: transcript.scrollTop,
      loading: olderRequest !== null || historyStatus === 'loading', hasCursor: Boolean(state.historyCursor) })) return
    touchY = undefined
    void loadOlder()
  }
  transcript.addEventListener('scroll', () => {
    const prevScrollTop = historyScrollPositions.get(transcript)
    historyScrollPositions.set(transcript, transcript.scrollTop)
    check({ prevScrollTop })
  }, { passive: true })
  transcript.addEventListener('wheel', event => check({ deltaY: event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? transcript.clientHeight : 1) }), { passive: true })
  transcript.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY }, { passive: true })
  transcript.addEventListener('touchmove', event => {
    if (touchY !== undefined && event.touches.length === 1) check({ touchPullDy: event.touches[0]!.clientY - touchY })
  }, { passive: true })
}

async function loadOlder(): Promise<void> {
  const api = state.api
  const session = state.session
  const cursor = state.historyCursor
  if (!api || !session || !cursor || olderRequest || historyStatus === 'loading' || state.view !== 'session') return
  const request = olderRequest = {}
  const generation = sessionGeneration
  const current = () => olderRequest === request && generation === sessionGeneration && state.api === api
  const indicator = rootNode().querySelector('.history-indicator')
  if (indicator) indicator.textContent = '正在同步更早对话…'
  let inserted = false
  try {
    const result = await api.history(targetOf(session), 40, cursor)
    if (!current()) return
    if (!result.ok) {
      if (state.view === 'session') toast(result.message, 'error')
      return
    }
    const older = historyMessages(result.data.items)
    state.messages = mergeTranscriptSnapshot(older, state.messages, { prepend: true })
    const progress = historyPageProgress(cursor, result.data.nextCursor, result.data.completeness, visitedHistoryCursors)
    visitedHistoryCursors.add(cursor)
    state.historyCursor = progress.cursor
    reachedHistoryStart = progress.reachedStart
    historyPageNotice = progress.notice
    inserted = true
  } finally {
    if (current()) {
      olderRequest = null
      if (state.view === 'session') render(inserted)
    }
  }
}

async function sendPrompt(reuseKey?: string): Promise<void> {
  const api = state.api
  const session = state.session
  if (!api || !session || state.busy) return
  const generation = sessionGeneration
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
  const pending: Message = {
    id: 'local-' + newIdempotencyKey(), role: 'user', text, open: false, at: Date.now(),
    retryKey: reuseKey || newIdempotencyKey(),
  }
  draft = ''
  state.busy = true
  state.messages.push(pending)
  render()
  const result = await api.command('prompt', targetOf(session), args, pending.retryKey)
  if (generation !== sessionGeneration || state.api !== api) return
  state.busy = false
  const entry = state.messages.find(message => message.id === pending.id)
  // A remote echo (live or snapshot) confirms the send even if its RPC failed.
  if (!result.ok && entry) {
    entry.failed = true
    if (!draft) draft = text
    toast(result.message, 'error')
    render()
    return
  }
  if (entry) { entry.failed = false; entry.retryKey = undefined }
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
  const generation = sessionGeneration
  const current = () => generation === sessionGeneration && state.api === api
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
      if (!current()) return
      const result = await api.upload(targetOf(session), { name: file.name, mime, bytes })
      if (!current()) return
      if (result.ok) {
        updateAttachment(key, { status: 'ready', attachmentId: result.data.attachmentId })
      } else {
        updateAttachment(key, { status: 'error', error: result.message })
        toast(result.message, 'error')
      }
    } catch (error) {
      if (!current()) return
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
  return Object.hasOwn(EFFORT_META, effort) ? EFFORT_META[effort]!.label : effort
}

async function refreshControls(notify = false): Promise<void> {
  const api = state.api
  const session = state.session
  if (!api || !session) return
  const generation = sessionGeneration
  const result = await api.controls(targetOf(session))
  if (generation !== sessionGeneration || state.api !== api) return
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
  if (state.api !== api) return
  pendingInputs.update(targetOf(session), card.requestId)
  toast('已忽略该请求')
  refreshPendingInputs(targetOf(session))
}

let answering = false
async function answerCard(card: InputCard, answers: Array<{ id: string; selectedOptionIds: string[]; text?: string }>): Promise<void> {
  const api = state.api
  const session = state.session
  if (!api || !session || answering) return
  answering = true
  const result = await api.command('answer', targetOf(session), { requestId: card.requestId, answers })
  answering = false
  if (!result.ok) { toast(result.message, 'error'); return }
  if (state.api !== api) return
  pendingInputs.update(targetOf(session), card.requestId)
  toast('已提交')
  refreshPendingInputs(targetOf(session))
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
      el('div', { class: 'setup-pair-icon' }, logoMark()),
      el('h2', { text: '连接电脑' }),
      el('p', { class: 'empty', text: '用摄像头扫电脑「跨设备」页的二维码，自动完成配对。' }),
      button('扫码配对', scanPairing, { class: 'primary block scan-button' }),
      el('p', { class: 'notice', text: '扫电脑上正在倒计时的配对码。码里只有 Hub 地址。' }),
      ...(state.config?.lanBridge && hasStoredBridge() ? [button('打开局域网工作台', openDshWorkbench, { class: 'block' })] : []),
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
  const patch = {
    version: CONFIG_VERSION,
    hubUrl: parsed.hubUrl,
    token: parsed.token,
    ...(hubChanged ? { account: null } : {}),
  }
  let config: MarshalConfig
  try {
    config = await saveConfigPatch(patch, makeConfig({ hubUrl: parsed.hubUrl }))
  } catch (error) {
    result.textContent = '保存失败：' + (error instanceof Error ? error.message : '未知错误')
    return
  }
  adoptConfig(config)
  state.account = config.account ?? null
  await enterApp()
}

function openDshWorkbench(): void {
  openBridgeWorkbench({
    onClose: () => { /* 覆盖层自己移除；底层保持原界面 */ },
    requestUnpair: () => confirmInApp('解除配对', '解除这台手机的 DSH 配对？', '解除'),
    onOpenHubGroups: () => {
      if (!state.account) { toast('请先配对 Hub 群聊账号', 'error'); return }
      openGroups('home')
    },
    onHubPairLink: (raw) => { void handleDeepLink(raw) },
    onUnifiedPairLink: (raw) => { void handleDeepLink(raw) },
  })
}

async function handleScannedPairing(text: string): Promise<void> {
  const raw = text.trim()
  if (!raw || appLocked()) return
  if (linkCarriesSecret(raw) || parseUnifiedPairing(raw)) {
    toast('这个码里有旧令牌，已忽略。请扫电脑上新的配对码。', 'error')
    return
  }
  const kind = classifyPairing(raw)
  if (kind === 'hub') { await handleDeepLink(raw); return }
  if (kind !== 'bridge') {
    toast('这个二维码不是配对链接，请扫「跨设备」页的码', 'error')
    return
  }
  if (!state.config?.lanBridge) {
    toast('局域网工作台默认关闭。要连本机电脑，先到设置里打开。', 'error')
    return
  }
  try {
    const payload = parsePairPayload(raw)
    const device = await pairBridge(payload)
    await saveBridgeDevice(device)
    if (!appLocked()) openDshWorkbench()
  } catch (error) {
    toast(error instanceof Error ? error.message : '配对失败', 'error')
  }
}

function scanPairing(): void {
  openQrScanner({
    onResult: (text) => { void handleScannedPairing(text) },
  })
}

function topologyNode(title: string, protocol: string, status: string): HTMLElement {
  return el('li', {}, el('strong', { text: title }), el('span', { text: protocol }), el('span', { text: status }))
}

function appLockRow(config: MarshalConfig): HTMLElement {
  return config.lock
    ? el('div', { class: 'row-between' },
      el('div', { class: 'label' }, el('strong', { text: '应用锁' }), el('span', { text: '已开启，启动需 6 位 PIN' })),
      button('关闭', () => { disableLock() }, { class: 'icon-button danger' }))
    : el('div', { class: 'row-between' },
      el('div', { class: 'label' }, el('strong', { text: '应用锁' }), el('span', { text: '开启后每次启动要输 6 位 PIN' })),
      button('开启', () => { openLockSetup() }, { class: 'icon-button' }))
}

function nodeSecurityCard(config: MarshalConfig): HTMLElement {
  const metadata = config.privacyMode === 'metadata'
  if (metadata) privacyConfirming = false
  const status = el('p', { class: 'node-caption', role: 'status' })
  const cancel = button('取消', () => {
    privacyConfirming = false; cancel.hidden = true; tighten.textContent = '收紧为仅元数据'; tighten.focus()
  }, { hidden: !privacyConfirming })
  const tighten = button(privacyConfirming ? '再次点按确认收紧' : '收紧为仅元数据', () => {
    if (!privacyConfirming) {
      privacyConfirming = true; cancel.hidden = false; tighten.textContent = '再次点按确认收紧'
      return
    }
    tighten.disabled = true; cancel.disabled = true
    void writeNodePreference({ tightenPrivacy: true }).then(saved => {
      privacyConfirming = false
      if (!state.config) return
      state.config = { ...state.config, privacyMode: saved.privacyMode }
      clearConfigReadError()
      memoryEntries = memoryEntries.map(maskMemoryNode)
      if (state.view === 'home' || showingMemory()) render()
    }).catch(error => {
      reportConfigReadError(error)
      tighten.disabled = false; cancel.disabled = false
      status.textContent = '未能保存隐私偏好，请重试。'
    })
  })
  const capNode = renderSummaryCap(summaryCap, config.dailySummaryCapK, value => { sliderDragging = false; void saveSummaryCap(value) })
  const slider = capNode.querySelector<HTMLInputElement>('#summary-cap')
  if (slider) {
    slider.addEventListener('pointerdown', () => { sliderDragging = true })
    slider.addEventListener('touchstart', () => { sliderDragging = true }, { passive: true })
    const finishDrag = () => { sliderDragging = false }
    slider.addEventListener('pointerup', finishDrag)
    slider.addEventListener('pointercancel', finishDrag)
    slider.addEventListener('touchend', finishDrag)
    slider.addEventListener('blur', finishDrag)
  }
  return el('section', { class: 'card' }, el('h2', { text: '安全与隐私边界' }), appLockRow(config),
    el('div', { class: 'node-preference' },
      el('strong', { text: metadata ? '本机记忆显示：仅元数据' : '本机记忆显示：正文（如已授权）' }),
      el('p', { class: 'node-caption', text: '手机上只能单向收紧，收紧后不显示记忆标题和正文。真实内容授权以电脑端为准，此处不会修改 Hub 权限。' }),
      metadata ? null : el('div', { class: 'node-pref-actions' }, tighten, cancel)),
    capNode, status)
}

const summaryCap = createSummaryCapDraft()

async function saveSummaryCap(value: number): Promise<void> {
  let saved: MarshalConfig | undefined
  const latest = await summaryCap.save(value, async cap => {
    saved = await writeNodePreference({ dailySummaryCapK: cap })
  }, rememberConfigReadError)
  if (!latest || !state.config) return
  if (saved) {
    state.config = { ...state.config, dailySummaryCapK: saved.dailySummaryCapK,
      privacyMode: saved.privacyMode === 'metadata' ? 'metadata' : state.config.privacyMode }
    if (state.config.privacyMode === 'metadata') memoryEntries = memoryEntries.map(maskMemoryNode)
  }
  if (state.view === 'home' || configReadError || (showingMemory() && saved?.privacyMode === 'metadata')) render()
}

let configReadError = ''
function clearConfigReadError(): void {
  configReadError = ''
  const banner = rootNode().querySelector<HTMLElement>('#config-read-error')
  if (banner) banner.hidden = true
}

function rememberConfigReadError(error: unknown): boolean {
  if (!(error instanceof ConfigReadError)) return false
  configReadError = error.message
  memoryEntries = memoryEntries.map(maskMemoryNode)
  return true
}

function reportConfigReadError(error: unknown): void {
  if (!rememberConfigReadError(error)) return
  if (showingMemory()) render()
  else {
    const banner = rootNode().querySelector<HTMLElement>('#config-read-error')
    if (banner) { banner.textContent = configReadError; banner.hidden = false }
  }
}

async function saveConfigPatch(patch: Partial<MarshalConfig>, initialize?: MarshalConfig): Promise<MarshalConfig> {
  try {
    return await updateConfig(current => {
      const base = current ?? initialize
      if (!base) throw new Error('未找到本机配置')
      return { ...base, ...patch, updatedAt: Date.now() }
    })
  } catch (error) {
    reportConfigReadError(error)
    throw error
  }
}

function adoptConfig(next: MarshalConfig): void {
  clearConfigReadError()
  state.config = { ...next,
    privacyMode: state.config?.privacyMode === 'metadata' ? 'metadata' : next.privacyMode }
  if (state.config.privacyMode === 'metadata') {
    memoryEntries = memoryEntries.map(maskMemoryNode)
    if (showingMemory()) render()
  }
}

function hostStatusLabel(hubReachable: boolean, device: DeviceRow): string {
  if (!hubReachable) return '状态未确认'
  if (device.syncing) return '同步中'
  return device.stale ? '同步滞后' : '在线'
}

function nodeTopologyCard(config: MarshalConfig): HTMLElement {
  const hubReachable = state.online && connectivity.snapshot(Date.now()).hub
  const syncingCount = state.devices.filter((device) => device.syncing).length
  const hostSummary = !hubReachable
    ? '状态未确认'
    : `${state.devices.length} 台已连${syncingCount > 0 ? `（${syncingCount} 同步中）` : ''}`
  const rows = state.devices.map((device) => el('button', {
    type: 'button', class: 'device-head card-tap',
    'aria-current': device.id === state.deviceId ? 'true' : undefined,
    onClick: () => { vibrate(); void openDevice(device) },
  },
  el('span', { class: 'dot' + (hubReachable && !device.stale ? ' online' : '') }),
  el('span', { class: 'name' }, device.name, el('small', { text: hostStatusLabel(hubReachable, device) })),
  el('span', { class: 'chip', text: device.agents.map(agentLabel).join(' / ') || '无 agent' }),
  el('span', { class: 'chevron', 'aria-hidden': 'true' }),
  ))
  return el('section', { id: 'node-topology-card', class: 'card' },
    el('h2', { text: '纯出站安全拓扑' }),
    el('ol', { class: 'node-topology' },
      topologyNode('手机 Node', config.token.startsWith('mph1.') ? 'mph1.*' : '未使用 mph1.*', state.online ? '网络可用' : '网络离线'),
      topologyNode('marshal-hub', config.hubUrl.startsWith('https:') ? 'TLS + SSE' : '本地 HTTP + SSE',
        hubReachable ? 'Hub 可达' : '状态未确认'),
      topologyNode('边缘主机', 'WSS · mnd1.*', hostSummary),
    ),
    el('p', { class: 'node-caption', text: '手机与边缘主机均主动连接 Hub，手机不监听入站端口。' }),
    el('h3', { class: 'node-subtitle', text: '边缘主机' }),
    ...(rows.length ? rows : [el('p', { class: 'empty', text: '暂无可显示的边缘主机。' })]),
  )
}

function homeView(): Child[] {
  const config = state.config
  if (!config) { state.view = 'setup'; return setupView() }
  const header = topbar('节点与空间', hubLabel(config.hubUrl), [
    button('扫码连接', scanPairing, { class: 'icon-button' }),
    button('设置', () => { state.view = 'settings'; render() }, { class: 'icon-button' }),
  ])
  header.classList.add('node-header')
  header.prepend(logoMark())
  const banners: Child[] = []
  if (!state.online) banners.push(el('div', { class: 'banner warn', text: '设备离线：网络恢复后会自动刷新。' }))
  if (state.statusText) banners.push(el('div', { class: 'banner', text: state.statusText }))

  return [
    header,
    ...banners,
    nodeTopologyCard(config),
    themeCard(),
    nodeSecurityCard(config),
    state.config?.lanBridge
      ? el('div', { class: 'card' },
        el('h2', { text: '局域网工作台' }),
        el('p', { class: 'empty', text: '默认关闭。只在和电脑同一网络、并且你打开了这个开关时使用。' }),
        button('进入局域网工作台', openDshWorkbench, { class: 'block' }),
      )
      : null,
    el('div', { class: 'card' },
      el('h2', { text: '协作' }),
      el('div', { class: 'row-between' },
        el('div', { class: 'label' }, el('strong', { text: '群聊' }), el('span', { text: '跨设备智能体讨论与汇总' })),
        button('打开', () => openGroups('home'), { class: 'icon-button' }),
      ),
      el('div', { class: 'row-between' },
        el('div', { class: 'label' }, el('strong', { text: '记忆' }), el('span', { text: '智能体长期记忆 · 只读浏览' })),
        button('打开', () => { memoryEntries = []; state.view = 'memory'; render(); void loadMemory() }, { class: 'icon-button' }),
      ),
    ),
    el('div', { class: 'foot', text: 'v' + APP_VERSION + ' · 手机端 node · 出站直连，不承载 hub' }),
  ]
}

function showingMemory(): boolean {
  return state.view === 'memory' || (state.view === 'agents' && agentsSegment === 'memory')
}

function memberConnectivity(member: RosterEntry): string {
  const device = state.devices.find(entry => entry.id === member.deviceId)
  if (!state.online || !connectivity.snapshot(Date.now()).roster || !device) return '状态未确认'
  if (!roster.some(entry => entry.id === member.id && entry.deviceId === member.deviceId)) return '状态未确认'
  if (device.syncing) return '同步中'
  return device.stale ? '同步滞后' : '在线'
}

function memberHostText(member: RosterEntry): string {
  return `运行主机：${deviceName(member.deviceId)} · ${memberConnectivity(member)}`
}

function agentsView(): Child[] {
  const segments = [{ id: 'members', label: '成员与预设' }, { id: 'memory', label: '记忆与星系' }] as const
  const header = topbar('智能体', '跨设备协作', [button('刷新', () => {
    if (showingMemory()) void loadMemory()
    else void refreshDevices()
  }, { class: 'icon-button' })])
  const picker = el('div', { class: 'segments', role: 'group', 'aria-label': '智能体视图' },
    ...segments.map(({ id, label }) => button(label, () => {
      if (agentsSegment === id) return
      agentsSegment = id
      render()
      if (id === 'memory') void loadMemory()
      else void refreshDevices()
    }, { type: 'button', 'aria-pressed': String(agentsSegment === id) })),
  )
  if (showingMemory()) return [header, picker, ...memoryContent()]
  const members = roster.map((item) => {
    const device = state.devices.find(entry => entry.id === item.deviceId)
    const status = memberConnectivity(item)
    const online = status === '在线'
    return el('button', { type: 'button', class: 'row-between roster-member', 'aria-haspopup': 'dialog',
      onClick: event => openMemberSheet(item, event.currentTarget as HTMLElement) },
      el('div', { class: 'roster-main' },
        el('span', { class: 'dot' + (online ? ' online' : '') }),
        el('div', { class: 'label' },
          el('strong', { text: item.name }),
          el('span', { text: device?.name ?? item.deviceId }),
        ),
      ),
      el('span', { class: 'chip' + (online ? ' on' : ''), text: status }),
    )
  })
  return [header, picker, el('section', { class: 'card' },
    el('h2', { text: '智能体花名册' }),
    ...(members.length > 0 ? members : [el('p', { class: 'empty', text: '等待电脑上报智能体花名册。' })]),
  )]
}

let activeMemberStatus: { node: HTMLElement; member: RosterEntry } | undefined
function openMemberSheet(member: RosterEntry, opener: HTMLElement): void {
  if (chatSheet) return
  const dialog = el('dialog', { class: 'ticket-sheet', 'aria-labelledby': 'member-sheet-title' })
  const dismiss = () => {
    activeMemberStatus = undefined
    chatSheet = null
    dialog.close()
    dialog.remove()
    opener.focus()
  }
  chatSheet = { view: state.view, dismiss, close: dismiss }
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss() })
  dialog.addEventListener('click', event => { if (event.target === dialog) dismiss() })
  const hostStatus = el('p', { text: memberHostText(member) })
  activeMemberStatus = { node: hostStatus, member }
  dialog.append(
    el('header', { class: 'ticket-sheet-header' }, el('div', { class: 'row-between' },
      el('h2', { id: 'member-sheet-title', text: member.name }), button('关闭', dismiss))),
    el('div', { class: 'ticket-sheet-body' },
      hostStatus,
      el('p', { text: `智能体：${member.id}` }),
      button('查看该成员的记忆星系', () => {
        dismiss()
        memoryMember = member
        memoryLayer = 'all'
        memoryMode = 'galaxy'
        agentsSegment = 'memory'
        render()
        rootNode().querySelector<HTMLElement>('.segments [aria-pressed="true"]')?.focus({ preventScroll: true })
        void loadMemory()
      }, { class: 'primary block' })),
  )
  document.body.append(dialog)
  dialog.showModal()
}

let agentsSegment: 'members' | 'memory' = 'members'
let hubUnavailable = false
let sessionQuery = ''
let sessionLimit = SESSION_PAGE_SIZE
let roster: RosterEntry[] = []
let boardTasks: Ticket[] = []
let boardRevisions: Record<string, number> = {}
let boardReceipts: BoardReceipt[] = []
let boardPoll: ReturnType<typeof setTimeout> | undefined
let boardLoad = 0
let memoryPoll: ReturnType<typeof setTimeout> | undefined
let memoryLoad = 0
let memoryEntries: GalaxyNode[] = []
let memoryMember: RosterEntry | null = null
let memoryLayer: 'all' | GalaxyNode['layer'] = 'all'
let memoryMode: 'galaxy' | 'list' = 'galaxy'
let selectedMemory = ''
const galaxyCamera = initialGalaxyCamera()
let disposeGalaxy: (() => void) | undefined
let groupKey = ''
let groupsParent: 'home' | 'sessions' = 'home'

let sessionCategory: SessionCategory = 'single'
let chatSheet: { view: View; close: () => void; dismiss: () => void } | null = null

function openGroups(from: typeof groupsParent): void {
  showSessionCategory('group', from)
}

function returnToGroups(): void {
  if (state.view !== 'groupRoom' && state.view !== 'groupNew') return
  showSessionCategory(groupBackCategory(state.view, sessionCategory))
}

function setSessionCenterRoute(category: SessionCategory): void {
  const route = sessionCenterRoute(category)
  sessionCategory = route.category
  state.view = route.view
}

function showSessionCategory(category: SessionCategory, from = groupsParent): void {
  groupsParent = from
  setSessionCenterRoute(category)
  render()
  if (category === 'single' && !state.deviceId) {
    const first = state.devices.find(device => !device.stale) ?? state.devices[0]
    if (first) void openDevice(first)
  } else if (category === 'group') {
    void loadRooms()
    if (!boardLoaded) void loadBoard(true)
  }
  else if (category === 'ticketRoom') void loadBoard()
}

function chatSegments<T extends string>(label: string, choices: ReadonlyArray<readonly [T, string]>, selected: T,
  select: (value: T) => void, disabled = false): HTMLElement {
  return el('div', { class: 'chat-segments', role: 'group', 'aria-label': label }, ...choices.map(([value, text]) =>
    button(text, () => select(value), { type: 'button', 'aria-pressed': value === selected, disabled })))
}

function chatCenterHeader(subtitle: string): Child[] {
  const add = button('', openChatSheet, { class: 'primary ticket-add chat-add', 'aria-label': '新建会话', 'aria-haspopup': 'dialog' })
  add.append(tabIcon('plus'))
  return [topbar('会话中心', subtitle, [add], backButton(state.view === 'groups' ? groupsParent : 'home')),
    chatSegments('会话类型', [['single', '单聊'], ['group', 'Agent 群聊'], ['ticketRoom', '工单群']], sessionCategory, category => {
      if (category === sessionCategory) return
      showSessionCategory(category)
      rootNode().querySelector<HTMLElement>('.chat-segments [aria-pressed="true"]')?.focus()
    })]
}

// Ambiguous receipts can be retried with the same key even after reopening the Sheet.
const unconfirmedCreates = new WeakMap<MarshalApi, Map<string, string>>()

function openChatSheet(): void {
  let wizard = initialWizardState(sessionCategory === 'group' ? 'group' : 'single')
  let attempt = { key: '', busy: false }
  let notice = ''
  const dialog = el('dialog', { class: 'ticket-sheet chat-sheet', 'aria-labelledby': 'chat-sheet-title' })
  const dismiss = () => {
    chatSheet = null
    dialog.close()
    dialog.remove()
    rootNode().querySelector<HTMLElement>('.chat-add')?.focus()
  }
  const close = () => { if (canCloseCreateSheet(attempt)) dismiss() }
  chatSheet = { view: state.view, close, dismiss }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
  dialog.addEventListener('click', event => { if (event.target === dialog) close() })

  function draw(focus?: string): void {
    const busy = attempt.busy
    const modes = chatSegments('新建类型', [['single', '新建单聊会话'], ['group', '多智能体群聊']], wizard.mode, mode => {
      if (mode === wizard.mode) return
      wizard = initialWizardState(mode)
      notice = ''
      draw('.chat-segments [aria-pressed="true"]')
    }, busy)
    const body = el('div', { class: 'ticket-sheet-body' }, modes)
    if (wizard.mode === 'group') {
      const ready = !!phoneApi() && accountUsable()
      body.append(button(ready ? '继续选择群成员' : '去设置登录或配对', () => {
        close()
        if (ready) {
          groupsParent = 'home'
          openGroupNew()
        } else { state.view = 'settings'; render() }
      }, { class: 'primary block' }))
    } else {
      const { step, deviceId, engineOrAgentId } = wizard
      const hosts = state.devices.filter(device => !device.stale)
      const host = hosts.find(device => device.id === deviceId)
      const title = step === 'host' ? '1. 选择运行主机' : step === 'agent' ? '2. 选择可用引擎或智能体' : '3. 工作目录（可选）'
      const field = el('div', { class: 'ticket-field' }, el('h3', { id: 'chat-wizard-step', tabindex: '-1', text: title }))
      const stepTo = (next: WizardStep) => {
        wizard = moveWizardStep(wizard, next)
        notice = ''
        draw('#chat-wizard-step')
      }
      if (step !== 'host') field.append(el('p', { class: 'notice', text: [host?.name,
        step === 'cwd' ? agentLabel(engineOrAgentId) : ''].filter(Boolean).join(' · ') }))
      if (step !== 'cwd') {
        const choices = step === 'host' ? hosts.map(device => [device.id, device.name] as const)
          : (host?.agents ?? []).map(agent => [agent, agentLabel(agent)] as const)
        if (!choices.length) field.append(el('p', { class: 'empty', text: step === 'host' ? '暂无可用主机。' : '该主机暂无可用引擎或智能体。' }),
          button('重新读取主机', () => { void refreshDevices().then(() => { if (dialog.open) draw('#chat-wizard-step') }) }))
        for (const [id, label] of choices) field.append(button(label, () => {
          if (wizard.mode !== 'single') return
          wizard = step === 'host' ? selectWizardHost(wizard, id) : { ...wizard, engineOrAgentId: id }
          stepTo(step === 'host' ? 'agent' : 'cwd')
        }))
      } else {
        const cwd = el('input', { type: 'text', value: wizard.cwd ?? '', maxlength: 4096, placeholder: '留空使用主机默认目录',
          'aria-label': title, disabled: busy, onInput: () => {
            if (wizard.mode === 'single') wizard = { ...wizard, cwd: cwd.value }
          } })
        field.append(cwd, button(busy ? '正在创建…' : '创建会话', () => { void create() }, { class: 'primary block', disabled: busy }))
      }
      if (step !== 'host') field.append(button('上一步', () => stepTo(step === 'agent' ? 'host' : 'agent'), { disabled: busy }))
      body.append(field)
    }
    body.append(el('p', { role: 'status', text: notice }))
    dialog.replaceChildren(el('header', { class: 'ticket-sheet-header' }, el('div', { class: 'ticket-handle', 'aria-hidden': 'true' }),
      el('div', { class: 'row-between' }, el('h2', { id: 'chat-sheet-title', text: '新建会话' }), button('关闭', close, { disabled: !canCloseCreateSheet(attempt) }))), body)
    if (focus) dialog.querySelector<HTMLElement>(focus)?.focus()
  }

  async function create(): Promise<void> {
    const api = state.api
    if (!api || wizard.mode !== 'single' || attempt.busy) return
    const { deviceId, engineOrAgentId: agent, cwd } = wizard
    const error = Object.values(validateWizardState(wizard))[0]
    const host = state.devices.find(device => device.id === deviceId && !device.stale && device.agents.includes(agent))
    if (error || !host) { notice = error ?? '所选主机或引擎当前不可用，请重新选择。'; draw('#chat-wizard-step'); return }
    const signature = JSON.stringify([deviceId, agent, cwd?.trim() ?? ''])
    const keys = unconfirmedCreates.get(api) ?? new Map<string, string>()
    unconfirmedCreates.set(api, keys)
    attempt = beginCreateAttempt(keys, signature, newIdempotencyKey)
    notice = ''
    draw('#chat-wizard-step')
    const result = await api.command('create', { deviceId, agent, sessionId: null }, cwd?.trim() ? { cwd: cwd.trim() } : {}, attempt.key)
    const receipt = result.ok ? result.data.result as { sessionId?: unknown } | undefined : undefined
    const sessionId = receipt?.sessionId
    const created = typeof sessionId === 'string' && sessionId !== ''
    const definiteReject = !result.ok && result.error === 'rejected' && result.code !== 'pending-confirmation' && result.code !== 'outcome-unknown'
    attempt = finishCreateAttempt(keys, signature, attempt, created || definiteReject)
    if (!dialog.open) return
    if (state.api !== api) { dismiss(); return }
    if (!result.ok) { notice = result.message; draw('#chat-wizard-step'); return }
    close()
    if (!created) {
      toast('未收到新会话编号，请在会话列表查看。')
      void openDevice(host)
      return
    }
    sessionCategory = 'single'
    state.deviceId = deviceId
    state.sessions = []
    void openSession(deviceId, { deviceId, agent, sessionId, running: false, updatedAt: Date.now(), blank: true })
  }

  draw()
  document.body.append(dialog)
  dialog.showModal()
}

function sessionsView(): Child[] {
  if (sessionCategory !== 'single') return groupsView()
  const device = state.devices.find(entry => entry.id === state.deviceId)
  const host = el('select', { 'aria-label': '会话列表主机', onChange: () => {
    const selected = state.devices.find(entry => entry.id === host.value)
    if (selected) void openDevice(selected)
  } }, ...state.devices.map(entry => optionNode(entry.id, entry.name)))
  if (device) host.value = device.id
  const search = el('input', {
    type: 'search', placeholder: '搜索会话', value: sessionQuery,
    onInput: (event: Event) => { sessionQuery = (event.target as HTMLInputElement).value; sessionLimit = SESSION_PAGE_SIZE; render() },
  }) as HTMLInputElement
  const page = sliceSessions(state.sessions, sessionQuery, sessionLimit)
  const groups = new Map<string, SessionRow[]>()
  for (const row of page.shown) {
    const list = groups.get(row.agent) ?? []
    list.push(row)
    groups.set(row.agent, list)
  }
  const sections: Child[] = [search]
  if (groups.size === 0) {
    sections.push(el('p', { class: 'empty', text: state.statusText || '这台设备暂无会话。' }))
  }
  for (const [agent, rows] of groups) {
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    sections.push(el('div', { class: 'agent-group' },
      el('h3', { class: 'agent-title', text: agentLabel(agent) + ' · ' + rows.length + ' 个会话' }),
      ...rows.map((row) => el('button', {
        class: 'session',
        onClick: () => { vibrate(); void openSession(state.deviceId ?? row.deviceId, row) },
      },
      el('span', { class: 'dot' + (row.running ? ' online' : '') }),
      el('span', { class: 'copy' },
        el('strong', { text: sessionTitle(row) }),
        el('span', { text: formatTime(row.updatedAt) }),
      ),
      el('span', { class: 'state' + (row.running ? ' running' : ''), text: row.running ? '运行中' : '空闲' }),
      el('span', { class: 'chevron', 'aria-hidden': 'true' }),
      )),
    ))
  }
  if (page.hasMore) sections.push(button('加载更多', () => { sessionLimit += SESSION_PAGE_SIZE; render() }, { class: 'block' }))
  return [
    ...chatCenterHeader(device?.name ?? '暂无运行主机'),
    state.devices.length > 1 ? host : null,
    el('div', { class: 'card' }, ...sections),
  ]
}

function chatIconButton(icon: string, label: string, action: () => void, props: Parameters<typeof button>[2] = {}): HTMLButtonElement {
  const node = button('', action, { type: 'button', 'aria-label': label, ...props })
  node.append(tabIcon(icon))
  return node
}

async function copyReply(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制回复')
  } catch {
    toast('无法访问剪贴板，可长按回复手动复制', 'error')
  }
}

function messageNode(message: Message): HTMLElement {
  const key = transcriptMessageKey(message)
  const cls = 'msg msg-' + message.role + (message.failed ? ' failed' : '') + (message.open ? ' streaming' : '')
  const body = el('div', { class: 'msg-body', text: message.text })
  if (message.role === 'reason' || message.role === 'tool') {
    const isReason = message.role === 'reason'
    const label = el('span')
    const toggle = button('', () => {
      const transcript = toggle.closest<HTMLElement>('.transcript')
      const top = transcript?.scrollTop ?? 0
      if (expandedMessages.has(key)) expandedMessages.delete(key)
      else expandedMessages.add(key)
      update()
      if (transcript) {
        transcript.scrollTop = top
        // A shorter panel may clamp scrollTop; that isn't an upward gesture.
        historyScrollPositions.set(transcript, transcript.scrollTop)
      }
    }, { type: 'button', class: 'msg-disclosure' })
    toggle.append(tabIcon(isReason ? 'thought' : 'terminal'), label)
    function update(): void {
      const expanded = expandedMessages.has(key)
      toggle.setAttribute('aria-expanded', String(expanded))
      body.hidden = !expanded
      if (isReason) {
        const summary = formatThoughtSummary(message)
        label.textContent = expanded ? summary.replace(/ ›$/, '') + ' ▾' : summary
      } else label.textContent = `${message.toolTitle ?? '工具调用'} ${expanded ? '▴' : '▾'}`
    }
    update()
    return el('div', { class: cls, 'data-msg': key }, toggle, body)
  }
  const role = message.role === 'assistant' ? agentLabel(state.session?.agent ?? '') : message.role === 'user' ? '我' : '系统'
  return el('div', { class: cls, 'data-msg': key },
    el('div', { class: 'msg-role', text: role }), body,
    message.role === 'assistant' && !message.open ? chatIconButton('copy', '复制回复', () => { void copyReply(message.text) }, { class: 'msg-copy' }) : null,
    message.failed ? button('重试', () => {
      if (state.busy || state.uploading) return
      draft = message.text
      state.messages = state.messages.filter(entry => entry !== message)
      void sendPrompt(message.retryKey)
    }, { class: 'danger' }) : null,
  )
}

function cardNode(card: InputCard): HTMLElement {
  if (card.approval) {
    return el('div', { class: 'card ask' },
      el('h2', { text: '审批：' + card.approval.action }),
      ...(card.approval.detail ? [el('p', { class: 'tool', text: card.approval.detail })] : []),
      el('div', { class: 'choices' },
        ...card.approval.decisions.filter(decisionIsSafe).map((decision) => button(decision.label, () => {
          void answerCard(card, [{ id: decision.id, selectedOptionIds: [] }])
        })),
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
  const freeText = el('textarea', { rows: 2, placeholder: '也可以直接输入回答' }) as HTMLTextAreaElement
  return el('div', { class: 'card ask' },
    el('h2', { text: card.title ?? '需要你回答' }),
    ...questionNodes,
    freeText,
    el('div', { class: 'choices' },
      button('提交', () => {
        const text = freeText.value.trim()
        const answers = (card.questions ?? []).map((question) => ({
          id: question.id,
          selectedOptionIds: Array.from(selections.get(question.id) ?? []),
          ...(text ? { text } : {}),
        }))
        if (answers.length === 0 && text) answers.push({ id: card.requestId, selectedOptionIds: [], text })
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

function openComposerSheet(title: string, trigger: string, options: (close: () => void) => Child[]): void {
  if (composerSheet) return
  const dialog = el('dialog', { class: 'ticket-sheet composer-sheet', 'aria-labelledby': 'composer-sheet-title' })
  const close = () => {
    composerSheet = null
    dialog.close()
    dialog.remove()
    rootNode().querySelector<HTMLElement>(`.${trigger}`)?.focus({ preventScroll: true })
  }
  composerSheet = { session: sessionGeneration, close }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
  dialog.addEventListener('click', event => { if (event.target === dialog) close() })
  dialog.append(el('div', {},
    el('div', { class: 'ticket-sheet-header row-between' },
      el('h2', { id: 'composer-sheet-title', text: title }), button('关闭', close, { class: 'ghost' })),
    el('div', { class: 'ticket-sheet-body composer-options' }, ...options(close)),
  ))
  document.body.append(dialog)
  dialog.showModal()
}

function composerOption(label: string, description: string, badge: string, action: () => void): HTMLButtonElement {
  return el('button', { type: 'button', class: 'composer-option', 'aria-pressed': badge ? true : undefined, onClick: action },
    el('span', { class: 'composer-option-copy' }, el('strong', { text: label }),
      description ? el('span', { text: description }) : null),
    badge ? el('span', { class: 'composer-current', text: badge }) : null,
  )
}

function sessionView(): Child[] {
  const session = state.session
  if (!session) { state.view = 'sessions'; return sessionsView() }
  const generation = sessionGeneration
  const cards = pendingInputs.cards(session)
  const header = topbar(sessionTitle(session), agentLabel(session.agent) + ' · ' + (state.running ? '运行中' : '空闲'), [
    button('控制', openControls, { class: 'icon-button' }),
  ], backButton('sessions'))
  const controls = state.controls
  const currentModel = state.modelChoice || controls?.current.model || ''
  const modelLabel = shortModelLabel(controls?.models.find(model => model.id === currentModel)?.label || currentModel || '会话模型')
  const efforts = effectiveEfforts(controls, state.modelChoice)
  const currentEffort = state.effortChoice || (state.modelChoice && state.modelChoice !== controls?.current.model ? '' : controls?.current.reasoning ?? '')
  const effortActive = Boolean(currentEffort && currentEffort !== 'off' && efforts.includes(currentEffort))
  const stop = state.running && can(state.capability, 'interrupt')

  const filePickers = [
    { label: '相册图片', description: '', accept: 'image/*', multiple: true },
    { label: '拍照识别', description: '拍摄并作为图片发送', accept: 'image/*', capture: 'environment' },
    { label: '本地文件', description: '分片上传，每个文件最多 10 MB', accept: '*/*', multiple: true },
  ].map(({ label, description, ...attributes }, index) => {
    const input = el('input', { type: 'file', hidden: true, 'data-attachment-picker': index, ...attributes })
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [])
      input.value = ''
      if (generation === sessionGeneration && state.view === 'session') void handleFiles(files)
    })
    return { label, description, input }
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

  const plus = chatIconButton('plus', '添加附件', () => openComposerSheet('添加附件', 'composer-add', close =>
    filePickers.map(({ label, description }, index) => composerOption(label, description, '', () => {
      close()
      rootNode().querySelector<HTMLInputElement>(`[data-attachment-picker="${index}"]`)?.click()
    }))), { class: 'composer-add', 'aria-haspopup': 'dialog', disabled: state.uploading || state.attachments.length >= 8 || state.busy })
  const model = button('', () => openComposerSheet('本次发送模型', 'composer-model', close => {
    const models = controls?.models ?? []
    if (models.length === 0) return [button('读取模型', () => { close(); void refreshControls(true) }, { class: 'ghost' })]
    return [
      ...models.map(entry => composerOption(shortModelLabel(entry.label), '', entry.id === currentModel ? '当前' : '', () => {
        state.modelChoice = entry.id
        if (!entry.efforts.includes(state.effortChoice)) state.effortChoice = ''
        close()
        render()
        rootNode().querySelector<HTMLElement>('.composer-model')?.focus({ preventScroll: true })
      })),
      state.modelChoice ? button('沿用会话模型', () => {
        state.modelChoice = ''
        state.effortChoice = ''
        close()
        render()
        rootNode().querySelector<HTMLElement>('.composer-model')?.focus({ preventScroll: true })
      }, { class: 'ghost' }) : null,
    ]
  }), { class: 'composer-model', 'aria-haspopup': 'dialog', 'aria-label': `选择模型：${modelLabel}` })
  model.append(el('span', { text: modelLabel }), tabIcon('down'))
  const effort = button('', () => openComposerSheet('深度思考强度', 'composer-effort', close =>
    buildEffortSheetOptions(efforts, currentEffort).map(option => composerOption(option.label, option.description, option.badge, () => {
      state.effortChoice = option.id
      close()
      render()
      rootNode().querySelector<HTMLElement>('.composer-effort')?.focus({ preventScroll: true })
    }))), { class: 'composer-effort' + (effortActive ? ' active' : ''), 'aria-haspopup': 'dialog', disabled: efforts.length === 0 })
  effort.append(tabIcon('thought'), el('span', { text: effortActive ? `思考 · ${effortLabel(currentEffort)}` : '深度思考' }))

  const input = el('input', {
    type: 'text', placeholder: '发消息给 ' + agentLabel(session.agent) + '…', value: draft, 'aria-label': '消息',
    onInput: (event: Event) => { draft = (event.target as HTMLInputElement).value },
  })
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !stop && !state.uploading) {
      event.preventDefault()
      void sendPrompt()
    }
  })
  const send = chatIconButton(stop ? 'stop' : 'send', stop ? '停止生成' : '发送消息', () => {
    if (stop) void interrupt()
    else void sendPrompt()
  }, { class: 'primary composer-action' + (stop ? ' stopping' : ''), disabled: !stop && (state.busy || state.uploading) })

  return [
    header,
    ...sessionStatChips(),
    cards.length > 0 ? el('div', { class: 'session-pending' }, ...cards.map(cardNode)) : null,
    el('div', { class: 'transcript', tabindex: 0, 'aria-label': '对话记录' },
      el('p', { role: 'status', class: 'history-indicator', text: olderRequest ? '正在同步更早对话…' : historyPageNotice || (reachedHistoryStart ? '已加载全部历史' : '') }),
      ...state.messages.map(messageNode),
      historyStatus === 'loading' ? el('p', { role: 'status', class: 'notice', text: '正在读取历史…' }) : null,
      historyStatus === 'error' ? el('div', { class: 'card' },
        el('p', { role: 'status', class: 'banner error', text: historyError }),
        button('重试读取历史', () => { void reloadTranscript() }, { class: 'block' })) : null,
      ...(!historyPageNotice && isWelcomeEmpty(historyStatus, historyItemCount, state.messages.length, Boolean(state.historyCursor)) ? [el('div', { class: 'chat-welcome card' },
        el('h2', { text: '开始对话' }), ...WELCOME_STARTERS.map(starter => button(starter, () => {
          draft = fillWelcomeStarter(input, starter)
        })))] : []),
    ),
    el('div', { class: 'session-composer' },
      ...attachmentChips,
      input,
      el('div', { class: 'composer-toolbar' }, plus, model, effort, send),
      ...filePickers.map(picker => picker.input),
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
      button('刷新', () => { void refreshControls(true) }, { class: 'icon-button' }),
    ], backButton('session')),
    el('div', { class: 'card' },
      el('h2', { text: '本次发送' }),
      el('p', { class: 'empty', text: '模型：' + (state.modelChoice || current.model || '沿用会话默认') }),
      el('p', { class: 'empty', text: '思考强度：' + (state.effortChoice || current.reasoning || '默认') }),
      el('p', { class: 'notice', text: '模型与思考强度按「本次发送」生效；回会话页选择。' }),
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
let groupPollGeneration = 0

function stopGroupPoll(): void {
  groupPollGeneration++
  groupStream?.close()
  groupStream = null
  if (groupPoll) { clearInterval(groupPoll); groupPoll = null }
}

let groupStream: StreamHandle | null = null
function startGroupPoll(): void {
  stopGroupPoll()
  const generation = groupPollGeneration
  const api = phoneApi()
  if (api) {
    void openEventStream({
      url: api.discussionStreamUrl(),
      token: api.token,
      id: 'groups',
      onFrame: () => { void refreshRoom(true) },
    }).then((handle) => {
      if (generation === groupPollGeneration) groupStream = handle
      else handle.close()
    })
  }
  groupPoll = setInterval(() => {
    if (state.view === 'groupRoom' || state.view === 'ticketGroup') void refreshRoom(true)
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

async function watchForegroundLock(): Promise<void> {
  try {
    const { App } = await import('@capacitor/app')
    let away = false
    await App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) { away = true; return }
      if (!away) return
      away = false
      void registerDevicePush()
      document.getElementById('bridge-workbench')?.remove()
      if (!state.config?.lock) return
      state.view = 'lock'
      render()
    })
  } catch { /* 浏览器预览没有这个事件 */ }
}

function appLocked(): boolean {
  return state.view === 'lock' || (state.view === 'booting' && !!state.config?.lock)
}

let appConfirmation: { view: View; cancel: () => void } | null = null

function confirmInApp(title: string, message: string, label = '继续'): Promise<boolean> {
  if (appConfirmation || chatSheet || appLocked()) return Promise.resolve(false)
  return new Promise(resolve => {
    const dialog = el('dialog', { class: 'ticket-sheet', 'aria-labelledby': 'app-confirm-title', 'aria-describedby': 'app-confirm-message' })
    const finish = (accepted: boolean) => {
      appConfirmation = null
      dialog.close()
      dialog.remove()
      resolve(accepted && !appLocked())
    }
    const cancel = () => finish(false)
    appConfirmation = { view: state.view, cancel }
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel() })
    dialog.addEventListener('click', event => { if (event.target === dialog) cancel() })
    dialog.append(
      el('header', { class: 'ticket-sheet-header' },
        el('h2', { id: 'app-confirm-title', text: title })),
      el('div', { class: 'ticket-sheet-body' },
        el('p', { id: 'app-confirm-message', text: message }),
        el('div', { class: 'choices' }, button('取消', cancel, { autofocus: true }),
          button(label, () => finish(true), { class: label === '解除' ? 'danger' : 'primary' }))),
    )
    document.body.append(dialog)
    dialog.showModal()
  })
}

async function readPinState(): Promise<{ failures: number; until: number }> {
  const raw = await readPinGuard()
  if (!raw) return { failures: 0, until: 0 }
  try {
    const value = JSON.parse(raw) as { failures?: unknown; until?: unknown }
    return {
      failures: typeof value.failures === 'number' ? value.failures : 0,
      until: typeof value.until === 'number' ? value.until : 0,
    }
  } catch {
    return { failures: 0, until: 0 }
  }
}

/**
 * 深链只接受 marshal://pair?code&hub。锁屏时直接丢掉，不排队。
 * 带管理令牌、群聊票或桥令牌的旧链接整段忽略。
 */
async function handleDeepLink(raw: string): Promise<void> {
  if (appLocked()) return
  if (linkCarriesSecret(raw) || parseUnifiedPairing(raw)) {
    toast('这个链接带有旧令牌，已忽略。请扫电脑上新的配对码。', 'error')
    return
  }
  const pairing = parsePairingLink(raw)
  if (pairing?.hubUrl) {
    const decision = decideDeepLink({ url: raw, locked: false, configuredHub: state.config?.hubUrl ?? null })
    if (decision.action === 'invalid') { toast(decision.error, 'error'); return }
    if (decision.action === 'confirm' || decision.action === 'prefill') {
      const host = new URL(decision.action === 'confirm' ? decision.hubUrl : pairing.hubUrl).host
      const prompt = decision.action === 'confirm'
        ? '把 Hub 换成 ' + host + '？已保存的令牌会被清掉。'
        : '连接到 ' + host + ' 并兑换这个配对码？'
      if (!await confirmInApp('确认配对', prompt)) return
    }
    await redeemPairingCode(pairing.hubUrl, pairing.code)
    return
  }
  const parsed = parseOnboardLink(raw)
  if (!parsed?.hub) return
  const decision = decideDeepLink({ url: raw, locked: false, configuredHub: state.config?.hubUrl ?? null })
  if (decision.action === 'invalid') { toast(decision.error, 'error'); return }
  if (decision.action !== 'prefill' && decision.action !== 'confirm' && decision.action !== 'same') return
  if (decision.action === 'confirm') {
    const host = new URL(decision.hubUrl).host
    if (!await confirmInApp('确认配对', '把 Hub 换成 ' + host + '？已保存的令牌会被清掉。')) return
  }
  const hub = decision.action === 'same' ? state.config?.hubUrl : decision.hubUrl
  if (!hub) return
  const hubChanged = !!state.config && state.config.hubUrl !== hub
  let next: MarshalConfig
  try {
    next = await saveConfigPatch({ hubUrl: hub, ...(hubChanged ? { token: '', account: null } : {}) }, makeConfig({ hubUrl: hub }))
  } catch { toast('配对信息保存失败', 'error'); return }
  adoptConfig(next)
  state.account = next.account ?? null
  state.view = next.token ? state.view : 'setup'
  render()
  toast(hubChanged ? '已更换 Hub，请重新配对' : '已填入 Hub 地址')
  return
}

async function redeemPairingCode(hubUrl: string, code: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(hubUrl + '/marshal/api/pairing/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code, name: '我的手机', installationId: await installationId() }),
    })
  } catch {
    toast('连不上 Hub', 'error')
    return
  }
  if (!response.ok) { toast('配对码无效或已过期，请扫电脑上最新的码', 'error'); return }
  const body = await response.json() as { credential?: unknown }
  if (typeof body.credential !== 'string' || !body.credential.startsWith('mph1.')) {
    toast('Hub 没有返回手机凭证', 'error')
    return
  }
  const previous = state.config
  const patch = {
    hubUrl,
    token: body.credential,
    ...(previous && previous.hubUrl !== hubUrl ? { account: null } : {}),
  }
  let next: MarshalConfig
  try { next = await saveConfigPatch(patch, makeConfig({ hubUrl })) } catch { toast('凭证保存失败', 'error'); return }
  adoptConfig(next)
  toast('配对完成')
  if (!appLocked()) await enterApp()
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
  try {
    adoptConfig(await saveConfigPatch({ account: result.data }))
  } catch {
    toast('登录成功，但本机保存失败', 'error')
  }
  state.account = result.data
  toast('群聊账号已登录')
  openGroups('home')
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
    try { adoptConfig(await saveConfigPatch({ account: null })) } catch {
      if (state.config) state.config = { ...state.config, account: null }
    }
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

function phoneApi(): MarshalApi | null {
  const api = state.api
  return api && api.token.startsWith('mph1.') ? api : null
}

async function loadBoard(quiet = false): Promise<void> {
  clearTimeout(boardPoll)
  const api = phoneApi()
  if (!api || appLocked()) return
  const load = ++boardLoad
  const result = await api.board()
  if (load !== boardLoad || state.api !== api || appLocked()) return
  if (result.ok) {
    boardTasks = result.data.tasks
    boardRevisions = result.data.revisions
    boardReceipts = result.data.receipts
    ticketWrites.refreshed()
    boardError = ''
  } else if (!quiet || !boardTasks.length) boardError = result.message
  boardLoaded = true
  boardPoll = scheduleBoardPoll(boardReceipts.some(receipt => receipt.state === 'queued'),
    () => state.api === api && !appLocked() && state.view !== 'setup' && !document.hidden && state.online,
    () => { void loadBoard(true) }, setTimeout)
  if (state.view === 'groups') render()
  if (state.view === 'board') {
    refreshTicketList()
    if (!quiet || !rootNode().querySelector('.modal-drawer :is(input, textarea, select):focus')) updateTicketSheet()
  }
  refreshTabBar()
}

function scheduleBoardRefresh(): void {
  clearTimeout(boardPoll)
  if (!phoneApi() || appLocked() || state.view === 'setup' || document.hidden || !state.online) return
  void loadBoard(true)
}

const BOARD_RECEIPT_ACTION = { create: '新建', edit: '修改', move: '移动', delete: '删除' }
const BOARD_RECEIPT_STATE = { queued: '等待回执', applied: '已应用', rejected: '已拒绝', unconfirmed: '结果未确认' }
const BOARD_RECEIPT_REASON: Record<string, string> = {
  conflict: '看板修订冲突', unsupported: '电脑未启用该操作',
  unavailable: '电脑未返回有效修订', expired: '未在时限内收到回执',
}
const BOARD_STATUS_LABELS: Record<string, string> = {
  todo: '待办', doing: '执行中', running: '执行中', review: '审查中', done: '已验收',
  attention: '待确认', 'pending-confirmation': '待确认', '待确认': '待确认',
}
const TICKET_STAGES = ['设计拆分', '隔离编码', '交叉审查', '机主验收']
const TICKET_FILTERS = { all: '全部', attention: '待确认', running: '执行中', done: '已验收' } as const

let ticketNav: TicketNavigation = { view: 'list' }
let boardFilter: TicketFilter = 'all'
let boardQuery = ''
let boardLoaded = false
let boardError = ''
let ticketGroupError = ''
let ticketGroupOpen = 0
let ticketReturnFocus: HTMLElement | null = null
interface TicketDraft {
  notice: string
  editTitle?: string
  editRevision?: number
  editCommandId?: string
  deleteRevision?: number
}
interface CreateTicketDraft extends TicketDraft {
  deviceId: string
  template: string
  title: string
  detail: string
  commandId?: string
}
let ticketDraft: TicketDraft = { notice: '' }
let createTicketDraft: CreateTicketDraft | null = null
const ticketWrites = new TicketWrites()
const ticketKey = (ticket: TicketRef) => ticketWriteKey(ticket.deviceId, ticket.id)
const boardReceipt = (id?: string) => boardReceipts.find(row => row.id === id)
const deviceName = (id: string) => state.devices.find(device => device.id === id)?.name ?? id
const rev = (revision: number | undefined) => el('span', { class: 'ticket-revision', text: `rev #${revision ?? '—'}` })

function resetTicketBoard(): void {
  ticketNav = { view: 'list' }
  ticketDraft = { notice: '' }
  createTicketDraft = null
  ticketReturnFocus = null
  ticketWrites.clear()
  boardLoaded = false
  boardError = boardQuery = ''
  boardFilter = 'all'
}

function selectedTicket(): Ticket | undefined {
  const nav = ticketNav
  return nav.view === 'list' ? undefined : boardTasks.find(task => ticketKey(task) === ticketKey(nav.ticket))
}

function receiptLabel(commandId?: string, deviceId?: string): string {
  const receipt = boardReceipt(commandId)
  if (!receipt) {
    // Server receipts do not expose task IDs. Label a device-level fallback explicitly.
    const latest = !commandId && boardReceipts.find(row => row.deviceId === deviceId)
    if (latest) return '本机最近操作：' + receiptLabel(latest.id)
    return commandId ? '未找到回执。请核对当前看板再操作。' : '暂无回执'
  }
  const reason = receipt.code && BOARD_RECEIPT_REASON[receipt.code]
  return `${BOARD_RECEIPT_ACTION[receipt.action]} · ${BOARD_RECEIPT_STATE[receipt.state]}${reason ? `（${reason}）` : ''}`
}

function writeStatus(write?: TicketWriteState, deviceId?: string): string {
  if (write?.phase === 'submitting') return '正在提交…'
  if (write?.phase === 'refreshing') return [write.notice, '请同步看板以核对结果。'].filter(Boolean).join(' ')
  return write?.notice || receiptLabel(write?.commandId, deviceId)
}

function retryTicketSync(write?: TicketWriteState): HTMLElement | null {
  return write?.phase === 'refreshing'
    ? button('同步看板', () => { void loadBoard() }, { id: 'ticket-sync', type: 'button' }) : null
}

async function writeBoard(
  draft: TicketDraft,
  body: { deviceId: string; baseRevision: number; action: BoardReceipt['action']; taskId?: string; [key: string]: unknown },
  onAccepted: (commandId?: string) => void,
): Promise<void> {
  const api = phoneApi()
  if (!api) return
  const key = ticketWriteKey(body.deviceId, body.taskId)
  if (boardRevisions[body.deviceId] !== body.baseRevision) {
    draft.notice = '看板修订已更新，请核对后重试。'
    draft.deleteRevision = undefined
    updateTicketSheet(true)
    return
  }
  const attempt = ticketWrites.begin(key, boardReceipt(ticketWrites.get(key)?.commandId)?.state)
  if (!attempt) return
  draft.notice = ''
  updateTicketSheet(true)
  const result = await api.boardWrite(body)
  if (state.api !== api) return
  ticketWrites.finish(key, attempt, result.ok
    ? { commandId: result.data.commandId, notice: result.data.commandId ? undefined : '未收到回执编号。请核对当前看板。' }
    : { notice: result.error === 'conflict' ? '看板已被别的修改抢先，请核对后再改。'
      : (result.code && BOARD_RECEIPT_REASON[result.code]) || result.message })
  if (result.ok) {
    onAccepted(result.data.commandId)
  }
  updateTicketSheet()
  await loadBoard(true)
}

function boardHost(): string {
  const selected = state.deviceId
  const id = selected && boardRevisions[selected] !== undefined ? selected
    : Object.keys(boardRevisions)[0] ?? selected ?? state.devices[0]?.id
  return id || ''
}

function refreshTicketList(): void {
  const list = rootNode().querySelector('.ticket-list')
  if (!list) return
  const ids = Object.keys(boardRevisions)
  const host = boardHost()
  const summary = rootNode().querySelector('.ticket-summary')
  summary?.replaceChildren(document.createTextNode(host ? `工作区 · ${deviceName(host)}${ids.length > 1 ? ` · ${ids.length} 台主机` : ''} · ` : '工作区 · 暂无主机 · '), rev(boardRevisions[host]))
  const rows = filterTickets(boardTasks, boardFilter, boardQuery)
  const focusedKey = (document.activeElement as HTMLElement | null)?.dataset.ticketKey
  list.replaceChildren()
  if (!phoneApi()) list.append(el('p', { class: 'banner', text: '请在节点页扫描电脑配对码，以管理工单。' }))
  else if (!state.online) list.append(el('p', { class: 'banner', text: '当前离线，显示最近同步的工单。' }))
  if (boardError) list.append(el('div', { class: 'banner error' }, el('p', { text: boardError }), button('重试', () => { void loadBoard() })))
  for (const task of rows) {
    const card = el('button', { type: 'button', class: 'card ticket-card', 'data-ticket-key': ticketKey(task),
      onClick: () => openTicket(task, card) },
      el('span', { class: `chip ticket-status ${ticketFilter(task.status) ?? ''}`, text: BOARD_STATUS_LABELS[task.status] ?? task.status }),
      el('strong', { text: task.title }), rev(task.revision),
      el('span', { class: 'ticket-card-footer', text: '工单详情 / 工单群 ›' }))
    list.append(card)
    if (focusedKey === ticketKey(task)) card.focus({ preventScroll: true })
  }
  if (phoneApi() && !rows.length && !boardError) list.append(el('p', { class: 'empty', text:
    !boardLoaded ? '正在读取工单…' : boardTasks.length ? '没有符合条件的工单。' : '暂无工单。' }))
}

function boardView(): Child[] {
  const create = button('', () => openCreateTicket(create), { class: 'primary ticket-add', 'aria-label': '新建编排工单' })
  create.append(tabIcon('plus'))
  const search = el('input', { type: 'search', value: boardQuery, placeholder: '搜索工单', 'aria-label': '搜索工单',
    onInput: () => { boardQuery = search.value; refreshTicketList() } })
  const filters = el('div', { class: 'ticket-filters', role: 'group', 'aria-label': '筛选工单' },
    ...(Object.keys(TICKET_FILTERS) as TicketFilter[]).map(key => {
      const item = button(TICKET_FILTERS[key], () => {
        boardFilter = key
        filters.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false')
        item.setAttribute('aria-pressed', 'true')
        refreshTicketList()
      }, { 'aria-pressed': key === boardFilter })
      return item
    }))
  const header = topbar('工单', '', [create])
  header.querySelector('.title span')?.classList.add('ticket-summary')
  return [header, search, filters, el('section', { class: 'ticket-list', 'aria-label': '工单列表' })]
}

function openTicket(task: Ticket, trigger: HTMLElement): void {
  ticketReturnFocus = trigger
  ticketDraft = { notice: '' }
  ticketNav = reduceTicketNavigation(ticketNav, { type: 'open', ticket: { deviceId: task.deviceId, id: task.id } })
  updateTicketSheet()
}

function openCreateTicket(trigger: HTMLElement): void {
  ticketReturnFocus = trigger
  const host = boardHost()
  createTicketDraft = { deviceId: boardRevisions[host] === undefined ? Object.keys(boardRevisions)[0] ?? '' : host,
    template: TICKET_TEMPLATES[0].id, title: '', detail: '', notice: '' }
  updateTicketSheet()
}

function closeTicketSheet(): void {
  ticketNav = reduceTicketNavigation(ticketNav, { type: 'close' })
  createTicketDraft = null
  const dialog = rootNode().querySelector<HTMLDialogElement>('.ticket-sheet')
  dialog?.close()
  dialog?.remove()
  if (ticketReturnFocus?.isConnected) ticketReturnFocus.focus()
  else {
    const key = ticketReturnFocus?.dataset.ticketKey
    const card = Array.from(rootNode().querySelectorAll<HTMLElement>('.ticket-card')).find(node => node.dataset.ticketKey === key)
    const fallback = card ?? rootNode().querySelector<HTMLElement>('.ticket-add')
    fallback?.focus()
  }
  ticketReturnFocus = null
}

let sheetSnapshot = ''
function updateTicketSheet(force = false): void {
  if (state.view !== 'board' || (!createTicketDraft && ticketNav.view !== 'detail')) return
  const task = selectedTicket()
  const create = createTicketDraft
  const deviceId = create?.deviceId ?? (ticketNav.view !== 'list' ? ticketNav.ticket.deviceId : '')
  const write = ticketWrites.get(ticketWriteKey(deviceId, create || ticketNav.view === 'list' ? undefined : ticketNav.ticket.id))
  const receipt = boardReceipt(write?.commandId)
  const snapshot = JSON.stringify(create ? [boardRevisions, state.devices.map(d => d.name), write, receipt]
    : [task, boardRevisions[deviceId], deviceName(deviceId), write, receipt, writeStatus(write, deviceId)])
  let dialog = rootNode().querySelector<HTMLDialogElement>('.ticket-sheet')
  if (dialog && !force && snapshot === sheetSnapshot) return
  sheetSnapshot = snapshot
  const active = dialog?.contains(document.activeElement) ? document.activeElement as HTMLElement : null
  const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null
  const scroll = dialog?.scrollTop ?? 0
  if (!dialog) {
    dialog = el('dialog', { class: 'ticket-sheet', 'aria-labelledby': 'ticket-sheet-title' })
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeTicketSheet() })
    dialog.addEventListener('click', event => { if (event.target === dialog) closeTicketSheet() })
    rootNode().append(dialog)
  }
  dialog.replaceChildren(
    el('header', { class: 'ticket-sheet-header' }, el('div', { class: 'ticket-handle', 'aria-hidden': 'true' }),
      el('div', { class: 'row-between' }, el('h2', { id: 'ticket-sheet-title', text: create ? '新建编排工单' : '工单详情' }),
        button('关闭', closeTicketSheet, { id: 'ticket-sheet-close', autofocus: true }))),
    create ? createTicketForm(create, write) : ticketDetails(task, write),
  )
  if (!dialog.open) dialog.showModal()
  else if (active) {
    const next = active.id ? document.getElementById(active.id) : null
    const focus = next && !(next as HTMLInputElement).disabled ? next : dialog.querySelector<HTMLElement>('#ticket-sheet-close')
    focus?.focus({ preventScroll: true })
    if (selection && (focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement)) focus.setSelectionRange(selection[0], selection[1])
  }
  dialog.scrollTop = scroll
}

function createTicketForm(draft: CreateTicketDraft, write?: TicketWriteState): HTMLElement {
  const revision = boardRevisions[draft.deviceId]
  const disabled = ticketWriteBlocked(write, boardReceipt(write?.commandId)?.state)
    || boardReceipt(draft.commandId)?.state === 'applied'
  const device = el('select', { id: 'ticket-device', disabled: write?.phase === 'submitting', onChange: () => {
    draft.deviceId = device.value; draft.commandId = undefined; draft.notice = ''; updateTicketSheet(true)
  } },
    ...Object.keys(boardRevisions).map(id => el('option', { value: id, text: deviceName(id) })))
  device.value = draft.deviceId
  const template = el('select', { id: 'ticket-template', disabled, onChange: () => { draft.template = template.value } },
    ...TICKET_TEMPLATES.map(item => el('option', { value: item.id, text: `${item.label} · ${item.roles}` })))
  template.value = draft.template
  const title = el('input', { id: 'ticket-title', type: 'text', value: draft.title, required: true, maxlength: 120, disabled, onInput: () => { draft.title = title.value } })
  const detail = el('textarea', { id: 'ticket-description', value: draft.detail, maxlength: 2000, disabled, onInput: () => { draft.detail = detail.value } })
  const field = (label: string, control: HTMLElement) => el('label', { class: 'ticket-field' }, label, control)
  return el('form', { class: 'ticket-sheet-body', onSubmit: event => {
    event.preventDefault()
    if (disabled || revision === undefined || !draft.title.trim()) return
    void writeBoard(draft, { action: 'create', deviceId: draft.deviceId, baseRevision: revision,
      template: draft.template, title: draft.title.trim(), detail: draft.detail.trim() }, id => { draft.commandId = id })
  } }, field('目标设备', device), rev(revision), field('编排模板', template), field('工单标题', title), field('需求描述', detail),
  el('p', { class: 'notice', text: '当前看板仅同步标题，不保存模板或需求描述，也不会自动建群。' }),
  el('p', { role: 'status', text: draft.notice || (write ? writeStatus(write) : revision === undefined ? '等待设备上报看板修订。' : '') }),
  retryTicketSync(write),
  el('button', { type: 'submit', class: 'primary', disabled: disabled || revision === undefined, text: '创建工单' }))
}

function ticketDetails(task: Ticket | undefined, write?: TicketWriteState): HTMLElement {
  const draft = ticketDraft
  const ref = ticketNav.view === 'list' ? undefined : ticketNav.ticket
  const receipt = boardReceipt(write?.commandId)
  const status = draft.notice || writeStatus(write, ref?.deviceId)
  if (!task) return el('div', { class: 'ticket-sheet-body' }, el('p', { text: '该工单已不在当前看板。' }), el('p', { role: 'status', text: status }))
  const revision = boardRevisions[task.deviceId]
  const blocked = revision === undefined || ticketWriteBlocked(write, receipt?.state)
  const send = (action: 'move' | 'edit' | 'delete', fields: Record<string, unknown> = {}) => {
    if (blocked || revision === undefined) return
    void writeBoard(draft, { ...fields, action, deviceId: task.deviceId, taskId: task.id, baseRevision: revision }, id => {
      if (action === 'edit') draft.editCommandId = id
      draft.deleteRevision = undefined
    })
  }
  const stage = ticketStageIndex(task.status)
  const preview = parseDiffPreview(task.detail)
  const diff = el('pre', { class: 'ticket-diff', tabindex: '0', 'aria-label': '补丁预览' })
  for (const [index, line] of preview.lines.entries()) {
    if (index) diff.append('\n')
    diff.append(el('span', { class: `diff-${line.type}`, text: line.text }))
  }
  if (draft.editCommandId && receipt && receipt.id === draft.editCommandId && receipt.state !== 'queued') {
    if (receipt.state === 'applied') draft.editTitle = undefined
    draft.editCommandId = undefined
  }
  const editing = draft.editTitle !== undefined
  const deleting = draft.deleteRevision !== undefined && draft.deleteRevision === revision
  const title = el('input', { id: 'ticket-edit-title', type: 'text', value: draft.editTitle, maxlength: 120, required: true,
    disabled: blocked, 'aria-label': '新工单标题', onInput: () => { draft.editTitle = title.value } })
  return el('div', { class: 'ticket-sheet-body' },
    el('h3', { text: task.title }), el('div', { class: 'ticket-meta' }, `${deviceName(task.deviceId)} · ${task.id} · `, rev(task.revision)),
    el('ol', { class: 'ticket-stages', 'aria-label': '执行阶段' }, ...TICKET_STAGES.map((label, index) =>
      el('li', { class: index <= stage ? 'reached' : '', 'aria-current': index === stage ? 'step' : undefined, text: label }))),
    el('section', {}, el('h3', { text: '需求详情' }), el('p', { class: 'ticket-requirements', text: task.detail || '暂无需求描述。' })),
    preview.lines.length || preview.truncated ? el('section', {}, el('h3', { text: '补丁 / Diff 预览' }), diff,
      preview.truncated ? el('p', { class: 'notice', text: '补丁预览已截断。' }) : null) : null,
    el('p', { role: 'status', text: '最近回执 · ' + status }),
    retryTicketSync(write),
    button(task.roomId ? '进入工单群查看各 Agent 讨论 ›' : '查看工单讨论 · 尚未关联群聊 ›',
      () => enterTicketGroup(task), { class: 'ticket-group-link block' }),
    el('footer', { class: 'ticket-sheet-actions' },
      el('p', { class: 'ticket-meta' }, '看板修订 · ', rev(revision)),
      button('确认完成', () => send('move', { status: 'done' }), { id: 'ticket-done', class: 'primary block', disabled: blocked || task.status === 'done' }),
      el('div', { class: 'choices' },
        button('移回进行中', () => send('move', { status: 'doing' }), { id: 'ticket-doing', disabled: blocked }),
        button('移回待办', () => send('move', { status: 'todo' }), { id: 'ticket-todo', disabled: blocked })),
      editing ? el('form', { class: 'ticket-field', onSubmit: event => {
        event.preventDefault()
        const text = draft.editTitle?.trim()
        if (text) send('edit', { title: text })
      } }, title, draft.editRevision !== revision ? el('p', { class: 'notice', text: '看板已更新，请核对当前标题再保存。' }) : null,
      el('div', { class: 'choices' }, el('button', { type: 'submit', id: 'ticket-save', text: draft.editRevision !== revision ? '确认新修订并保存' : '保存标题', disabled: blocked }),
        button('取消编辑', () => { draft.editTitle = undefined; updateTicketSheet(true) }, { type: 'button' }))) :
        button('编辑标题', () => { draft.editTitle = task.title; draft.editRevision = revision; draft.deleteRevision = undefined; updateTicketSheet(true); document.getElementById('ticket-edit-title')?.focus() }, { disabled: blocked }),
      el('div', { class: 'choices' }, button(deleting ? '确认删除工单' : '删除工单', () => {
        if (deleting) send('delete')
        else { draft.deleteRevision = revision; updateTicketSheet(true) }
      }, { id: 'ticket-delete', class: 'danger', disabled: blocked }),
      deleting ? button('取消删除', () => { draft.deleteRevision = undefined; updateTicketSheet(true) }) : null)))
}

function enterTicketGroup(task: Ticket): void {
  ticketNav = reduceTicketNavigation(ticketNav, { type: 'enter-group' })
  state.view = 'ticketGroup'
  state.room = null
  state.groupDraft = state.groupError = groupKey = ''
  state.groupBusy = false
  ticketGroupError = ''
  render()
  void loadTicketGroup(task)
}

function returnToTicket(): void {
  ticketGroupOpen++
  state.room = null
  state.groupBusy = false
  state.view = 'board'
  ticketDraft.deleteRevision = undefined
  ticketNav = reduceTicketNavigation(ticketNav, { type: 'back' })
  render()
}

async function loadTicketGroup(task: Ticket): Promise<void> {
  // Current Hub snapshots do not serialize roomId. Never infer a room from
  // its title or a coincidentally equal ID in a separate namespace.
  if (!task.roomId) return
  const api = phoneApi()
  if (!api) return
  const request = ++ticketGroupOpen
  const current = () => state.view === 'ticketGroup' && request === ticketGroupOpen && state.api === api
  ticketGroupError = '正在查找关联的工单群…'
  render()
  const result = await api.discussion(task.roomId)
  if (!current()) return
  const room = result.ok ? parseRoom(result.data) : null
  state.room = room?.id === task.roomId ? room : null
  ticketGroupError = result.ok ? '未能读取关联的群聊。' : result.message
  render()
  if (state.room) startGroupPoll()
}

function ticketGroupView(): Child[] {
  const task = selectedTicket()
  const back = button('工单详情', returnToTicket, { class: 'ticket-group-back' })
  back.prepend(backChevron())
  const header = topbar('工单群', task ? `${task.id} · ${task.title}` : '会话',
    [button('确认操作', returnToTicket, { class: 'icon-button' })], back)
  if (state.room) return groupRoomView(header)
  return [header, el('section', { class: 'card' }, el('h2', { text: task?.title ?? '该工单已不在当前看板' }),
    el('p', { role: 'status', text: task ? ticketGroupError || '该工单没有已同步的群聊关联，暂无法查看 Agent 讨论。' : '请返回工单列表。' }),
    task?.roomId && !ticketGroupError.startsWith('正在') ? button('重试读取群聊', () => { void loadTicketGroup(task) }) : null)]
}

async function loadMemory(): Promise<void> {
  const api = phoneApi()
  if (!api) { toast('记忆需要手机配对凭证', 'error'); return }
  clearTimeout(memoryPoll)
  const load = ++memoryLoad
  const result = await api.memory()
  if (load !== memoryLoad || state.api !== api || !showingMemory()) return
  const nodes = result.ok ? toGalaxyNodes(result.data) : []
  const entries = configReadError || state.config?.privacyMode === 'metadata' ? nodes.map(maskMemoryNode) : nodes
  const changed = JSON.stringify(entries) !== JSON.stringify(memoryEntries)
  memoryEntries = entries
  if (!result.ok) toast(result.message, 'error')
  else memoryPoll = setTimeout(() => { if (showingMemory()) void loadMemory() }, 15_000)
  if (changed) render()
}

function maskMemoryNode(node: GalaxyNode): GalaxyNode {
  return { ...node, title: '记忆条目', text: '', cue: '', tags: [] }
}

function memoryView(): Child[] {
  return [
    topbar('记忆', '只读', [button('刷新', () => { void loadMemory() }, { class: 'icon-button' })], backButton('home')),
    button('前往智能体的记忆星系', () => {
      agentsSegment = 'memory'; memoryMember = null; memoryLayer = 'all'; memoryMode = 'galaxy'
      state.view = 'agents'; render(); void loadMemory()
    }),
    ...memoryContent(),
  ]
}

function memoryContent(): Child[] {
  const inAgents = state.view === 'agents'
  const member = inAgents ? memoryMember : null
  const nodes = memoryEntries.filter(node =>
    (!inAgents || memoryLayer === 'all' || memoryLayer === node.layer)
    && (!member || (member.deviceId === node.deviceId && member.id === node.agent)))
  const galaxy = inAgents && memoryMode === 'galaxy'
  const visible = galaxy ? nodes.slice(0, GALAXY_NODE_LIMIT) : nodes
  if (!visible.some(n => n.id === selectedMemory)) selectedMemory = visible[0]?.id ?? ''
  const inspector = el('section', { class: 'card memory-inspector', 'aria-label': '记忆详情', 'aria-live': 'polite' })
  const list = el('div', { class: 'card memory-list', role: 'group', 'aria-label': '记忆列表' })
  const inspect = (id: string) => {
    selectedMemory = id
    clear(inspector)
    const node = visible.find(n => n.id === id)
    if (!node) {
      inspector.append(el('p', { class: 'empty', text: member
        ? memoryEntries.length && memoryEntries.every(entry => !entry.agent)
          ? '当前只读快照未标注智能体。清除筛选可查看全部条目，包括未标注条目。'
          : '当前只读快照在此范围没有明确归属于该成员的条目。清除筛选可查看全部条目，包括未标注条目。'
        : '此范围暂无可读记忆。正文共享由电脑端授权。' }))
      return
    }
    const meta = MEMORY_KIND_META[node.kind]
    inspector.append(
      el('div', { class: 'memory-meta' }, memoryTypeDot(node), `${meta.label} · ${CLARITY_LABELS[node.clarity]}`
        + (node.pinned ? ' · 已固定' : '') + (node.pending ? ' · 待审批' : '')),
      el('h2', { text: node.title }),
      el('p', { class: 'memory-meta', text: [MEMORY_LAYERS[node.layer], node.deviceId ? deviceName(node.deviceId) : '未标注设备',
        (roster.find(item => item.id === node.agent && item.deviceId === node.deviceId)?.name ?? node.agent) || '未标注智能体'].join(' · ') }),
      ...(node.cue ? [el('p', { text: '触发场景：' + node.cue })] : []),
      ...(node.tags.length ? [el('p', { class: 'memory-meta', text: node.tags.map(tag => '#' + tag).join(' · ') })] : []),
      el('p', { class: 'memory-body', text: node.text || (configReadError ? '无法确认本机隐私设置，已隐藏正文。' : state.config?.privacyMode === 'metadata' ? '根据本机隐私设置隐藏正文。' : '快照未提供正文。') }),
    )
  }
  const select = (id: string) => {
    if (id === selectedMemory) return
    inspect(id)
    for (const b of list.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.memoryId === id))
  }
  inspect(selectedMemory)
  let content: HTMLElement | null = null
  if (galaxy) {
    const canvas = el('canvas', { 'aria-label': '记忆星系。可切换列表，用键盘选择记忆。', role: 'img' }, '浏览器不支持 Canvas，请切换列表。')
    const plus = el('button', { type: 'button', text: '+', 'aria-label': '放大' })
    const minus = el('button', { type: 'button', text: '−', 'aria-label': '缩小' })
    const reset = el('button', { type: 'button', text: '重置', 'aria-label': '重置星系视角' })
    content = el('section', { id: 'memory-galaxy', 'aria-label': '3D 记忆星系' }, canvas,
      el('div', { class: 'galaxy-controls' }, plus, minus, reset))
    disposeGalaxy = mountGalaxyCanvas(canvas, layoutMemoryGalaxy(buildMemoryGraph(visible)), galaxyCamera,
      () => selectedMemory, select, { plus, minus, reset })
  } else if (visible.length) {
    content = list
    for (const node of visible) list.append(el('button', {
      type: 'button', class: 'memory-row', 'data-memory-id': node.id,
      'aria-pressed': String(node.id === selectedMemory), onClick: () => select(node.id),
    }, memoryTypeDot(node), el('span', { text: node.title }),
    el('small', { text: `${MEMORY_LAYERS[node.layer]} · ${MEMORY_KIND_META[node.kind].label}` })))
  }
  return [
    inAgents ? el('div', { class: 'memory-filters' },
      chatSegments('记忆视图', [['galaxy', '3D 星系'], ['list', '列表']], memoryMode, mode => {
        if (mode !== memoryMode) { memoryMode = mode; render() }
      }),
      chatSegments('记忆层级', [['all', '全部'], ['global', '全局'], ['workspace', '工作区'], ['private', '私有']], memoryLayer, layer => {
        if (layer !== memoryLayer) { memoryLayer = layer; render() }
      }),
      member ? el('div', { class: 'row-between memory-member-filter' },
        el('span', { text: `成员：${member.name}` }),
        button('清除筛选', () => { memoryMember = null; memoryLayer = 'all'; render(); rootNode().querySelector<HTMLElement>('.memory-filters button')?.focus() })) : null,
    ) : null,
    el('p', { class: 'memory-meta', text: 'Hub 只读快照 · 手机端无法批准、编辑或删除记忆' }),
    content,
    galaxy && nodes.length > visible.length ? el('p', { class: 'memory-meta', text: `星系显示 ${visible.length} / ${nodes.length} 条 · 切换列表查看全部` }) : null,
    inspector,
  ]
}

function memoryTypeDot(node: GalaxyNode): HTMLElement {
  const dot = el('span', { class: 'memory-kind-dot', 'aria-hidden': 'true' })
  dot.style.setProperty('--memory-kind', MEMORY_KIND_META[node.kind].color)
  return dot
}

async function loadRooms(notify = false): Promise<void> {
  const config = state.config
  const api = phoneApi()
  if (!config) { state.view = 'setup'; render(); return }
  if (!api) {
    state.groupError = '群聊使用手机配对凭证。请先扫电脑上的配对码。'
    state.roomList = []
    state.catalog = []
    if (state.view === 'groups') render()
    return
  }
  state.groupBusy = true
  state.groupError = ''
  if (state.view === 'groups') render()
  const result = await api.discussions()
  state.groupBusy = false
  if (!result.ok) {
    state.groupError = result.message
    if (result.error === 'unauthorized') {
      await clearAccount('账号会话已失效，请重新生成 ticket')
      return
    }
    if (state.view === 'groups') render()
    return
  }
  const listed = parseRoomList(result.data)
  state.roomList = listed.rooms
  state.catalog = listed.catalog
  if (notify) toast('群聊已刷新')
  if (state.view === 'groups') render()
}

let roomOpen = 0
let requestedRoomId: string | null = null

async function openRoom(roomId: string, category: 'group' | 'ticketRoom'): Promise<void> {
  const api = phoneApi()
  if (!api) return
  stopGroupPoll()
  requestedRoomId = roomId
  sessionCategory = category
  state.room = null
  state.groupError = ''
  state.groupDraft = ''
  groupKey = ''
  const request = ++roomOpen
  state.view = 'groupRoom'
  state.groupBusy = true
  render()
  const result = await api.discussion(roomId)
  if (state.api !== api || state.view !== 'groupRoom' || request !== roomOpen) return
  state.groupBusy = false
  if (!result.ok) {
    state.groupError = result.message
    if (result.error === 'unauthorized') {
      await clearAccount('账号会话已失效，请重新生成 ticket')
      return
    }
    render()
    return
  }
  const room = parseRoom(result.data)
  state.room = room?.id === roomId ? room : null
  if (!state.room) state.groupError = '未能读取群聊。'
  render()
  if (state.room) startGroupPoll()
}

async function refreshRoom(silent = false): Promise<void> {
  const api = phoneApi()
  const room = state.room
  if (!api) return
  const retry = !silent && state.view === 'groupRoom' ? roomRetryId(room, requestedRoomId, state.groupBusy) : null
  if (retry) { await openRoom(retry, sessionCategory === 'ticketRoom' ? 'ticketRoom' : 'group'); return }
  if (!room || state.groupBusy) return
  const generation = groupPollGeneration
  const view = state.view
  if (!silent) state.groupBusy = true
  const result = await api.discussion(room.id)
  if (state.api !== api || state.room?.id !== room.id || groupPollGeneration !== generation || state.view !== view) return
  if (!silent) state.groupBusy = false
  if (!result.ok) {
    if (state.view === 'ticketGroup') {
      if (result.error === 'unauthorized') {
        state.room = null
        stopGroupPoll()
        ticketGroupError = result.message
        rootNode().querySelector('[data-group-transcript]')?.replaceChildren(
          el('p', { class: 'banner error', role: 'status', text: ticketGroupError }))
        rootNode().querySelector<HTMLButtonElement>('[data-group-send]')?.setAttribute('disabled', '')
      }
      return
    }
    if (result.error === 'unauthorized') {
      await clearAccount('账号会话已失效，请重新生成 ticket')
      return
    }
    if (!silent) toast(result.message, 'error')
    return
  }
  const updated = parseRoom(result.data)
  if (updated && state.room?.id === updated.id && updated.revision >= state.room.revision) {
    state.room = updated
    if (view === 'ticketGroup' || view === 'groupRoom') updateGroupMessages(updated)
  }
}

async function sendGroupMessage(): Promise<void> {
  const api = phoneApi()
  const room = state.room
  if (!api || !room || state.groupBusy) return
  const text = state.groupDraft.trim()
  if (!text) return
  if (room.state !== 'idle' || room.cleared || room.rounds >= 3) {
    toast('此群当前不可发送', 'error')
    return
  }
  if (!groupKey) groupKey = newIdempotencyKey()
  state.groupBusy = true
  render()
  const result = await api.discussionAction(buildSendPayload(room.id, text, groupKey, room.moderatorId))
  if (state.api !== api || state.room?.id !== room.id) return
  state.groupBusy = false
  if (!result.ok) {
    toast(result.message + '。这次发送会沿用同一个幂等键。', 'error')
    render()
    return
  }
  groupKey = ''
  state.groupDraft = ''
  const updated = result.data.room ? parseRoom(result.data.room) : null
  if (updated) state.room = updated
  else await refreshRoom(true)
  render()
}

async function stopRoom(): Promise<void> {
  const api = phoneApi()
  const room = state.room
  if (!api || !room) return
  state.groupBusy = true
  render()
  const result = await api.discussionAction({ action: 'stop', roomId: room.id })
  if (state.api !== api || state.room?.id !== room.id) return
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
  if (sessionCategory === 'single') return sessionsView()
  const ticketRooms = new Map(boardTasks.flatMap(task => task.roomId ? [[task.roomId, task] as const] : []))
  if (sessionCategory === 'ticketRoom') {
    const rooms = filterSessionsByCategory([...ticketRooms].map(([id, task]) => ({
      kind: 'group' as const, ticketRoom: true, id, task,
    })), 'ticketRoom')
    return [
      ...chatCenterHeader('工单关联会话'),
      el('section', { class: 'card' },
        boardError ? el('p', { class: 'banner error', text: boardError }) : null,
        ...rooms.map(({ id, task }) => button(task.title, () => { void openRoom(id, 'ticketRoom') }, { class: 'session' })),
        rooms.length ? null : el('p', { class: 'empty', text: !phoneApi() ? '请先扫描电脑配对码。'
          : !boardLoaded && !boardError ? '正在读取工单群…' : '暂无已关联群聊的工单。' }),
        phoneApi() ? button('刷新工单群', () => { void loadBoard() }, { class: 'block' }) : null),
    ]
  }
  const account = state.account
  const header = chatCenterHeader(phoneApi() ? '手机凭证' : '未配对')
  if (!phoneApi() || !account || !accountUsable()) {
    return [
      ...header,
      el('div', { class: 'card' },
        el('h2', { text: '需要手机配对凭证' }),
        el('p', { class: 'empty', text: state.groupError || '请扫描电脑上的配对码，或在设置中登录。' }),
        button('去设置', () => { state.view = 'settings'; render() }, { class: 'primary block' }),
      ),
    ]
  }
  const banners: Child[] = []
  if (state.groupError) banners.push(el('div', { class: 'banner error', text: state.groupError }))
  const listed = filterSessionsByCategory(state.roomList.map(room => ({ ...room, kind: 'group' as const, ticketRoom: ticketRooms.has(room.id) })), 'group')
  const rooms = listed.map((room) => el('button', {
    class: 'session',
    onClick: () => { void openRoom(room.id, 'group') },
  },
  el('span', { class: 'dot' + (room.state === 'running' ? ' online' : '') }),
  el('span', { class: 'copy' },
    el('strong', { text: room.title }),
    el('span', { text: groupStateLabel(room.state) + ' · ' + formatTime(room.createdAt) }),
  ),
  el('span', { class: 'state' + (room.state === 'running' ? ' running' : ''), text: groupStateLabel(room.state) }),
  ))
  return [
    ...header,
    ...banners,
    el('div', { class: 'card' },
      el('h2', { text: '房间（' + rooms.length + '）' }),
      ...(rooms.length > 0 ? rooms : [el('p', { class: 'empty', text: state.groupBusy ? '读取群聊…' : '暂无群聊房间。' })]),
      button('刷新群聊', () => { void loadRooms(true) }, { class: 'block' }),
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

function groupMessageNodes(room: DiscussionRoom): HTMLElement[] {
  return room.messages.length ? room.messages.map(message => groupMessageNode(room, message))
    : [el('p', { class: 'empty', text: '暂无群聊消息。' })]
}

const canComposeGroup = (room: DiscussionRoom) => room.state === 'idle' && !room.cleared && room.rounds < 3
const groupRetention = (room: DiscussionRoom) => '内容保留至 ' + (room.expiresAt ? new Date(room.expiresAt).toLocaleTimeString('zh-CN') : '—') + (room.cleared ? ' · 正文已清除' : '')
const groupProgress = (room: DiscussionRoom) => groupStateLabel(room.state) + ' · 第 ' + room.rounds + '/3 轮'

function updateGroupMessages(room: DiscussionRoom): void {
  const app = rootNode()
  app.querySelector('[data-group-transcript]')?.replaceChildren(...groupMessageNodes(room))
  const send = app.querySelector<HTMLButtonElement>('[data-group-send]')
  if (send) send.disabled = !canComposeGroup(room)
  const retention = app.querySelector('[data-group-retention]')
  if (retention) retention.textContent = groupRetention(room)
  const progress = app.querySelector('[data-group-progress]')
  if (progress) progress.textContent = groupProgress(room)
}

function groupRoomView(ticketHeader?: HTMLElement): Child[] {
  const room = state.room
  const config = state.config
  const account = state.account
  if (!ticketHeader && sessionCategory !== 'ticketRoom' && (!config || !account || !accountUsable())) {
    setSessionCenterRoute('group')
    return groupsView()
  }
  const header = ticketHeader ?? topbar(room ? room.title : '群聊', room ? groupProgress(room) : state.groupError ? '读取失败' : '读取中…', [
    button('刷新', () => { void refreshRoom() }, { class: 'icon-button', disabled: !room && state.groupBusy }),
    room && room.state !== 'closed' ? button('停止', () => { void stopRoom() }, { class: 'icon-button danger' }) : null,
  ], backButton(returnToGroups))
  if (!room) {
    return [header, el('div', { class: 'card' }, el('p', { class: state.groupError ? 'banner error' : 'empty', role: 'status', text: state.groupError || '读取群聊…' }))]
  }
  if (!ticketHeader) header.querySelector('.title span')?.setAttribute('data-group-progress', '')
  const members = room.members.map((member) => el('span', {
    class: 'chip' + (member.id === room.moderatorId ? ' on' : ''),
    text: member.name + ' · ' + member.model.agent + (member.id === room.moderatorId ? ' · 主持' : ''),
  }))
  const composable = canComposeGroup(room)
  const input = el('input', {
    type: 'text',
    placeholder: '补充问题，由主持人继续组织…',
    value: state.groupDraft,
    maxlength: 8192,
    onInput: (event: Event) => { state.groupDraft = (event.target as HTMLInputElement).value },
  }) as HTMLInputElement
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) void sendGroupMessage()
  })
  const send = button(state.groupBusy ? '发送中…' : '发送', () => { void sendGroupMessage() }, {
    class: 'primary',
    'data-group-send': '',
    disabled: !composable || state.groupBusy,
  })
  return [
    header,
    ...(state.groupError ? [el('div', { class: 'banner error', text: state.groupError })] : []),
    el('div', { class: 'stat-row' }, ...members),
    el('p', { class: 'notice', 'data-group-retention': '', text: groupRetention(room) }),
    el('div', { class: 'transcript', 'data-group-transcript': '' }, ...groupMessageNodes(room)),
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
  sessionCategory = 'group'
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
  const api = phoneApi()
  if (!api || state.groupBusy) return
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
  const result = await api.discussionAction({ action: 'preview', input })
  state.groupBusy = false
  if (!result.ok) {
    toast(result.message, 'error')
    if (result.error === 'unauthorized') {
      await clearAccount('账号会话已失效，请重新生成 ticket')
      return
    }
    render()
    return
  }
  const preview = parsePreview(result.data.preview)
  if (!preview) { toast('预览结果无法识别', 'error'); render(); return }
  state.groupPreview = preview
  render()
}

async function createGroup(): Promise<void> {
  const api = phoneApi()
  const preview = state.groupPreview
  if (!api || !preview || state.groupBusy) return
  state.groupBusy = true
  render()
  const result = await api.discussionAction({ action: 'create', digest: preview.digest, key: newIdempotencyKey() })
  state.groupBusy = false
  if (!result.ok) {
    toast(result.message, 'error')
    if (result.error === 'unauthorized') {
      await clearAccount('账号会话已失效，请重新生成 ticket')
      return
    }
    render()
    return
  }
  state.room = parseRoom(result.data.room)
  requestedRoomId = state.room?.id ?? null
  state.groupPreview = null
  state.view = 'groupRoom'
  state.groupDraft = ''
  render()
  startGroupPoll()
  void loadRooms()
  toast('群聊已创建')
}

function groupNewView(): Child[] {
  if (!phoneApi()) {
    setSessionCenterRoute('group')
    return groupsView()
  }
  const header = topbar('新建群聊', '手机凭证 · 讨论模式', [], backButton(returnToGroups))
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
      class: 'session' + (picked ? ' picked' : ''), 'aria-pressed': picked,
      onClick: () => { toggleGroupChoice(item.id) },
    },
    el('span', { class: 'dot' + (picked ? ' online' : '') }),
    el('span', { class: 'copy' },
      el('strong', { text: item.deviceName + ' · ' + agentLabel(item.agent) }),
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
  const tokenInput = el('input', { type: 'password', autocomplete: 'off', value: '', placeholder: config.token ? SETTINGS_TOKEN_PLACEHOLDER : '管理令牌' }) as HTMLInputElement
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



  return [
    topbar('设置', hubLabel(config.hubUrl), [], backButton('home')),
    themeCard(),
    el('div', { class: 'card' },
      el('h2', { text: '连接' }),
      el('div', { class: 'form' },
        el('div', { class: 'field' }, el('label', { text: 'Hub 地址' }), hubInput),
        el('details', {},
          el('summary', { text: '高级：管理令牌' }),
          el('div', { class: 'field' }, tokenInput,
            el('small', { text: '管理令牌能控制这台 Hub 上的全部设备。平时用配对码，不要把令牌留在手机上。' })),
        ),
        button('测试连接', () => { void testSettings(hubInput, tokenInput, result) }, { class: 'block' }),
        button('保存', () => { void saveSettings(hubInput, tokenInput, result) }, { class: 'primary block' }),
        result,
      ),
    ),
    accountCard,
    el('div', { class: 'card' }, el('h2', { text: '安全' }), appLockRow(config),
      el('div', { class: 'row-between' },
        el('div', { class: 'label' }, el('strong', { text: '局域网工作台' }), el('span', { text: config.lanBridge ? '已打开，可连接同一网络的电脑' : '默认关闭' })),
        button(config.lanBridge ? '关闭' : '打开', () => {
          void saveConfigPatch({ lanBridge: !config.lanBridge }).then(saved => {
            adoptConfig(saved)
            render()
          }).catch(() => toast('局域网工作台偏好未能保存', 'error'))
        }, { class: 'icon-button' }),
      ),
    ),
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
  const hub = normalizeHubUrl(hubInput.value)
  if (!hub.ok) { result.textContent = hub.error; return }
  const token = resolveSettingsToken({ typed: tokenInput.value, saved: config.token, previousHub: config.hubUrl, nextHub: hub.value })
  if (!token.ok) { result.textContent = token.error; return }
  const hubChanged = hub.value !== config.hubUrl
  const patch = {
    hubUrl: hub.value,
    token: token.token,
    ...(hubChanged ? { account: null } : {}),
  }
  let next: MarshalConfig
  try {
    next = await saveConfigPatch(patch)
  } catch (error) {
    result.textContent = '保存失败：' + (error instanceof Error ? error.message : '未知错误')
    return
  }
  adoptConfig(next)
  if (hubChanged) state.account = null
  toast('已保存')
  await enterApp()
}

async function wipeData(): Promise<void> {
  await removeConfig()
  summaryCap.reset()
  clearConfigReadError()
  closeMainStream()
  stopGroupPoll()
  clearTimeout(boardPoll)
  state.config = null
  applyTheme('system')
  state.api = null
  resetTicketBoard()
  pendingInputs = createPendingInputs()
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
  adoptConfig(await saveConfigPatch({ lock }))
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
    const guard = await readPinState()
    if (guard.until > Date.now()) {
      state.pinError = '请等待 ' + Math.ceil((guard.until - Date.now()) / 1000) + ' 秒后再试'
      render()
      return
    }
    const ok = await verifyPin(pin, config.lock)
    if (!ok) {
      const failures = guard.failures + 1
      const until = Date.now() + pinDelay(failures)
      await writePinGuard(JSON.stringify({ failures, until }))
      state.pinError = 'PIN 不正确，请等待 ' + Math.ceil(pinDelay(failures) / 1000) + ' 秒'
      render()
      return
    }
    await writePinGuard(null)
    if (purpose === 'disable') {
      await persistLock(null)
      state.view = 'settings'
      render()
      toast('应用锁已关闭')
      return
    }
    state.pinError = ''
    state.pendingDeepLink = null
    await enterApp()
  }

  const press = (digit: string): void => {
    if (pinBuffer.length >= 6) return
    pinBuffer += digit
    refreshDots()
    if (pinBuffer.length === 6) void finish().catch(() => {
      pinBuffer = ''
      state.pinError = '未能保存本机应用锁，请重试。'
      render()
    })
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
