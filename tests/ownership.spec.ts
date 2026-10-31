import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PreCallRejection, type Adapter } from '../src/adapters/types.ts'
import {
  createOwnershipCoordinator, OwnershipError, toWireOwnership,
  type OwnershipCoordinator,
} from '../src/agents/ownership.ts'
import type {
  CreateSessionRequest, CreatedSession, ForkSessionRequest, OwnershipEvidence,
} from '../src/agents/types.ts'
import type { HandshakeBinding, NodeLink } from '../src/node/link.ts'
import { openJournal, type Journal } from '../src/node/journal.ts'
import { createFollower, runCommand } from '../src/node/runner.ts'
import type {
  AckFrame, CommandFrame, CommandStatusFrame, CommandStatusResultFrame, Frame,
} from '../src/wire/frames.ts'

const dirs: string[] = []
const journals: Journal[] = []

function setupJournal(): Journal {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-ownership-'))
  dirs.push(dir)
  const journal = openJournal({
    file: join(dir, 'journal.json'),
    keyFile: join(dir, 'journal.key'),
    initFile: join(dir, 'journal.init'),
  })
  journals.push(journal)
  return journal
}

function evidence(
  sessionId = 's1',
  overrides: {
    mechanism?: string
    holder?: string
    runtimeEpoch?: string
    acquiredAt?: number
    expiresAt?: number
    invalidatesOn?: readonly string[]
  } = {},
): OwnershipEvidence {
  return {
    sessionId,
    mechanism: overrides.mechanism ?? 'native-lock',
    holder: overrides.holder ?? 'holder-1',
    runtimeEpoch: overrides.runtimeEpoch ?? 'epoch-1',
    acquiredAt: overrides.acquiredAt ?? 100,
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
    invalidatesOn: overrides.invalidatesOn ?? ['process-exit'],
  }
}

function coordinator(now: () => number = () => 100): OwnershipCoordinator {
  return createOwnershipCoordinator({ runtimeEpoch: 'epoch-1', holder: 'holder-1', now })
}

async function ownedSession(target: OwnershipCoordinator, sessionId = 's1'): Promise<void> {
  await target.acquire(sessionId, async () => evidence(sessionId))
}

/** 捕获同步抛出的错误，便于断言内部/线上分类而不是只判类型。 */
function caught(fn: () => void): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let settle!: (value: T) => void
  const promise = new Promise<T>(resolve => { settle = resolve })
  return { promise, resolve: settle }
}

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ownership state table', () => {
  it('defaults to foreign-unknown and never invents foreign-idle', () => {
    const target = coordinator()
    expect(target.state('s1')).toBe('foreign-unknown')
    expect(target.ownership('s1')).toBe('foreign-unknown')
    expect(target.controlReason('s1')).toBe('ownership-unverified')
    expect(target.evidence('s1')).toBeUndefined()
  })

  it('records observations separately without overwriting ownership', async () => {
    const target = coordinator()
    target.noteObserved('s1', true)
    expect(target.state('s1')).toBe('foreign-running')
    expect(target.ownership('s1')).toBe('foreign-running')
    expect(target.controlReason('s1')).toBe('writer-busy')

    target.noteObserved('s1', false)
    expect(target.state('s1')).toBe('foreign-unknown')

    await ownedSession(target)
    target.noteObserved('s1', true)
    expect(target.state('s1')).toBe('ours-idle')
    target.release('s1')
    // release 只撤销 ownership，最新的外部观察仍然是事实。
    expect(target.state('s1')).toBe('foreign-running')
  })

  it('maps internal states to stable wire values and reasons', () => {
    expect(toWireOwnership('foreign-unknown')).toBe('foreign-unknown')
    expect(toWireOwnership('foreign-running')).toBe('foreign-running')
    expect(toWireOwnership('acquiring')).toBe('unverified')
    expect(toWireOwnership('ours-idle')).toBe('ours')
    expect(toWireOwnership('ours-running')).toBe('ours')
  })
})

describe('ownership acquire', () => {
  it('sets acquiring before awaiting and rejects a second acquire immediately', async () => {
    const target = coordinator()
    let release!: (value: OwnershipEvidence | undefined) => void
    let calls = 0
    let seenEpoch: string | undefined
    const pending = target.acquire('s1', async context => {
      calls += 1
      seenEpoch = context.runtimeEpoch
      return await new Promise<OwnershipEvidence | undefined>(resolve => { release = resolve })
    })

    expect(target.state('s1')).toBe('acquiring')
    expect(target.ownership('s1')).toBe('unverified')
    expect(target.controlReason('s1')).toBe('writer-busy')

    const second = target.acquire('s1', async () => {
      calls += 1
      return evidence('s1')
    })
    await expect(second).rejects.toMatchObject({
      name: 'OwnershipError', code: 'writer-busy', ownershipCode: 'writer-busy',
    })

    // 取得中的观察不能把状态改回 foreign-*。
    target.noteObserved('s1', true)
    expect(target.state('s1')).toBe('acquiring')

    release(evidence('s1'))
    const snapshot = await pending
    expect(snapshot).toMatchObject({ sessionId: 's1', state: 'ours-idle', wire: 'ours' })
    expect(snapshot.evidence?.mechanism).toBe('native-lock')
    expect(seenEpoch).toBe('epoch-1')
    expect(calls).toBe(1)
    expect(target.state('s1')).toBe('ours-idle')
  })

  it('keeps the session read-only when acquire resolves without exclusivity evidence', async () => {
    const target = coordinator()
    await expect(target.acquire('s1', async () => undefined)).rejects.toMatchObject({
      name: 'OwnershipError', code: 'ownership-unverified',
    })
    expect(target.state('s1')).toBe('foreign-unknown')
    expect(target.evidence('s1')).toBeUndefined()
  })

  it('rejects malformed evidence and reverts to foreign-unknown', async () => {
    const target = coordinator()
    const cases: Array<[string, (sessionId: string) => OwnershipEvidence]> = [
      ['wrong-session', () => evidence('other')],
      ['wrong-epoch', sessionId => evidence(sessionId, { runtimeEpoch: 'epoch-2' })],
      ['empty-mechanism', sessionId => evidence(sessionId, { mechanism: '' })],
      ['empty-holder', sessionId => evidence(sessionId, { holder: '' })],
      ['expired', sessionId => evidence(sessionId, { expiresAt: 50 })],
      ['empty-invalidates', sessionId => evidence(sessionId, { invalidatesOn: [] })],
      ['blank-invalidates-entry', sessionId => evidence(sessionId, { invalidatesOn: ['process-exit', ''] })],
    ]
    for (const [label, make] of cases) {
      const sessionId = `case-${label}`
      await expect(
        target.acquire(sessionId, async () => make(sessionId)),
        label,
      ).rejects.toMatchObject({ code: 'ownership-unverified' })
      expect(target.state(sessionId)).toBe('foreign-unknown')
    }
  })

  it('converts arbitrary upstream errors but preserves PreCallRejection codes', async () => {
    const target = coordinator()
    await expect(target.acquire('s1', async () => { throw new Error('boom') }))
      .rejects.toMatchObject({ name: 'OwnershipError', code: 'ownership-unverified' })
    expect(target.state('s1')).toBe('foreign-unknown')

    await expect(target.acquire('s1', async () => { throw new PreCallRejection('session-unknown') }))
      .rejects.toMatchObject({ code: 'session-unknown' })
    expect(target.state('s1')).toBe('foreign-unknown')
  })

  it('rejects with the abort reason and reverts when aborted during acquire', async () => {
    const target = coordinator()
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const pending = target.acquire('s1', async context => await new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
    }), { signal: controller.signal })

    expect(target.state('s1')).toBe('acquiring')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(target.state('s1')).toBe('foreign-unknown')
  })

  it('clear/release/revoke cancels an in-flight acquire', async () => {
    const cases: Array<{
      readonly label: string
      readonly cancel: (target: OwnershipCoordinator) => void
    }> = [
      { label: 'clear', cancel: target => { target.clear() } },
      { label: 'release', cancel: target => { target.release('s1') } },
    ]

    for (const { label, cancel } of cases) {
      const target = coordinator()
      const upstream = deferred<OwnershipEvidence | undefined>()
      let seenSessionId: string | undefined
      const pending = target.acquire('s1', async context => {
        seenSessionId = context.sessionId
        return await upstream.promise
      })
      expect(target.state('s1'), label).toBe('acquiring')

      cancel(target)
      expect(target.state('s1'), label).toBe('foreign-unknown')

      // 上游照常成功返回，但这次取得已被取消，证据不能落地。
      upstream.resolve(evidence('s1'))
      await expect(pending, label).rejects.toMatchObject({
        name: 'OwnershipError',
        ownershipCode: 'stale-runtime',
        code: 'stale-connection',
      })
      expect(seenSessionId, label).toBe('s1')
      expect(target.state('s1'), label).toBe('foreign-unknown')
      expect(target.ownership('s1'), label).toBe('foreign-unknown')
      expect(target.evidence('s1'), label).toBeUndefined()
    }
  })
})

describe('ownership turns and configure', () => {
  it('rejects prompt from foreign states and enforces idle/busy transitions', async () => {
    const target = coordinator()
    expect(() => target.beginPrompt('s1')).toThrow(OwnershipError)

    await ownedSession(target)
    target.beginPrompt('s1')
    // 接受即 busy：原生 turnId 回来之前不能再接受第二次写入。
    expect(target.state('s1')).toBe('ours-running')
    expect(target.turn('s1')).toBeUndefined()
    expect(caught(() => target.beginPrompt('s1'))).toMatchObject({ code: 'writer-busy' })
    // 未绑定时控制动作一律 unbound，即使 id 看起来匹配。
    expect(caught(() => target.authorizeControl('s1', 'turn-1'))).toMatchObject({
      ownershipCode: 'turn-unbound', code: 'stale-connection',
    })

    target.bindTurn('s1', 'turn-1')
    expect(target.state('s1')).toBe('ours-running')
    expect(target.turn('s1')).toBe('turn-1')
    expect(() => target.beginPrompt('s1')).toThrow(OwnershipError)
    expect(() => target.beginConfigure('s1')).toThrow(OwnershipError)

    target.authorizeControl('s1', 'turn-1')
    expect(() => target.authorizeControl('s1', 'turn-2')).toThrow(OwnershipError)
    expect(() => target.authorizeControl('s1', '')).toThrow(OwnershipError)

    expect(target.endTurn('s1', 'old-turn')).toBe(false)
    expect(target.turn('s1')).toBe('turn-1')
    expect(target.endTurn('s1', 'turn-1')).toBe(true)
    expect(target.state('s1')).toBe('ours-idle')
    expect(target.endTurn('s1', 'turn-1')).toBe(false)
  })

  it('authorizeControl works while a long turn is still pending', async () => {
    const target = coordinator()
    await ownedSession(target)
    target.beginPrompt('s1')
    expect(target.state('s1')).toBe('ours-running')
    target.bindTurn('s1', 'turn-1')

    let finish!: () => void
    const longTurn = new Promise<void>(resolve => { finish = resolve })
    const running = longTurn.then(() => 'done')
    expect(target.state('s1')).toBe('ours-running')
    expect(() => target.authorizeControl('s1', 'turn-1')).not.toThrow()
    finish()
    await expect(running).resolves.toBe('done')
  })

  it('does not let a late turn bind or end clear a newer binding', async () => {
    const target = coordinator()
    await ownedSession(target)
    target.beginPrompt('s1')
    target.bindTurn('s1', 'newer')
    expect(() => target.bindTurn('s1', 'older')).toThrow(OwnershipError)
    expect(target.turn('s1')).toBe('newer')
  })

  it('rejects a second configure and a prompt while configuring', async () => {
    const target = coordinator()
    await ownedSession(target)
    target.beginConfigure('s1')
    expect(target.state('s1')).toBe('ours-idle')
    expect(() => target.beginConfigure('s1')).toThrow(OwnershipError)
    expect(() => target.beginPrompt('s1')).toThrow(OwnershipError)

    target.endConfigure('s1')
    target.endConfigure('s1')
    target.beginPrompt('s1')
    expect(target.state('s1')).toBe('ours-running')
  })

  it('a prompt before bind is already busy and unbound', async () => {
    const target = coordinator()
    await ownedSession(target)
    target.beginPrompt('s1')
    expect(target.state('s1')).toBe('ours-running')
    expect(target.turn('s1')).toBeUndefined()

    expect(caught(() => target.beginPrompt('s1'))).toMatchObject({
      name: 'OwnershipError', code: 'writer-busy',
    })
    expect(caught(() => target.beginConfigure('s1'))).toMatchObject({
      name: 'OwnershipError', code: 'writer-busy',
    })
    expect(caught(() => target.authorizeControl('s1', 'turn-1'))).toMatchObject({
      name: 'OwnershipError', ownershipCode: 'turn-unbound', code: 'stale-connection',
    })

    // 未绑定时的完成事件没有 id 可对，按无参结束处理。
    expect(target.endTurn('s1')).toBe(true)
    expect(target.state('s1')).toBe('ours-idle')
    expect(target.endTurn('s1')).toBe(false)
  })

  it('late completion cannot clear an active newer turn', async () => {
    const target = coordinator()
    await ownedSession(target)
    target.beginPrompt('s1')
    target.bindTurn('s1', 'newer')

    expect(target.endTurn('s1', 'older')).toBe(false)
    expect(target.turn('s1')).toBe('newer')
    expect(target.state('s1')).toBe('ours-running')

    expect(target.endTurn('s1', 'newer')).toBe(true)
    expect(target.state('s1')).toBe('ours-idle')
    expect(target.turn('s1')).toBeUndefined()
  })

  it('requires ownership before binding or authorizing control', () => {
    const target = coordinator()
    expect(() => target.bindTurn('s1', 'turn-1')).toThrow(OwnershipError)
    expect(() => target.authorizeControl('s1', 'turn-1')).toThrow(OwnershipError)

    target.noteObserved('s1', true)
    let thrown: unknown
    try {
      target.authorizeControl('s1', 'turn-1')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'writer-busy' })
  })
})

describe('ownership lease and cleanup', () => {
  it('revokes expired evidence on every read and guard', async () => {
    let now = 1_000
    const target = coordinator(() => now)
    await target.acquire('s1', async () => evidence('s1', { expiresAt: 1_500 }))
    expect(target.state('s1')).toBe('ours-idle')

    now = 1_500
    expect(target.state('s1')).toBe('foreign-unknown')
    expect(target.ownership('s1')).toBe('foreign-unknown')
    expect(target.evidence('s1')).toBeUndefined()
    expect(target.controlReason('s1')).toBe('ownership-unverified')
    expect(() => target.beginPrompt('s1')).toThrow(OwnershipError)
  })

  it('release falls back to observation, revoke keeps it, clear drops everything', async () => {
    const target = coordinator()
    target.noteObserved('s1', true)
    await target.acquire('s1', async () => evidence('s1'))
    target.noteObserved('s2', true)
    await target.acquire('s2', async () => evidence('s2'))
    target.noteObserved('s2', true)

    target.release('s1')
    target.release('s1')
    expect(target.state('s1')).toBe('foreign-running')

    target.revoke('s2')
    expect(target.state('s2')).toBe('foreign-running')
    expect(target.evidence('s2')).toBeUndefined()

    target.clear()
    expect(target.state('s1')).toBe('foreign-unknown')
    expect(target.state('s2')).toBe('foreign-unknown')
    expect(target.evidence('s1')).toBeUndefined()
  })
})

function target(sessionId: string | null) {
  return { deviceId: 'mac', agent: 'dsh', sessionId }
}

function command(options: {
  key: string
  op: CommandFrame['op']
  sessionId: string | null
  args?: unknown
  id?: string
  deadline?: number
}): CommandFrame {
  return {
    v: 2, type: 'command',
    commandId: options.id ?? `c-${Math.random().toString(36).slice(2)}`,
    idempotencyKey: options.key,
    operatorId: 'operator-1',
    target: target(options.sessionId),
    op: options.op,
    args: options.args ?? {},
    issuedAt: 0,
    deadline: options.deadline ?? Date.now() + 10_000,
    connectionId: 'conn-1',
    nodeEpoch: 'epoch-1',
  }
}

function statusQuery(key: string, sessionId: string | null): CommandStatusFrame {
  return {
    v: 2, type: 'command.status',
    requestId: `r-${Math.random().toString(36).slice(2)}`,
    operatorId: 'operator-1',
    target: target(sessionId),
    idempotencyKey: key,
    connectionId: 'conn-1',
    nodeEpoch: 'epoch-1',
  }
}

interface HarnessAdapter {
  agent: string
  execute(command: { op: string; target: { sessionId: string }; args?: unknown }): Promise<unknown>
  createSession?(request: CreateSessionRequest, signal: AbortSignal): Promise<CreatedSession>
  forkSession?(request: ForkSessionRequest, signal: AbortSignal): Promise<CreatedSession>
}

function harness(options: {
  createSession?: (request: CreateSessionRequest, signal: AbortSignal) => Promise<CreatedSession>
  forkSession?: (request: ForkSessionRequest, signal: AbortSignal) => Promise<CreatedSession>
  execute?: (command: { op: string; target: { sessionId: string }; args?: unknown }) => Promise<unknown>
} = {}) {
  const createCalls: CreateSessionRequest[] = []
  const forkCalls: ForkSessionRequest[] = []
  const executeCalls: string[] = []
  const binding: HandshakeBinding = {
    connectionId: 'conn-1', nodeEpoch: 'epoch-1', serverTimeOffset: 0,
  }
  const sent: Frame[] = []

  const adapter: HarnessAdapter = {
    agent: 'dsh',
    async execute(input) {
      executeCalls.push(input.op)
      if (options.execute !== undefined) return await options.execute(input)
      return { accepted: true }
    },
  }
  const createImpl = options.createSession
  if (createImpl !== undefined) {
    adapter.createSession = async (request, signal) => {
      createCalls.push(request)
      return await createImpl(request, signal)
    }
  }
  const forkImpl = options.forkSession
  if (forkImpl !== undefined) {
    adapter.forkSession = async (request, signal) => {
      forkCalls.push(request)
      return await forkImpl(request, signal)
    }
  }

  const v0: Adapter = adapter as unknown as Adapter
  const link = {
    sendRaw(text: string) { sent.push(JSON.parse(text) as Frame) },
    get handshake(): HandshakeBinding | undefined { return binding },
  } as unknown as NodeLink
  const follower = createFollower({ adapter: v0, send: () => {}, logger: { warn() {} } })

  return {
    adapter: v0,
    follower,
    link,
    sent,
    createCalls,
    forkCalls,
    executeCalls,
    acks(): AckFrame[] { return sent.filter((frame): frame is AckFrame => frame.type === 'ack') },
    statusResults(): CommandStatusResultFrame[] {
      return sent.filter((frame): frame is CommandStatusResultFrame => frame.type === 'command.status.result')
    },
  }
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('runner create/fork/acquire', () => {
  it('create uses sessionId null, persists only the new ID, and replays it after ACK loss', async () => {
    const journal = setupJournal()
    const h = harness({
      createSession: async () => ({ sessionId: 'new-1', runtimeEpoch: 'epoch-9' }),
    })
    runCommand(h.link, h.adapter, h.follower, command({
      key: 'create-1', op: 'create', sessionId: null, args: { cwd: '/workspace' }, id: 'c1',
    }), 'mac', journal)
    await flush()

    expect(h.createCalls).toEqual([{ requestId: 'c1', cwd: '/workspace' }])
    expect(h.acks()).toMatchObject([
      { commandId: 'c1', status: 'accepted', result: { sessionId: 'new-1' } },
    ])
    const domain = { operatorId: 'operator-1', target: target(null), idempotencyKey: 'create-1' }
    expect(journal.lookup(domain)).toMatchObject({
      status: 'accepted', result: { sessionId: 'new-1' },
    })
    // runtimeEpoch 属于本机，不能出现在已落盘的 journal 里。
    expect(JSON.stringify(journal.lookup(domain))).not.toContain('epoch-9')

    runCommand(h.link, h.adapter, h.follower, statusQuery('create-1', null), 'mac', journal)
    expect(h.statusResults()).toMatchObject([
      { status: 'accepted', result: { sessionId: 'new-1' } },
    ])

    runCommand(h.link, h.adapter, h.follower, command({
      key: 'create-1', op: 'create', sessionId: null, args: { cwd: '/workspace' }, id: 'c2',
    }), 'mac', journal)
    await flush()
    expect(h.createCalls).toHaveLength(1)
    expect(h.acks().at(-1)).toMatchObject({
      commandId: 'c2', status: 'accepted', result: { sessionId: 'new-1' },
    })
  })

  it('settles create as outcome-unknown when the adapter returns no session id', async () => {
    const journal = setupJournal()
    const h = harness({
      // 适配器违约返回：没有可用的新会话 ID。
      createSession: async () => undefined as unknown as CreatedSession,
    })
    runCommand(h.link, h.adapter, h.follower, command({
      key: 'create-no-id', op: 'create', sessionId: null, id: 'c1',
    }), 'mac', journal)
    await flush()

    expect(h.createCalls).toHaveLength(1)
    expect(h.acks()).toMatchObject([
      { commandId: 'c1', status: 'outcome-unknown', code: 'outcome-unknown' },
    ])
    const entry = journal.lookup({
      operatorId: 'operator-1', target: target(null), idempotencyKey: 'create-no-id',
    })
    expect(entry).toMatchObject({ status: 'outcome-unknown' })
    expect(entry).not.toHaveProperty('result')
  })

  it('rejects create with a concrete session and fork without one', async () => {
    const journal = setupJournal()
    const h = harness({
      createSession: async () => ({ sessionId: 'new-1', runtimeEpoch: 'epoch-9' }),
      forkSession: async request => ({
        sessionId: 'new-fork', runtimeEpoch: 'epoch-9', parentSessionId: request.parentSessionId,
      }),
    })

    runCommand(h.link, h.adapter, h.follower, command({
      key: 'bad-create', op: 'create', sessionId: 's1',
    }), 'mac', journal)
    runCommand(h.link, h.adapter, h.follower, command({
      key: 'bad-fork', op: 'fork', sessionId: null,
    }), 'mac', journal)
    await flush()

    expect(h.acks()).toMatchObject([
      { status: 'rejected', code: 'invalid-args' },
      { status: 'rejected', code: 'session-unknown' },
    ])
    expect(h.createCalls).toHaveLength(0)
    expect(h.forkCalls).toHaveLength(0)
    expect(journal.size).toBe(0)
  })

  it('fork passes the parent session and journals only the new ID', async () => {
    const journal = setupJournal()
    const h = harness({
      forkSession: async request => ({
        sessionId: 'new-fork', runtimeEpoch: 'epoch-9', parentSessionId: request.parentSessionId,
      }),
    })
    runCommand(h.link, h.adapter, h.follower, command({
      key: 'fork-1', op: 'fork', sessionId: 's1', id: 'c1',
    }), 'mac', journal)
    await flush()

    expect(h.forkCalls).toEqual([{ requestId: 'c1', parentSessionId: 's1' }])
    expect(h.acks()[0]).toMatchObject({
      status: 'accepted', result: { sessionId: 'new-fork' },
    })
    expect(journal.lookup({
      operatorId: 'operator-1', target: target('s1'), idempotencyKey: 'fork-1',
    })).toMatchObject({ status: 'accepted', result: { sessionId: 'new-fork' } })
  })

  it('rejects create/fork without a native port before admitting a journal entry', async () => {
    const journal = setupJournal()
    const h = harness()
    runCommand(h.link, h.adapter, h.follower, command({
      key: 'no-create', op: 'create', sessionId: null,
    }), 'mac', journal)
    runCommand(h.link, h.adapter, h.follower, command({
      key: 'no-fork', op: 'fork', sessionId: 's1',
    }), 'mac', journal)
    await flush()

    expect(h.acks()).toMatchObject([
      { status: 'rejected', code: 'unsupported', result: { reason: 'capability-unavailable' } },
      { status: 'rejected', code: 'unsupported', result: { reason: 'capability-unavailable' } },
    ])
    expect(journal.lookup({
      operatorId: 'operator-1', target: target(null), idempotencyKey: 'no-create',
    })).toBeUndefined()
    expect(journal.lookup({
      operatorId: 'operator-1', target: target('s1'), idempotencyKey: 'no-fork',
    })).toBeUndefined()
    expect(journal.size).toBe(0)
  })

  it('routes acquire through execute and settles a PreCallRejection as rejected', async () => {
    const journal = setupJournal()
    const h = harness({
      execute: async () => { throw new PreCallRejection('writer-busy') },
    })
    runCommand(h.link, h.adapter, h.follower, command({
      key: 'acquire-1', op: 'acquire', sessionId: 's1',
    }), 'mac', journal)
    await flush()

    expect(h.executeCalls).toEqual(['acquire'])
    expect(h.acks()[0]).toMatchObject({ status: 'rejected', code: 'writer-busy' })
    expect(journal.lookup({
      operatorId: 'operator-1', target: target('s1'), idempotencyKey: 'acquire-1',
    })?.status).toBe('rejected')
  })
})
