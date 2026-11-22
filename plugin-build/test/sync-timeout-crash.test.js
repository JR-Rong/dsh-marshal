import assert from 'node:assert/strict'
import test from 'node:test'
import { createPrivacyProjector } from '../lib/src/node/privacy.js'
import { createNodeSync } from '../lib/src/node/sync.js'

function makeLink(overrides = {}) {
  const link = {
    state: 'syncing',
    online: false,
    handshake: { connectionId: 'conn-1', nodeEpoch: 'epoch-1', serverTimeOffset: 0 },
    controls: [],
    rejected: [],
    confirmed: [],
    beginSync() { return true },
    confirmSync(syncId) {
      this.confirmed.push(syncId)
      this.state = 'online'
      this.online = true
      return true
    },
    rejectSync(reason) {
      this.rejected.push(reason)
      this.online = false
    },
    sendControl(text) {
      this.controls.push(text)
    },
    ...overrides,
  }
  return link
}

function makeProjector() {
  return createPrivacyProjector({
    privacy: 'metadata',
    allowContent: false,
    questionRelay: 'off',
    approvalRelay: 'off',
    allowInteractions: false,
    redaction: [],
    deviceId: 'mac',
    agent: 'dsh',
    nodeEpoch: 'epoch-1',
    now: () => 1,
  })
}

test('initial sync gather timeout rejects link without leaking unhandledRejection Symbol(sync-timeout)', async () => {
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const warnings = []
  let sync
  try {
    const link = makeLink()
    const projector = makeProjector()
    sync = createNodeSync({
      link,
      sources: [{
        agent: 'dsh',
        async syncSnapshot(signal) {
          return await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              // Even if source never settles or rejects late, gather deadline wins first.
            }, { once: true })
          })
        },
      }],
      agents: ['dsh'],
      projector: () => projector,
      emit: () => {},
      frame: (agent, sessionId, kind, payload) => ({
        v: 2, type: 'event', deviceId: 'mac', agent, sessionId, nodeEpoch: 'epoch-1', seq: 0, ts: 1, kind, payload,
      }),
      scanTimeoutMs: 25,
      ackTimeoutMs: 100,
      logger: { warn: (msg) => warnings.push(msg) },
    })

    sync.begin()
    await new Promise((resolve) => setTimeout(resolve, 60))

    assert.deepEqual(unhandled, [])
    assert.deepEqual(link.rejected, ['sync-timeout'])
    assert.equal(sync.syncing, false)
    assert.equal(sync.stale, true)
    assert.ok(warnings.some((msg) => String(msg).includes('sync-timeout')))
  } finally {
    sync?.dispose()
    process.off('unhandledRejection', onUnhandled)
  }
})

test('synchronous sendControl error after waitAck does not leak unhandledRejection Symbol(sync-timeout)', async () => {
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  let sync
  try {
    const link = makeLink({
      sendControl(text) {
        const parsed = JSON.parse(text)
        if (parsed.type === 'sync.end') throw new Error('ws-closed')
        this.controls.push(text)
      },
    })
    const projector = makeProjector()
    sync = createNodeSync({
      link,
      sources: [{
        agent: 'dsh',
        async syncSnapshot() {
          return { rows: [{ sessionId: 's1', running: false, updatedAt: 1, blank: false }], capabilities: [], completeness: 'complete' }
        },
      }],
      agents: ['dsh'],
      projector: () => projector,
      emit: () => {},
      frame: (agent, sessionId, kind, payload) => ({
        v: 2, type: 'event', deviceId: 'mac', agent, sessionId, nodeEpoch: 'epoch-1', seq: 0, ts: 1, kind, payload,
      }),
      scanTimeoutMs: 100,
      ackTimeoutMs: 100,
    })

    sync.begin()
    await new Promise((resolve) => setTimeout(resolve, 40))

    assert.deepEqual(unhandled, [])
    assert.deepEqual(link.rejected, ['sync-failed'])
    assert.equal(sync.syncing, false)
    assert.equal(sync.stale, true)
  } finally {
    sync?.dispose()
    process.off('unhandledRejection', onUnhandled)
  }
})
