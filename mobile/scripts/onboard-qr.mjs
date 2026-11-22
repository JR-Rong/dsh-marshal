#!/usr/bin/env node
/**
 * 电脑端一键配对二维码：Hub 地址 + 管理令牌，默认顺带一张 60 秒群聊 ticket。
 *
 *   npm run onboard -- --hub https://hub.example.com
 *   npm run onboard -- --no-ticket     # 只配 Hub + 令牌，不登录群聊
 *
 * Hub 地址默认从当前 node 的 cordis.patch.yml 的 hubUrl 推导；
 * 管理令牌默认从 ~/.dsh-marshal/install-20261031/hub.json 读取。
 * 令牌不会打印到终端；深链复制到剪贴板，二维码写 /tmp 并收紧到 0600。
 *
 * 安全提醒：二维码里含长期管理令牌，等于这台 Hub 的管理员凭据。
 * 只在自己的手机上扫，扫完删掉 PNG，不要把截图发人；泄露就轮换 dashboardToken。
 */
import fs from 'node:fs'
import { chmod } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import QRCode from 'qrcode'

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1]
  return process.env[name === 'hub' ? 'MARSHAL_HUB' : name === 'dsh' ? 'DSH_ORIGIN' : ''] ?? fallback
}

function hiddenFlag(name) {
  return process.argv.includes('--' + name)
}

function normalizeHub(raw) {
  const value = (raw ?? '').trim()
  if (!value) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value
  const url = new URL(withScheme)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  if (url.protocol === 'ws:') url.protocol = 'http:'
  return url.origin
}

function hubFromNodeConfig(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const match = text.match(/"hubUrl"\s*:\s*"([^"]+)"|hubUrl\s*:\s*([^\s]+)/)
    const raw = match?.[1] ?? match?.[2]
    return raw ? normalizeHub(raw) : ''
  } catch {
    return ''
  }
}

async function ticketFromDsh(dsh) {
  try {
    const response = await fetch(dsh + '/marshal/account/login', {
      method: 'POST',
      headers: { 'x-marshal-account': '1', accept: 'application/json' },
    })
    const body = await response.json()
    return body?.ok && typeof body.ticket === 'string' ? body.ticket : ''
  } catch {
    return ''
  }
}

const hubJsonPath = arg('hub-json', homedir() + '/.dsh-marshal/install-20261031/hub.json')
const nodeConfigPath = arg('node-config', homedir() + '/.dsh/profiles/desktop/cordis.patch.yml')
const dsh = (arg('dsh', 'http://127.0.0.1:64766') ?? '').replace(/\/+$/, '')

let hub = arg('hub', '')
if (!hub) hub = hubFromNodeConfig(nodeConfigPath)
let hubJson = {}
try { hubJson = JSON.parse(fs.readFileSync(hubJsonPath, 'utf8')) } catch { /* 下面报错 */ }
if (!hub) hub = hubJson.publicOrigin ?? ''
hub = normalizeHub(hub)
if (!hub) {
  console.error('找不到 Hub 地址：用 --hub https://你的Hub 指定')
  process.exit(2)
}
const token = typeof hubJson.dashboardToken === 'string' ? hubJson.dashboardToken : ''
if (token.length < 16) {
  console.error('找不到管理令牌：检查 --hub-json 指向的 hub.json 是否有 dashboardToken')
  process.exit(2)
}

let ticket = ''
const nodeHub = hubFromNodeConfig(nodeConfigPath)
if (!hiddenFlag('no-ticket')) {
  if (nodeHub && nodeHub !== hub) {
    console.warn('提示：--hub 与本机 node 的 hubUrl 不一致，跳过群聊 ticket，只生成 Hub + 令牌配对码。')
  } else {
    ticket = await ticketFromDsh(dsh)
    if (!ticket) console.warn('提示：本机 DSH 换票失败，本次只生成 Hub + 令牌配对码。')
  }
}

const params = new URLSearchParams({ hub, token, ...(ticket ? { ticket } : {}) })
const link = 'marshal://open?' + params.toString()
const qrPath = '/tmp/marshal-onboard.png'
await QRCode.toFile(qrPath, link, { width: 900, margin: 2, errorCorrectionLevel: 'M' })
try { await chmod(qrPath, 0o600) } catch { /* 收紧失败不阻塞 */ }

console.log('一键配对二维码: ' + qrPath)
console.log('Hub       : ' + hub)
console.log('管理令牌  : len=' + token.length + ' prefix=' + token.slice(0, 6) + '…（不打印全文）')
console.log('群聊 ticket: ' + (ticket ? '已附带（60 秒，扫晚了只完成 Hub 配对）' : '未附带（可稍后 npm run ticket）'))
console.log('深链      : 已复制到剪贴板（含令牌，勿外传）')
if (hiddenFlag('print-link')) {
  console.log('完整深链  : ' + link)
  console.warn('警告：上面这条含长期管理令牌，只在自己的设备上使用。')
}
try {
  execFileSync('pbcopy', { input: link })
} catch {
  console.warn('剪贴板不可用；请直接扫上面的二维码。')
}
console.warn('安全：二维码=Hub 管理员凭据。只给自己的手机扫，扫完删 PNG；泄露请轮换 dashboardToken。')