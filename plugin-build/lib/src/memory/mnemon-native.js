import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { neutralizeMemory } from './lifecycle.js';

const exec = promisify(execFile);
const META = 'marshal-v1-';
const TAG_LIMIT = 20;
const RUN_ENV = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP'];
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const CATEGORIES = { profile: 'preference', fact: 'fact', decision: 'decision', episode: 'context', handoff: 'context', scene: 'context' };
const bound = (value, low, high) => Math.max(low, Math.min(high, value));
const memoryError = (code, message) => Object.assign(new Error(message), { code });
const unavailable = () => memoryError('mnemon-unavailable', 'Mnemon 私有记忆暂不可用，请检查已配置的本机程序。');

function entryFor(row, ownerId) {
    if (!UUID.test(row?.id) || typeof row.content !== 'string') return undefined;
    const tags = (Array.isArray(row.tags) ? row.tags : []).filter(value => typeof value === 'string' && value.startsWith(META)).sort();
    if (!tags.length) return undefined;
    let meta;
    try {
        const encoded = tags.map(value => value.slice(META.length + 3)).join('');
        meta = JSON.parse(inflateRawSync(Buffer.from(encoded, 'base64url'), { maxOutputLength: 12_000 }).toString('utf8'));
    }
    catch { return undefined; }
    const separator = row.content.indexOf('\n\n');
    if (separator < 1 || !Object.hasOwn(CATEGORIES, meta?.kind ?? '') || !Array.isArray(meta.tags)) return undefined;
    return {
        id: row.id, scope: 'agent', ownerId, backend: 'mnemon',
        title: row.content.slice(0, separator), content: row.content.slice(separator + 2),
        kind: meta.kind, importance: meta.importance, visibility: meta.visibility, pinned: meta.pinned,
        tags: meta.tags, sourceSession: meta.sessionId ?? null, sourceDevice: meta.deviceId ?? null,
        ...(meta.workspaceId ? { allowedWorkspaceId: meta.workspaceId } : {}),
        createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at ?? row.created_at),
        accessCount: row.access_count ?? 0, clarity: 'vivid', retention: 100, archived: false,
    };
}

// The caller selects the pilot from a server-owned identity. Extra CLI options
// and the data directory are never taken from a prompt or HTTP request.
export function createMnemonNative({ root, agentId, executable }) {
    const dataDir = join(root, 'mnemon');
    const store = 'agent-' + createHash('sha256').update(agentId).digest('hex');
    const run = async (args, { signal, allowMissing = false } = {}) => {
        try {
            await mkdir(dataDir, { recursive: true, mode: 0o700 });
            const env = Object.fromEntries(RUN_ENV.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
            // The pilot compares local graph/keyword retrieval. An inherited
            // embedding endpoint could otherwise receive private recall text.
            env.MNEMON_EMBED_ENDPOINT = 'http://127.0.0.1:0';
            env.MNEMON_MAX_INSIGHTS = '0';
            const result = await exec(executable, ['--data-dir', dataDir, '--store', store, ...args], {
                env, timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, signal, windowsHide: true,
            });
            return JSON.parse(result.stdout);
        } catch (error) {
            if (signal?.aborted) signal.throwIfAborted();
            if (allowMissing && error.code === 1 && /no rows in result set|not found or already deleted/.test(error.stderr ?? '')) return undefined;
            throw unavailable();
        }
    };
    const get = async id => UUID.test(id) ? entryFor(await run(['show', id], { allowMissing: true }), agentId) : undefined;
    return {
        agentId, get,
        async remember(entry, context = {}) {
            const title = neutralizeMemory(entry.title ?? '').trim().replace(/\s+/g, ' ').slice(0, 160);
            const content = neutralizeMemory(entry.content ?? '').trim();
            const kind = String(entry.kind ?? 'fact');
            if (!title || !content || !Object.hasOwn(CATEGORIES, kind)) {
                throw memoryError('invalid-memory', '请填写有效的记忆类型、标题和正文。');
            }
            const importance = bound(Number.isFinite(Number(entry.importance)) ? Number(entry.importance) : 0.5, 0, 1);
            const tags = (Array.isArray(entry.tags) ? entry.tags : [])
                .filter(tag => typeof tag === 'string' && !tag.startsWith(META)).slice(0, 24).map(tag => tag.slice(0, 85));
            const sharedWorkspace = entry.visibility === 'group-safe' && typeof context.workspaceId === 'string' && context.workspaceId
                ? context.workspaceId : undefined;
            const meta = { kind, importance, tags, pinned: entry.pinned === true || kind === 'handoff',
                visibility: sharedWorkspace ? 'group-safe' : entry.visibility === 'never-group' ? 'never-group' : 'private',
                workspaceId: sharedWorkspace, sessionId: context.sessionId, deviceId: context.deviceId };
            const encoded = deflateRawSync(JSON.stringify(meta)).toString('base64url');
            const markers = encoded.match(/.{1,80}/g).map((chunk, index) =>
                META + String(index).padStart(2, '0') + '-' + chunk);
            if (markers.length > TAG_LIMIT) throw memoryError('invalid-memory', 'Mnemon 记忆的标签元数据过长，请缩短标签。');
            const searchableTags = tags.filter(tag => !tag.includes(',') && Buffer.byteLength(tag) <= 100)
                .slice(0, TAG_LIMIT - markers.length);
            const result = await run(['remember', '--cat', CATEGORIES[kind], '--imp', String(1 + Math.round(4 * importance)),
                '--source', 'agent', '--tags', [...searchableTags, ...markers].join(','),
                '--', title + '\n\n' + content], context);
            const id = result?.action === 'skipped' ? result.replaced_id : result?.action === 'added' ? result.id : undefined;
            if (!id) throw unavailable();
            const confirmed = result.action === 'added' && entryFor({ ...result, access_count: 0 }, agentId);
            const item = confirmed || await get(id);
            if (!item) throw unavailable();
            return item;
        },
        async recall(query, { k = 8, signal } = {}) {
            if (!String(query).trim()) return [];
            const result = await run(['recall', '--verbose', '--limit', String(bound(k, 1, 50)), '--', String(query).slice(0, 2000)], { signal });
            if (!Array.isArray(result?.results)) throw unavailable();
            return result.results.flatMap(({ insight, score }) => {
                const item = entryFor(insight, agentId);
                return item ? [{ ...item, score, why: ['mnemon'] }] : [];
            });
        },
        async list({ limit = 100 } = {}) {
            const rows = await run(['recall', '--basic', '--limit', String(bound(limit, 1, 500)), '--', '']);
            if (!Array.isArray(rows)) throw unavailable();
            return rows.map(row => entryFor(row, agentId)).filter(Boolean);
        },
        async stats() {
            const value = (await run(['status']))?.total_insights;
            if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
            return value;
        },
        async forget(id) {
            if (!await get(id)) return false;
            const result = await run(['forget', id], { allowMissing: true });
            return result?.status === 'deleted';
        },
    };
}
