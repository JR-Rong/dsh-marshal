import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { phoneTokenDigest, sha256Hex, type DeviceRecord, type DeviceStore } from './devices.ts'
import { qrSvg } from './qr.ts'

export const PAIRING_TTL_MS = 60_000
export const MAX_OPEN_CODES = 8
export const PHONE_PREFIX = 'mph1.'
export const NODE_PREFIX = 'mnd1.'
const UNSAFE_APPROVAL = /always|persist|remember|session|don'?t\s*ask|总是|始终|会话内/i

export interface TaskCard {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly status: 'todo' | 'doing' | 'done'
  readonly revision: number
  readonly deviceId: string
}

export interface TaskCommand {
  readonly id: string
  readonly deviceId: string
  readonly action: 'create' | 'edit' | 'move' | 'delete'
  readonly baseRevision: number
  readonly title?: string
  readonly detail?: string
  readonly status?: TaskCard['status']
  readonly taskId?: string
}

export interface MemoryEntry {
  readonly id: string
  readonly deviceId: string
  readonly layer: 'private' | 'workspace'
  readonly agent: string
  readonly text: string
}

export interface RosterAgent {
  readonly deviceId: string
  readonly agent: string
  readonly name: string
}

export type PhoneAuth =
  | { readonly ok: true; readonly phone: DeviceRecord }
  | { readonly ok: false; readonly code: 'unauthorized' | 'revoked' | 'cross-account' }

export type NodeAuth =
  | { readonly ok: true; readonly device: DeviceRecord }
  | { readonly ok: false; readonly code: 'unauthorized' | 'revoked' }

export function parseBearer(header: string | undefined): { kind: 'phone' | 'node'; token: string } | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!match?.[1]) return undefined
  const value = match[1]
  if (value.startsWith(PHONE_PREFIX)) return { kind: 'phone', token: value.slice(PHONE_PREFIX.length) }
  if (value.startsWith(NODE_PREFIX)) return { kind: 'node', token: value.slice(NODE_PREFIX.length) }
  return undefined
}

export interface PendingDecisionCard {
  readonly approval: boolean
  readonly allowedIds: ReadonlySet<string>
}

/** 允许「这一次」的 accept，以及 decline / cancel。拒绝总是、记住、会话内这类放宽。 */
export function onceDecisionIds(card: unknown): PendingDecisionCard | null {
  if (typeof card !== 'object' || card === null) return null
  const record = card as Record<string, unknown>
  const approval = typeof record.approval === 'object' && record.approval !== null
    ? record.approval as Record<string, unknown>
    : undefined
  if (!approval) return { approval: false, allowedIds: new Set() }
  const allowedIds = new Set<string>()
  if (Array.isArray(approval.decisions)) {
    for (const raw of approval.decisions) {
      if (typeof raw !== 'object' || raw === null) continue
      const decision = raw as { id?: unknown; label?: unknown }
      const id = typeof decision.id === 'string' ? decision.id : ''
      const label = typeof decision.label === 'string' ? decision.label : ''
      if (!id || UNSAFE_APPROVAL.test(id) || UNSAFE_APPROVAL.test(label)) continue
      allowedIds.add(id)
    }
  }
  return { approval: true, allowedIds }
}

/** 审批必须对上 Hub 已经见过的卡片，并且只能选卡片上的非持久决定。提问不受这道限制。 */
export function phoneAnswerAllowed(args: unknown, card: PendingDecisionCard | undefined): boolean {
  if (!card) return false
  if (!card.approval) return true
  if (card.allowedIds.size === 0) return false
  if (typeof args !== 'object' || args === null || !Array.isArray((args as { answers?: unknown }).answers)) return false
  return (args as { answers: unknown[] }).answers.every((answer) => {
    if (typeof answer !== 'object' || answer === null) return false
    const row = answer as { id?: unknown; selectedOptionIds?: unknown }
    const selected = Array.isArray(row.selectedOptionIds)
      ? row.selectedOptionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    const ids = selected.length > 0 ? selected : (typeof row.id === 'string' ? [row.id] : [])
    return ids.length > 0 && ids.every((id) => card.allowedIds.has(id))
  })
}

export function controllerCommandAllowed(op: string, args: unknown, card?: PendingDecisionCard): boolean {
  const allowed = new Set(['prompt', 'answer', 'interrupt', 'create', 'fork', 'observe', 'cancel'])
  if (!allowed.has(op)) return false
  if (op !== 'answer') return true
  return phoneAnswerAllowed(args, card)
}

function digest(value: string): string {
  return phoneTokenDigest(value)
}

function nodeDigest(value: string): string {
  return sha256Hex(value)
}

export function createPhoneHub(options: {
  now?: () => number
  ownerHash?: string
  store: DeviceStore
  findNode?: (digest: string) => DeviceRecord | undefined
}) {
  const now = options.now ?? Date.now
  const codes = new Map<string, { accountHash: string; expiresAt: number }>()
  const tasks = new Map<string, TaskCard[]>()
  const queued = new Map<string, TaskCommand[]>()
  const memory = new Map<string, MemoryEntry[]>()
  const roster = new Map<string, RosterAgent[]>()
  const streams = new Map<string, Set<() => void>>()
  const boardRevision = new Map<string, number>()
  const watched = new Map<string, Set<string>>()
  const MAX_WATCHED = 32
  const MAX_COMMANDS = 32
  const MAX_CARDS = 64
  const CARD_TTL_MS = 15 * 60_000
  const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/
  const cardFile = join(dirname(options.store.file), 'pending-cards.json')
  const pendingCards = new Map<string, { card: PendingDecisionCard; expiresAt: number }>()
  const loadCards = (): void => {
    let raw = ''
    try { raw = readFileSync(cardFile, 'utf8') } catch { return }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return }
    if (!Array.isArray(parsed)) return
    const at = now()
    for (const row of parsed) {
      if (typeof row !== 'object' || row === null) continue
      const item = row as { requestId?: unknown; approval?: unknown; allowedIds?: unknown; expiresAt?: unknown }
      if (typeof item.requestId !== 'string' || typeof item.expiresAt !== 'number' || item.expiresAt <= at) continue
      const allowedIds = new Set<string>()
      if (Array.isArray(item.allowedIds)) {
        for (const id of item.allowedIds) if (typeof id === 'string' && id) allowedIds.add(id)
      }
      pendingCards.set(item.requestId, {
        card: { approval: item.approval === true, allowedIds },
        expiresAt: item.expiresAt,
      })
    }
  }
  const saveCards = (): void => {
    const at = now()
    const rows = [...pendingCards.entries()]
      .filter(([, item]) => item.expiresAt > at)
      .slice(-MAX_CARDS)
      .map(([requestId, item]) => ({
        requestId,
        approval: item.card.approval,
        allowedIds: [...item.card.allowedIds],
        expiresAt: item.expiresAt,
      }))
    try { writeFileSync(cardFile, JSON.stringify(rows), { mode: 0o600 }) } catch { /* 卡片缓存写失败不影响应答 */ }
  }
  loadCards()

  const purgeCodes = (): void => {
    const at = now()
    for (const [code, item] of codes) if (item.expiresAt <= at) codes.delete(code)
    while (codes.size > MAX_OPEN_CODES) {
      const oldest = codes.keys().next().value
      if (oldest === undefined) break
      codes.delete(oldest)
    }
  }

  function authenticate(token: string): PhoneAuth {
    if (!token) return { ok: false, code: 'unauthorized' }
    const row = options.store.findByTokenDigest(digest(token))
    if (!row || row.role !== 'phone') return { ok: false, code: 'unauthorized' }
    if (row.revoked) return { ok: false, code: 'revoked' }
    if (options.ownerHash && row.accountHash && row.accountHash !== options.ownerHash) return { ok: false, code: 'cross-account' }
    return { ok: true, phone: row }
  }

  function authenticateNode(token: string): NodeAuth {
    if (!token) return { ok: false, code: 'unauthorized' }
    const row = options.findNode?.(nodeDigest(token))
    if (!row || row.role === 'phone') return { ok: false, code: 'unauthorized' }
    if (row.revoked) return { ok: false, code: 'revoked' }
    return { ok: true, device: row }
  }

  return {
    authenticate,
    authenticateNode,
    issuePairing(accountHash: string, hubOrigin: string, replace?: string) {
      purgeCodes()
      if (options.ownerHash && accountHash !== options.ownerHash) {
        throw Object.assign(new Error('cross-account'), { code: 'cross-account' })
      }
      // 刷新二维码时作废同一账号尚未使用的旧码，只留即将显示的这一张。
      if (replace) {
        const previous = codes.get(replace)
        if (previous?.accountHash === accountHash) {
          for (const [code, item] of codes) if (item.accountHash === accountHash) codes.delete(code)
        }
      }
      while (codes.size >= MAX_OPEN_CODES) {
        const oldest = codes.keys().next().value
        if (oldest === undefined) break
        codes.delete(oldest)
      }
      const code = randomBytes(16).toString('base64url')
      const expiresAt = now() + PAIRING_TTL_MS
      codes.set(code, { accountHash, expiresAt })
      const url = 'marshal://pair?code=' + encodeURIComponent(code) + '&hub=' + encodeURIComponent(hubOrigin)
      return { code, expiresAt, url, svg: qrSvg(url) }
    },
    redeem(code: string, name: string, installationId: string) {
      purgeCodes()
      const found = codes.get(code)
      codes.delete(code)
      if (!found || found.expiresAt <= now()) throw Object.assign(new Error('unknown'), { code: 'unknown' })
      if (options.ownerHash && found.accountHash !== options.ownerHash) {
        throw Object.assign(new Error('cross-account'), { code: 'cross-account' })
      }
      const created = options.store.enrollPhone({ name, accountHash: found.accountHash, installationId })
      const open = streams.get(created.record.id)
      streams.delete(created.record.id)
      open?.forEach((close) => close())
      return created
    },
    revoke(id: string) {
      options.store.revoke(id)
      const open = streams.get(id)
      streams.delete(id)
      open?.forEach((close) => close())
    },
    rememberCard(requestId: string, card: PendingDecisionCard) {
      const at = now()
      for (const [id, item] of pendingCards) if (item.expiresAt <= at) pendingCards.delete(id)
      while (pendingCards.size >= MAX_CARDS) {
        const oldest = pendingCards.keys().next().value
        if (oldest === undefined) break
        pendingCards.delete(oldest)
      }
      pendingCards.set(requestId, { card, expiresAt: at + CARD_TTL_MS })
      saveCards()
    },
    forgetCard(requestId: string) {
      if (!pendingCards.delete(requestId)) return
      saveCards()
    },
    cardFor(requestId: string) {
      const found = pendingCards.get(requestId)
      if (!found) return undefined
      if (found.expiresAt <= now()) {
        pendingCards.delete(requestId)
        saveCards()
        return undefined
      }
      return found.card
    },
    revisions() {
      return Object.fromEntries(boardRevision)
    },
    unwatch(auth: PhoneAuth, key: string) {
      if (!auth.ok) return
      watched.get(auth.phone.id)?.delete(key)
    },
    watch(auth: PhoneAuth, key: string) {
      if (!auth.ok || !key) return
      const set = watched.get(auth.phone.id) ?? new Set<string>()
      if (!set.has(key) && set.size >= MAX_WATCHED) return
      set.add(key)
      watched.set(auth.phone.id, set)
    },
    watchedBy(phoneId: string) {
      return watched.get(phoneId) ?? new Set<string>()
    },
    seen(phoneId: string) {
      options.store.touchPhone(phoneId, now())
    },
    attachStream(phoneId: string, close: () => void) {
      const set = streams.get(phoneId) ?? new Set<() => void>()
      set.add(close)
      streams.set(phoneId, set)
      options.store.touchPhone(phoneId, now())
      return () => { set.delete(close); if (set.size === 0) streams.delete(phoneId) }
    },
    listPhones() {
      const at = now()
      return options.store.phones().map((phone) => ({
        id: phone.id,
        name: phone.name,
        online: (streams.get(phone.id)?.size ?? 0) > 0
          || (typeof phone.lastSeen === 'number' && at - phone.lastSeen < 45_000),
      }))
    },
    tasksFor(deviceId?: string) {
      if (deviceId) return tasks.get(deviceId) ?? []
      return [...tasks.values()].flat()
    },
    commandsFor(deviceId: string) {
      return queued.get(deviceId) ?? []
    },
    writeTasks(auth: PhoneAuth | NodeAuth, body: Record<string, unknown>) {
      if (!auth.ok) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' })
      if ('device' in auth) {
        if (body.read !== true) return { tasks: tasks.get(auth.device.id) ?? [], conflict: false }
        if (typeof body.revision === 'number' && Number.isInteger(body.revision) && body.revision >= 0) {
          boardRevision.set(auth.device.id, body.revision)
        }
        const next = normalizeTasks(body.tasks, auth.device.id, boardRevision.get(auth.device.id))
        tasks.set(auth.device.id, next)
        const drop = new Set<string>()
        if (Array.isArray(body.applied)) {
          for (const id of body.applied) if (typeof id === 'string') drop.add(id)
        }
        if (Array.isArray(body.rejected)) {
          for (const item of body.rejected) {
            if (typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string') {
              drop.add((item as { id: string }).id)
            }
          }
        }
        if (drop.size > 0) {
          queued.set(auth.device.id, (queued.get(auth.device.id) ?? []).filter((command) => !drop.has(command.id)))
        }
        return { tasks: next, conflict: false }
      }
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
      if (!DEVICE_ID.test(deviceId)) throw Object.assign(new Error('invalid'), { code: 'invalid' })
      const current = tasks.get(deviceId) ?? []
      const head = boardRevision.get(deviceId)
      if (head === undefined) return { tasks: current, conflict: true }
      const base = typeof body.baseRevision === 'number' ? body.baseRevision : head
      if (base !== head) return { tasks: current, conflict: true }
      const action = body.action
      if (action !== 'create' && action !== 'edit' && action !== 'move' && action !== 'delete') {
        throw Object.assign(new Error('unsupported'), { code: 'unsupported' })
      }
      const command: TaskCommand = {
        id: randomBytes(16).toString('hex'),
        deviceId,
        action,
        baseRevision: base,
        ...(typeof body.title === 'string' ? { title: body.title.slice(0, 120) } : {}),
        ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
        ...(body.status === 'todo' || body.status === 'doing' || body.status === 'done' ? { status: body.status } : {}),
      }
      const queue = queued.get(deviceId) ?? []
      if (queue.length >= MAX_COMMANDS) throw Object.assign(new Error('size-limit'), { code: 'size-limit' })
      queued.set(deviceId, [...queue, command])
      return { tasks: current, conflict: false }
    },
    readMemory(deviceId?: string) {
      return deviceId ? (memory.get(deviceId) ?? []) : [...memory.values()].flat()
    },
    writeMemory(auth: NodeAuth, entries: unknown) {
      if (!auth.ok) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' })
      const next = normalizeMemory(entries, auth.device.id)
      memory.set(auth.device.id, next)
      return next
    },
    readRoster(deviceId?: string) {
      return deviceId ? (roster.get(deviceId) ?? []) : [...roster.values()].flat()
    },
    writeRoster(auth: NodeAuth, agents: unknown) {
      if (!auth.ok) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' })
      const next = normalizeRoster(agents, auth.device.id)
      roster.set(auth.device.id, next)
      return next
    },
    registerPush(auth: PhoneAuth, target: { provider: 'apns' | 'fcm' | 'huawei'; token: string; liveToken?: string }) {
      if (!auth.ok || !target.token) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' })
      options.store.setPhonePush(auth.phone.id, target)
    },
  }
}

function normalizeTasks(raw: unknown, deviceId: string, boardRevision: number | undefined): TaskCard[] {
  if (!Array.isArray(raw)) return []
  const cards: TaskCard[] = []
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.title !== 'string' || !item.title.trim()) continue
    cards.push({
      id: item.id.slice(0, 80),
      deviceId,
      title: item.title.trim().slice(0, 120),
      detail: (typeof item.detail === 'string' ? item.detail : typeof item.description === 'string' ? item.description : '').slice(0, 2000),
      status: item.status === 'doing' || item.status === 'done' ? item.status : 'todo',
      revision: typeof boardRevision === 'number'
        ? boardRevision
        : (typeof item.revision === 'number' ? item.revision : 0),
    })
  }
  return cards
}

function normalizeMemory(raw: unknown, deviceId: string): MemoryEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: MemoryEntry[] = []
  let used = 0
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    if (typeof item.text !== 'string' || !item.text) continue
    const text = item.text.slice(0, 2000)
    used += text.length
    if (used > 24_000) break
    entries.push({
      id: typeof item.id === 'string' ? item.id.slice(0, 80) : 'mem-' + String(entries.length),
      deviceId,
      layer: item.layer === 'workspace' ? 'workspace' : 'private',
      agent: typeof item.agent === 'string' ? item.agent.slice(0, 80) : '',
      text,
    })
  }
  return entries
}

function normalizeRoster(raw: unknown, deviceId: string): RosterAgent[] {
  if (!Array.isArray(raw)) return []
  const agents: RosterAgent[] = []
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    if (typeof item.name !== 'string' || !item.name.trim()) continue
    agents.push({
      deviceId,
      agent: typeof item.agent === 'string' ? item.agent.slice(0, 80) : 'dsh',
      name: item.name.trim().slice(0, 80),
    })
  }
  return agents
}

/** 到期前 5 秒更换，和桌面「手机连接」弹层用的是同一个提前量。 */
export function pairingRefreshDelay(expiresAt: number, at: number): number {
  return Math.max(1_000, expiresAt - at - 5_000)
}

export function pairingPage(url: string, code: string, expiresAt: number, csrfCookie: string): string {
  const payload = JSON.stringify({ code, expiresAt, url }).replace(/</g, '\\u003c')
  return `<!doctype html><meta charset="utf-8"><title>手机配对</title>
<body style="font-family:sans-serif;background:#151719;color:#edf0f3">
<main><h1>手机配对</h1>
<p>二维码只有 Hub 地址和 60 秒一次性配对码。到期前 5 秒自动更换，旧码立即作废。</p>
<div id="qr">${qrSvg(url)}</div>
<p id="status"></p></main>
<script>
const csrfName = ${JSON.stringify(csrfCookie)};
let current = ${payload};
const status = document.getElementById('status');
const qr = document.getElementById('qr');
function csrf() {
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const item = part.trim();
    if (item.startsWith(csrfName + '=')) return decodeURIComponent(item.slice(csrfName.length + 1));
  }
  return '';
}
function paint() {
  const left = Math.max(0, Math.round((current.expiresAt - Date.now()) / 1000));
  status.textContent = left > 0 ? '剩余 ' + left + ' 秒，到期前 5 秒自动更换' : '正在更换配对码…';
}
async function rotate() {
  const response = await fetch('/marshal/api/pairing', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-marshal-csrf': csrf() },
    body: JSON.stringify({ replace: current.code }),
  });
  if (!response.ok) { status.textContent = '更换失败，请重新打开这个页面'; return; }
  const next = await response.json();
  if (!next || typeof next.url !== 'string' || typeof next.code !== 'string' || typeof next.expiresAt !== 'number') return;
  current = next;
  qr.innerHTML = typeof next.svg === 'string' ? next.svg : '';
  arm();
}
function arm() {
  paint();
  const delay = Math.max(1000, current.expiresAt - Date.now() - 5000);
  setTimeout(() => { rotate().catch(() => { status.textContent = '更换失败，请重新打开这个页面'; }); }, delay);
}
setInterval(paint, 1000);
arm();
</script></body>`
}
