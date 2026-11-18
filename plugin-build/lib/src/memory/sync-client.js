import { decryptRecord, encryptRecord, freshSalt, LEGACY_SALT, passphraseAcceptable, syncKey } from './sync-crypto.js';

function weakClient() {
    return { async sync() { const error = new Error('weak-passphrase'); error.code = 'weak-passphrase'; throw error; } };
}

export function createMemorySyncClient({ hubUrl, token, passphrase = process.env.DSH_MARSHAL_MEMORY_SYNC_KEY, deviceId, fetchImpl = fetch } = {}) {
    if (typeof passphrase !== 'string' || passphrase.trim() === '') return undefined;
    if (!passphraseAcceptable(passphrase)) return weakClient();
    if (typeof hubUrl !== 'string' || hubUrl === '' || typeof token !== 'string' || token === '') return undefined;
    let base;
    try {
        const url = new URL(hubUrl);
        base = (url.protocol === 'wss:' ? 'https:' : 'http:') + '//' + url.host;
    }
    catch { return undefined; }
    const legacyKey = syncKey(passphrase, LEGACY_SALT);
    const request = async (path, body) => {
        const response = await fetchImpl(base + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        if (!response.ok) {
            const error = new Error(data?.code ?? 'HTTP ' + response.status);
            error.code = data?.code ?? 'HTTP ' + response.status;
            error.payload = data;
            throw error;
        }
        return data;
    };
    const applyRemote = (store, scope, ownerId, envelopes, salt) => {
        let pulled = 0;
        const list = Array.isArray(envelopes) ? envelopes : [];
        for (const envelope of list.filter(item => item?.tombstone === true)) {
            store.applyTombstone(scope, ownerId, envelope);
            pulled++;
        }
        const key = typeof salt === 'string' && salt.length >= 8 ? syncKey(passphrase, salt) : undefined;
        for (const envelope of list.filter(item => item?.tombstone !== true)) {
            try {
                const selected = envelope?.kdf === 'legacy' || key === undefined ? legacyKey : key;
                if (selected === undefined) continue;
                const record = decryptRecord(selected, envelope);
                if (record !== null && typeof record === 'object') {
                    const applied = store.applyRemote(scope, ownerId, { ...record, id: record.id ?? envelope.id });
                    if (applied !== undefined) pulled++;
                }
            }
            catch { /* skip a record that another key produced */ }
        }
        return pulled;
    };
    return {
        async sync(store, scopes) {
            let pushed = 0;
            let pulled = 0;
            let salt;
            const seen = [];
            for (const { scope, ownerId } of scopes) {
                const remote = await request('/marshal/api/memory-sync/pull?scope=' + encodeURIComponent(scope) + '&ownerId=' + encodeURIComponent(ownerId) + '&since=0');
                if (typeof remote?.salt === 'string' && remote.salt.length >= 8) salt = remote.salt;
                pulled += applyRemote(store, scope, ownerId, remote?.records, salt);
                seen.push({ scope, ownerId });
            }
            if (salt === undefined) salt = freshSalt();
            const key = syncKey(passphrase, salt);
            if (key === undefined) throw Object.assign(new Error('weak-passphrase'), { code: 'weak-passphrase' });
            for (const { scope, ownerId } of seen) {
                const records = [
                    ...store.exportRecords(scope, ownerId).map(record => encryptRecord(key, record, 'scrypt')),
                    ...store.exportTombstones(scope, ownerId).map(tomb => ({
                        id: tomb.id, updatedAt: tomb.updatedAt, revision: tomb.updatedAt, tombstone: true,
                    })),
                ];
                if (records.length === 0 && salt === undefined) continue;
                let result;
                try {
                    result = await request('/marshal/api/memory-sync/push', { scope, ownerId, deviceId, records, salt });
                }
                catch (error) {
                    if (error.code !== 'salt-mismatch' || typeof error.payload?.salt !== 'string') throw error;
                    salt = error.payload.salt;
                    const retryKey = syncKey(passphrase, salt);
                    const retried = [
                        ...store.exportRecords(scope, ownerId).map(record => encryptRecord(retryKey, record, 'scrypt')),
                        ...store.exportTombstones(scope, ownerId).map(tomb => ({
                            id: tomb.id, updatedAt: tomb.updatedAt, revision: tomb.updatedAt, tombstone: true,
                        })),
                    ];
                    result = await request('/marshal/api/memory-sync/push', { scope, ownerId, deviceId, records: retried, salt });
                }
                pushed += Number(result?.accepted ?? 0);
                if (typeof result?.salt === 'string' && result.salt.length >= 8) salt = result.salt;
            }
            for (const { scope, ownerId } of seen) {
                const remote = await request('/marshal/api/memory-sync/pull?scope=' + encodeURIComponent(scope) + '&ownerId=' + encodeURIComponent(ownerId) + '&since=0');
                if (typeof remote?.salt === 'string' && remote.salt.length >= 8) salt = remote.salt;
                pulled += applyRemote(store, scope, ownerId, remote?.records, salt);
            }
            return { pushed, pulled };
        },
    };
}
