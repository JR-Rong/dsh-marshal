/**
 * Codex app-server 协议最小子集，pin 到 `rust-v0.166.0` 的生成 schema
 * （`codex_app_server_protocol.v2.schemas.json`）。这里只声明适配器实际使用
 * 的字段；字段缺失/类型不符一律按协议错误处理，不做“尽量兼容”。
 *
 * 0.166.0 没有 `protocolVersion`：版本只按 `initialize.userAgent` 旁证。
 */

export const CODEX_SUPPORTED_VERSION = '0.166.0'
export const CODEX_SCHEMA_REVISION = 'rust-v0.166.0@6ff1e1ca3b30fc8b914720681fcf5fe62e95f856'

export const CODEX_CLIENT_INFO = { name: 'dsh-marshal', version: '0.0.0' } as const

export const CODEX_JSONRPC_METHOD_NOT_FOUND = -32601
export const CODEX_JSONRPC_INTERNAL_ERROR = -32603

/**
 * 目标版本已知的 server notification。未列入集合的方法由 peer 做有界计数；
 * 列入但未映射的方法（settings/goal/diff 等）属于“已知但本版本不投影”。
 */
export const CODEX_KNOWN_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'error',
  'thread/started',
  'thread/status/changed',
  'thread/readState/changed',
  'thread/archived',
  'thread/deleted',
  'thread/unarchived',
  'thread/closed',
  'thread/reverted',
  'thread/name/updated',
  'thread/attachment/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/queue/changed',
  'thread/settings/updated',
  'thread/tokenUsage/updated',
  'thread/compacted',
  'turn/started',
  'turn/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'turn/moderationMetadata',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'serverRequest/resolved',
  'skills/changed',
  'account/updated',
  'account/rateLimits/updated',
  'mcpServer/startupStatus/updated',
  'model/rerouted',
  'warning',
  'guardianWarning',
  'deprecationNotice',
  'configWarning',
])

export interface CodexInitializeResponse {
  readonly userAgent: string
  readonly codexHome?: string
  readonly platformFamily?: string
  readonly platformOs?: string
}

export interface CodexThreadStatusActive {
  readonly type: 'active'
  readonly activeFlags: readonly string[]
}

export interface CodexThreadStatusInactive {
  readonly type: 'idle' | 'notLoaded' | 'systemError'
}

export type CodexThreadStatus = CodexThreadStatusActive | CodexThreadStatusInactive

export interface CodexTurn {
  readonly id: string
  readonly status: string
  readonly items?: readonly CodexThreadItem[]
  readonly startedAt?: number
  readonly completedAt?: number
}

export interface CodexThreadItem {
  readonly id: string
  readonly type: string
  readonly [field: string]: unknown
}

export interface CodexThread {
  readonly id: string
  readonly status?: CodexThreadStatus
  readonly updatedAt?: number
  readonly createdAt?: number
  readonly preview?: string
  readonly turns?: readonly CodexTurn[]
  readonly forkedFromId?: string | null
}

export interface CodexThreadListResponse {
  readonly data: readonly CodexThread[]
  readonly nextCursor?: string
}

export interface CodexTurnsListResponse {
  readonly data: readonly CodexTurn[]
  readonly nextCursor?: string
}

export interface CodexTurnStartResponse {
  readonly turn: CodexTurn
}

export interface CodexThreadRefResponse {
  readonly thread: CodexThread
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 只接受 string|null；其它形状视为协议错误，不猜“缺失”。 */
function optionalCursor(value: unknown): { readonly cursor?: string } | undefined {
  if (value === null || value === undefined) return {}
  if (typeof value === 'string' && value !== '') return { cursor: value }
  return undefined
}

export function parseThreadStatus(value: unknown): CodexThreadStatus | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (record.type === 'active') {
    if (!Array.isArray(record.activeFlags)) return undefined
    if (!record.activeFlags.every(flag => typeof flag === 'string')) return undefined
    return { type: 'active', activeFlags: [...record.activeFlags] }
  }
  if (record.type === 'idle' || record.type === 'notLoaded' || record.type === 'systemError') {
    return { type: record.type }
  }
  return undefined
}

export function parseThread(value: unknown): CodexThread | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const id = nonEmptyString(record.id)
  if (id === undefined) return undefined
  const status = record.status === undefined ? undefined : parseThreadStatus(record.status)
  if (record.status !== undefined && status === undefined) return undefined
  const updatedAt = record.updatedAt === undefined ? undefined : finiteNumber(record.updatedAt)
  const createdAt = record.createdAt === undefined ? undefined : finiteNumber(record.createdAt)
  if (record.updatedAt !== undefined && updatedAt === undefined) return undefined
  if (record.createdAt !== undefined && createdAt === undefined) return undefined
  const turns = record.turns === undefined ? undefined : parseTurns(record.turns)
  if (record.turns !== undefined && turns === undefined) return undefined
  const forkedFromId = record.forkedFromId === undefined
    ? undefined
    : record.forkedFromId === null ? null : nonEmptyString(record.forkedFromId)
  if (record.forkedFromId !== undefined && forkedFromId === undefined) return undefined
  return {
    id,
    ...(status === undefined ? {} : { status }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(typeof record.preview === 'string' ? { preview: record.preview } : {}),
    ...(turns === undefined ? {} : { turns }),
    ...(forkedFromId === undefined ? {} : { forkedFromId }),
  }
}

export function parseThreadItem(value: unknown): CodexThreadItem | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const id = nonEmptyString(record.id)
  const type = nonEmptyString(record.type)
  if (id === undefined || type === undefined) return undefined
  return { ...record, id, type }
}

export function parseTurn(value: unknown): CodexTurn | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const id = nonEmptyString(record.id)
  const status = nonEmptyString(record.status)
  if (id === undefined || status === undefined) return undefined
  const items = record.items === undefined ? undefined : parseItems(record.items)
  if (record.items !== undefined && items === undefined) return undefined
  const startedAt = record.startedAt === undefined ? undefined : finiteNumber(record.startedAt)
  const completedAt = record.completedAt === undefined ? undefined : finiteNumber(record.completedAt)
  if (record.startedAt !== undefined && startedAt === undefined) return undefined
  if (record.completedAt !== undefined && completedAt === undefined) return undefined
  return {
    id,
    status,
    ...(items === undefined ? {} : { items }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  }
}

function parseItems(value: unknown): readonly CodexThreadItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: CodexThreadItem[] = []
  for (const entry of value) {
    const item = parseThreadItem(entry)
    if (item === undefined) return undefined
    items.push(item)
  }
  return items
}

function parseTurns(value: unknown): readonly CodexTurn[] | undefined {
  if (!Array.isArray(value)) return undefined
  const turns: CodexTurn[] = []
  for (const entry of value) {
    const turn = parseTurn(entry)
    if (turn === undefined) return undefined
    turns.push(turn)
  }
  return turns
}

export function parseInitializeResponse(value: unknown): CodexInitializeResponse | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const userAgent = nonEmptyString(record.userAgent)
  if (userAgent === undefined) return undefined
  return {
    userAgent,
    ...(optionalString(record.codexHome) === undefined ? {} : { codexHome: record.codexHome as string }),
    ...(optionalString(record.platformFamily) === undefined ? {} : { platformFamily: record.platformFamily as string }),
    ...(optionalString(record.platformOs) === undefined ? {} : { platformOs: record.platformOs as string }),
  }
}

export function parseThreadListResponse(value: unknown): CodexThreadListResponse | undefined {
  const record = asRecord(value)
  if (record === undefined || !Array.isArray(record.data)) return undefined
  const cursor = optionalCursor(record.nextCursor)
  if (cursor === undefined) return undefined
  const threads: CodexThread[] = []
  for (const entry of record.data) {
    const thread = parseThread(entry)
    if (thread === undefined) return undefined
    threads.push(thread)
  }
  return { data: threads, ...(cursor.cursor === undefined ? {} : { nextCursor: cursor.cursor }) }
}

export function parseTurnsListResponse(value: unknown): CodexTurnsListResponse | undefined {
  const record = asRecord(value)
  if (record === undefined || !Array.isArray(record.data)) return undefined
  const cursor = optionalCursor(record.nextCursor)
  if (cursor === undefined) return undefined
  const turns = parseTurns(record.data)
  if (turns === undefined) return undefined
  return { data: turns, ...(cursor.cursor === undefined ? {} : { nextCursor: cursor.cursor }) }
}

export function parseTurnStartResponse(value: unknown): CodexTurnStartResponse | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const turn = parseTurn(record.turn)
  return turn === undefined ? undefined : { turn }
}

export function parseThreadRefResponse(value: unknown): CodexThreadRefResponse | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const thread = parseThread(record.thread)
  return thread === undefined ? undefined : { thread }
}

/** `userAgent` 形如 `dsh-marshal/0.0.0 (linux; x86_64) codex/0.166.0`；只认第一个语义版本号。 */
export function parseVersionFromUserAgent(userAgent: string): string | undefined {
  const match = /\b(\d+\.\d+\.\d+)\b/.exec(userAgent)
  return match?.[1]
}

export function supportsVersion(version: string | undefined): version is string {
  return version === CODEX_SUPPORTED_VERSION
}

export function threadRunning(thread: CodexThread): boolean {
  return thread.status?.type === 'active'
}

/** Thread 的时间戳是秒；对外统一毫秒，异常值不猜。 */
export function threadUpdatedAtMs(thread: CodexThread): number | undefined {
  const value = thread.updatedAt
  if (value === undefined || value < 0) return undefined
  return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value)
}

/** 没有 preview 也没有回合才算空白；标题/正文不参与判定之外的输出。 */
export function threadBlank(thread: CodexThread): boolean {
  const preview = typeof thread.preview === 'string' ? thread.preview.trim() : ''
  if (preview !== '') return false
  return thread.turns === undefined || thread.turns.length === 0
}

export function threadWaitKind(thread: CodexThread): 'approval' | 'question' | undefined {
  const status = thread.status
  if (status?.type !== 'active') return undefined
  if (status.activeFlags.includes('waitingOnApproval')) return 'approval'
  if (status.activeFlags.includes('waitingOnUserInput')) return 'question'
  return undefined
}
