#!/usr/bin/env node
/**
 * 把「手机连接」按钮注入已安装的调度官客户端。
 *
 *   node desktop-pairing/inject-phone-connect.mjs
 *   node desktop-pairing/inject-phone-connect.mjs --revert
 *   node desktop-pairing/inject-phone-connect.mjs --dry-run
 *
 * 只把按钮脚本写进插件 client。配对码由页面当场向 Hub 领取，脚本里不放令牌。
 * 客户端文件收紧到 0600；首次注入自动备份 index.js.bak-phone-connect。回滚用 --revert。
 *
 * 需要写插件目录权限。默认路径可用环境变量覆盖：
 *   MARSHAL_PLUGIN_CLIENT / MARSHAL_HUB_JSON / MARSHAL_NODE_CONFIG / MARSHAL_MOBILE_ROOT
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const home = process.env.HOME || ''
const pluginClient = process.env.MARSHAL_PLUGIN_CLIENT
  || path.join(home, '.dsh-marshal/install-20261031/plugin-ui/client/index.js')
const mobileRoot = process.env.MARSHAL_MOBILE_ROOT
  || path.join(import.meta.dirname, '..')
const templatePath = path.join(import.meta.dirname, 'marshal-phone-connect.js')
const qrPath = path.join(mobileRoot, 'node_modules/qrcode-generator/dist/qrcode.js')
const backupPath = pluginClient + '.bak-phone-connect'
if (!fs.existsSync(pluginClient)) {
  console.error('找不到插件 client/index.js：请用 MARSHAL_PLUGIN_CLIENT 指向已安装插件')
  process.exit(2)
}

const START = '/* ===== marshal-phone-connect:start ===== */'
const END = '/* ===== marshal-phone-connect:end ===== */'
const dryRun = process.argv.includes('--dry-run')
const revert = process.argv.includes('--revert')

if (revert) {
  if (!fs.existsSync(backupPath)) {
    console.error('没有备份可回滚：' + backupPath)
    process.exit(2)
  }
  if (!dryRun) {
    fs.copyFileSync(backupPath, pluginClient)
    fs.chmodSync(pluginClient, 0o644)
  }
  console.log('已回滚：' + pluginClient)
  process.exit(0)
}

const block = fs.readFileSync(templatePath, 'utf8')
  .replace('/* __QRCODE_LIB__ */', () => fs.readFileSync(qrPath, 'utf8'))
let client = fs.readFileSync(pluginClient, 'utf8')
const marker = client.indexOf(START)
if (marker >= 0) client = client.slice(0, marker)
if (!client.endsWith('\n')) client += '\n'
const next = client + START + '\n' + block + '\n' + END + '\n'

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, wouldWrite: pluginClient, bytes: next.length }))
  process.exit(0)
}

if (!fs.existsSync(backupPath)) fs.copyFileSync(pluginClient, backupPath)
fs.writeFileSync(pluginClient, next, { mode: 0o600 })
fs.chmodSync(pluginClient, 0o600)
try {
  execFileSync(process.execPath, ['--check', pluginClient], { stdio: 'pipe' })
} catch (error) {
  fs.copyFileSync(backupPath, pluginClient)
  fs.chmodSync(pluginClient, 0o644)
  console.error('语法检查失败，已恢复备份：' + String(error))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, pluginClient, backup: backupPath, bytes: next.length }))
