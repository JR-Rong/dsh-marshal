import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { agentsLedgerPath } from '../groups/inventory.js';
import { atomicWriteFile, withFileLock } from '../hub/state-file.js';

/**
 * Loopback memory cookies.
 * `__Host-` + `Secure` was not verified to stick in the desktop WebView on
 * http://127.0.0.1 (a headless Chrome probe of that origin did not complete, and
 * Electron WebViews have dropped Secure cookies on plain HTTP). These names omit
 * the `__Host-` prefix and the Secure flag so the WebView can store them.
 * They are still SameSite=Strict, Path=/, and only issued to loopback.
 */
export const MEMORY_SESSION_COOKIE = 'marshal-memory-session';
export const MEMORY_CSRF_COOKIE = 'marshal-memory-csrf';
export const MEMORY_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const MEMORY_SESSION_IDLE_MS = 30 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const DESKTOP_HEADER = 'x-marshal-desktop';
const SESSION_HEADER = 'x-marshal-session';

const OWNER_HASH = /^[a-f0-9]{64}$/;

function hashOrUndefined(value) {
    return typeof value === 'string' && OWNER_HASH.test(value) ? value : undefined;
}

/** The install owner is the configured account hash, the signed-in platform account, or a hash persisted from an earlier signed-in owner. A device id is not an owner. */
export function installOwnerFor(config, platformHash, persistedHash) {
    const configured = hashOrUndefined(config?.dshAccountHash);
    if (configured !== undefined) return configured;
    const persisted = hashOrUndefined(persistedHash);
    if (persisted !== undefined) return persisted;
    return hashOrUndefined(platformHash);
}

export function readPersistedOwner(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return hashOrUndefined(parsed?.accountHash);
    }
    catch { return undefined; }
}

/** Remember the first signed-in owner. A later different account does not replace it. */
export function persistOwner(file, hash) {
    const next = hashOrUndefined(hash);
    if (next === undefined || typeof file !== 'string' || file === '') return undefined;
    return withFileLock(file, () => {
        const existing = readPersistedOwner(file);
        if (existing !== undefined) return existing;
        atomicWriteFile(file, JSON.stringify({ accountHash: next }) + '\n');
        return next;
    });
}

/**
 * Desktop owner resolution. The first matching signed-in account is written to
 * ownerFile. After that, a logged-out local session can present that same hash.
 * Until a hash exists, install is undefined and approval stays closed.
 */
export function resolveDesktopOwner({ config, platformHash, ownerFile }) {
    const platform = hashOrUndefined(platformHash);
    const configured = hashOrUndefined(config?.dshAccountHash);
    if (platform !== undefined && (configured === undefined || platform === configured)) persistOwner(ownerFile, platform);
    const persisted = typeof ownerFile === 'string' && ownerFile !== '' ? readPersistedOwner(ownerFile) : undefined;
    return {
        caller: platform ?? persisted,
        install: installOwnerFor(config, platform, persisted),
    };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function hostIsLoopback(value) {
    if (typeof value !== 'string' || value === '') return false;
    try { return LOOPBACK_HOSTS.has(new URL('http://' + value).hostname); }
    catch { return false; }
}

export function isLoopbackAddress(address) {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function headerValue(req, name) {
    const header = req.headers?.[name];
    return Array.isArray(header) ? undefined : header;
}

export function readCookie(req, name) {
    const header = req.headers?.cookie;
    if (header === undefined) return undefined;
    const raw = Array.isArray(header) ? header.join('; ') : header;
    let found;
    let count = 0;
    for (const part of raw.split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        if (part.slice(0, index).trim() !== name) continue;
        count += 1;
        found = part.slice(index + 1).trim();
    }
    if (count === 0) return undefined;
    if (count > 1 || found === undefined || !TOKEN_PATTERN.test(found)) return null;
    return found;
}

function cookiePair(name, value, httpOnly, maxAge) {
    return `${name}=${value}; Path=/; SameSite=Strict${httpOnly ? '; HttpOnly' : ''}`
        + (maxAge === undefined ? '' : `; Max-Age=${maxAge}`);
}

function stampOf(value) {
    if (value === null || typeof value !== 'object') return undefined;
    for (const key of ['ownerId', 'accountHash']) {
        if (typeof value[key] === 'string' && value[key] !== '') return value[key];
    }
    return undefined;
}

export function readRawLedger(env = process.env) {
    try {
        const parsed = JSON.parse(readFileSync(agentsLedgerPath(env), 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.teams)) return { teams: [] };
        return parsed;
    }
    catch { return { teams: [] }; }
}

/** Agent and workspace ids must belong to the session. Unstamped rows belong to the install owner only. */
export function memoryTargetAllowed(session, target, ledger) {
    if (session === undefined || session === null) return false;
    const scope = target?.scope;
    if (scope === 'global' || target?.global === true) return session.owner === true;
    const agentId = typeof target?.agentId === 'string' ? target.agentId : '';
    const workspaceId = typeof target?.workspaceId === 'string' ? target.workspaceId : '';
    const agents = [];
    const workspaces = new Set();
    for (const team of Array.isArray(ledger?.teams) ? ledger.teams : []) {
        const teamStamp = stampOf(team);
        const teamAllowed = teamStamp !== undefined ? teamStamp === session.ownerId : session.owner === true;
        if (teamAllowed && typeof team?.workspaceId === 'string' && team.workspaceId !== '') workspaces.add(team.workspaceId);
        for (const member of Array.isArray(team?.members) ? team.members : []) {
            const memberStamp = stampOf(member) ?? teamStamp;
            const allowed = memberStamp !== undefined ? memberStamp === session.ownerId : session.owner === true;
            if (allowed && typeof member?.id === 'string' && member.id !== '') agents.push(member.id);
        }
    }
    if (agentId !== '' && !agents.includes(agentId)) return false;
    if (workspaceId !== '' && !workspaces.has(workspaceId)) return false;
    if (agentId === '' && workspaceId === '') return session.owner === true;
    return true;
}

export function createMemoryHttpAuth({ now = Date.now, resolveOwner = async () => '', installOwner, loadLedger = readRawLedger, allowedOrigins = ['dsh-app://app'], absoluteMs = MEMORY_SESSION_ABSOLUTE_MS, idleMs = MEMORY_SESSION_IDLE_MS, trustedRequest } = {}) {
    const sessions = new Map();
    const token = () => randomBytes(32).toString('base64url');
    const expectedOwner = async () => {
        const value = typeof installOwner === 'function' ? await installOwner() : installOwner;
        return typeof value === 'string' && value !== '' ? value : undefined;
    };
    const hostOk = req => req.headers?.host === undefined || hostIsLoopback(headerValue(req, 'host'));
    const admitted = req => {
        if (typeof trustedRequest !== 'function') return true;
        try { return trustedRequest(req) === true; }
        catch { return false; }
    };
    const originAllowed = (req, origins) => {
        const origin = headerValue(req, 'origin');
        const list = Array.isArray(origins) ? origins : allowedOrigins;
        return typeof origin === 'string' && origin !== '' && list.includes(origin);
    };
    // The authenticated DSH app proxy strips Origin, fetch-site and browser cookies
    // while attaching the Host's signed connection cookie. Require connection admission
    // when the Host connection service is wired.
    const desktop = req => headerValue(req, DESKTOP_HEADER) === '1' &&
        admitted(req) &&
        ((req.headers?.origin === undefined && req.headers?.['sec-fetch-site'] === undefined) ||
            headerValue(req, 'origin') === 'dsh-app://app');
    const matches = (value, expected) => typeof value === 'string' &&
        value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
    const csrfMatches = (req, session) => {
        const header = headerValue(req, 'x-marshal-csrf');
        return TOKEN_PATTERN.test(header ?? '') && matches(header, session.csrf) &&
            (session.desktop || matches(readCookie(req, MEMORY_CSRF_COOKIE), session.csrf));
    };
    const expired = (session, at) => at - session.createdAt >= absoluteMs || at - session.lastSeenAt >= idleMs;
    return {
        loadLedger,
        cookiePair,
        async open(req, origins = allowedOrigins) {
            if (!isLoopbackAddress(req.socket?.remoteAddress ?? '') || !hostOk(req)) return { ok: false, status: 403, code: 'forbidden' };
            if (req.headers?.['sec-fetch-site'] === 'cross-site') return { ok: false, status: 403, code: 'forbidden' };
            if (headerValue(req, 'x-marshal-memory') !== '1') return { ok: false, status: 403, code: 'forbidden' };
            const native = desktop(req);
            if (!native && (headerValue(req, DESKTOP_HEADER) === '1' || !originAllowed(req, origins))) {
                return { ok: false, status: 403, code: 'forbidden' };
            }
            const ownerId = await resolveOwner();
            if (typeof ownerId !== 'string' || ownerId === '') return { ok: false, status: 403, code: 'memory-account-unavailable' };
            const expected = await expectedOwner();
            const at = now();
            const session = {
                id: token(), csrf: token(), ownerId,
                owner: expected !== undefined && ownerId === expected,
                createdAt: at, lastSeenAt: at, desktop: native,
            };
            for (const [id, previous] of sessions) if (expired(previous, at)) sessions.delete(id);
            sessions.set(session.id, session);
            return {
                ok: true, session,
                cookies: native ? undefined : [
                    cookiePair(MEMORY_SESSION_COOKIE, session.id, true),
                    cookiePair(MEMORY_CSRF_COOKIE, session.csrf, false),
                ],
            };
        },
        authenticate(req, { write = false, origins = allowedOrigins } = {}) {
            if (!isLoopbackAddress(req.socket?.remoteAddress ?? '') || !hostOk(req)) return { ok: false, status: 403, code: 'forbidden' };
            if (req.headers?.['sec-fetch-site'] === 'cross-site') return { ok: false, status: 403, code: 'forbidden' };
            const native = desktop(req);
            if ((write && !native && !originAllowed(req, origins)) ||
                (headerValue(req, DESKTOP_HEADER) === '1' && !native)) return { ok: false, status: 403, code: 'forbidden' };
            const id = native ? headerValue(req, SESSION_HEADER) : readCookie(req, MEMORY_SESSION_COOKIE);
            if (!TOKEN_PATTERN.test(id ?? '')) return { ok: false, status: 401, code: 'unauthorized' };
            const session = sessions.get(id);
            if (session === undefined || session.desktop !== native) return { ok: false, status: 401, code: 'unauthorized' };
            const at = now();
            if (expired(session, at)) {
                sessions.delete(id);
                return { ok: false, status: 401, code: 'unauthorized' };
            }
            if (write && !csrfMatches(req, session)) return { ok: false, status: 403, code: 'memory-csrf-mismatch' };
            session.lastSeenAt = at;
            return { ok: true, session };
        },
        allows(session, target, ledger = loadLedger()) {
            return memoryTargetAllowed(session, target, ledger);
        },
    };
}
