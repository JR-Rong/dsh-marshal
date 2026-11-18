import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ensureDir, nowIso, readJson, slugify, writeJson } from '../dispatch/store.js';
import { atomicWriteFile } from '../hub/state-file.js';

/**
 * 两级记忆（借鉴淋雨家工作台的「记忆在文件不在会话」+ 六层里的 L1/L2）：
 *
 *   global/         跨工作区共享，短、稳定、只放「不读就会白干」的东西
 *     rules.md      全局铁律
 *     profile.md    机主 / 设备 / 长期约束 + 跨工作区沉淀
 *     index.json    工作区登记表（slug ↔ 路径 ↔ 最后活跃）
 *
 *   workspaces/<slug>/
 *     handoff.md    §〇 当前交接（覆盖写，4 KB 红线，五小节）
 *     notes.md      项目结论（追加，单次 ≤10 行 / 2 KB，8 KB 软红线）
 *     archive/      旧版交接与完成工单的档案层（只进不改）
 *
 * 判据照搬：只记结论不记过程；写回要短；交接前先归档；换会话不丢记忆。
 */

export const MAX_HANDOFF_BYTES = 4096;
export const MAX_NOTES_BYTES = 8192;
export const MAX_GLOBAL_BYTES = 8192;
export const MAX_WRITE_LINES = 10;
export const MAX_WRITE_BYTES = 2048;
export const MAX_ARCHIVE_FILES = 20;

const SEED_RULES = `# 全局铁律（跨工作区，保持短）

1. 记忆在文件，不在会话：收工 / 换会话前先写工作区 handoff。
2. 只记结论不记过程：单次写回 ≤10 行，过程留在会话里。
3. 一单一 owner：同一件事同一时刻只有一个负责人；完成必须有验收和证据。
4. 场景主权：只写自己的工作区记忆；跨工作区结论用 promote 沉淀到全局。
`;

const SEED_PROFILE = `# 全局画像（机主 / 设备 / 长期约束）

- 设备：
- 使用者：
- 长期约束：

## 跨工作区沉淀
（用 marshal_memory promote 追加，只放三个月后仍然有用的结论）
`;

export class MemoryError extends Error {
    constructor(code, detail) {
        super(`marshal-memory: ${code}${detail === undefined ? '' : `: ${detail}`}`);
        this.name = 'MemoryError';
        this.code = code;
    }
}

const bytes = text => Buffer.byteLength(text, 'utf8');
const lines = text => text.split('\n').length;

function readText(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}

export class MemoryStore {
    constructor(root, now = Date.now) {
        this.root = root;
        this.now = now;
        this.globalDir = join(root, 'global');
        this.workspacesDir = join(root, 'workspaces');
        this.indexFile = join(this.globalDir, 'index.json');
    }

    ensure() {
        ensureDir(this.root);
        ensureDir(this.globalDir);
        ensureDir(this.workspacesDir);
        const rules = join(this.globalDir, 'rules.md');
        const profile = join(this.globalDir, 'profile.md');
        if (!existsSync(rules))
            atomicWriteFile(rules, SEED_RULES);
        if (!existsSync(profile))
            atomicWriteFile(profile, SEED_PROFILE);
        if (!existsSync(this.indexFile))
            writeJson(this.indexFile, { version: 1, workspaces: {} });
        return this;
    }

    index() {
        const data = readJson(this.indexFile, { version: 1, workspaces: {} });
        if (typeof data.workspaces !== 'object' || data.workspaces === null)
            data.workspaces = {};
        return data;
    }

    saveIndex(data) {
        writeJson(this.indexFile, data);
    }

    /** 工作区标识：路径 → 稳定 slug（目录名 + 路径哈希，重名不冲突）。 */
    slugFor(cwd) {
        if (typeof cwd !== 'string' || cwd.trim() === '' || !cwd.startsWith('/'))
            throw new MemoryError('invalid-cwd', 'an absolute workspace cwd is required');
        const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 6);
        return `${slugify(basename(cwd.trim()) || 'root')}-${hash}`;
    }

    /** 解析并登记一个工作区；返回 {slug, dir, record}。 */
    workspaceFor(cwd) {
        this.ensure();
        const slug = this.slugFor(cwd);
        const dir = join(this.workspacesDir, slug);
        ensureDir(join(dir, 'archive'));
        const index = this.index();
        const record = index.workspaces[slug] ?? { path: cwd, title: basename(cwd) || slug, created: nowIso(this.now), lastActive: null };
        index.workspaces[slug] = { ...record, path: cwd, lastActive: nowIso(this.now) };
        this.saveIndex(index);
        return { slug, dir, record: index.workspaces[slug] };
    }

    /** 已登记工作区（最近活跃在前）。 */
    list(limit = 20) {
        this.ensure();
        const index = this.index();
        const items = Object.entries(index.workspaces)
            .map(([slug, record]) => ({ slug, ...record }))
            .sort((a, b) => String(b.lastActive ?? '').localeCompare(String(a.lastActive ?? '')));
        return items.slice(0, Math.max(1, Math.min(limit, 100)));
    }

    /** 读全局或工作区记忆；返回 {file, path, bytes, text}。 */
    read({ scope = 'workspace', file = 'handoff', cwd } = {}) {
        this.ensure();
        if (scope === 'global') {
            const path = join(this.globalDir, `${file}.md`);
            if (!['rules', 'profile'].includes(file))
                throw new MemoryError('invalid-args', 'global file must be rules|profile');
            const text = readText(path);
            if (text === undefined)
                throw new MemoryError('not-found', path);
            return { scope, file, path, bytes: bytes(text), text };
        }
        if (!['handoff', 'notes'].includes(file))
            throw new MemoryError('invalid-args', 'workspace file must be handoff|notes');
        const { dir, slug } = this.workspaceFor(cwd);
        const path = join(dir, `${file}.md`);
        const text = readText(path) ?? '';
        return { scope: 'workspace', slug, file, path, bytes: bytes(text), text };
    }

    /** 追加写入（notes / global profile）。写回判据：≤10 行、≤2 KB、只记结论。 */
    write({ scope = 'workspace', file = 'notes', cwd, content, by = null, approved = false } = {}) {
        this.ensure();
        if (typeof content !== 'string' || content.trim() === '')
            throw new MemoryError('invalid-args', 'content is required');
        const body = content.trim();
        if (lines(body) > MAX_WRITE_LINES)
            throw new MemoryError('too-long', `keep one write to ${MAX_WRITE_LINES} lines; move detail to a file and link it`);
        if (bytes(body) > MAX_WRITE_BYTES)
            throw new MemoryError('too-long', `keep one write to ${MAX_WRITE_BYTES} bytes`);
        if (scope === 'global') {
            if (approved !== true)
                throw new MemoryError('approval-required', 'global file memory is only written after owner approval');
            if (file !== 'profile' && file !== 'rules')
                throw new MemoryError('invalid-args', 'global writes go to profile or rules');
            const path = join(this.globalDir, file + '.md');
            const record = nowIso(this.now);
            const seed = file === 'rules' ? SEED_RULES : SEED_PROFILE;
            atomicWriteFile(path, `${readText(path) ?? seed}\n- [${record}]${by === null ? '' : ` (${by})`} ${body}\n`);
            return { scope, file, path, bytes: bytes(body) };
        }
        if (file !== 'notes')
            throw new MemoryError('invalid-args', 'workspace writes go to notes; use handoff for §〇');
        const { dir, slug } = this.workspaceFor(cwd);
        const path = join(dir, 'notes.md');
        const existing = readText(path) ?? `# 工作区笔记（${basename(cwd ?? '')}）\n`;
        const record = nowIso(this.now);
        const appended = `${existing}\n- [${record}]${by === null ? '' : ` (${by})`} ${body}\n`;
        atomicWriteFile(path, appended);
        return { scope, slug, file, path, bytes: bytes(appended), warning: bytes(appended) > MAX_NOTES_BYTES ? `notes > ${MAX_NOTES_BYTES} bytes, split or archive` : null };
    }

    /** §〇 交接：覆盖写，旧版归档。先归档，再写新版。 */
    handoff({ cwd, last, projects = [], next, blockers = '无', by = null } = {}) {
        this.ensure();
        const { dir, slug } = this.workspaceFor(cwd);
        const path = join(dir, 'handoff.md');
        const previous = readText(path);
        if (previous !== undefined && previous.trim() !== '')
            this.#archive(dir, `handoff-${stamp(this.now())}.md`, previous);
        const rows = projects.length === 0
            ? '| 无 | — | — |'
            : projects.map(item => `| ${cell(item.name ?? '未命名')} | ${cell(item.status ?? '进行中')} | ${cell(item.next ?? '—')} |`).join('\n');
        const body = [
            '## §〇 当前交接（≤ 4 KB）',
            '',
            '### 1) 上次交接',
            String(last ?? '无').trim(),
            '',
            '### 2) 当前项目',
            '| 项目 | 状态 | 下一步 |',
            '| --- | --- | --- |',
            rows,
            '',
            '### 3) 下一步 / 卡点',
            `- 下一步：${String(next ?? '未写明').trim()}`,
            `- 卡点：${String(blockers ?? '无').trim()}`,
            '',
            `<!-- written at ${nowIso(this.now)}${by === null ? '' : ` by ${by}`} -->`,
            '',
        ].join('\n');
        if (bytes(body) > MAX_HANDOFF_BYTES)
            throw new MemoryError('too-long', `handoff is ${bytes(body)} bytes (limit ${MAX_HANDOFF_BYTES}); shorten it and move detail to notes/archive`);
        atomicWriteFile(path, body);
        return { scope: 'workspace', slug, file: 'handoff', path, bytes: bytes(body), archived: previous !== undefined };
    }

    /** 跨工作区沉淀：工作区结论提升到全局 profile。 */
    promote({ cwd, content, by = null } = {}) {
        if (typeof content !== 'string' || content.trim() === '')
            throw new MemoryError('invalid-args', 'content is required');
        const body = content.trim();
        const patch = lines(body) > 3 || bytes(body) > 600
            ? `${body.slice(0, 600)}…`
            : body;
        const source = cwd === undefined ? '' : ` <${basename(cwd)}>`;
        return this.write({ scope: 'global', file: 'profile', content: `${patch}${source}`, by });
    }

    /** 体检：交接是否可读、是否超线、是否缺小节。 */
    check({ cwd } = {}) {
        this.ensure();
        const issues = [];
        const workspace = this.workspaceFor(cwd);
        const handoff = readText(join(workspace.dir, 'handoff.md'));
        if (handoff === undefined || handoff.trim() === '') {
            issues.push('handoff.md 不存在：换会话前先写 §〇');
        }
        else {
            const size = bytes(handoff);
            if (size > MAX_HANDOFF_BYTES)
                issues.push(`handoff ${size} B > ${MAX_HANDOFF_BYTES} B`);
            for (const [label, pattern] of [
                ['上次交接', /上次交接/],
                ['当前项目', /当前项目/],
                ['下一步', /下一步/],
                ['卡点', /卡点/],
            ]) {
                if (!pattern.test(handoff))
                    issues.push(`handoff 缺小节：${label}`);
            }
        }
        const notes = readText(join(workspace.dir, 'notes.md'));
        if (notes !== undefined && bytes(notes) > MAX_NOTES_BYTES)
            issues.push(`notes ${bytes(notes)} B > ${MAX_NOTES_BYTES} B，拆到 archive 或拆文件`);
        const rules = readText(join(this.globalDir, 'rules.md')) ?? '';
        if (bytes(rules) > MAX_GLOBAL_BYTES)
            issues.push(`global rules ${bytes(rules)} B > ${MAX_GLOBAL_BYTES} B，铁律必须短`);
        return { ok: issues.length === 0, issues, workspace: { slug: workspace.slug, path: workspace.record.path } };
    }

    /**
     * Short operational block injected beside SQLite memory.
     * Rules and the current workspace handoff only; notes stay on the tool.
     * Does not create files.
     */
    promptText(cwd) {
        const parts = [];
        const rules = (readText(join(this.globalDir, 'rules.md')) ?? '').trim();
        if (rules !== '') parts.push('【文件记忆·全局铁律】\n' + rules.slice(0, 1500));
        if (typeof cwd === 'string' && cwd.startsWith('/')) {
            try {
                const handoff = (readText(join(this.workspacesDir, this.slugFor(cwd), 'handoff.md')) ?? '').trim();
                if (handoff !== '') parts.push('【文件记忆·工作区交接】\n' + handoff.slice(0, 1500));
            }
            catch { /* cwd that cannot be a workspace slug contributes no handoff */ }
        }
        if (parts.length === 0) return '';
        return '<file-memory>\n' + parts.join('\n') + '\n</file-memory>\n';
    }

    /** 一线视图：全局摘要 + 工作区摘要 + 体检。 */
    status({ cwd } = {}) {
        this.ensure();
        const rules = readText(join(this.globalDir, 'rules.md')) ?? '';
        const profile = readText(join(this.globalDir, 'profile.md')) ?? '';
        const workspace = this.workspaceFor(cwd);
        const handoff = readText(join(workspace.dir, 'handoff.md')) ?? '';
        const notes = readText(join(workspace.dir, 'notes.md')) ?? '';
        const check = this.check({ cwd });
        return {
            global: {
                rules: { bytes: bytes(rules), preview: rules.trim().slice(0, 300) },
                profile: { bytes: bytes(profile), preview: profile.trim().slice(0, 300) },
            },
            workspace: {
                slug: workspace.slug,
                path: workspace.record.path,
                handoff: { bytes: bytes(handoff), preview: handoff.trim().slice(0, 500) },
                notes: { bytes: bytes(notes) },
            },
            check,
            workspaces: this.list(10),
        };
    }

    /** 完成工单写档案层（只进不改）。 */
    archiveTicket(ticket, cwd) {
        try {
            const { dir } = this.workspaceFor(cwd);
            const path = join(dir, 'archive', 'tickets.md');
            const existing = readText(path) ?? '# 工单档案\n\n';
            const verify = ticket.verification === null || ticket.verification === undefined ? '—' : `${ticket.verification.verdict} by ${ticket.verification.by}`;
            const line = `- ${nowIso(this.now)} [done] ${ticket.title} (${ticket.id}) owner=${ticket.owner ?? '—'} evidence=${(ticket.evidence ?? []).length} verify=${verify}\n`;
            atomicWriteFile(path, existing + line);
        }
        catch {
            // 档案失败不能影响工单完成。
        }
    }

    #archive(dir, name, content) {
        try {
            const archiveDir = join(dir, 'archive');
            ensureDir(archiveDir);
            atomicWriteFile(join(archiveDir, name), content);
            const files = readdirSync(archiveDir)
                .filter(file => file.startsWith('handoff-') && file.endsWith('.md'))
                .map(file => ({ file, mtime: statSync(join(archiveDir, file)).mtimeMs }))
                .sort((a, b) => a.mtime - b.mtime);
            while (files.length > MAX_ARCHIVE_FILES) {
                const oldest = files.shift();
                try {
                    unlinkSync(join(archiveDir, oldest.file));
                }
                catch { /* 另一个写者刚清过 */ }
            }
        }
        catch { /* 归档尽力而为 */ }
    }
}

function stamp(ms) {
    return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function cell(value) {
    return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
}
