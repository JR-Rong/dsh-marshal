import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONNECTIVITY_TTL_MS as ttl, createConnectivity } from '../src/lib/connectivity.ts'

test('Hub and hosts expire at the last successful device snapshot; old roster may expire independently', () => {
  const status = createConnectivity()
  status.devices(5)
  status.roster(10)
  status.devices(15)
  assert.deepEqual(status.snapshot(9 + ttl), { hub: true, roster: true, expiry: 10 + ttl })
  assert.deepEqual(status.snapshot(10 + ttl), { hub: true, roster: false, expiry: 15 + ttl })
  assert.deepEqual(status.snapshot(15 + ttl), { hub: false, roster: false, expiry: Infinity })
})

for (const event of ['error', 'close', 'offline', 'probe failure'] as const) {
  test(`${event} immediately invalidates status and any in-flight snapshot`, () => {
    const status = createConnectivity()
    status.devices(5)
    status.roster(6)
    const old = status.beginProbe()
    assert.equal(status.accepts(old), true)
    if (event === 'error' || event === 'close') status.stream(event)
    else status.invalidate()
    assert.deepEqual(status.snapshot(7), { hub: false, roster: false, expiry: Infinity })
    assert.equal(status.accepts(old), false)
    if (event === 'error' || event === 'close') {
      assert.equal(status.accepts(status.beginProbe()), false)
      status.stream('open')
    }
    assert.equal(status.accepts(status.beginProbe()), true)
    assert.equal(status.snapshot(8).hub, false)
    status.devices(9)
    assert.equal(status.snapshot(9).hub, true)
    assert.equal(status.snapshot(9).roster, false)
  })
}
