import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'

export interface ForwardBody {
  tasks?: unknown
  memory?: unknown
  roster?: unknown
  read: true
}

/** 没读到的面不要带上空数组，避免 Hub 用空快照盖掉别的设备或手机刚改的内容。 */
export function forwardBody(input: {
  tasks: unknown[] | null
  memory: unknown[] | null
  roster: unknown[] | null
}): ForwardBody {
  return {
    read: true,
    ...(input.tasks === null ? {} : { tasks: input.tasks }),
    ...(input.memory === null ? {} : { memory: input.memory }),
    ...(input.roster === null ? {} : { roster: input.roster }),
  }
}

export function rosterFromLedger(ledger: { teams?: Array<{ members?: Array<{ id?: string; name?: string }> }> } | null, deviceId: string): Array<{ deviceId: string; agent: string; name: string }> {
  const agents = []
  for (const team of ledger?.teams ?? []) {
    for (const member of team.members ?? []) {
      if (typeof member.name !== 'string' || !member.name.trim()) continue
      agents.push({
        deviceId,
        agent: typeof member.id === 'string' && member.id ? member.id : 'dsh',
        name: member.name.trim(),
      })
    }
  }
  return agents
}

/** 只读私有层和项目层。内容共享关闭时不外发，调用方应省略这个字段而不是上报空数组。 */
export function readMemoryDir(root: string, allowContent: boolean, cap = 24_000): Array<{ id: string; layer: 'private' | 'workspace'; agent: string; text: string }> | null {
  if (!allowContent) return null
  const entries: Array<{ id: string; layer: 'private' | 'workspace'; agent: string; text: string }> = []
  let used = 0
  const take = (id: string, layer: 'private' | 'workspace', file: string): void => {
    if (used >= cap) return
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return }
    text = text.slice(0, Math.max(0, cap - used))
    if (!text.trim()) return
    used += text.length
    entries.push({ id, layer, agent: '', text })
  }
  take('rules', 'private', join(root, 'global', 'rules.md'))
  take('profile', 'private', join(root, 'global', 'profile.md'))
  let names: string[] = []
  try { names = readdirSync(join(root, 'workspaces')) } catch { names = [] }
  for (const name of names) {
    take(name + '/handoff', 'workspace', join(root, 'workspaces', name, 'handoff.md'))
    take(name + '/notes', 'workspace', join(root, 'workspaces', name, 'notes.md'))
  }
  return entries
}

export function hubHttpOrigin(hubUrl: string): string {
  const url = new URL(hubUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
  return url.origin
}

/** 节点上报走自己的 Bearer 前缀，并使用配置里的私有 CA。 */
export function postNodeJson(input: {
  origin: string
  path: string
  token: string
  body: unknown
  ca?: Buffer
}): Promise<{ status: number }> {
  const url = new URL(input.path, input.origin)
  const payload = Buffer.from(JSON.stringify(input.body))
  const lib = url.protocol === 'https:' ? https : http
  return new Promise((resolve) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        authorization: 'Bearer mnd1.' + input.token,
      },
      ...(input.ca && url.protocol === 'https:' ? { ca: input.ca } : {}),
    }, (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0 })
    })
    req.on('error', () => resolve({ status: 0 }))
    req.end(payload)
  })
}

const BOARD_KINDS = ['create', 'delete', 'run', 'edit', 'move'] as const
export type BoardKind = typeof BOARD_KINDS[number]

export interface BoardCapabilities {
  readonly read: boolean
  readonly revision: boolean
  readonly apply: readonly BoardKind[]
}

export interface PhoneHost {
  readonly board?: {
    snapshot?: () => unknown
    capabilities?: () => { revision?: boolean; apply?: readonly string[] }
    apply?: (requestId: string, action: Record<string, unknown>) => unknown
  }
  readonly memory?: {
    readPhone?: (input: { allowContent: boolean; capBytes: number }) => unknown
  }
  readonly roster?: {
    list?: () => unknown
  }
}

/** 没有 capabilities() 就不调用 apply。现有实现会把不认识的 kind 静默忽略，不能拿来假装写成功。 */
export function boardCapabilities(board: PhoneHost['board']): BoardCapabilities {
  const read = typeof board?.snapshot === 'function'
  const advertised = typeof board?.capabilities === 'function' ? board.capabilities() : undefined
  const apply = Array.isArray(advertised?.apply)
    ? advertised.apply.filter((kind): kind is BoardKind => (BOARD_KINDS as readonly string[]).includes(kind))
    : []
  return { read, revision: advertised?.revision === true, apply }
}

export interface PhoneFaces {
  readonly tasks: unknown[] | null
  readonly memory: unknown[] | null
  readonly roster: unknown[] | null
  readonly revision: number | null
}

function asTasks(value: unknown): { tasks: unknown[]; revision: number | null } | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as { tasks?: unknown; revision?: unknown }
  if (!Array.isArray(record.tasks)) return null
  return { tasks: record.tasks, revision: typeof record.revision === 'number' ? record.revision : null }
}

/** 只上报主机真的返回的面。读失败或方法不存在时该面是 null，不能补成空数组。 */
export async function readPhoneFaces(host: PhoneHost | undefined, allowContent: boolean): Promise<PhoneFaces> {
  let tasks: unknown[] | null = null
  let revision: number | null = null
  if (typeof host?.board?.snapshot === 'function') {
    try {
      const snap = asTasks(await host.board.snapshot())
      if (snap) { tasks = snap.tasks; revision = snap.revision }
    } catch { tasks = null }
  }
  let memory: unknown[] | null = null
  if (typeof host?.memory?.readPhone === 'function') {
    try {
      const result = await host.memory.readPhone({ allowContent, capBytes: 24_000 })
      if (typeof result === 'object' && result !== null && Array.isArray((result as { entries?: unknown }).entries)) {
        memory = (result as { entries: unknown[] }).entries
      }
    } catch { memory = null }
  }
  let roster: unknown[] | null = null
  if (typeof host?.roster?.list === 'function') {
    try {
      const result = await host.roster.list()
      if (typeof result === 'object' && result !== null && Array.isArray((result as { agents?: unknown }).agents)) {
        roster = (result as { agents: unknown[] }).agents
      }
    } catch { roster = null }
  }
  return { tasks, memory, roster, revision }
}

export async function applyBoardCommand(host: PhoneHost | undefined, command: {
  id: string
  action: string
  baseRevision: number
  taskId?: string
  title?: string
  status?: string
}): Promise<{ ok: true; revision: number | null } | { ok: false; code: 'unsupported' | 'conflict' | 'unavailable' }> {
  const caps = boardCapabilities(host?.board)
  if (!caps.apply.includes(command.action as BoardKind) || typeof host?.board?.apply !== 'function') {
    return { ok: false, code: 'unsupported' }
  }
  try {
    const snap = asTasks(await host.board.apply(command.id, {
      kind: command.action,
      baseRevision: command.baseRevision,
      ...(command.taskId === undefined ? {} : { taskId: command.taskId }),
      ...(command.title === undefined ? {} : { input: { title: command.title } }),
      ...(command.status === undefined ? {} : { status: command.status }),
    }))
    if (!snap) return { ok: false, code: 'unavailable' }
    if (caps.revision && snap.revision !== null && snap.revision === command.baseRevision) {
      return { ok: false, code: 'conflict' }
    }
    return { ok: true, revision: snap.revision }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && (error as { code?: unknown }).code
    if (code === 'conflict') return { ok: false, code: 'conflict' }
    return { ok: false, code: 'unavailable' }
  }
}

export function startPhoneRelay(input: {
  host: () => PhoneHost | undefined
  allowContent: boolean
  origin: string
  token: string
  deviceId: string
  ca?: Buffer
  intervalMs?: number
}): () => void {
  let stopped = false
  const postBoard = (body: unknown) => postNodeJsonRead({
    origin: input.origin,
    path: '/marshal/api/board',
    token: input.token,
    body,
    ...(input.ca === undefined ? {} : { ca: input.ca }),
  })
  const tick = async (): Promise<void> => {
    if (stopped) return
    const faces = await readPhoneFaces(input.host(), input.allowContent)
    const memory = input.allowContent ? faces.memory : null
    const first = await postBoard({
      ...forwardBody({ tasks: faces.tasks, memory, roster: faces.roster }),
      deviceId: input.deviceId,
    })
    const commands = Array.isArray((first.body as { commands?: unknown })?.commands)
      ? (first.body as { commands: Array<Record<string, unknown>> }).commands
      : []
    const applied: string[] = []
    const rejected: Array<{ id: string; code: string }> = []
    for (const command of commands) {
      if (typeof command.id !== 'string' || typeof command.action !== 'string' || typeof command.baseRevision !== 'number') continue
      const result = await applyBoardCommand(input.host(), {
        id: command.id,
        action: command.action,
        baseRevision: command.baseRevision,
        ...(typeof command.taskId === 'string' ? { taskId: command.taskId } : {}),
        ...(typeof command.title === 'string' ? { title: command.title } : {}),
        ...(typeof command.status === 'string' ? { status: command.status } : {}),
      })
      if (result.ok) applied.push(command.id)
      else rejected.push({ id: command.id, code: result.code })
    }
    if (applied.length === 0 && rejected.length === 0) return
    const after = await readPhoneFaces(input.host(), input.allowContent)
    await postBoard({
      ...forwardBody({ tasks: after.tasks, memory: input.allowContent ? after.memory : null, roster: after.roster }),
      deviceId: input.deviceId,
      applied,
      rejected,
    })
  }
  const timer = setInterval(() => { void tick() }, input.intervalMs ?? 15_000)
  timer.unref?.()
  void tick()
  return () => { stopped = true; clearInterval(timer) }
}

export function mountDesktopPairing(webServer: { register(route: { kind: 'exact'; path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void> }): () => void }, input: {
  hubUrl: string
  token: string
  ca?: Buffer
}): () => void {
  return webServer.register({
    kind: 'exact',
    path: '/marshal/desktop-pairing',
    handler: async (req, res) => {
      const remote = req.socket.remoteAddress ?? ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!loopback) { res.writeHead(403).end('forbidden'); return }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      let replace: string | undefined
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { replace?: unknown }
        if (typeof body.replace === 'string' && body.replace !== '') replace = body.replace
      } catch { /* 空正文当成第一次领取 */ }
      const outcome = await postNodeJsonRead({
        origin: hubHttpOrigin(input.hubUrl),
        path: '/marshal/api/pairing',
        token: input.token,
        body: replace === undefined ? {} : { replace },
        ...(input.ca === undefined ? {} : { ca: input.ca }),
      })
      res.writeHead(outcome.status || 502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(outcome.body))
    },
  })
}

function postNodeJsonRead(input: {
  origin: string
  path: string
  token: string
  body: unknown
  ca?: Buffer
}): Promise<{ status: number; body: unknown }> {
  const url = new URL(input.path, input.origin)
  const payload = Buffer.from(JSON.stringify(input.body))
  const lib = url.protocol === 'https:' ? https : http
  return new Promise((resolve) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        authorization: 'Bearer mnd1.' + input.token,
      },
      ...(input.ca && url.protocol === 'https:' ? { ca: input.ca } : {}),
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk as Buffer))
      res.on('end', () => {
        let body: unknown = {}
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = {} }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('error', () => resolve({ status: 0, body: { ok: false, code: 'network' } }))
    req.end(payload)
  })
}
