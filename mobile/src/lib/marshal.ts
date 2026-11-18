/**
 * 手机端直连 Hub 的只读/写入客户端。
 *
 * 与浏览器控制台走同一组 `/marshal/api/*` 接口，但界面由 App 自己绘制，
 * 不再加载 Hub 的网页。鉴权一律用 `x-marshal-token` 头（Hub 的 token 分支
 * 不需要 CSRF），流式事件走原生插件（见 lib/sse.ts）。
 */
import type { MarshalConfig } from './config.ts'

export const TOKEN_HEADER = 'x-marshal-token'
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
  unavailable?: string[]
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
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = options.token ?? this.token
    if (token) headers[TOKEN_HEADER] = token
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    try {
      const response = await fetch(this.url(path), {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      })
      let body: unknown = null
      const text = await response.text()
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = null
        }
      }
      const record = (body ?? {}) as Record<string, unknown>
      const code = typeof record.code === 'string' ? record.code : undefined
      const failure = statusFailure(response.status)
      if (failure) {
        return { ok: false, error: failure, message: describeFailure(failure, code), status: response.status, ...(code ? { code } : {}) }
      }
      if (!response.ok) {
        return { ok: false, error: 'server', message: 'Hub 返回 ' + response.status, status: response.status }
      }
      return { ok: true, data: body as T }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      const kind: ApiFailure = aborted ? 'timeout' : 'unreachable'
      return { ok: false, error: kind, message: describeFailure(kind) }
    } finally {
      clearTimeout(timeout)
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

  async command(op: string, target: Target, args: unknown = {}): Promise<ApiResult<Record<string, unknown>>> {
    const result = await this.request<Record<string, unknown>>('/marshal/api/command', {
      body: { op, target, args, idempotencyKey: newIdempotencyKey() },
    })
    if (!result.ok) return result
    const body = result.data ?? {}
    if (body.status === 'rejected') {
      const code = typeof body.code === 'string' ? body.code : 'invalid'
      return { ok: false, error: 'rejected', message: describeFailure('rejected', code), code }
    }
    return { ok: true, data: body }
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
