import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    HASH_DIM, HASH_PROVIDER, bufferToVector, contentHash, cosine,
    hashEmbed, memorySearchText, vectorToBuffer,
} from './hash-vector.js';
import { neutralizeMemory, queryTerms } from './lifecycle.js';
import { normalizeFact, normalizeGlobalVisibility } from './policy.js';

const SCHEMA_VERSION = 1;
const MAX_CONTENT = 20_000;
const HALF_LIFE_DAYS = 45;

function safeSegment(value) {
    const text = String(value ?? 'owner');
    return text.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 72) + '-' + createHash('sha256').update(text).digest('hex').slice(0, 8);
}

function parseTags(value) {
    try {
        const parsed = JSON.parse(String(value ?? '[]'));
        return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : [];
    }
    catch { return []; }
}

function mapMemory(row) {
    if (row === undefined) return undefined;
    return {
        id: row.id,
        scope: row.scope,
        ownerId: row.owner_id,
        kind: row.kind,
        title: row.title,
        content: row.content,
        importance: Number(row.importance),
        pinned: Number(row.pinned) === 1,
        visibility: row.visibility,
        tags: parseTags(row.tags),
        sourceSession: row.source_session ?? undefined,
        sourceDevice: row.source_device ?? undefined,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        lastAccessedAt: row.last_accessed_at === null ? undefined : Number(row.last_accessed_at),
        accessCount: Number(row.access_count),
        recallCount: Number(row.recall_count ?? row.access_count ?? 0),
        clarity: row.clarity ?? 'vivid',
        retention: Number(row.retention ?? 50),
        lastSeenAt: row.last_seen_at === null || row.last_seen_at === undefined ? undefined : Number(row.last_seen_at),
        archived: Number(row.archived ?? 0) === 1,
        supersededBy: row.superseded_by ?? undefined,
    };
}

function nowMs(now) {
    return typeof now === 'function' ? now() : Date.now();
}

export class MemoryStore {
    constructor({ root, logger, now = Date.now } = {}) {
        this.root = root ?? join(process.env.HOME ?? '.', '.dsh-marshal', 'memory');
        this.logger = logger ?? { info: () => { }, warn: () => { } };
        this.now = now;
        this.dbs = new Map();
        mkdirSync(this.root, { recursive: true });
    }

    dbPath(scope, ownerId) {
        if (scope === 'global') return join(this.root, 'global.db');
        if (scope === 'workspace') return join(this.root, 'workspaces', safeSegment(ownerId), 'memory.db');
        return join(this.root, 'agents', safeSegment(ownerId), 'memory.db');
    }

    db(scope, ownerId) {
        const path = this.dbPath(scope, ownerId);
        const cached = this.dbs.get(path);
        if (cached !== undefined) return cached;
        mkdirSync(dirname(path), { recursive: true });
        const db = new DatabaseSync(path);
        db.exec('PRAGMA journal_mode=WAL');
        db.exec('PRAGMA busy_timeout=5000');
        db.exec('PRAGMA foreign_keys=ON');
        this.ensure(db, scope);
        this.dbs.set(path, db);
        return db;
    }

    ensure(db, scope) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                importance REAL NOT NULL DEFAULT 0.5,
                pinned INTEGER NOT NULL DEFAULT 0,
                visibility TEXT NOT NULL DEFAULT 'private',
                tags TEXT NOT NULL DEFAULT '[]',
                source_session TEXT,
                source_device TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_accessed_at INTEGER,
                access_count INTEGER NOT NULL DEFAULT 0,
                superseded_by TEXT,
                content_hash TEXT NOT NULL,
                clarity TEXT NOT NULL DEFAULT 'vivid',
                retention REAL NOT NULL DEFAULT 55,
                last_seen_at INTEGER,
                recall_count INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS memory_archive (
                id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
                title TEXT NOT NULL, content TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5,
                pinned INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'private',
                tags TEXT NOT NULL DEFAULT '[]', source_session TEXT, source_device TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_accessed_at INTEGER,
                access_count INTEGER NOT NULL DEFAULT 0, superseded_by TEXT, content_hash TEXT NOT NULL,
                clarity TEXT NOT NULL DEFAULT 'vivid', retention REAL NOT NULL DEFAULT 55,
                last_seen_at INTEGER, recall_count INTEGER NOT NULL DEFAULT 0, archived_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS memories_hash ON memories(content_hash);
            CREATE INDEX IF NOT EXISTS memories_owner ON memories(scope, owner_id, updated_at DESC);
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, search_text, tokenize='unicode61');
            CREATE TABLE IF NOT EXISTS memory_vectors (
                memory_id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                dim INTEGER NOT NULL,
                vector BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memory_edges (
                src TEXT NOT NULL,
                dst TEXT NOT NULL,
                relation TEXT NOT NULL,
                weight REAL NOT NULL DEFAULT 1,
                PRIMARY KEY (src, dst, relation)
            );
            CREATE TABLE IF NOT EXISTS sync_outbox (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                ciphertext BLOB,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memory_tombstones (
                id TEXT PRIMARY KEY,
                content_hash TEXT,
                norm_hash TEXT,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memory_proposals (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                importance REAL NOT NULL DEFAULT 0.5,
                tags TEXT NOT NULL DEFAULT '[]',
                visibility TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                resolved_at INTEGER
            );
        `);
        const columns = new Set(db.prepare('PRAGMA table_info(memories)').all().map(row => row.name));
        const additions = [
            ['clarity', "TEXT NOT NULL DEFAULT 'vivid'"],
            ['retention', 'REAL NOT NULL DEFAULT 55'],
            ['last_seen_at', 'INTEGER'],
            ['recall_count', 'INTEGER NOT NULL DEFAULT 0'],
            ['archived', 'INTEGER NOT NULL DEFAULT 0'],
        ];
        for (const [name, type] of additions) {
            if (!columns.has(name)) db.exec('ALTER TABLE memories ADD COLUMN ' + name + ' ' + type);
        }
        const current = db.prepare("SELECT value FROM memory_meta WHERE key='schema_version'").get();
        if (current === undefined) db.prepare("INSERT INTO memory_meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
        const tombColumns = new Set(db.prepare('PRAGMA table_info(memory_tombstones)').all().map(row => row.name));
        if (!tombColumns.has('norm_hash')) db.exec('ALTER TABLE memory_tombstones ADD COLUMN norm_hash TEXT');
        if (scope === 'global') {
            db.prepare("UPDATE memories SET visibility='no-group' WHERE visibility NOT IN ('all','no-group')").run();
            db.prepare("UPDATE memory_archive SET visibility='no-group' WHERE visibility NOT IN ('all','no-group')").run();
        }
    }

    visibilityFor(scope, value) {
        if (scope === 'global') return normalizeGlobalVisibility(value);
        return ['private', 'group-safe', 'never-group'].includes(value) ? value : 'private';
    }

    insertFts(db, memory) {
        db.prepare('DELETE FROM memories_fts WHERE memory_id=?').run(memory.id);
        const search = memorySearchText(memory.title, memory.content, memory.tags.join(' '));
        db.prepare('INSERT INTO memories_fts(memory_id, search_text) VALUES(?,?)').run(memory.id, search);
    }

    remember(scope, ownerId, entry, context = {}) {
        const title = neutralizeMemory(entry.title ?? '').trim().slice(0, 160);
        const content = neutralizeMemory(entry.content ?? '').trim();
        if (title === '' || content === '') throw new Error('memory title and content are required');
        if (content.length > MAX_CONTENT) throw new Error('memory content is too long');
        const kind = String(entry.kind ?? 'fact');
        if (!['profile', 'fact', 'decision', 'episode', 'handoff', 'scene'].includes(kind)) throw new Error('invalid memory kind');
        const visibility = this.visibilityFor(scope, entry.visibility);
        const tags = Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string').slice(0, 24) : [];
        const importance = Math.max(0, Math.min(1, Number(entry.importance ?? 0.5)));
        const pinned = entry.pinned === true || kind === 'handoff' ? 1 : 0;
        const hash = contentHash(title, content);
        const db = this.db(scope, ownerId);
        if (this.hashTombstoned(scope, ownerId, title, content)) return undefined;
        const existing = db.prepare('SELECT * FROM memories WHERE content_hash=?').get(hash);
        if (existing !== undefined) {
            const updated = nowMs(this.now);
            db.prepare('UPDATE memories SET importance=?, pinned=?, visibility=?, tags=?, updated_at=? WHERE id=?')
                .run(Math.max(Number(existing.importance), importance), Math.max(Number(existing.pinned), pinned), visibility, JSON.stringify(tags), updated, existing.id);
            return mapMemory(db.prepare('SELECT * FROM memories WHERE id=?').get(existing.id));
        }
        const at = nowMs(this.now);
        const id = typeof context.id === 'string' && context.id !== '' ? context.id : randomUUID();
        if (this.hasTombstone(scope, ownerId, id)) return undefined;
        const memory = {
            id, scope, ownerId, kind, title, content, importance, pinned, visibility,
            tags, sourceSession: context.sessionId ?? null, sourceDevice: context.deviceId ?? null,
            createdAt: at, updatedAt: at,
        };
        db.exec('BEGIN IMMEDIATE');
        try {
            db.prepare(`INSERT INTO memories
                (id,scope,owner_id,kind,title,content,importance,pinned,visibility,tags,source_session,source_device,created_at,updated_at,last_accessed_at,access_count,superseded_by,content_hash,clarity,retention,last_seen_at,recall_count,archived)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(memory.id, scope, ownerId, kind, title, content, importance, pinned, visibility, JSON.stringify(tags), memory.sourceSession, memory.sourceDevice, at, at, null, 0, null, hash, 'vivid', Math.max(55, importance * 100), at, 0, 0);
            this.insertFts(db, { ...memory, tags });
            const vector = hashEmbed(title + '\n' + content, HASH_DIM);
            db.prepare('INSERT INTO memory_vectors(memory_id,provider,model,dim,vector) VALUES(?,?,?,?,?)')
                .run(memory.id, HASH_PROVIDER, 'hash-384', HASH_DIM, vectorToBuffer(vector));
            db.exec('COMMIT');
        }
        catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
            throw error;
        }
        return mapMemory(db.prepare('SELECT * FROM memories WHERE id=?').get(memory.id));
    }

    get(scope, ownerId, id) {
        const row = this.db(scope, ownerId).prepare('SELECT * FROM memories WHERE id=?').get(String(id));
        return mapMemory(row);
    }

    list(scope, ownerId, { limit = 100, kinds, visibility } = {}) {
        const db = this.db(scope, ownerId);
        const cap = Math.max(1, Math.min(500, Number(limit) || 100));
        const clauses = ['scope=?', 'owner_id=?', 'archived=0'];
        const params = [scope, ownerId];
        if (Array.isArray(kinds) && kinds.length > 0) {
            clauses.push('kind IN (' + kinds.map(() => '?').join(',') + ')');
            params.push(...kinds);
        }
        if (visibility !== undefined) {
            clauses.push('visibility=?', 'superseded_by IS NULL');
            params.push(visibility);
        }
        return db.prepare('SELECT * FROM memories WHERE ' + clauses.join(' AND ')
            + ' ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?').all(...params, cap).map(mapMemory);
    }

    forget(scope, ownerId, id) {
        const db = this.db(scope, ownerId);
        const row = db.prepare('SELECT * FROM memories WHERE id=?').get(String(id));
        if (row === undefined) return false;
        db.exec('BEGIN IMMEDIATE');
        try {
            db.prepare(`INSERT OR REPLACE INTO memory_archive
                (id,scope,owner_id,kind,title,content,importance,pinned,visibility,tags,source_session,source_device,created_at,updated_at,last_accessed_at,access_count,superseded_by,content_hash,clarity,retention,last_seen_at,recall_count,archived_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(row.id, row.scope, row.owner_id, row.kind, row.title, row.content, row.importance, row.pinned, row.visibility, row.tags, row.source_session, row.source_device, row.created_at, row.updated_at, row.last_accessed_at, row.access_count, row.superseded_by, row.content_hash, row.clarity, row.retention, row.last_seen_at, row.recall_count, nowMs(this.now));
            db.prepare('DELETE FROM memories_fts WHERE memory_id=?').run(String(id));
            db.prepare('DELETE FROM memory_vectors WHERE memory_id=?').run(String(id));
            db.prepare('DELETE FROM memories WHERE id=?').run(String(id));
            db.prepare('INSERT OR REPLACE INTO memory_tombstones(id, content_hash, norm_hash, updated_at) VALUES(?,?,?,?)')
                .run(String(id), row.content_hash, contentHash(normalizeFact(row.title), normalizeFact(row.content)), nowMs(this.now));
            db.exec('COMMIT');
            return true;
        }
        catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* closed */ }
            throw error;
        }
    }

    fts(db, query, limit) {
        const text = String(query ?? '').trim();
        if (text === '') return [];
        const terms = queryTerms(text);
        const tokens = [...terms.whole, ...terms.grams].filter(Boolean).slice(0, 24);
        if (tokens.length > 0) {
            const expression = tokens.map(token => '"' + token.replace(/"/g, '""') + '"').join(' OR ');
            try {
                return db.prepare('SELECT memory_id, bm25(memories_fts) AS rank FROM memories_fts WHERE search_text MATCH ? ORDER BY rank LIMIT ?').all(expression, limit);
            }
            catch { /* fall through to LIKE for odd FTS syntax */ }
        }
        return db.prepare("SELECT id AS memory_id, 0 AS rank FROM memories WHERE lower(title) LIKE ? OR lower(content) LIKE ? ORDER BY importance DESC LIMIT ?")
            .all('%' + text.toLowerCase() + '%', '%' + text.toLowerCase() + '%', limit);
    }

    recallOne(scope, ownerId, query, limit = 60) {
        const db = this.db(scope, ownerId);
        const ftsRows = this.fts(db, query, limit);
        const byId = new Map();
        ftsRows.forEach((row, index) => byId.set(row.memory_id, { id: row.memory_id, ftsRank: index + 1 }));
        const queryVector = hashEmbed(query, HASH_DIM);
        const vectors = db.prepare('SELECT memory_id, dim, vector FROM memory_vectors').all();
        const vectorHits = [];
        for (const row of vectors) {
            const score = cosine(queryVector, bufferToVector(row.vector));
            if (score > 0.02) vectorHits.push({ id: row.memory_id, score });
        }
        vectorHits.sort((a, b) => b.score - a.score);
        vectorHits.slice(0, limit).forEach((hit, index) => {
            const current = byId.get(hit.id) ?? { id: hit.id };
            current.vectorRank = index + 1;
            current.vectorScore = hit.score;
            byId.set(hit.id, current);
        });
        const items = [];
        for (const candidate of byId.values()) {
            const row = db.prepare('SELECT * FROM memories WHERE id=?').get(candidate.id);
            if (row === undefined || row.superseded_by !== null || Number(row.archived) === 1) continue;
            const memory = mapMemory(row);
            const rrfFts = candidate.ftsRank === undefined ? 0 : 1 / (60 + candidate.ftsRank);
            const rrfVector = candidate.vectorRank === undefined ? 0 : 1 / (60 + candidate.vectorRank);
            const rrf = (rrfFts + rrfVector) * 30;
            const ageDays = Math.max(0, (nowMs(this.now) - memory.updatedAt) / 86_400_000);
            const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
            const access = Math.min(1, Math.log1p(memory.accessCount) / 6);
            const scopeWeight = scope === 'agent' ? 1 : scope === 'workspace' ? 0.85 : 0.7;
            const clarityWeight = memory.clarity === 'vivid' ? 1 : memory.clarity === 'clear' ? 0.8 : memory.clarity === 'fuzzy' ? 0.45 : 0.2;
            const exact = String(query ?? '').trim() !== '' && (memory.title.toLowerCase().includes(String(query).toLowerCase()) || memory.content.toLowerCase().includes(String(query).toLowerCase()));
            const score = 0.35 * Math.min(1, rrf) + 0.20 * memory.importance + 0.15 * recency + 0.10 * access + 0.05 * scopeWeight + 0.10 * clarityWeight + (memory.pinned ? 0.05 : 0) + (exact ? 0.08 : 0);
            items.push({ ...memory, score, why: [candidate.ftsRank === undefined ? undefined : 'fts', candidate.vectorRank === undefined ? undefined : 'vector', clarityWeight < 1 ? 'faded-' + memory.clarity : undefined, exact ? 'exact' : undefined].filter(Boolean) });
        }
        return items;
    }

    recall(scopes, query, { k = 8, kinds, minScore = 0.02 } = {}) {
        const items = [];
        for (const { scope, ownerId } of scopes) {
            for (const item of this.recallOne(scope, ownerId, query)) {
                if (Array.isArray(kinds) && kinds.length > 0 && !kinds.includes(item.kind)) continue;
                if (item.score < minScore) continue;
                items.push(item);
            }
        }
        const dedup = new Map();
        for (const item of items) {
            const key = contentHash(item.title, item.content);
            const current = dedup.get(key);
            if (current === undefined || item.score > current.score) dedup.set(key, item);
        }
        const result = [...dedup.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, k)));
        if (result.length > 0) {
            for (const { scope, ownerId } of scopes) {
                const db = this.db(scope, ownerId);
                const update = db.prepare('UPDATE memories SET last_accessed_at=?, last_seen_at=?, access_count=access_count+1, recall_count=recall_count+1 WHERE id=?');
                for (const item of result.filter(entry => entry.scope === scope && entry.ownerId === ownerId)) update.run(nowMs(this.now), nowMs(this.now), item.id);
            }
        }
        return result;
    }

    graph(scopes, { limit = 400 } = {}) {
        const nodes = [];
        for (const { scope, ownerId } of scopes) {
            for (const item of this.list(scope, ownerId, { limit })) nodes.push({ ...item, scope });
        }
        const byId = new Map(nodes.map(node => [node.id, node]));
        const edges = [];
        const seen = new Set();
        const addEdge = (src, dst, relation, weight) => {
            if (src === dst || !byId.has(src) || !byId.has(dst)) return;
            const key = [src, dst, relation].sort().join('|');
            if (seen.has(key)) return;
            seen.add(key);
            edges.push({ source: src, target: dst, relation, weight });
        };
        const tags = new Map();
        for (const node of nodes) for (const tag of node.tags) {
            const list = tags.get(tag) ?? [];
            list.push(node.id);
            tags.set(tag, list);
        }
        for (const [tag, ids] of tags) {
            const slice = ids.slice(0, 12);
            for (let i = 0; i < slice.length; i++) for (let j = i + 1; j < slice.length; j++) addEdge(slice[i], slice[j], 'tag', 1);
        }
        const sessions = new Map();
        for (const node of nodes) if (node.sourceSession) {
            const list = sessions.get(node.sourceSession) ?? [];
            list.push(node.id);
            sessions.set(node.sourceSession, list);
        }
        for (const [session, ids] of sessions) {
            const slice = ids.slice(0, 12);
            for (let i = 0; i < slice.length; i++) for (let j = i + 1; j < slice.length; j++) addEdge(slice[i], slice[j], 'session', 0.6);
        }
        return { nodes: nodes.map(node => ({
            id: node.id, title: node.title, kind: node.kind, scope: node.scope,
            visibility: node.visibility,
            importance: node.importance, pinned: node.pinned, tags: node.tags,
            accessCount: node.accessCount, clarity: node.clarity, retention: node.retention,
            createdAt: node.createdAt, updatedAt: node.updatedAt,
        })), edges };
    }

    exportRecords(scope, ownerId) {
        return this.db(scope, ownerId).prepare('SELECT * FROM memories ORDER BY updated_at ASC').all().map(mapMemory);
    }

    hasTombstone(scope, ownerId, id) {
        if (typeof id !== 'string' || id === '') return false;
        const row = this.db(scope, ownerId).prepare('SELECT id FROM memory_tombstones WHERE id=?').get(id);
        return row !== undefined;
    }

    hashTombstoned(scope, ownerId, title, content) {
        const raw = contentHash(title, content);
        const norm = contentHash(normalizeFact(title), normalizeFact(content));
        const row = this.db(scope, ownerId).prepare(
            'SELECT id FROM memory_tombstones WHERE content_hash=? OR norm_hash=? OR content_hash=? OR norm_hash=? LIMIT 1',
        ).get(raw, raw, norm, norm);
        return row !== undefined;
    }

    exportTombstones(scope, ownerId) {
        return this.db(scope, ownerId).prepare('SELECT id, content_hash AS contentHash, norm_hash AS normHash, updated_at AS updatedAt FROM memory_tombstones ORDER BY updated_at ASC').all()
            .map(row => ({
                id: row.id, contentHash: row.contentHash ?? undefined, normHash: row.normHash ?? undefined,
                updatedAt: Number(row.updatedAt), tombstone: true, revision: Number(row.updatedAt),
            }));
    }

    applyTombstone(scope, ownerId, record) {
        const id = String(record?.id ?? '');
        if (id === '') return false;
        if (this.get(scope, ownerId, id) !== undefined) this.forget(scope, ownerId, id);
        const at = Number(record?.updatedAt ?? nowMs(this.now));
        const contentHashValue = typeof record?.contentHash === 'string' ? record.contentHash : null;
        const normHash = typeof record?.normHash === 'string' ? record.normHash : null;
        const existing = this.db(scope, ownerId).prepare('SELECT content_hash, norm_hash FROM memory_tombstones WHERE id=?').get(id);
        this.db(scope, ownerId).prepare('INSERT OR REPLACE INTO memory_tombstones(id, content_hash, norm_hash, updated_at) VALUES(?,?,?,?)')
            .run(id, contentHashValue ?? existing?.content_hash ?? null, normHash ?? existing?.norm_hash ?? null, at);
        return true;
    }

    update(scope, ownerId, id, patch = {}) {
        const db = this.db(scope, ownerId);
        const row = db.prepare('SELECT * FROM memories WHERE id=?').get(String(id));
        if (row === undefined) return undefined;
        const current = mapMemory(row);
        const title = patch.title !== undefined ? neutralizeMemory(patch.title).trim().slice(0, 160) : current.title;
        const content = patch.content !== undefined ? neutralizeMemory(patch.content).trim() : current.content;
        if (title === '' || content === '') throw new Error('memory title and content are required');
        if (content.length > MAX_CONTENT) throw new Error('memory content is too long');
        const kind = patch.kind !== undefined && ['profile', 'fact', 'decision', 'episode', 'handoff', 'scene'].includes(patch.kind) ? patch.kind : current.kind;
        const visibility = patch.visibility === undefined && scope !== 'global'
            ? current.visibility
            : this.visibilityFor(scope, patch.visibility === undefined ? current.visibility : patch.visibility);
        const tags = Array.isArray(patch.tags) ? patch.tags.filter(tag => typeof tag === 'string').slice(0, 24) : current.tags;
        const importance = patch.importance === undefined ? current.importance : Math.max(0, Math.min(1, Number(patch.importance)));
        const hash = contentHash(title, content);
        const clash = db.prepare('SELECT id FROM memories WHERE content_hash=? AND id<>?').get(hash, String(id));
        if (clash !== undefined) throw new Error('memory already exists');
        const at = nowMs(this.now);
        db.exec('BEGIN IMMEDIATE');
        try {
            db.prepare('UPDATE memories SET kind=?, title=?, content=?, importance=?, visibility=?, tags=?, updated_at=?, content_hash=? WHERE id=?')
                .run(kind, title, content, importance, visibility, JSON.stringify(tags), at, hash, String(id));
            const memory = mapMemory(db.prepare('SELECT * FROM memories WHERE id=?').get(String(id)));
            this.insertFts(db, memory);
            const vector = hashEmbed(title + '\n' + content, HASH_DIM);
            db.prepare(`INSERT INTO memory_vectors(memory_id,provider,model,dim,vector) VALUES(?,?,?,?,?)
                ON CONFLICT(memory_id) DO UPDATE SET provider=excluded.provider, model=excluded.model, dim=excluded.dim, vector=excluded.vector`)
                .run(String(id), HASH_PROVIDER, 'hash-384', HASH_DIM, vectorToBuffer(vector));
            db.exec('COMMIT');
            return memory;
        }
        catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* closed */ }
            throw error;
        }
    }

    mapProposal(row) {
        if (row === undefined) return undefined;
        return {
            id: row.id, status: row.status, agentId: row.agent_id, kind: row.kind, title: row.title,
            content: row.content, importance: Number(row.importance), tags: parseTags(row.tags),
            visibility: row.visibility, createdAt: Number(row.created_at),
            resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? undefined : Number(row.resolved_at),
        };
    }

    propose(entry, context = {}) {
        const title = neutralizeMemory(entry.title ?? '').trim().slice(0, 160);
        const content = neutralizeMemory(entry.content ?? '').trim();
        if (title === '' || content === '') throw new Error('memory title and content are required');
        const kind = ['profile', 'fact', 'decision', 'episode', 'handoff', 'scene'].includes(entry.kind) ? entry.kind : 'fact';
        const visibility = normalizeGlobalVisibility(entry.visibility);
        const tags = Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string').slice(0, 24) : [];
        const importance = Math.max(0, Math.min(1, Number(entry.importance ?? 0.5)));
        const at = nowMs(this.now);
        const id = randomUUID();
        const agentId = typeof context.agentId === 'string' && context.agentId !== '' ? context.agentId : 'unknown';
        this.db('global', 'global').prepare(`INSERT INTO memory_proposals
            (id,status,agent_id,kind,title,content,importance,tags,visibility,created_at,resolved_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`)
            .run(id, 'pending', agentId, kind, title, content, importance, JSON.stringify(tags), visibility, at);
        return this.mapProposal(this.db('global', 'global').prepare('SELECT * FROM memory_proposals WHERE id=?').get(id));
    }

    listProposals(status = 'pending') {
        const rows = this.db('global', 'global').prepare('SELECT * FROM memory_proposals WHERE status=? ORDER BY created_at ASC').all(status);
        return rows.map(row => this.mapProposal(row));
    }

    getProposal(id) {
        return this.mapProposal(this.db('global', 'global').prepare('SELECT * FROM memory_proposals WHERE id=?').get(String(id)));
    }

    approveProposal(id, edits = {}) {
        const proposal = this.getProposal(id);
        if (proposal === undefined || proposal.status !== 'pending') return undefined;
        const title = edits.title !== undefined ? edits.title : proposal.title;
        const content = edits.content !== undefined ? edits.content : (edits.text !== undefined ? edits.text : proposal.content);
        const visibility = edits.visibility === undefined ? proposal.visibility : edits.visibility;
        const memory = this.remember('global', 'global', {
            kind: proposal.kind, title, content, importance: proposal.importance, tags: proposal.tags, visibility,
        });
        if (memory === undefined) return undefined;
        this.db('global', 'global').prepare("UPDATE memory_proposals SET status='approved', resolved_at=? WHERE id=?")
            .run(nowMs(this.now), proposal.id);
        return { proposal: this.getProposal(proposal.id), memory };
    }

    rejectProposal(id) {
        const proposal = this.getProposal(id);
        if (proposal === undefined || proposal.status !== 'pending') return undefined;
        this.db('global', 'global').prepare("UPDATE memory_proposals SET status='rejected', resolved_at=? WHERE id=?")
            .run(nowMs(this.now), proposal.id);
        return this.getProposal(proposal.id);
    }

    applyRemote(scope, ownerId, record) {
        if (record === null || typeof record !== 'object') return undefined;
        if (record.tombstone === true || this.hasTombstone(scope, ownerId, record.id)) {
            this.applyTombstone(scope, ownerId, record);
            return undefined;
        }
        if (typeof record.title !== 'string' || typeof record.content !== 'string') return undefined;
        const existing = this.db(scope, ownerId).prepare('SELECT * FROM memories WHERE content_hash=?').get(contentHash(record.title, record.content));
        if (existing !== undefined) {
            if (Number(existing.updated_at) >= Number(record.updatedAt ?? 0)) return mapMemory(existing);
            const db = this.db(scope, ownerId);
            db.prepare('UPDATE memories SET importance=?, pinned=?, visibility=?, tags=?, updated_at=? WHERE id=?')
                .run(Math.max(0, Math.min(1, Number(record.importance ?? 0.5))), record.pinned ? 1 : 0, this.visibilityFor(scope, record.visibility), JSON.stringify(Array.isArray(record.tags) ? record.tags : []), Number(record.updatedAt ?? nowMs(this.now)), existing.id);
            return mapMemory(db.prepare('SELECT * FROM memories WHERE id=?').get(existing.id));
        }
        return this.remember(scope, ownerId, {
            kind: record.kind, title: record.title, content: record.content,
            importance: record.importance, pinned: record.pinned,
            visibility: record.visibility, tags: record.tags,
        }, { sessionId: record.sourceSession, deviceId: record.sourceDevice, id: record.id });
    }

    decay(scope, ownerId) {
        const db = this.db(scope, ownerId);
        const at = nowMs(this.now);
        const rows = db.prepare('SELECT * FROM memories WHERE archived=0').all();
        let changed = 0;
        const update = db.prepare('UPDATE memories SET clarity=?, retention=? WHERE id=?');
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const row of rows) {
                const created = Number(row.created_at) || at;
                const seen = Number(row.last_seen_at ?? row.updated_at ?? created);
                const ageDays = Math.max(0, (at - created) / 86_400_000);
                const sinceSeen = Math.max(0, (at - seen) / 86_400_000);
                const important = Number(row.pinned) === 1 || row.kind === 'profile' || row.kind === 'handoff' || row.kind === 'decision';
                if (Number(row.pinned) === 1) {
                    if (row.clarity !== 'vivid' || Number(row.retention) !== 100) { update.run('vivid', 100, row.id); changed++; }
                    continue;
                }
                let retention = Number(row.importance) * 100;
                retention += Math.min(12, Number(row.recall_count ?? 0) * 2);
                if (ageDays <= 7) retention += 18;
                if (sinceSeen <= 2) retention += 8;
                retention -= Math.min(80, Math.max(0, ageDays - 7) * (important ? 0.12 : 0.35));
                if (important) retention = Math.max(retention, 55);
                retention = Math.max(8, Math.min(100, retention));
                const clarity = retention >= 68 ? 'vivid' : retention >= 46 ? 'clear' : retention >= 24 ? 'fuzzy' : 'trace';
                if (row.clarity !== clarity || Math.abs(Number(row.retention) - retention) > 0.01) { update.run(clarity, retention, row.id); changed++; }
            }
            db.exec('COMMIT');
        }
        catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* closed */ }
            throw error;
        }
        return changed;
    }

    health(scopes) {
        return scopes.map(({ scope, ownerId }) => {
            const db = this.db(scope, ownerId);
            const byClarity = db.prepare('SELECT clarity, count(*) AS n FROM memories WHERE archived=0 GROUP BY clarity').all();
            const archived = Number(db.prepare('SELECT count(*) AS n FROM memory_archive').get().n);
            const fuzzy = byClarity.filter(row => row.clarity === 'fuzzy' || row.clarity === 'trace').reduce((sum, row) => sum + Number(row.n), 0);
            const total = byClarity.reduce((sum, row) => sum + Number(row.n), 0);
            return { scope, ownerId, total, archived, fuzzy, byClarity };
        });
    }

    stats(scopes) {
        return scopes.map(({ scope, ownerId }) => {
            const db = this.db(scope, ownerId);
            const total = Number(db.prepare('SELECT count(*) AS n FROM memories').get().n);
            const pinned = Number(db.prepare('SELECT count(*) AS n FROM memories WHERE pinned=1').get().n);
            const byKind = db.prepare('SELECT kind, count(*) AS n FROM memories WHERE archived=0 GROUP BY kind').all();
            const byClarity = db.prepare('SELECT clarity, count(*) AS n FROM memories WHERE archived=0 GROUP BY clarity').all();
            const archived = Number(db.prepare('SELECT count(*) AS n FROM memory_archive').get().n);
            return { scope, ownerId, total, pinned, byKind, byClarity, archived, file: this.dbPath(scope, ownerId) };
        });
    }

    close() {
        for (const db of this.dbs.values()) { try { db.close(); } catch { /* already closed */ } }
        this.dbs.clear();
    }
}
