#!/usr/bin/env node
/**
 * 在本机 DSH 上换一张一次性账号 ticket，并生成手机可扫的深链二维码。
 *
 *   npm run ticket -- --hub https://hub.example.com
 *   npm run ticket -- --hub https://hub.example.com --dsh http://127.0.0.1:64766
 *
 * ticket 由本机 DSH 的 /marshal/account/login 用当前已登录账号向 Hub 换取，
 * 只在本机与 Hub 之间流转；不写入仓库。60 秒内有效、只能用一次。
 */
import { execFileSync } from 'node:child_process'
import { chmod } from 'node:fs/promises'
import QRCode from 'qrcode'

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return process.env[name === 'hub' ? 'MARSHAL_HUB' : 'DSH_ORIGIN'] ?? fallback
}

const hub = (arg('hub', '') ?? '').replace(/\/+$/, '')
const dsh = (arg('dsh', 'http://127.0.0.1:64766') ?? '').replace(/\/+$/, '')
const noQr = process.argv.includes('--no-qr')
if (!hub) {
  console.error('用法：npm run ticket -- --hub https://你的Hub地址 [--dsh http://127.0.0.1:64766]')
  process.exit(2)
}

let response
try {
  response = await fetch(dsh + '/marshal/account/login', {
    method: 'POST',
    headers: { 'x-marshal-account': '1', accept: 'application/json' },
  })
} catch {
  console.error('连不上本机 DSH：' + dsh + '（用 --dsh 指定实际地址）')
  process.exit(1)
}
const body = await response.json().catch(() => null)
if (!body?.ok || typeof body.ticket !== 'string') {
  console.error('换票失败：' + (body?.code ?? ('HTTP ' + response.status)))
  console.error('请先在本机 DSH 左下角登录账号，再重试。')
  process.exit(1)
}

const link = 'marshal://open?hub=' + encodeURIComponent(hub) + '&ticket=' + encodeURIComponent(body.ticket)
const seconds = Math.max(0, Math.round((body.expiresAt - Date.now()) / 1000))
console.log('已生成一次性账号 ticket（' + seconds + ' 秒内有效，只能用一次）')
console.log('Hub  : ' + hub)
console.log('账号 : ' + (body.accountHash ? body.accountHash.slice(0, 12) + '…' : '已绑定'))
console.log('深链 : ' + link)
console.log('提示 : 手机扫码后会自动打开调度官并完成群聊登录；也可复制深链到手机打开。')

if (!noQr) {
  const file = '/tmp/marshal-ticket.png'
  await QRCode.toFile(file, link, { width: 720, margin: 2, errorCorrectionLevel: 'M' })
  try { await chmod(file, 0o600) } catch { /* 权限收紧失败不阻塞 */ }
  console.log('二维码: ' + file + '（打开后用手机相机扫；用完可删）')
}

try {
  execFileSync('pbcopy', { input: link })
  console.log('已复制深链到剪贴板（可隔空投送到手机）。')
} catch {
  /* 非 macOS 或无 pbcopy 时忽略 */
}