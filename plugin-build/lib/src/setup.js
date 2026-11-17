import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { atomicWriteFile, readTextIfExists } from "./hub/state-file.js";
import { parseConfig } from "./config.js";
import { createAccountLogin, dshAccountHash, DSH_ACCOUNT_ORIGIN } from "./hub/account.js";
import { accountCloudRequest, isDesktopRequest } from "./node/account.js";
export const DEFAULT_HUB_ORIGIN = 'https://hub.example.com';
export function parseSetupChoice(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw Error('invalid-args');
    const data = raw;
    if (Object.keys(data).some(k => !['role', 'origin', 'name', 'shareContent'].includes(k)) || (data.role !== 'node' && data.role !== 'hub')
        || typeof data.origin !== 'string' || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80 || /[\x00-\x1f\x7f]/.test(data.name)
        || typeof data.shareContent !== 'boolean')
        throw Error('invalid-args');
    const url = new URL(data.origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
        throw Error('invalid-args');
    return { role: data.role, origin: url.origin, name: data.name.trim(), shareContent: data.shareContent };
}
export class SetupStore {
    file;
    constructor(file = join(homedir(), '.dsh-marshal', 'desktop-setup.json')) {
        this.file = file;
    }
    read() {
        const text = readTextIfExists(this.file);
        if (text === undefined)
            return;
        const state = JSON.parse(text);
        if (state.version !== 1 || !/^[a-f0-9-]{36}$/.test(state.installationId) || !/^[\w-]{43}$/.test(state.token))
            throw Error('recovery-required');
        if (state.choice)
            parseSetupChoice(state.choice);
        if (state.config)
            parseConfig(state.config, hostname());
        return state;
    }
    choose(choice) {
        const state = this.read() ?? { version: 1, installationId: randomUUID(), token: randomBytes(32).toString('base64url') };
        if (state.config)
            throw Error('already-configured');
        const next = { ...state, choice };
        this.write(next);
        return next;
    }
    write(state) { atomicWriteFile(this.file, JSON.stringify(state, null, 2) + '\n'); }
}
/** Empty bundles start in setup mode. Explicit existing configs retain precedence. */
export function mountSetup(ctx, raw, activate, store = new SetupStore()) {
    const explicit = !!raw && typeof raw === 'object' && 'role' in raw;
    let state = explicit ? undefined : store.read();
    let config = explicit ? parseConfig(raw, hostname()) : state?.config;
    let busy = false, closed = false, code = '', started = false, starting = false;
    const start = async () => {
        if (!config || started || starting || closed)
            return;
        starting = true;
        let fiber;
        try {
            if (ctx.plugin) {
                fiber = ctx.plugin({ name: 'marshal-configured-runtime', apply: activate }, config);
                await fiber;
                if (fiber.state !== undefined && fiber.state !== 2)
                    throw Error('runtime-unavailable');
            }
            else
                activate(ctx, config);
            started = true;
            code = '';
        }
        catch {
            try {
                await fiber?.dispose();
            }
            catch { }
            started = false;
            code = 'runtime-unavailable';
        }
        finally {
            starting = false;
        }
    };
    // Existing integrations without child-plugin support keep their synchronous startup contract.
    if (config && !ctx.plugin) {
        activate(ctx, config);
        started = true;
    }
    else
        void start();
    ctx.inject(['webServer', 'deepseekAccount'], scoped => {
        const complete = async () => {
            if (busy || closed)
                return;
            if (config) {
                await start();
                return;
            }
            if (!state?.choice)
                return;
            busy = true;
            try {
                const account = await scoped.deepseekAccount.getPlatformSession();
                if (!account?.userId) {
                    code = 'account-required';
                    return;
                }
                if (account.origin !== DSH_ACCOUNT_ORIGIN)
                    throw Error('account-mismatch');
                const choice = state.choice, owner = dshAccountHash(account.userId);
                let next;
                if (choice.role === 'node') {
                    const enrolled = await accountCloudRequest({ hubUrl: choice.origin }, 'enroll', {
                        grant: account.token, installationId: state.installationId,
                        tokenDigest: createHash('sha256').update(state.token).digest('hex'), name: choice.name, shareContent: choice.shareContent,
                    });
                    if (enrolled.accountHash !== owner || typeof enrolled.deviceId !== 'string' || !/^account-[a-f0-9]{32}$/.test(enrolled.deviceId))
                        throw Error('account-mismatch');
                    next = parseConfig({ role: 'node', hubUrl: choice.origin.replace('https:', 'wss:') + '/marshal/uplink',
                        deviceId: enrolled.deviceId, token: state.token, deviceName: choice.name, accountLogin: true,
                        privacy: choice.shareContent ? 'content' : 'metadata', allowDiscussion: choice.shareContent,
                        agents: ['dsh', 'codex'] }, hostname());
                }
                else {
                    const verify = createAccountLogin(owner);
                    try {
                        await verify.exchange(account.token);
                    }
                    finally {
                        verify.dispose();
                    }
                    next = parseConfig({ role: 'hub', publicOrigin: choice.origin, dashboardToken: state.token,
                        accountLogin: true, dshAccountHash: owner, deviceName: choice.name,
                        devicesFile: join(homedir(), '.dsh-marshal', 'desktop-hub', 'devices.json') }, hostname());
                }
                const current = await scoped.deepseekAccount.getPlatformSession();
                if (closed || current?.userId !== account.userId || current?.token !== account.token)
                    throw Error('account-required');
                state = { ...state, config: next };
                store.write(state);
                config = next;
                code = '';
                await start();
            }
            catch (error) {
                const message = error instanceof Error ? error.message : '';
                const classified = error && typeof error === 'object' && 'code' in error ? error.code : message;
                code = typeof classified === 'string' && ['account-required', 'account-mismatch', 'revoked', 'duplicate-id', 'invalid'].includes(classified) ? classified : 'account-unavailable';
            }
            finally {
                busy = false;
            }
        };
        scoped.effect(() => {
            const timer = setInterval(() => { void complete(); }, 20_000);
            timer.unref?.();
            void complete();
            return () => { closed = true; clearInterval(timer); };
        }, 'marshal: account enrollment retry');
        scoped.effect(() => scoped.webServer.register({ kind: 'exact', path: '/marshal/setup', async handler(req, res) {
                const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
                if (!isDesktopRequest(req, scoped.webServer.getOrigin(), 'x-marshal-setup')) {
                    json(403, { code: 'forbidden' });
                    return;
                }
                try {
                    let text = '';
                    for await (const chunk of req) {
                        text += chunk;
                        if (text.length > 8192)
                            throw Error('invalid-args');
                    }
                    const input = JSON.parse(text || '{}');
                    if (input.action === 'save') {
                        if (explicit || config || busy) {
                            json(409, { code: 'already-configured' });
                            return;
                        }
                        state = store.choose(parseSetupChoice(input.choice));
                        await complete();
                    }
                    else if (input.action !== 'status')
                        throw Error('invalid-args');
                    json(200, { ok: true, ready: !!config && started, configured: !!config, role: config?.role ?? state?.choice?.role ?? null,
                        origin: config?.publicOrigin ?? (config?.hubUrl ? new URL(config.hubUrl).origin.replace('wss:', 'https:') : state?.choice?.origin ?? DEFAULT_HUB_ORIGIN),
                        name: config?.deviceName ?? state?.choice?.name ?? hostname(), shareContent: state?.choice?.shareContent ?? true, busy, code, chosen: !!state?.choice });
                }
                catch {
                    json(400, { ok: false, code: 'invalid-args' });
                }
            } }), 'marshal: first-run setup');
    });
}
