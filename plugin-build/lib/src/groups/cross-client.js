/**
 * Node-side HTTP client for the hub cross-device group ledger. The node never
 * holds groups locally for this mode; the hub owns membership and delivery.
 */
import { request as httpsRequest } from 'node:https';

function httpsJsonRequest(urlString, { method, headers, body, ca, signal }) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
        const req = httpsRequest({
            hostname: url.hostname,
            port: url.port ? Number(url.port) : 443,
            path: url.pathname + url.search,
            method,
            headers: {
                ...headers,
                ...(payload === undefined ? {} : { 'content-length': String(payload.length) }),
            },
            ca,
            rejectUnauthorized: true,
            signal,
        }, res => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
                res.resume();
                reject(new Error('unexpected redirect'));
                return;
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => {
                const status = res.statusCode ?? 0;
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({
                    ok: status >= 200 && status < 300,
                    status,
                    async json() { return JSON.parse(text); },
                });
            });
        });
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

export function createCrossClient({ hubUrl, token, ca, fetchImpl } = {}) {
    if (typeof hubUrl !== 'string' || hubUrl === '' || typeof token !== 'string' || token === '') return undefined;
    let base;
    try {
        const url = new URL(hubUrl);
        base = (url.protocol === 'wss:' ? 'https:' : 'http:') + '//' + url.host;
    }
    catch {
        return undefined;
    }
    const useHttpsCa = ca !== undefined && fetchImpl === undefined && base.startsWith('https://');
    const transport = fetchImpl ?? fetch;
    const request = async (path, body, signal) => {
        const method = body === undefined ? 'GET' : 'POST';
        const headers = {
            authorization: 'Bearer ' + token,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        };
        const serialized = body === undefined ? undefined : JSON.stringify(body);
        const response = useHttpsCa
            ? await httpsJsonRequest(base + path, { method, headers, body: serialized, ca, signal })
            : await transport(base + path, {
                method, signal, redirect: 'error', headers,
                ...(serialized === undefined ? {} : { body: serialized }),
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
