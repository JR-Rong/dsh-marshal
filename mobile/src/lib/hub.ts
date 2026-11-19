/**
 * Hub 只读客户端。
 *
 * 只调用 marshal hub 的既有 HTTP 接口，不启动任何服务、不监听端口 ——
 * 手机端永远只能作为客户端（见 README「客户端约束」）。
 */
import { healthUrl } from './config.ts'

export const TOKEN_HEADER = 'x-marshal-token'
const TIMEOUT_MS = 12_000

export interface HubDevice {
  id: string
  name: string
  agents: string[]
  connectedAt: number
  lastSeen: number
  syncing: boolean
  stale: boolean
}

export interface HubSession {
  deviceId: string
  agent: string
  sessionId: string
  running: boolean
  updatedAt: number
  title?: string
  blank?: boolean
}

export type HubFailure = 'unauthorized' | 'rate-limited' | 'unreachable' | 'timeout' | 'server' | 'malformed'

export type HubResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: HubFailure; message: string; status?: number }

export function failureMessage(error: HubFailure): string {
  switch (error) {
    case 'unauthorized': return '令牌被 Hub 拒绝（401）'
    case 'rate-limited': return '尝试过于频繁（429），请稍后再试'
    case 'timeout': return 'Hub 响应超时'
    case 'unreachable': return '连不上 Hub，请检查地址与网络'
    case 'server': return 'Hub 返回异常'
    case 'malformed': return 'Hub 返回了无法解析的数据'
  }
}

function statusToFailure(status: number): HubFailure | null {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'server'
  return null
}

interface JsonOptions {
  token?: string
  method?: string
  body?: unknown
  timeoutMs?: number
}

export async function requestJson(url: string, options: JsonOptions = {}): Promise<HubResult<unknown>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.token) headers[TOKEN_HEADER] = options.token
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    })
    const failure = statusToFailure(response.status)
    if (failure) return { ok: false, error: failure, message: failureMessage(failure), status: response.status }
    if (!response.ok) return { ok: false, error: 'server', message: `Hub 返回 ${response.status}`, status: response.status }
    let value: unknown
    try {
      value = await response.json()
    } catch {
      return { ok: false, error: 'malformed', message: failureMessage('malformed'), status: response.status }
    }
    return { ok: true, data: value }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    const kind: HubFailure = aborted ? 'timeout' : 'unreachable'
    return { ok: false, error: kind, message: failureMessage(kind) }
  } finally {
    clearTimeout(timeout)
  }
}

/** hub 健康检查不需要令牌，用于「连接测试」的第一步。 */
export async function pingHub(hubUrl: string): Promise<HubResult<true>> {
  const result = await requestJson(healthUrl(hubUrl), { timeoutMs: 8000 })
  if (!result.ok) return result
  const value = result.data as { ok?: unknown } | null
  if (!value || value.ok !== true) return { ok: false, error: 'malformed', message: 'Hub 健康检查返回异常' }
  return { ok: true, data: true }
}

export async function fetchDevices(hubUrl: string, token: string): Promise<HubResult<HubDevice[]>> {
  if (!token) return { ok: false, error: 'unauthorized', message: '还没有填写管理令牌' }
  const result = await requestJson(hubUrl.replace(/\/+$/, '') + '/marshal/api/devices', { token })
  if (!result.ok) return result
  return { ok: true, data: parseDevices(result.data) }
}

export async function fetchSessions(hubUrl: string, token: string, deviceId: string): Promise<HubResult<HubSession[]>> {
  if (!token) return { ok: false, error: 'unauthorized', message: '还没有填写管理令牌' }
  const url = hubUrl.replace(/\/+$/, '') + '/marshal/api/sessions?device=' + encodeURIComponent(deviceId)
  const result = await requestJson(url, { token })
  if (!result.ok) return result
  return { ok: true, data: parseSessions(result.data) }
}

/** 纯函数：hub 的 devices 响应 → 模型。坏行丢弃，不整包失败。 */
export function parseDevices(value: unknown): HubDevice[] {
  const rows = (value as { devices?: unknown } | null)?.devices
  if (!Array.isArray(rows)) return []
  const devices: HubDevice[] = []
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
    })
  }
  return devices
}

/** 纯函数：hub 的 sessions 响应 → 模型。 */
export function parseSessions(value: unknown): HubSession[] {
  const rows = (value as { sessions?: unknown } | null)?.sessions
  if (!Array.isArray(rows)) return []
  const sessions: HubSession[] = []
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
    })
  }
  return sessions
}

export interface Overview {
  deviceCount: number
  sessionCount: number
  runningCount: number
  onlineDeviceCount: number
}

export function summarize(devices: HubDevice[], sessions: HubSession[]): Overview {
  return {
    deviceCount: devices.length,
    onlineDeviceCount: devices.filter((device) => !device.stale).length,
    sessionCount: sessions.length,
    runningCount: sessions.filter((session) => session.running).length,
  }
}

export function sessionTitle(session: HubSession): string {
  if (session.title && session.title.trim()) return session.title.trim()
  return session.blank ? '新会话' : '未命名会话'
}

export function agentLabel(agent: string): string {
  if (agent === 'dsh') return 'DSH'
  if (agent === 'codex') return 'Codex'
  if (agent === 'claude') return 'Claude'
  return agent
}
