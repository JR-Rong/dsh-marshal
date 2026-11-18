import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { atomicWriteFile, withFileLock } from './state-file.js';

export const MEMORY_SYNC_MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_PUSH = 500;
const SALT_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function emptyState() {
    return { version: 2, accounts: {} };
}

function accountOf(device) {
    if (device === undefined || device === null || device.revoked === true) return undefined;
    if (typeof device.ownerId === 'string' && device.ownerId !== '') return device.ownerId;
    return undefined;
}

/** Unbound devices, including DeviceStore.add() rows with no ownerId, are isolated. */
export function accountOwnerForDevice(device) {
    return accountOf(device);
}

function knownScope(scope) {
    return scope === 'agent' || scope === 'workspace' || scope === 'global';
}

function bindingKey(scope, memoryOwnerId) {
    return scope + ':' + memoryOwnerId;
}

function recordKey(scope, memoryOwnerId, id) {
    return scope + ':' + memoryOwnerId + ':' + id;
}

function ensureAccount(state, accountOwner) {
    const current = state.accounts[accountOwner];
    if (current !== undefined && typeof current === 'object') {
        if (current.bindings === undefined || typeof current.bindings !== 'object') current.bindings = {};
        if (current.records === undefined || typeof current.records !== 'object') current.records = {};
        return current;
    }
    const created = { salt: null, bindings: {}, records: {} };
    state.accounts[accountOwner] = created;
    return created;
}

function claimLegacy(state, accountOwner) {
    if (typeof accountOwner !== 'string' || accountOwner === '' || accountOwner.startsWith('operator:')) {
        const error = new Error('owner-mismatch'); error.code = 'owner-mismatch'; throw error;
    }
    if (state.legacyRecords === undefined) return 0;
    if (state.legacyClaimedBy !== undefined && state.legacyClaimedBy !== accountOwner) {
        const error = new Error('owner-mismatch'); error.code = 'owner-mismatch'; throw error;
    }
    const bucket = ensureAccount(state, accountOwner);
    let migrated = 0;
    for (const record of Object.values(state.legacyRecords)) {
        if (record === null || typeof record !== 'object' || typeof record.id !== 'string') continue;
        if (!knownScope(record.scope)) continue;
        if (typeof record.ownerId !== 'string' || record.ownerId === '') continue;
        const key = recordKey(record.scope, record.ownerId, record.id);
        bucket.records[key] = { ...record, kdf: record.kdf === 'scrypt' ? 'scrypt' : 'legacy' };
        bucket.bindings[bindingKey(record.scope, record.ownerId)] = true;
        migrated++;
    }
    state.legacyClaimedBy = accountOwner;
    delete state.legacyRecords;
    return migrated;
}

function boundAccount(state, scope, memoryOwnerId) {
    const key = bindingKey(scope, memoryOwnerId);
    for (const [account, bucket] of Object.entries(state.accounts)) {
        if (bucket?.bindings?.[key] === true) return account;
    }
    return undefined;
}

function totalBytes(state) {
    let total = 0;
    for (const bucket of Object.values(state.accounts)) {
        for (const record of Object.values(bucket?.records ?? {})) total += String(record?.ciphertext ?? '').length;
    }
    return total;
}

function load(file) {
    if (!existsSync(file)) return emptyState();
    try { chmodSync(file, 0o600); } catch { /* tightened on the next successful write */ }
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
    catch { const error = new Error('memory-sync-corrupt'); error.code = 'memory-sync-corrupt'; throw error; }
    if (parsed !== null && typeof parsed === 'object' && parsed.version === 2 && parsed.accounts !== null && typeof parsed.accounts === 'object') {
        return parsed;
    }
    if (parsed !== null && typeof parsed === 'object' && parsed.records !== null && typeof parsed.records === 'object') {
        return { version: 2, accounts: {}, legacyRecords: parsed.records };
    }
    const error = new Error('memory-sync-corrupt');
    error.code = 'memory-sync-corrupt';
    throw error;
}

function save(file, state) {
    atomicWriteFile(file, JSON.stringify(state), 0o600);
}

/**
 * Opaque encrypted memory records. The hub never sees plaintext.
 * Records live in the authenticated device's account bucket. A memory owner
 * bound to one account cannot be read or written by another account.
 * Tombstones are permanent for an id: a later live record cannot resurrect it.
 */
export function createHubMemorySync({ file, now = Date.now, maxBytes = MEMORY_SYNC_MAX_BYTES } = {}) {
    const mutate = (fn) => withFileLock(file, () => {
        const state = load(file);
        const result = fn(state);
        if (result.write === true) save(file, state);
        return result.value;
    });
    const read = () => withFileLock(file, () => load(file));
    const push = ({ accountOwner, scope, memoryOwnerId, deviceId, records, salt }) => {
        if (typeof accountOwner !== 'string' || accountOwner === '') {
            const error = new Error('owner-mismatch'); error.code = 'owner-mismatch'; throw error;
        }
        if (!knownScope(scope)) {
            const error = new Error('invalid-args'); error.code = 'invalid-args'; throw error;
        }
        if (typeof memoryOwnerId !== 'string' || memoryOwnerId === '') {
            const error = new Error('invalid-args'); error.code = 'invalid-args'; throw error;
        }
        return mutate(state => {
            const bound = boundAccount(state, scope, memoryOwnerId);
            if (bound !== undefined && bound !== accountOwner) {
                const error = new Error('owner-mismatch'); error.code = 'owner-mismatch'; throw error;
            }
            const bucket = ensureAccount(state, accountOwner);
            if (salt !== undefined && salt !== null && salt !== '') {
                if (typeof salt !== 'string' || !SALT_PATTERN.test(salt)) {
                    const error = new Error('invalid-salt'); error.code = 'invalid-salt'; throw error;
                }
                if (typeof bucket.salt === 'string' && bucket.salt !== salt) {
                    const error = new Error('salt-mismatch'); error.code = 'salt-mismatch'; error.salt = bucket.salt; throw error;
                }
            }
            const incoming = Array.isArray(records) ? records.slice(0, MAX_PUSH) : [];
            let extra = 0;
            for (const record of incoming) {
                if (record === null || typeof record !== 'object' || typeof record.id !== 'string' || record.id === '') continue;
                if (record.tombstone === true) continue;
                const ciphertext = String(record.ciphertext ?? '');
                if (ciphertext.length > MAX_RECORD_BYTES) {
                    const error = new Error('size-limit'); error.code = 'size-limit'; throw error;
                }
                const prior = bucket.records[recordKey(scope, memoryOwnerId, record.id)];
                extra += ciphertext.length - String(prior?.ciphertext ?? '').length;
            }
            if (totalBytes(state) + extra > maxBytes) {
                const error = new Error('size-limit'); error.code = 'size-limit'; throw error;
            }
            let accepted = 0;
            for (const record of incoming) {
                if (record === null || typeof record !== 'object' || typeof record.id !== 'string' || record.id === '') continue;
                const key = recordKey(scope, memoryOwnerId, record.id);
                const prior = bucket.records[key];
                if (prior?.tombstone === true) continue;
                if (record.tombstone === true) {
                    bucket.records[key] = {
                        scope, ownerId: memoryOwnerId, id: record.id, deviceId: String(deviceId ?? ''),
                        revision: Number(record.revision ?? record.updatedAt ?? now()),
                        updatedAt: Number(record.updatedAt ?? now()),
                        tombstone: true, kdf: 'tombstone', nonce: '', tag: '', ciphertext: '',
                        contentHash: typeof record.contentHash === 'string' ? record.contentHash : '',
                        normHash: typeof record.normHash === 'string' ? record.normHash : '',
                    };
                    accepted++;
                    continue;
                }
                if (typeof record.nonce !== 'string' || typeof record.tag !== 'string' || typeof record.ciphertext !== 'string' || record.ciphertext === '') continue;
                if (prior !== undefined && Number(prior.revision) >= Number(record.revision) && Number(prior.updatedAt) >= Number(record.updatedAt)) continue;
                bucket.records[key] = {
                    scope, ownerId: memoryOwnerId, id: record.id, deviceId: String(deviceId ?? ''),
                    revision: Number(record.revision ?? 0), updatedAt: Number(record.updatedAt ?? now()),
                    nonce: String(record.nonce), tag: String(record.tag), ciphertext: String(record.ciphertext),
                    kdf: record.kdf === 'legacy' ? 'legacy' : 'scrypt',
                    tombstone: false,
                };
                accepted++;
            }
            if (accepted > 0) {
                bucket.bindings[bindingKey(scope, memoryOwnerId)] = true;
                if (typeof salt === 'string' && SALT_PATTERN.test(salt) && bucket.salt == null) bucket.salt = salt;
            }
            return { write: true, value: { accepted, salt: bucket.salt ?? null } };
        });
    };
    const pull = ({ accountOwner, scope, memoryOwnerId, since = 0 }) => {
        if (typeof accountOwner !== 'string' || accountOwner === '') {
            const error = new Error('owner-mismatch'); error.code = 'owner-mismatch'; throw error;
        }
        if (!knownScope(scope)) {
            const error = new Error('invalid-args'); error.code = 'invalid-args'; throw error;
        }
        return mutate(state => {
            const bound = boundAccount(state, scope, memoryOwnerId);
            if (bound !== undefined && bound !== accountOwner) {
                const error = new Error('owner-mismatch'); error.code = 'owner-mismatch'; throw error;
            }
            const bucket = state.accounts[accountOwner];
            const records = bucket === undefined ? [] : Object.values(bucket.records)
                .filter(record => record.scope === scope && record.ownerId === memoryOwnerId && Number(record.updatedAt) > Number(since))
                .sort((a, b) => a.updatedAt - b.updatedAt)
                .slice(0, MAX_PUSH);
            return { write: false, value: { records, salt: bucket?.salt ?? null } };
        });
    };
    /** Explicit migration. Push and pull never claim leftover v1 records. */
    const migrateLegacy = (accountOwner) => mutate(state => {
        const migrated = claimLegacy(state, accountOwner);
        return { write: migrated > 0, value: { migrated } };
    });
    return { push, pull, migrateLegacy, read, file, maxBytes };
}

function readBody(req, limit) {
    return (async () => {
        const chunks = [];
        let total = 0;
        for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.length;
            if (total > limit) {
                const error = new Error('size-limit'); error.code = 'size-limit'; throw error;
            }
            chunks.push(buffer);
        }
        if (total === 0) return {};
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    })();
}

function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

function fail(res, error) {
    const code = error?.code === 'owner-mismatch' ? 'owner-mismatch'
        : error?.code === 'size-limit' ? 'size-limit'
            : error?.code === 'salt-mismatch' ? 'salt-mismatch'
                : error?.code === 'invalid-salt' ? 'invalid-salt'
                    : error?.code === 'memory-sync-corrupt' ? 'memory-sync-corrupt'
                        : 'invalid-args';
    const status = code === 'owner-mismatch' ? 403 : code === 'size-limit' ? 413 : code === 'salt-mismatch' ? 409 : code === 'memory-sync-corrupt' ? 500 : 400;
    send(res, status, { ok: false, code, ...(error?.salt === undefined ? {} : { salt: error.salt }) });
}

/**
 * Device bearer only. The account comes from the device record, never from the body.
 */
export async function handleMemorySyncPush(req, res, { memorySync, deviceFromRequest, operatorId }) {
    if (memorySync === undefined) { send(res, 503, { ok: false, code: 'memory-sync-unavailable' }); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' }).end(); return; }
    const device = deviceFromRequest(req);
    const accountOwner = accountOwnerForDevice(device);
    if (device === undefined || accountOwner === undefined) { send(res, 401, { ok: false, code: 'unauthorized' }); return; }
    let body;
    try { body = await readBody(req, 512 * 1024); }
    catch (error) { fail(res, error?.code === 'size-limit' ? error : Object.assign(new Error('invalid-args'), { code: 'invalid-args' })); return; }
    const scope = body?.scope === 'workspace' ? 'workspace' : body?.scope === 'agent' ? 'agent' : body?.scope === 'global' ? 'global' : undefined;
    const memoryOwnerId = typeof body?.ownerId === 'string' ? body.ownerId : '';
    if (scope === undefined || memoryOwnerId === '') { send(res, 400, { ok: false, code: 'invalid-args' }); return; }
    try {
        const result = memorySync.push({
            accountOwner, scope, memoryOwnerId, deviceId: device.id,
            records: body.records, salt: body.salt,
        });
        send(res, 200, { ok: true, accepted: result.accepted, salt: result.salt });
    }
    catch (error) { fail(res, error); }
}

export function handleMemorySyncPull(req, res, { memorySync, deviceFromRequest, operatorId }) {
    if (memorySync === undefined) { send(res, 503, { ok: false, code: 'memory-sync-unavailable' }); return; }
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' }).end(); return; }
    const device = deviceFromRequest(req);
    const accountOwner = accountOwnerForDevice(device);
    if (device === undefined || accountOwner === undefined) { send(res, 401, { ok: false, code: 'unauthorized' }); return; }
    let url;
    try { url = new URL(req.url ?? '/', 'http://localhost'); }
    catch { send(res, 400, { ok: false, code: 'invalid-args' }); return; }
    const requested = url.searchParams.get('scope');
    const scope = requested === 'workspace' ? 'workspace' : requested === 'agent' ? 'agent' : requested === 'global' ? 'global' : undefined;
    const memoryOwnerId = url.searchParams.get('ownerId') ?? '';
    if (scope === undefined || memoryOwnerId === '') { send(res, 400, { ok: false, code: 'invalid-args' }); return; }
    const since = Number(url.searchParams.get('since')) || 0;
    try {
        const result = memorySync.pull({ accountOwner, scope, memoryOwnerId, since });
        send(res, 200, { ok: true, records: result.records, salt: result.salt });
    }
    catch (error) { fail(res, error); }
}
