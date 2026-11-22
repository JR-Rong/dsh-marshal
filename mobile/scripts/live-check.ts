#!/usr/bin/env node
/**
 * 对真实 Hub 的只读联调（不发送 prompt、不回答审批）。
 *
 *   MARSHAL_LIVE_HUB=https://hub.example.com \
 *   MARSHAL_LIVE_TOKEN=<dashboardToken> \
 *   node --experimental-strip-types scripts/live-check.ts
 *
 * 上传只发一个 27 字节的探针文件，节点会在临时目录落盘，1 小时后过期。
 * 令牌只从环境变量读取，不写入仓库与日志。
 */
import { MarshalApi, type Target } from '../src/lib/marshal.ts'

const hubUrl = (process.env.MARSHAL_LIVE_HUB ?? '').replace(/\/+$/, '')
const token = process.env.MARSHAL_LIVE_TOKEN ?? ''
if (!hubUrl || !token) {
  console.error('需要 MARSHAL_LIVE_HUB 与 MARSHAL_LIVE_TOKEN')
  process.exit(2)
}

const api = new MarshalApi({ hubUrl, token })
const fail = (label: string, detail: string): never => {
  console.error('FAIL', label, detail)
  process.exit(1)
}

const devices = await api.devices()
if (!devices.ok) fail('devices', devices.message)
console.log('devices ok:', devices.data.length, devices.data.map((row) => row.id).join(' | '))

let target: Target | null = null
for (const device of devices.data) {
  const sessions = await api.sessions(device.id)
  if (!sessions.ok) { console.log('sessions fail for', device.id, sessions.message); continue }
  console.log('sessions ok:', device.id, sessions.data.length, 'running', sessions.data.filter((row) => row.running).length)
  const row = sessions.data.find((entry) => entry.agent === 'dsh') ?? sessions.data[0]
  if (!target && row) target = { deviceId: row.deviceId || device.id, agent: row.agent, sessionId: row.sessionId }
}
if (!target) fail('target', '没有可用会话')

const controls = await api.controls(target)
if (!controls.ok) fail('controls', controls.message)
console.log('controls ok:', controls.data?.models.length ?? 0, 'models; current',
  controls.data?.current.model ?? '-', '/', controls.data?.current.reasoning ?? '-')

const history = await api.history(target, 5)
if (!history.ok) fail('history', history.message)
console.log('history ok:', history.data.items.length, 'items; completeness', history.data.completeness)

const inputs = await api.inputs(target)
if (!inputs.ok) fail('inputs', inputs.message)
console.log('inputs ok:', inputs.data.length, 'cards')

const bytes = new TextEncoder().encode('marshal-mobile-live-probe')
const upload = await api.upload(target, { name: 'mobile-live-probe.txt', mime: 'text/plain', bytes })
if (!upload.ok) fail('upload', upload.message)
console.log('upload ok:', upload.data.attachmentId, upload.data.bytes, 'bytes; complete', upload.data.complete)

const discussions = await api.discussions()
console.log('discussions:', discussions.ok ? 'ok' : discussions.error, discussions.ok ? '' : '（本 Hub 账号登录模式，令牌不可用）')

console.log('LIVE CHECK PASS')
