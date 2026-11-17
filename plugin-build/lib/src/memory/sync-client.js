import { decryptRecord, encryptRecord, syncKey } from './sync-crypto.js';

export function createMemorySyncClient({ hubUrl, token, passphrase = process.env.DSH_MARSHAL_MEMORY_SYNC_KEY, deviceId, fetchImpl = fetch } = {}) {
    const key = syncKey(passphrase);
    if (key === undefined || typeof hubUrl !== 'string' || hubUrl === '' || typeof token !== 'string' || token === '') return undefined;
    let base;
    try {
        const url = new URL(hubUrl);
        base = (url.protocol === 'wss:' ? 'https:' : 'http:') + '//' + url.host;
    }
    catch { return undefined; }
    const request = async (path, body) => {
        const response = await fetchImpl(base + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        if (!response.ok) throw new Error(data?.code ?? 'HTTP ' + response.status);
        return data;
    };
    return {
        async sync(store, scopes) {
            let pushed = 0;
            let pulled = 0;
            for (const { scope, ownerId } of scopes) {
                const local = store.exportRecords(scope, ownerId);
                const records = local.map(record => encryptRecord(key, record));
                if (records.length > 0) {
                    const result = await request('/marshal/api/memory-sync/push', { scope, ownerId, deviceId, records });
                    pushed += Number(result?.accepted ?? 0);
                }
                const remote = await request('/marshal/api/memory-sync/pull?scope=' + encodeURIComponent(scope) + '&ownerId=' + encodeURIComponent(ownerId) + '&since=0');
                for (const envelope of Array.isArray(remote?.records) ? remote.records : []) {
                    try {
                        const record = decryptRecord(key, envelope);
                        if (record !== null && typeof record === 'object') { store.applyRemote(scope, ownerId, record); pulled++; }
                    }
                    catch { /* skip a record that another key produced */ }
                }
            }
            return { pushed, pulled };
        },
    };
}
