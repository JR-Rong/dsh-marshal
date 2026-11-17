import { createHash } from 'node:crypto';
/** 域键用固定顺序的 JSON 数组再哈希；分隔符/转义不会造成跨域碰撞。 */
export function commandDomainKey(domain) {
    const canonical = JSON.stringify([
        domain.operatorId,
        domain.target.deviceId,
        domain.target.agent,
        domain.target.sessionId,
        domain.idempotencyKey,
    ]);
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
/** 记住已受理指令的结果，防止重连后重复执行。 */
export class CommandLog {
    ttlMs;
    limit;
    now;
    entries = new Map();
    constructor(ttlMs = 30_000, limit = 512, now = Date.now) {
        this.ttlMs = ttlMs;
        this.limit = limit;
        this.now = now;
    }
    remember(key, result) {
        this.prune();
        // 先删除再写入，令重复 key 移到 Map 末尾，使淘汰顺序按最近使用（LRU）而非插入顺序。
        this.entries.delete(key);
        this.entries.set(key, { at: this.now(), result });
        while (this.entries.size > this.limit) {
            const oldest = this.entries.keys().next();
            if (oldest.done === true)
                break;
            this.entries.delete(oldest.value);
        }
    }
    lookup(key) {
        this.prune();
        const entry = this.entries.get(key);
        return entry === undefined ? { hit: false } : { hit: true, result: entry.result };
    }
    prune() {
        const cutoff = this.now() - this.ttlMs;
        for (const [key, entry] of this.entries) {
            if (entry.at < cutoff)
                this.entries.delete(key);
        }
    }
}
