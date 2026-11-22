import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deliverPush, noticeForEvent } from '../src/hub/push-send.ts'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

function keyFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'marshal-push-')), 'key.pem')
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  return path
}

describe('push senders', () => {
  it('signs APNs in raw r||s and sends live activity updates to the activity token', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const path = join(mkdtempSync(join(tmpdir(), 'marshal-apns-')), 'key.pem')
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const seen: Array<{ host: string; headers: Record<string, string | undefined>; body: string }> = []
    const notice = { kind: 'approval' as const, title: '审批', body: '一次', dedupeKey: 'approval:apns-live' }
    const input = {
      config: { apns: { keyId: 'KEY123', teamId: 'TEAM', bundleId: 'com.example.marshal', keyPath: path } },
      deviceId: 'phone-apns',
      target: { provider: 'apns' as const, token: 'device', liveToken: 'activity' },
      notice,
      apnsPost: async (request: { host: string; headers: Record<string, string | undefined>; body: string }) => {
        seen.push(request)
        return 200
      },
    }
    const first = await deliverPush(input)
    const second = await deliverPush({ ...input, notice: { ...notice, dedupeKey: 'approval:apns-live-2' } })
    expect(first.delivered).toBe(true)
    expect(second.delivered).toBe(true)
    expect(seen[0]?.host).toBe('api.sandbox.push.apple.com')
    expect(seen[0]?.headers['apns-push-type']).toBe('alert')
    expect(seen[0]?.headers[':path']).toBe('/3/device/device')
    expect(seen[1]?.headers['apns-push-type']).toBe('liveactivity')
    expect(seen[1]?.headers['apns-topic']).toBe('com.example.marshal.push-type.liveactivity')
    expect(seen[1]?.headers[':path']).toBe('/3/device/activity')
    const signature = String(seen[0]?.headers.authorization).split('.').at(-1) ?? ''
    expect(Buffer.from(signature, 'base64url').length).toBe(64)
    expect(seen[0]?.headers.authorization).toBe(seen[2]?.headers.authorization)
    const alert = JSON.parse(seen[0]?.body ?? '{}') as { aps: { alert?: { title: string } } }
    const live = JSON.parse(seen[1]?.body ?? '{}') as { aps: { event?: string; 'content-state'?: { title: string }; timestamp?: number } }
    expect(alert.aps.alert?.title).toBe('审批')
    expect(live.aps.event).toBe('update')
    expect(live.aps['content-state']?.title).toBe('审批')
    expect(typeof live.aps.timestamp).toBe('number')
  })

  it('does not call FCM when the key is missing', async () => {
    let called = false
    const result = await deliverPush({
      config: { fcm: { projectId: 'PLACEHOLDER', clientEmail: 'PLACEHOLDER', privateKeyPath: '/missing' } },
      deviceId: 'phone-1',
      target: { provider: 'fcm', token: 'abc' },
      notice: { kind: 'question', title: '提问', body: '请回答', dedupeKey: 'question:missing' },
      fetchImpl: (async () => { called = true; return new Response('{}', { status: 200 }) }) as typeof fetch,
    })
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('key-unreadable')
    expect(called).toBe(false)
  })

  it('posts FCM HTTP v1 and records a non-2xx as failure', async () => {
    const urls: string[] = []
    let body = ''
    const result = await deliverPush({
      config: { fcm: { projectId: 'proj', clientEmail: 'bot@proj.iam.gserviceaccount.com', privateKeyPath: keyFile() } },
      deviceId: 'phone-2',
      target: { provider: 'fcm', token: 'device-token' },
      notice: { kind: 'approval', title: '审批', body: '只允许这一次', dedupeKey: 'approval:fcm' },
      fetchImpl: (async (url: string, init?: { body?: string }) => {
        urls.push(String(url))
        if (typeof init?.body === 'string' && String(url).includes('fcm.googleapis.com')) body = init.body
        if (String(url).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'ya29' }), { status: 200 })
        return new Response('no', { status: 403 })
      }) as typeof fetch,
    })
    expect(JSON.parse(body).message.data.kind).toBe('approval')
    expect(urls[0]).toBe('https://oauth2.googleapis.com/token')
    expect(urls[1]).toBe('https://fcm.googleapis.com/v1/projects/proj/messages:send')
    expect(result).toEqual({ delivered: false, reason: 'provider-403' })
  })

  it('reports an FCM network failure as network', async () => {
    const result = await deliverPush({
      config: { fcm: { projectId: 'proj', clientEmail: 'net@proj.iam.gserviceaccount.com', privateKeyPath: keyFile() } },
      deviceId: 'phone-net',
      target: { provider: 'fcm', token: 'device-token' },
      notice: { kind: 'question', title: '提问', body: '请回答', dedupeKey: 'question:net' },
      fetchImpl: (async () => { throw new Error('socket') }) as typeof fetch,
    })
    expect(result).toEqual({ delivered: false, reason: 'network' })
  })

  it('posts Huawei Push Kit and only notifies watched sessions', async () => {
    const urls: string[] = []
    const result = await deliverPush({
      config: { huawei: { appId: '100', clientId: 'cid', clientSecretPath: keyFile() } },
      deviceId: 'phone-3',
      target: { provider: 'huawei', token: 'hms', liveToken: 'live' },
      notice: { kind: 'run-start', title: '开始', body: 's', dedupeKey: 'turn.started:s' },
      fetchImpl: (async (url: string) => {
        urls.push(String(url))
        if (String(url).includes('oauth-login.cloud.huawei.com')) return new Response(JSON.stringify({ access_token: 'h' }), { status: 200 })
        return new Response('{}', { status: 200 })
      }) as typeof fetch,
    })
    expect(urls[1]).toBe('https://push-api.cloud.huawei.com/v1/100/messages:send')
    expect(result.delivered).toBe(true)
    expect(noticeForEvent('turn.started', { deviceId: 'd', agent: 'dsh', sessionId: 's' }, new Set())).toBeNull()
    expect(noticeForEvent('turn.started', { deviceId: 'd', agent: 'dsh', sessionId: 's' }, new Set(['d|dsh|s']))?.kind).toBe('run-start')
    expect(noticeForEvent('turn.started', { deviceId: 'd', agent: 'dsh', sessionId: 's' }, new Set(['d|dsh|s']))?.sessionId).toBe('s')
  })

  it('updates the Live Activity for that session and not a shared token', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const path = join(mkdtempSync(join(tmpdir(), 'marshal-apns-')), 'key.pem')
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const paths: string[] = []
    const result = await deliverPush({
      config: { apns: { keyId: 'KEY123', teamId: 'TEAM', bundleId: 'com.example.marshal', keyPath: path } },
      deviceId: 'phone-sessions',
      target: { provider: 'apns', token: 'device', liveToken: 'shared', liveTokens: { s1: 'one', s2: 'two' } },
      notice: { kind: 'approval', title: '审批', body: '一次', dedupeKey: 'approval:session-s1', sessionId: 's1' },
      apnsPost: async (request) => { paths.push(request.headers[':path'] ?? ''); return 200 },
    })
    expect(result.delivered).toBe(true)
    expect(paths).toEqual(['/3/device/device', '/3/device/one'])
  })
})
