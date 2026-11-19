import { createHash, randomBytes } from 'node:crypto';
import { atomicWriteFile, withFileLock, readTextIfExists } from "./state-file.js";
/** 设备状态文件 v2；v1 只能经 `marshal-device migrate` 显式转换。 */
export const DEVICES_FILE_VERSION = 2;
export class DeviceStateError extends Error {
    name = 'DeviceStateError';
    code;
    constructor(code, detail) {
        // 错误只带分类与结构信息，绝不拼接 token 或摘要。
        super(`marshal: ${code}: ${detail}`);
        this.code = code;
    }
}
export function phoneTokenDigest(secret) {
    return sha256Hex('marshal-phone-v1\0' + secret);
}
export function sha256Hex(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function emptyDevicesState() {
    return { version: DEVICES_FILE_VERSION, devices: [] };
}
export function serializeDevicesState(state) {
    return `${JSON.stringify(state, null, 2)}\n`;
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
    return typeof value === 'string' && value !== '';
}
function assertUnique(records, context) {
    const ids = new Set();
    const digests = new Set();
    for (const record of records) {
        if (ids.has(record.id)) {
            throw new DeviceStateError('duplicate-id', `${context} repeats device id "${record.id}"`);
        }
        ids.add(record.id);
        if (digests.has(record.tokenDigest)) {
            throw new DeviceStateError('duplicate-digest', `${context} repeats a token digest for "${record.id}"`);
        }
        digests.add(record.tokenDigest);
    }
}
function validateRecord(value, index) {
    if (!isObject(value))
        throw new DeviceStateError('invalid', `devices[${index}] is not an object`);
    const { id, name, tokenDigest, revoked, allowContent, allowInteractions, allowDiscussion, policyRevision, revokedAt, ownerId } = value;
    if (!nonEmptyString(id))
        throw new DeviceStateError('invalid', `devices[${index}].id must be a non-empty string`);
    if (!nonEmptyString(name))
        throw new DeviceStateError('invalid', `devices[${index}].name must be a non-empty string`);
    if (typeof tokenDigest !== 'string' || !/^[0-9a-f]{64}$/.test(tokenDigest)) {
        throw new DeviceStateError('invalid', `devices[${index}].tokenDigest must be a hex sha256`);
    }
    if (typeof revoked !== 'boolean')
        throw new DeviceStateError('invalid', `devices[${index}].revoked must be a boolean`);
    for (const key of ['allowContent', 'allowInteractions', 'allowDiscussion']) {
        if (typeof value[key] !== 'boolean') {
            throw new DeviceStateError('invalid', `devices[${index}].${key} must be a boolean`);
        }
    }
    // 修订字段异常不拖垮整张表：设备仍在，但授权不可确认，拒绝新写。
    const revisionUnconfirmed = typeof policyRevision !== 'number'
        || !Number.isInteger(policyRevision)
        || policyRevision < 1;
    if (revokedAt !== undefined && (typeof revokedAt !== 'number' || !Number.isInteger(revokedAt) || revokedAt < 0)) {
        throw new DeviceStateError('invalid', `devices[${index}].revokedAt must be an integer >= 0`);
    }
    if (ownerId !== undefined && (typeof ownerId !== 'string' || ownerId === '' || ownerId.length > 128 || /[\x00-\x1f\x7f]/.test(ownerId))) {
        throw new DeviceStateError('invalid', `devices[${index}].ownerId must be 1–128 visible characters`);
    }
    return {
        record: {
            id, name, tokenDigest, revoked,
            allowContent: allowContent,
            allowInteractions: allowInteractions,
            allowDiscussion: allowDiscussion,
            // 占位值只用于内存；任何写盘都会因 unconfirmed 而被拒绝，不会把 0 持久化。
            policyRevision: revisionUnconfirmed ? 0 : policyRevision,
            ...(revokedAt === undefined ? {} : { revokedAt }),
            ...(ownerId === undefined ? {} : { ownerId }),
            ...parsePhoneFields(value, index),
        },
        revisionUnconfirmed,
    };
}
function parsePhoneFields(value, index) {
    if (value.role !== undefined && value.role !== 'phone') {
        throw new DeviceStateError('invalid', `devices[${index}].role must be phone`);
    }
    const text = (key) => {
        const field = value[key];
        if (field === undefined) return undefined;
        if (typeof field !== 'string' || field.length === 0 || field.length > 512) {
            throw new DeviceStateError('invalid', `devices[${index}].${key} must be a short string`);
        }
        return field;
    };
    const accountHash = text('accountHash');
    const installationId = text('installationId');
    const pushToken = text('pushToken');
    const liveToken = text('liveToken');
    if (value.pushProvider !== undefined && value.pushProvider !== 'apns' && value.pushProvider !== 'fcm' && value.pushProvider !== 'huawei') {
        throw new DeviceStateError('invalid', `devices[${index}].pushProvider is unknown`);
    }
    if (value.lastSeen !== undefined && (typeof value.lastSeen !== 'number' || !Number.isInteger(value.lastSeen) || value.lastSeen < 0)) {
        throw new DeviceStateError('invalid', `devices[${index}].lastSeen must be an integer >= 0`);
    }
    return {
        ...(value.role === 'phone' ? { role: 'phone' } : {}),
        ...(accountHash === undefined ? {} : { accountHash }),
        ...(installationId === undefined ? {} : { installationId }),
        ...(pushToken === undefined ? {} : { pushToken }),
        ...(liveToken === undefined ? {} : { liveToken }),
        ...(value.pushProvider === 'apns' || value.pushProvider === 'fcm' || value.pushProvider === 'huawei' ? { pushProvider: value.pushProvider } : {}),
        ...(typeof value.lastSeen === 'number' ? { lastSeen: value.lastSeen } : {}),
    };
}
function parseHighWatermarks(value) {
    if (value === undefined)
        return undefined;
    if (!isObject(value))
        throw new DeviceStateError('invalid', 'revisionHighWatermarks must be an object');
    const marks = {};
    for (const [id, mark] of Object.entries(value)) {
        if (typeof mark !== 'number' || !Number.isInteger(mark) || mark < 0) {
            throw new DeviceStateError('invalid', `revisionHighWatermarks["${id}"] must be an integer >= 0`);
        }
        marks[id] = mark;
    }
    return marks;
}
function parseCurrent(value) {
    if (value.version !== DEVICES_FILE_VERSION) {
        throw new DeviceStateError('invalid', `devices file version must be ${DEVICES_FILE_VERSION}`);
    }
    if (!Array.isArray(value.devices))
        throw new DeviceStateError('invalid', 'devices must be an array');
    const validated = value.devices.map((item, index) => validateRecord(item, index));
    const devices = validated.map(item => item.record);
    assertUnique(devices, 'devices file');
    const watermarks = parseHighWatermarks(value.revisionHighWatermarks);
    const unconfirmed = new Set();
    validated.forEach((item, index) => {
        if (item.revisionUnconfirmed)
            unconfirmed.add(item.record.id);
        const mark = watermarks?.[item.record.id];
        // 只有确实存过高水位时才把较低 revision 视为回退；否则不同设备各自递增是正常的。
        if (mark !== undefined && item.record.policyRevision < mark)
            unconfirmed.add(devices[index].id);
    });
    return {
        kind: 'current',
        state: {
            version: DEVICES_FILE_VERSION,
            devices,
            ...(watermarks === undefined ? {} : { revisionHighWatermarks: watermarks }),
        },
        revisionUnconfirmed: [...unconfirmed],
    };
}
function looksLegacy(value) {
    if (value.version !== undefined && value.version !== 1)
        return false;
    if (!Array.isArray(value.devices))
        return false;
    return value.devices.every(item => isObject(item)
        && typeof item.id === 'string'
        && typeof item.name === 'string'
        && typeof item.token === 'string');
}
function parseLegacy(value) {
    const devices = value.devices;
    if (!Array.isArray(devices))
        throw new DeviceStateError('invalid', 'legacy devices must be an array');
    const seen = new Set();
    return devices.map((item, index) => {
        if (!isObject(item)
            || !nonEmptyString(item.id) || !nonEmptyString(item.name) || !nonEmptyString(item.token)) {
            throw new DeviceStateError('invalid', `legacy devices[${index}] is incomplete`);
        }
        if (seen.has(item.id))
            throw new DeviceStateError('duplicate-id', `legacy devices repeat id "${item.id}"`);
        seen.add(item.id);
        return { id: item.id, name: item.name, token: item.token };
    });
}
/**
 * 读取并分类设备表：缺失、v1 旧表、结构合法的 v2。
 * 无法读取/解析/结构非法都抛错，绝不静默丢弃条目。
 */
export function readDeviceState(path) {
    let text;
    try {
        text = readTextIfExists(path);
    }
    catch {
        throw new DeviceStateError('unreadable', `cannot read ${path}`);
    }
    if (text === undefined)
        return { kind: 'missing' };
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new DeviceStateError('unreadable', `${path} is not valid JSON`);
    }
    if (!isObject(parsed))
        throw new DeviceStateError('invalid', `${path} must contain an object`);
    if (parsed.version === DEVICES_FILE_VERSION)
        return parseCurrent(parsed);
    if (looksLegacy(parsed))
        return { kind: 'legacy', devices: parseLegacy(parsed) };
    throw new DeviceStateError('invalid', `${path} is not a v1 or v2 device table`);
}
/** v1 → v2 的纯转换；不写盘，也不改动旧 token 原文。 */
export function migrateLegacyState(devices) {
    const migrated = devices.map((device) => ({
        id: device.id,
        name: device.name,
        tokenDigest: sha256Hex(device.token),
        revoked: false,
        allowContent: false,
        allowInteractions: false,
        allowDiscussion: false,
        policyRevision: 1,
    }));
    assertUnique(migrated, 'migrated device table');
    return { version: DEVICES_FILE_VERSION, devices: migrated };
}
/**
 * 进程间共享的设备表写者。每次变更都在锁内重读整表、校验版本与唯一性，
 * 成功后原子替换；写盘失败时内存状态保持旧值。
 */
export class DeviceStore {
    path;
    state;
    now;
    /** 修订异常设备：可启动但授权不可确认，任何整表写入都会拒绝以保留原始证据。 */
    unconfirmed = new Set();
    constructor(path, options = {}) {
        this.path = path;
        this.now = options.now ?? Date.now;
        this.state = this.load();
    }
    get file() { return this.path; }
    reload() {
        this.state = this.load();
    }
    list() { return [...this.state.devices]; }
    /** 该设备是否因修订缺失/非法/回退而不能确认授权。 */
    isRecoveryRequired(id) { return this.unconfirmed.has(id); }
    recoveryRequired() { return [...this.unconfirmed]; }
    findById(id) {
        return this.state.devices.find(device => device.id === id);
    }
    findByTokenDigest(digest) {
        return this.state.devices.find(device => device.tokenDigest === digest);
    }
    add(id, name) {
        if (id === '')
            throw new DeviceStateError('invalid', 'device id must not be blank');
        return this.mutate(state => {
            const existing = state.devices.find(device => device.id === id);
            if (existing !== undefined) {
                throw existing.revoked
                    ? new DeviceStateError('revoked', `device "${id}" is revoked and cannot be re-added`)
                    : new DeviceStateError('duplicate-id', `device "${id}" already exists`);
            }
            const token = randomBytes(32).toString('base64url');
            const entry = {
                id,
                name: name === '' ? id : name,
                tokenDigest: sha256Hex(token),
                revoked: false,
                allowContent: false,
                allowInteractions: false,
                allowDiscussion: false,
                policyRevision: 1,
            };
            return {
                state: { version: DEVICES_FILE_VERSION, devices: [...state.devices, entry] },
                result: { entry, revision: entry.policyRevision, token },
            };
        });
    }
    /** The native installation persists its random credential BEFORE enrollment.
     * Retrying the same verified account/installation cannot rotate it or widen policy. */
    enroll(id, name, tokenDigest, content, ownerId) {
        if (!/^account-[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(tokenDigest)
            || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)
            || (ownerId !== undefined && (typeof ownerId !== 'string' || ownerId === '' || ownerId.length > 128 || /[\x00-\x1f\x7f]/.test(ownerId))))
            throw new DeviceStateError('invalid', 'invalid enrollment');
        return this.mutate(state => {
            const current = state.devices.find(device => device.id === id);
            if (current?.revoked)
                throw new DeviceStateError('revoked', 'device enrollment revoked');
            if (current) {
                if (current.tokenDigest !== tokenDigest)
                    throw new DeviceStateError('duplicate-id', 'installation credential mismatch');
                if (typeof ownerId === 'string' && current.ownerId !== undefined && current.ownerId !== ownerId)
                    throw new DeviceStateError('invalid', 'device owner mismatch');
                if (typeof ownerId === 'string' && current.ownerId === undefined) {
                    const entry = { ...current, ownerId };
                    return { state: { ...state, devices: state.devices.map(device => device.id === id ? entry : device) }, result: entry };
                }
                return { state, result: current };
            }
            if (state.devices.length >= 256 || state.devices.some(device => device.tokenDigest === tokenDigest)) {
                throw new DeviceStateError('invalid', 'enrollment limit or credential conflict');
            }
            const entry = { id, name: name.trim(), tokenDigest, revoked: false,
                allowContent: content, allowDiscussion: content, allowInteractions: false, policyRevision: 1,
                ...(typeof ownerId === 'string' ? { ownerId } : {}) };
            return { state: { ...state, devices: [...state.devices, entry] }, result: entry };
        });
    }
    revoke(id) {
        return this.mutate(state => {
            const index = state.devices.findIndex(device => device.id === id);
            if (index === -1)
                throw new DeviceStateError('unknown-device', `unknown device "${id}"`);
            const current = state.devices[index];
            if (current === undefined)
                throw new DeviceStateError('unknown-device', `unknown device "${id}"`);
            if (current.revoked)
                throw new DeviceStateError('revoked', `device "${id}" is already revoked`);
            const entry = {
                ...current,
                revoked: true,
                revokedAt: this.now(),
                policyRevision: current.policyRevision + 1,
            };
            const devices = [...state.devices];
            devices[index] = entry;
            return { state: { version: DEVICES_FILE_VERSION, devices }, result: { entry, revision: entry.policyRevision } };
        });
    }
    setPolicy(id, changes) {
        const keys = ['allowContent', 'allowInteractions', 'allowDiscussion']
            .filter(key => changes[key] !== undefined);
        if (keys.length === 0)
            throw new DeviceStateError('invalid-policy', 'no policy change requested');
        return this.mutate(state => {
            const index = state.devices.findIndex(device => device.id === id);
            if (index === -1)
                throw new DeviceStateError('unknown-device', `unknown device "${id}"`);
            const current = state.devices[index];
            if (current === undefined)
                throw new DeviceStateError('unknown-device', `unknown device "${id}"`);
            if (current.revoked)
                throw new DeviceStateError('revoked', `device "${id}" is revoked`);
            const entry = {
                ...current,
                ...(changes.allowContent === undefined ? {} : { allowContent: changes.allowContent }),
                ...(changes.allowInteractions === undefined ? {} : { allowInteractions: changes.allowInteractions }),
                ...(changes.allowDiscussion === undefined ? {} : { allowDiscussion: changes.allowDiscussion }),
                policyRevision: current.policyRevision + 1,
            };
            const devices = [...state.devices];
            devices[index] = entry;
            return { state: { version: DEVICES_FILE_VERSION, devices }, result: { entry, revision: entry.policyRevision } };
        });
    }
    phones() {
        return this.state.devices.filter(device => device.role === 'phone' && !device.revoked);
    }
    /** 同一安装再次配对会换掉旧摘要，旧凭证立刻失效。 */
    enrollPhone(input) {
        const name = input.name.trim();
        if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name))
            throw new DeviceStateError('invalid', 'invalid phone name');
        if (!input.installationId || input.installationId.length > 128)
            throw new DeviceStateError('invalid', 'invalid installation');
        if (!input.accountHash || input.accountHash.length > 128)
            throw new DeviceStateError('invalid', 'invalid account');
        const credential = 'mph1.' + randomBytes(32).toString('base64url');
        const tokenDigest = phoneTokenDigest(credential.slice('mph1.'.length));
        const id = 'phone-' + sha256Hex(input.installationId).slice(0, 32);
        return this.mutate(state => {
            const current = state.devices.find(device => device.id === id);
            if (current?.revoked)
                throw new DeviceStateError('revoked', 'phone enrollment revoked');
            const entry = {
                id,
                name,
                tokenDigest,
                revoked: false,
                allowContent: false,
                allowInteractions: true,
                allowDiscussion: true,
                policyRevision: current === undefined ? 1 : current.policyRevision + 1,
                role: 'phone',
                accountHash: input.accountHash,
                installationId: input.installationId,
            };
            const devices = current === undefined
                ? [...state.devices, entry]
                : state.devices.map(device => device.id === id ? entry : device);
            return { state: { ...state, devices }, result: { record: entry, credential } };
        });
    }
    touchPhone(id, at) {
        const current = this.findById(id);
        if (current?.role !== 'phone' || current.revoked)
            return;
        if (typeof current.lastSeen === 'number' && at - current.lastSeen < 60_000)
            return;
        this.mutate(state => {
            const devices = state.devices.map(device => device.id === id ? { ...device, lastSeen: at } : device);
            return { state: { ...state, devices }, result: undefined };
        });
    }
    setPhonePush(id, target) {
        this.mutate(state => {
            const current = state.devices.find(device => device.id === id);
            if (current?.role !== 'phone' || current.revoked)
                throw new DeviceStateError('unknown-device', 'phone not found');
            const entry = {
                ...current,
                pushProvider: target.provider,
                pushToken: target.token,
                ...(target.liveToken === undefined ? {} : { liveToken: target.liveToken }),
            };
            return {
                state: { ...state, devices: state.devices.map(device => device.id === id ? entry : device) },
                result: undefined,
            };
        });
    }
    rename(id, rawName) {
        const name = rawName.trim();
        if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
            throw new DeviceStateError('invalid', 'name must contain 1–80 printable characters');
        }
        return this.mutate(state => {
            const current = state.devices.find(item => item.id === id);
            if (!current)
                throw new DeviceStateError('unknown-device', 'device not found');
            const entry = { ...current, name };
            return { state: { ...state, devices: state.devices.map(item => item.id === id ? entry : item) }, result: entry };
        });
    }
    load() {
        const loaded = readDeviceState(this.path);
        if (loaded.kind === 'missing')
            throw new DeviceStateError('missing', `device table ${this.path} is missing`);
        if (loaded.kind === 'legacy') {
            throw new DeviceStateError('legacy', `device table ${this.path} is v1; run "marshal-device migrate" and point devicesFile at the new file`);
        }
        this.unconfirmed = new Set(loaded.revisionUnconfirmed);
        return loaded.state;
    }
    /** 已有高水位只能升不能降；新写入的 revision 同时推进高水位。 */
    withWatermarks(state) {
        const marks = { ...(state.revisionHighWatermarks ?? {}) };
        for (const entry of state.devices) {
            marks[entry.id] = Math.max(marks[entry.id] ?? entry.policyRevision, entry.policyRevision);
        }
        return { ...state, revisionHighWatermarks: marks };
    }
    assertWritable() {
        if (this.unconfirmed.size === 0)
            return;
        const ids = [...this.unconfirmed].join(', ');
        throw new DeviceStateError('recovery-required', `device authorization is unconfirmable for ${ids}; repair policyRevision before writing`);
    }
    mutate(fn) {
        return withFileLock(this.path, () => {
            // 锁内重读：并发的 CLI/另一个 hub 写者可能已经提交了更新。
            const current = this.load();
            this.assertWritable();
            const next = fn(current);
            if (next.state === current) {
                this.state = current;
                return next.result;
            }
            // 写入前再确认目标行没有被锁外修改成修订异常。
            this.assertWritable();
            const committed = this.withWatermarks(next.state);
            atomicWriteFile(this.path, serializeDevicesState(committed));
            this.state = committed;
            return next.result;
        });
    }
}
