import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskError } from './pr-material.js';

export const INLINE_PATCH_LIMIT = 44 * 1024;
export const MAX_STORED_PATCH_BYTES = 2 * 1024 * 1024;
export const PATCH_ARTIFACT_PREFIX = '<!--marshal-patch-artifact:';
export const PATCH_ARTIFACT_SUFFIX = '-->';
const DIGEST_RE = /^[a-f\d]{64}$/;

export function summarizePatch(patchText) {
    const text = String(patchText ?? '');
    const files = [];
    let additions = 0;
    let deletions = 0;
    for (const line of text.split('\n')) {
        if (line.startsWith('diff --git ')) {
            const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
            const name = match ? match[2] : line.slice('diff --git '.length).trim();
            if (name && !files.includes(name)) files.push(name);
        } else if (line.startsWith('+') && !line.startsWith('+++ ')) {
            additions += 1;
        } else if (line.startsWith('-') && !line.startsWith('--- ')) {
            deletions += 1;
        }
    }
    return {
        bytes: Buffer.byteLength(text, 'utf8'),
        fileCount: files.length,
        files,
        additions,
        deletions,
    };
}

export function extractPatchTouchedFiles(patchText) {
    const text = String(patchText ?? '');
    const files = new Set();
    let currentA;
    let currentB;
    const flush = () => {
        if (currentA && currentA !== '/dev/null') files.add(currentA);
        if (currentB && currentB !== '/dev/null') files.add(currentB);
        currentA = undefined;
        currentB = undefined;
    };
    for (const line of text.split('\n')) {
        if (line.startsWith('diff --git ')) {
            flush();
            const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
            if (m) {
                currentA = m[1];
                currentB = m[2];
            }
        } else if (line.startsWith('--- a/')) {
            currentA = line.slice('--- a/'.length).trim();
        } else if (line.startsWith('--- /dev/null')) {
            currentA = '/dev/null';
        } else if (line.startsWith('+++ b/')) {
            currentB = line.slice('+++ b/'.length).trim();
        } else if (line.startsWith('+++ /dev/null')) {
            currentB = '/dev/null';
        }
    }
    flush();
    return [...files].filter(p => p && !p.startsWith('/') && !p.includes('\0') && !p.split('/').includes('..'));
}

export function parsePatchArtifactHeader(text) {
    if (typeof text !== 'string' || !text.startsWith(PATCH_ARTIFACT_PREFIX)) return undefined;
    const end = text.indexOf(PATCH_ARTIFACT_SUFFIX, PATCH_ARTIFACT_PREFIX.length);
    if (end === -1) return undefined;
    const jsonText = text.slice(PATCH_ARTIFACT_PREFIX.length, end).trim();
    try {
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed !== 'object' || !DIGEST_RE.test(String(parsed.digest ?? ''))) return undefined;
        return {
            meta: parsed,
            body: text.slice(end + PATCH_ARTIFACT_SUFFIX.length).replace(/^\n+/, ''),
        };
    } catch {
        return undefined;
    }
}

export function formatPatchRoomRecord(patchText, { digest, stat = '', stored = false } = {}) {
    const text = String(patchText ?? '');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= INLINE_PATCH_LIMIT) return text;
    const summary = summarizePatch(text);
    const effectiveDigest = DIGEST_RE.test(String(digest ?? ''))
        ? digest
        : createHash('sha256').update(text).digest('hex');
    const meta = {
        v: 1,
        digest: effectiveDigest,
        bytes: summary.bytes,
        fileCount: summary.fileCount,
        files: summary.files.slice(0, 40),
        additions: summary.additions,
        deletions: summary.deletions,
        stored: Boolean(stored),
    };
    const encodedMeta = JSON.stringify(meta).replace(/-->/g, '--\\u003e');
    const previewBudget = 12 * 1024;
    const preview = Buffer.byteLength(text, 'utf8') > previewBudget
        ? Buffer.from(text, 'utf8').subarray(0, previewBudget).toString('utf8')
            + '\n\n…（完整补丁共 ' + (summary.bytes / 1024).toFixed(1) + ' KiB，涉及 ' + summary.fileCount
            + ' 个文件，已持久化存储；点击「下载 .patch」或「应用补丁」可获取完整补丁）'
        : text;
    const statBlock = typeof stat === 'string' && stat.trim()
        ? '# git diff --stat\n' + stat.trim().slice(0, 3000) + '\n\n'
        : '';
    return PATCH_ARTIFACT_PREFIX + encodedMeta + PATCH_ARTIFACT_SUFFIX + '\n' + statBlock + preview;
}

export function createPatchStore(dir) {
    const ensureDir = () => {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    };
    const pathFor = digest => {
        if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
            throw taskError('invalid-patch-digest', '补丁摘要格式无效。');
        }
        return join(dir, digest + '.patch');
    };
    return {
        dir,
        save(patchText, { digest } = {}) {
            const text = String(patchText ?? '');
            const bytes = Buffer.byteLength(text, 'utf8');
            if (bytes === 0) throw taskError('development-no-changes', '补丁内容为空。');
            if (bytes > MAX_STORED_PATCH_BYTES) {
                throw taskError('development-patch-too-large', '开发补丁超过持久化存储上限（2 MiB）。');
            }
            const computed = createHash('sha256').update(text).digest('hex');
            if (digest && digest !== computed) {
                throw taskError('invalid-patch-digest', '补丁摘要校验不一致。');
            }
            ensureDir();
            const filePath = pathFor(computed);
            if (!existsSync(filePath)) {
                const tmp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
                writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
                renameSync(tmp, filePath);
            }
            return { digest: computed, bytes, filePath, ...summarizePatch(text) };
        },
        has(digest) {
            if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) return false;
            return existsSync(join(dir, digest + '.patch'));
        },
        read(digest) {
            if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) return undefined;
            const filePath = join(dir, digest + '.patch');
            if (!existsSync(filePath)) return undefined;
            const text = readFileSync(filePath, 'utf8');
            const actual = createHash('sha256').update(text).digest('hex');
            if (actual !== digest) {
                throw taskError('patch-corrupted', '持久化补丁校验失败（SHA-256 不匹配）。');
            }
            return text;
        },
    };
}

export function resolvePatchText(recordText, recordRef, patchStore) {
    const parsed = parsePatchArtifactHeader(recordText);
    if (parsed) {
        const digest = parsed.meta.digest || recordRef;
        const stored = patchStore?.read?.(digest);
        if (typeof stored === 'string' && stored.trim() !== '') {
            return { text: stored, digest, meta: parsed.meta };
        }
        throw taskError('patch-artifact-missing', '未在本机补丁仓库找到对应的大补丁文件（' + String(digest ?? '').slice(0, 12) + '），请重新运行该工单生成补丁。');
    }
    if (typeof recordRef === 'string' && DIGEST_RE.test(recordRef) && patchStore?.has?.(recordRef)) {
        const stored = patchStore.read(recordRef);
        if (typeof stored === 'string' && stored.trim() !== '') {
            return { text: stored, digest: recordRef, meta: summarizePatch(stored) };
        }
    }
    const text = String(recordText ?? '');
    const digest = typeof recordRef === 'string' && recordRef ? recordRef : createHash('sha256').update(text).digest('hex');
    return { text, digest, meta: summarizePatch(text) };
}
