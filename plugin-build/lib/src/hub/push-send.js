import { createSign, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
const seen = new Map();
const sentAt = new Map();
function b64url(value) {
    return Buffer.from(value).toString('base64url');
}
function readKey(path) {
    if (!path || path.includes('PLACEHOLDER'))
        return undefined;
    try {
        const text = readFileSync(path, 'utf8');
        return text.trim() ? text : undefined;
    }
    catch {
        return undefined;
    }
}
function allowSend(deviceId, dedupeKey, now) {
    const last = seen.get(deviceId + '|' + dedupeKey);
    if (last !== undefined && now - last < 30_000)
        return 'duplicate';
    const recent = (sentAt.get(deviceId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= 8)
        return 'rate-limited';
    recent.push(now);
    sentAt.set(deviceId, recent);
    seen.set(deviceId + '|' + dedupeKey, now);
    return undefined;
}
export async function deliverPush(input) {
    const now = input.now ?? Date.now();
    const blocked = allowSend(input.deviceId, input.notice.dedupeKey, now);
    if (blocked)
        return { delivered: false, reason: blocked };
    const block = input.config?.[input.target.provider];
    if (!block)
        return { delivered: false, reason: 'unconfigured' };
    if (input.target.provider === 'apns') {
        const key = readKey(input.config?.apns?.keyPath);
        const keyId = input.config?.apns?.keyId;
        const teamId = input.config?.apns?.teamId;
        if (!key || !keyId || !teamId || keyId.includes('PLACEHOLDER'))
            return { delivered: false, reason: 'key-unreadable' };
        const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
        const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
        const signer = createSign('SHA256');
        signer.update(header + '.' + claims);
        let jwt = header + '.' + claims + '.';
        try {
            jwt += signer.sign(key).toString('base64url');
        }
        catch {
            return { delivered: false, reason: 'key-unreadable' };
        }
        const status = await postApns(input.target.token, jwt, input.config?.apns?.bundleId ?? '', input.notice);
        return status >= 200 && status < 300
            ? { delivered: true, reason: 'sent' }
            : { delivered: false, reason: 'provider-' + status };
    }
    const fetcher = input.fetchImpl ?? fetch;
    if (input.target.provider === 'fcm')
        return deliverFcm(input.config?.fcm, input.target, input.notice, now, fetcher);
    return deliverHuawei(input.config?.huawei, input.target, input.notice, fetcher);
}
async function deliverFcm(config, target, notice, now, fetcher) {
    const key = readKey(config?.privateKeyPath);
    const email = config?.clientEmail;
    const project = config?.projectId;
    if (!key || !email || !project || email.includes('PLACEHOLDER') || project.includes('PLACEHOLDER')) {
        return { delivered: false, reason: 'key-unreadable' };
    }
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
        iss: email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 3600,
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(header + '.' + claims);
    let assertion = header + '.' + claims + '.';
    try {
        assertion += signer.sign(key).toString('base64url');
    }
    catch {
        return { delivered: false, reason: 'key-unreadable' };
    }
    try {
        const tokenResponse = await fetcher('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(assertion),
        });
        if (!tokenResponse.ok)
            return { delivered: false, reason: 'provider-' + tokenResponse.status };
        const tokenBody = await tokenResponse.json();
        if (!tokenBody.access_token)
            return { delivered: false, reason: 'provider-rejected' };
        const send = await fetcher('https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(project) + '/messages:send', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + tokenBody.access_token, 'content-type': 'application/json' },
            body: JSON.stringify({ message: { token: target.token, notification: { title: notice.title, body: notice.body } } }),
        });
        return send.ok ? { delivered: true, reason: 'sent' } : { delivered: false, reason: 'provider-' + send.status };
    }
    catch {
        return { delivered: false, reason: 'network' };
    }
}
async function deliverHuawei(config, target, notice, fetcher) {
    const secret = readKey(config?.clientSecretPath);
    const clientId = config?.clientId;
    const appId = config?.appId;
    if (!secret || !clientId || !appId || clientId.includes('PLACEHOLDER') || appId.includes('PLACEHOLDER')) {
        return { delivered: false, reason: 'key-unreadable' };
    }
    try {
        const tokenResponse = await fetcher('https://oauth-login.cloud.huawei.com/oauth2/v3/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(clientId) + '&client_secret=' + encodeURIComponent(secret),
        });
        if (!tokenResponse.ok)
            return { delivered: false, reason: 'provider-' + tokenResponse.status };
        const tokenBody = await tokenResponse.json();
        if (!tokenBody.access_token)
            return { delivered: false, reason: 'provider-rejected' };
        const send = await fetcher('https://push-api.cloud.huawei.com/v1/' + encodeURIComponent(appId) + '/messages:send', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + tokenBody.access_token, 'content-type': 'application/json' },
            body: JSON.stringify({
                validate_only: false,
                message: {
                    token: [target.token],
                    notification: { title: notice.title, body: notice.body },
                    android: target.liveToken
                        ? { notification: { foreground_show: true, importance: 'NORMAL' }, category: 'CATEGORY_PROGRESS' }
                        : { notification: { foreground_show: true } },
                },
            }),
        });
        return send.ok ? { delivered: true, reason: 'sent' } : { delivered: false, reason: 'provider-' + send.status };
    }
    catch {
        return { delivered: false, reason: 'network' };
    }
}
function postApns(token, jwt, bundleId, notice) {
    return new Promise((resolve) => {
        const client = http2.connect('https://api.push.apple.com');
        client.on('error', () => { client.close(); resolve(0); });
        const req = client.request({
            ':method': 'POST',
            ':path': '/3/device/' + token,
            authorization: 'bearer ' + jwt,
            'apns-topic': notice.kind === 'run-start' || notice.kind === 'run-finish' ? bundleId + '.push-type.liveactivity' : bundleId,
            'apns-push-type': notice.kind === 'run-start' || notice.kind === 'run-finish' ? 'liveactivity' : 'alert',
        });
        req.on('response', (headers) => {
            const status = Number(headers[':status'] ?? 0);
            client.close();
            resolve(status);
        });
        req.on('error', () => { client.close(); resolve(0); });
        req.end(JSON.stringify({ aps: { alert: { title: notice.title, body: notice.body } } }));
    });
}
export function noticeForEvent(kind, payload, watched) {
    const record = typeof payload === 'object' && payload !== null ? payload : {};
    const sessionKey = [record.deviceId, record.agent, record.sessionId].every((part) => typeof part === 'string')
        ? String(record.deviceId) + '|' + String(record.agent) + '|' + String(record.sessionId)
        : '';
    if (kind === 'input.requested') {
        const approval = typeof record.approval === 'object' && record.approval !== null;
        const id = typeof record.requestId === 'string' ? record.requestId : randomBytes(4).toString('hex');
        return {
            kind: approval ? 'approval' : 'question',
            title: approval ? '需要审批' : '需要回答',
            body: approval ? '只允许这一次' : '有一条提问',
            dedupeKey: (approval ? 'approval:' : 'question:') + id,
        };
    }
    if ((kind === 'turn.started' || kind === 'turn.completed') && sessionKey && watched.has(sessionKey)) {
        return {
            kind: kind === 'turn.started' ? 'run-start' : 'run-finish',
            title: kind === 'turn.started' ? '开始运行' : '运行结束',
            body: sessionKey,
            dedupeKey: kind + ':' + sessionKey,
        };
    }
    return null;
}
