import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DeviceRecord } from './devices.ts'
import { qrSvg } from './qr.ts'

export const PAIRING_TTL_MS = 60_000
const UNSAFE_DECISION = /always|persist|remember|session|don'?t\s*ask|总是|始终|会话内/i

export interface ControllerRecord {
  readonly id: string
  readonly name: string
  readonly accountHash: string
  readonly tokenDigest: string
  readonly revoked: boolean
  readonly role: 'controller'
}

export interface TaskCard {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly status: 'todo' | 'doing' | 'done'
  readonly updatedAt: number
}

export interface MemoryEntry {
  readonly id: string
  readonly agent: string
  readonly text: string
  readonly updatedAt: number
}

export interface RosterAgent {
  readonly deviceId: string
  readonly agent: string
  readonly name: string
}

export type PushProvider = 'apns' | 'fcm' | 'huawei'

export interface PushTarget {
  readonly provider: PushProvider
  readonly token: string
  readonly liveToken?: string
}

export interface PushCredentials {
  readonly apns?: { readonly keyId?: string; readonly teamId?: string; readonly bundleId?: string; readonly keyPath?: string }
  readonly fcm?: { readonly projectId?: string; readonly clientEmail?: string; readonly privateKeyPath?: string }
  readonly huawei?: { readonly appId?: string; readonly clientId?: string; readonly clientSecretPath?: string }
}

export interface PushNotice {
  readonly kind: 'approval' | 'question' | 'run-start' | 'run-finish'
  readonly title: string
  readonly body: string
}

export type PhoneAuth =
  | { readonly ok: true; readonly role: 'controller'; readonly controller: ControllerRecord }
  | { readonly ok: true; readonly role: 'node'; readonly device: DeviceRecord; readonly accountHash: string }
  | { readonly ok: false; readonly code: 'unauthorized' | 'revoked' | 'cross-account' }

const CONTROLLER_OPS = new Set(['prompt', 'answer', 'interrupt', 'create', 'fork', 'observe', 'cancel'])

export function controllerCommandAllowed(op: string, args: unknown): boolean {
  if (!CONTROLLER_OPS.has(op)) return false
  if (op !== 'answer') return true
  if (typeof args !== 'object' || args === null) return false
  const answers = (args as { answers?: unknown }).answers
  if (!Array.isArray(answers)) return false
  return answers.every((answer) => {
    if (typeof answer !== 'object' || answer === null) return false
    const id = (answer as { id?: unknown }).id
    return typeof id === 'string' && id.length > 0 && !UNSAFE_DECISION.test(id)
  })
}

export function pushProviderReady(config: PushCredentials | undefined, provider: PushProvider): boolean {
  const block = config?.[provider]
  if (!block) return false
  return Object.values(block).every((value) => typeof value === 'string' && value.trim() !== '' && !value.includes('PLACEHOLDER'))
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

export function createPhoneHub(options: {
  now?: () => number
  ownerHash?: string
  publicOrigin?: string
  push?: PushCredentials
  findNode?: (digest: string) => DeviceRecord | undefined
  fetch?: typeof fetch
} = {}) {
  const now = options.now ?? Date.now
  const codes = new Map<string, { accountHash: string; expiresAt: number }>()
  const controllers: ControllerRecord[] = []
  const tasks = new Map<string, TaskCard[]>()
  const memory = new Map<string, MemoryEntry[]>()
  const roster = new Map<string, RosterAgent[]>()
  const pushes = new Map<string, PushTarget>()
  let serial = 0

  const owner = (): string => options.ownerHash && options.ownerHash.length > 0 ? options.ownerHash : 'local'

  const purgeCodes = (): void => {
    const at = now()
    for (const [code, item] of codes) if (item.expiresAt <= at) codes.delete(code)
  }

  function authenticate(token: string): PhoneAuth {
    if (!token) return { ok: false, code: 'unauthorized' }
    const hashed = digest(token)
    const controller = controllers.find((item) => sameDigest(item.tokenDigest, hashed))
    if (controller) {
      if (controller.revoked) return { ok: false, code: 'revoked' }
      if (options.ownerHash && controller.accountHash !== options.ownerHash) return { ok: false, code: 'cross-account' }
      return { ok: true, role: 'controller', controller }
    }
    const node = options.findNode?.(hashed)
    if (!node) return { ok: false, code: 'unauthorized' }
    if (node.revoked) return { ok: false, code: 'revoked' }
    return { ok: true, role: 'node', device: node, accountHash: owner() }
  }

  function accountOf(auth: PhoneAuth): string | undefined {
    if (!auth.ok) return undefined
    return auth.role === 'controller' ? auth.controller.accountHash : auth.accountHash
  }

  return {
    authenticate,
    issuePairing(accountHash: string, hubOrigin: string): { code: string; expiresAt: number; url: string } {
      purgeCodes()
      if (options.ownerHash && accountHash !== options.ownerHash) {
        throw Object.assign(new Error('cross-account'), { code: 'cross-account' })
      }
      const code = randomBytes(16).toString('base64url')
      const expiresAt = now() + PAIRING_TTL_MS
      codes.set(code, { accountHash, expiresAt })
      const url = 'marshal://pair?code=' + encodeURIComponent(code) + '&hub=' + encodeURIComponent(hubOrigin)
      return { code, expiresAt, url }
    },
    redeem(code: string, name: string): { deviceId: string; credential: string; accountHash: string } {
      purgeCodes()
      const found = codes.get(code)
      codes.delete(code)
      if (!found) throw Object.assign(new Error('unknown'), { code: 'unknown' })
      if (found.expiresAt <= now()) throw Object.assign(new Error('expired'), { code: 'expired' })
      if (options.ownerHash && found.accountHash !== options.ownerHash) {
        throw Object.assign(new Error('cross-account'), { code: 'cross-account' })
      }
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > 80) throw Object.assign(new Error('invalid'), { code: 'invalid' })
      const credential = randomBytes(32).toString('base64url')
      const record: ControllerRecord = {
        id: 'phone-' + digest(found.accountHash + '|' + credential).slice(0, 32),
        name: trimmed,
        accountHash: found.accountHash,
        tokenDigest: digest(credential),
        revoked: false,
        role: 'controller',
      }
      controllers.push(record)
      return { deviceId: record.id, credential, accountHash: record.accountHash }
    },
    revoke(id: string): void {
      const index = controllers.findIndex((item) => item.id === id)
      const current = controllers[index]
      if (!current || current.revoked) throw Object.assign(new Error('unknown-device'), { code: 'unknown-device' })
      controllers[index] = { ...current, revoked: true }
    },
    listControllers(): ControllerRecord[] {
      return controllers.filter((item) => !item.revoked).map((item) => ({ ...item }))
    },
    tasksFor(auth: PhoneAuth): TaskCard[] {
      const account = accountOf(auth)
      if (!account) return []
      return (tasks.get(account) ?? []).map((item) => ({ ...item }))
    },
    writeTasks(auth: PhoneAuth, body: Record<string, unknown>): TaskCard[] {
      const account = accountOf(auth)
      if (!auth.ok || !account) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' })
      const action = body.action
      const current = tasks.get(account) ?? []
      if (action === 'snapshot' || action === 'forward') {
        if (auth.role !== 'node') throw Object.assign(new Error('unsupported'), { code: 'unsupported' })
        const next = normalizeTasks(body.tasks, now())
        tasks.set(account, next)
        return next
      }
      if (auth.role === 'node' && action !== 'create' && action !== 'edit' && action !== 'move') {
        throw Object.assign(new Error('unsupported'), { code: 'unsupported' })
      }
      if (action === 'create') {
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (!title) throw Object.assign(new Error('invalid'), { code: 'invalid' })
        const card: TaskCard = {
          id: 'task-' + String(++serial),
          title: title.slice(0, 120),
          detail: typeof body.detail === 'string' ? body.detail.slice(0, 2000) : '',
          status: 'todo',
          updatedAt: now(),
        }
        const next = [card, ...current]
        tasks.set(account, next)
        return next
      }
      const id = typeof body.id === 'string' ? body.id : ''
      const index = current.findIndex((item) => item.id === id)
      if (index < 0) throw Object.assign(new Error('unknown'), { code: 'unknown' })
      const card = current[index]!
      let nextCard = card
      if (action === 'edit') {
        nextCard = {
          ...card,
          ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim().slice(0, 120) } : {}),
          ...(typeof body.detail === 'string' ? { detail: body.detail.slice(0, 2000) } : {}),
          updatedAt: now(),
        }
      } else if (action === 'move') {
        const status = body.status === 'doing' || body.status === 'done' || body.status === 'todo' ? body.status : null
        if (!status) throw Object.assign(new Error('invalid'), { code: 'invalid' })
        nextCard = { ...card, status, updatedAt: now() }
      } else {
        throw Object.assign(new Error('unsupported'), { code: 'unsupported' })
      }
      const next = current.map((item, itemIndex) => itemIndex === index ? nextCard : item)
      tasks.set(account, next)
      return next
    },
    readMemory(auth: PhoneAuth): MemoryEntry[] {
      const account = accountOf(auth)
      if (!account) return []
      return (memory.get(account) ?? []).map((item) => ({ ...item }))
    },
    writeMemory(auth: PhoneAuth, entries: unknown): MemoryEntry[] {
      if (!auth.ok || auth.role !== 'node') throw Object.assign(new Error('read-only'), { code: 'read-only' })
      const next = normalizeMemory(entries, now())
      memory.set(auth.accountHash, next)
      return next
    },
    readRoster(auth: PhoneAuth): RosterAgent[] {
      const account = accountOf(auth)
      if (!account) return []
      return (roster.get(account) ?? []).map((item) => ({ ...item }))
    },
    writeRoster(auth: PhoneAuth, agents: unknown): RosterAgent[] {
      if (!auth.ok || auth.role !== 'node') throw Object.assign(new Error('unsupported'), { code: 'unsupported' })
      const next = normalizeRoster(agents)
      roster.set(auth.accountHash, next)
      return next
    },
    registerPush(auth: PhoneAuth, target: PushTarget): void {
      if (!auth.ok || auth.role !== 'controller') throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' })
      if (target.provider !== 'apns' && target.provider !== 'fcm' && target.provider !== 'huawei') {
        throw Object.assign(new Error('invalid'), { code: 'invalid' })
      }
      if (!target.token || target.token.length > 4096) throw Object.assign(new Error('invalid'), { code: 'invalid' })
      pushes.set(auth.controller.id, { ...target })
    },
    async notify(notice: PushNotice): Promise<Array<{ deviceId: string; delivered: boolean; reason?: string }>> {
      const results = []
      for (const controller of controllers) {
        if (controller.revoked) continue
        if (options.ownerHash && controller.accountHash !== options.ownerHash) continue
        const target = pushes.get(controller.id)
        if (!target) {
          results.push({ deviceId: controller.id, delivered: false, reason: 'no-token' })
          continue
        }
        if (!pushProviderReady(options.push, target.provider)) {
          results.push({ deviceId: controller.id, delivered: false, reason: 'unconfigured' })
          continue
        }
        const fetcher = options.fetch
        if (fetcher) {
          await fetcher('https://push.invalid/' + target.provider, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: target.token, liveToken: target.liveToken, notice }),
          })
        }
        results.push({ deviceId: controller.id, delivered: true })
      }
      return results
    },
    pairingUrl(code: string, hubOrigin: string): string {
      return 'marshal://pair?code=' + encodeURIComponent(code) + '&hub=' + encodeURIComponent(hubOrigin)
    },
  }
}

function normalizeTasks(raw: unknown, at: number): TaskCard[] {
  if (!Array.isArray(raw)) return []
  const cards: TaskCard[] = []
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.title !== 'string' || !item.title.trim()) continue
    const status = item.status === 'doing' || item.status === 'done' ? item.status : 'todo'
    cards.push({
      id: item.id.slice(0, 80),
      title: item.title.trim().slice(0, 120),
      detail: typeof item.detail === 'string' ? item.detail.slice(0, 2000) : '',
      status,
      updatedAt: at,
    })
  }
  return cards
}

function normalizeMemory(raw: unknown, at: number): MemoryEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: MemoryEntry[] = []
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.text !== 'string') continue
    entries.push({
      id: item.id.slice(0, 80),
      agent: typeof item.agent === 'string' ? item.agent.slice(0, 80) : '',
      text: item.text.slice(0, 4000),
      updatedAt: at,
    })
  }
  return entries
}

function normalizeRoster(raw: unknown): RosterAgent[] {
  if (!Array.isArray(raw)) return []
  const agents: RosterAgent[] = []
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    if (typeof item.deviceId !== 'string' || typeof item.agent !== 'string' || typeof item.name !== 'string') continue
    agents.push({ deviceId: item.deviceId.slice(0, 128), agent: item.agent.slice(0, 80), name: item.name.slice(0, 80) })
  }
  return agents
}

export type PhoneHub = ReturnType<typeof createPhoneHub>

/** 节点把任务板、只读记忆和花名册推到 Hub。失败不抛到调用方。 */
export async function forwardPhoneState(input: {
  hubHttpOrigin: string
  token: string
  tasks?: unknown
  memory?: unknown
  roster?: unknown
  fetch?: typeof fetch
}): Promise<{ tasks: boolean; memory: boolean; roster: boolean }> {
  const fetcher = input.fetch ?? fetch
  const headers = { 'content-type': 'application/json', 'x-marshal-token': input.token }
  const post = async (path: string, body: unknown): Promise<boolean> => {
    try {
      const response = await fetcher(input.hubHttpOrigin.replace(/\/+$/, '') + path, {
        method: 'POST', headers, body: JSON.stringify(body),
      })
      return response.ok
    } catch {
      return false
    }
  }
  const [tasksOk, memoryOk, rosterOk] = await Promise.all([
    post('/marshal/api/tasks', { action: 'snapshot', tasks: input.tasks ?? [] }),
    post('/marshal/api/memory', { entries: input.memory ?? [] }),
    post('/marshal/api/roster', { agents: input.roster ?? [] }),
  ])
  return { tasks: tasksOk, memory: memoryOk, roster: rosterOk }
}

export function hubHttpOrigin(hubUrl: string): string {
  const url = new URL(hubUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.origin
}

export function noticeForEvent(kind: string, payload?: unknown): PushNotice | null {
  if (kind === 'input.requested') {
    const approval = typeof payload === 'object' && payload !== null && 'approval' in payload
    return approval
      ? { kind: 'approval', title: '需要审批', body: '有一条只允许本次的审批' }
      : { kind: 'question', title: '需要回答', body: '有一条提问' }
  }
  if (kind === 'turn.started') return { kind: 'run-start', title: '开始运行', body: '会话开始了一轮' }
  if (kind === 'turn.completed') return { kind: 'run-finish', title: '运行结束', body: '这一轮已经结束' }
  return null
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export function registerPhoneRoutes(input: {
  phone: PhoneHub
  publicOrigin: string
  register: (path: string, handler: RouteHandler) => void
  guard: (handler: RouteHandler) => RouteHandler
  json: (res: ServerResponse, status: number, body: unknown) => void
  deny: (res: ServerResponse, status: number, body: string) => void
  methodNotAllowed: (res: ServerResponse, allow: string) => void
  authorize: (req: IncomingMessage, res: ServerResponse, auth: {
    allowToken: boolean
    allowDevice?: boolean
    refresh: boolean
    write: boolean
  }) => { kind: string; session?: { account?: { accountHash: string } } } | undefined
  readJsonBody: (req: IncomingMessage, res: ServerResponse, limit: number) => Promise<{ ok: true; value: unknown } | { ok: false }>
  headerValue: (req: IncomingMessage, name: string) => string | undefined
  asRecord: (value: unknown) => Record<string, unknown> | undefined
  smallBodyLimit: number
}): void {
  const { phone, publicOrigin, register, guard, json, deny, methodNotAllowed, authorize, readJsonBody, headerValue, asRecord, smallBodyLimit } = input
  const sessionOnly = { allowToken: false, allowDevice: false, refresh: true, write: true }
  const bearer = (req: IncomingMessage) => {
    const header = headerValue(req, 'x-marshal-token')
    if (!header) return undefined
    const auth = phone.authenticate(header)
    return auth.ok ? auth : undefined
  }
  const phoneJson = (auth: ReturnType<typeof bearer>, res: ServerResponse): auth is NonNullable<ReturnType<typeof bearer>> => {
    if (!auth) { deny(res, 401, 'unauthorized'); return false }
    return true
  }
  register('/marshal/pair', guard((req, res) => {
    if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
    const auth = authorize(req, res, { allowToken: false, refresh: false, write: false })
    if (auth?.kind !== 'session') return
    if (!auth.session?.account) { json(res, 403, { ok: false, code: 'account-required' }); return }
    try {
      const issued = phone.issuePairing(auth.session.account.accountHash, publicOrigin)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(pairingPage(issued.url, issued.code, qrSvg(issued.url)))
    } catch {
      json(res, 403, { ok: false, code: 'cross-account' })
    }
  }))
  register('/marshal/api/pairing', guard((req, res) => {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    const auth = authorize(req, res, sessionOnly)
    if (auth?.kind !== 'session') return
    if (!auth.session?.account) { json(res, 403, { ok: false, code: 'account-required' }); return }
    try {
      json(res, 200, { ok: true, ...phone.issuePairing(auth.session.account.accountHash, publicOrigin) })
    } catch {
      json(res, 403, { ok: false, code: 'cross-account' })
    }
  }))
  register('/marshal/api/pairing/redeem', guard(async (req, res) => {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    if (headerValue(req, 'x-marshal-token')) { deny(res, 403, 'forbidden'); return }
    const read = await readJsonBody(req, res, smallBodyLimit)
    if (!read.ok) return
    const body = asRecord(read.value)
    if (!body || typeof body.code !== 'string' || typeof body.name !== 'string') {
      json(res, 400, { ok: false, code: 'invalid-args' }); return
    }
    try {
      const created = phone.redeem(body.code, body.name)
      json(res, 200, { ok: true, deviceId: created.deviceId, credential: created.credential })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code?: string }).code) : 'unknown'
      json(res, code === 'expired' || code === 'unknown' ? 410 : 403, { ok: false, code })
    }
  }))
  register('/marshal/api/controllers/revoke', guard(async (req, res) => {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    if (authorize(req, res, sessionOnly) === undefined) return
    const read = await readJsonBody(req, res, smallBodyLimit)
    if (!read.ok) return
    const body = asRecord(read.value)
    if (!body || typeof body.deviceId !== 'string') { json(res, 400, { ok: false, code: 'invalid-args' }); return }
    try {
      phone.revoke(body.deviceId)
      json(res, 200, { ok: true })
    } catch {
      json(res, 404, { ok: false, code: 'unknown-device' })
    }
  }))
  register('/marshal/api/tasks', guard(async (req, res) => {
    const auth = bearer(req)
    if (!phoneJson(auth, res)) return
    if (req.method === 'GET') { json(res, 200, { ok: true, tasks: phone.tasksFor(auth) }); return }
    if (req.method !== 'POST') { methodNotAllowed(res, 'GET, POST'); return }
    const read = await readJsonBody(req, res, 65_536)
    if (!read.ok) return
    const body = asRecord(read.value)
    if (!body) { json(res, 400, { ok: false, code: 'invalid-args' }); return }
    try { json(res, 200, { ok: true, tasks: phone.writeTasks(auth, body) }) }
    catch (error) { json(res, 403, { ok: false, code: error instanceof Error && 'code' in error ? (error as { code?: string }).code : 'unsupported' }) }
  }))
  register('/marshal/api/memory', guard(async (req, res) => {
    const auth = bearer(req)
    if (!phoneJson(auth, res)) return
    if (req.method === 'GET') { json(res, 200, { ok: true, entries: phone.readMemory(auth) }); return }
    if (req.method !== 'POST') { methodNotAllowed(res, 'GET, POST'); return }
    if (auth.role !== 'node') { json(res, 403, { ok: false, code: 'read-only' }); return }
    const read = await readJsonBody(req, res, 65_536)
    if (!read.ok) return
    const body = asRecord(read.value)
    try { json(res, 200, { ok: true, entries: phone.writeMemory(auth, body?.entries) }) }
    catch (error) { json(res, 403, { ok: false, code: error instanceof Error && 'code' in error ? (error as { code?: string }).code : 'read-only' }) }
  }))
  register('/marshal/api/roster', guard(async (req, res) => {
    const auth = bearer(req)
    if (!phoneJson(auth, res)) return
    if (req.method === 'GET') { json(res, 200, { ok: true, agents: phone.readRoster(auth) }); return }
    if (req.method !== 'POST') { methodNotAllowed(res, 'GET, POST'); return }
    if (auth.role !== 'node') { json(res, 403, { ok: false, code: 'unsupported' }); return }
    const read = await readJsonBody(req, res, 65_536)
    if (!read.ok) return
    const body = asRecord(read.value)
    try { json(res, 200, { ok: true, agents: phone.writeRoster(auth, body?.agents) }) }
    catch { json(res, 403, { ok: false, code: 'unsupported' }) }
  }))
  register('/marshal/api/push/register', guard(async (req, res) => {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    const auth = bearer(req)
    if (!phoneJson(auth, res)) return
    const read = await readJsonBody(req, res, smallBodyLimit)
    if (!read.ok) return
    const body = asRecord(read.value)
    const provider = body?.provider
    if (!body || (provider !== 'apns' && provider !== 'fcm' && provider !== 'huawei') || typeof body.token !== 'string') {
      json(res, 400, { ok: false, code: 'invalid-args' }); return
    }
    try {
      phone.registerPush(auth, {
        provider, token: body.token,
        ...(typeof body.liveToken === 'string' ? { liveToken: body.liveToken } : {}),
      })
      json(res, 200, { ok: true })
    } catch {
      json(res, 403, { ok: false, code: 'unauthorized' })
    }
  }))
}

export function pairingPage(url: string, code: string, svg: string): string {
  const escape = (value: string): string => value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)
  return `<!doctype html><meta charset="utf-8"><title>手机配对</title>
<body style="font-family:sans-serif;background:#151719;color:#edf0f3;display:grid;place-items:center;min-height:100vh">
<main style="max-width:28rem;text-align:center">
<h1>手机配对</h1>
<p>用手机相机扫描。码一分钟内有效，只能用一次。不会把 DeepSeek 密码发到手机。</p>
${svg}
<p style="word-break:break-all">${escape(url)}</p>
<p>配对码：${escape(code)}</p>
</main></body>`
}
