import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { COMMAND_OPS } from "../wire/frames.js";
import { commandPayloadDigest } from "../wire/commands.js";
import { commandDomainKey } from "../wire/idempotency.js";
import { FileLockError, acquireFileLock, atomicWriteFile, ensurePrivateDir, } from "../hub/state-file.js";
export const JOURNAL_VERSION = 2;
export const JOURNAL_INIT_VERSION = 1;
export const DEFAULT_JOURNAL_CAPACITY = 10_000;
/** 终态至少保留 24h；只有容量不足时才允许提前回收更老的终态。 */
export const DEFAULT_JOURNAL_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 结果白名单的字节上限：超出就当作没有结果，而不是把大对象写进 journal。 */
export const RESULT_MAX_BYTES = 4096;
const DEFAULT_JOURNAL_FILE = join(homedir(), '.dsh-marshal', 'journal.json');
const INIT_FILE_NAME = 'journal.init';
/** 只有这些键（递归到原始值）允许进入 journal；正文/路径不在其中。 */
const RESULT_KEYS = new Set([
    'sessionId', 'turnId', 'following', 'accepted', 'configured', 'revision',
]);
const RESULT_MAX_DEPTH = 4;
const STATUSES = new Set([
    'admitted', 'accepted', 'confirmed', 'rejected', 'pending-confirmation', 'outcome-unknown',
]);
/** 未决记录永不驱逐：容量满时宁拒绝新写，也不能丢掉恢复依据。 */
const UNRESOLVED = new Set([
    'admitted', 'pending-confirmation', 'outcome-unknown',
]);
const DOMAIN_KEY = /^[0-9a-f]{64}$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
/** 分类错误：调用方只按 code 处理，不解析消息文本。 */
export class JournalError extends Error {
    name = 'JournalError';
    code;
    constructor(code, detail) {
        super(`marshal: ${code}: ${detail ?? code}`);
        this.code = code;
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readText(path, label) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw new JournalError('recovery-required', `${label} is unreadable`);
    }
}
function sanitizeNode(value, depth) {
    if (value === null)
        return null;
    if (typeof value === 'string' || typeof value === 'boolean')
        return value;
    // NaN/Infinity 会被 JSON 序列化成 null：拒绝，避免静默改变语义。
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    if (depth >= RESULT_MAX_DEPTH || !isObject(value))
        return undefined;
    const output = {};
    let kept = false;
    for (const [key, item] of Object.entries(value)) {
        if (!RESULT_KEYS.has(key))
            continue;
        const clean = sanitizeNode(item, depth + 1);
        if (clean === undefined)
            continue;
        output[key] = clean;
        kept = true;
    }
    return kept ? output : undefined;
}
/**
 * 只保留白名单键 + 原始值，并限制体积；不满足就返回 undefined（存为“无结果”）。
 * 这里不做尽力截断：宁可少存，也不把不受控的结构写进去。
 */
export function sanitizeResult(value) {
    if (!isObject(value))
        return undefined;
    const clean = sanitizeNode(value, 0);
    if (!isObject(clean))
        return undefined;
    let text;
    try {
        text = JSON.stringify(clean);
    }
    catch {
        return undefined;
    }
    if (Buffer.byteLength(text, 'utf8') > RESULT_MAX_BYTES)
        return undefined;
    return clean;
}
function parseEntry(key, value) {
    if (!isObject(value)
        || value.domainKey !== key
        || !DOMAIN_KEY.test(key)
        || typeof value.op !== 'string'
        || !COMMAND_OPS.includes(value.op)
        || typeof value.deviceId !== 'string' || value.deviceId === ''
        || typeof value.agent !== 'string' || value.agent === ''
        || (value.sessionId !== null && (typeof value.sessionId !== 'string' || value.sessionId === ''))
        || typeof value.status !== 'string' || !STATUSES.has(value.status)
        || (value.code !== undefined && typeof value.code !== 'string')
        || typeof value.payloadDigest !== 'string' || !HEX_DIGEST.test(value.payloadDigest)
        || typeof value.admittedAt !== 'number' || !Number.isInteger(value.admittedAt) || value.admittedAt < 0
        || typeof value.updatedAt !== 'number' || !Number.isInteger(value.updatedAt) || value.updatedAt < 0) {
        throw new JournalError('recovery-required', 'journal.json is corrupt; restore it from a trusted backup');
    }
    let result;
    if (value.result !== undefined) {
        result = sanitizeResult(value.result);
        // 本实现只写白名单结果；出现别的形状说明文件被改过或版本不匹配。
        if (result === undefined) {
            throw new JournalError('recovery-required', 'journal.json has an unsupported result; restore it from a trusted backup');
        }
    }
    return {
        domainKey: key,
        op: value.op,
        deviceId: value.deviceId,
        agent: value.agent,
        sessionId: value.sessionId,
        status: value.status,
        ...(value.code === undefined ? {} : { code: value.code }),
        ...(result === undefined ? {} : { result }),
        payloadDigest: value.payloadDigest,
        admittedAt: value.admittedAt,
        updatedAt: value.updatedAt,
    };
}
function parseJournal(text) {
    let json;
    try {
        json = JSON.parse(text);
    }
    catch {
        throw new JournalError('recovery-required', 'journal.json is not valid JSON; restore it from a trusted backup');
    }
    if (!isObject(json)
        || json.version !== JOURNAL_VERSION
        || typeof json.keyFingerprint !== 'string' || !HEX_DIGEST.test(json.keyFingerprint)
        || typeof json.generation !== 'number' || !Number.isInteger(json.generation) || json.generation < 0
        || !isObject(json.entries)) {
        throw new JournalError('recovery-required', 'journal.json has an unsupported shape');
    }
    const entries = new Map();
    for (const [key, value] of Object.entries(json.entries)) {
        entries.set(key, parseEntry(key, value));
    }
    return { entries, keyFingerprint: json.keyFingerprint, generation: json.generation };
}
function serialize(entries, keyFingerprint, generation) {
    return `${JSON.stringify({
        version: JOURNAL_VERSION,
        keyFingerprint,
        generation,
        entries: Object.fromEntries(entries),
    })}\n`;
}
/** 初始化标记：证明 journal+key 是同一次初始化产生的，且没有被回滚。 */
function parseInitMarker(text) {
    let json;
    try {
        json = JSON.parse(text);
    }
    catch {
        throw new JournalError('recovery-required', 'journal.init is not valid JSON; restore it from a trusted backup');
    }
    if (!isObject(json)
        || json.version !== JOURNAL_INIT_VERSION
        || typeof json.keyFingerprint !== 'string' || !HEX_DIGEST.test(json.keyFingerprint)
        || typeof json.generation !== 'number' || !Number.isInteger(json.generation) || json.generation < 0
        || typeof json.createdAt !== 'number' || !Number.isInteger(json.createdAt) || json.createdAt < 0) {
        throw new JournalError('recovery-required', 'journal.init has an unsupported shape');
    }
    return {
        keyFingerprint: json.keyFingerprint,
        generation: json.generation,
        createdAt: json.createdAt,
    };
}
function serializeInitMarker(marker) {
    return `${JSON.stringify({
        version: JOURNAL_INIT_VERSION,
        keyFingerprint: marker.keyFingerprint,
        generation: marker.generation,
        createdAt: marker.createdAt,
    })}\n`;
}
function keyFingerprintOf(key) {
    return createHash('sha256').update(key).digest('hex');
}
function parseKey(text) {
    const trimmed = text.trim();
    // 只接受 base64url 字符；错误长度/乱码都视为密钥损坏，不能自动换新密钥。
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
        throw new JournalError('recovery-required', 'journal.key is corrupt; restore it from a trusted backup');
    }
    const key = Buffer.from(trimmed, 'base64url');
    if (key.length < 32) {
        throw new JournalError('recovery-required', 'journal.key is too short; restore it from a trusted backup');
    }
    return key;
}
function defaultJournalPath() {
    return process.env.MARSHAL_JOURNAL_FILE ?? DEFAULT_JOURNAL_FILE;
}
/**
 * 打开（必要时首次创建）journal 并长期持有进程间排他锁。
 *
 * 初始化完整性：
 * - journal、key、init 标记三者都不存在 → 首次运行；先写标记，再写密钥与空 journal；
 * - 任一存在但不同时齐全 → recovery-required，不自动补建、不静默接管；
 * - 密钥指纹与标记/头部不一致，或标记代次高于 journal（旧备份回滚）→ recovery-required；
 * - 解析/密钥校验失败 → recovery-required；
 * - 启动时 admitted → outcome-unknown 并立即落盘；pending-confirmation 保持不变。
 */
export function openJournal(options = {}) {
    const file = resolve(options.file ?? defaultJournalPath());
    // 默认 key/init 标记与 journal 同目录：默认路径下就是 $HOME/.dsh-marshal/*，
    // 测试覆盖 journal 路径时也不会误用真实 HOME 里的状态。
    const keyFile = resolve(options.keyFile ?? process.env.MARSHAL_JOURNAL_KEY_FILE ?? join(dirname(file), 'journal.key'));
    const initFile = resolve(options.initFile
        ?? process.env.MARSHAL_JOURNAL_INIT_FILE
        ?? join(dirname(file), INIT_FILE_NAME));
    const capacity = options.capacity ?? DEFAULT_JOURNAL_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
        throw new JournalError('recovery-required', 'journal capacity must be a positive integer');
    }
    ensurePrivateDir(dirname(file));
    ensurePrivateDir(dirname(keyFile));
    ensurePrivateDir(dirname(initFile));
    let lock;
    try {
        lock = acquireFileLock(file, options.now);
    }
    catch (error) {
        if (error instanceof FileLockError) {
            throw new JournalError('lock-held', 'journal is already held by another running instance');
        }
        throw error;
    }
    try {
        const now = options.now ?? Date.now;
        let journalText = readText(file, 'journal.json');
        let keyText = readText(keyFile, 'journal.key');
        let markerText = readText(initFile, INIT_FILE_NAME);
        if (journalText === undefined && keyText === undefined && markerText === undefined) {
            // 首次初始化：标记必须先落盘。标记存在而 journal/key 缺失时，下次打开会
            // 进入 recovery-required，而不是把缺失当作全新安装。
            const key = randomBytes(32);
            keyText = `${key.toString('base64url')}\n`;
            const createdAt = now();
            const keyFingerprint = keyFingerprintOf(key);
            markerText = serializeInitMarker({ keyFingerprint, generation: 1, createdAt });
            journalText = serialize(new Map(), keyFingerprint, 1);
            atomicWriteFile(initFile, markerText, 0o600);
            atomicWriteFile(keyFile, keyText, 0o600);
            atomicWriteFile(file, journalText, 0o600);
        }
        else if (journalText === undefined || keyText === undefined || markerText === undefined) {
            // 不能自行补建缺失的部分：那会把已初始化的去重域重置为空，或静默接管旧文件。
            throw new JournalError('recovery-required', 'journal.json, journal.key and journal.init must exist together');
        }
        chmodSync(file, 0o600);
        chmodSync(keyFile, 0o600);
        chmodSync(initFile, 0o600);
        const key = parseKey(keyText);
        const marker = parseInitMarker(markerText);
        const header = parseJournal(journalText);
        const keyFingerprint = keyFingerprintOf(key);
        if (header.keyFingerprint !== keyFingerprint || marker.keyFingerprint !== keyFingerprint) {
            // 密钥换了而标记/头部仍是旧指纹：继续使用会把幂等域按错误的密钥重建。
            throw new JournalError('recovery-required', 'journal key fingerprint does not match journal.init/journal.json');
        }
        if (marker.generation > header.generation) {
            // 标记比 journal 新：journal 被旧备份覆盖过，不能据此推断“未执行”。
            throw new JournalError('recovery-required', 'journal.json is older than journal.init (rolled back backup)');
        }
        const recoveredAt = now();
        const next = new Map(header.entries);
        let changed = false;
        for (const [domainKey, entry] of next) {
            if (entry.status !== 'admitted')
                continue;
            // 崩溃发生在 admitted 之后、调用/落结果之间：不推断副作用是否发生。
            next.set(domainKey, { ...entry, status: 'outcome-unknown', updatedAt: recoveredAt });
            changed = true;
        }
        const journal = new Journal({
            file,
            initFile,
            key,
            keyFingerprint,
            generation: header.generation,
            markerCreatedAt: marker.createdAt,
            entries: next,
            capacity,
            retentionMs: options.retentionMs ?? DEFAULT_JOURNAL_RETENTION_MS,
            now,
            lock,
        });
        if (changed)
            journal.persist(next);
        return journal;
    }
    catch (error) {
        lock.release();
        throw error;
    }
}
export class Journal {
    entries;
    generation;
    released = false;
    initFile;
    file;
    key;
    keyFingerprint;
    markerCreatedAt;
    capacity;
    retentionMs;
    now;
    lock;
    constructor(init) {
        this.file = init.file;
        this.initFile = init.initFile;
        this.key = init.key;
        this.keyFingerprint = init.keyFingerprint;
        this.generation = init.generation;
        this.markerCreatedAt = init.markerCreatedAt;
        this.entries = init.entries;
        this.capacity = init.capacity;
        this.retentionMs = init.retentionMs;
        this.now = init.now;
        this.lock = init.lock;
    }
    get size() { return this.entries.size; }
    /** 该域是否存在记录；只读，不写盘。 */
    lookup(domain) {
        this.assertOpen();
        return this.entries.get(commandDomainKey(domain));
    }
    /**
     * 调用 agent 前持久化 admitted。只有本次写入成功返回后调用方才允许发起调用。
     * 载荷摘要用本地 HMAC；正文/参数只在摘要计算期间存在于内存。
     */
    admit(input) {
        this.assertOpen();
        const key = commandDomainKey(input.domain);
        if (this.entries.has(key)) {
            throw new JournalError('record-unavailable', 'domain is already admitted');
        }
        const next = new Map(this.entries);
        if (next.size >= this.capacity)
            this.evictResolved(next);
        if (next.size >= this.capacity) {
            throw new JournalError('size-limit', 'journal is full of unresolved or recent entries');
        }
        const at = this.now();
        const entry = {
            domainKey: key,
            op: input.op,
            deviceId: input.domain.target.deviceId,
            agent: input.domain.target.agent,
            sessionId: input.domain.target.sessionId,
            status: 'admitted',
            payloadDigest: this.digestPayload(input.op, input.domain.target, input.args),
            admittedAt: at,
            updatedAt: at,
        };
        next.set(key, entry);
        this.persist(next);
        return entry;
    }
    /**
     * `result` 只对 accepted/confirmed 且通过白名单/体积检查的部分落盘；
     * 其余形状一律存为“无结果”，重放时也不会凭空返回。
     */
    settle(domain, status, code, result) {
        this.assertOpen();
        const key = commandDomainKey(domain);
        const current = this.entries.get(key);
        if (current === undefined)
            throw new JournalError('record-unavailable', 'domain has no journal entry');
        const sanitized = status === 'accepted' || status === 'confirmed' ? sanitizeResult(result) : undefined;
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
            ...(code === undefined ? {} : { code }),
            ...(sanitized === undefined ? {} : { result: sanitized }),
        };
        const next = new Map(this.entries);
        next.set(key, base);
        this.persist(next);
        return base;
    }
    /** HMAC-SHA256(本地密钥, 规范化载荷摘要)；外部只看到摘要，看不到正文。 */
    digestPayload(op, target, args) {
        this.assertOpen();
        return createHmac('sha256', this.key)
            .update(commandPayloadDigest(op, target, args), 'utf8')
            .digest('hex');
    }
    /** 释放进程间锁；之后该 journal 不再可用。幂等。 */
    close() {
        if (this.released)
            return;
        this.released = true;
        this.entries.clear();
        this.lock.release();
    }
    /**
     * 每次持久化都推进代次：先写 journal，再镜像到 init 标记。
     * 标记写失败说明磁盘证据不可信，必须转人工恢复；不能带着旧代次继续运行。
     */
    persist(entries) {
        const generation = this.generation + 1;
        try {
            atomicWriteFile(this.file, serialize(entries, this.keyFingerprint, generation), 0o600);
        }
        catch {
            // 不把底层路径/errno 透出到命令通道。
            throw new JournalError('recovery-required', 'journal write failed');
        }
        try {
            atomicWriteFile(this.initFile, serializeInitMarker({
                keyFingerprint: this.keyFingerprint,
                generation,
                createdAt: this.markerCreatedAt,
            }), 0o600);
        }
        catch {
            throw new JournalError('recovery-required', 'journal marker write failed');
        }
        this.generation = generation;
        this.entries = entries;
    }
    evictResolved(next) {
        const cutoff = this.now() - this.retentionMs;
        const candidates = [...next.values()]
            .filter(entry => !UNRESOLVED.has(entry.status) && entry.updatedAt <= cutoff)
            .sort((a, b) => a.updatedAt - b.updatedAt);
        for (const candidate of candidates) {
            if (next.size < this.capacity)
                break;
            next.delete(candidate.domainKey);
        }
    }
    assertOpen() {
        if (this.released)
            throw new JournalError('journal-closed', 'journal is closed');
    }
}
