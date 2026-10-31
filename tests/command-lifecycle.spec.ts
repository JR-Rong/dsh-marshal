import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PreCallRejection, type Adapter } from '../src/adapters/types.ts'
import type { HandshakeBinding, NodeLink } from '../src/node/link.ts'
import { JournalError, openJournal, type Journal } from '../src/node/journal.ts'
import { createFollower, runCommand } from '../src/node/runner.ts'
import type {
  AckFrame, CommandFrame, CommandStatusFrame, CommandStatusResultFrame, Frame,
} from '../src/wire/frames.ts'

const dirs: string[] = []
const journals: Journal[] = []

function setup(capacity?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-lifecycle-'))
  dirs.push(dir)
  const file = join(dir, 'journal.json')
  const keyFile = join(dir, 'journal.key')
  const initFile = join(dir, 'journal.init')
  const journal = openJournal({ file, keyFile, initFile, ...(capacity === undefined ? {} : { capacity }) })
  journals.push(journal)
  return { dir, file, keyFile, initFile, journal }
}

function target(sessionId = 's1') {
  return { deviceId: 'mac', agent: 'dsh', sessionId }
}

function command(options: {
  key: string
  op?: CommandFrame['op']
  args?: unknown
  id?: string
  deadline?: number
  sessionId?: string
  connectionId?: string
  nodeEpoch?: string
}): CommandFrame {
  return {
    v: 2, type: 'command',
    commandId: options.id ?? `c-${Math.random().toString(36).slice(2)}`,
    idempotencyKey: options.key,
    operatorId: 'operator-1',
    target: target(options.sessionId),
    op: options.op ?? 'prompt',
    args: options.args ?? { text: 'hi' },
    issuedAt: 0,
    deadline: options.deadline ?? Date.now() + 10_000,
    connectionId: options.connectionId ?? 'conn-1',
    nodeEpoch: options.nodeEpoch ?? 'epoch-1',
  }
}

function statusQuery(key: string, overrides: {
  deviceId?: string
  agent?: string
  requestId?: string
  connectionId?: string
  nodeEpoch?: string
} = {}): CommandStatusFrame {
  const base = target()
  return {
    v: 2, type: 'command.status',
    requestId: overrides.requestId ?? `r-${Math.random().toString(36).slice(2)}`,
    operatorId: 'operator-1',
    target: {
      deviceId: overrides.deviceId ?? base.deviceId,
      agent: overrides.agent ?? base.agent,
      sessionId: base.sessionId,
    },
    idempotencyKey: key,
    connectionId: overrides.connectionId ?? 'conn-1',
    nodeEpoch: overrides.nodeEpoch ?? 'epoch-1',
  }
}

function harness() {
  let calls = 0
  let mode: 'ok' | 'reject' | 'after-call' | 'huge' = 'ok'
  let binding: HandshakeBinding | undefined = {
    connectionId: 'conn-1', nodeEpoch: 'epoch-1', serverTimeOffset: 0,
  }
  const adapter = {
    agent: 'dsh',
    async execute() {
      calls += 1
      if (mode === 'reject') throw new PreCallRejection('session-unknown')
      if (mode === 'after-call') throw new Error('native transport lost')
      if (mode === 'huge') return { accepted: true, blob: 'x'.repeat(2 * 1024 * 1024) }
      return { accepted: true }
    },
  } as unknown as Adapter
  const sent: Frame[] = []
  const link = {
    sendRaw(text: string) { sent.push(JSON.parse(text) as Frame) },
    get handshake(): HandshakeBinding | undefined { return binding },
  } as unknown as NodeLink
  const follower = createFollower({ adapter, send: () => {}, logger: { warn() {} } })
  return {
    adapter,
    follower,
    link,
    sent,
    calls: () => calls,
    setMode(next: 'ok' | 'reject' | 'after-call' | 'huge') { mode = next },
    setBinding(next: HandshakeBinding | undefined) { binding = next },
    acks(): AckFrame[] { return sent.filter((frame): frame is AckFrame => frame.type === 'ack') },
    statusResults(): CommandStatusResultFrame[] {
      return sent.filter((frame): frame is CommandStatusResultFrame => frame.type === 'command.status.result')
    },
  }
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('node command lifecycle', () => {
  it('同键并发只调用一次，其余返回 pending-confirmation', async () => {
    const { journal } = setup()
    const h = harness()
    for (let index = 0; index < 100; index += 1) {
      runCommand(h.link, h.adapter, h.follower, command({ key: 'burst', id: `c-${index}` }), 'mac', journal)
    }
    // adapter.execute 同步进入函数体，第一条命令在循环内就会计数一次。
    expect(h.calls()).toBe(1)
    await flush()
    expect(h.calls()).toBe(1)
    const acks = h.acks()
    expect(acks).toHaveLength(100)
    expect(acks.filter(ack => ack.status === 'accepted')).toHaveLength(1)
    expect(acks.filter(ack => ack.status === 'pending-confirmation')).toHaveLength(99)
  })

  it('同键不同载荷返回 idempotency-conflict 且不二次调用', async () => {
    const { journal } = setup()
    const h = harness()
    runCommand(h.link, h.adapter, h.follower, command({ key: 'same', args: { text: 'a' }, id: 'c1' }), 'mac', journal)
    runCommand(h.link, h.adapter, h.follower, command({ key: 'same', args: { text: 'b' }, id: 'c2' }), 'mac', journal)
    await flush()
    expect(h.calls()).toBe(1)
    expect(h.acks()).toMatchObject([
      { commandId: 'c2', status: 'rejected', code: 'idempotency-conflict' },
      { commandId: 'c1', status: 'accepted' },
    ])
    expect(journal.lookup({ operatorId: 'operator-1', target: target(), idempotencyKey: 'same' })?.status)
      .toBe('accepted')
  })

  it('journal 满拒绝新写且零调用', async () => {
    const { journal } = setup(1)
    const h = harness()
    runCommand(h.link, h.adapter, h.follower, command({ key: 'first' }), 'mac', journal)
    await flush()
    expect(h.calls()).toBe(1)

    runCommand(h.link, h.adapter, h.follower, command({ key: 'second' }), 'mac', journal)
    await flush()
    expect(h.calls()).toBe(1)
    expect(h.acks().at(-1)).toMatchObject({ status: 'rejected', code: 'size-limit' })
    expect(journal.size).toBe(1)
  })

  it('崩溃恢复后 admitted 记录以 outcome-unknown 返回且不再调用', async () => {
    const first = setup()
    first.journal.admit({
      domain: { operatorId: 'operator-1', target: target(), idempotencyKey: 'crash' },
      op: 'prompt',
      args: { text: 'hi' },
    })
    first.journal.close()
    journals.splice(journals.indexOf(first.journal), 1)

    const reopened = openJournal({ file: first.file, keyFile: first.keyFile })
    journals.push(reopened)
    const h = harness()
    runCommand(h.link, h.adapter, h.follower, command({ key: 'crash' }), 'mac', reopened)
    await flush()
    expect(h.calls()).toBe(0)
    expect(h.acks()[0]).toMatchObject({ status: 'outcome-unknown' })
    expect(reopened.lookup({ operatorId: 'operator-1', target: target(), idempotencyKey: 'crash' })?.status)
      .toBe('outcome-unknown')
  })

  it('调用前拒绝记 rejected，调用后异常记 outcome-unknown', async () => {
    const { journal } = setup()
    const h = harness()
    h.setMode('reject')
    runCommand(h.link, h.adapter, h.follower, command({ key: 'pre' }), 'mac', journal)
    await flush()
    h.setMode('after-call')
    runCommand(h.link, h.adapter, h.follower, command({ key: 'post' }), 'mac', journal)
    await flush()
    expect(h.acks()).toMatchObject([
      { status: 'rejected', code: 'session-unknown' },
      { status: 'outcome-unknown', code: 'outcome-unknown' },
    ])
    expect(journal.lookup({ operatorId: 'operator-1', target: target(), idempotencyKey: 'pre' })?.status)
      .toBe('rejected')
    expect(journal.lookup({ operatorId: 'operator-1', target: target(), idempotencyKey: 'post' })?.status)
      .toBe('outcome-unknown')
  })

  it('只读状态查询返回已存状态，无记录返回 record-unavailable', async () => {
    const { journal } = setup()
    const h = harness()
    runCommand(h.link, h.adapter, h.follower, command({ key: 'known' }), 'mac', journal)
    await flush()
    runCommand(h.link, h.adapter, h.follower, statusQuery('known'), 'mac', journal)
    runCommand(h.link, h.adapter, h.follower, statusQuery('missing'), 'mac', journal)
    expect(h.statusResults()).toMatchObject([
      { status: 'accepted' },
      { status: 'outcome-unknown', code: 'record-unavailable' },
    ])

    // 目标/agent 不符必须拒绝，且不能泄露记录。
    runCommand(h.link, h.adapter, h.follower, statusQuery('known', { deviceId: 'pc' }), 'mac', journal)
    runCommand(h.link, h.adapter, h.follower, statusQuery('known', { agent: 'codex' }), 'mac', journal)
    expect(h.statusResults().slice(-2)).toMatchObject([
      { status: 'rejected', code: 'device-mismatch' },
      { status: 'rejected', code: 'session-unknown' },
    ])
  })

  it('journal 只保存摘要，不保存 prompt', async () => {
    const { journal, file } = setup()
    const h = harness()
    runCommand(h.link, h.adapter, h.follower, command({ key: 'secret', args: { text: 'PROMPT-SENTINEL-42' } }), 'mac', journal)
    await flush()
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('PROMPT-SENTINEL-42')
    expect(raw).toContain('payloadDigest')
  })

  it('过期命令零调用且不占 journal', async () => {
    const { journal } = setup()
    const h = harness()
    runCommand(h.link, h.adapter, h.follower, command({ key: 'late', deadline: Date.now() - 1 }), 'mac', journal)
    await flush()
    expect(h.calls()).toBe(0)
    expect(h.acks()[0]).toMatchObject({ status: 'rejected', code: 'deadline-expired' })
    expect(journal.size).toBe(0)
  })

  it('observe 不写 journal', async () => {
    const { journal } = setup()
    const h = harness()
    runCommand(h.link, h.adapter, h.follower, command({
      key: 'observe', op: 'observe', args: { kind: 'follow', action: 'subscribe' },
    }), 'mac', journal)
    await flush()
    expect(journal.size).toBe(0)
    expect(h.acks()[0]).toMatchObject({ status: 'accepted' })
  })

  it('结果超过帧上限时保留真实状态并只回 result-too-large', async () => {
    const { journal } = setup()
    const h = harness()
    h.setMode('huge')
    runCommand(h.link, h.adapter, h.follower, command({ key: 'huge' }), 'mac', journal)
    await flush()
    expect(h.calls()).toBe(1)
    expect(h.acks()).toHaveLength(1)
    expect(h.acks()[0]).toMatchObject({ status: 'accepted', code: 'result-too-large' })
    // 真实结果没有回传，但幂等登记仍是 accepted，不能被当成 rejected。
    expect(h.acks()[0]?.result).toBeUndefined()
    expect(journal.lookup({ operatorId: 'operator-1', target: target(), idempotencyKey: 'huge' })?.status)
      .toBe('accepted')
  })

  it('旧连接/旧代次的命令与状态查询返回 stale-connection', async () => {
    const { journal } = setup()
    const h = harness()
    runCommand(h.link, h.adapter, h.follower, command({ key: 'old-conn', connectionId: 'conn-old' }), 'mac', journal)
    runCommand(h.link, h.adapter, h.follower, command({ key: 'old-epoch', nodeEpoch: 'epoch-0' }), 'mac', journal)
    runCommand(h.link, h.adapter, h.follower, statusQuery('old-conn', { connectionId: 'conn-old' }), 'mac', journal)
    await flush()
    expect(h.calls()).toBe(0)
    expect(h.acks()).toMatchObject([
      { status: 'rejected', code: 'stale-connection' },
      { status: 'rejected', code: 'stale-connection' },
    ])
    expect(h.statusResults()[0]).toMatchObject({ status: 'rejected', code: 'stale-connection' })
    expect(journal.size).toBe(0)

    // 没有握手证据（未完成握手）同样不能执行。
    h.setBinding(undefined)
    runCommand(h.link, h.adapter, h.follower, command({ key: 'unbound' }), 'mac', journal)
    await flush()
    expect(h.calls()).toBe(0)
    expect(h.acks().at(-1)).toMatchObject({ status: 'rejected', code: 'stale-connection' })
  })

  it('时钟偏差超过 60s 时拒绝副作用命令且零写入', async () => {
    const { journal } = setup()
    const h = harness()
    h.setBinding({ connectionId: 'conn-1', nodeEpoch: 'epoch-1', serverTimeOffset: 60_001 })
    runCommand(h.link, h.adapter, h.follower, command({ key: 'skewed' }), 'mac', journal)
    await flush()
    expect(h.calls()).toBe(0)
    expect(h.acks()[0]).toMatchObject({ status: 'rejected', code: 'clock-skew' })
    expect(journal.size).toBe(0)
  })

  it('journal 写入失败时拒绝且零调用', async () => {
    const { journal } = setup()
    const h = harness()
    journal.admit = () => { throw new JournalError('recovery-required', 'disk full') }
    runCommand(h.link, h.adapter, h.follower, command({ key: 'nowrite' }), 'mac', journal)
    await flush()
    expect(h.calls()).toBe(0)
    expect(h.acks()[0]).toMatchObject({ status: 'rejected', code: 'recovery-required' })
  })

  it('configure 没有验证回读时结算为 pending-confirmation', async () => {
    const { journal } = setup()
    const h = harness()
    runCommand(h.link, h.adapter, h.follower, command({
      key: 'configure', op: 'configure', args: { field: 'model', value: 'm' },
    }), 'mac', journal)
    await flush()
    expect(h.acks()[0]).toMatchObject({ status: 'pending-confirmation' })
    expect(journal.lookup({ operatorId: 'operator-1', target: target(), idempotencyKey: 'configure' })?.status)
      .toBe('pending-confirmation')
  })
})
