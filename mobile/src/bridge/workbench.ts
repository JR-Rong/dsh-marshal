/**
 * DSH remote-bridge workbench: the agent-first mobile surface.
 *
 * Full-screen overlay independent of the Hub views. The bridge token stays in
 * the keychain or encrypted storage. Tabs: agents,
 * sessions, task board, groups (Hub), memory (not yet served remotely).
 */
import { BridgeClient, bridgeHost, classifyPairing, pairBridge, parsePairPayload, stripBridgeToken } from '../lib/bridge.ts'
import { openQrScanner } from '../lib/scanner.ts'
import type { BridgeDevice, BridgePresetRow, BridgeRunRow, BridgeSessionRow, BridgeSquadRow, BridgeTaskRow } from '../lib/bridge.ts'
import { readBridgeRecord, writeBridgeRecord } from '../lib/storage.ts'

const STYLE_ID = 'bridge-workbench-style'

type Tab = 'agents' | 'sessions' | 'board' | 'groups' | 'memory'

interface WorkbenchOptions {
  onClose: () => void
  requestUnpair: () => Promise<boolean>
  onOpenHubGroups: () => void
  onHubPairLink?: (raw: string) => void
  onUnifiedPairLink?: (raw: string) => void
}

interface StoredBridge extends BridgeDevice {}

interface UiMessage {
  role: 'user' | 'assistant' | 'reason'
  text: string
  at: number
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'html') node.innerHTML = String(value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    else if (key === 'value' && node instanceof HTMLInputElement) node.value = String(value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(child)
  }
  return node
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.bw{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#101316;color:#e9edf1;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}',
    '.bw-head{display:flex;align-items:center;gap:10px;padding:14px 16px 10px;border-bottom:1px solid #262b31;background:#12161a}',
    '.bw-head .bw-title{flex:1;min-width:0}',
    '.bw-head .bw-title strong{display:block;font-size:17px}',
    '.bw-head .bw-title span{display:block;color:#8a95a1;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bw-head button{border:1px solid #30363d;border-radius:9px;background:#1a1f24;color:#dfe5ea;padding:6px 10px;font:inherit;font-size:12px}',
    '.bw-main{flex:1;overflow:auto;padding:12px 14px 84px}',
    '.bw-nav{position:absolute;left:0;right:0;bottom:0;display:flex;border-top:1px solid #262b31;background:#12161a;padding:6px 4px calc(6px + env(safe-area-inset-bottom))}',
    '.bw-nav button{flex:1;min-height:var(--tap-min);border:0;background:transparent;color:#8a95a1;font:inherit;font-size:11px;padding:6px 2px}',
    '.bw-nav button.active{color:var(--accent)}',
    '.bw-card{background:#171c21;border:1px solid #262e36;border-radius:13px;padding:13px;margin-bottom:10px}',
    '.bw-card h3{margin:0 0 3px;font-size:14px}',
    '.bw-card p{margin:0;color:#8a95a1;font-size:12px}',
    '.bw-card .bw-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;color:#8a95a1;font-size:11px}',
    '.bw-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--accent-border);background:var(--accent-soft);color:var(--accent);border-radius:999px;padding:2px 8px;font-size:11px}',
    '.bw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #30363d;border-radius:10px;background:#20262c;color:#e9edf1;padding:9px 12px;font:inherit;font-size:13px}',
    '.bw-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}',
    '.bw-btn.block{width:100%;margin-top:8px}',
    '.bw-empty{color:#7f8a95;font-size:12px;text-align:center;padding:18px 8px}',
    '.bw-list{display:flex;flex-direction:column;gap:8px}',
    '.bw-row{display:flex;gap:10px;align-items:flex-start;padding:11px 12px;background:#171c21;border:1px solid #262e36;border-radius:12px}',
    '.bw-row .bw-row-main{flex:1;min-width:0}',
    '.bw-row strong{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bw-row small{display:block;color:#8a95a1;font-size:11px;margin-top:3px}',
    '.bw-row .bw-row-side{color:#7f8a95;font-size:11px;white-space:nowrap}',
    '.bw-messages{display:flex;flex-direction:column;gap:10px}',
    '.bw-msg{padding:10px 12px;border-radius:12px;background:#171c21;border:1px solid #262e36;font-size:13px;white-space:pre-wrap;word-break:break-word}',
    '.bw-msg.user{background:var(--accent-soft);border-color:var(--accent-border)}',
    '.bw-msg.reason{color:#9aa5b1;font-size:12px;background:#15191d}',
    '.bw-msg .bw-role{display:block;color:#7f8a95;font-size:10px;margin-bottom:4px}',
    '.bw-compose{position:sticky;bottom:0;display:flex;gap:8px;padding:10px 0 4px;background:linear-gradient(180deg,rgba(16,19,22,0),#101316 30%)}',
    '.bw-compose textarea{flex:1;min-height:44px;max-height:120px;resize:vertical;border:1px solid #30363d;border-radius:10px;background:#171c21;color:#e9edf1;padding:9px 10px;font:inherit}',
    '.bw-pair{max-width:520px;margin:8vh auto 0}',
    '.bw-pair textarea{width:100%;min-height:110px;border:1px solid #30363d;border-radius:10px;background:#171c21;color:#e9edf1;padding:10px;font:12px/1.5 ui-monospace,monospace}',
    '.bw-pair .bw-hint{color:#8a95a1;font-size:12px;margin:8px 0}',
    '.bw-error{color:#e1ae68;font-size:12px;margin:8px 0;white-space:pre-wrap}',
    '.bw-status{color:var(--accent);font-size:11px}',
    '.bw-search{width:100%;box-sizing:border-box;border:1px solid #30363d;border-radius:10px;background:#171c21;color:#e9edf1;padding:9px 10px;font:inherit;margin-bottom:10px}',
    '.bw-board{display:flex;gap:10px;overflow-x:auto;padding-bottom:8px}',
    '.bw-col{min-width:210px;flex:0 0 210px;background:#12161a;border:1px solid #262b31;border-radius:12px;padding:8px}',
    '.bw-col h4{margin:2px 4px 8px;font-size:12px;color:#9aa5b1;display:flex;justify-content:space-between}',
    '.bw-task{background:#171c21;border:1px solid #262e36;border-radius:10px;padding:9px;margin-bottom:7px}',
    '.bw-task strong{display:block;font-size:12px;line-height:1.4}',
    '.bw-task p{margin:4px 0 0;color:#7f8a95;font-size:11px;max-height:54px;overflow:hidden}',
    '.bw-tabs{display:flex;gap:6px;overflow-x:auto;margin:2px 0 10px}',
    '.bw-tabs button{border:1px solid #30363d;background:#171c21;color:#9aa5b1;border-radius:999px;padding:5px 10px;font:inherit;font-size:11px;white-space:nowrap}',
    '.bw-tabs button.active{background:var(--accent-soft);border-color:var(--accent-border);color:var(--accent)}',
    '.bw-back{display:inline-flex;align-items:center;gap:4px;color:var(--accent);font-size:12px;margin-bottom:8px;background:none;border:0;padding:0}',
    '.bw-agent-head{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px}',
    '.bw-agent-head h3{margin:0;font-size:16px}',
    '.bw-pair-hero{text-align:center}',
    '.bw-pair-hero h3{font-size:18px;margin-bottom:4px}',
    '.bw-pair-hero p{color:var(--muted,#8a95a1);font-size:12px;margin:0 0 14px}',
    '.bw-pair-hero .bw-btn.primary{min-height:50px;font-size:15px}',
    '.bw-manual{margin-top:14px;text-align:left;border-top:1px solid #262e36;padding-top:10px}',
    '.bw-manual summary{cursor:pointer;color:#8a95a1;font-size:12px;padding:4px 0}',
    '.bw-manual textarea{width:100%;min-height:80px;margin-top:8px;border:1px solid #30363d;border-radius:10px;background:#171c21;color:#e9edf1;padding:9px;font:12px/1.5 ui-monospace,monospace}',
    '.bw-agent-head p{margin:3px 0 0;color:#8a95a1;font-size:12px}',
  ].join('\n')
  document.head.appendChild(style)
}

let bridgeCache: StoredBridge | null = null

function parseStored(raw: string | null): StoredBridge | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<StoredBridge>
    if (typeof value.url !== 'string' || typeof value.deviceToken !== 'string' || typeof value.deviceId !== 'string') return null
    return { url: stripBridgeToken(value.url), deviceToken: value.deviceToken, deviceId: value.deviceId }
  } catch {
    return null
  }
}

export async function loadBridgeDevice(): Promise<StoredBridge | null> {
  bridgeCache = parseStored(await readBridgeRecord())
  return bridgeCache
}

function readStored(): StoredBridge | null {
  return bridgeCache
}

async function store(device: StoredBridge): Promise<void> {
  bridgeCache = device
  await writeBridgeRecord(JSON.stringify(device))
}

async function unstore(): Promise<void> {
  bridgeCache = null
  await writeBridgeRecord(null)
}

/** 桥令牌只进钥匙串 / 加密存储，不进 localStorage。 */
export async function saveBridgeDevice(device: BridgeDevice): Promise<void> {
  await store({ url: stripBridgeToken(device.url), deviceToken: device.deviceToken, deviceId: device.deviceId })
}

function prettyAgentName(name: string | undefined): string {
  const raw = (name ?? '未命名智能体').trim()
  return raw.replace(/^marshal-agent:/, '').replace(/-[a-z0-9]{6}$/i, '') || raw
}

function formatWhen(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  const now = Date.now()
  if (now - at < 86_400_000) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const record = item as { type?: unknown; text?: unknown }
    if (typeof record.text === 'string' && record.text !== '') parts.push(record.text)
  }
  return parts.join('\n')
}

function messagesOfSnapshot(snapshot: unknown): UiMessage[] {
  const root = snapshot as { turns?: unknown } | null
  if (!root || !Array.isArray(root.turns)) return []
  const result: UiMessage[] = []
  for (const turn of root.turns) {
    if (!turn || typeof turn !== 'object') continue
    const entries = (turn as { entries?: unknown }).entries
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as { type?: unknown; time?: unknown; data?: unknown }
      const type = typeof record.type === 'string' ? record.type : ''
      const data = (record.data ?? {}) as Record<string, unknown>
      const at = typeof record.time === 'number' ? record.time : 0
      if (type === 'user/message') {
        const text = textOfContent(data.content)
        if (text) result.push({ role: 'user', text, at })
        continue
      }
      if (type === 'assistant/message') {
        const message = (data.message ?? {}) as { content?: unknown }
        if (Array.isArray(message.content)) {
          for (const item of message.content) {
            if (!item || typeof item !== 'object') continue
            const part = item as { type?: unknown; text?: unknown }
            const text = typeof part.text === 'string' ? part.text : ''
            if (!text) continue
            result.push({ role: part.type === 'reasoning' ? 'reason' : 'assistant', text, at })
          }
        }
      }
    }
  }
  return result.slice(-240)
}

export function hasStoredBridge(): boolean {
  return readStored() !== null
}

export function openBridgeWorkbench(options: WorkbenchOptions): void {
  document.getElementById('bridge-workbench')?.remove()
  injectStyle()
  const overlay = h('div', { id: 'bridge-workbench', class: 'bw' })
  document.body.appendChild(overlay)
  const workbench = new Workbench(overlay, options)
  void workbench.start()
}

class Workbench {
  readonly #root: HTMLElement
  readonly #options: WorkbenchOptions
  #device: StoredBridge | null = null
  #client: BridgeClient | null = null
  #tab: Tab = 'agents'
  #loading = false
  #error = ''
  #status = ''
  #sessions: BridgeSessionRow[] = []
  #presets: BridgePresetRow[] = []
  #squads: BridgeSquadRow[] = []
  #runs: BridgeRunRow[] = []
  #tasks: BridgeTaskRow[] = []
  #agentId: string | null = null
  #sessionId: string | null = null
  #messages: UiMessage[] = []
  #draft = ''
  #sending = false
  #reloadTimer: ReturnType<typeof setTimeout> | null = null

  constructor(root: HTMLElement, options: WorkbenchOptions) {
    this.#root = root
    this.#options = options
  }

  async start(): Promise<void> {
    this.#device = await loadBridgeDevice()
    this.render()
    if (this.#device) await this.connect()
  }

  async connect(): Promise<void> {
    const device = this.#device
    if (!device) { this.render(); return }
    this.#loading = true
    this.#error = ''
    this.#status = '正在连接…'
    this.render()
    const client = new BridgeClient(device, (event) => this.onEvent(event))
    this.#client = client
    try {
      await client.connect()
      const [state, sessions, presets, board] = await Promise.all([
        client.squadsState(),
        client.listSessions(200),
        client.presets(),
        client.board(),
      ])
      this.#squads = state.squads
      this.#runs = state.runs
      this.#sessions = sessions
      this.#presets = presets
      this.#tasks = board.tasks
      this.#status = '已连接 · ' + sessions.length + ' 会话 · ' + board.tasks.length + ' 任务'
    } catch (error) {
      this.#error = error instanceof Error ? error.message : '连接远程桥失败'
      this.#client = null
    } finally {
      this.#loading = false
      this.render()
    }
  }

  onEvent(event: { method: string }): void {
    if (event.method === 'session.delta' && this.#sessionId) {
      if (this.#reloadTimer) clearTimeout(this.#reloadTimer)
      this.#reloadTimer = setTimeout(() => { void this.reloadSnapshot() }, 1200)
    }
  }

  header(): HTMLElement {
    const title = this.#device ? 'DSH 工作台' : '配对 DSH'
    const subtitle = this.#status || (this.#device ? '远程桥 · ' + bridgeHost(this.#device.url) : '智能体 / 会话 / 任务看板')
    const actions: HTMLElement[] = []
    if (this.#client) actions.push(h('button', { text: '刷新', onclick: () => { void this.connect() } }))
    if (this.#device) actions.push(h('button', { text: '解除', onclick: async () => {
      if (await this.#options.requestUnpair() && this.#root.isConnected) await this.unpair()
    } }))
    actions.push(h('button', { text: '关闭', onclick: () => this.close() }))
    return h('div', { class: 'bw-head' },
      h('div', { class: 'bw-title' }, h('strong', { text: title }), h('span', { text: subtitle })),
      ...actions,
    )
  }

  nav(): HTMLElement {
    if (!this.#device) return h('div')
    const items: { id: Tab; label: string }[] = [
      { id: 'agents', label: '智能体' },
      { id: 'sessions', label: '会话' },
      { id: 'board', label: '任务' },
      { id: 'groups', label: '群聊' },
      { id: 'memory', label: '记忆' },
    ]
    return h('div', { class: 'bw-nav' }, ...items.map((item) => h('button', {
      class: item.id === this.#tab ? 'active' : '',
      onclick: () => { this.#tab = item.id; this.#agentId = null; this.#sessionId = null; this.render() },
    }, h('span', { text: item.label }))))
  }

  render(): void {
    this.#root.replaceChildren(this.header(), h('div', { class: 'bw-main' }, ...this.main()), this.nav())
  }

  main(): (Node | string)[] {
    if (!this.#device) return this.pairing()
    if (this.#loading) return [h('div', { class: 'bw-empty', text: '正在连接远程桥…' })]
    if (this.#error) {
      return [
        h('div', { class: 'bw-card' }, h('h3', { text: '远程桥连接失败' }), h('p', { text: this.#error }),
          h('button', { class: 'bw-btn primary block', text: '重试', onclick: () => { void this.connect() } }),
          h('button', { class: 'bw-btn block', text: '重新配对', onclick: () => this.unpair() }),
        ),
      ]
    }
    switch (this.#tab) {
      case 'agents': return this.agentsView()
      case 'sessions': return this.sessionsView()
      case 'board': return this.boardView()
      case 'groups': return this.groupsView()
      case 'memory': return this.memoryView()
    }
  }

  pairing(): (Node | string)[] {
    const input = h('textarea', { placeholder: '粘 {token,url} 或 ws(s):// 配对链接' }) as HTMLTextAreaElement
    const manualError = h('div', { class: 'bw-error' })
    const status = h('div', { class: 'bw-status' })
    const manually = h('details', { class: 'bw-manual' }) as HTMLDetailsElement
    manually.append(
      h('summary', { text: '高级：手动粘贴配对链接' }),
      input,
      h('button', { class: 'bw-btn block', text: '从剪贴板粘贴', onclick: () => {
        void (async () => {
          try {
            const text = await navigator.clipboard.readText()
            if (text) input.value = text
          } catch { manualError.textContent = '剪贴板不可用，请手动粘贴' }
        })()
      } }),
      h('button', { class: 'bw-btn primary block', text: '连接', onclick: () => { void this.applyScanned(input.value) } }),
      status, manualError,
    )
    return [
      h('div', { class: 'bw-pair' },
        h('div', { class: 'bw-card bw-pair-hero' },
          h('h3', { text: '配对 DSH 工作台' }),
          h('p', { text: '扫电脑「跨设备」页的二维码' }),
          h('button', { class: 'bw-btn primary block', text: '扫码配对', onclick: () => this.scanPair() }),
          h('p', { class: 'bw-hint', text: 'Hub「手机连接」与 DSH「配对 iPhone」的码都能扫。' }),
          ...(this.#error ? [h('div', { class: 'bw-error', text: this.#error })] : []),
          manually,
        ),
      ),
    ]
  }

  scanPair(): void {
    openQrScanner({ onResult: (text) => { void this.applyScanned(text) } })
  }

  async applyScanned(text: string): Promise<void> {
    const raw = text.trim()
    if (!raw) return
    const kind = classifyPairing(raw)
    if (kind === 'unified') {
      this.close()
      this.#options.onUnifiedPairLink?.(raw)
      return
    }
    if (kind === 'hub') {
      this.close()
      this.#options.onHubPairLink?.(raw)
      return
    }
    if (kind !== 'bridge') {
      this.#error = '这个二维码不是配对链接；请重扫或手动粘贴'
      this.render()
      return
    }
    this.#loading = true
    this.#error = ''
    this.#status = '正在配对…'
    this.render()
    try {
      const payload = parsePairPayload(raw)
      const device = await pairBridge(payload)
      store(device)
      this.#device = device
      await this.connect()
    } catch (cause) {
      this.#loading = false
      this.#error = cause instanceof Error ? cause.message : '配对失败'
      this.render()
    }
  }

  agentsView(): (Node | string)[] {
    if (this.#agentId) return this.agentDetail()
    const nodes: (Node | string)[] = []
    if (this.#presets.length) {
      nodes.push(h('div', { class: 'bw-tabs' }, ...this.#presets.map((preset) => h('span', { class: 'bw-chip', text: preset.name ?? preset.id }))))
    }
    const runCount = new Map<string, number>()
    for (const run of this.#runs) runCount.set(run.squadId, (runCount.get(run.squadId) ?? 0) + 1)
    for (const squad of this.#squads) {
      const count = runCount.get(squad.id) ?? 0
      nodes.push(h('button', { class: 'bw-card', style: 'text-align:left;width:100%', onclick: () => { this.#agentId = squad.id; this.render() } },
        h('h3', { text: prettyAgentName(squad.name), title: squad.name ?? '' }),
        h('p', { text: squad.description ?? '（无描述）' }),
        h('div', { class: 'bw-meta' },
          h('span', { class: 'bw-chip', text: count + ' 次运行' }),
          h('span', { text: (squad.members?.length ?? 0) + ' 名成员' }),
        ),
      ))
    }
    if (!nodes.length) nodes.push(h('div', { class: 'bw-empty', text: '远程桥没有返回智能体。' }))
    return nodes
  }

  agentDetail(): (Node | string)[] {
    const squad = this.#squads.find((item) => item.id === this.#agentId)
    if (!squad) return [h('div', { class: 'bw-empty', text: '智能体不存在' })]
    const runs = this.#runs.filter((run) => run.squadId === squad.id).sort((a, b) => b.createdAt - a.createdAt)
    const byId = new Map(this.#sessions.map((session) => [session.id, session]))
    const nodes: (Node | string)[] = [
      h('button', { class: 'bw-back', text: '‹ 智能体', onclick: () => { this.#agentId = null; this.render() } }),
      h('div', { class: 'bw-agent-head' },
        h('div', {}, h('h3', { text: prettyAgentName(squad.name), title: squad.name ?? '' }), h('p', { text: squad.description ?? '' })),
      ),
    ]
    if (squad.members?.length) {
      nodes.push(h('div', { class: 'bw-card' }, h('h3', { text: '成员' }),
        ...squad.members.map((member) => h('div', { class: 'bw-row' },
          h('div', { class: 'bw-row-main' }, h('strong', { text: member.name }), h('small', { text: member.preset ?? member.model ?? '' })),
        )),
      ))
    }
    if (!runs.length) {
      nodes.push(h('div', { class: 'bw-empty', text: '这个智能体还没有运行记录。' }))
    } else {
      nodes.push(h('h3', { text: '运行记录' }))
      for (const run of runs) {
        const session = byId.get(run.sessionId)
        nodes.push(h('button', { class: 'bw-row', style: 'text-align:left;width:100%', onclick: () => { void this.openSession(run.sessionId) } },
          h('div', { class: 'bw-row-main' }, h('strong', { text: session?.title ?? run.sessionId }), h('small', { text: run.kind === 'squad' ? '整队运行' : '成员运行' })),
          h('div', { class: 'bw-row-side', text: run.status }),
        ))
      }
    }
    return nodes
  }

  sessionsView(): (Node | string)[] {
    if (this.#sessionId) return this.sessionDetail()
    const nodes: (Node | string)[] = []
    const sorted = [...this.#sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const session of sorted) {
      nodes.push(h('button', { class: 'bw-row', style: 'text-align:left;width:100%', onclick: () => { void this.openSession(session.id) } },
        h('div', { class: 'bw-row-main' },
          h('strong', { text: session.title || '未命名会话' }),
          h('small', { text: [session.agentRunning ? '正在运行' : '', session.cwd ?? ''].filter(Boolean).join(' · ') }),
        ),
        h('div', { class: 'bw-row-side', text: formatWhen(session.updatedAt) }),
      ))
    }
    if (!nodes.length) nodes.push(h('div', { class: 'bw-empty', text: '暂无会话。' }))
    return nodes
  }

  async openSession(id: string): Promise<void> {
    this.#tab = 'sessions'
    this.#sessionId = id
    this.#messages = []
    this.#error = ''
    this.render()
    await this.reloadSnapshot()
  }

  async reloadSnapshot(): Promise<void> {
    const id = this.#sessionId
    const client = this.#client
    if (!id || !client) return
    try {
      const snapshot = await client.snapshot(id)
      this.#messages = messagesOfSnapshot(snapshot)
    } catch (error) {
      this.#error = error instanceof Error ? error.message : '读取会话失败'
    }
    this.render()
  }

  sessionDetail(): (Node | string)[] {
    const session = this.#sessions.find((item) => item.id === this.#sessionId)
    const messages = this.#messages.map((message) => h('div', { class: 'bw-msg ' + message.role },
      h('span', { class: 'bw-role', text: message.role === 'user' ? '我' : message.role === 'reason' ? '思考' : 'DSH' }),
      message.text,
    ))
    const input = h('textarea', { placeholder: '给这个会话发消息…', value: this.#draft }) as HTMLTextAreaElement
    input.addEventListener('input', () => { this.#draft = input.value })
    const send = h('button', { class: 'bw-btn primary', text: this.#sending ? '发送中…' : '发送' }) as HTMLButtonElement
    send.addEventListener('click', () => { void this.send(input) })
    return [
      h('button', { class: 'bw-back', text: '‹ 会话', onclick: () => { this.#sessionId = null; this.#messages = []; this.render() } }),
      h('div', { class: 'bw-card' }, h('h3', { text: session?.title ?? '会话' }), h('p', { text: (session?.cwd ?? '') + (session?.agentRunning ? ' · 正在运行' : '') })),
      ...(this.#error ? [h('div', { class: 'bw-error', text: this.#error })] : []),
      h('div', { class: 'bw-messages' }, ...(messages.length ? messages : [h('div', { class: 'bw-empty', text: '正在读取会话内容…' })])),
      h('div', { class: 'bw-compose' }, input, send),
    ]
  }

  async send(input: HTMLTextAreaElement): Promise<void> {
    const client = this.#client
    const id = this.#sessionId
    const text = input.value.trim()
    if (!client || !id || !text || this.#sending) return
    this.#sending = true
    this.#error = ''
    this.#draft = ''
    this.render()
    try {
      await client.prompt(id, text)
      await new Promise((resolve) => setTimeout(resolve, 1200))
      await this.reloadSnapshot()
    } catch (error) {
      this.#error = error instanceof Error ? error.message : '发送失败'
    } finally {
      this.#sending = false
      this.render()
    }
  }

  boardView(): (Node | string)[] {
    const order = ['backlog', 'todo', 'running', 'done', 'failed']
    const labels: Record<string, string> = { backlog: '待办', todo: '待处理', running: '进行中', done: '完成', failed: '失败' }
    const groups = new Map<string, BridgeTaskRow[]>()
    for (const task of this.#tasks) {
      const key = String(task.column ?? task.status ?? 'todo')
      const list = groups.get(key) ?? []
      list.push(task)
      groups.set(key, list)
    }
    const keys = [...order.filter((key) => groups.has(key)), ...[...groups.keys()].filter((key) => !order.includes(key))]
    const columns = keys.map((key) => h('div', { class: 'bw-col' },
      h('h4', {}, h('span', { text: labels[key] ?? key }), h('span', { text: String(groups.get(key)?.length ?? 0) })),
      ...(groups.get(key) ?? []).map((task) => h('div', { class: 'bw-task' },
        h('strong', { text: String(task.title ?? task.id) }),
        h('p', { text: String(task.description ?? '') }),
      )),
    ))
    if (!columns.length) return [h('div', { class: 'bw-empty', text: '任务看板为空。' })]
    return [h('div', { class: 'bw-board' }, ...columns)]
  }

  groupsView(): (Node | string)[] {
    return [
      h('div', { class: 'bw-card' },
        h('h3', { text: '群聊仍走 Hub' }),
        h('p', { text: 'DSH remote-bridge v1 没有群聊消息面；群聊继续用调度官的账号 ticket。这里先给入口，不画假消息。' }),
        h('button', { class: 'bw-btn primary block', text: '回调度官群聊', onclick: () => { this.close(); this.#options.onOpenHubGroups() } }),
      ),
    ]
  }

  memoryView(): (Node | string)[] {
    return [
      h('div', { class: 'bw-card' },
        h('h3', { text: '记忆：远程桥还没有这一面' }),
        h('p', { text: '远程桥还没有记忆接口，这里先空着。DSH 补上 docs/dsh-phone-api.md 里的 memory.readPhone 之后才会显示。' }),
      ),
    ]
  }

  unpair(): void {
    void unstore()
    this.#device = null
    this.#client?.close()
    this.#client = null
    this.#sessions = []
    this.#squads = []
    this.#runs = []
    this.#tasks = []
    this.#status = ''
    this.#error = ''
    this.#tab = 'agents'
    this.render()
  }

  close(): void {
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer)
    this.#client?.close()
    this.#client = null
    this.#root.remove()
    this.#options.onClose()
  }
}
