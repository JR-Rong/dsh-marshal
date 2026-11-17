import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
/**
 * Codex 入口解析：只接受显式配置、PATH 中存在且可执行的绝对路径。
 * 不内置任何机器路径，不读取凭据内容，也不执行找不到的候选。
 */
export const CODEX_APP_SERVER_ARGS = ['app-server', '--stdio'];
function defaultIsFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function defaultIsExecutable(path) {
    try {
        accessSync(path, fsConstants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
const WINDOWS_EXTENSIONS = ['.EXE', '.CMD', '.BAT', '.COM'];
/** Windows 的 PATH 查找需要 PATHEXT；显式路径仍按原样检查。 */
function windowsCandidates(name, env) {
    if (WINDOWS_EXTENSIONS.some(extension => name.toLowerCase().endsWith(extension.toLowerCase()))) {
        return [name];
    }
    const custom = env.PATHEXT?.split(';').filter(part => part.trim() !== '') ?? [];
    const extensions = custom.length === 0 ? [...WINDOWS_EXTENSIONS] : custom;
    return extensions.map(extension => `${name}${extension}`);
}
export function resolveCodexBinary(options = {}) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const isFile = options.isFile ?? defaultIsFile;
    const isExecutable = options.isExecutable ?? defaultIsExecutable;
    const explicit = options.explicitPath;
    if (explicit !== undefined) {
        if (explicit === '' || !isAbsolute(explicit))
            return { ok: false, reason: 'config-invalid' };
        if (!isFile(explicit))
            return { ok: false, reason: 'config-invalid' };
        // Windows 不依赖 X_OK；显式路径本身已经由配置者负责。
        if (platform !== 'win32' && !isExecutable(explicit))
            return { ok: false, reason: 'config-invalid' };
        return {
            ok: true,
            entry: { command: explicit, args: [...CODEX_APP_SERVER_ARGS], source: 'config' },
        };
    }
    const rawPath = env.PATH ?? '';
    const directories = rawPath.split(delimiter).filter(directory => directory !== '');
    const names = platform === 'win32' ? windowsCandidates('codex', env) : ['codex'];
    for (const directory of directories) {
        // 相对 PATH 项缺少解析基准；不把 cwd 当成可靠证据。
        if (!isAbsolute(directory))
            continue;
        for (const name of names) {
            const candidate = join(directory, name);
            if (!isFile(candidate))
                continue;
            if (platform !== 'win32' && !isExecutable(candidate))
                continue;
            return {
                ok: true,
                entry: { command: candidate, args: [...CODEX_APP_SERVER_ARGS], source: 'path' },
            };
        }
    }
    return { ok: false, reason: 'not-installed' };
}
