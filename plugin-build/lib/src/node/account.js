import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { dshAccountHash, DSH_ACCOUNT_ORIGIN } from "../hub/account.js";
const CODES = new Set(['account-required', 'account-mismatch', 'account-unavailable', 'rate-limited', 'revoked', 'duplicate-id', 'invalid', 'hub-not-configured', 'pairing-unavailable']);
const fail = (code = 'account-unavailable') => new Error(code);
function resolveHubOrigin(config) {
    const raw = config.hubUrl ?? config.publicOrigin;
    if (!raw)
        throw fail('hub-not-configured');
    const url = new URL(raw);
    url.protocol = 'https:';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.origin;
}
function hubJsonPost(config, pathname, body, extraHeaders = {}, maxBytes = 16_384) {
    const origin = resolveHubOrigin(config);
    const url = new URL(pathname, origin);
    const ca = config.hubCaFile === undefined ? undefined : readFileSync(config.hubCaFile);
    return new Promise((resolve, reject) => {
        const req = request(url, { method: 'POST', rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }),
            headers: { 'content-type': 'application/json', ...extraHeaders } }, res => {
            const chunks = [];
            let size = 0;
            res.on('data', data => {
                size += data.length;
                if (size > maxBytes) {
                    res.destroy();
                    reject(fail());
                    return;
                }
                chunks.push(data);
            });
            res.on('error', () => reject(fail()));
            res.on('end', () => {
                let data = {};
                try {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (text)
                        data = JSON.parse(text);
                }
                catch {
                    data = {};
                }
                const rawSetCookie = res.headers['set-cookie'];
                const setCookies = Array.isArray(rawSetCookie) ? rawSetCookie : (typeof rawSetCookie === 'string' ? [rawSetCookie] : []);
                resolve({ statusCode: res.statusCode ?? 0, data, setCookies });
            });
        });
        req.setTimeout(12_000, () => { req.destroy(); reject(fail()); });
        req.on('error', () => reject(fail()));
        req.end(JSON.stringify(body));
    });
}
export function accountCloudRequest(config, path, body) {
    return hubJsonPost(config, '/marshal/account/' + path, body).then(({ statusCode, data }) => {
        if (statusCode !== 200 || !data.ok)
            throw fail(CODES.has(data.code) ? data.code : undefined);
        return data;
    });
}
async function readSmallJsonBody(req, limit = 4096) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > limit)
            throw fail('invalid');
        chunks.push(buf);
    }
    if (size === 0)
        return {};
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        throw fail('invalid');
    }
}
/** Native dsh-app requests are proxied over loopback without an Origin header.
 * The non-simple header and refusal of OPTIONS prevent cross-site browser calls. */
export function isDesktopRequest(req, origin, header) {
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
        && req.method === 'POST' && req.headers[header] === '1'
        && (req.headers.origin === undefined || req.headers.origin === 'dsh-app://app' || req.headers.origin === origin);
}
export function mountAccountConnection(ctx, config, deps = {}) {
    if (!config.accountLogin)
        return;
    const postHub = deps.hubPost ?? hubJsonPost;
    ctx.inject(['webServer', 'deepseekAccount'], scoped => {
        for (const action of ['status', 'login', 'pairing'])
            scoped.effect(() => scoped.webServer.register({
                kind: 'exact', path: '/marshal/account/' + action,
                async handler(req, res) {
                    const json = (status, data) => {
                        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
                        res.end(JSON.stringify(data));
                    };
                    if (!isDesktopRequest(req, scoped.webServer.getOrigin(), 'x-marshal-account')) {
                        json(403, { ok: false, code: 'forbidden' });
                        return;
                    }
                    let observedHash = null;
                    try {
                        const body = action === 'pairing' ? await readSmallJsonBody(req) : {};
                        const account = scoped.deepseekAccount;
                        const session = await account.getPlatformSession();
                        if (!session || !session.userId) {
                            json(200, { ok: false, code: 'account-required', accountHash: null });
                            return;
                        }
                        if (session.origin !== DSH_ACCOUNT_ORIGIN)
                            throw fail('account-mismatch');
                        const accountHash = dshAccountHash(session.userId);
                        observedHash = accountHash;
                        if (action === 'status') {
                            json(200, { ok: true, accountHash });
                            return;
                        }
                        const exchangeRes = await postHub(config, '/marshal/account/exchange', { grant: session.token });
                        if (exchangeRes.statusCode !== 200 || !exchangeRes.data.ok)
                            throw fail(CODES.has(exchangeRes.data.code) ? exchangeRes.data.code : undefined);
                        const result = exchangeRes.data;
                        if (typeof result.ticket !== 'string' || !/^[\w-]{43}$/.test(result.ticket) || typeof result.expiresAt !== 'number')
                            throw fail();
                        const current = await account.getPlatformSession();
                        if (!current || current.origin !== session.origin || current.token !== session.token || current.userId !== session.userId)
                            throw fail('account-required');
                        if (action === 'login') {
                            json(200, { ok: true, accountHash, ticket: result.ticket, expiresAt: result.expiresAt });
                            return;
                        }
                        const hubOrigin = resolveHubOrigin(config);
                        const loginRes = await postHub(config, '/marshal/login', { ticket: result.ticket }, { origin: hubOrigin });
                        const cookieHeader = loginRes.setCookies.map(item => item.split(';')[0]?.trim()).filter(Boolean).join('; ');
                        if (loginRes.statusCode !== 200 || !loginRes.data.ok || typeof loginRes.data.csrf !== 'string' || !cookieHeader)
                            throw fail(loginRes.statusCode === 429 ? 'rate-limited' : 'pairing-unavailable');
                        const authHeaders = { origin: hubOrigin, cookie: cookieHeader, 'x-marshal-csrf': loginRes.data.csrf };
                        try {
                            const replace = typeof body.replace === 'string' && body.replace.length > 0 && body.replace.length <= 128 ? body.replace : undefined;
                            const pairRes = await postHub(config, '/marshal/api/pairing', replace ? { replace } : {}, authHeaders, 65_536);
                            const pair = pairRes.data;
                            if (pairRes.statusCode !== 200 || !pair.ok || typeof pair.url !== 'string' || !pair.url.startsWith('marshal://pair?') || typeof pair.code !== 'string' || typeof pair.expiresAt !== 'number' || typeof pair.svg !== 'string')
                                throw fail(pairRes.statusCode === 429 ? 'rate-limited' : 'pairing-unavailable');
                            json(200, { ok: true, accountHash, hubUrl: hubOrigin, code: pair.code, url: pair.url, expiresAt: pair.expiresAt, svg: pair.svg });
                        }
                        finally {
                            await postHub(config, '/marshal/logout', {}, authHeaders).catch(() => {});
                        }
                    }
                    catch (error) {
                        json(503, { ok: false, accountHash: observedHash, code: error instanceof Error && CODES.has(error.message) ? error.message : 'account-unavailable' });
                    }
                },
            }), 'marshal: DSH account ' + action);
    });
}
