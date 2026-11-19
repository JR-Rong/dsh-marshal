/**
 * 手机端直连 Hub 的只读/写入客户端。
 *
 * 与浏览器控制台走同一组 `/marshal/api/*` 接口，但界面由 App 自己绘制，
 * 不再加载 Hub 的网页。鉴权一律用 `x-marshal-token` 头（Hub 的 token 分支
 * 不需要 CSRF），流式事件走原生插件（见 lib/sse.ts）。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import type { MarshalConfig } from './config.ts'

export const TOKEN_HEADER = 'x-marshal-token'

/** 手机凭证走 Bearer mph1.；管理令牌仍走原来的头，两种不会混用。 */
export function authHeaders(token: string): Record<string, string> {
  if (token.startsWith('mph1.') || token.startsWith('mnd1.')) return { authorization: 'Bearer ' + token }
  return { [TOKEN_HEADER]: token }
}
const DEFAULT_TIMEOUT_MS = 15_000

export interface Target {
  deviceId: string
  agent: string
  sessionId: string | null
}

export interface Tunable {
  id: string
  scope?: string
  effect?: string
  editable?: boolean
  reason?: string
  direction?: string
  value?: unknown
}

export interface Capability {
  operations?: string[]
  ownership?: string
  runtimeEpoch?: string | null
  revision?: number | string
  tunables?: Tunable[]
  observe?: { history?: boolean; follow?: string }
  /** Hub 用「字段名 → 未开放原因」说明本会话缺哪些能力。 */
  unavailable?: Record<string, string> | string[]
}

export interface DeviceRow {
  id: string
  name: string
  agents: string[]
  connectedAt: number
  lastSeen: number
  syncing: boolean
  stale: boolean
  capabilities?: Record<string, Capability>
}

export interface SessionRow {
  deviceId: string
  agent: string
  sessionId: string
  running: boolean
  updatedAt: number
  title?: string
  blank?: boolean
  ownership?: string
  counts?: Record<string, number>
  capability?: Capability
}

export interface ModelRow {
  id: string
  label: string
  efforts: string[]
}

export interface SessionControls {
  models: ModelRow[]
  current: { model?: string; reasoning?: string }
}

export interface UploadReceipt {
  attachmentId: string
  bytes: number
  complete: boolean
}

export interface PromptOptions {
  model?: string
  reasoning?: string
}

export interface CardOption {
  id: string
  label: string
  ambiguous?: boolean
}

export interface CardQuestion {
  id: string
  prompt?: string
  multi?: boolean
  custom?: boolean
  required?: boolean
  options?: CardOption[]
}

export interface InputCard {
  requestId: string
  kind?: string
  runtimeEpoch?: string
  title?: string
  reason?: string
  questions?: CardQuestion[]
  approval?: {
    action: string
    title?: string
    detail?: string
    decisions: CardOption[]
  }
}

export interface HistoryItem {
  deviceId: string
  agent: string
  sessionId: string
  seq?: number
  ts?: number
  kind: string
  payload?: Record<string, unknown>
}

export type ApiFailure =
  | 'unauthorized' | 'rate-limited' | 'unreachable' | 'timeout'
  | 'server' | 'malformed' | 'rejected' | 'conflict'

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiFailure; message: string; status?: number; code?: string }

export function describeFailure(error: ApiFailure, code?: string): string {
  switch (error) {
    case 'unauthorized': return '令牌被 Hub 拒绝（401）'
    case 'rate-limited': return '尝试过于频繁（429）'
    case 'timeout': return 'Hub 响应超时'
    case 'unreachable': return '连不上 Hub'
    case 'server': return 'Hub 返回异常'
    case 'malformed': return 'Hub 返回了无法解析的数据'
    case 'rejected': return 'Hub 拒绝：' + (code ?? 'invalid')
    case 'conflict': return '状态冲突：' + (code ?? 'conflict')
  }
}

function statusFailure(status: number): ApiFailure | null {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate-limited'
  if (status === 400) return 'rejected'
  if (status === 409) return 'conflict'
  if (status >= 500) return 'server'
  return null
}

/** 202、等待确认、结果未知都不是成功。调用方应继续查 command-status，或显示失败并沿用同一个幂等键重试。 */
export function commandNeedsPoll(body: Record<string, unknown> | null | undefined): boolean {
  const status = body?.status
  return status === 'pending-confirmation' || status === 'outcome-unknown' || status === 'queued'
}

export function newIdempotencyKey(): string {
  const api = globalThis.crypto
  if (api && typeof api.randomUUID === 'function') return api.randomUUID()
  return 'k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/** 事件流里属于某会话的判断：deviceId + agent + sessionId 三者同时相等。 */
export function sameTarget(a: Target, b: Target): boolean {
  return a.deviceId === b.deviceId && a.agent === b.agent && a.sessionId === b.sessionId
}

/** 会话标题：标题优先，其次「新会话 / 未命名」。 */
export function sessionTitle(row: SessionRow): string {
  if (row.title && row.title.trim()) return row.title.trim()
  return row.blank ? '新会话' : '未命名会话'
}

export function agentLabel(agent: string): string {
  if (agent === 'dsh') return 'DSH'
  if (agent === 'codex') return 'Codex'
  if (agent === 'claude') return 'Claude'
  return agent
}

/** 能力文档里是否允许某个操作。 */
export function can(capability: Capability | undefined, op: string): boolean {
  if (!capability) return false
  return Array.isArray(capability.operations) && capability.operations.includes(op)
}

interface RequestOptions {
  method?: string
  body?: unknown
  timeoutMs?: number
  token?: string
}

export class MarshalApi {
  readonly hubUrl: string
  readonly token: string

  constructor(config: Pick<MarshalConfig, 'hubUrl' | 'token'>) {
    this.hubUrl = config.hubUrl.replace(/\/+$/, '')
    this.token = config.token
  }

  url(path: string): string {
    return this.hubUrl + path
  }

  streamUrl(): string {
    return this.url('/marshal/api/stream')
  }

  discussionStreamUrl(): string {
    return this.url('/marshal/api/discussions/stream')
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const native = (() => {
      try { return Capacitor.isNativePlatform() } catch { return false }
    })()
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST')
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = options.token ?? this.token
    if (token) Object.assign(headers, authHeaders(token))
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    // Android WebView 的原生 fetch 会带上 Origin: https://localhost，Hub 会按来源拒绝（403）。
    // 原生栈显式发 Hub 的精确 Origin；浏览器里由同源/代理处理，不手写这个禁止头。
    if (native) headers.origin = this.hubUrl
    const controller = native ? null : new AbortController()
    const timeout = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
    try {
      let status: number
      let text: string
      if (native) {
        const response = await CapacitorHttp.request({
          url: this.url(path),
          method,
          headers,
          ...(options.body === undefined ? {} : { data: options.body }),
          connectTimeout: timeoutMs,
          readTimeout: timeoutMs,
          responseType: 'text',
          shouldEncodeUrlParams: false,
        })
        status = response.status
        text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      } else {
        const response = await fetch(this.url(path), {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller?.signal,
          credentials: 'omit',
          cache: 'no-store',
        })
        status = response.status
        text = await response.text()
      }
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = null
        }
      }
      const record = (body ?? {}) as Record<string, unknown>
      const code = typeof record.code === 'string' ? record.code : undefined
      if (status === 403) {
        return {
          ok: false, error: 'unauthorized',
          message: 'Hub 拒绝了 App 的来源（403）；请升级到 0.3.2+，或用带正确 Origin 的原生请求',
          status,
        }
      }
      const failure = statusFailure(status)
      if (failure) {
        return { ok: false, error: failure, message: describeFailure(failure, code), status, ...(code ? { code } : {}) }
      }
      if (status < 200 || status >= 300) {
        return { ok: false, error: 'server', message: 'Hub 返回 ' + status, status }
      }
      return { ok: true, data: body as T }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const aborted = error instanceof Error && error.name === 'AbortError'
      const kind: ApiFailure = aborted || /timeout|timed out/i.test(message) ? 'timeout' : 'unreachable'
      return { ok: false, error: kind, message: describeFailure(kind) }
    } finally {
      if (timeout !== null) clearTimeout(timeout)
    }
  }

  async devices(): Promise<ApiResult<DeviceRow[]>> {
    const result = await this.request<{ devices?: unknown }>('/marshal/api/devices')
    if (!result.ok) return result
    return { ok: true, data: parseDevices(result.data) }
  }

  async sessions(deviceId: string): Promise<ApiResult<SessionRow[]>> {
    const result = await this.request<{ sessions?: unknown }>(
      '/marshal/api/sessions?device=' + encodeURIComponent(deviceId),
    )
    if (!result.ok) return result
    return { ok: true, data: parseSessions(result.data) }
  }

  /** 读取会话可用的模型/思考强度目录（不会改会话设置）。 */
  async controls(target: Target): Promise<ApiResult<SessionControls | null>> {
    const result = await this.command('controls', target, {})
    if (!result.ok) return result
    return { ok: true, data: parseControls(result.data?.result) }
  }

  /**
   * 分片上传一个附件；返回 Hub 的 attachmentId。
   * 文本/图片都按 256 KiB 一片走 upload 命令，最后一片 complete 才算成功。
   */
  async upload(
    target: Target,
    file: { name: string; mime: string; bytes: Uint8Array },
  ): Promise<ApiResult<UploadReceipt>> {
    if (file.bytes.length > 10 * 1024 * 1024) {
      return { ok: false, error: 'rejected', message: '附件不能超过 10 MB', code: 'size-limit' }
    }
    let digest: string
    try {
      digest = await sha256Hex(file.bytes)
    } catch {
      return { ok: false, error: 'server', message: '本机无法计算附件摘要' }
    }
    const id = randomUuid()
    const chunks = planUploadChunks(file.bytes.length)
    for (const chunk of chunks) {
      const part = file.bytes.subarray(chunk.offset, chunk.offset + chunk.length)
      const result = await this.command('upload', target, {
        id,
        name: file.name,
        mime: file.mime || 'application/octet-stream',
        size: file.bytes.length,
        offset: chunk.offset,
        data: bytesToBase64(part),
        sha256: digest,
      })
      if (!result.ok) return result
      const receipt = parseUploadReceipt(result.data?.result)
      if (chunk.offset + chunk.length === file.bytes.length) {
        if (!receipt?.complete) return { ok: false, error: 'server', message: '附件上传未完成' }
        return { ok: true, data: receipt }
      }
    }
    return { ok: false, error: 'server', message: '附件上传失败' }
  }

  async cancelRequest(target: Target, requestId: string): Promise<ApiResult<Record<string, unknown>>> {
    return this.command('cancel', target, { requestId })
  }

  async command(op: string, target: Target, args: unknown = {}, idempotencyKey = newIdempotencyKey()): Promise<ApiResult<Record<string, unknown>>> {
    const result = await this.request<Record<string, unknown>>('/marshal/api/command', {
      body: { op, target, args, idempotencyKey },
    })
    if (!result.ok) return result
    const body = result.data ?? {}
    if (body.ok === false || body.status === 'rejected') {
      const code = typeof body.code === 'string' ? body.code : 'invalid'
      return { ok: false, error: 'rejected', message: describeFailure('rejected', code), code }
    }
    if (!commandNeedsPoll(body)) return { ok: true, data: body }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const polled = await this.commandStatus(target, op, idempotencyKey)
      if (!polled.ok) return polled
      const next = polled.data ?? {}
      if (next.ok === false || next.status === 'rejected') {
        const code = typeof next.code === 'string' ? next.code : 'invalid'
        return { ok: false, error: 'rejected', message: describeFailure('rejected', code), code }
      }
      if (!commandNeedsPoll(next)) return { ok: true, data: next }
    }
    return { ok: false, error: 'timeout', message: 'Hub 还没有确认这次操作，可以重试' }
  }

  async commandStatus(target: Target, op: string, key: string): Promise<ApiResult<Record<string, unknown>>> {
    const query = new URLSearchParams({ deviceId: target.deviceId, agent: target.agent, op, key })
    if (target.sessionId) query.set('sessionId', target.sessionId)
    return this.request<Record<string, unknown>>('/marshal/api/command-status?' + query.toString())
  }

  async roster(): Promise<ApiResult<Array<{ deviceId: string; agent: string; name: string }>>> {
    const result = await this.request<{ agents?: unknown }>('/marshal/api/roster')
    if (!result.ok) return result
    const agents = Array.isArray(result.data?.agents) ? result.data.agents.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return []
      const item = row as Record<string, unknown>
      if (typeof item.name !== 'string' || !item.name) return []
      return [{
        deviceId: typeof item.deviceId === 'string' ? item.deviceId : '',
        agent: typeof item.agent === 'string' ? item.agent : 'dsh',
        name: item.name,
      }]
    }) : []
    return { ok: true, data: agents }
  }

  async board(): Promise<ApiResult<{ tasks: Array<{ id: string; deviceId: string; title: string; detail: string; status: string; revision: number }>; revisions: Record<string, number> }>> {
    const result = await this.request<{ tasks?: unknown; revisions?: unknown }>('/marshal/api/board')
    if (!result.ok) return result
    const revisions: Record<string, number> = {}
    if (typeof result.data?.revisions === 'object' && result.data.revisions !== null) {
      for (const [id, value] of Object.entries(result.data.revisions as Record<string, unknown>)) {
        if (typeof value === 'number') revisions[id] = value
      }
    }
    const tasks = Array.isArray(result.data?.tasks) ? result.data.tasks.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return []
      const item = row as Record<string, unknown>
      if (typeof item.id !== 'string' || typeof item.title !== 'string') return []
      return [{
        id: item.id,
        deviceId: typeof item.deviceId === 'string' ? item.deviceId : '',
        title: item.title,
        detail: typeof item.detail === 'string' ? item.detail : '',
        status: item.status === 'doing' || item.status === 'done' ? item.status : 'todo',
        revision: typeof item.revision === 'number' ? item.revision : 0,
      }]
    }) : []
    return { ok: true, data: { tasks, revisions } }
  }

  async unwatchSession(target: Target): Promise<ApiResult<Record<string, unknown>>> {
    return this.request('/marshal/api/unwatch', {
      body: { deviceId: target.deviceId, agent: target.agent, sessionId: target.sessionId },
    })
  }

  async boardWrite(body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
    const result = await this.request<Record<string, unknown>>('/marshal/api/board', { body })
    if (!result.ok) return result
    const payload = result.data ?? {}
    if (payload.ok === false || payload.code === 'conflict') {
      return { ok: false, error: 'conflict', message: '看板已被别的修改抢先，请刷新后再改', code: 'conflict' }
    }
    if (payload.code === 'queued' || payload.code === 'unsupported') {
      return { ok: true, data: payload }
    }
    return { ok: true, data: payload }
  }

  async memory(): Promise<ApiResult<Array<{ id: string; deviceId: string; layer: string; agent: string; text: string }>>> {
    const result = await this.request<{ entries?: unknown }>('/marshal/api/memory')
    if (!result.ok) return result
    const entries = Array.isArray(result.data?.entries) ? result.data.entries.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return []
      const item = row as Record<string, unknown>
      if (typeof item.text !== 'string') return []
      return [{
        id: typeof item.id === 'string' ? item.id : '',
        deviceId: typeof item.deviceId === 'string' ? item.deviceId : '',
        layer: item.layer === 'workspace' ? 'workspace' : 'private',
        agent: typeof item.agent === 'string' ? item.agent : '',
        text: item.text,
      }]
    }) : []
    return { ok: true, data: entries }
  }

  async registerPush(provider: 'apns' | 'fcm' | 'huawei', token: string, liveToken?: string): Promise<ApiResult<Record<string, unknown>>> {
    return this.request('/marshal/api/push-token', { body: { provider, token, ...(liveToken ? { liveToken } : {}) } })
  }

  async watchSession(target: Target): Promise<ApiResult<Record<string, unknown>>> {
    return this.request('/marshal/api/watch', {
      body: { deviceId: target.deviceId, agent: target.agent, sessionId: target.sessionId },
    })
  }

  async inputs(target: Target): Promise<ApiResult<InputCard[]>> {
    const result = await this.request<{ cards?: unknown }>('/marshal/api/inputs', { body: { target } })
    if (!result.ok) return result
    return { ok: true, data: parseCards((result.data as { cards?: unknown })?.cards) }
  }

  async history(target: Target, limit = 40, cursor?: string): Promise<ApiResult<{ items: HistoryItem[]; completeness: string; nextCursor?: string }>> {
    const result = await this.request<{ result?: unknown }>('/marshal/api/history', {
      body: { target, limit, ...(cursor ? { cursor } : {}) },
    })
    if (!result.ok) return result
    const payload = (result.data as { result?: unknown })?.result as Record<string, unknown> | undefined
    const items = Array.isArray(payload?.items) ? (payload.items as HistoryItem[]) : []
    return {
      ok: true,
      data: {
        items,
        completeness: typeof payload?.completeness === 'string' ? String(payload.completeness) : 'unconfirmed',
        ...(typeof payload?.nextCursor === 'string' ? { nextCursor: payload.nextCursor } : {}),
      },
    }
  }

  /** 订阅某会话的 follow 流；返回 Hub 签发的不透明 subscriptionId（若有）。 */
  async subscribe(target: Target): Promise<ApiResult<string | null>> {
    const result = await this.command('observe', target, { kind: 'follow', action: 'subscribe' })
    if (!result.ok) return result
    const body = result.data ?? {}
    const value = (body.result as Record<string, unknown> | undefined)?.subscriptionId
    return { ok: true, data: typeof value === 'string' ? value : null }
  }

  async unsubscribe(target: Target, subscriptionId: string | null): Promise<void> {
    await this.command('observe', target, { kind: 'follow', action: 'unsubscribe', subscriptionId: subscriptionId ?? newIdempotencyKey() })
  }

  async discussions(): Promise<ApiResult<{ rooms: unknown[]; catalog: unknown[]; presets: unknown[] }>> {
    const result = await this.request<{ rooms?: unknown[]; catalog?: unknown[]; presets?: unknown[] }>('/marshal/api/discussions')
    if (!result.ok) return result
    return {
      ok: true,
      data: {
        rooms: Array.isArray(result.data?.rooms) ? result.data.rooms : [],
        catalog: Array.isArray(result.data?.catalog) ? result.data.catalog : [],
        presets: Array.isArray(result.data?.presets) ? result.data.presets : [],
      },
    }
  }

  async discussion(roomId: string): Promise<ApiResult<Record<string, unknown>>> {
    const result = await this.request<{ room?: Record<string, unknown> }>(
      '/marshal/api/discussions?room=' + encodeURIComponent(roomId),
    )
    if (!result.ok) return result
    return { ok: true, data: result.data?.room ?? {} }
  }

  async discussionAction(payload: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
    const result = await this.request<Record<string, unknown>>('/marshal/api/discussions', { body: payload })
    if (!result.ok) return result
    return { ok: true, data: result.data ?? {} }
  }
}

/* ------------------------------ 纯解析函数 ------------------------------ */

export function parseDevices(value: unknown): DeviceRow[] {
  const rows = (value as { devices?: unknown } | null)?.devices
  if (!Array.isArray(rows)) return []
  const devices: DeviceRow[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id) continue
    const agents = Array.isArray(item.agents) ? item.agents.filter((agent): agent is string => typeof agent === 'string') : []
    devices.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name ? item.name : item.id,
      agents,
      connectedAt: typeof item.connectedAt === 'number' ? item.connectedAt : 0,
      lastSeen: typeof item.lastSeen === 'number' ? item.lastSeen : 0,
      syncing: item.syncing === true,
      stale: item.stale === true,
      ...(typeof item.capabilities === 'object' && item.capabilities !== null
        ? { capabilities: item.capabilities as Record<string, Capability> }
        : {}),
    })
  }
  return devices
}

export function parseSessions(value: unknown): SessionRow[] {
  const rows = (value as { sessions?: unknown } | null)?.sessions
  if (!Array.isArray(rows)) return []
  const sessions: SessionRow[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    if (typeof item.sessionId !== 'string' || !item.sessionId) continue
    if (typeof item.agent !== 'string' || !item.agent) continue
    sessions.push({
      deviceId: typeof item.deviceId === 'string' ? item.deviceId : '',
      agent: item.agent,
      sessionId: item.sessionId,
      running: item.running === true,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
      ...(typeof item.title === 'string' ? { title: item.title } : {}),
      ...(item.blank === true ? { blank: true } : {}),
      ...(typeof item.ownership === 'string' ? { ownership: item.ownership } : {}),
      ...(typeof item.counts === 'object' && item.counts !== null ? { counts: item.counts as Record<string, number> } : {}),
      ...(typeof item.capability === 'object' && item.capability !== null ? { capability: item.capability as Capability } : {}),
    })
  }
  return sessions
}

function parseOptions(raw: unknown): CardOption[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const item = entry as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.label !== 'string') return []
    return [{ id: item.id, label: item.label, ...(item.ambiguous === true ? { ambiguous: true } : {}) }]
  })
}

/** 任何「总是 / 记住 / 会话内」语义的审批选项都不得呈现或发送。 */
export function decisionIsSafe(decision: CardOption): boolean {
  const unsafe = /always|persist|remember|session|don'?t\s*ask|总是|始终|会话内/i
  return !unsafe.test(decision.id) && !unsafe.test(decision.label)
}

export function parseControls(value: unknown): SessionControls | null {
  const wrapped = (value as { controls?: unknown } | null | undefined)?.controls
  const source = (wrapped ?? value) as Record<string, unknown> | null | undefined
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const models: ModelRow[] = []
  if (Array.isArray(source.models)) {
    for (const row of source.models) {
      if (typeof row !== 'object' || row === null) continue
      const item = row as Record<string, unknown>
      if (typeof item.id !== 'string' || !item.id) continue
      const efforts = Array.isArray(item.efforts)
        ? item.efforts.filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
        : []
      models.push({
        id: item.id,
        label: typeof item.label === 'string' && item.label ? item.label : item.id,
        efforts,
      })
    }
  }
  const rawCurrent = (source.current ?? {}) as Record<string, unknown>
  return {
    models,
    current: {
      ...(typeof rawCurrent.model === 'string' && rawCurrent.model ? { model: rawCurrent.model } : {}),
      ...(typeof rawCurrent.reasoning === 'string' && rawCurrent.reasoning ? { reasoning: rawCurrent.reasoning } : {}),
    },
  }
}

export function parseUploadReceipt(value: unknown): UploadReceipt | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.attachmentId !== 'string' || !row.attachmentId) return null
  return {
    attachmentId: row.attachmentId,
    bytes: typeof row.bytes === 'number' && Number.isFinite(row.bytes) ? row.bytes : 0,
    complete: row.complete === true,
  }
}

/** 纯函数：把文件长度切成 upload 允许的分片（单片 256 KiB）。 */
export function planUploadChunks(size: number, chunkBytes = 256 * 1024): Array<{ offset: number; length: number }> {
  if (!Number.isFinite(size) || size < 0) return []
  if (size === 0) return [{ offset: 0, length: 0 }]
  const step = Math.max(1, Math.floor(chunkBytes))
  const chunks: Array<{ offset: number; length: number }> = []
  for (let offset = 0; offset < size; offset += step) {
    chunks.push({ offset, length: Math.min(step, size - offset) })
  }
  return chunks
}

/** 组装 prompt 参数：空模型/空思考强度/空附件都不发，避免 Hub 判非法。 */
export function buildPromptArgs(
  text: string,
  options?: PromptOptions,
  attachments?: readonly string[],
): Record<string, unknown> {
  const args: Record<string, unknown> = { text }
  const model = options?.model?.trim()
  const reasoning = options?.reasoning?.trim()
  if (model || reasoning) {
    args.options = {
      ...(model ? { model } : {}),
      ...(reasoning ? { reasoning } : {}),
    }
  }
  if (attachments && attachments.length > 0) args.attachments = [...attachments]
  return args
}

export function formatTokens(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (value >= 1_000) return (value / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(value))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('subtle crypto unavailable')
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  const digest = await subtle.digest('SHA-256', copy)
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function randomUuid(): string {
  const api = globalThis.crypto
  if (api && typeof api.randomUUID === 'function') return api.randomUUID()
  const bytes = new Uint8Array(16)
  if (api && typeof api.getRandomValues === 'function') api.getRandomValues(bytes)
  else for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function parseCards(raw: unknown): InputCard[] {
  if (!Array.isArray(raw)) return []
  const cards: InputCard[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    if (typeof item.requestId !== 'string' || !item.requestId) continue
    const questions = Array.isArray(item.questions)
      ? item.questions.flatMap((raw) => {
        if (typeof raw !== 'object' || raw === null) return []
        const question = raw as Record<string, unknown>
        if (typeof question.id !== 'string') return []
        return [{
          id: question.id,
          ...(typeof question.prompt === 'string' ? { prompt: question.prompt } : {}),
          ...(question.multi === true ? { multi: true } : {}),
          ...(question.custom === true ? { custom: true } : {}),
          ...(question.required === true ? { required: true } : {}),
          options: parseOptions(question.options),
        }]
      })
      : []
    const approvalRaw = typeof item.approval === 'object' && item.approval !== null
      ? item.approval as Record<string, unknown>
      : null
    const approval = approvalRaw && typeof approvalRaw.action === 'string'
      ? {
        action: approvalRaw.action,
        ...(typeof approvalRaw.title === 'string' ? { title: approvalRaw.title } : {}),
        ...(typeof approvalRaw.detail === 'string' ? { detail: approvalRaw.detail } : {}),
        decisions: parseOptions(approvalRaw.decisions).filter(decisionIsSafe),
      }
      : undefined
    cards.push({
      requestId: item.requestId,
      ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
      ...(typeof item.runtimeEpoch === 'string' ? { runtimeEpoch: item.runtimeEpoch } : {}),
      ...(typeof item.title === 'string' ? { title: item.title } : {}),
      ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
      ...(questions.length > 0 ? { questions } : {}),
      ...(approval ? { approval } : {}),
    })
  }
  return cards
}