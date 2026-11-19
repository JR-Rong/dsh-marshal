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
    const request = async (path, body, signal) => {
        const response = await fetchImpl(base + path, {
            method: body === undefined ? 'GET' : 'POST', signal, redirect: 'error',
            headers: {
                authorization: 'Bearer ' + token,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        if (!response.ok) {
            const taskRoomErrors = { 401: 'unauthorized', 403: 'forbidden', 404: 'task-room-not-found' };
            const fallback = path === '/marshal/api/task-rooms' ? taskRoomErrors[response.status] : undefined;
            const code = typeof data?.code === 'string' ? data.code : fallback ?? ('HTTP ' + response.status);
            throw Object.assign(new Error(data?.message ?? code), { code, status: response.status });
        }
        return data;
    };
    return {
        taskRoom(input) {
            const url = new URL(base);
            if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
                throw Object.assign(new Error('跨设备工单归档需要受信任的 HTTPS Hub。'), { code: 'task-room-hub-transport' });
            }
            return request('/marshal/api/task-rooms', input, AbortSignal.timeout(input.action === 'turn' ? 126_000 : 15_000));
        },
        state: () => request('/marshal/api/cross-groups/state'),
        catalog: () => request('/marshal/api/cross-groups/catalog'),
        create: (input) => request('/marshal/api/cross-groups/create', input),
        send: (input) => request('/marshal/api/cross-groups/send', input),
    };
}
