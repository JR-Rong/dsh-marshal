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
    const result = await deliverPush({
      config: { fcm: { projectId: 'proj', clientEmail: 'bot@proj.iam.gserviceaccount.com', privateKeyPath: keyFile() } },
      deviceId: 'phone-2',
      target: { provider: 'fcm', token: 'device-token' },
      notice: { kind: 'approval', title: '审批', body: '只允许这一次', dedupeKey: 'approval:fcm' },
      fetchImpl: (async (url: string) => {
        urls.push(String(url))
        if (String(url).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'ya29' }), { status: 200 })
        return new Response('no', { status: 403 })
      }) as typeof fetch,
    })
    expect(urls[0]).toBe('https://oauth2.googleapis.com/token')
    expect(urls[1]).toBe('https://fcm.googleapis.com/v1/projects/proj/messages:send')
    expect(result).toEqual({ delivered: false, reason: 'provider-403' })
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
  })
})
