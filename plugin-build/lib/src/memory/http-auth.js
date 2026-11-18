import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { agentsLedgerPath } from '../groups/inventory.js';

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

/** The install owner is the configured account hash, or the signed-in platform account. A device id is not an owner. */
export function installOwnerFor(config, platformHash) {
    const configured = config?.dshAccountHash;
    if (typeof configured === 'string' && /^[a-f0-9]{64}$/.test(configured)) return configured;
    if (typeof platformHash === 'string' && /^[a-f0-9]{64}$/.test(platformHash)) return platformHash;
    return undefined;
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

export function createMemoryHttpAuth({ now = Date.now, resolveOwner = async () => '', installOwner, loadLedger = readRawLedger, allowedOrigins = ['dsh-app://app'], absoluteMs = MEMORY_SESSION_ABSOLUTE_MS, idleMs = MEMORY_SESSION_IDLE_MS } = {}) {
    const sessions = new Map();
    const token = () => randomBytes(32).toString('base64url');
    const expectedOwner = async () => {
        const value = typeof installOwner === 'function' ? await installOwner() : installOwner;
        return typeof value === 'string' && value !== '' ? value : undefined;
    };
    const originAllowed = (req, origins) => {
        const origin = headerValue(req, 'origin');
        const list = Array.isArray(origins) ? origins : allowedOrigins;
        return typeof origin === 'string' && origin !== '' && list.includes(origin);
    };
    const csrfMatches = (req, session) => {
        const cookie = readCookie(req, MEMORY_CSRF_COOKIE);
        const header = headerValue(req, 'x-marshal-csrf');
        if (cookie === undefined || cookie === null || header === undefined || header === '') return false;
        const expected = Buffer.from(session.csrf, 'utf8');
        const fromCookie = Buffer.from(cookie, 'utf8');
        const fromHeader = Buffer.from(header, 'utf8');
        return fromCookie.length === expected.length
            && fromHeader.length === expected.length
            && timingSafeEqual(fromCookie, expected)
            && timingSafeEqual(fromHeader, expected);
    };
    return {
        loadLedger,
        cookiePair,
        async open(req, origins = allowedOrigins) {
            if (!isLoopbackAddress(req.socket?.remoteAddress ?? '')) return { ok: false, status: 403, code: 'forbidden' };
            if (req.headers?.['sec-fetch-site'] === 'cross-site') return { ok: false, status: 403, code: 'forbidden' };
            if (headerValue(req, 'x-marshal-memory') !== '1') return { ok: false, status: 403, code: 'forbidden' };
            if (!originAllowed(req, origins)) return { ok: false, status: 403, code: 'forbidden' };
            const ownerId = await resolveOwner();
            if (typeof ownerId !== 'string' || ownerId === '') return { ok: false, status: 403, code: 'forbidden' };
            const expected = await expectedOwner();
            const at = now();
            const session = {
                id: token(), csrf: token(), ownerId,
                owner: expected !== undefined && ownerId === expected,
                createdAt: at, lastSeenAt: at,
            };
            sessions.set(session.id, session);
            return {
                ok: true, session,
                cookies: [
                    cookiePair(MEMORY_SESSION_COOKIE, session.id, true),
                    cookiePair(MEMORY_CSRF_COOKIE, session.csrf, false),
                ],
            };
        },
        authenticate(req, { write = false, origins = allowedOrigins } = {}) {
            if (!isLoopbackAddress(req.socket?.remoteAddress ?? '')) return { ok: false, status: 403, code: 'forbidden' };
            if (req.headers?.['sec-fetch-site'] === 'cross-site') return { ok: false, status: 403, code: 'forbidden' };
            if (write && !originAllowed(req, origins)) return { ok: false, status: 403, code: 'forbidden' };
            const id = readCookie(req, MEMORY_SESSION_COOKIE);
            if (id === undefined || id === null) return { ok: false, status: 401, code: 'unauthorized' };
            const session = sessions.get(id);
            if (session === undefined) return { ok: false, status: 401, code: 'unauthorized' };
            const at = now();
            if (at - session.createdAt >= absoluteMs || at - session.lastSeenAt >= idleMs) {
                sessions.delete(id);
                return { ok: false, status: 401, code: 'unauthorized' };
            }
            session.lastSeenAt = at;
            if (write && !csrfMatches(req, session)) return { ok: false, status: 403, code: 'forbidden' };
            return { ok: true, session };
        },
        allows(session, target, ledger = loadLedger()) {
            return memoryTargetAllowed(session, target, ledger);
        },
    };
}
