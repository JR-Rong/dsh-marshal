/**
 * 账号 ticket 接法（群聊）。
 *
 * 浏览器 WebView 不能设置 Origin、也不能读 HttpOnly cookie；这里统一走
 * CapacitorHttp 的原生栈：换票 → 拿 Set-Cookie → 后续 discussions 请求带
 * Cookie + x-marshal-csrf。仍然只是手机节点出站，不开任何端口。
 */
import { Capacitor, CapacitorCookies, CapacitorHttp } from '@capacitor/core'
import type { AccountSession } from './config.ts'
import { randomUuid } from './marshal.ts'

export type AccountFailure =
  | 'unauthorized' | 'rate-limited' | 'unreachable' | 'timeout'
  | 'server' | 'malformed' | 'rejected' | 'expired' | 'no-cookie'

export type AccountResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AccountFailure; message: string; status?: number; code?: string }

const TIMEOUT_MS = 15_000
const SESSION_COOKIE = '__Host-marshal-session'
const CSRF_COOKIE = '__Host-marshal-csrf'

export interface AccountLoginData extends AccountSession {
  accountHash?: string
  name?: string
}

export function describeAccountFailure(error: AccountFailure, code?: string): string {
  switch (error) {
    case 'unauthorized': return 'ticket 被 Hub 拒绝（401/403），可能已过期或已用过'
    case 'rate-limited': return '登录尝试过于频繁（429），请稍后再试'
    case 'unreachable': return '连不上 Hub，请检查地址与网络'
    case 'timeout': return 'Hub 响应超时'
    case 'server': return 'Hub 返回异常'
    case 'malformed': return 'Hub 返回了无法解析的数据'
    case 'rejected': return 'Hub 拒绝：' + (code ?? 'invalid')
    case 'expired': return '账号会话已过期，请重新生成 ticket'
    case 'no-cookie': return 'Hub 没有下发会话 cookie'
  }
}

export function parseLoginBody(value: unknown): {
  csrf: string
  expiresAt: number
  accountHash?: string
  name?: string
} | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (row.ok !== true) return null
  if (typeof row.csrf !== 'string' || !row.csrf || row.csrf.length > 512) return null
  if (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt) || row.expiresAt <= 0) return null
  const account = typeof row.account === 'object' && row.account !== null
    ? row.account as Record<string, unknown>
    : {}
  const nameValue = typeof account.name === 'string' ? account.name : row.workspaceName
  const hashValue = typeof account.accountHash === 'string' ? account.accountHash : row.accountHash
  return {
    csrf: row.csrf,
    expiresAt: Math.round(row.expiresAt),
    ...(typeof hashValue === 'string' && /^[a-f0-9]{64}$/.test(hashValue) ? { accountHash: hashValue } : {}),
    ...(typeof nameValue === 'string' && nameValue.trim() ? { name: nameValue.slice(0, 80) } : {}),
  }
}

/** 从原生响应头里抽 Set-Cookie，兼容字符串/数组与逗号拼接。 */
export function extractSetCookie(headers: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'set-cookie') continue
    if (Array.isArray(value)) parts.push(...value.map((item) => String(item)))
    else if (typeof value === 'string') parts.push(value)
  }
  return parts.join('; ')
}

export function matchCookie(raw: string, name: string): string | undefined {
  // Cookie 值都是 base64url/随机串，不含 ; 或 ,；按属性分隔符切开即可。
  for (const part of raw.split(/[;,]s*/)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return part.slice(eq + 1).trim()
  }
  return undefined
}

function statusFailure(status: number): AccountFailure | null {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate-limited'
  if (status === 400) return 'rejected'
  if (status >= 500) return 'server'
  return null
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function isNativePlatform(): boolean {
  try { return Capacitor.isNativePlatform() } catch { return false }
}

export async function loginWithTicket(
  hubUrl: string,
  ticket: string,
): Promise<AccountResult<AccountLoginData>> {
  const origin = hubUrl.replace(/\/+$/, '')
  const trimmed = (ticket ?? '').trim()
  if (!trimmed) return { ok: false, error: 'rejected', message: '请填写 ticket' }
  if (!/^[\w-]{20,80}$/.test(trimmed)) {
    return { ok: false, error: 'rejected', message: 'ticket 格式不正确' }
  }
  try {
    if (isNativePlatform()) {
      // 清掉旧会话，避免上一轮 cookie 与新 ticket 混用。
      try { await CapacitorCookies.clearCookies({ url: origin }) } catch { /* 清不掉也不阻塞登录 */ }
    }
    const response = await CapacitorHttp.post({
      url: origin + '/marshal/login',
      headers: { accept: 'application/json', 'content-type': 'application/json', origin },
      data: { ticket: trimmed },
      connectTimeout: TIMEOUT_MS,
      readTimeout: TIMEOUT_MS,
      responseType: 'text',
      shouldEncodeUrlParams: false,
    })
    const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
    const body = parseJson(text)
    const failure = statusFailure(response.status)
    if (failure) {
      const code = typeof body?.code === 'string' ? body.code : undefined
      return { ok: false, error: failure, message: describeAccountFailure(failure, code), status: response.status, ...(code ? { code } : {}) }
    }
    if (response.status !== 200 || body?.ok !== true) {
      return { ok: false, error: 'server', message: 'Hub 返回 ' + response.status, status: response.status }
    }
    const parsed = parseLoginBody(body)
    if (!parsed) return { ok: false, error: 'malformed', message: describeAccountFailure('malformed') }
    const headers = (response.headers ?? {}) as Record<string, unknown>
    const raw = extractSetCookie(headers)
    let session = matchCookie(raw, SESSION_COOKIE)
    let csrf = matchCookie(raw, CSRF_COOKIE) ?? parsed.csrf
    if (!session || !csrf) {
      // 某些原生栈只把 cookie 放进自己的 jar，读一次兜底。
      try {
        const jar = await CapacitorCookies.getCookies({ url: origin })
        session = session ?? jar[SESSION_COOKIE] ?? jar['marshal-session']
        csrf = csrf || jar[CSRF_COOKIE] || jar['marshal-csrf']
      } catch {
        /* jar 不可用就按失败处理 */
      }
    }
    if (!session || !csrf) {
      return { ok: false, error: 'no-cookie', message: describeAccountFailure('no-cookie') }
    }
    if (isNativePlatform()) {
      // 关键：登录响应会让原生 URLSession/HttpURLConnection 自动存 cookie；
      // 之后我们再显式带 Cookie 头就会重复，而 Hub 对重复 cookie 判 null。
      // 这里清掉原生 jar，后续只认 JS 保存的这一份 Cookie 头。
      try { await CapacitorCookies.clearCookies({ url: origin }) } catch { /* 清不掉也不阻塞 */ }
    }
    return {
      ok: true,
      data: {
        cookies: SESSION_COOKIE + '=' + session + '; ' + CSRF_COOKIE + '=' + csrf,
        csrf,
        expiresAt: parsed.expiresAt,
        ...(parsed.accountHash ? { accountHash: parsed.accountHash } : {}),
        ...(parsed.name ? { name: parsed.name } : {}),
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const kind: AccountFailure = /timeout|timed out/i.test(message) ? 'timeout' : 'unreachable'
    return { ok: false, error: kind, message: describeAccountFailure(kind) }
  }
}

export class AccountApi {
  private readonly hubUrl: string
  private readonly session: AccountSession

  constructor(hubUrl: string, session: AccountSession) {
    this.hubUrl = hubUrl
    this.session = session
  }

  get expiresAt(): number { return this.session.expiresAt }

  private async request(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: Record<string, unknown>,
  ): Promise<AccountResult<Record<string, unknown>>> {
    if (Date.now() >= this.session.expiresAt) {
      return { ok: false, error: 'expired', message: describeAccountFailure('expired') }
    }
    const origin = this.hubUrl.replace(/\/+$/, '')
    const headers: Record<string, string> = {
      accept: 'application/json',
      cookie: this.session.cookies,
    }
    if (method === 'POST') {
      headers.origin = origin
      headers['x-marshal-csrf'] = this.session.csrf
      headers['content-type'] = 'application/json'
    }
    if (!isNativePlatform()) {
      // 浏览器预览/冒烟没有原生 cookie 栈；走同源 fetch，靠测试代理或路由注入。
      try {
        const response = await fetch(origin + path, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          credentials: 'omit',
          cache: 'no-store',
        })
        const text = await response.text()
        const parsed = parseJson(text)
        const failure = statusFailure(response.status)
        if (failure) {
          const code = typeof parsed?.code === 'string' ? parsed.code : undefined
          return { ok: false, error: failure, message: describeAccountFailure(failure, code), status: response.status, ...(code ? { code } : {}) }
        }
        if (response.status < 200 || response.status >= 300) {
          return { ok: false, error: 'server', message: 'Hub 返回 ' + response.status, status: response.status }
        }
        if (!parsed) return { ok: false, error: 'malformed', message: describeAccountFailure('malformed') }
        return { ok: true, data: parsed }
      } catch {
        return { ok: false, error: 'unreachable', message: describeAccountFailure('unreachable') }
      }
    }
    try {
      const options = {
        url: origin + path,
        method,
        headers,
        ...(body === undefined ? {} : { data: body }),
        connectTimeout: TIMEOUT_MS,
        readTimeout: TIMEOUT_MS,
        responseType: 'text' as const,
        shouldEncodeUrlParams: false,
      }
      let response = await CapacitorHttp.request(options)
      if (isNativePlatform() && (response.status === 401 || response.status === 403)) {
        // 原生栈可能把登录 cookie 又同步回 jar，与手写 Cookie 头重复（Hub 判 null）。
        // 清一次 jar 再重试；成功与否都以第二次为准。
        try { await CapacitorCookies.clearCookies({ url: origin }) } catch { /* 清不掉就按原结果处理 */ }
        response = await CapacitorHttp.request(options)
      }
      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      const parsed = parseJson(text)
      const failure = statusFailure(response.status)
      if (failure) {
        const code = typeof parsed?.code === 'string' ? parsed.code : undefined
        return { ok: false, error: failure, message: describeAccountFailure(failure, code), status: response.status, ...(code ? { code } : {}) }
      }
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: 'server', message: 'Hub 返回 ' + response.status, status: response.status }
      }
      if (!parsed) return { ok: false, error: 'malformed', message: describeAccountFailure('malformed') }
      return { ok: true, data: parsed }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const kind: AccountFailure = /timeout|timed out/i.test(message) ? 'timeout' : 'unreachable'
      return { ok: false, error: kind, message: describeAccountFailure(kind) }
    }
  }

  async list(): Promise<AccountResult<{ rooms: RoomSummary[]; catalog: DiscussionCatalogItem[]; presets: unknown[] }>> {
    const result = await this.request('/marshal/api/discussions')
    if (!result.ok) return result
    return { ok: true, data: parseRoomList(result.data) }
  }

  async room(roomId: string): Promise<AccountResult<DiscussionRoom>> {
    const result = await this.request('/marshal/api/discussions?room=' + encodeURIComponent(roomId))
    if (!result.ok) return result
    const room = parseRoom((result.data as { room?: unknown }).room)
    if (!room) return { ok: false, error: 'malformed', message: describeAccountFailure('malformed') }
    return { ok: true, data: room }
  }

  async action(payload: Record<string, unknown>): Promise<AccountResult<Record<string, unknown>>> {
    return this.request('/marshal/api/discussions', 'POST', payload)
  }

  async preview(input: Record<string, unknown>): Promise<AccountResult<GroupPreview>> {
    const result = await this.action({ action: 'preview', input })
    if (!result.ok) return result
    const preview = parsePreview(result.data.preview)
    if (!preview) return { ok: false, error: 'malformed', message: describeAccountFailure('malformed') }
    return { ok: true, data: preview }
  }

  async create(digest: string): Promise<AccountResult<DiscussionRoom>> {
    const result = await this.action({ action: 'create', digest, key: randomUuid() })
    if (!result.ok) return result
    const room = parseRoom(result.data.room)
    if (!room) return { ok: false, error: 'malformed', message: describeAccountFailure('malformed') }
    return { ok: true, data: room }
  }

  async logout(): Promise<void> {
    const origin = this.hubUrl.replace(/\/+$/, '')
    await this.request('/marshal/logout', 'POST', {})
    if (isNativePlatform()) {
      try { await CapacitorCookies.clearCookies({ url: origin }) } catch { /* 本地已清 */ }
    }
  }
}

export interface DiscussionCatalogItem {
  id: string
  agent: string
  model: string
  provider: string
  deviceId: string
  deviceName: string
  reasoningEfforts: string[]
}

export interface RoomSummary {
  id: string
  title: string
  state: string
  createdAt: number
}

export interface RoomMember {
  id: string
  name: string
  model: { agent: string; model: string; provider?: string }
  reasoning?: string
  work?: { workspace?: string }
}

export interface RoomMessage {
  id: string
  author: string
  text: string
  markdown?: string
  state: string
  error?: string
  at: number
}

export interface RoomCall {
  turnId: string
  memberId: string
  state: string
  phase?: string
}

export interface PreviewMember {
  id: string
  deviceId: string
  model: { id?: string; agent: string; model: string; provider?: string }
  reasoning?: string
  work?: { workspace?: string }
}

export interface GroupPreview {
  digest: string
  mode: string
  title: string
  text: string
  members: PreviewMember[]
  moderatorId: string
  maxCalls: number
  expiresAt: number
}

export interface DiscussionRoom {
  id: string
  title: string
  state: string
  phase?: string
  mode?: string
  rounds: number
  revision: number
  moderatorId: string
  members: RoomMember[]
  messages: RoomMessage[]
  calls: RoomCall[]
  cleared: boolean
  createdAt: number
  expiresAt: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textOf(value: unknown, max = 8192): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

export function parseRoomList(value: unknown): { rooms: RoomSummary[]; catalog: DiscussionCatalogItem[]; presets: unknown[] } {
  const source = asRecord(value) ?? {}
  const rooms: RoomSummary[] = []
  for (const row of Array.isArray(source.rooms) ? source.rooms : []) {
    const item = asRecord(row)
    if (!item || typeof item.id !== 'string' || !item.id) continue
    rooms.push({
      id: item.id,
      title: textOf(item.title, 200) || '未命名群聊',
      state: textOf(item.state, 40) || 'unknown',
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    })
  }
  const catalog: DiscussionCatalogItem[] = []
  for (const row of Array.isArray(source.catalog) ? source.catalog : []) {
    const item = asRecord(row)
    if (!item || typeof item.id !== 'string' || !item.id) continue
    if (typeof item.deviceId !== 'string' || !item.deviceId) continue
    if (typeof item.agent !== 'string' || !item.agent) continue
    if (typeof item.model !== 'string' || !item.model) continue
    catalog.push({
      id: item.id,
      agent: item.agent,
      model: item.model,
      provider: textOf(item.provider),
      deviceId: item.deviceId,
      deviceName: textOf(item.deviceName, 120) || item.deviceId,
      reasoningEfforts: Array.isArray(item.reasoningEfforts)
        ? item.reasoningEfforts.filter((effort): effort is string => typeof effort === 'string')
        : [],
    })
  }
  return { rooms, catalog, presets: Array.isArray(source.presets) ? source.presets : [] }
}

export function parseRoom(value: unknown): DiscussionRoom | null {
  const item = asRecord(value)
  if (!item || typeof item.id !== 'string' || !item.id) return null
  const members: RoomMember[] = []
  for (const row of Array.isArray(item.members) ? item.members : []) {
    const member = asRecord(row)
    if (!member || typeof member.id !== 'string' || !member.id) continue
    const model = asRecord(member.model) ?? {}
    const work = asRecord(member.work)
    members.push({
      id: member.id,
      name: textOf(member.name, 120) || member.id,
      model: {
        agent: textOf(model.agent, 40) || 'dsh',
        model: textOf(model.model, 200) || 'unknown',
        ...(typeof model.provider === 'string' ? { provider: model.provider } : {}),
      },
      ...(typeof member.reasoning === 'string' ? { reasoning: member.reasoning } : {}),
      ...(work && typeof work.workspace === 'string' ? { work: { workspace: work.workspace } } : {}),
    })
  }
  const messages: RoomMessage[] = []
  for (const row of Array.isArray(item.messages) ? item.messages : []) {
    const message = asRecord(row)
    if (!message || typeof message.id !== 'string' || !message.id) continue
    messages.push({
      id: message.id,
      author: textOf(message.author, 120) || 'unknown',
      text: textOf(message.text, 16_384),
      ...(typeof message.markdown === 'string' ? { markdown: message.markdown.slice(0, 16_384) } : {}),
      state: textOf(message.state, 40) || 'completed',
      ...(typeof message.error === 'string' ? { error: message.error.slice(0, 512) } : {}),
      at: typeof message.at === 'number' ? message.at : 0,
    })
  }
  const calls: RoomCall[] = []
  for (const row of Array.isArray(item.calls) ? item.calls : []) {
    const call = asRecord(row)
    if (!call || typeof call.turnId !== 'string' || typeof call.memberId !== 'string') continue
    calls.push({
      turnId: call.turnId,
      memberId: call.memberId,
      state: textOf(call.state, 40) || 'unknown',
      ...(typeof call.phase === 'string' ? { phase: call.phase } : {}),
    })
  }
  return {
    id: item.id,
    title: textOf(item.title, 200) || '未命名群聊',
    state: textOf(item.state, 40) || 'unknown',
    ...(typeof item.phase === 'string' ? { phase: item.phase } : {}),
    ...(typeof item.mode === 'string' ? { mode: item.mode } : {}),
    rounds: typeof item.rounds === 'number' ? item.rounds : 0,
    revision: typeof item.revision === 'number' ? item.revision : 0,
    moderatorId: textOf(item.moderatorId, 128),
    members,
    messages,
    calls,
    cleared: item.cleared === true,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : 0,
  }
}

export function parsePreview(value: unknown): GroupPreview | null {
  const source = asRecord(value)
  const item = asRecord(source?.preview ?? value)
  if (!item || typeof item.digest !== 'string' || !item.digest) return null
  const members: PreviewMember[] = []
  for (const row of Array.isArray(item.members) ? item.members : []) {
    const member = asRecord(row)
    if (!member || typeof member.id !== 'string' || !member.id) continue
    if (typeof member.deviceId !== 'string' || !member.deviceId) continue
    const model = asRecord(member.model) ?? {}
    members.push({
      id: member.id,
      deviceId: member.deviceId,
      model: {
        ...(typeof model.id === 'string' && model.id ? { id: model.id } : {}),
        agent: textOf(model.agent, 40) || 'dsh',
        model: textOf(model.model, 200) || 'unknown',
        ...(typeof model.provider === 'string' ? { provider: model.provider } : {}),
      },
      ...(typeof member.reasoning === 'string' ? { reasoning: member.reasoning } : {}),
    })
  }
  return {
    digest: item.digest,
    mode: textOf(item.mode, 40) || 'discussion',
    title: textOf(item.title, 200),
    text: textOf(item.text, 16_384),
    members,
    moderatorId: textOf(item.moderatorId, 128),
    maxCalls: typeof item.maxCalls === 'number' ? item.maxCalls : 0,
    expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : 0,
  }
}

export interface GroupChoice { deviceId: string; modelId: string }

export interface OnboardLink {
  hub?: string
  token?: string
  ticket?: string
}

/** 解析一键配对深链：marshal://open?hub=...&token=...&ticket=... */
export function parseOnboardLink(raw: string): OnboardLink | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'marshal:') return null
  const hub = url.searchParams.get('hub') ?? undefined
  const token = url.searchParams.get('token') ?? undefined
  const ticket = url.searchParams.get('ticket') ?? undefined
  if (!hub && !token && !ticket) return null
  return {
    ...(hub ? { hub } : {}),
    ...(token ? { token } : {}),
    ...(ticket ? { ticket } : {}),
  }
}

/** 非加密指纹：只用于判重同一张一次性 ticket，不保存 ticket 原文。 */
export function ticketFingerprint(ticket: string): string {
  let hash = 2166136261
  for (let i = 0; i < ticket.length; i += 1) {
    hash ^= ticket.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 允许直接粘贴 ticket 或完整的 marshal://open?...ticket=... 深链。 */
export function extractTicket(input: string): string {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).searchParams.get('ticket')?.trim() ?? ''
    } catch {
      return ''
    }
  }
  const match = trimmed.match(/[?&]ticket=([^&\s]+)/)
  return match ? decodeURIComponent(match[1]) : trimmed
}

export function buildPreviewInput(input: {
  title: string
  text: string
  members: GroupChoice[]
  mode?: string
  moderator?: number
}): Record<string, unknown> {
  return {
    mode: input.mode ?? 'discussion',
    title: input.title,
    text: input.text,
    moderator: input.moderator ?? 0,
    members: input.members.map((choice) => ({ deviceId: choice.deviceId, modelId: choice.modelId, profile: {} })),
  }
}

export function buildSendPayload(roomId: string, text: string, key: string, recipient = 'moderator'): Record<string, unknown> {
  return { action: 'send', roomId, text, recipient, key }
}

export function isNativeAccountRuntime(): boolean {
  return isNativePlatform()
}
