import { createSign, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http2 from 'node:http2'

export interface PushConfig {
  readonly apns?: { readonly keyId?: string; readonly teamId?: string; readonly bundleId?: string; readonly keyPath?: string }
  readonly fcm?: { readonly projectId?: string; readonly clientEmail?: string; readonly privateKeyPath?: string }
  readonly huawei?: { readonly appId?: string; readonly clientId?: string; readonly clientSecretPath?: string }
}

export interface PushTarget {
  readonly provider: 'apns' | 'fcm' | 'huawei'
  readonly token: string
  readonly liveToken?: string
}

export interface PushNotice {
  readonly kind: 'approval' | 'question' | 'run-start' | 'run-finish'
  readonly title: string
  readonly body: string
  readonly dedupeKey: string
}

export interface PushDelivery {
  readonly delivered: boolean
  readonly reason: string
}

const seen = new Map<string, number>()
const sentAt = new Map<string, number[]>()

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function readKey(path: string | undefined): string | undefined {
  if (!path || path.includes('PLACEHOLDER')) return undefined
  try {
    const text = readFileSync(path, 'utf8')
    return text.trim() ? text : undefined
  } catch {
    return undefined
  }
}

function allowSend(deviceId: string, dedupeKey: string, now: number): string | undefined {
  const last = seen.get(deviceId + '|' + dedupeKey)
  if (last !== undefined && now - last < 30_000) return 'duplicate'
  const recent = (sentAt.get(deviceId) ?? []).filter((at) => now - at < 60_000)
  if (recent.length >= 8) return 'rate-limited'
  recent.push(now)
  sentAt.set(deviceId, recent)
  seen.set(deviceId + '|' + dedupeKey, now)
  return undefined
}

export async function deliverPush(input: {
  config: PushConfig | undefined
  deviceId: string
  target: PushTarget
  notice: PushNotice
  now?: number
  fetchImpl?: typeof fetch
}): Promise<PushDelivery> {
  const now = input.now ?? Date.now()
  const blocked = allowSend(input.deviceId, input.notice.dedupeKey, now)
  if (blocked) return { delivered: false, reason: blocked }
  const block = input.config?.[input.target.provider]
  if (!block) return { delivered: false, reason: 'unconfigured' }
  if (input.target.provider === 'apns') {
    const key = readKey(input.config?.apns?.keyPath)
    const keyId = input.config?.apns?.keyId
    const teamId = input.config?.apns?.teamId
    if (!key || !keyId || !teamId || keyId.includes('PLACEHOLDER')) return { delivered: false, reason: 'key-unreadable' }
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
    const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }))
    const signer = createSign('SHA256')
    signer.update(header + '.' + claims)
    let jwt = header + '.' + claims + '.'
    try { jwt += signer.sign(key).toString('base64url') } catch { return { delivered: false, reason: 'key-unreadable' } }
    const status = await postApns(input.target.token, jwt, input.config?.apns?.bundleId ?? '', input.notice)
    return status >= 200 && status < 300
      ? { delivered: true, reason: 'sent' }
      : { delivered: false, reason: 'provider-' + status }
  }
  const secretPath = input.target.provider === 'fcm' ? input.config?.fcm?.privateKeyPath : input.config?.huawei?.clientSecretPath
  if (!readKey(secretPath)) return { delivered: false, reason: 'key-unreadable' }
  const fetcher = input.fetchImpl ?? fetch
  try {
    const response = await fetcher('https://push.invalid/' + input.target.provider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: input.target.token, notice: input.notice }),
    })
    return response.ok ? { delivered: true, reason: 'sent' } : { delivered: false, reason: 'provider-' + response.status }
  } catch {
    return { delivered: false, reason: 'network' }
  }
}

function postApns(token: string, jwt: string, bundleId: string, notice: PushNotice): Promise<number> {
  return new Promise((resolve) => {
    const client = http2.connect('https://api.push.apple.com')
    client.on('error', () => { client.close(); resolve(0) })
    const req = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + token,
      authorization: 'bearer ' + jwt,
      'apns-topic': notice.kind === 'run-start' || notice.kind === 'run-finish' ? bundleId + '.push-type.liveactivity' : bundleId,
      'apns-push-type': notice.kind === 'run-start' || notice.kind === 'run-finish' ? 'liveactivity' : 'alert',
    })
    req.on('response', (headers) => {
      const status = Number(headers[':status'] ?? 0)
      client.close()
      resolve(status)
    })
    req.on('error', () => { client.close(); resolve(0) })
    req.end(JSON.stringify({ aps: { alert: { title: notice.title, body: notice.body } } }))
  })
}

export function noticeForEvent(kind: string, payload: unknown, watched: ReadonlySet<string>): PushNotice | null {
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const sessionKey = [record.deviceId, record.agent, record.sessionId].every((part) => typeof part === 'string')
    ? String(record.deviceId) + '|' + String(record.agent) + '|' + String(record.sessionId)
    : ''
  if (kind === 'input.requested') {
    const approval = typeof record.approval === 'object' && record.approval !== null
    const id = typeof record.requestId === 'string' ? record.requestId : randomBytes(4).toString('hex')
    return {
      kind: approval ? 'approval' : 'question',
      title: approval ? '需要审批' : '需要回答',
      body: approval ? '只允许这一次' : '有一条提问',
      dedupeKey: (approval ? 'approval:' : 'question:') + id,
    }
  }
  if ((kind === 'turn.started' || kind === 'turn.completed') && sessionKey && watched.has(sessionKey)) {
    return {
      kind: kind === 'turn.started' ? 'run-start' : 'run-finish',
      title: kind === 'turn.started' ? '开始运行' : '运行结束',
      body: sessionKey,
      dedupeKey: kind + ':' + sessionKey,
    }
  }
  return null
}
