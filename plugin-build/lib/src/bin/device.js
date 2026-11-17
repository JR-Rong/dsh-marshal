#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DeviceStateError, DeviceStore, migrateLegacyState, readDeviceState, serializeDevicesState, } from "../hub/devices.js";
import { ensureInstall, ensureMigratedIdentity } from "../hub/identity.js";
import { atomicWriteFile, withFileLock } from "../hub/state-file.js";
const DEFAULT_FILE = `${homedir()}/.dsh-marshal/devices.json`;
const USAGE = `usage: marshal-device <command> [args]

  add <deviceId> [displayName]       register a device and print its token once
  revoke <deviceId>                  revoke a device, keeping a tombstone
  list                               list ids, policy flags and revisions
  allow <deviceId> <content|interactions|discussion> <on|off>
                                     change a local policy flag
  migrate [--create-identity]        convert a v1 table to <devicesFile>.v2;
                                     --create-identity also adopts the migrated
                                     table as this install's operator identity
  --help                             show this message`;
function pathFromEnv() {
    return resolve(process.env.MARSHAL_DEVICES_FILE ?? DEFAULT_FILE);
}
function fail(message) {
    console.error(`marshal-device: ${message}`);
    process.exit(1);
}
function openStore(file) {
    try {
        return new DeviceStore(file);
    }
    catch (error) {
        if (error instanceof DeviceStateError && error.code === 'legacy') {
            fail('device table is v1; run "marshal-device migrate" and point devicesFile at the new file');
        }
        fail(error instanceof Error ? error.message : String(error));
    }
}
function parseOnOff(value) {
    if (value === 'on')
        return true;
    if (value === 'off')
        return false;
    fail('policy value must be "on" or "off"');
}
function policyKey(value) {
    if (value === 'content')
        return 'allowContent';
    if (value === 'interactions')
        return 'allowInteractions';
    if (value === 'discussion')
        return 'allowDiscussion';
    fail('policy name must be content, interactions or discussion');
}
function add(file, id, displayName) {
    if (id === undefined || id.trim() === '')
        fail('add requires a non-empty device id');
    // add 需要身份；其余命令可在身份缺失时用于恢复设备表。
    const install = ensureInstall(file);
    if (install.initialized)
        console.warn('marshal-device: empty device table');
    const name = displayName?.trim() || id.trim();
    const added = install.store.add(id.trim(), name);
    console.log(`device ${added.entry.id} added to ${file}`);
    console.log(`policyRevision=${added.revision} allowContent=off allowInteractions=off allowDiscussion=off`);
    console.log(`token (shown once): ${added.token}`);
}
function revoke(file, id) {
    if (id === undefined || id.trim() === '')
        fail('revoke requires a device id');
    const store = openStore(file);
    const result = store.revoke(id.trim());
    console.log(`device ${result.entry.id} revoked; policyRevision=${result.revision}`);
}
function list(file) {
    const store = openStore(file);
    const devices = store.list();
    if (devices.length === 0)
        console.log('(no devices)');
    for (const device of devices) {
        console.log([
            device.id,
            device.name,
            `revoked=${device.revoked ? 'yes' : 'no'}`,
            `content=${device.allowContent ? 'on' : 'off'}`,
            `interactions=${device.allowInteractions ? 'on' : 'off'}`,
            `discussion=${device.allowDiscussion ? 'on' : 'off'}`,
            `revision=${device.policyRevision}`,
        ].join('\t'));
    }
}
function allow(file, id, policy, value) {
    if (id === undefined || id.trim() === '')
        fail('allow requires a device id');
    const key = policyKey(policy);
    const on = parseOnOff(value);
    const store = openStore(file);
    const result = store.setPolicy(id.trim(), { [key]: on });
    console.log(`device ${result.entry.id} ${key}=${on ? 'on' : 'off'}; policyRevision=${result.revision}`);
    console.log(`allowContent=${result.entry.allowContent ? 'on' : 'off'} allowInteractions=${result.entry.allowInteractions ? 'on' : 'off'} allowDiscussion=${result.entry.allowDiscussion ? 'on' : 'off'}`);
}
function migrate(file, createIdentity) {
    const loaded = readDeviceState(file);
    if (loaded.kind === 'missing')
        fail(`device table ${file} is missing`);
    if (loaded.kind === 'current')
        fail(`${file} is already a v2 device table; nothing to migrate`);
    const target = `${file}.v2`;
    if (existsSync(target)) {
        if (!createIdentity)
            fail(`${target} already exists; refusing to overwrite it`);
        // 允许在已迁移的表上补做一次身份对账，但不再重写表内容。
        const existing = readDeviceState(target);
        if (existing.kind !== 'current')
            fail(`${target} is not a valid v2 device table`);
    }
    else {
        const state = migrateLegacyState(loaded.devices);
        // 新表也是设备表写者，共用同一锁与原子替换；锁内再核对一次，避免并发迁移覆盖。
        withFileLock(target, () => {
            if (existsSync(target))
                throw new Error(`${target} already exists; refusing to overwrite it`);
            atomicWriteFile(target, serializeDevicesState(state), 0o600);
        });
        console.log(`migrated ${loaded.devices.length} device(s) to ${target}`);
        console.log(`the v1 table at ${file} was left untouched`);
    }
    if (!createIdentity) {
        console.log(`set devicesFile to ${target}`);
        console.log('identity.json was not created; adopt the migrated table with the one-time command:');
        console.log('  marshal-device migrate --create-identity');
        return;
    }
    // 与 hub/CLI 的其他写者共用 <devicesFile>.lock；身份要么新建要么核对后沿用。
    const adopted = ensureMigratedIdentity(target);
    console.log(`operatorId=${adopted.operatorId}`);
    console.log(`identity.json now points at ${target}`);
    console.warn('WARNING: this is the one-time reconciliation step for a migrated install; '
        + 'keep identity.json and the .v2 table together, and do not run it again with a different table.');
}
function main(argv) {
    const [command] = argv;
    if (command === undefined) {
        console.error(USAGE);
        process.exit(1);
    }
    if (command === '--help' || command === '-h' || command === 'help') {
        console.log(USAGE);
        process.exit(0);
    }
    const file = pathFromEnv();
    switch (command) {
        case 'add':
            add(file, argv[1], argv[2]);
            return;
        case 'revoke':
            revoke(file, argv[1]);
            return;
        case 'list':
            list(file);
            return;
        case 'allow':
            allow(file, argv[1], argv[2], argv[3]);
            return;
        case 'migrate':
            migrate(file, argv[1] === '--create-identity');
            return;
        default:
            console.error(USAGE);
            fail(`unknown command "${command}"`);
    }
}
try {
    main(process.argv.slice(2));
}
catch (error) {
    // 设备/身份错误不含 token 或摘要，直接给出分类与修复提示。
    fail(error instanceof Error ? error.message : String(error));
}
