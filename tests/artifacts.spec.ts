import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readArtifactChunk } from '../src/node/artifacts.ts'
import { DeviceRegistry } from '../src/hub/registry.ts'
import { HubRelay } from '../src/hub/relay.ts'
import { registerMarshalRoutes } from '../src/hub/api.ts'
import { decodeFrame } from '../src/wire/frames.ts'
import { createMemoryWeb } from './support/memory.ts'

const TOKEN = 'test-artifact-token-0123456789abcdef'
const ORIGIN = 'https://marshal.example'
const AUTH = { 'x-marshal-token': TOKEN }

const cleanupDirs: string[] = []
afterEach(() => {
  while (cleanupDirs.length > 0) {
    rmSync(cleanupDirs.pop()!, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-artifact-test-'))
  cleanupDirs.push(dir)
  return dir
}

describe('node artifact reader security & chunking', () => {
  it('读取源码文本并脱敏内置凭据，同时支持 file:// 与行号片段', () => {
    const dir = tempDir()
    const file = join(dir, 'sample.ts')
    writeFileSync(file, 'export const a = 1\nconst key = "sk-1234567890abcdef123456"\n', 'utf8')

    const res = readArtifactChunk({
      path: `file://${file}#L1-L2`,
      allowedRoots: [dir],
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.kind).toBe('text')
      expect(res.encoding).toBe('utf8')
      expect(res.name).toBe('sample.ts')
      expect(res.eof).toBe(true)
      expect(res.data).toContain('export const a = 1')
      expect(res.data).not.toContain('sk-1234567890abcdef123456')
      expect(res.data).toContain('***')
    }
  })

  it('按分片读取二进制图片/视频并完整还原字节', () => {
    const dir = tempDir()
    const file = join(dir, 'render.mp4')
    const payload = Buffer.alloc(1024, 0xab)
    payload.write('ftypmp42', 4, 'ascii')
    writeFileSync(file, payload)

    const c1 = readArtifactChunk({ path: file, offset: 0, maxBytes: 400, allowedRoots: [dir] })
    const c2 = readArtifactChunk({ path: file, offset: 400, maxBytes: 400, allowedRoots: [dir] })
    const c3 = readArtifactChunk({ path: file, offset: 800, maxBytes: 400, allowedRoots: [dir] })
    expect(c1.ok && c2.ok && c3.ok).toBe(true)
    if (c1.ok && c2.ok && c3.ok) {
      expect(c1.kind).toBe('video')
      expect(c1.mime).toBe('video/mp4')
      expect(c1.eof).toBe(false)
      expect(c2.eof).toBe(false)
      expect(c3.eof).toBe(true)
      const reassembled = Buffer.concat([
        Buffer.from(c1.data, 'base64'),
        Buffer.from(c2.data, 'base64'),
        Buffer.from(c3.data, 'base64'),
      ])
      expect(reassembled.equals(payload)).toBe(true)
    }
  })

  it('拦截 .env / .ssh / .pem 与越界软链接', () => {
    const dir = tempDir()
    const outside = tempDir()
    const sshDir = join(dir, '.ssh')
    mkdirSync(sshDir)
    writeFileSync(join(sshDir, 'id_ed25519'), 'PRIVATE')
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    writeFileSync(join(dir, '.env.example'), 'SECRET=placeholder')
    writeFileSync(join(dir, 'cert.pem'), 'PEM')
    writeFileSync(join(outside, 'escape.txt'), 'OUTSIDE')
    symlinkSync(join(outside, 'escape.txt'), join(dir, 'link.txt'))

    expect(readArtifactChunk({ path: join(sshDir, 'id_ed25519'), allowedRoots: [dir] })).toEqual({ ok: false, code: 'unsupported' })
    expect(readArtifactChunk({ path: join(dir, '.env'), allowedRoots: [dir] })).toEqual({ ok: false, code: 'unsupported' })
    expect(readArtifactChunk({ path: join(dir, 'cert.pem'), allowedRoots: [dir] })).toEqual({ ok: false, code: 'unsupported' })
    expect(readArtifactChunk({ path: join(dir, 'link.txt'), allowedRoots: [dir] })).toEqual({ ok: false, code: 'unsupported' })
    expect(readArtifactChunk({ path: join(dir, 'missing.png'), allowedRoots: [dir] })).toEqual({ ok: false, code: 'record-unavailable' })
    expect(readArtifactChunk({ path: join(dir, '.env.example'), allowedRoots: [dir] }).ok).toBe(true)
  })
})

describe('hub /marshal/api/artifact round-trip', () => {
  it('转发 artifact.read 到边缘节点并将 artifact.result 返回客户端', async () => {
    const dir = tempDir()
    const img = join(dir, 'shot.png')
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    writeFileSync(img, pngBytes)

    const registry = new DeviceRegistry()
    const relay = new HubRelay({ registry, now: Date.now, timeoutMs: 200, hubEpoch: 'hub-art' })
    registry.attach(
      { id: 'mac', name: 'M5', agents: ['dsh'] },
      {
        send: (raw) => {
          const frame = decodeFrame(raw)
          if (frame.type === 'artifact.read') {
            const chunk = readArtifactChunk({ path: frame.path, offset: frame.offset, maxBytes: frame.maxBytes, allowedRoots: [dir] })
            relay.settleArtifact(
              { v: 2, type: 'artifact.result', requestId: frame.requestId, ...chunk },
              { deviceId: 'mac', connectionId: 'c1', nodeEpoch: 'e1' },
            )
          }
        },
      },
      0,
      { connectionId: 'c1', nodeEpoch: 'e1' },
    )
    const web = createMemoryWeb()
    const routes = registerMarshalRoutes({
      webServer: web.webServer,
      registry,
      relay,
      requireToken: TOKEN,
      publicOrigin: ORIGIN,
      operatorId: 'op-art',
      loginFailureDelayMs: 0,
    })
    try {
      const okRes = await web.request('/marshal/api/artifact', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, path: img }),
      })
      expect(okRes.statusCode).toBe(200)
      const body = okRes.json<Record<string, unknown>>()
      expect(body.ok).toBe(true)
      expect(body.kind).toBe('image')
      expect(body.mime).toBe('image/png')
      expect(Buffer.from(String(body.data), 'base64').equals(pngBytes)).toBe(true)

      const missingRes = await web.request('/marshal/api/artifact', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: { deviceId: 'mac', agent: 'dsh', sessionId: 's1' }, path: join(dir, 'nope.png') }),
      })
      expect(missingRes.statusCode).toBe(404)
      expect(missingRes.json()).toEqual({ ok: false, code: 'record-unavailable' })
    } finally {
      routes.dispose()
      relay.dispose()
    }
  })
})
