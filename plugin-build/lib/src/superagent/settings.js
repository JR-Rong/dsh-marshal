/**
 * superagent bridge settings: a small, local, atomically written JSON file.
 *
 * The bridge is deliberately configured by the operator's own machine, not by
 * the profile patch: settings live in ~/.dsh-marshal/superagent so a card
 * written by an agent can never change who gets woken. Unknown or malformed
 * values fall back to safe defaults and are reported, never guessed at.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SETTINGS_VERSION = 1;
export const DEFAULT_TAG_PREFIX = '@';
const MAX_ALIASES = 50;

function text(value, max) {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > max) return undefined;
    return trimmed;
}

function integer(value, fallback, min, max) {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return fallback;
    return value;
}

function boolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

export function defaultSettings(now = Date.now()) {
    return {
        version: SETTINGS_VERSION,
        enabled: true,
        autoDispatchTodo: true,
        defaultAgent: null,
        rootOnly: true,
        tagPrefix: DEFAULT_TAG_PREFIX,
        aliases: {},
        injectMemory: true,
        memoryLimit: 6,
        maxDispatchesPerMinute: 10,
        updatedAt: now,
    };
}

/** Directory the bridge owns; MARSHAL_SUPERAGENT_ROOT exists for tests and development. */
export function resolveRoot(env = process.env, home = homedir()) {
    const override = env.MARSHAL_SUPERAGENT_ROOT;
    if (typeof override === 'string' && override.trim() !== '') return override.trim();
    return join(home, '.dsh-marshal', 'superagent');
}

export function normalizeSettings(raw, now = Date.now()) {
    const base = defaultSettings(now);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base;
    const value = raw;
    const aliases = {};
    if (value.aliases !== null && typeof value.aliases === 'object' && !Array.isArray(value.aliases)) {
        let count = 0;
        for (const [key, entry] of Object.entries(value.aliases)) {
            if (count >= MAX_ALIASES) break;
            const from = text(key, 64);
            const to = text(entry, 64);
            if (from === undefined || to === undefined) continue;
            aliases[from] = to;
            count += 1;
        }
    }
    return {
        version: SETTINGS_VERSION,
        enabled: boolean(value.enabled, base.enabled),
        autoDispatchTodo: boolean(value.autoDispatchTodo, base.autoDispatchTodo),
        defaultAgent: text(value.defaultAgent, 64) ?? null,
        rootOnly: boolean(value.rootOnly, base.rootOnly),
        tagPrefix: text(value.tagPrefix, 8) ?? base.tagPrefix,
        aliases,
        injectMemory: boolean(value.injectMemory, base.injectMemory),
        memoryLimit: integer(value.memoryLimit, base.memoryLimit, 0, 6),
        maxDispatchesPerMinute: integer(value.maxDispatchesPerMinute, base.maxDispatchesPerMinute, 1, 60),
        updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : now,
    };
}

export function createSettingsStore(root, options = {}) {
    const now = options.now ?? Date.now;
    const logger = options.logger ?? { warn: () => {} };
    const file = join(root, 'settings.json');
    let current = defaultSettings(now());
    let error;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        current = normalizeSettings(parsed, now());
    }
    catch (cause) {
        if (cause?.code !== 'ENOENT') {
            error = 'settings-unreadable: ' + (cause instanceof Error ? cause.message : String(cause));
            logger.warn?.('marshal-superagent: ' + error);
        }
    }
    const save = () => {
        mkdirSync(dirname(file), { recursive: true });
        const temp = file + '.tmp-' + randomUUID();
        writeFileSync(temp, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
        renameSync(temp, file);
    };
    if (error === undefined) {
        try { save(); }
        catch (cause) {
            error = 'settings-unwritable: ' + (cause instanceof Error ? cause.message : String(cause));
            logger.warn?.('marshal-superagent: ' + error);
        }
    }
    return {
        file,
        get: () => current,
        error: () => error,
        update(patch) {
            current = normalizeSettings({ ...current, ...(patch ?? {}), updatedAt: now() }, now());
            error = undefined;
            try { save(); }
            catch (cause) {
                error = 'settings-unwritable: ' + (cause instanceof Error ? cause.message : String(cause));
                logger.warn?.('marshal-superagent: ' + error);
                throw new Error(error);
            }
            return current;
        },
        reload() {
            try {
                current = normalizeSettings(JSON.parse(readFileSync(file, 'utf8')), now());
                error = undefined;
            }
            catch (cause) {
                error = 'settings-unreadable: ' + (cause instanceof Error ? cause.message : String(cause));
            }
            return current;
        },
    };
}
