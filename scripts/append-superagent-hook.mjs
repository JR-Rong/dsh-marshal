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
const hook = readFileSync(hookPath, 'utf8');
const markerComment = '/* --- ' + marker + ' --- */';
const at = bundle.indexOf(markerComment);
// Replace the previously appended block: an idempotent append is not enough,
// because a source fix after the first build would otherwise keep shipping the
// old observer while the tests exercise the new source file.
const base = (at === -1 ? bundle : bundle.slice(0, at)).replace(/\s+$/, '');
const next = base + '\n' + markerComment + '\n' + hook;
if (next === bundle) {
    console.log('superagent hook already current in ' + bundlePath);
    process.exit(0);
}
writeFileSync(bundlePath, next);
console.log((at === -1 ? 'superagent hook appended to ' : 'superagent hook refreshed in ') + bundlePath);
