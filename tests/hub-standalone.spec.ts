import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import { startHubServer } from '../src/hub/standalone.ts'
import { ensureInstall } from '../src/hub/identity.ts'
import { CONTRACT_REVISION } from '../src/wire/frames.ts'

const cert = readFileSync(new URL('./fixtures/tls-cert.pem', import.meta.url))
const key = readFileSync(new URL('./fixtures/tls-key.pem', import.meta.url))
const dashboardToken = 'standalone-hub-token-0123456789abcdef'
const logger = { info() {}, warn() {}, error() {} }

describe('standalone TLS Hub', () => {
  it('serves authenticated APIs and the embedded page, accepts a registered WSS node, and closes live sockets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marshal-cloud-'))
    const devicesFile = join(dir, 'devices.json')
    const device = ensureInstall(devicesFile).store.add('cloud-test', 'Cloud test')
    const hub = await startHubServer({ config: { role: 'hub', devicesFile, dashboardToken, publicOrigin: 'https://127.0.0.1' }, cert, key, host: '127.0.0.1', port: 0, logger })
    const address = hub.server.address()
    if (!address || typeof address === 'string') throw new Error('missing listener')
    const base = `https://127.0.0.1:${address.port}`
    const get = (path: string, authenticated = false) => new Promise<{ status: number; body: string; csp?: string }>((resolve, reject) => {
      const req = request(base + path, { ca: cert, agent: false, headers: authenticated ? { 'x-marshal-token': dashboardToken } : {} }, res => {
        let body = ''
        res.on('data', chunk => { body += String(chunk) })
        res.on('end', () => resolve({ status: res.statusCode!, body, ...(res.headers['content-security-policy'] ? { csp: String(res.headers['content-security-policy']) } : {}) }))
      })
      req.on('error', reject).end()
    })
    let socket: WebSocket | undefined
    try {
      expect((await get('/marshal/health')).status).toBe(200)
      expect((await get('/unknown')).status).toBe(404)
      expect((await get('/marshal/api/devices')).status).toBe(401)
      expect((await get('/marshal/api/devices', true)).status).toBe(200)
      expect((await get('/marshal/desktop')).csp).toBe('frame-ancestors dsh-app://app')
      const wrong = new WebSocket(base.replace('https:', 'wss:') + '/not-uplink', { ca: cert })
      const failure = await new Promise<Error>(resolve => wrong.once('error', resolve))
      expect(failure.message).toContain('404')
      socket = new WebSocket(base.replace('https:', 'wss:') + '/marshal/uplink', { ca: cert, headers: { authorization: `Bearer ${device.token}` } })
      await once(socket, 'open')
      const ack = once(socket, 'message', { signal: AbortSignal.timeout(2_000) })
      socket.send(JSON.stringify({ v: 2, type: 'hello', deviceId: 'cloud-test', deviceName: 'Cloud test', agents: ['codex'], features: [], privacy: 'metadata', nodeEpoch: 'cloud-epoch', contractRevision: CONTRACT_REVISION }))
      const [raw] = await ack
      expect(JSON.parse(String(raw)).type).toBe('hello.ack')
      const closed = once(socket, 'close')
      await hub.close()
      await closed
      expect(hub.server.listening).toBe(false)
      await hub.close()
    } finally {
      socket?.terminate()
      await hub.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects node configuration before opening a listener', async () => {
    await expect(startHubServer({ cert, key, logger, config: {
      role: 'node', hubUrl: 'wss://example.com/marshal/uplink', deviceId: 'mac', token: 'test-token-0123456789abcdef',
    } })).rejects.toThrow('requires role=hub')
  })
})
