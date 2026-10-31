import { describe, expect, it } from 'vitest'
import {
  CodexPeerError, createCodexPeer,
  type CodexPeerOptions, type CodexPeerTimers,
} from '../src/agents/codex/peer.ts'
import { parseThreadListResponse } from '../src/agents/codex/protocol.ts'

function harness(overrides: Partial<CodexPeerOptions> = {}) {
  const lines: string[] = []
  const notifications: Array<{ method: string; params: unknown }> = []
  const peer = createCodexPeer({
    write: line => { lines.push(line) },
    onNotification: (method, params) => { notifications.push({ method, params }) },
    requestTimeoutMs: 1_000,
    ...overrides,
  })
  return { peer, lines, notifications }
}

class ManualTimers implements CodexPeerTimers {
  private readonly callbacks = new Map<number, () => void>()
  private nextId = 1

  setTimeout(callback: () => void, _ms: number): unknown {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    return id
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number)
  }

  fire(): void {
    const pending = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const callback of pending) callback()
  }
}

const accept = (value: unknown): true | undefined => (value === undefined ? undefined : true)

describe('codex peer', () => {
  it('reassembles fragmented NDJSON and resolves the matching request', async () => {
    const { peer } = harness()
    const pending = peer.request('thread/list', { limit: 1 }, new AbortController().signal, parseThreadListResponse)
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data: [] } })
    peer.handle(line.slice(0, 9))
    peer.handle(`${line.slice(9)}\n`)
    await expect(pending).resolves.toEqual({ data: [] })
  })

  it('tolerates CRLF line endings', async () => {
    const { peer } = harness()
    const pending = peer.request('thread/list', { limit: 1 }, new AbortController().signal, parseThreadListResponse)
    peer.handle('{"jsonrpc":"2.0","id":1,"result":{"data":[]}}\r\n')
    await expect(pending).resolves.toEqual({ data: [] })
  })

  it('times out without resending the request', async () => {
    const timers = new ManualTimers()
    const { peer, lines } = harness({ timers })
    const pending = peer.request('thread/list', {}, new AbortController().signal, parseThreadListResponse)
    expect(lines).toHaveLength(1)
    timers.fire()
    const error = await pending.catch(reason => reason)
    expect(error).toBeInstanceOf(CodexPeerError)
    expect(error).toMatchObject({ code: 'timeout' })
    // 超时只拒绝本请求；绝不自动重发。
    expect(lines).toHaveLength(1)
    expect(peer.closed).toBe(false)
  })

  it('closes the connection on malformed JSON and rejects pending requests', async () => {
    const { peer } = harness()
    const pending = peer.request('thread/list', {}, new AbortController().signal, parseThreadListResponse)
    peer.handle('not-json\n')
    await expect(pending).rejects.toMatchObject({ code: 'closed' })
    expect(peer.closed).toBe(true)
    expect(peer.stats().protocolErrors).toBe(1)
  })

  it('closes when an unfinished line exceeds the byte cap', () => {
    const { peer } = harness({ maxLineBytes: 1_024 })
    peer.handle('x'.repeat(2_000))
    expect(peer.closed).toBe(true)
    expect(peer.stats().protocolErrors).toBe(1)
  })

  it('answers server requests with method-not-found when no handler is registered', () => {
    const { peer, lines } = harness()
    peer.handle('{"jsonrpc":"2.0","id":7,"method":"item/commandExecution/requestApproval","params":{}}\n')
    expect(peer.stats().serverRequests).toBe(1)
    expect(lines).toHaveLength(1)
    const response = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    expect(response.id).toBe(7)
    expect(response).toHaveProperty('error.code', -32601)
  })

  it('returns the registered handler result for server requests', () => {
    const { peer, lines } = harness({
      onServerRequest: () => ({ result: { decision: 'decline' } }),
    })
    peer.handle('{"jsonrpc":"2.0","id":8,"method":"item/commandExecution/requestApproval","params":{}}\n')
    const response = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    expect(response).toMatchObject({ id: 8, result: { decision: 'decline' } })
  })

  it('counts unknown notifications instead of routing them', () => {
    const { peer, notifications } = harness({
      knownNotifications: new Set(['turn/started']),
    })
    peer.handle('{"jsonrpc":"2.0","method":"vendor/unknown","params":{}}\n')
    peer.handle('{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"s1"}}\n')
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.method).toBe('turn/started')
    expect(peer.stats().unknownNotifications).toBe(1)
  })

  it('rejects aborted requests without writing anything else', async () => {
    const { peer, lines } = harness()
    const controller = new AbortController()
    const pending = peer.request('thread/list', {}, controller.signal, parseThreadListResponse)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    expect(lines).toHaveLength(1)
  })

  it('rejects new requests once the pending cap is reached', async () => {
    const { peer } = harness({ maxPending: 1 })
    const first = peer.request('thread/list', {}, new AbortController().signal, parseThreadListResponse)
    await expect(
      peer.request('thread/list', {}, new AbortController().signal, parseThreadListResponse),
    ).rejects.toMatchObject({ code: 'busy' })
    peer.close()
    await expect(first).rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects every pending request on close', async () => {
    const { peer } = harness()
    const pending = peer.request('thread/list', {}, new AbortController().signal, accept)
    peer.close()
    await expect(pending).rejects.toMatchObject({ code: 'closed' })
  })

  it('routes known notifications without id', () => {
    const { peer, notifications } = harness()
    peer.notify('initialized')
    peer.handle('{"jsonrpc":"2.0","method":"thread/status/changed","params":{"threadId":"s1"}}\n')
    expect(notifications.map(item => item.method)).toEqual(['thread/status/changed'])
  })
})
