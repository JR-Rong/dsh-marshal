/**
 * 手机端本地配置模型与 Hub 地址规范化。
 * 这个文件是纯函数，Node 单元测试直接 import 它。
 */

export const CONFIG_VERSION = 1
/** 首次进入时不预填任何真实地址，避免把运维地址写进仓库。 */
export const DEFAULT_HUB = ''
/** hub 对外的控制台路径（与浏览器版同一页面）。 */
export const CONSOLE_PATH = '/marshal'
export const MIN_TOKEN_LENGTH = 16

export interface AppLock {
  salt: string
  hash: string
  iterations: number
}

/**
 * 账号 ticket 换来的浏览器会话。
 * 只用于群聊接口（discussions 只认 cookie），不替代管理令牌。
 */
export interface AccountSession {
  /** 原样保存的 Cookie 头：__Host-marshal-session=…; __Host-marshal-csrf=… */
  cookies: string
  /** 服务端会话绑定的 CSRF token，写请求必须同时放在 x-marshal-csrf 头里。 */
  csrf: string
  /** 会话绝对到期时间（毫秒）；Hub 侧 8 小时。 */
  expiresAt: number
  /** 可选：票面账号摘要/名称，仅用于界面显示。 */
  accountHash?: string
  name?: string
}

export interface MarshalConfig {
  version: number
  /** 规范化后的 Hub origin，例如 https://hub.example.com（无尾斜杠、无路径）。 */
  hubUrl: string
  /** 管理令牌（dashboardToken）。只存在手机本地，用于原生仪表盘读取设备与会话。 */
  token: string
  /** 人类可读的备注，仅用于首页展示。 */
  label: string
  /** 应用锁；null 表示未启用。 */
  lock: AppLock | null
  /** 群聊账号会话；null/缺省表示未用 ticket 登录。 */
  account?: AccountSession | null
  updatedAt: number
}

export type NormalizedHub = { ok: true; value: string } | { ok: false; error: string }

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** 判断地址是否属于本机/局域网，允许 http 明文（仅调试用）。 */
export function isLocalHost(hostname: string): boolean {
  if (LOCAL_HOSTS.has(hostname)) return true
  if (hostname.endsWith('.local')) return true
  if (/^10\./.test(hostname)) return true
  if (/^192\.168\./.test(hostname)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true
  return false
}

/**
 * 把用户输入整理成 Hub origin：
 * - 缺协议时补 https://
 * - 允许粘贴带 /marshal 或 /marshal/setup 的完整地址，统一裁到 origin
 * - 拒绝非 http(s)、带账号密码、缺主机名的地址
 * - 非本机地址强制 https
 */
export function normalizeHubUrl(raw: string): NormalizedHub {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { ok: false, error: '请填写 Hub 地址' }

  let candidate = trimmed
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) candidate = 'https://' + candidate

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, error: '地址格式不正确' }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: '只支持 http/https 地址' }
  }
  if (url.username || url.password) return { ok: false, error: '地址里不要带账号密码' }
  if (!url.hostname) return { ok: false, error: '地址缺少主机名' }
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    return { ok: false, error: '公网 Hub 必须用 https，否则令牌会在链路上明文传输' }
  }

  const path = url.pathname.replace(/\/+$/, '')
  if (path && path !== CONSOLE_PATH && !path.startsWith(CONSOLE_PATH + '/')) {
    // 允许粘贴更深的自定义路径，但 Hub 的接口都在 origin 根上，这里统一收敛。
    if (!/^\/(marshal)/.test(path)) return { ok: false, error: '只填 Hub 的源地址，例如 https://hub.example.com' }
  }

  return { ok: true, value: url.origin }
}

/** 浏览器/内嵌 WebView 打开的控制台地址。 */
export function consoleUrl(hubUrl: string): string {
  return hubUrl.replace(/\/+$/, '') + CONSOLE_PATH
}

/** 健康检查地址（hub 自带，不需要令牌）。 */
export function healthUrl(hubUrl: string): string {
  return hubUrl.replace(/\/+$/, '') + '/marshal/health'
}

/** 首页展示用的短标签。 */
export function hubLabel(hubUrl: string): string {
  try {
    return new URL(hubUrl).host
  } catch {
    return hubUrl
  }
}

/** 令牌只做长度与空白校验，真实校验交给 hub。 */
export function normalizeToken(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = (raw ?? '').trim()
  if (!value) return { ok: true, value: '' }
  if (/\s/.test(value)) return { ok: false, error: '令牌里不能有空白字符' }
  if (value.length < MIN_TOKEN_LENGTH) return { ok: false, error: `令牌至少 ${MIN_TOKEN_LENGTH} 位` }
  return { ok: true, value }
}

/** 从任何来源（安全存储/旧版本/损坏数据）还原配置，坏数据一律丢弃。 */
export function parseConfig(raw: unknown): MarshalConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (value.version !== CONFIG_VERSION) return null
  if (typeof value.hubUrl !== 'string') return null
  const normalized = normalizeHubUrl(value.hubUrl)
  if (!normalized.ok) return null
  const token = typeof value.token === 'string' ? value.token : ''
  const lock = parseLock(value.lock)
  const account = parseAccount(value.account)
  return {
    version: CONFIG_VERSION,
    hubUrl: normalized.value,
    token,
    label: typeof value.label === 'string' ? value.label.slice(0, 60) : '',
    lock,
    ...(account === null ? {} : { account }),
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
  }
}

/** Cookie/CSRF 只接受单行、可控长度的字符串，防止把头注入或写坏存储。 */
function parseAccount(raw: unknown): AccountSession | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.cookies !== 'string' || !value.cookies || value.cookies.length > 4_096) return null
  if (typeof value.csrf !== 'string' || !value.csrf || value.csrf.length > 512) return null
  if (/[\x00-\x1f\x7f]/.test(value.cookies) || /[\x00-\x1f\x7f]/.test(value.csrf)) return null
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0) return null
  return {
    cookies: value.cookies,
    csrf: value.csrf,
    expiresAt: Math.round(value.expiresAt),
    ...(typeof value.accountHash === 'string' && /^[a-f0-9]{64}$/.test(value.accountHash)
      ? { accountHash: value.accountHash }
      : {}),
    ...(typeof value.name === 'string' && value.name.trim()
      ? { name: value.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) }
      : {}),
  }
}

function parseLock(raw: unknown): AppLock | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.salt !== 'string' || typeof value.hash !== 'string') return null
  if (typeof value.iterations !== 'number' || !Number.isFinite(value.iterations)) return null
  if (value.iterations < 10_000 || value.iterations > 2_000_000) return null
  return { salt: value.salt, hash: value.hash, iterations: Math.round(value.iterations) }
}

export function makeConfig(input: { hubUrl: string; token?: string; label?: string }): MarshalConfig {
  return {
    version: CONFIG_VERSION,
    hubUrl: input.hubUrl,
    token: input.token ?? '',
    label: input.label ?? '',
    lock: null,
    account: null,
    updatedAt: Date.now(),
  }
}
