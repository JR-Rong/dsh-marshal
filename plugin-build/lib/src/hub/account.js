import { createHash, randomBytes } from 'node:crypto';
export const DSH_ACCOUNT_ORIGIN = 'https://platform.deepseek.com';
export function dshAccountHash(id) {
    return createHash('sha256').update(DSH_ACCOUNT_ORIGIN + '|' + id).digest('hex');
}
export class AccountLoginError extends Error {
    code;
    constructor(code) {
        super('marshal: ' + code);
        this.code = code;
    }
}
/** The private Hub has one owner account. Never trust a client-supplied UID or URL. */
export function createAccountLogin(ownerHash, options = {}) {
    if (!/^[a-f0-9]{64}$/.test(ownerHash))
        throw new Error('marshal: invalid account owner hash');
    const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now;
    const tickets = new Map();
    let pending = 0, closed = false;
    const purge = () => { for (const [key, item] of tickets)
        if (item.expiresAt <= now())
            tickets.delete(key); };
    return {
        async exchange(grant) {
            purge();
            if (closed)
                throw new AccountLoginError('account-unavailable');
            if (!grant || grant.length > 8192 || /[\x00-\x20\x7f]/.test(grant))
                throw new AccountLoginError('account-required');
            if (pending >= 4 || tickets.size + pending >= 128)
                throw new AccountLoginError('rate-limited');
            pending++;
            try {
                const response = await fetcher(DSH_ACCOUNT_ORIGIN + '/auth-api/v0/users/current', {
                    redirect: 'error', signal: AbortSignal.timeout(8000), headers: {
                        'x-dsh-auth-token': grant, 'x-client-platform': 'web', 'x-client-bundle-id': '',
                        'x-client-version': 'dsh-marshal', 'x-client-locale': 'zh_CN', 'x-client-timezone-offset': '0',
                    },
                });
                if (!response.ok || !response.body) {
                    await response.body?.cancel();
                    throw new AccountLoginError(response.status === 401 ? 'account-required' : 'account-unavailable');
                }
                const chunks = [];
                let size = 0;
                const reader = response.body.getReader();
                try {
                    for (;;) {
                        const next = await reader.read();
                        if (next.done)
                            break;
                        size += next.value.byteLength;
                        if (size > 65536)
                            throw new AccountLoginError('account-unavailable');
                        chunks.push(next.value);
                    }
                }
                finally {
                    await reader.cancel().catch(() => { });
                }
                const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (payload?.code !== 0 || payload?.data?.biz_code !== 0)
                    throw new AccountLoginError('account-required');
                const user = payload.data.biz_data;
                if (typeof user?.id !== 'string' || !user.id || user.id.length > 256)
                    throw new AccountLoginError('account-unavailable');
                const accountHash = dshAccountHash(user.id);
                if (accountHash !== ownerHash)
                    throw new AccountLoginError('account-mismatch');
                if (closed)
                    throw new AccountLoginError('account-unavailable');
                const name = typeof user.id_profile?.name === 'string'
                    ? user.id_profile.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : 'DSH 用户';
                const ticket = randomBytes(32).toString('base64url'), expiresAt = now() + 60_000;
                tickets.set(ticket, { identity: { accountHash, name }, expiresAt });
                return { ticket, expiresAt };
            }
            catch (error) {
                // Provider exceptions and response bodies may contain secrets; never forward them.
                throw error instanceof AccountLoginError ? error : new AccountLoginError('account-unavailable');
            }
            finally {
                pending--;
            }
        },
        consume(ticket) {
            purge();
            const found = tickets.get(ticket);
            tickets.delete(ticket);
            return closed ? undefined : found?.identity;
        },
        dispose() { closed = true; tickets.clear(); },
    };
}
