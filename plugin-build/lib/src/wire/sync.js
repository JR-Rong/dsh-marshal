import { createHash } from 'node:crypto';
/** 单分片最多多少行；行数只作上限，实际还要受字节数约束。 */
export const SYNC_CHUNK_MAX_ROWS = 512;
/** 单分片 JSON 载荷上限（256 KiB）。 */
export const SYNC_CHUNK_MAX_BYTES = 256 * 1024;
/** 同步暂存超时：超时即放弃暂存，保留旧索引并标 stale。 */
export const SYNC_STAGING_TIMEOUT_MS = 30_000;
/** node 周期扫描间隔与单次扫描期限；契约 §11 要求 30s 内可见。 */
export const SYNC_SCAN_INTERVAL_MS = 10_000;
export const SYNC_SCAN_TIMEOUT_MS = 10_000;
/** node 等待 sync.ack 的期限；超时不得 online，只能重连重试。 */
export const SYNC_ACK_TIMEOUT_MS = 15_000;
/**
 * 分片载荷的规范形式：数组按节点发来的字段顺序序列化。
 * 两端都用同一函数计算校验和，避免各自定义 canonical 规则。
 */
export function canonicalRows(rows) {
    return JSON.stringify(rows);
}
/** sha256(按 chunk index 顺序拼接的规范载荷)；空快照就是 sha256("")。 */
export function syncChecksum(chunks) {
    const hash = createHash('sha256');
    for (const rows of chunks)
        hash.update(canonicalRows(rows), 'utf8');
    return hash.digest('hex');
}
/** 逐行累计到 ≤512 行 / ≤256 KiB 的分片；单行超限时独占一片，交由帧上限拒绝。 */
export function buildSyncChunks(rows) {
    const chunks = [];
    let current = [];
    let bytes = 0;
    for (const row of rows) {
        const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
        if (current.length > 0
            && (current.length >= SYNC_CHUNK_MAX_ROWS || bytes + size > SYNC_CHUNK_MAX_BYTES)) {
            chunks.push(current);
            current = [];
            bytes = 0;
        }
        current.push(row);
        bytes += size;
    }
    if (current.length > 0)
        chunks.push(current);
    return chunks;
}
