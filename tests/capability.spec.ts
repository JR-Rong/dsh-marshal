import { describe, expect, it } from 'vitest'
import { createDshAdapter } from '../src/adapters/dsh/adapter.ts'
import type { DshSurface } from '../src/adapters/dsh/surface.ts'
import { createPrivacyProjector } from '../src/node/privacy.ts'
import type { EventFrame, MarshalKind } from '../src/wire/frames.ts'

const SENTINEL = `sk-${'B'.repeat(24)}`

function projector(privacy: 'metadata' | 'content' = 'metadata') {
  return createPrivacyProjector({
    privacy,
    allowContent: privacy === 'content',
    questionRelay: 'off',
    approvalRelay: 'off',
    allowInteractions: false,
    redaction: [],
    deviceId: 'mac',
    agent: 'dsh',
    nodeEpoch: 'epoch-1',
    now: () => 100,
  })
}

function event(kind: MarshalKind, payload: unknown): EventFrame {
  return {
    v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1',
    nodeEpoch: 'epoch-1', seq: 1, ts: 10, kind, payload,
  }
}

const surface = {
  list: async () => ({
    items: [{ sessionId: 's1', running: false, blank: true, updatedAt: 3 }],
    completeness: 'complete' as const,
  }),
  follow: async function* () {},
  prompt: async () => ({}),
} satisfies DshSurface

describe('capability projection', () => {
  it('observe 的 history/follow 分开投影，未知字段与旧 dispatch 一律丢弃', () => {
    const projected = projector().event(event('capability.changed', {
      observe: { history: false, follow: 'stream', extra: SENTINEL },
      dispatch: 'prompt',
      operations: ['prompt', 'interrupt', 'answer', 'cancel', 'bogus', SENTINEL],
      ownership: 'unverified',
      reasoning: true,
      toolDetail: 'args+output',
      promptFidelity: 'native',
      revision: 2,
      readAt: 100,
      injected: SENTINEL,
    }))
    expect(projected).toHaveLength(1)
    expect(projected[0]?.payload).toEqual({
      observe: { history: false, follow: 'stream' },
      operations: ['prompt', 'interrupt', 'answer', 'cancel'],
      ownership: 'unverified',
      toolDetail: 'args+output',
      promptFidelity: 'native',
      reasoning: true,
      revision: 2,
      readAt: 100,
    })
    expect(JSON.stringify(projected)).not.toContain(SENTINEL)
  })

  it('未知 follow/ownership 值不进入投影', () => {
    const projected = projector().event(event('capability.changed', {
      observe: { history: true, follow: 'push' },
      ownership: 'admin',
    }))
    expect(projected[0]?.payload).toEqual({ observe: { history: true } })
  })

  it('unavailable 原因码有界，tunables 的 values/current 只保留有界结构', () => {
    const unavailable: Record<string, string> = { 'observe.history': 'history-unavailable' }
    for (let index = 0; index < 20; index += 1) unavailable[`x${index}`] = `reason-${index}`
    const projected = projector().event(event('capability.changed', {
      settingsRevision: 4,
      runtimeEpoch: 'epoch-1',
      operations: ['prompt', 'acquire', 'teleport'],
      pending: {
        field: 'goal',
        status: 'pending',
        requested: { objective: SENTINEL },
        requestedAt: 9,
        baseFieldRevision: 3,
      },
      tunables: [{
        id: 'model', scope: 'next-turn', effect: 'immediate', editable: false,
        reason: 'v0-field-only', current: SENTINEL,
        values: [{ id: 'opus', label: SENTINEL }],
      }, {
        id: 'permission', scope: 'next-session', effect: 'next-session', editable: false,
        current: {
          approvalPolicy: 'on-request',
          sandbox: { fileSystem: 'workspace-write', network: false },
          additionalDirectories: ['/home/secret'],
          rules: [SENTINEL],
        },
        values: [{ id: 'x'.repeat(80), label: 'y'.repeat(200) }],
      }, { id: 'shell' }],
      unavailable,
    }))
    const payload = projected[0]?.payload as {
      operations: string[]
      tunables: Record<string, unknown>[]
      unavailable: Record<string, string>
      settingsRevision: number
      runtimeEpoch: string
      pending: Record<string, unknown>
    }
    expect(payload.operations).toEqual(['prompt', 'acquire'])
    expect(payload.settingsRevision).toBe(4)
    expect(payload.runtimeEpoch).toBe('epoch-1')
    // pending 只保留字段与状态；requested/requestedAt/baseFieldRevision 不进入投影。
    expect(payload.pending).toEqual({ field: 'goal', status: 'pending' })
    expect(Object.keys(payload.unavailable)).toHaveLength(16)
    expect(payload.unavailable['observe.history']).toBe('history-unavailable')

    // 未知 tunable id 被丢弃；values/current 按有界结构保留并脱敏。
    expect(payload.tunables).toHaveLength(2)
    const model = payload.tunables[0] as {
      current: string
      values: { id: string; label: string }[]
    }
    expect(model).toMatchObject({ id: 'model', editable: false, reason: 'v0-field-only' })
    expect(typeof model.current).toBe('string')
    expect(model.values).toHaveLength(1)
    expect(model.values[0]?.id).toBe('opus')

    const permission = payload.tunables[1] as { current: unknown; values: { id: string; label: string }[] }
    // 目录/规则是路径或自由文本，投影后只剩 approvalPolicy/sandbox。
    expect(permission.current).toEqual({
      approvalPolicy: 'on-request',
      sandbox: { fileSystem: 'workspace-write', network: false },
    })
    expect(permission.values[0]?.id).toHaveLength(64)
    expect(permission.values[0]?.label).toHaveLength(128)

    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain(SENTINEL)
    expect(serialized).not.toContain('/home/secret')
    expect(serialized).not.toContain('additionalDirectories')
  })

  it('未知枚举与自由文本一律丢弃，不把陌生值当能力', () => {
    const projected = projector().event(event('capability.changed', {
      toolDetail: 'full-transcript',
      promptFidelity: 'best-effort',
      operations: ['prompt', 'teleport'],
      tunables: [
        { id: 'shell', scope: 'next-turn', effect: 'immediate' },
        { id: 'model', scope: 'forever', effect: 'immediate', direction: 'widen', reason: 'free text reason' },
        { id: 'reasoning', scope: 'next-turn', effect: 'immediate', direction: 'tighten-only', reason: 'host-config' },
      ],
    }))
    expect(projected[0]?.payload).toEqual({
      operations: ['prompt'],
      tunables: [
        { id: 'model', effect: 'immediate' },
        { id: 'reasoning', scope: 'next-turn', effect: 'immediate', direction: 'tighten-only', reason: 'host-config' },
      ],
    })
  })

  it('内容档也不把 capability 当正文通道', () => {
    const projected = projector('content').event(event('capability.changed', {
      observe: { history: false, follow: 'stream' },
      ownership: 'unverified',
      extra: SENTINEL,
    }))
    expect(projected[0]?.payload).toEqual({
      observe: { history: false, follow: 'stream' },
      ownership: 'unverified',
    })
  })

  it('session.updated 的 blank 是安全布尔字段，cwd 仍然丢弃', () => {
    const projected = projector().event(event('session.updated', {
      running: false, updatedAt: 3, blank: true, cwd: '/secret', title: SENTINEL,
    }))
    expect(projected[0]?.payload).toEqual({ running: false, blank: true, updatedAt: 3 })
  })
})

describe('dsh capability model', () => {
  it('adapter 的 snapshot 能力载荷经过投影后仍完整可读', async () => {
    const adapter = createDshAdapter(surface, { deviceId: 'mac', nodeEpoch: 'epoch-1' })
    const frames = await adapter.snapshot(new AbortController().signal)
    const changed = frames.filter(frame => frame.kind === 'capability.changed')
    expect(changed).toHaveLength(1)
    const projected = projector().event(changed[0]!)
    expect(projected[0]?.payload).toMatchObject({
      observe: { history: false, follow: 'stream' },
      operations: ['prompt', 'answer', 'cancel'],
      ownership: 'attached',
      reasoning: true,
      unavailable: {
        'observe.history': 'history-unavailable',
        create: 'not-exposed-in-v0',
        fork: 'not-exposed-in-v0',
        configure: 'read-only-in-v0',
      },
    })
  })

  it('没有回合绑定时 interrupt 关闭并给出原因；有绑定时才出现在 operations', () => {
    const without = createDshAdapter(surface, { deviceId: 'mac', nodeEpoch: 'e' }).capabilities('s1')
    expect(without.operations.has('interrupt')).toBe(false)
    expect(without.unavailable?.interrupt).toBe('no-atomic-turn-binding')

    const withBinding = createDshAdapter({
      ...surface,
      activeTurn: async () => ({ turnId: 't1' }),
      cancelTurn: async () => ({}),
    }, { deviceId: 'mac', nodeEpoch: 'e' }).capabilities('s1')
    expect(withBinding.operations.has('interrupt')).toBe(true)
    expect(withBinding.unavailable?.interrupt).toBeUndefined()
    expect(withBinding.operations.has('create')).toBe(false)
    expect(withBinding.operations.has('fork')).toBe(false)
  })
})
