import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOCK_ITERATIONS, createLock, equalBytes, isValidPin, verifyPin } from '../src/lib/lock.ts'

test('PIN 只接受 4 到 8 位数字', () => {
  assert.equal(isValidPin('1234'), true)
  assert.equal(isValidPin('12345678'), true)
  assert.equal(isValidPin('123'), false)
  assert.equal(isValidPin('123456789'), false)
  assert.equal(isValidPin('12a4'), false)
})

test('设置与校验 PIN 往返', async () => {
  const record = await createLock('123456', 20_000)
  assert.equal(record.iterations, 20_000)
  assert.equal(await verifyPin('123456', record), true)
  assert.equal(await verifyPin('654321', record), false)
})

test('默认迭代次数足够高', () => {
  assert.ok(LOCK_ITERATIONS >= 100_000)
})

test('盐每次不同，摘要不重复', async () => {
  const a = await createLock('123456', 20_000)
  const b = await createLock('123456', 20_000)
  assert.notEqual(a.salt, b.salt)
  assert.notEqual(a.hash, b.hash)
})

test('equalBytes 常数时间比较语义', () => {
  assert.equal(equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true)
  assert.equal(equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false)
  assert.equal(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false)
})

test('损坏的锁记录不会误放行', async () => {
  const record = { salt: '!!!', hash: '???', iterations: 20_000 }
  assert.equal(await verifyPin('123456', record), false)
})
