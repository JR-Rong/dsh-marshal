import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const cwd = new URL('../../', import.meta.url);

test('plugin client bundle matches its source shards byte for byte', () => {
    execFileSync(process.execPath, ['scripts/build-plugin-client.mjs', '--check'], { cwd });
});

test('plugin client bundle passes the Node syntax check', () => {
    execFileSync(process.execPath, ['--check', 'plugin-build/client/index.js'], { cwd });
});
