/**
 * DSH remote-bridge protocol v1 client (phone side).
 *
 * This is the full-feature channel: /ios/v1 WebSocket, one JSON object per text
 * frame. Pairing is a one-shot bootstrap token plus an ES256 challenge. The
 * paired device token then authenticates the same socket via ?token=.
 *
 * Kept free of Capacitor/DOM so a Node script can exercise it against a real
 * bridge before the UI uses it.
 */

export const BRIDGE_CAPS = [
  'agents.v1',
  'squads.v1',
  'board.v1',
  'questions.v1',
  'approvals.v1',
  'jobs.v1',
  'usage.v1',
  'usage.stats.v1',
  'ui.v1',
  'ui.list.v1',
  'session.snapshot.page.v1',
  'session.snapshot.since.v1',
  'session.list.compact.v1',
] as const

export interface PairPayload {
  token: string
  url: string
}

export interface BridgeDevice {
  url: string
  deviceToken: string
  deviceId: string
}

export interface BridgeSessionRow {
  id: string
  title: string
  updatedAt: number
  agentRunning?: boolean
  cwd?: string
  parentSessionId?: string
  origin?: string
  blank?: boolean
  archived?: boolean
}

export interface BridgePresetRow {
  id: string
  name?: string
  description?: string
  [key: string]: unknown
}

export interface BridgeSquadMember {
  id: string
  name: string
  preset?: string
  permission?: string
  model?: string
  reasoningEffort?: string
  brief?: string
}

export interface BridgeSquadRow {
  id: string
  name?: string
  description?: string
  members?: BridgeSquadMember[]
  [key: string]: unknown
}

export interface BridgeRunRow {
  id: string
  squadId: string
  kind: 'squad' | 'member'
  memberId?: string
  sessionId: string
  createdAt: number
  status: 'running' | 'settled' | 'failed'
  failure?: string
}

export interface BridgeTaskRow {
  id: string
  title?: string
  status?: string
  column?: string
  [key: string]: unknown
}

export interface BridgeEvent {
  seq: number
  method: string
  payload: unknown
}

type RequestId = number
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function bytesFromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function tokenOfUrl(url: string): string | undefined {
  try {
    const value = new URL(url).searchParams.get('token')
    return value === null || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

function withToken(url: string, token: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set('token', token)
  return parsed.toString()
}

/** Strip any credential from a bridge URL before persisting/displaying it. */
export function stripBridgeToken(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('token')
    return parsed.toString()
  } catch {
    return url
  }
}

/** Host-only label for the UI; never render a URL that can carry a token. */
export function bridgeHost(url: string): string {
  try { return new URL(url).host } catch { return '远程桥' }
}

/** Parse the payload a pairing QR/copy button carries: a JSON {token,url}, or a ws(s) URL. */
export function parsePairPayload(text: string): PairPayload {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('配对内容为空')
  if (trimmed.startsWith('{')) {
    const value = JSON.parse(trimmed) as { token?: unknown; url?: unknown; pairingUrl?: unknown; expiresAt?: unknown }
    const url = typeof value.url === 'string' ? value.url : typeof value.pairingUrl === 'string' ? value.pairingUrl : ''
    const token = typeof value.token === 'string' ? value.token : tokenOfUrl(url) ?? ''
    if (!/^wss?:\/\//.test(url)) throw new Error('配对内容缺少 ws(s) 地址')
    if (token === '') throw new Error('配对内容缺少 token')
    return { token, url }
  }
  if (/^wss?:\/\//.test(trimmed)) {
    const token = tokenOfUrl(trimmed)
    if (!token) throw new Error('配对链接缺少 token')
    return { token, url: trimmed }
  }
  throw new Error('请粘贴 {token,url} JSON 或 ws(s):// 配对链接')
}

/** One QR that carries the Hub pairing and the DSH bridge pairing together. */
export interface UnifiedPairing {
  version: 1
  hub: string
  hubToken: string
  ticket?: string
  bridge: string
  bridgeToken: string
}

function decodeBase64UrlText(text: string): string | null {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** Parse marshal://setup?payload=<base64url JSON>; null means it is not a valid unified code. */
export function parseUnifiedPairing(text: string): UnifiedPairing | null {
  const trimmed = text.trim()
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { return null }
  if (parsed.protocol !== 'marshal:' || parsed.host !== 'setup') return null
  const encoded = parsed.searchParams.get('payload')
  if (!encoded) return null
  const json = decodeBase64UrlText(encoded)
  if (!json) return null
  let value: unknown
  try { value = JSON.parse(json) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const hub = typeof record.hub === 'string' ? record.hub : ''
  const hubToken = typeof record.hubToken === 'string' ? record.hubToken : ''
  const bridge = typeof record.bridge === 'string' ? record.bridge : ''
  const bridgeToken = typeof record.bridgeToken === 'string' ? record.bridgeToken : ''
  const ticket = typeof record.ticket === 'string' && record.ticket !== '' ? record.ticket : undefined
  if (!/^https?:\/\//i.test(hub) || hubToken.length < 16) return null
  if (!/^wss?:\/\//i.test(bridge) || bridgeToken.length < 16) return null
  return { version: 1, hub, hubToken, ...(ticket ? { ticket } : {}), bridge, bridgeToken }
}

/** Classify a scanned QR: Hub, DSH bridge, combined setup, or unknown. */
export function classifyPairing(text: string): 'hub' | 'bridge' | 'unified' | 'unknown' {
  const trimmed = text.trim()
  if (parseUnifiedPairing(trimmed)) return 'unified'
  if (/^marshal:\/\//i.test(trimmed)) return 'hub'
  try { parsePairPayload(trimmed); return 'bridge' } catch { return 'unknown' }
}

/** True when the text looks like a bridge pairing payload; cheap gate for deep links. */
export function looksLikePairPayload(text: string): boolean {
  try { parsePairPayload(text); return true } catch { return false }
}

export class BridgeClient {
  readonly url: string
  readonly deviceToken: string
  readonly deviceId: string
  #ws: WebSocket | null = null
  #nextId = 1
  #pending = new Map<RequestId, Pending>()
  #events: BridgeEvent[] = []
  #closed = false
  #onEvent: ((event: BridgeEvent) => void) | undefined

  constructor(device: Pick<BridgeDevice, 'url' | 'deviceToken' | 'deviceId'>, onEvent?: (event: BridgeEvent) => void) {
    this.url = device.url
    this.deviceToken = device.deviceToken
    this.deviceId = device.deviceId
    this.#onEvent = onEvent
  }

  get events(): readonly BridgeEvent[] { return this.#events }
  get connected(): boolean { return this.#ws?.readyState === 1 }

  async connect(): Promise<{ capabilities: string[]; minor: number }> {
    if (this.#closed) throw new Error('客户端已关闭')
    const url = withToken(this.url, this.deviceToken)
    const ws = new WebSocket(url)
    this.#ws = ws
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接远程桥超时')), 10_000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接远程桥失败')) }, { once: true })
    })
    ws.addEventListener('message', (event) => this.#onMessage(event))
    ws.addEventListener('close', () => this.#failAll(new Error('远程桥已断开')))
    const hello = await this.request<{ capabilities?: string[]; minor?: number; auth?: string }>('hello', {
      proto: 1, minor: 22, client: 'dsh-marshal-mobile/0.4', cap: [...BRIDGE_CAPS],
    })
    if (hello.auth !== 'paired') throw new Error('配对凭据未被远程桥接受')
    return { capabilities: hello.capabilities ?? [], minor: hello.minor ?? 0 }
  }

  close(): void {
    this.#closed = true
    this.#failAll(new Error('客户端已关闭'))
    try { this.#ws?.close() } catch { /* ignore */ }
    this.#ws = null
  }

  request<T>(method: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const ws = this.#ws
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('远程桥未连接'))
    const id = this.#nextId++
    ws.send(JSON.stringify({ t: 'req', id, m: method, p: payload }))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(method + ' 超时'))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
    })
  }

  #onMessage(event: MessageEvent): void {
    let frame: Record<string, unknown>
    try { frame = JSON.parse(String(event.data)) as Record<string, unknown> } catch { return }
    const kind = frame.t
    if (kind === 'ping') {
      try { this.#ws?.send(JSON.stringify({ t: 'pong', ts: frame.ts })) } catch { /* ignore */ }
      return
    }
    if (kind === 'res') {
      const id = typeof frame.id === 'number' ? frame.id : -1
      const pending = this.#pending.get(id)
      if (!pending) return
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      if (frame.ok === true) pending.resolve(frame.r)
      else {
        const error = (frame.e ?? {}) as { code?: unknown; msg?: unknown }
        pending.reject(new Error(String(error.msg ?? '远程桥拒绝') + (error.code ? ' (' + String(error.code) + ')' : '')))
      }
      return
    }
    if (kind === 'ev') {
      const item: BridgeEvent = {
        seq: typeof frame.seq === 'number' ? frame.seq : 0,
        method: typeof frame.m === 'string' ? frame.m : '',
        payload: frame.p,
      }
      this.#events.push(item)
      if (this.#events.length > 500) this.#events.shift()
      this.#onEvent?.(item)
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  // ---- typed methods -------------------------------------------------

  async listSessions(maxRows = 200): Promise<BridgeSessionRow[]> {
    const result = await this.request<{ sessions?: unknown }>('session.list', { maxRows })
    return Array.isArray(result.sessions) ? (result.sessions as BridgeSessionRow[]) : []
  }

  async presets(): Promise<BridgePresetRow[]> {
    const result = await this.request<{ presets?: unknown }>('presets.list', {})
    return Array.isArray(result.presets) ? (result.presets as BridgePresetRow[]) : []
  }

  async squads(): Promise<BridgeSquadRow[]> {
    const result = await this.request<{ squads?: unknown }>('squads.list', {})
    return Array.isArray(result.squads) ? (result.squads as BridgeSquadRow[]) : []
  }

  async squadsState(): Promise<{ squads: BridgeSquadRow[]; runs: BridgeRunRow[]; presets: string[] }> {
    const result = await this.request<{ squads?: unknown; runs?: unknown; presets?: unknown }>('squads.state', {})
    return {
      squads: Array.isArray(result.squads) ? (result.squads as BridgeSquadRow[]) : [],
      runs: Array.isArray(result.runs) ? (result.runs as BridgeRunRow[]) : [],
      presets: Array.isArray(result.presets) ? (result.presets as string[]) : [],
    }
  }

  async board(): Promise<{ tasks: BridgeTaskRow[]; revision?: number; snapshot?: unknown }> {
    const result = await this.request<{ tasks?: unknown; revision?: number; snapshot?: unknown }>('board.snapshot', {})
    return {
      tasks: Array.isArray(result.tasks) ? (result.tasks as BridgeTaskRow[]) : [],
      revision: result.revision,
      snapshot: result.snapshot,
    }
  }

  async snapshot(sessionId: string): Promise<unknown> {
    return this.request('session.snapshot', { sessionId })
  }

  async prompt(sessionId: string, text: string): Promise<unknown> {
    const requestId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    return this.request('session.prompt', { sessionId, text, requestId }, 60_000)
  }

  async createSession(presetId: string, cwd?: string): Promise<{ sessionId?: string }> {
    return this.request('session.create', { preset: presetId, ...(cwd ? { cwd } : {}) }, 60_000)
  }

  async resolveApproval(id: string, decision: string): Promise<unknown> {
    return this.request('approval.resolve', { id, decision })
  }

  async answerQuestion(id: string, answers: unknown): Promise<unknown> {
    return this.request('question.answer', { id, answers })
  }
}

/**
 * Pair a fresh phone: bootstrap token -> ES256 challenge -> device token.
 * The caller keeps BridgeDevice and constructs BridgeClient for the paired socket.
 */
export async function pairBridge(payload: PairPayload, clientName = 'dsh-marshal-mobile/0.4'): Promise<BridgeDevice> {
  const bootstrapUrl = withToken(payload.url, payload.token)
  const ws = new WebSocket(bootstrapUrl)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接配对地址超时')), 10_000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接配对地址失败')) }, { once: true })
  })
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  ws.addEventListener('message', (event) => {
    let frame: Record<string, unknown>
    try { frame = JSON.parse(String(event.data)) as Record<string, unknown> } catch { return }
    if (frame.t === 'ping') { try { ws.send(JSON.stringify({ t: 'pong', ts: frame.ts })) } catch { /* ignore */ } return }
    if (frame.t !== 'res') return
    const id = typeof frame.id === 'number' ? frame.id : -1
    const item = pending.get(id)
    if (!item) return
    pending.delete(id)
    clearTimeout(item.timer)
    if (frame.ok === true) item.resolve(frame.r)
    else {
      const error = (frame.e ?? {}) as { code?: unknown; msg?: unknown }
      item.reject(new Error(String(error.msg ?? '配对被拒绝') + (error.code ? ' (' + String(error.code) + ')' : '')))
    }
  })
  const call = <T>(method: string, body: Record<string, unknown>): Promise<T> => {
    const id = nextId++
    ws.send(JSON.stringify({ t: 'req', id, m: method, p: body }))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' 超时')) }, 20_000)
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
    })
  }
  try {
    await call('hello', { proto: 1, minor: 22, client: clientName, cap: [...BRIDGE_CAPS] })
    const begun = await call<{ nonce: string }>('pair.begin', { token: payload.token })
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey)
    const nonce = bytesFromBase64Url(begun.nonce)
    const nonceBuffer = nonce.buffer.slice(nonce.byteOffset, nonce.byteOffset + nonce.byteLength) as ArrayBuffer
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, nonceBuffer)
    const finished = await call<{ deviceToken: string; deviceId: string }>('pair.finish', {
      devicePubKey: base64UrlFromBytes(new Uint8Array(spki)),
      signature: base64UrlFromBytes(new Uint8Array(signature)),
    })
    if (typeof finished.deviceToken !== 'string' || typeof finished.deviceId !== 'string') {
      throw new Error('配对回包缺少设备凭据')
    }
    return { url: stripBridgeToken(payload.url), deviceToken: finished.deviceToken, deviceId: finished.deviceId }
  } finally {
    try { ws.close() } catch { /* ignore */ }
  }
}