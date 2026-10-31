import {
  appendFileSync, chmodSync, mkdirSync, renameSync, statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 审计只允许这些字段；提示词、命令、路径、答案和原始异常都进不来。 */
export interface AuditFields {
  readonly ts?: number
  readonly operatorId?: string
  readonly deviceId?: string
  readonly agent?: string
  readonly sessionId?: string
  readonly op?: string
  readonly requestId?: string
  readonly decision?: string
  readonly status?: string
  readonly errorClass?: string
}

export interface AuditSink {
  readonly file: string
  write(fields: AuditFields): void
}

export interface AuditLogOptions {
  /** 默认 `MARSHAL_AUDIT_FILE` 或 `$HOME/.dsh-marshal/audit.jsonl`。 */
  readonly file?: string
  readonly now?: () => number
  /** 单文件上限，默认 5 MiB；超限后单次轮转为 `.1`。 */
  readonly maxBytes?: number
  /** 写失败时的分类告警；不传则静默。绝不外抛。 */
  readonly warn?: (message: string) => void
}

export const AUDIT_MAX_BYTES = 5 * 1024 * 1024
export const AUDIT_FIELDS = [
  'ts', 'operatorId', 'deviceId', 'agent', 'sessionId',
  'op', 'requestId', 'decision', 'status', 'errorClass',
] as const

/** 单字段上限：审计是索引不是正文，异常长值只截断不落盘。 */
const MAX_FIELD_CHARS = 160

export function defaultAuditFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MARSHAL_AUDIT_FILE
  if (override !== undefined && override.trim() !== '') return override.trim()
  return join(homedir(), '.dsh-marshal', 'audit.jsonl')
}

function scalar(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value === '') return undefined
  return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value
}

/** 白名单再次收口：调用方即使误传 prompt/answers 也不会写入文件。 */
function sanitize(fields: AuditFields, now: () => number): string {
  const record: Record<string, string | number> = { ts: fields.ts ?? now() }
  for (const key of AUDIT_FIELDS) {
    if (key === 'ts') continue
    const value = scalar(fields[key])
    if (value !== undefined) record[key] = value
  }
  return JSON.stringify(record)
}

/**
 * 追加式 JSONL 审计。写失败只告警（分类为 audit-write-failed），
 * 不能让节点因为磁盘/权限问题崩溃；审计与幂等 journal 完全独立。
 */
export function createAuditLog(options: AuditLogOptions = {}): AuditSink {
  const file = options.file ?? defaultAuditFile()
  const now = options.now ?? Date.now
  const maxBytes = options.maxBytes ?? AUDIT_MAX_BYTES
  let warned = false

  const warn = (message: string): void => {
    if (warned) return
    warned = true
    try { options.warn?.(message) } catch { /* 告警自身失败不再外抛 */ }
  }

  const rotateIfNeeded = (incoming: number): void => {
    let size: number
    try { size = statSync(file).size } catch { return }
    if (size === 0 || size + incoming <= maxBytes) return
    try {
      // 单次轮转：POSIX rename 覆盖旧 `.1`，不保留更早的审计文件。
      renameSync(file, `${file}.1`)
    } catch {
      warn('marshal: audit-write-failed: rotation failed')
    }
  }

  return {
    file,
    write(fields: AuditFields): void {
      let line: string
      try { line = sanitize(fields, now) } catch { return }
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
        rotateIfNeeded(Buffer.byteLength(line, 'utf8') + 1)
        appendFileSync(file, `${line}\n`, { mode: 0o600 })
        // 文件可能由旧版本/其他进程以更宽权限创建，追加后统一收紧。
        try { chmodSync(file, 0o600) } catch { /* 权限收紧失败不影响已写入记录 */ }
      } catch {
        warn('marshal: audit-write-failed: cannot append')
      }
    },
  }
}
