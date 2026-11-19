import { createSign, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http2 from 'node:http2'

export interface PushConfig {
  readonly apns?: {
    readonly keyId?: string
    readonly teamId?: string
    readonly bundleId?: string
    readonly keyPath?: string
    /** 与 entitlements 的 aps-environment 一致。缺省 sandbox。 */
    readonly environment?: 'sandbox' | 'production'
  }
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

export interface ApnsPost {
  host: string
  path: string
  headers: Record<string, string | undefined>
  body: string
}

const jwtCache = new Map<string, { jwt: string; exp: number }>()
const fcmCache = new Map<string, { token: string; exp: number }>()

export async function deliverPush(input: {
  config: PushConfig | undefined
  deviceId: string
  target: PushTarget
  notice: PushNotice
  now?: number
  fetchImpl?: typeof fetch
  apnsPost?: (request: ApnsPost) => Promise<number>
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
    const jwt = signApnsJwt(key, keyId, teamId, now)
    if (!jwt) return { delivered: false, reason: 'key-unreadable' }
    const bundleId = input.config?.apns?.bundleId ?? ''
    const sandbox = input.config?.apns?.environment !== 'production'
    const post = async (token: string, live: boolean) => postApns({
      token, jwt, bundleId, notice: input.notice, sandbox, live, now,
      ...(input.apnsPost === undefined ? {} : { post: input.apnsPost }),
    })
    const liveKind = input.notice.kind === 'run-start' || input.notice.kind === 'run-finish' || input.notice.kind === 'approval'
    if (input.notice.kind === 'approval') {
      const alert = await post(input.target.token, false)
      if (input.target.liveToken) await post(input.target.liveToken, true)
      return alert >= 200 && alert < 300
        ? { delivered: true, reason: 'sent' }
        : { delivered: false, reason: 'provider-' + alert }
    }
    const status = await post(liveKind && input.target.liveToken ? input.target.liveToken : input.target.token, Boolean(liveKind && input.target.liveToken))
    return status >= 200 && status < 300
      ? { delivered: true, reason: 'sent' }
      : { delivered: false, reason: 'provider-' + status }
  }
  const fetcher = input.fetchImpl ?? fetch
  if (input.target.provider === 'fcm') return deliverFcm(input.config?.fcm, input.target, input.notice, now, fetcher)
  return deliverHuawei(input.config?.huawei, input.target, input.notice, fetcher)
}

async function deliverFcm(
  config: PushConfig['fcm'],
  target: PushTarget,
  notice: PushNotice,
  now: number,
  fetcher: typeof fetch,
): Promise<PushDelivery> {
  const key = readKey(config?.privateKeyPath)
  const email = config?.clientEmail
  const project = config?.projectId
  if (!key || !email || !project || email.includes('PLACEHOLDER') || project.includes('PLACEHOLDER')) {
    return { delivered: false, reason: 'key-unreadable' }
  }
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600,
  }))
  const cached = fcmCache.get(email)
  let access = cached && cached.exp > now + 60_000 ? cached.token : ''
  let assertion = ''
  try {
    const signer = createSign('RSA-SHA256')
    signer.update(header + '.' + claims)
    assertion = header + '.' + claims + '.' + signer.sign(key).toString('base64url')
  } catch {
    return { delivered: false, reason: 'key-unreadable' }
  }
  try {
    if (!access) {
      const tokenResponse = await fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(assertion),
      })
      if (!tokenResponse.ok) return { delivered: false, reason: 'provider-' + tokenResponse.status }
      const tokenBody = await tokenResponse.json() as { access_token?: string }
      if (!tokenBody.access_token) return { delivered: false, reason: 'provider-rejected' }
      access = tokenBody.access_token
      fcmCache.set(email, { token: access, exp: now + 50 * 60_000 })
    }
    const send = await fetcher('https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(project) + '/messages:send', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: target.token,
          notification: { title: notice.title, body: notice.body },
          data: { kind: notice.kind },
        },
      }),
    })
    return send.ok ? { delivered: true, reason: 'sent' } : { delivered: false, reason: 'provider-' + send.status }
  } catch {
    return { delivered: false, reason: 'network' }
  }
}

async function deliverHuawei(
  config: PushConfig['huawei'],
  target: PushTarget,
  notice: PushNotice,
  fetcher: typeof fetch,
): Promise<PushDelivery> {
  const secret = readKey(config?.clientSecretPath)
  const clientId = config?.clientId
  const appId = config?.appId
  if (!secret || !clientId || !appId || clientId.includes('PLACEHOLDER') || appId.includes('PLACEHOLDER')) {
    return { delivered: false, reason: 'key-unreadable' }
  }
  try {
    const tokenResponse = await fetcher('https://oauth-login.cloud.huawei.com/oauth2/v3/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(clientId) + '&client_secret=' + encodeURIComponent(secret),
    })
    if (!tokenResponse.ok) return { delivered: false, reason: 'provider-' + tokenResponse.status }
    const tokenBody = await tokenResponse.json() as { access_token?: string }
    if (!tokenBody.access_token) return { delivered: false, reason: 'provider-rejected' }
    const send = await fetcher('https://push-api.cloud.huawei.com/v1/' + encodeURIComponent(appId) + '/messages:send', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tokenBody.access_token, 'content-type': 'application/json' },
      body: JSON.stringify({
        validate_only: false,
        message: {
          token: [target.token],
          notification: { title: notice.title, body: notice.body },
          android: {
            notification: {
              title: notice.title,
              body: notice.body,
              click_action: { type: 3 },
            },
          },
        },
      }),
    })
    return send.ok ? { delivered: true, reason: 'sent' } : { delivered: false, reason: 'provider-' + send.status }
  } catch {
    return { delivered: false, reason: 'network' }
  }
}

function signApnsJwt(key: string, keyId: string, teamId: string, now: number): string | undefined {
  const cached = jwtCache.get(keyId + '|' + teamId)
  if (cached && cached.exp > now + 60_000) return cached.jwt
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }))
  const signer = createSign('SHA256')
  signer.update(header + '.' + claims)
  try {
    const jwt = header + '.' + claims + '.' + signer.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    jwtCache.set(keyId + '|' + teamId, { jwt, exp: now + 50 * 60_000 })
    return jwt
  } catch {
    return undefined
  }
}

function postApns(input: {
  token: string
  jwt: string
  bundleId: string
  notice: PushNotice
  sandbox: boolean
  live: boolean
  now: number
  post?: (request: ApnsPost) => Promise<number>
}): Promise<number> {
  const host = input.sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'
  const headers = {
    ':method': 'POST',
    ':path': '/3/device/' + input.token,
    authorization: 'bearer ' + input.jwt,
    'apns-topic': input.live ? input.bundleId + '.push-type.liveactivity' : input.bundleId,
    'apns-push-type': input.live ? 'liveactivity' : 'alert',
  }
  const body = input.live
    ? JSON.stringify({
      aps: {
        timestamp: Math.floor(input.now / 1000),
        event: 'update',
        'content-state': { title: input.notice.title, phase: input.notice.kind },
      },
    })
    : JSON.stringify({ aps: { alert: { title: input.notice.title, body: input.notice.body } } })
  if (input.post) return input.post({ host, path: headers[':path'], headers, body })
  return new Promise((resolve) => {
    const client = http2.connect('https://' + host)
    client.on('error', () => { client.close(); resolve(0) })
    const req = client.request(headers)
    req.on('response', (response) => {
      const status = Number(response[':status'] ?? 0)
      client.close()
      resolve(status)
    })
    req.on('error', () => { client.close(); resolve(0) })
    req.end(body)
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
