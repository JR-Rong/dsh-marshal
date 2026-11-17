import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UploadSchema, UploadStore } from '../src/node/uploads.ts'
import { createDshSurface } from '../src/adapters/dsh/surface.ts'
import { vi } from 'vitest'

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
describe('session attachments', () => {
  it('checks complete bytes and scope before exposing a local file', () => {
    let now = 0; const store = new UploadStore(() => now), bytes = Buffer.from('附件内容 split across chunks')
    const input = { id: randomUUID(), name: 'input.txt', mime: 'text/plain', size: bytes.length, sha256: hash(bytes) }
    expect(store.put('mac/codex/session/operator/epoch', { ...input, offset: 0, data: bytes.subarray(0, 3).toString('base64') }).complete).toBe(false)
    expect(() => store.resolve('mac/codex/session/operator/epoch', [input.id])).toThrow()
    expect(() => store.put('other-session', { ...input, offset: 3, data: bytes.subarray(3).toString('base64') })).toThrow()
    expect(store.put('mac/codex/session/operator/epoch', { ...input, offset: 3, data: bytes.subarray(3).toString('base64') }).complete).toBe(true)
    const [file] = store.resolve('mac/codex/session/operator/epoch', [input.id])
    try {
      expect(readFileSync(file!.path)).toEqual(bytes)
      expect(() => store.resolve('other-session', [input.id])).toThrow()
      now = 3_600_001; expect(() => store.resolve('mac/codex/session/operator/epoch', [input.id])).toThrow()
    } finally { rmSync(dirname(dirname(file!.path)), { recursive: true, force: true }) }
  })
  it('rejects traversal, oversized payloads, corrupted checksums and noncanonical base64', () => {
    const store = new UploadStore(), bytes = Buffer.from('test')
    const input = { id: randomUUID(), name: '../bad', mime: '', size: bytes.length, sha256: hash(bytes), offset: 0, data: bytes.toString('base64') }
    expect(() => store.put('s', input)).toThrow()
    expect(() => store.put('s', { ...input, name: 'file', data: '!!!!' })).toThrow()
    expect(() => store.put('s', { ...input, name: 'file', sha256: '0'.repeat(64) })).toThrow()
    expect(UploadSchema.safeParse({ ...input, size: 11 * 1024 * 1024 }).success).toBe(false)
  })
  it('uses the DSH native model selection and preserves ordinary prompt admission', async () => {
    const selectModel = vi.fn(async () => ({})), prompt = vi.fn(async (_request: unknown) => ({ accepted: true }))
    const surface = createDshSurface({
      list: async () => ({ items: [{ sessionId: 's', running: false, blank: false, updatedAt: 1 }] }),
      async *follow() {}, cancel() {}, prompt, selectModel,
      modelCatalog: async () => ({ groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model', reasoning: { efforts: [{ id: 'low' }] } }] }] }),
    })
    await surface.prompt({ sessionId: 's', text: 'test', requestId: 'r', options: { model: 'provider/model', reasoning: 'low' } })
    expect(selectModel).toHaveBeenCalledWith({ sessionId: 's', provider: 'provider', model: 'model', reasoningEffort: 'low' })
    expect(prompt.mock.calls[0]?.[0]).toEqual({ requestId: 'r', sessionId: 's', content: [{ type: 'text', text: 'test' }] })
  })
})
