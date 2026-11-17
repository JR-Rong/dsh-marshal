import { unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { DeviceStore, DeviceStateError, emptyDevicesState, readDeviceState, serializeDevicesState, } from "./devices.js";
import { atomicWriteFile, ensurePrivateDir, readTextIfExists, withFileLock } from "./state-file.js";
/** operatorId 是 hub 安装的持久 owner 身份，跨登录/重启/token 轮换稳定。 */
export const IDENTITY_VERSION = 1;
export const INIT_INTENT_VERSION = 1;
/** 初始化意图超过一天仍未完成，按过期意图转人工恢复。 */
export const INIT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
/** 契约 §6：已初始化安装的身份/授权状态不可自动重建。 */
export class RecoveryRequiredError extends Error {
    name = 'RecoveryRequiredError';
    code = 'recovery-required';
    constructor(detail) {
        super(`marshal: recovery-required: ${detail}`);
    }
}
/** 契约 §3：operator 身份存在而设备表缺失是启动失败，不是空表。 */
export class StateDevicesMissingError extends Error {
    name = 'StateDevicesMissingError';
    code = 'state-devices-missing';
    constructor(path) {
        super(`marshal: state-devices-missing: ${path} is missing for an initialized install`);
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validOperatorId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(value);
}
function readJson(path, label) {
    let text;
    try {
        text = readTextIfExists(path);
    }
    catch {
        throw new RecoveryRequiredError(`${label} is unreadable; restore it from a trusted backup`);
    }
    if (text === undefined)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        throw new RecoveryRequiredError(`${label} is not valid JSON; restore it from a trusted backup`);
    }
}
function parseIdentity(value, devicesPath) {
    if (!isObject(value) || value.version !== IDENTITY_VERSION || !validOperatorId(value.operatorId)) {
        throw new RecoveryRequiredError('identity.json is corrupt; restore it from a trusted backup');
    }
    if (value.devicesPath !== undefined) {
        if (typeof value.devicesPath !== 'string' || value.devicesPath === '') {
            throw new RecoveryRequiredError('identity.json has an invalid devicesPath');
        }
        if (resolve(value.devicesPath) !== devicesPath) {
            throw new RecoveryRequiredError(`identity.json belongs to ${value.devicesPath}, not ${devicesPath}; inspect the state directory`);
        }
    }
    return {
        version: IDENTITY_VERSION,
        operatorId: value.operatorId,
        ...(value.devicesPath === undefined ? {} : { devicesPath }),
    };
}
function parseIntent(value) {
    if (!isObject(value)
        || value.version !== INIT_INTENT_VERSION
        || !validOperatorId(value.operatorId)
        || typeof value.devicesPath !== 'string'
        || value.devicesPath === ''
        || typeof value.createdAt !== 'number'
        || !Number.isInteger(value.createdAt)
        || value.createdAt < 0) {
        throw new RecoveryRequiredError('init-intent.json is corrupt; inspect the state directory before retrying');
    }
    return {
        version: INIT_INTENT_VERSION,
        operatorId: value.operatorId,
        devicesPath: value.devicesPath,
        createdAt: value.createdAt,
    };
}
function writeIdentity(path, operatorId, devicesPath) {
    const record = { version: IDENTITY_VERSION, operatorId, devicesPath };
    atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`, 0o600);
}
function writeIntent(path, intent) {
    atomicWriteFile(path, `${JSON.stringify(intent, null, 2)}\n`, 0o600);
}
function writeEmptyDevices(path) {
    atomicWriteFile(path, serializeDevicesState(emptyDevicesState()), 0o600);
}
function removeIntent(path) {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
/**
 * 只补做尚未完成的步骤：身份已存在时绝不能重建缺失的设备表（契约 §3），
 * 也不能覆盖既有身份，只能核对 operatorId/devicesPath 后沿用。
 */
function completeIntent(devicesPath, intent, identity, current, intentPath, identityPath) {
    if (intent.devicesPath !== devicesPath) {
        throw new RecoveryRequiredError(`init intent targets ${intent.devicesPath}, not ${devicesPath}; inspect the state directory before retrying`);
    }
    if (Date.now() - intent.createdAt > INIT_INTENT_TTL_MS) {
        throw new RecoveryRequiredError('init intent has expired; inspect the state directory before retrying');
    }
    if (identity !== undefined && identity.operatorId !== intent.operatorId) {
        throw new RecoveryRequiredError('init intent and identity.json disagree on operatorId; restore a trusted pair');
    }
    if (identity !== undefined && current === undefined) {
        // 已初始化安装的设备表缺失是启动失败；匹配意图也不能重建空表。
        throw new StateDevicesMissingError(devicesPath);
    }
    const initialized = identity === undefined;
    if (identity === undefined && current === undefined)
        writeEmptyDevices(devicesPath);
    if (identity === undefined)
        writeIdentity(identityPath, intent.operatorId, devicesPath);
    removeIntent(intentPath);
    const store = new DeviceStore(devicesPath);
    return { operatorId: intent.operatorId, store, initialized };
}
function initializeFresh(devicesPath, intentPath, identityPath) {
    const operatorId = randomBytes(32).toString('base64url');
    const intent = {
        version: INIT_INTENT_VERSION,
        operatorId,
        devicesPath,
        createdAt: Date.now(),
    };
    // 顺序固定：意图 → 空 v2 表 → 身份 → 清理意图。中途崩溃只能凭匹配意图续完。
    writeIntent(intentPath, intent);
    writeEmptyDevices(devicesPath);
    writeIdentity(identityPath, operatorId, devicesPath);
    removeIntent(intentPath);
    return { operatorId, store: new DeviceStore(devicesPath), initialized: true };
}
/**
 * 所有判断与写入都在 `<devicesFile>.lock` 内完成，并与 DeviceStore 共用同一把锁。
 * 并发首次启动只有一个赢家；输家在锁内重读后看到完整状态并幂等返回。
 */
function installLocked(devicesPath) {
    const dir = dirname(devicesPath);
    const identityPath = join(dir, 'identity.json');
    const intentPath = join(dir, 'init-intent.json');
    const identityRaw = readJson(identityPath, 'identity.json');
    const identity = identityRaw === undefined ? undefined : parseIdentity(identityRaw, devicesPath);
    const intentRaw = readJson(intentPath, 'init-intent.json');
    const intent = intentRaw === undefined ? undefined : parseIntent(intentRaw);
    let loaded;
    try {
        loaded = readDeviceState(devicesPath);
    }
    catch (error) {
        if (error instanceof DeviceStateError)
            throw error;
        throw new RecoveryRequiredError('device table cannot be read; inspect the state directory');
    }
    const current = loaded.kind === 'current' ? loaded.state : undefined;
    if (intent !== undefined) {
        if (loaded.kind === 'legacy') {
            throw new RecoveryRequiredError('init intent cannot complete over a v1 device table; run "marshal-device migrate"');
        }
        return completeIntent(devicesPath, intent, identity, current, intentPath, identityPath);
    }
    if (identity === undefined && loaded.kind === 'missing') {
        return initializeFresh(devicesPath, intentPath, identityPath);
    }
    if (identity === undefined) {
        const hint = loaded.kind === 'legacy'
            ? ' the table is still v1: run "marshal-device migrate" and point devicesFile at the new file'
            : ' restore the matching identity.json from a trusted backup';
        throw new RecoveryRequiredError(`device state exists but identity.json is missing;${hint}`);
    }
    if (loaded.kind === 'missing')
        throw new StateDevicesMissingError(devicesPath);
    if (loaded.kind === 'legacy') {
        throw new RecoveryRequiredError('device table is still v1; run "marshal-device migrate" and point devicesFile at the new file');
    }
    return { operatorId: identity.operatorId, store: new DeviceStore(devicesPath), initialized: false };
}
/**
 * hub 启动与 `marshal-device` 共用的初始化入口。
 * 只有所有状态都不存在时才新建安装；其余组合按契约 §3/§4 失败或转人工恢复。
 */
export function ensureInstall(devicesFile) {
    const devicesPath = resolve(devicesFile);
    ensurePrivateDir(dirname(devicesPath));
    return withFileLock(devicesPath, () => installLocked(devicesPath));
}
/**
 * 显式迁移对账：为已写好的 `.v2` 设备表补建同一目录下的身份。
 * 既有身份只核对并沿用（可补齐缺失的 devicesPath），绝不更换 operatorId。
 */
export function ensureMigratedIdentity(devicesFile) {
    const devicesPath = resolve(devicesFile);
    ensurePrivateDir(dirname(devicesPath));
    return withFileLock(devicesPath, () => {
        const loaded = readDeviceState(devicesPath);
        if (loaded.kind !== 'current') {
            throw new RecoveryRequiredError(`${devicesPath} is not a v2 device table; finish "marshal-device migrate" before creating identity.json`);
        }
        const identityPath = join(dirname(devicesPath), 'identity.json');
        const identityRaw = readJson(identityPath, 'identity.json');
        if (identityRaw !== undefined) {
            const identity = parseIdentity(identityRaw, devicesPath);
            if (identity.devicesPath === undefined) {
                // 只补元数据，operatorId 保持原值。
                writeIdentity(identityPath, identity.operatorId, devicesPath);
            }
            return { operatorId: identity.operatorId, created: false };
        }
        const operatorId = randomBytes(32).toString('base64url');
        writeIdentity(identityPath, operatorId, devicesPath);
        return { operatorId, created: true };
    });
}
