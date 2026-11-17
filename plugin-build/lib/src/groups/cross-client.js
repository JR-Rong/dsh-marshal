/**
 * Node-side HTTP client for the hub cross-device group ledger. The node never
 * holds groups locally for this mode; the hub owns membership and delivery.
 */
export function createCrossClient({ hubUrl, token, fetchImpl = fetch } = {}) {
    if (typeof hubUrl !== 'string' || hubUrl === '' || typeof token !== 'string' || token === '') return undefined;
    let base;
    try {
        const url = new URL(hubUrl);
        base = (url.protocol === 'wss:' ? 'https:' : 'http:') + '//' + url.host;
    }
    catch {
        return undefined;
    }
    const request = async (path, body) => {
        const response = await fetchImpl(base + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                authorization: 'Bearer ' + token,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        if (!response.ok) {
            const code = data !== null && typeof data === 'object' && typeof data.code === 'string' ? data.code : 'HTTP ' + response.status;
            throw new Error(code);
        }
        return data;
    };
    return {
        state: () => request('/marshal/api/cross-groups/state'),
        catalog: () => request('/marshal/api/cross-groups/catalog'),
        create: (input) => request('/marshal/api/cross-groups/create', input),
        send: (input) => request('/marshal/api/cross-groups/send', input),
    };
}
