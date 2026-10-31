import { describe, expect, it } from 'vitest'
import type { ConfigureRequest } from '../src/agents/types.ts'
import {
  effortRank,
  type ConfirmedSettings, type EffortLevel, type PermissionScope, type TunableCatalog,
} from '../src/tunables/catalog.ts'
import {
  comparePermission, decideConfigure, nextSettingsRevision,
  type ConfigureContext,
} from '../src/tunables/policy.ts'

const LADDER: readonly EffortLevel[] = [
  // 故意不按等级排序：显式 rank 才是唯一语义来源。
  { id: 'high', rank: 3 },
  { id: 'low', rank: 1 },
  { id: 'medium', rank: 2 },
]

const BASE_PERMISSION: PermissionScope = {
  approvalPolicy: 'on-request',
  sandbox: { fileSystem: 'workspace-write', network: false },
  additionalDirectories: ['src', 'docs'],
  rules: ['no-network'],
}

const TIGHTER_PERMISSION: PermissionScope = {
  approvalPolicy: 'untrusted',
  sandbox: { fileSystem: 'read-only', network: false },
  additionalDirectories: ['src'],
  rules: ['no-network'],
}

const WIDER_PERMISSION: PermissionScope = {
  approvalPolicy: 'never',
  sandbox: { fileSystem: 'danger-full-access', network: true },
  additionalDirectories: ['src', 'docs', 'etc'],
  rules: ['no-network'],
}

const CATALOG: TunableCatalog = {
  agent: 'codex',
  models: [
    { id: 'large', label: 'Large', efforts: LADDER, defaultEffort: 'high', permission: BASE_PERMISSION },
    {
      id: 'small',
      label: 'Small',
      efforts: [{ id: 'low', rank: 1 }, { id: 'medium', rank: 2 }],
      defaultEffort: 'low',
      permission: TIGHTER_PERMISSION,
    },
    {
      id: 'wide',
      label: 'Wide',
      efforts: LADDER,
      defaultEffort: 'high',
      permission: WIDER_PERMISSION,
    },
    {
      id: 'louder',
      label: 'Louder',
      efforts: [...LADDER, { id: 'ultra', rank: 4 }],
      defaultEffort: 'ultra',
      permission: TIGHTER_PERMISSION,
    },
    { id: 'bare', label: 'Bare' },
  ],
  readback: {
    model: true, reasoning: true, permission: true, plan: true, goal: true,
  },
  permissionLattice: {
    approvalPolicy: { untrusted: 0, 'on-request': 1, 'on-failure': 2, never: 3 },
    fileSystem: { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 },
  },
  skills: [{ id: 'review' }],
  plugins: [{ id: 'build' }],
}

const CONFIRMED: ConfirmedSettings = {
  revision: 3,
  model: 'large',
  reasoning: 'high',
  permission: BASE_PERMISSION,
  plan: 'on',
  goal: true,
}

/** exactOptionalPropertyTypes 下不能写 `field: undefined`；用删除表达“未知”。 */
function confirmedWithout(...keys: readonly (keyof ConfirmedSettings)[]): ConfirmedSettings {
  const copy: Record<string, unknown> = { ...CONFIRMED }
  for (const key of keys) delete copy[key]
  return copy as unknown as ConfirmedSettings
}

function catalogWithoutLattice(source: TunableCatalog): TunableCatalog {
  return {
    agent: source.agent,
    models: source.models,
    readback: source.readback,
    ...(source.skills === undefined ? {} : { skills: source.skills }),
    ...(source.plugins === undefined ? {} : { plugins: source.plugins }),
  }
}

function context(overrides: Partial<ConfigureContext> = {}): ConfigureContext {
  const base: ConfigureContext = {
    agent: 'codex',
    runtimeEpoch: 'epoch-1',
    state: 'idle',
    settingsRevision: 3,
    current: CONFIRMED,
    catalog: CATALOG,
    contentAuthorized: true,
  }
  const { pending, ...rest } = overrides
  return pending === undefined ? { ...base, ...rest } : { ...base, ...rest, pending }
}

function request(overrides: Partial<ConfigureRequest> = {}): ConfigureRequest {
  return {
    sessionId: 's1',
    field: 'reasoning',
    value: 'medium',
    expectedRevision: 3,
    runtimeEpoch: 'epoch-1',
    contentAuthorized: false,
    ...overrides,
  }
}

function decideReasoning(value: unknown, cat: TunableCatalog = CATALOG, from = 'high') {
  return decideConfigure(
    request({ field: 'reasoning', value }),
    context({ catalog: cat, current: { ...CONFIRMED, reasoning: from } }),
  )
}

describe('decideConfigure gate order', () => {
  it('只读 agent 优先于 epoch/状态/修订错误', () => {
    expect(decideConfigure(
      request({ runtimeEpoch: 'old', expectedRevision: 99 }),
      context({ agent: 'dsh', state: 'running' }),
    )).toEqual({ outcome: 'reject', code: 'unsupported', reason: 'read-only-in-v0' })
  })

  it('未知 agent 同样 fail closed', () => {
    expect(decideConfigure(
      request(),
      context({ agent: 'gemini' as unknown as ConfigureContext['agent'] }),
    )).toEqual({ outcome: 'reject', code: 'unsupported', reason: 'read-only-in-v0' })
  })

  it('catalog 与 agent 不一致时拒绝', () => {
    expect(decideConfigure(
      request(),
      context({ agent: 'codex', catalog: { ...CATALOG, agent: 'claude' } }),
    )).toEqual({ outcome: 'reject', code: 'unsupported', reason: 'catalog-agent-mismatch' })
  })

  it('runtimeEpoch 不一致先于 busy/pending/revision', () => {
    expect(decideConfigure(
      request({ runtimeEpoch: 'epoch-0', expectedRevision: 99 }),
      context({ state: 'running', pending: { requestId: 'r1', field: 'model' } }),
    )).toEqual({ outcome: 'reject', code: 'stale-connection', reason: 'runtime-epoch-mismatch' })
  })

  it('运行中禁止 configure，不排队', () => {
    expect(decideConfigure(
      request({ expectedRevision: 99 }),
      context({ state: 'running', pending: { requestId: 'r1', field: 'model' } }),
    )).toEqual({ outcome: 'reject', code: 'writer-busy', reason: 'session-not-idle' })
  })

  it('另一个 configure pending 时冲突，不比较它的字段', () => {
    expect(decideConfigure(
      request({ expectedRevision: 99 }),
      context({ pending: { requestId: 'r1', field: 'goal' } }),
    )).toEqual({ outcome: 'reject', code: 'conflict', reason: 'configure-pending' })
  })

  it('expectedRevision 比较整个设置快照的修订', () => {
    expect(decideConfigure(request({ expectedRevision: 2 }), context()))
      .toEqual({ outcome: 'reject', code: 'revision-conflict', reason: 'settings-revision-mismatch' })
  })

  it('未知字段拒绝', () => {
    expect(decideConfigure(request({ field: 'temperature' }), context()))
      .toEqual({ outcome: 'reject', code: 'unsupported', reason: 'unknown-field' })
  })

  it('skill/plugin 永远 host-config 只读', () => {
    for (const field of ['skill', 'plugin']) {
      expect(decideConfigure(request({ field }), context()))
        .toEqual({ outcome: 'reject', code: 'unsupported', reason: 'host-config' })
    }
  })
})

describe('effortRank', () => {
  it('只认显式整数 rank，与数组顺序无关', () => {
    expect(effortRank(CATALOG, 'large', 'medium')).toBe(2)
    expect(effortRank(CATALOG, 'large', 'high')).toBe(3)
    expect(effortRank(CATALOG, 'large', 'unknown')).toBeUndefined()
    expect(effortRank(CATALOG, 'missing', 'medium')).toBeUndefined()
    expect(effortRank(CATALOG, 'bare', 'medium')).toBeUndefined()
  })

  it('非整数 rank 视为无语义', () => {
    const odd: TunableCatalog = {
      ...CATALOG,
      models: [{ id: 'odd', efforts: [{ id: 'x', rank: 1.5 }, { id: 'y', rank: Number.NaN }] }],
    }
    expect(effortRank(odd, 'odd', 'x')).toBeUndefined()
    expect(effortRank(odd, 'odd', 'y')).toBeUndefined()
  })
})

describe('reasoning 阶梯', () => {
  it('沿阶梯下降可 apply', () => {
    expect(decideReasoning('medium')).toEqual({ outcome: 'apply' })
    expect(decideReasoning('low')).toEqual({ outcome: 'apply' })
    expect(decideReasoning('low', CATALOG, 'medium')).toEqual({ outcome: 'apply' })
  })

  it('任何上调都拒绝', () => {
    expect(decideReasoning('medium', CATALOG, 'low'))
      .toEqual({ outcome: 'reject', code: 'tighten-only', reason: 'effort-raise-rejected' })
    expect(decideReasoning('high', CATALOG, 'low'))
      .toEqual({ outcome: 'reject', code: 'tighten-only', reason: 'effort-raise-rejected' })
    expect(decideReasoning('high', CATALOG, 'medium'))
      .toEqual({ outcome: 'reject', code: 'tighten-only', reason: 'effort-raise-rejected' })
  })

  it('同一确认等级 no-op（即使 id 不同）', () => {
    expect(decideReasoning('high')).toEqual({ outcome: 'no-op' })
  })

  it('未知请求值拒绝，未知当前值也拒绝', () => {
    expect(decideReasoning('extreme'))
      .toEqual({ outcome: 'reject', code: 'unsupported', reason: 'unknown-effort' })
    expect(decideReasoning(7))
      .toEqual({ outcome: 'reject', code: 'unsupported', reason: 'unknown-effort' })
    expect(decideConfigure(
      request({ field: 'reasoning', value: 'low' }),
      context({ current: confirmedWithout('reasoning') }),
    )).toEqual({ outcome: 'reject', code: 'unsupported', reason: 'current-unknown' })
    expect(decideConfigure(
      request({ field: 'reasoning', value: 'low' }),
      context({ current: { ...CONFIRMED, reasoning: 'bogus' } }),
    )).toEqual({ outcome: 'reject', code: 'unsupported', reason: 'current-unknown' })
  })

  it('显示目录打乱不改变任何决策', () => {
    const shuffled: TunableCatalog = {
      ...CATALOG,
      models: CATALOG.models.map(model => model.id === 'large'
        ? { ...model, efforts: [...LADDER].reverse() }
        : model),
    }
    const steps: readonly (readonly [string, string])[] = [
      ['high', 'medium'], ['high', 'low'], ['medium', 'low'],
      ['low', 'medium'], ['low', 'high'], ['medium', 'high'], ['high', 'high'],
    ]
    for (const [from, to] of steps) {
      expect(decideReasoning(to, shuffled, from)).toEqual(decideReasoning(to, CATALOG, from))
    }
  })
})

describe('permission 比较完整有效范围', () => {
  const lattice = CATALOG.permissionLattice

  it('相等与子集', () => {
    expect(comparePermission(BASE_PERMISSION, BASE_PERMISSION, lattice)).toBe('equal')
    expect(comparePermission(TIGHTER_PERMISSION, BASE_PERMISSION, lattice)).toBe('tighter')
  })

  it('超集或放宽的维度为 wider', () => {
    expect(comparePermission(WIDER_PERMISSION, BASE_PERMISSION, lattice)).toBe('wider')
    expect(comparePermission(
      { ...BASE_PERMISSION, sandbox: { fileSystem: 'workspace-write', network: true } },
      BASE_PERMISSION,
      lattice,
    )).toBe('wider')
    expect(comparePermission(
      { ...BASE_PERMISSION, additionalDirectories: ['src', 'docs', 'etc'] },
      BASE_PERMISSION,
      lattice,
    )).toBe('wider')
  })

  it('缺失不等于空：未知与已知不可比较', () => {
    expect(comparePermission({}, {}, lattice)).toBe('equal')
    expect(comparePermission({ additionalDirectories: [] }, {}, lattice)).toBe('incomparable')
    expect(comparePermission({}, { additionalDirectories: [] }, lattice)).toBe('incomparable')
    expect(comparePermission(
      { additionalDirectories: [] },
      { additionalDirectories: [] },
      lattice,
    )).toBe('equal')
    expect(comparePermission(
      {
        approvalPolicy: 'on-request',
        sandbox: { fileSystem: 'workspace-write', network: false },
        additionalDirectories: ['src', 'docs'],
      },
      BASE_PERMISSION,
      lattice,
    )).toBe('incomparable')
  })

  it('缺少等级或 mode 名称不在 lattice 中时不可比较', () => {
    expect(comparePermission(
      { approvalPolicy: 'mode-a' },
      { approvalPolicy: 'mode-b' },
      undefined,
    )).toBe('incomparable')
    expect(comparePermission(
      { approvalPolicy: 'mode-a' },
      { approvalPolicy: 'mode-b' },
      { approvalPolicy: { 'mode-a': 0 } },
    )).toBe('incomparable')
    // 顺序只来自 lattice，不来自名称本身。
    expect(comparePermission(
      { approvalPolicy: 'mode-a' },
      { approvalPolicy: 'mode-b' },
      { approvalPolicy: { 'mode-a': 0, 'mode-b': 1 } },
    )).toBe('tighter')
  })

  it('未知键使完整范围不可证明', () => {
    expect(comparePermission(
      { ...BASE_PERMISSION, extra: true } as unknown as PermissionScope,
      BASE_PERMISSION,
      lattice,
    )).toBe('incomparable')
  })

  it('wider 优先于 incomparable，incomparable 优先于 tighter', () => {
    const unknownRp: PermissionScope = { ...TIGHTER_PERMISSION, approvalPolicy: 'not-in-lattice' }
    expect(comparePermission(unknownRp, BASE_PERMISSION, lattice)).toBe('incomparable')
    const widerAndUnknown: PermissionScope = {
      ...WIDER_PERMISSION,
      approvalPolicy: 'not-in-lattice',
    }
    expect(comparePermission(widerAndUnknown, BASE_PERMISSION, lattice)).toBe('wider')
  })

  it('decideConfigure 只接受 tighter/equal', () => {
    expect(decideConfigure(
      request({ field: 'permission', value: TIGHTER_PERMISSION }),
      context(),
    )).toEqual({ outcome: 'apply' })
    expect(decideConfigure(
      request({ field: 'permission', value: BASE_PERMISSION }),
      context(),
    )).toEqual({ outcome: 'no-op' })
    expect(decideConfigure(
      request({ field: 'permission', value: WIDER_PERMISSION }),
      context(),
    )).toEqual({ outcome: 'reject', code: 'widen-rejected', reason: 'permission-widens' })
    expect(decideConfigure(
      request({ field: 'permission', value: { ...TIGHTER_PERMISSION, approvalPolicy: 'not-in-lattice' } }),
      context(),
    )).toEqual({ outcome: 'reject', code: 'widen-rejected', reason: 'permission-incomparable' })
  })

  it('缺 current 或 lattice 时不可验证', () => {
    expect(decideConfigure(
      request({ field: 'permission', value: TIGHTER_PERMISSION }),
      context({ current: confirmedWithout('permission') }),
    )).toEqual({ outcome: 'reject', code: 'unsupported', reason: 'permission-unverifiable' })
    expect(decideConfigure(
      request({ field: 'permission', value: TIGHTER_PERMISSION }),
      context({ catalog: catalogWithoutLattice(CATALOG) }),
    )).toEqual({ outcome: 'reject', code: 'unsupported', reason: 'permission-unverifiable' })
  })

  it('非普通对象拒绝', () => {
    expect(decideConfigure(
      request({ field: 'permission', value: [TIGHTER_PERMISSION] }),
      context(),
    )).toEqual({ outcome: 'reject', code: 'invalid-args', reason: 'permission-shape-invalid' })
    expect(decideConfigure(
      request({ field: 'permission', value: 'read-only' }),
      context(),
    )).toEqual({ outcome: 'reject', code: 'invalid-args', reason: 'permission-shape-invalid' })
  })
})

describe('model 组合检查', () => {
  const choose = (value: unknown, cat: TunableCatalog = CATALOG) => decideConfigure(
    request({ field: 'model', value }),
    context({ catalog: cat }),
  )

  it('同一模型 no-op，未知模型拒绝', () => {
    expect(choose('large')).toEqual({ outcome: 'no-op' })
    expect(choose('huge')).toEqual({ outcome: 'reject', code: 'unsupported', reason: 'unknown-model' })
    expect(choose(42)).toEqual({ outcome: 'reject', code: 'unsupported', reason: 'unknown-model' })
  })

  it('默认 effort 与权限都不放宽时可切换', () => {
    expect(choose('small')).toEqual({ outcome: 'apply' })
  })

  it('默认 effort 上调拒绝', () => {
    expect(choose('louder'))
      .toEqual({ outcome: 'reject', code: 'tighten-only', reason: 'model-widens-effort' })
  })

  it('模型默认权限放宽或不可比较时拒绝', () => {
    expect(choose('wide'))
      .toEqual({ outcome: 'reject', code: 'widen-rejected', reason: 'model-widens-permission' })
    const mysteryCatalog: TunableCatalog = {
      ...CATALOG,
      models: [
        ...CATALOG.models,
        {
          id: 'mystery',
          efforts: LADDER,
          defaultEffort: 'high',
          permission: { ...BASE_PERMISSION, approvalPolicy: 'not-in-lattice' },
        },
      ],
    }
    expect(choose('mystery', mysteryCatalog))
      .toEqual({ outcome: 'reject', code: 'widen-rejected', reason: 'model-permission-incomparable' })
  })

  it('目录缺少默认 effort/permission 且已有确认值时不可验证', () => {
    expect(choose('bare'))
      .toEqual({ outcome: 'reject', code: 'unsupported', reason: 'model-unverifiable' })
    expect(choose('ghost', {
      ...CATALOG,
      models: [
        ...CATALOG.models,
        { id: 'ghost', defaultEffort: 'ghost-effort', permission: TIGHTER_PERMISSION },
      ],
    })).toEqual({ outcome: 'reject', code: 'unsupported', reason: 'model-unverifiable' })
  })
})

describe('plan 只允许收紧', () => {
  const plan = (value: unknown, currentPlan: 'on' | 'off' | undefined = 'on') => decideConfigure(
    request({ field: 'plan', value }),
    context({
      current: currentPlan === undefined ? confirmedWithout('plan') : { ...CONFIRMED, plan: currentPlan },
    }),
  )

  it('off -> on 是收紧，允许', () => {
    expect(plan('on', 'off')).toEqual({ outcome: 'apply' })
  })

  it('on -> off 可能放宽权限，拒绝', () => {
    expect(plan('off'))
      .toEqual({ outcome: 'reject', code: 'widen-rejected', reason: 'plan-may-widen' })
  })

  it('相等 no-op，非法值与非确认当前值拒绝', () => {
    expect(plan('on')).toEqual({ outcome: 'no-op' })
    expect(plan('maybe')).toEqual({ outcome: 'reject', code: 'invalid-args', reason: 'plan-value-invalid' })
    expect(plan('on', undefined))
      .toEqual({ outcome: 'reject', code: 'unsupported', reason: 'current-unknown' })
  })
})

describe('goal 需要双重 content 授权', () => {
  const goal = (
    value: unknown,
    overrides: Partial<ConfigureContext> = {},
    requestOverrides: Partial<ConfigureRequest> = {},
  ) => decideConfigure(
    request({
      field: 'goal',
      value,
      // 请求级授权默认与上下文一致；可显式覆盖以验证单侧拒绝。
      contentAuthorized: overrides.contentAuthorized ?? true,
      ...requestOverrides,
    }),
    context(overrides),
  )

  it('缺少 content 授权时关闭', () => {
    expect(goal({ objective: 'ship v1' }, { contentAuthorized: false }))
      .toEqual({ outcome: 'reject', code: 'unsupported', reason: 'privacy-readback-unavailable' })
  })

  it('仅请求级授权缺失时同样关闭', () => {
    expect(goal({ objective: 'ship v1' }, {}, { contentAuthorized: false }))
      .toEqual({ outcome: 'reject', code: 'unsupported', reason: 'privacy-readback-unavailable' })
    expect(goal(null, {}, { contentAuthorized: false }))
      .toEqual({ outcome: 'reject', code: 'unsupported', reason: 'privacy-readback-unavailable' })
  })

  it('缺少 goal 回读渠道时关闭', () => {
    const noReadback: TunableCatalog = {
      ...CATALOG,
      readback: { ...CATALOG.readback, goal: false },
    }
    expect(goal({ objective: 'ship v1' }, { catalog: noReadback }))
      .toEqual({ outcome: 'reject', code: 'unsupported', reason: 'settings-readback-unavailable' })
  })

  it('双授权成立时接受合法 objective，且决策不携带正文', () => {
    const decision = goal({ objective: 'ship v1' })
    expect(decision).toEqual({ outcome: 'apply' })
    expect(JSON.stringify(decision)).not.toContain('ship v1')
  })

  it('双授权成立时允许 clear，仍不携带正文', () => {
    const decision = goal(null)
    expect(decision).toEqual({ outcome: 'apply' })
    expect(JSON.stringify(decision)).not.toContain('objective')
  })

  it('clear 同样受回读渠道门控', () => {
    const noReadback: TunableCatalog = {
      ...CATALOG,
      readback: { ...CATALOG.readback, goal: false },
    }
    expect(goal(null, { catalog: noReadback }))
      .toEqual({ outcome: 'reject', code: 'unsupported', reason: 'settings-readback-unavailable' })
  })

  it('objective 形状或长度非法时拒绝', () => {
    for (const value of [
      {}, { objective: '' }, { objective: '   ' }, { objective: 7 },
      { objective: ['ship'] }, 'ship', ['ship'], undefined,
    ]) {
      expect(goal(value)).toEqual({ outcome: 'reject', code: 'invalid-args', reason: 'goal-objective-invalid' })
    }
    expect(goal({ objective: 'x'.repeat(20_000) })).toEqual({ outcome: 'apply' })
    expect(goal({ objective: 'x'.repeat(20_001) }))
      .toEqual({ outcome: 'reject', code: 'invalid-args', reason: 'goal-objective-too-large' })
  })
})

describe('nextSettingsRevision', () => {
  it('每次关联实际变化推进 +1', () => {
    expect(nextSettingsRevision(0)).toBe(1)
    expect(nextSettingsRevision(41)).toBe(42)
  })

  it('危险输入保持不变', () => {
    expect(nextSettingsRevision(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    expect(nextSettingsRevision(1.5)).toBe(1.5)
    expect(nextSettingsRevision(Number.NaN)).toBe(Number.NaN)
  })
})
