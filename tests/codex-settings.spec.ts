import { describe, expect, it } from 'vitest'
import type {
  ConfigureRequest, SettingsReadRequest,
} from '../src/agents/types.ts'
import type { CodexRequest } from '../src/agents/codex/discover.ts'
import { CodexPeerError } from '../src/agents/codex/peer.ts'
import {
  parseGoalClearedNotification, parseGoalGetResponse, parseGoalUpdatedNotification,
  parseThreadSettingsSnapshot, parseThreadSettingsUpdated,
} from '../src/agents/codex/protocol.ts'
import { createCodexSettingsPort } from '../src/agents/codex/settings.ts'

/** 注入式假定时器：不依赖 vitest fake timers，也不真实等待回读超时。 */
class FakeTimers {
  private nextId = 1
  private readonly active = new Map<number, () => void>()
  private readonly delays: number[] = []
  nowMs = 1_000

  readonly now = (): number => this.nowMs

  readonly schedule = (fn: () => void, ms: number): unknown => {
    const id = this.nextId
    this.nextId += 1
    this.active.set(id, fn)
    this.delays.push(ms)
    return id
  }

  readonly cancel = (handle: unknown): void => {
    this.active.delete(handle as number)
  }

  get lastDelay(): number | undefined {
    return this.delays.at(-1)
  }

  fire(): void {
    const callbacks = [...this.active.values()]
    this.active.clear()
    for (const callback of callbacks) callback()
  }
}

type Handler = (params: unknown) => unknown

class FakeCodex {
  readonly calls: Array<{ readonly method: string; readonly params: unknown }> = []
  private readonly handlers = new Map<string, Handler>()

  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler)
  }

  readonly request: CodexRequest = async (method, params, _signal, parse) => {
    this.calls.push({ method, params })
    const handler = this.handlers.get(method)
    if (handler === undefined) throw new Error(`unexpected method ${method}`)
    const parsed = parse(await handler(params))
    if (parsed === undefined) throw new Error(`unparseable ${method}`)
    return parsed
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function resume(overrides: Record<string, unknown> = {}): unknown {
  return {
    thread: { id: 's1' },
    model: 'gpt-5',
    modelProvider: 'openai',
    cwd: '/repo',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite', networkAccess: false, writableRoots: ['/repo/src'] },
    reasoningEffort: 'high',
    collaborationMode: { mode: 'plan', settings: {} },
    ...overrides,
  }
}

function setup(options: { readonly writable?: boolean; readonly idle?: boolean } = {}) {
  const timers = new FakeTimers()
  const fake = new FakeCodex()
  const began: string[] = []
  const ended: string[] = []
  fake.on('thread/goal/get', () => ({ goal: null }))
  const port = createCodexSettingsPort({
    request: fake.request,
    runtimeEpoch: 'epoch-1',
    writable: id => (options.writable ?? true) && id === 's1',
    idle: () => options.idle ?? true,
    beginConfigure: id => { began.push(id) },
    endConfigure: id => { ended.push(id) },
    now: timers.now,
    readbackTimeoutMs: 20,
    readbackOptions: { schedule: timers.schedule, cancel: timers.cancel },
  })
  return { timers, fake, port, began, ended }
}

const READ_REQUEST: SettingsReadRequest = { sessionId: 's1', runtimeEpoch: 'epoch-1', revision: 0 }

function configureRequest(overrides: Partial<ConfigureRequest> = {}): ConfigureRequest {
  return {
    sessionId: 's1',
    field: 'goal',
    value: { objective: 'do X' },
    expectedRevision: 0,
    runtimeEpoch: 'epoch-1',
    contentAuthorized: true,
    ...overrides,
  }
}

describe('Codex 设置快照解析', () => {
  it('workspaceWrite 映射权限，plan/default 映射 plan，null effort 省略', () => {
    expect(parseThreadSettingsSnapshot(resume())).toEqual({
      threadId: 's1',
      model: 'gpt-5',
      reasoning: 'high',
      permission: {
        approvalPolicy: 'on-request',
        sandbox: { fileSystem: 'workspace-write', network: false },
        additionalDirectories: ['/repo/src'],
      },
      plan: 'on',
    })
    expect(parseThreadSettingsSnapshot(resume({
      reasoningEffort: null,
      collaborationMode: { mode: 'default', settings: {} },
    }))).toMatchObject({ threadId: 's1', plan: 'off' })
    expect(parseThreadSettingsSnapshot(resume({ reasoningEffort: null }))?.reasoning).toBeUndefined()
  })

  it('externalSandbox 与 granular approvalPolicy 省略整个 permission', () => {
    const external = parseThreadSettingsSnapshot(resume({
      approvalPolicy: { granular: { sandboxApproval: true } },
      sandbox: { type: 'externalSandbox', networkAccess: true },
      collaborationMode: null,
    }))
    // 既没有外部 sandbox 的可比较范围，也没有可用的 approvalPolicy 字符串。
    expect(external).toEqual({ threadId: 's1', model: 'gpt-5', reasoning: 'high' })

    const granular = parseThreadSettingsSnapshot(resume({ approvalPolicy: { granular: {} } }))
    // granular approvalPolicy 即使 sandbox 可映射，也只能省略整个 permission。
    expect(granular?.permission).toBeUndefined()

    // 有 approvalPolicy 但 sandbox 缺失：同样省略整个 permission。
    expect(parseThreadSettingsSnapshot(resume({ sandbox: undefined }))?.permission).toBeUndefined()

    expect(parseThreadSettingsSnapshot(resume({ sandbox: { type: 'dangerFullAccess' } }))?.permission)
      .toEqual({ approvalPolicy: 'on-request', sandbox: { fileSystem: 'danger-full-access' } })

    expect(parseThreadSettingsSnapshot(resume({ sandbox: { type: 'readOnly', networkAccess: true } }))?.permission)
      .toEqual({ approvalPolicy: 'on-request', sandbox: { fileSystem: 'read-only', network: true } })
  })

  it('thread/settings/updated 用 threadSettings 归一化，未知会话不创建状态', () => {
    const updated = parseThreadSettingsUpdated({
      threadId: 's1',
      threadSettings: {
        model: 'gpt-6',
        effort: 'low',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: true },
        collaborationMode: { mode: 'default' },
      },
    })
    expect(updated).toEqual({
      threadId: 's1',
      snapshot: {
        threadId: 's1',
        model: 'gpt-6',
        reasoning: 'low',
        permission: { approvalPolicy: 'never', sandbox: { fileSystem: 'read-only', network: true } },
        plan: 'off',
      },
    })
    expect(parseThreadSettingsUpdated({ threadId: 's1' })).toBeUndefined()
  })

  it('goal get/通知只暴露 objective', () => {
    expect(parseGoalGetResponse({ goal: null })).toEqual({ goal: null })
    expect(parseGoalGetResponse({
      goal: { objective: 'secret', status: 'active', counts: { turns: 2 } },
    })).toEqual({ goal: { objective: 'secret' } })
    expect(parseGoalGetResponse({ goal: { status: 'active' } })).toBeUndefined()
    expect(parseGoalGetResponse({})).toBeUndefined()

    expect(parseGoalUpdatedNotification({ threadId: 's1', goal: { objective: 'x' } }))
      .toEqual({ threadId: 's1', objective: 'x' })
    expect(parseGoalClearedNotification({ threadId: 's1' })).toEqual({ threadId: 's1' })
  })
})

describe('CodexSettingsPort readSettings', () => {
  it('发布 model/reasoning/permission/plan/goal 且不泄露 objective', async () => {
    const { fake, port } = setup()
    fake.on('thread/resume', () => resume())
    fake.on('thread/goal/get', () => ({ goal: { objective: 'secret objective', status: 'active' } }))

    const result = await port.readSettings(READ_REQUEST, signal())
    const byField = new Map(result.values.map(value => [value.field, value]))

    expect(result.runtimeEpoch).toBe('epoch-1')
    expect(byField.get('model')?.current).toBe('gpt-5')
    expect(byField.get('reasoning')?.current).toBe('high')
    expect(byField.get('permission')?.current).toEqual({
      approvalPolicy: 'on-request',
      sandbox: { fileSystem: 'workspace-write', network: false },
      additionalDirectories: ['/repo/src'],
    })
    expect(byField.get('plan')?.current).toBe('on')
    expect(byField.get('goal')?.current).toBe(true)
    expect(result.values.every(value => value.confirmed)).toBe(true)
    // 每个发布值都来自同一当前修订，客户端用它作为 expectedRevision。
    expect(result.values.every(value => value.revision === result.revision)).toBe(true)
    expect(result.revision).toBe(port.snapshot('s1')?.current.revision)
    expect(JSON.stringify(result)).not.toContain('secret objective')
    expect(JSON.stringify(port.snapshot('s1'))).not.toContain('secret objective')
  })

  it('goal 为 null 时发布存在性 false', async () => {
    const { fake, port } = setup()
    fake.on('thread/resume', () => resume())
    const result = await port.readSettings(READ_REQUEST, signal())
    expect(result.values.find(value => value.field === 'goal')?.current).toBe(false)
  })
})

describe('CodexSettingsPort configure goal', () => {
  it('set 以 goal/get 为真值，方法顺序与参数正确', async () => {
    const { fake, port, began, ended } = setup()
    fake.on('thread/goal/set', () => ({ goal: { objective: 'do X' } }))
    fake.on('thread/goal/get', () => ({ goal: { objective: 'do X' } }))

    const result = await port.configure(configureRequest(), signal())

    expect(result).toMatchObject({ status: 'confirmed', runtimeEpoch: 'epoch-1' })
    expect(result.code).toBeUndefined()
    expect(fake.calls.map(call => call.method)).toEqual(['thread/goal/set', 'thread/goal/get'])
    expect(fake.calls[0]?.params).toMatchObject({ threadId: 's1', objective: 'do X' })
    expect(port.snapshot('s1')?.current.goal).toBe(true)
    expect(JSON.stringify(port.snapshot('s1'))).not.toContain('do X')
    expect(began).toEqual(['s1'])
    expect(ended).toEqual(['s1'])
  })

  it('set 后 get 返回不同 objective → confirmed + readback-mismatch', async () => {
    const { fake, port } = setup()
    fake.on('thread/goal/set', () => ({ goal: { objective: 'do X' } }))
    fake.on('thread/goal/get', () => ({ goal: { objective: 'something else' } }))

    const result = await port.configure(configureRequest(), signal())
    expect(result.status).toBe('confirmed')
    expect(result.code).toBe('readback-mismatch')
    expect(port.snapshot('s1')?.current.goal).toBe(true)
  })

  it('clear 后 get 为 null → confirmed 且 current.goal=false', async () => {
    const { fake, port } = setup()
    fake.on('thread/goal/clear', () => ({ cleared: true }))
    fake.on('thread/goal/get', () => ({ goal: null }))

    const result = await port.configure(configureRequest({ value: null }), signal())
    expect(result.status).toBe('confirmed')
    expect(result.code).toBeUndefined()
    expect(port.snapshot('s1')?.current.goal).toBe(false)
    expect(fake.calls.map(call => call.method)).toEqual(['thread/goal/clear', 'thread/goal/get'])
  })

  it('clear 后 get 仍非 null → readback-mismatch 且 current.goal=true', async () => {
    const { fake, port } = setup()
    fake.on('thread/goal/clear', () => ({ cleared: true }))
    fake.on('thread/goal/get', () => ({ goal: { objective: 'still here' } }))

    const result = await port.configure(configureRequest({ value: null }), signal())
    expect(result.status).toBe('confirmed')
    expect(result.code).toBe('readback-mismatch')
    expect(port.snapshot('s1')?.current.goal).toBe(true)
  })

  it('未授权 contentAuthorized 时零原生调用且不取 configure 锁', async () => {
    const { fake, port, began } = setup()
    await expect(port.configure(configureRequest({ contentAuthorized: false }), signal()))
      .rejects.toMatchObject({ code: 'unsupported' })
    expect(fake.calls).toHaveLength(0)
    expect(began).toHaveLength(0)
  })

  it('revision 不一致在原生调用前拒绝', async () => {
    const { fake, port, began } = setup()
    await expect(port.configure(configureRequest({ expectedRevision: 7 }), signal()))
      .rejects.toMatchObject({ code: 'revision-conflict' })
    expect(fake.calls).toHaveLength(0)
    expect(began).toHaveLength(0)
  })

  it('非受管/非 idle 在原生调用前拒绝', async () => {
    const foreign = setup({ writable: false })
    await expect(foreign.port.configure(configureRequest(), signal()))
      .rejects.toMatchObject({ code: 'ownership-unverified' })
    expect(foreign.fake.calls).toHaveLength(0)
    expect(foreign.began).toHaveLength(0)

    const busy = setup({ idle: false })
    await expect(busy.port.configure(configureRequest(), signal()))
      .rejects.toMatchObject({ code: 'writer-busy' })
    expect(busy.fake.calls).toHaveLength(0)
    expect(busy.began).toHaveLength(0)
  })

  it('model/reasoning/permission/plan 一律 unsupported 且不触达原生', async () => {
    const cases: ReadonlyArray<{ readonly field: string; readonly value: unknown }> = [
      { field: 'model', value: 'gpt-9' },
      { field: 'reasoning', value: 'high' },
      { field: 'permission', value: { approvalPolicy: 'never' } },
      { field: 'plan', value: 'on' },
    ]
    for (const entry of cases) {
      const { fake, port, began } = setup()
      await expect(port.configure(configureRequest({ field: entry.field, value: entry.value }), signal()))
        .rejects.toMatchObject({ code: 'unsupported' })
      expect(fake.calls).toHaveLength(0)
      expect(began).toHaveLength(0)
    }
  })

  it('goal/set RPC 错误映射 unsupported，且不留下卡住的 pending', async () => {
    const { fake, port, ended } = setup()
    fake.on('thread/goal/set', () => { throw new CodexPeerError('rpc', -32601) })

    await expect(port.configure(configureRequest(), signal()))
      .rejects.toMatchObject({ code: 'unsupported' })
    expect(port.snapshot('s1')?.pending).toBeUndefined()
    expect(ended).toEqual(['s1'])

    fake.on('thread/goal/set', () => ({ goal: { objective: 'do X' } }))
    fake.on('thread/goal/get', () => ({ goal: { objective: 'do X' } }))
    const result = await port.configure(configureRequest(), signal())
    expect(result.status).toBe('confirmed')
  })

  it('传输超时保持旧 current，返回 pending-confirmation/readback-timeout', async () => {
    const { timers, fake, port } = setup()
    fake.on('thread/goal/set', () => { throw new CodexPeerError('timeout') })

    const promise = port.configure(configureRequest(), signal())
    expect(timers.lastDelay).toBe(20)
    timers.fire()
    const result = await promise

    expect(result.status).toBe('pending-confirmation')
    expect(result.code).toBe('readback-timeout')
    expect(port.snapshot('s1')?.current.goal).toBeUndefined()
    expect(port.snapshot('s1')?.pending?.status).toBe('readback-timeout')
  })

  it('超时后可手动重试：同一 expectedRevision 不会被 configure-pending 拒绝', async () => {
    const { timers, fake, port, began, ended } = setup()
    fake.on('thread/goal/set', () => { throw new CodexPeerError('timeout') })

    const first = port.configure(configureRequest(), signal())
    timers.fire()
    const timedOut = await first
    expect(timedOut.status).toBe('pending-confirmation')
    expect(timedOut.code).toBe('readback-timeout')
    // 超时保持旧 current，revision 不推进。
    expect(port.snapshot('s1')?.current.revision).toBe(0)

    fake.on('thread/goal/set', () => ({ goal: { objective: 'do X' } }))
    fake.on('thread/goal/get', () => ({ goal: { objective: 'do X' } }))
    const result = await port.configure(configureRequest(), signal())
    expect(result.status).toBe('confirmed')
    expect(result.code).toBeUndefined()
    expect(port.snapshot('s1')?.current.goal).toBe(true)
    expect(began).toHaveLength(2)
    expect(ended).toHaveLength(2)
  })

  it('已 abort 的 signal 在原生写前拒绝：零 goal 调用、无 pending、不取锁', async () => {
    const { fake, port, began, ended } = setup()
    const reason = new Error('cancelled before write')
    const controller = new AbortController()
    controller.abort(reason)

    await expect(port.configure(configureRequest(), controller.signal)).rejects.toBe(reason)
    expect(fake.calls.filter(call => call.method.startsWith('thread/goal/'))).toHaveLength(0)
    expect(port.snapshot('s1')?.pending).toBeUndefined()
    expect(began).toHaveLength(0)
    expect(ended).toHaveLength(0)
  })
})

describe('CodexSettingsPort 通知与生命周期', () => {
  it('settings/goal 通知更新 current 但不结算 pending', async () => {
    const { fake, port } = setup()
    fake.on('thread/resume', () => resume())
    fake.on('thread/goal/get', () => ({ goal: { objective: 'a' } }))
    await port.readSettings(READ_REQUEST, signal())

    port.observeNotification('thread/settings/updated', {
      threadId: 's1',
      threadSettings: {
        model: 'gpt-6',
        effort: 'low',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        collaborationMode: { mode: 'default' },
      },
    })
    const updated = port.snapshot('s1')?.current
    expect(updated).toMatchObject({
      model: 'gpt-6',
      reasoning: 'low',
      permission: { approvalPolicy: 'never', sandbox: { fileSystem: 'danger-full-access' } },
      plan: 'off',
      goal: true,
    })

    port.observeNotification('thread/goal/cleared', { threadId: 's1' })
    expect(port.snapshot('s1')?.current.goal).toBe(false)
    port.observeNotification('thread/goal/updated', { threadId: 's1', goal: { objective: 'b' } })
    expect(port.snapshot('s1')?.current.goal).toBe(true)

    // 未知会话不创建回读状态。
    port.observeNotification('thread/goal/updated', { threadId: 'other', goal: { objective: 'x' } })
    expect(port.snapshot('other')).toBeUndefined()
  })

  it('pending goal 请求期间的通知不结算它', async () => {
    const { fake, port } = setup()
    let release!: (value: unknown) => void
    fake.on('thread/goal/set', () => new Promise(resolve => { release = resolve }))
    fake.on('thread/goal/get', () => ({ goal: { objective: 'do X' } }))

    const promise = port.configure(configureRequest(), signal())
    await Promise.resolve()
    expect(port.snapshot('s1')?.pending?.status).toBe('pending')

    port.observeNotification('thread/goal/updated', { threadId: 's1', goal: { objective: 'late' } })
    expect(port.snapshot('s1')?.pending?.status).toBe('pending')
    expect(port.snapshot('s1')?.current.goal).toBe(true)

    release({ goal: { objective: 'do X' } })
    const result = await promise
    expect(result.status).toBe('confirmed')
  })

  it('reset 拒绝 pending、清空回读且实例仍可用', async () => {
    const { fake, port } = setup()
    let release!: (value: unknown) => void
    fake.on('thread/goal/set', () => new Promise(resolve => { release = resolve }))
    fake.on('thread/goal/get', () => ({ goal: { objective: 'do X' } }))

    const promise = port.configure(configureRequest(), signal())
    await Promise.resolve()
    port.reset()
    expect(port.snapshot('s1')).toBeUndefined()
    release({ goal: { objective: 'do X' } })
    await expect(promise).rejects.toThrow()

    fake.on('thread/resume', () => resume())
    const read = await port.readSettings(READ_REQUEST, signal())
    expect(read.values.find(value => value.field === 'model')?.current).toBe('gpt-5')
  })

  it('dispose 后 readSettings/configure 都以 unsupported 拒绝', async () => {
    const { port } = setup()
    port.dispose()
    await expect(port.readSettings(READ_REQUEST, signal()))
      .rejects.toMatchObject({ code: 'unsupported' })
    await expect(port.configure(configureRequest(), signal()))
      .rejects.toMatchObject({ code: 'unsupported' })
  })
})
