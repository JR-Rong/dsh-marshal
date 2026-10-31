import { createHmac, randomBytes } from 'node:crypto'
import { chmodSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { CommandFrame, CommandOp } from '../wire/frames.ts'
import { COMMAND_OPS } from '../wire/frames.ts'
import { commandPayloadDigest } from '../wire/commands.ts'
import { commandDomainKey, type CommandDomain } from '../wire/idempotency.ts'
import {
  FileLockError, acquireFileLock, atomicWriteFile, ensurePrivateDir, type LockHandle,
} from '../hub/state-file.ts'

export const JOURNAL_VERSION = 1 as const
export const DEFAULT_JOURNAL_CAPACITY = 10_000
/** 终态至少保留 24h；只有容量不足时才允许提前回收更老的终态。 */
export const DEFAULT_JOURNAL_RETENTION_MS = 24 * 60 * 60 * 1000

const DEFAULT_JOURNAL_FILE = join(homedir(), '.dsh-marshal', 'journal.json')

export type JournalStatus =
  | 'admitted'
  | 'accepted'
  | 'confirmed'
  | 'rejected'
  | 'pending-confirmation'
  | 'outcome-unknown'

/** admitted 只能由 admit 写入；settle 不接受它。 */
export type SettledStatus = Exclude<JournalStatus, 'admitted'>

const STATUSES: ReadonlySet<string> = new Set([
  'admitted', 'accepted', 'confirmed', 'rejected', 'pending-confirmation', 'outcome-unknown',
])

/** 未决记录永不驱逐：容量满时宁拒绝新写，也不能丢掉恢复依据。 */
const UNRESOLVED: ReadonlySet<JournalStatus> = new Set([
  'admitted', 'pending-confirmation', 'outcome-unknown',
])

const DOMAIN_KEY = /^[0-9a-f]{64}$/
const HEX_DIGEST = /^[0-9a-f]{64}$/

export interface JournalEntry {
  readonly domainKey: string
  readonly op: CommandOp
  readonly deviceId: string
  readonly agent: string
  readonly sessionId: string | null
  readonly status: JournalStatus
  readonly code?: string
  /** HMAC-SHA256(本地密钥, 规范化载荷)；不含正文。 */
  readonly payloadDigest: string
  readonly admittedAt: number
  readonly updatedAt: number
}

export interface JournalDomain extends CommandDomain {}

export interface AdmitInput {
  readonly domain: JournalDomain
  readonly op: CommandOp
  readonly args?: unknown
}

export interface JournalOptions {
  readonly file?: string
  readonly keyFile?: string
  readonly capacity?: number
  readonly retentionMs?: number
  readonly now?: () => number
}

export type JournalErrorCode =
  | 'recovery-required'
  | 'size-limit'
  | 'lock-held'
  | 'record-unavailable'
  | 'journal-closed'

/** 分类错误：调用方只按 code 处理，不解析消息文本。 */
export class JournalError extends Error {
  override readonly name = 'JournalError'
  readonly code: JournalErrorCode

  constructor(code: JournalErrorCode, detail?: string) {
    super(`marshal: ${code}: ${detail ?? code}`)
    this.code = code
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readText(path: string, label: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new JournalError('recovery-required', `${label} is unreadable`)
  }
}

function parseEntry(key: string, value: unknown): JournalEntry {
  if (!isObject(value)
    || value.domainKey !== key
    || !DOMAIN_KEY.test(key)
    || typeof value.op !== 'string'
    || !(COMMAND_OPS as readonly string[]).includes(value.op)
    || typeof value.deviceId !== 'string' || value.deviceId === ''
    || typeof value.agent !== 'string' || value.agent === ''
    || (value.sessionId !== null && (typeof value.sessionId !== 'string' || value.sessionId === ''))
    || typeof value.status !== 'string' || !STATUSES.has(value.status)
    || (value.code !== undefined && typeof value.code !== 'string')
    || typeof value.payloadDigest !== 'string' || !HEX_DIGEST.test(value.payloadDigest)
    || typeof value.admittedAt !== 'number' || !Number.isInteger(value.admittedAt) || value.admittedAt < 0
    || typeof value.updatedAt !== 'number' || !Number.isInteger(value.updatedAt) || value.updatedAt < 0) {
    throw new JournalError('recovery-required', 'journal.json is corrupt; restore it from a trusted backup')
  }
  return {
    domainKey: key,
    op: value.op as CommandOp,
    deviceId: value.deviceId,
    agent: value.agent,
    sessionId: value.sessionId as string | null,
    status: value.status as JournalStatus,
    ...(value.code === undefined ? {} : { code: value.code }),
    payloadDigest: value.payloadDigest,
    admittedAt: value.admittedAt,
    updatedAt: value.updatedAt,
  }
}

function parseJournal(text: string): Map<string, JournalEntry> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new JournalError('recovery-required', 'journal.json is not valid JSON; restore it from a trusted backup')
  }
  if (!isObject(json) || json.version !== JOURNAL_VERSION || !isObject(json.entries)) {
    throw new JournalError('recovery-required', 'journal.json has an unsupported shape')
  }
  const entries = new Map<string, JournalEntry>()
  for (const [key, value] of Object.entries(json.entries)) {
    entries.set(key, parseEntry(key, value))
  }
  return entries
}

function serialize(entries: ReadonlyMap<string, JournalEntry>): string {
  return `${JSON.stringify({
    version: JOURNAL_VERSION,
    entries: Object.fromEntries(entries),
  })}\n`
}

function parseKey(text: string): Buffer {
  const trimmed = text.trim()
  // 只接受 base64url 字符；错误长度/乱码都视为密钥损坏，不能自动换新密钥。
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new JournalError('recovery-required', 'journal.key is corrupt; restore it from a trusted backup')
  }
  const key = Buffer.from(trimmed, 'base64url')
  if (key.length < 32) {
    throw new JournalError('recovery-required', 'journal.key is too short; restore it from a trusted backup')
  }
  return key
}

function defaultJournalPath(): string {
  return process.env.MARSHAL_JOURNAL_FILE ?? DEFAULT_JOURNAL_FILE
}

/**
 * 打开（必要时首次创建）journal 并长期持有进程间排他锁。
 *
 * 初始化完整性：
 * - 两个文件都不存在 → 首次运行，创建密钥与空 journal；
 * - 只有其中一个存在 → recovery-required，不自动补建；
 * - 解析/密钥校验失败 → recovery-required；
 * - 启动时 admitted → outcome-unknown 并立即落盘；pending-confirmation 保持不变。
 */
export function openJournal(options: JournalOptions = {}): Journal {
  const file = resolve(options.file ?? defaultJournalPath())
  // 默认密钥与 journal 同目录：默认路径下就是 $HOME/.dsh-marshal/journal.key，
  // 测试覆盖 journal 路径时也不会误用真实 HOME 里的密钥。
  const keyFile = resolve(options.keyFile ?? process.env.MARSHAL_JOURNAL_KEY_FILE ?? join(dirname(file), 'journal.key'))
  const capacity = options.capacity ?? DEFAULT_JOURNAL_CAPACITY
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new JournalError('recovery-required', 'journal capacity must be a positive integer')
  }
  ensurePrivateDir(dirname(file))
  ensurePrivateDir(dirname(keyFile))

  let lock: LockHandle
  try {
    lock = acquireFileLock(file, options.now)
  } catch (error) {
    if (error instanceof FileLockError) {
      throw new JournalError('lock-held', 'journal is already held by another running instance')
    }
    throw error
  }

  try {
    let journalText = readText(file, 'journal.json')
    let keyText = readText(keyFile, 'journal.key')

    if (journalText === undefined && keyText === undefined) {
      keyText = `${randomBytes(32).toString('base64url')}\n`
      journalText = serialize(new Map())
      atomicWriteFile(keyFile, keyText, 0o600)
      atomicWriteFile(file, journalText, 0o600)
    } else if (journalText === undefined || keyText === undefined) {
      // 不能自行补建缺失的一半：那会把已初始化的去重域重置为空。
      throw new JournalError('recovery-required', 'journal.json and journal.key must exist together')
    }

    chmodSync(file, 0o600)
    chmodSync(keyFile, 0o600)
    const key = parseKey(keyText ?? '')
    const entries = parseJournal(journalText ?? '')

    const now = options.now ?? Date.now
    const recoveredAt = now()
    const next = new Map(entries)
    let changed = false
    for (const [domainKey, entry] of next) {
      if (entry.status !== 'admitted') continue
      // 崩溃发生在 admitted 之后、调用/落结果之间：不推断副作用是否发生。
      next.set(domainKey, { ...entry, status: 'outcome-unknown', updatedAt: recoveredAt })
      changed = true
    }
    const journal = new Journal(
      file, key, next, capacity, options.retentionMs ?? DEFAULT_JOURNAL_RETENTION_MS, now, lock,
    )
    if (changed) journal.persist(next)
    return journal
  } catch (error) {
    lock.release()
    throw error
  }
}

export class Journal {
  private entries: Map<string, JournalEntry>
  private released = false

  constructor(
    readonly file: string,
    private readonly key: Buffer,
    entries: Map<string, JournalEntry>,
    private readonly capacity: number,
    private readonly retentionMs: number,
    private readonly now: () => number,
    private readonly lock: LockHandle,
  ) {
    this.entries = entries
  }

  get size(): number { return this.entries.size }

  /** 该域是否存在记录；只读，不写盘。 */
  lookup(domain: JournalDomain): JournalEntry | undefined {
    this.assertOpen()
    return this.entries.get(commandDomainKey(domain))
  }

  /**
   * 调用 agent 前持久化 admitted。只有本次写入成功返回后调用方才允许发起调用。
   * 载荷摘要用本地 HMAC；正文/参数只在摘要计算期间存在于内存。
   */
  admit(input: AdmitInput): JournalEntry {
    this.assertOpen()
    const key = commandDomainKey(input.domain)
    if (this.entries.has(key)) {
      throw new JournalError('record-unavailable', 'domain is already admitted')
    }
    const next = new Map(this.entries)
    if (next.size >= this.capacity) this.evictResolved(next)
    if (next.size >= this.capacity) {
      throw new JournalError('size-limit', 'journal is full of unresolved or recent entries')
    }
    const at = this.now()
    const entry: JournalEntry = {
      domainKey: key,
      op: input.op,
      deviceId: input.domain.target.deviceId,
      agent: input.domain.target.agent,
      sessionId: input.domain.target.sessionId,
      status: 'admitted',
      payloadDigest: this.digestPayload(input.op, input.domain.target, input.args),
      admittedAt: at,
      updatedAt: at,
    }
    next.set(key, entry)
    this.persist(next)
    return entry
  }

  settle(domain: JournalDomain, status: SettledStatus, code?: string): JournalEntry {
    this.assertOpen()
    const key = commandDomainKey(domain)
    const current = this.entries.get(key)
    if (current === undefined) throw new JournalError('record-unavailable', 'domain has no journal entry')
    const base = {
      domainKey: current.domainKey,
      op: current.op,
      deviceId: current.deviceId,
      agent: current.agent,
      sessionId: current.sessionId,
      status,
      payloadDigest: current.payloadDigest,
      admittedAt: current.admittedAt,
      updatedAt: this.now(),
    }
    const entry: JournalEntry = code === undefined ? base : { ...base, code }
    const next = new Map(this.entries)
    next.set(key, entry)
    this.persist(next)
    return entry
  }

  /** HMAC-SHA256(本地密钥, 规范化载荷摘要)；外部只看到摘要，看不到正文。 */
  digestPayload(op: CommandOp, target: CommandFrame['target'], args: unknown): string {
    this.assertOpen()
    return createHmac('sha256', this.key)
      .update(commandPayloadDigest(op, target, args), 'utf8')
      .digest('hex')
  }

  /** 释放进程间锁；之后该 journal 不再可用。幂等。 */
  close(): void {
    if (this.released) return
    this.released = true
    this.entries.clear()
    this.lock.release()
  }

  /** 只给 openJournal 的启动恢复写入；调用方已持有锁。 */
  persist(entries: Map<string, JournalEntry>): void {
    try {
      atomicWriteFile(this.file, serialize(entries), 0o600)
    } catch {
      // 不把底层路径/errno 透出到命令通道。
      throw new JournalError('recovery-required', 'journal write failed')
    }
    this.entries = entries
  }

  private evictResolved(next: Map<string, JournalEntry>): void {
    const cutoff = this.now() - this.retentionMs
    const candidates = [...next.values()]
      .filter(entry => !UNRESOLVED.has(entry.status) && entry.updatedAt <= cutoff)
      .sort((a, b) => a.updatedAt - b.updatedAt)
    for (const candidate of candidates) {
      if (next.size < this.capacity) break
      next.delete(candidate.domainKey)
    }
  }

  private assertOpen(): void {
    if (this.released) throw new JournalError('journal-closed', 'journal is closed')
  }
}
