import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { neutralizeMemory } from './lifecycle.js';

const execFileAsync = promisify(execFile);
const META = '__mm__';
const META_PART = /^__mm__(\d{2})-(.+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_LIMIT = 50;
const CATEGORIES = {
    profile: 'preference',
    decision: 'decision',
    fact: 'fact',
    handoff: 'context',
    episode: 'general',
    scene: 'context',
};
const VALID_INTENTS = new Set(['WHY', 'WHEN', 'ENTITY', 'GENERAL']);
const VALID_EDGE_TYPES = new Set(['causal', 'entity', 'semantic', 'supersedes', 'temporal']);

const memoryError = (code, message) => Object.assign(new Error(message), { code });
const unavailable = () => memoryError('memory-backend-unavailable', 'Mnemon 记忆后端暂时不可用。');
const bound = (value, min, max) => Math.max(min, Math.min(max, value));
const parseTime = value => {
    const ms = Date.parse(value ?? '');
    return Number.isFinite(ms) ? ms : Date.now();
};
const storeNameFor = (scope, ownerId) => {
    const prefix = scope === 'workspace' ? 'ws-' : 'pilot-';
    const slug = String(ownerId ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'owner';
    return prefix + slug + '-' + createHash('sha256').update(scope + ':' + String(ownerId ?? '')).digest('hex').slice(0, 8);
};

function decodeMeta(tags) {
    const parts = [];
    const plain = [];
    for (const tag of Array.isArray(tags) ? tags : []) {
        const match = META_PART.exec(String(tag));
        if (match) parts.push([Number(match[1]), match[2]]);
        else if (!String(tag).startsWith(META)) plain.push(String(tag));
    }
    if (parts.length === 0) return { tags: plain };
    parts.sort((a, b) => a[0] - b[0]);
    try {
        const parsed = JSON.parse(inflateRawSync(Buffer.from(parts.map(([, chunk]) => chunk).join(''), 'base64url')).toString('utf8'));
        return parsed && typeof parsed === 'object' ? { ...parsed, tags: Array.isArray(parsed.tags) ? parsed.tags : plain } : { tags: plain };
    }
    catch { return { tags: plain }; }
}

function splitTitle(text) {
    const raw = String(text ?? '').trim();
    const blank = raw.indexOf('\n\n');
    if (blank > 0 && blank <= 180) return { title: raw.slice(0, blank).trim(), content: raw.slice(blank + 2).trim() };
    const line = raw.indexOf('\n');
    if (line > 0 && line <= 180) return { title: raw.slice(0, line).trim(), content: raw.slice(line + 1).trim() };
    return { title: raw.slice(0, 120), content: raw };
}

function entryFor(row, scope, ownerId) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !UUID.test(row.id)) return undefined;
    const meta = decodeMeta(row.tags);
    const { title, content } = splitTitle(row.content);
    const importance = typeof meta.importance === 'number'
        ? bound(meta.importance, 0, 1)
        : bound(((Number(row.importance) || 3) - 1) / 4, 0, 1);
    const createdAt = parseTime(row.created_at);
    const updatedAt = parseTime(row.updated_at ?? row.created_at);
    return {
        id: row.id,
        scope,
        ownerId,
        kind: Object.hasOwn(CATEGORIES, meta.kind) ? meta.kind : 'fact',
        title,
        content,
        ...(typeof meta.cue === 'string' && meta.cue ? { cue: meta.cue } : {}),
        ...(typeof meta.source === 'string' && meta.source ? { source: meta.source } : {}),
        ...(typeof meta.sessionId === 'string' && meta.sessionId ? { sourceSession: meta.sessionId } : {}),
        ...(typeof meta.deviceId === 'string' && meta.deviceId ? { sourceDevice: meta.deviceId } : {}),
        ...(typeof meta.supersededBy === 'string' && meta.supersededBy ? { supersededBy: meta.supersededBy } : {}),
        importance,
        tags: meta.tags ?? [],
        pinned: meta.pinned === true || meta.kind === 'handoff',
        visibility: meta.visibility ?? (scope === 'workspace' ? 'group-safe' : 'private'),
        allowedWorkspaceId: meta.workspaceId,
        clarity: 'vivid',
        strength: 1,
        accessCount: Number(row.access_count) || 0,
        archived: false,
        backend: 'mnemon',
        createdAt,
        updatedAt,
    };
}

export function createMnemonNative({ agentId, ownerId, scope = 'agent', executable, root, store: explicitStore }) {
    const resolvedScope = scope === 'workspace' ? 'workspace' : 'agent';
    const resolvedOwner = String(ownerId ?? agentId ?? '');
    const dataDir = join(root, 'mnemon-native');
    const store = explicitStore || storeNameFor(resolvedScope, resolvedOwner);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const env = { ...process.env, MNEMON_DATA_DIR: dataDir, MNEMON_STORE: store };
    const run = async (args, { signal, allowMissing = false } = {}) => {
        try {
            const result = await execFileAsync(executable, ['--data-dir', dataDir, '--store', store, ...args], {
                env, timeout: 3500, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, signal, windowsHide: true,
            });
            return JSON.parse(result.stdout);
        }
        catch (error) {
            if (signal?.aborted) signal.throwIfAborted();
            if (allowMissing && error.code === 1 && /no rows in result set|not found or already deleted/.test(error.stderr ?? '')) return undefined;
            throw unavailable();
        }
    };
    const get = async id => UUID.test(id) ? entryFor(await run(['show', id], { allowMissing: true }), resolvedScope, resolvedOwner) : undefined;
    return {
        scope: resolvedScope,
        ownerId: resolvedOwner,
        agentId: resolvedScope === 'agent' ? resolvedOwner : undefined,
        store,
        get,
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
            const cue = typeof entry.cue === 'string' ? neutralizeMemory(entry.cue).trim().slice(0, 140) : '';
            const source = typeof entry.source === 'string' ? entry.source.trim().slice(0, 80) : (context.sessionId ? 'session:' + String(context.sessionId).slice(0, 48) : '');
            const sharedWorkspace = resolvedScope === 'workspace'
                ? resolvedOwner
                : (entry.visibility === 'group-safe' && typeof context.workspaceId === 'string' && context.workspaceId ? context.workspaceId : undefined);
            const meta = {
                kind, importance, tags,
                ...(cue ? { cue } : {}),
                ...(source ? { source } : {}),
                pinned: entry.pinned === true || kind === 'handoff',
                visibility: resolvedScope === 'workspace'
                    ? 'group-safe'
                    : (sharedWorkspace ? 'group-safe' : entry.visibility === 'never-group' ? 'never-group' : 'private'),
                workspaceId: sharedWorkspace,
                sessionId: context.sessionId,
                deviceId: context.deviceId,
            };
            const encoded = deflateRawSync(JSON.stringify(meta)).toString('base64url');
            const markers = encoded.match(/.{1,80}/g).map((chunk, index) => META + String(index).padStart(2, '0') + '-' + chunk);
            if (markers.length > TAG_LIMIT) throw memoryError('invalid-memory', 'Mnemon 记忆的标签元数据过长，请缩短标签。');
            const searchableTags = tags.filter(tag => !tag.includes(',') && Buffer.byteLength(tag) <= 100)
                .slice(0, TAG_LIMIT - markers.length);
            const rememberArgs = (extra = []) => [
                'remember', ...extra,
                '--cat', CATEGORIES[kind],
                '--imp', String(1 + Math.round(4 * importance)),
                '--source', 'agent',
                '--tags', [...searchableTags, ...markers].join(','),
                '--', title + '\n\n' + content,
            ];
            let result = await run(rememberArgs(), context);
            if (result?.action === 'skipped' && UUID.test(result.replaced_id)) {
                const existing = await get(result.replaced_id);
                const sameMeta = existing !== undefined
                    && existing.kind === meta.kind
                    && existing.visibility === meta.visibility
                    && existing.allowedWorkspaceId === meta.workspaceId
                    && existing.pinned === meta.pinned
                    && existing.importance === meta.importance
                    && (existing.cue ?? '') === (meta.cue ?? '')
                    && JSON.stringify(existing.tags) === JSON.stringify(meta.tags);
                if (sameMeta) return existing;
                await run(['forget', result.replaced_id], { allowMissing: true, signal: context.signal });
                result = await run(rememberArgs(['--no-diff']), context);
            }
            const id = result?.action === 'skipped' ? result.replaced_id : result?.action === 'added' ? result.id : undefined;
            if (!id) throw unavailable();
            const confirmed = result.action === 'added' && entryFor({ ...result, access_count: 0 }, resolvedScope, resolvedOwner);
            const item = confirmed || await get(id);
            if (!item) throw unavailable();
            return item;
        },
        async recall(query, { k = 8, intent, signal } = {}) {
            if (!String(query).trim()) return [];
            const args = ['recall', '--verbose', '--limit', String(bound(k, 1, 50))];
            if (typeof intent === 'string' && VALID_INTENTS.has(intent.toUpperCase())) {
                args.push('--intent', intent.toUpperCase());
            }
            args.push('--', String(query).slice(0, 2000));
            const result = await run(args, { signal });
            if (!Array.isArray(result?.results)) throw unavailable();
            return result.results.flatMap(({ insight, score }) => {
                const item = entryFor(insight, resolvedScope, resolvedOwner);
                return item ? [{ ...item, score, why: ['mnemon', ...(result?.meta?.intent ? ['intent:' + result.meta.intent] : [])] }] : [];
            });
        },
        async list({ limit = 100 } = {}) {
            const rows = await run(['recall', '--basic', '--limit', String(bound(limit, 1, 500)), '--', '']);
            if (!Array.isArray(rows)) throw unavailable();
            return rows.map(row => entryFor(row, resolvedScope, resolvedOwner)).filter(Boolean);
        },
        async link(sourceId, targetId, { type = 'semantic', weight = 0.6, reason } = {}) {
            if (!UUID.test(sourceId) || !UUID.test(targetId)) throw memoryError('invalid-args', 'link 需要有效的 Mnemon 记忆 UUID。');
            const edgeType = VALID_EDGE_TYPES.has(type) ? type : 'semantic';
            const args = ['link', sourceId, targetId, '--type', edgeType, '--weight', String(bound(Number(weight) || 0.6, 0.1, 1))];
            if (reason) args.push('--meta', JSON.stringify({ reason: String(reason).slice(0, 160) }));
            return await run(args);
        },
        async related(id, { depth = 1, edge, signal } = {}) {
            if (!UUID.test(id)) return [];
            const args = ['related', id, '--depth', String(bound(depth, 1, 3))];
            if (edge && VALID_EDGE_TYPES.has(edge)) args.push('--edge', edge);
            const result = await run(args, { signal, allowMissing: true });
            const items = Array.isArray(result) ? result : Array.isArray(result?.results) ? result.results : Array.isArray(result?.related) ? result.related : [];
            return items.map(row => ({
                targetId: row?.insight?.id ?? row?.id ?? row?.target_id,
                edgeType: row?.edge_type ?? row?.type ?? 'semantic',
                weight: Number(row?.weight ?? row?.score ?? 0.5),
            })).filter(e => typeof e.targetId === 'string' && UUID.test(e.targetId) && e.targetId !== id);
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
