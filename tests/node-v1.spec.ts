import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Adapter } from '../src/adapters/types.ts'
import type { ConfigureRequest, ConfigureResult, SettingsPort } from '../src/agents/types.ts'
import type { HandshakeBinding, NodeLink } from '../src/node/link.ts'
import { openJournal, type Journal } from '../src/node/journal.ts'
import { createPrivacyProjector, type PrivacyProjector } from '../src/node/privacy.ts'
import {
  createFollower, formatExpectedRevision, parseExpectedRevision, runCommand, runRoutedCommand,
  type AgentRoute, type CommandRuntime,
} from '../src/node/runner.ts'
import type {
  AckFrame, CommandFrame, CommandStatusFrame, CommandStatusResultFrame, Frame, InputsSnapshotFrame,
} from '../src/wire/frames.ts'

const dirs: string[] = []
const journals: Journal[] = []
let idCounter = 0

function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

function setup(): { journal: Journal; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-node-v1-'))
  dirs.push(dir)
  const journal = openJournal({
    file: join(dir, 'journal.json'),
    keyFile: join(dir, 'journal.key'),
    initFile: join(dir, 'journal.init'),
  })
  journals.push(journal)
  return { journal, dir }
}

function target(agent: string, sessionId: string | null = 's1') {
  return { deviceId: 'mac', agent, sessionId }
}

interface LinkHarness {
  readonly link: NodeLink
  readonly sent: Frame[]
  acks(): AckFrame[]
  statusResults(): CommandStatusResultFrame[]
  bind(next: HandshakeBinding | undefined): void
}

function linkHarness(): LinkHarness {
  let binding: HandshakeBinding | undefined = {
    connectionId: 'conn-1', nodeEpoch: 'epoch-1', serverTimeOffset: 0,
  }
  const sent: Frame[] = []
  const link = {
    sendRaw(text: string) { sent.push(JSON.parse(text) as Frame) },
    get handshake(): HandshakeBinding | undefined { return binding },
  } as unknown as NodeLink
  return {
    link,
    sent,
    acks() { return sent.filter((frame): frame is AckFrame => frame.type === 'ack') },
    statusResults() {
      return sent.filter((frame): frame is CommandStatusResultFrame => frame.type === 'command.status.result')
    },
    bind(next) { binding = next },
  }
}

interface FakeAdapter {
  readonly adapter: Adapter
  calls(): number
}

/** 设置端口在 v0 Adapter 上没有声明；这里用结构对象挂上去，模拟真实 v1 适配器。 */
function fakeAdapter(
  agent: string,
  options: { settingsPort?: SettingsPort; runtimeEpoch?: string } = {},
): FakeAdapter {
  let calls = 0
  const adapter = {
    agent,
    ...(options.runtimeEpoch === undefined ? {} : { runtimeEpoch: options.runtimeEpoch }),
    ...(options.settingsPort === undefined ? {} : { settingsPort: options.settingsPort }),
    async execute() {
      calls += 1
      return { accepted: true }
    },
    // 测试不做 follow 订阅；保持空循环以满足跟随端口结构。
    async *follow() { /* no events */ },
  }
  return { adapter: adapter as unknown as Adapter, calls: () => calls }
}

function followerFor(adapter: Adapter): ReturnType<typeof createFollower> {
  return createFollower({ adapter, send: () => {}, logger: { warn() {} } })
}

function routesOf(entries: readonly { agent: string; adapter: Adapter }[]): ReadonlyMap<string, AgentRoute> {
  return new Map(entries.map(entry => [
    entry.agent,
    { adapter: entry.adapter, follower: followerFor(entry.adapter) },
  ]))
}

function fakeSettingsPort(result: ConfigureResult): { port: SettingsPort; requests: ConfigureRequest[] } {
  const requests: ConfigureRequest[] = []
  const port: SettingsPort = {
    async readSettings() { throw new Error('readSettings unused in these tests') },
    async configure(request) {
      requests.push(request)
      return result
    },
  }
  return { port, requests }
}

function command(options: {
  key: string
  agent?: string
  op?: CommandFrame['op']
  args?: unknown
  id?: string
  sessionId?: string
  deadline?: number
}): CommandFrame {
  return {
    v: 2, type: 'command',
    commandId: options.id ?? nextId('c'),
    idempotencyKey: options.key,
    operatorId: 'operator-1',
    target: target(options.agent ?? 'dsh', options.sessionId ?? 's1'),
    op: options.op ?? 'prompt',
    args: options.args ?? { text: 'hi' },
    issuedAt: 0,
    deadline: options.deadline ?? Date.now() + 10_000,
    connectionId: 'conn-1',
    nodeEpoch: 'epoch-1',
  }
}

function statusQuery(key: string, agent = 'dsh'): CommandStatusFrame {
  return {
    v: 2, type: 'command.status',
    requestId: nextId('r'),
    operatorId: 'operator-1',
    target: target(agent),
    idempotencyKey: key,
    connectionId: 'conn-1',
    nodeEpoch: 'epoch-1',
  }
}

function configureCommand(options: {
  agent?: string
  key: string
  expectedRevision: string
  field?: string
  value?: unknown
}): CommandFrame {
  return command({
    key: options.key,
    agent: options.agent ?? 'codex',
    op: 'configure',
    args: {
      expectedRevision: options.expectedRevision,
      field: options.field ?? 'model',
      value: options.value ?? 'gpt-5',
    },
  })
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('expected revision', () => {
  it('只按最后一个 # 切分，并拒绝缺 epoch/非整数版本', () => {
    expect(formatExpectedRevision('node:codex:a#b', 7)).toBe('node:codex:a#b#7')
    expect(parseExpectedRevision('node:codex:a#b#7')).toEqual({ runtimeEpoch: 'node:codex:a#b', revision: 7 })
    expect(parseExpectedRevision('epoch#0')).toEqual({ runtimeEpoch: 'epoch', revision: 0 })
    for (const value of ['', 'no-separator', '#5', 'epoch#', 'epoch#-1', 'epoch#1.5', 'epoch#abc']) {
      expect(parseExpectedRevision(value)).toBeUndefined()
    }
  })
})

describe('routed command dispatch', () => {
  it('只调用目标 agent；未知 agent 不落 journal、不发命令给适配器', async () => {
    const { journal } = setup()
    const link = linkHarness()
    const dsh = fakeAdapter('dsh')
    const codex = fakeAdapter('codex')
    const routes = routesOf([
      { agent: 'dsh', adapter: dsh.adapter },
      { agent: 'codex', adapter: codex.adapter },
    ])

    runRoutedCommand(link.link, routes, command({ key: 'codex-prompt', agent: 'codex' }), 'mac', journal)
    await flush()
    expect(codex.calls()).toBe(1)
    expect(dsh.calls()).toBe(0)
    expect(link.acks().at(-1)).toMatchObject({ status: 'accepted' })

    runRoutedCommand(link.link, routes, command({ key: 'ghost-prompt', agent: 'claude' }), 'mac', journal)
    await flush()
    expect(dsh.calls()).toBe(0)
    expect(codex.calls()).toBe(1)
    expect(link.acks().at(-1)).toMatchObject({ status: 'rejected', code: 'session-unknown' })
    expect(journal.lookup({
      operatorId: 'operator-1', target: target('claude'), idempotencyKey: 'ghost-prompt',
    })).toBeUndefined()
    expect(journal.size).toBe(1)

    // 未知 agent 的状态查询同样拒绝，且不触碰任何适配器。
    runRoutedCommand(link.link, routes, statusQuery('ghost-prompt', 'claude'), 'mac', journal)
    expect(link.statusResults().at(-1)).toMatchObject({ status: 'rejected', code: 'session-unknown' })
  })

  it('未知 agent 的 inputs.snapshot 静默丢弃，不回任何帧', async () => {
    const { journal } = setup()
    const link = linkHarness()
    const dsh = fakeAdapter('dsh')
    const routes = routesOf([{ agent: 'dsh', adapter: dsh.adapter }])
    const snapshot: InputsSnapshotFrame = {
      v: 2, type: 'inputs.snapshot', requestId: 'snap-1',
      target: { deviceId: 'mac', agent: 'claude', sessionId: 's1' },
      connectionId: 'conn-1', nodeEpoch: 'epoch-1',
    }
    runRoutedCommand(link.link, routes, snapshot, 'mac', journal)
    await flush()
    expect(link.sent).toHaveLength(0)
  })
})

describe('configure through the settings port', () => {
  it('没有 settingsPort 时 rejected/unsupported 且零执行', async () => {
    const { journal } = setup()
    const link = linkHarness()
    const dsh = fakeAdapter('dsh')
    runCommand(
      link.link, dsh.adapter, followerFor(dsh.adapter),
      configureCommand({ agent: 'dsh', key: 'no-port', expectedRevision: formatExpectedRevision('epoch-1', 3) }),
      'mac', journal,
    )
    await flush()
    expect(dsh.calls()).toBe(0)
    expect(link.acks()[0]).toMatchObject({ status: 'rejected', code: 'unsupported' })
  })

  it('epoch 不符时 stale-connection，非法 expectedRevision 时 invalid-args', async () => {
    const { journal } = setup()
    const link = linkHarness()
    const settings = fakeSettingsPort({
      status: 'confirmed', revision: 5, runtimeEpoch: 'codex-epoch',
    })
    const codex = fakeAdapter('codex', { settingsPort: settings.port, runtimeEpoch: 'codex-epoch' })
    const follower = followerFor(codex.adapter)

    runCommand(
      link.link, codex.adapter, follower,
      configureCommand({ key: 'stale', expectedRevision: formatExpectedRevision('other-epoch', 4) }),
      'mac', journal,
    )
    await flush()
    expect(link.acks().at(-1)).toMatchObject({ status: 'rejected', code: 'stale-connection' })

    runCommand(
      link.link, codex.adapter, follower,
      configureCommand({ key: 'malformed', expectedRevision: 'not-a-revision' }),
      'mac', journal,
    )
    await flush()
    expect(link.acks().at(-1)).toMatchObject({ status: 'rejected', code: 'invalid-args' })
    expect(settings.requests).toHaveLength(0)
    expect(codex.calls()).toBe(0)
  })

  it('回读 confirmed 时 ACK confirmed 并透出 revision 与 code', async () => {
    const { journal } = setup()
    const link = linkHarness()
    const settings = fakeSettingsPort({
      status: 'confirmed', revision: 5, runtimeEpoch: 'codex-epoch', code: 'readback-mismatch',
    })
    const codex = fakeAdapter('codex', { settingsPort: settings.port, runtimeEpoch: 'codex-epoch' })
    runCommand(
      link.link, codex.adapter, followerFor(codex.adapter),
      configureCommand({ key: 'confirmed', expectedRevision: formatExpectedRevision('codex-epoch', 4) }),
      'mac', journal,
    )
    await flush()
    expect(link.acks().at(-1)).toMatchObject({
      status: 'confirmed',
      code: 'readback-mismatch',
      result: { status: 'confirmed', revision: 5 },
    })
    expect(settings.requests[0]).toMatchObject({
      sessionId: 's1',
      field: 'model',
      value: 'gpt-5',
      expectedRevision: 4,
      runtimeEpoch: 'codex-epoch',
    })
    expect(codex.calls()).toBe(0)
  })

  it('回读未确认时 ACK pending-confirmation 并保留 readback-timeout', async () => {
    const { journal } = setup()
    const link = linkHarness()
    const settings = fakeSettingsPort({
      status: 'pending-confirmation', revision: 4, runtimeEpoch: 'codex-epoch', code: 'readback-timeout',
    })
    const codex = fakeAdapter('codex', { settingsPort: settings.port, runtimeEpoch: 'codex-epoch' })
    runCommand(
      link.link, codex.adapter, followerFor(codex.adapter),
      configureCommand({ key: 'pending', expectedRevision: formatExpectedRevision('codex-epoch', 4) }),
      'mac', journal,
    )
    await flush()
    expect(link.acks().at(-1)).toMatchObject({
      status: 'pending-confirmation',
      code: 'readback-timeout',
    })
    expect(journal.lookup({
      operatorId: 'operator-1', target: target('codex'), idempotencyKey: 'pending',
    })?.status).toBe('pending-confirmation')
  })

  it('contentAuthorized 只由本地投影器的 privacy=content 且 allowContent=true 决定', async () => {
    const { journal } = setup()
    const link = linkHarness()
    const content = fakeSettingsPort({
      status: 'confirmed', revision: 1, runtimeEpoch: 'codex-epoch',
    })
    const contentAdapter = fakeAdapter('codex', { settingsPort: content.port, runtimeEpoch: 'codex-epoch' })
    const contentProjector: PrivacyProjector = createPrivacyProjector({
      privacy: 'content', allowContent: true, questionRelay: 'off', approvalRelay: 'off',
      allowInteractions: false, redaction: [], deviceId: 'mac', agent: 'codex',
    })
    const contentRuntime: CommandRuntime = { projector: () => contentProjector }
    runCommand(
      link.link, contentAdapter.adapter, followerFor(contentAdapter.adapter),
      configureCommand({ key: 'content', expectedRevision: formatExpectedRevision('codex-epoch', 0) }),
      'mac', journal, Date.now, contentRuntime,
    )
    await flush()
    expect(content.requests[0]?.contentAuthorized).toBe(true)

    const meta = fakeSettingsPort({ status: 'confirmed', revision: 1, runtimeEpoch: 'codex-epoch' })
    const metaAdapter = fakeAdapter('codex', { settingsPort: meta.port, runtimeEpoch: 'codex-epoch' })
    const metadataProjector: PrivacyProjector = createPrivacyProjector({
      privacy: 'metadata', allowContent: true, questionRelay: 'off', approvalRelay: 'off',
      allowInteractions: false, redaction: [], deviceId: 'mac', agent: 'codex',
    })
    const metadataRuntime: CommandRuntime = { projector: () => metadataProjector }
    runCommand(
      link.link, metaAdapter.adapter, followerFor(metaAdapter.adapter),
      configureCommand({ key: 'metadata', expectedRevision: formatExpectedRevision('codex-epoch', 0) }),
      'mac', journal, Date.now, metadataRuntime,
    )
    await flush()
    expect(meta.requests[0]?.contentAuthorized).toBe(false)
  })
})


describe('history transport privacy and isolation', () => {
  it('denies metadata history, redacts content, filters unrelated targets, and does not journal reads', async () => {
    const { journal } = setup()
    const link = linkHarness(), base = fakeAdapter('codex')
    let reads = 0
    const adapter: Adapter = { ...base.adapter, async history() {
      reads++
      const event = { v: 2 as const, type: 'event' as const, deviceId: 'mac', agent: 'codex', sessionId: 's1', nodeEpoch: 'epoch-1', seq: 1, ts: 1, kind: 'user.message' as const, payload: { itemId: 'u', text: 'password=secret hello' } }
      return { items: [event, { ...event, sessionId: 'other' }, { ...event, kind: 'input.requested' as const }], completeness: 'complete' }
    } }
    const frame = command({ agent: 'codex', key: 'history-read', op: 'observe', args: { kind: 'history', limit: 20 } })
    runCommand(link.link, adapter, followerFor(adapter), frame, 'mac', journal)
    await flush()
    expect(reads).toBe(0)
    expect(link.acks().at(-1)).toMatchObject({ status: 'rejected', code: 'unsupported' })
    const projector = createPrivacyProjector({ privacy: 'content', allowContent: true, questionRelay: 'off', approvalRelay: 'off', allowInteractions: false, redaction: [], deviceId: 'mac', agent: 'codex' })
    runCommand(link.link, adapter, followerFor(adapter), frame, 'mac', journal, Date.now, { projector: () => projector })
    await flush()
    const page = link.sent.find(item => item.type === 'history.result')
    expect(page).toMatchObject({ type: 'history.result', items: [{ sessionId: 's1', kind: 'user.message' }] })
    expect(page?.type === 'history.result' && page.items.length).toBe(1)
    expect(JSON.stringify(page)).not.toContain('secret')
    expect(base.calls()).toBe(0)
    expect(journal.lookup({ operatorId: 'operator-1', target: frame.target, idempotencyKey: frame.idempotencyKey })).toBeUndefined()
  })

  it('drops the body if content authorization changes while a read is pending', async () => {
    const { journal } = setup(), link = linkHarness(), base = fakeAdapter('codex')
    let finish!: (value: { items: []; completeness: 'complete' }) => void
    const adapter: Adapter = { ...base.adapter, history: () => new Promise(resolve => { finish = resolve }) }
    let content = true
    const runtime: CommandRuntime = { projector: () => createPrivacyProjector({ privacy: 'content', allowContent: content, questionRelay: 'off', approvalRelay: 'off', allowInteractions: false, redaction: [], deviceId: 'mac', agent: 'codex' }) }
    runCommand(link.link, adapter, followerFor(adapter), command({ agent: 'codex', key: 'revoked', op: 'observe', args: { kind: 'history', limit: 20 } }), 'mac', journal, Date.now, runtime)
    content = false; finish({ items: [], completeness: 'complete' }); await flush()
    expect(link.sent.some(item => item.type === 'history.result')).toBe(false)
    expect(link.acks().at(-1)).toMatchObject({ status: 'rejected' })
  })
})
