import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Opaque encrypted memory records. The hub never sees plaintext. */
export function createHubMemorySync({ file, now = Date.now } = {}) {
    let state = { version: 1, records: {} };
    try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first run */ }
    if (state === null || typeof state !== 'object' || typeof state.records !== 'object') state = { version: 1, records: {} };
    const save = () => {
        const temp = file + '.tmp-' + process.pid + '-' + now();
        writeFileSync(temp, JSON.stringify(state));
        renameSync(temp, file);
    };
    const key = (scope, ownerId, id) => scope + ':' + ownerId + ':' + id;
    const push = (scope, ownerId, deviceId, records) => {
        let changed = 0;
        for (const record of Array.isArray(records) ? records.slice(0, 500) : []) {
            if (record === null || typeof record !== 'object' || typeof record.id !== 'string') continue;
            const id = key(scope, ownerId, record.id);
            const prior = state.records[id];
            if (prior !== undefined && Number(prior.revision) >= Number(record.revision) && Number(prior.updatedAt) >= Number(record.updatedAt)) continue;
            state.records[id] = {
                scope, ownerId, id: record.id, deviceId: String(deviceId ?? ''),
                revision: Number(record.revision ?? 0), updatedAt: Number(record.updatedAt ?? now()),
                nonce: String(record.nonce ?? ''), tag: String(record.tag ?? ''), ciphertext: String(record.ciphertext ?? ''),
            };
            changed++;
        }
        if (changed > 0) save();
        return changed;
    };
    const pull = (scope, ownerId, since = 0) => Object.values(state.records)
        .filter(record => record.scope === scope && record.ownerId === ownerId && Number(record.updatedAt) > Number(since))
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, 500);
    return { push, pull, file };
}
