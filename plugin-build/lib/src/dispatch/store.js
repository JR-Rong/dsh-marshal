import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFile, ensurePrivateDir, withFileLock } from '../hub/state-file.js';

/**
 * 派单台账的底层存储：单文件 JSON（原子写 + 进程间锁）+ 追加式事件日志。
 * 与 journal 同源（hub/state-file），不引入新依赖。
 */
export function readJson(path, fallback) {
    try {
        const text = readFileSync(path, 'utf8');
        return JSON.parse(text);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return fallback;
        throw error;
    }
}

export function writeJson(path, value) {
    const text = JSON.stringify(value, null, 2) + '\n';
    withFileLock(path, () => atomicWriteFile(path, text));
}

export function appendJsonLine(path, value) {
    ensurePrivateDir(dirname(path));
    appendFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 });
}

export function ensureDir(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function nowIso(now = Date.now) {
    return new Date(now()).toISOString();
}

export function slugify(text) {
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace';
}

export { join };
