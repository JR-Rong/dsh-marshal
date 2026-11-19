import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const plugin = join(root, 'plugin-build')
const packedName = readdirSync(plugin).find((name) => name.endsWith('.tgz'))
if (!packedName) throw new Error('plugin-build is missing its tgz')
const pkg = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'))
if (!pkg.dependencies?.uqr) throw new Error('plugin-build package.json is missing uqr')
if (!packedName.includes(pkg.version)) throw new Error('tgz name does not include ' + pkg.version)

const phone = readFileSync(join(plugin, 'lib/src/hub/phone.js'), 'utf8')
const devices = readFileSync(join(plugin, 'lib/src/hub/devices.js'), 'utf8')
const server = readFileSync(join(plugin, 'lib/src/hub/server.js'), 'utf8')
const push = readFileSync(join(plugin, 'lib/src/hub/push-send.js'), 'utf8')
for (const [file, needle] of [
  [phone, 'phoneTokenDigest'],
  [phone, 'onceDecisionIds'],
  [devices, 'phoneTokenDigest'],
  [server, "record.role === 'phone'"],
  [push, 'ieee-p1363'],
  [push, 'click_action'],
]) {
  if (!file.includes(needle)) throw new Error('plugin-build is missing ' + needle)
}
const srcPhone = readFileSync(join(root, 'src/hub/phone.ts'), 'utf8')
if (!srcPhone.includes('phoneTokenDigest') || !srcPhone.includes('onceDecisionIds')) {
  throw new Error('src/hub/phone.ts is missing the review fixes')
}

function filesUnder(dir, root = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, root))
    else out.push(relative(root, path))
  }
  return out.sort()
}
const extracted = mkdtempSync(join(tmpdir(), 'marshal-tgz-'))
try {
  execFileSync('tar', ['-xzf', join(plugin, packedName), '-C', extracted])
  const packedLib = join(extracted, 'package', 'lib')
  const live = filesUnder(join(plugin, 'lib'))
  const packed = filesUnder(packedLib)
  if (live.join('\n') !== packed.join('\n')) {
    throw new Error('tgz lib tree does not match plugin-build/lib')
  }
  for (const path of live) {
    const installed = readFileSync(join(plugin, 'lib', path))
    if (!installed.equals(readFileSync(join(packedLib, path)))) throw new Error('tgz lib differs at ' + path)
  }
  const packedPkg = JSON.parse(readFileSync(join(extracted, 'package/package.json'), 'utf8'))
  if (!packedPkg.dependencies?.uqr) throw new Error('tgz is missing the uqr dependency')
  const entry = packedPkg.exports?.['.']
  if (typeof entry !== 'string' || !entry.startsWith('./lib/')) throw new Error('tgz is missing its plugin entry')
  symlinkSync(join(root, 'node_modules'), join(extracted, 'node_modules'), 'dir')
  const installedPlugin = await import(pathToFileURL(join(extracted, 'package', entry)).href)
  if (typeof installedPlugin.apply !== 'function') throw new Error('tgz entry does not export apply')
  console.log('plugin tgz matches plugin-build/lib (' + packed.length + ' files)')
} finally {
  rmSync(extracted, { recursive: true, force: true })
}
