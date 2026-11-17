import { createHash } from 'node:crypto';

const DIM = 384;

/** CJK characters and common full-width punctuation. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

/**
 * Deterministic lexical tokens for Chinese + Latin text.
 * Chinese is expanded to bigrams and trigrams so FTS5 unicode61 can match
 * substrings without a trigram tokenizer (which needs 3 characters).
 */
export function memoryTokens(text) {
    const source = String(text ?? '').toLowerCase();
    const out = new Set();
    for (const match of source.matchAll(/[\p{Script=Han}]+/gu)) {
        const run = match[0];
        if (run.length === 1) out.add(run);
        else {
            out.add(run);
            for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
            for (let i = 0; i + 3 <= run.length; i++) out.add(run.slice(i, i + 3));
        }
    }
    for (const match of source.matchAll(/[a-z0-9][a-z0-9._-]*/g)) {
        if (match[0].length > 1) out.add(match[0]);
    }
    return [...out];
}

export function memorySearchText(...parts) {
    return memoryTokens(parts.filter(Boolean).join(' ')).join(' ');
}

function hash32(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Signed feature hashing; stable across processes and Node versions. */
export function hashEmbed(text, dim = DIM) {
    const vector = new Float32Array(dim);
    const counts = new Map();
    for (const token of memoryTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [token, count] of counts) {
        const hash = hash32(token);
        const index = hash % dim;
        const sign = (hash & 0x80000000) === 0 ? 1 : -1;
        vector[index] += sign * (1 + Math.log1p(count));
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < dim; i++) vector[i] /= norm;
    return vector;
}

export function vectorToBuffer(vector) {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bufferToVector(buffer) {
    if (buffer === null || buffer === undefined) return undefined;
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

export function cosine(a, b) {
    if (a === undefined || b === undefined || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
}

export function contentHash(title, content) {
    return createHash('sha256').update(String(title) + '\n' + String(content)).digest('hex');
}

export const HASH_PROVIDER = 'hash';
export const HASH_DIM = DIM;
