import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync, } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
export const AUDIT_FIELDS = [
    'ts', 'operatorId', 'deviceId', 'agent', 'sessionId',
    'op', 'requestId', 'decision', 'status', 'errorClass',
];
/** 单字段上限：审计是索引不是正文，异常长值只截断不落盘。 */
const MAX_FIELD_CHARS = 160;
export function defaultAuditFile(env = process.env) {
    const override = env.MARSHAL_AUDIT_FILE;
    if (override !== undefined && override.trim() !== '')
        return override.trim();
    return join(homedir(), '.dsh-marshal', 'audit.jsonl');
}
function scalar(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value !== 'string' || value === '')
        return undefined;
    return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}
/** 白名单再次收口：调用方即使误传 prompt/answers 也不会写入文件。 */
function sanitize(fields, now) {
    const record = { ts: fields.ts ?? now() };
    for (const key of AUDIT_FIELDS) {
        if (key === 'ts')
            continue;
        const value = scalar(fields[key]);
        if (value !== undefined)
            record[key] = value;
    }
    return JSON.stringify(record);
}
/**
 * 追加式 JSONL 审计。写失败只告警（分类为 audit-write-failed），
 * 不能让节点因为磁盘/权限问题崩溃；审计与幂等 journal 完全独立。
 */
export function createAuditLog(options = {}) {
    const file = options.file ?? defaultAuditFile();
    const now = options.now ?? Date.now;
    const maxBytes = options.maxBytes ?? AUDIT_MAX_BYTES;
    let warned = false;
    const warn = (message) => {
        if (warned)
            return;
        warned = true;
        try {
            options.warn?.(message);
        }
        catch { /* 告警自身失败不再外抛 */ }
    };
    const rotateIfNeeded = (incoming) => {
        let size;
        try {
            size = statSync(file).size;
        }
        catch {
            return;
        }
        if (size === 0 || size + incoming <= maxBytes)
            return;
        try {
            // 单次轮转：POSIX rename 覆盖旧 `.1`，不保留更早的审计文件。
            renameSync(file, `${file}.1`);
        }
        catch {
            warn('marshal: audit-write-failed: rotation failed');
        }
    };
    return {
        file,
        write(fields) {
            let line;
            try {
                line = sanitize(fields, now);
            }
            catch {
                return;
            }
            try {
                mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
                rotateIfNeeded(Buffer.byteLength(line, 'utf8') + 1);
                appendFileSync(file, `${line}\n`, { mode: 0o600 });
                // 文件可能由旧版本/其他进程以更宽权限创建，追加后统一收紧。
                try {
                    chmodSync(file, 0o600);
                }
                catch { /* 权限收紧失败不影响已写入记录 */ }
            }
            catch {
                warn('marshal: audit-write-failed: cannot append');
            }
        },
    };
}
