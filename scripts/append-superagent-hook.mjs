/**
 * Re-attach the browser human-create observer after a client bundle rebuild.
 *
 * plugin-build/client/index.js is a generated artifact; the observer lives in
 * client/superagent-hook.js and is appended to the bundle. Running this script
 * after a rebuild keeps the two in sync. It is idempotent.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(root, 'plugin-build', 'client', 'index.js');
const hookPath = join(root, 'plugin-build', 'client', 'superagent-hook.js');
const marker = 'dsh-marshal superagent human-create observer';

const bundle = readFileSync(bundlePath, 'utf8');
if (bundle.includes(marker)) {
    console.log('superagent hook already present in ' + bundlePath);
    process.exit(0);
}
const hook = readFileSync(hookPath, 'utf8');
writeFileSync(bundlePath, bundle + '\n/* --- ' + marker + ' --- */\n' + hook);
console.log('superagent hook appended to ' + bundlePath);
