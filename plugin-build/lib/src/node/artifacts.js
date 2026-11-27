import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { redact } from './redact.js';

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_ARTIFACT_CHUNK_BYTES = 512 * 1024;
export const MAX_ARTIFACT_CHUNK_BYTES = 512 * 1024;

const BUILTIN_REDACT_PATTERNS = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gi,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /\bsk-[A-Za-z0-9_-]{16,}/gi,
    /\bghp_[A-Za-z0-9]{20,}/gi,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/gi,
    /\bAKIA[0-9A-Z]{16}\b/gi,
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|mssql|clickhouse):\/\/[^\s"'<>]+/gi,
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi,
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*[^\s,;]+/gi,
];

const BLOCKED_SEGMENTS = new Set([
    '.ssh', '.gnupg', '.aws', '.kube', '.dsh', '.dsh-marshal', '.docker',
    'keychains', 'cookies',
]);

const ALLOWED_ENV_NAMES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);

function isBlockedFileName(name) {
    const lower = name.toLowerCase();
    if (lower === '.env' || (lower.startsWith('.env.') && !ALLOWED_ENV_NAMES.has(lower)))
        return true;
    if (lower === '.netrc' || lower === '.npmrc' || lower === '.pypirc' || lower === '.git-credentials')
        return true;
    if (lower === 'id_rsa' || lower === 'id_ed25519' || lower === 'id_ecdsa' || lower === 'id_dsa')
        return true;
    if (lower === 'journal.key' || lower === 'dashboard-token.txt')
        return true;
    if (lower.endsWith('.pem') || lower.endsWith('.key') || lower.endsWith('.p12') || lower.endsWith('.pfx') || lower.endsWith('.jks'))
        return true;
    return false;
}

const IMAGE_MIMES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.avif': 'image/avif',
    '.heic': 'image/heic',
};

const VIDEO_MIMES = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
};

const AUDIO_MIMES = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
};

const TEXT_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonl', '.md', '.mdx', '.txt',
    '.py', '.rs', '.go', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs',
    '.css', '.scss', '.less', '.html', '.htm', '.xml', '.yml', '.yaml', '.toml', '.ini', '.conf',
    '.sh', '.zsh', '.bash', '.fish', '.sql', '.diff', '.patch', '.csv', '.tsv', '.log',
    '.vue', '.svelte', '.rb', '.php', '.lua', '.r', '.gradle', '.cmake', '.mk', '.plist',
    '.gitignore', '.editorconfig', '.prettierrc', '.eslintrc', '.npmrc',
]);

const TEXT_BASENAMES = new Set(['makefile', 'dockerfile', 'license', 'readme', 'changelog', 'cmakelists.txt']);

export function classifyFile(name) {
    const ext = extname(name).toLowerCase();
    if (IMAGE_MIMES[ext])
        return { kind: 'image', mime: IMAGE_MIMES[ext] };
    if (VIDEO_MIMES[ext])
        return { kind: 'video', mime: VIDEO_MIMES[ext] };
    if (AUDIO_MIMES[ext])
        return { kind: 'audio', mime: AUDIO_MIMES[ext] };
    if (ext === '.pdf')
        return { kind: 'pdf', mime: 'application/pdf' };
    if (TEXT_EXTENSIONS.has(ext) || TEXT_BASENAMES.has(name.toLowerCase())) {
        if (ext === '.md' || ext === '.mdx')
            return { kind: 'text', mime: 'text/markdown; charset=utf-8' };
        if (ext === '.json')
            return { kind: 'text', mime: 'application/json; charset=utf-8' };
        return { kind: 'text', mime: 'text/plain; charset=utf-8' };
    }
    return { kind: 'binary', mime: 'application/octet-stream' };
}

export function normalizeRequestedPath(rawPath) {
    let clean = rawPath.trim();
    if (!clean || clean.includes('\0'))
        return null;
    if (/^file:\/\//i.test(clean)) {
        try {
            const url = new URL(clean);
            clean = decodeURIComponent(url.pathname);
        }
        catch {
            clean = clean.replace(/^file:\/\//i, '').split(/[?#]/)[0] ?? '';
            try { clean = decodeURIComponent(clean); } catch { /* keep raw */ }
        }
    }
    else {
        clean = clean.replace(/#L\d+(?:-L?\d+)?$/i, '');
    }
    if (!clean || clean.includes('\0'))
        return null;
    if (clean === '~' || clean.startsWith('~/')) {
        clean = resolve(homedir(), clean.slice(2));
    }
    return clean;
}

function isWithinRoot(target, root) {
    const normalizedRoot = root.endsWith(sep) ? root : root + sep;
    return target === root || target.startsWith(normalizedRoot);
}

function defaultAllowedRoots() {
    const roots = [];
    for (const candidate of [homedir(), tmpdir(), '/Volumes']) {
        try { roots.push(realpathSync(candidate)); } catch { roots.push(resolve(candidate)); }
    }
    return roots;
}

function isPathAllowed(realPath, allowedRoots, explicitRoots) {
    const segments = realPath.split(sep).filter(Boolean);
    for (const seg of segments) {
        if (BLOCKED_SEGMENTS.has(seg.toLowerCase()))
            return false;
    }
    if (isBlockedFileName(basename(realPath)))
        return false;
    for (const root of explicitRoots) {
        if (isWithinRoot(realPath, root))
            return true;
    }
    let realHome = '';
    try { realHome = realpathSync(homedir()); } catch { realHome = resolve(homedir()); }
    const homeLibrary = resolve(realHome, 'Library');
    if (isWithinRoot(realPath, homeLibrary))
        return false;
    return allowedRoots.some((root) => isWithinRoot(realPath, root));
}

function looksLikeText(buf) {
    const checkLen = Math.min(buf.length, 8192);
    for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0)
            return false;
    }
    return true;
}

export function readArtifactChunk(options) {
    const normalized = normalizeRequestedPath(options.path);
    if (!normalized)
        return { ok: false, code: 'invalid-args' };
    const explicitRoots = [];
    for (const dir of [...(options.allowedRoots ?? []), ...(options.baseDirs ?? [])]) {
        try { explicitRoots.push(realpathSync(dir)); } catch { /* ignore nonexistent */ }
    }
    const allowedRoots = options.allowedRoots ? explicitRoots : defaultAllowedRoots();
    const candidates = isAbsolute(normalized)
        ? [normalized]
        : (options.baseDirs ?? []).map((dir) => resolve(dir, normalized));
    if (candidates.length === 0)
        return { ok: false, code: 'invalid-args' };
    let realPath = null;
    let sawAccessError = false;
    for (const candidate of candidates) {
        try {
            const resolved = realpathSync(candidate);
            if (!isPathAllowed(resolved, allowedRoots, explicitRoots)) {
                sawAccessError = true;
                continue;
            }
            realPath = resolved;
            break;
        }
        catch {
            continue;
        }
    }
    if (!realPath) {
        return { ok: false, code: sawAccessError ? 'unsupported' : 'record-unavailable' };
    }
    let stat;
    try {
        stat = statSync(realPath);
    }
    catch {
        return { ok: false, code: 'record-unavailable' };
    }
    if (!stat.isFile())
        return { ok: false, code: 'unsupported' };
    if (stat.size > MAX_ARTIFACT_BYTES)
        return { ok: false, code: 'size-limit' };
    const offset = options.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > stat.size) {
        return { ok: false, code: 'invalid-args' };
    }
    const requestedMax = options.maxBytes ?? DEFAULT_ARTIFACT_CHUNK_BYTES;
    const maxBytes = Math.max(1, Math.min(MAX_ARTIFACT_CHUNK_BYTES, Math.floor(requestedMax)));
    const toRead = Math.min(maxBytes, stat.size - offset);
    const buffer = Buffer.alloc(toRead);
    let bytesRead = 0;
    const fd = openSync(realPath, 'r');
    try {
        while (bytesRead < toRead) {
            const n = readSync(fd, buffer, bytesRead, toRead - bytesRead, offset + bytesRead);
            if (n <= 0)
                break;
            bytesRead += n;
        }
    }
    finally {
        closeSync(fd);
    }
    const slice = buffer.subarray(0, bytesRead);
    const name = basename(realPath);
    let { kind, mime } = classifyFile(name);
    if (kind === 'binary' && offset === 0 && looksLikeText(slice)) {
        kind = 'text';
        mime = 'text/plain; charset=utf-8';
    }
    const eof = offset + bytesRead >= stat.size;
    if (kind === 'text') {
        const rawText = slice.toString('utf8');
        const scrubbed = String(redact(rawText, BUILTIN_REDACT_PATTERNS));
        return {
            ok: true,
            name,
            mime,
            kind,
            size: stat.size,
            offset,
            bytes: bytesRead,
            eof,
            encoding: 'utf8',
            data: scrubbed,
        };
    }
    return {
        ok: true,
        name,
        mime,
        kind,
        size: stat.size,
        offset,
        bytes: bytesRead,
        eof,
        encoding: 'base64',
        data: slice.toString('base64'),
    };
}
