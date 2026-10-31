import { describe, expect, it } from 'vitest'
import type { Tunable } from '../src/adapters/types.ts'
import {
  buildTunables, SETTINGS_FIELDS,
  type ConfirmedSettings, type EffortLevel, type PermissionScope, type TunableCatalog,
} from '../src/tunables/catalog.ts'

const EFFORTS: readonly EffortLevel[] = [
  // 展示顺序故意打乱，等级由 rank 决定。
  { id: 'medium', rank: 2 },
  { id: 'high', rank: 3 },
  { id: 'low', rank: 1 },
]

const PERMISSION: PermissionScope = {
  approvalPolicy: 'on-request',
  sandbox: { fileSystem: 'workspace-write', network: false },
  additionalDirectories: ['src'],
  rules: ['no-network'],
}

const CATALOG: TunableCatalog = {
  agent: 'codex',
  models: [
    { id: 'zeta', label: 'Zeta', efforts: EFFORTS, defaultEffort: 'high', permission: PERMISSION },
    { id: 'alpha', label: 'Alpha', efforts: [{ id: 'low', rank: 1 }], defaultEffort: 'low' },
    { id: 'unlabeled', efforts: EFFORTS, defaultEffort: 'medium' },
  ],
  readback: {
    model: true, reasoning: true, permission: true, plan: true, goal: true,
  },
  permissionLattice: {
    approvalPolicy: { untrusted: 0, 'on-request': 1 },
    fileSystem: { 'read-only': 0, 'workspace-write': 1 },
  },
  skills: [{ id: 'review', label: 'Review' }, { id: 'plain' }],
  plugins: [{ id: 'build' }],
}

const CONFIRMED: ConfirmedSettings = {
  revision: 5,
  model: 'zeta',
  reasoning: 'high',
  permission: PERMISSION,
  plan: 'on',
  goal: true,
}

function tunable(tunables: readonly Tunable[], id: Tunable['id']): Tunable {
  const found = tunables.find(item => item.id === id)
  if (found === undefined) throw new Error(`missing tunable: ${id}`)
  return found
}

/** 只保留语义字段；values 的顺序属于展示，另行按集合比较。 */
function semantics(tunables: readonly Tunable[]): unknown {
  return tunables.map(({ id, scope, effect, direction, editable, reason, current }) => ({
    id,
    scope,
    effect,
    ...(direction === undefined ? {} : { direction }),
    editable,
    ...(reason === undefined ? {} : { reason }),
    ...(current === undefined ? {} : { current }),
  }))
}

function valuesById(tunables: readonly Tunable[]): unknown {
  return tunables.map(item => ({
    id: item.id,
    values: item.values === undefined ? undefined : [...item.values].map(value => value.id).sort(),
  }))
}

describe('buildTunables 固定形状', () => {
  it('七个字段全部存在且顺序固定', () => {
    const tunables = buildTunables(CATALOG, CONFIRMED, { contentAuthorized: true })
    expect(tunables.map(item => item.id)).toEqual([...SETTINGS_FIELDS])
  })

  it('DSH 全部只读，设置字段用 v0 原因，不声称回读', () => {
    const tunables = buildTunables({ ...CATALOG, agent: 'dsh' }, CONFIRMED, { contentAuthorized: true })
    for (const item of tunables) expect(item.editable).toBe(false)
    for (const field of ['model', 'reasoning', 'permission', 'plan', 'goal'] as const) {
      expect(tunable(tunables, field).reason).toBe('read-only-in-v0')
      expect(tunable(tunables, field).current).toBeUndefined()
    }
    expect(tunable(tunables, 'skill').reason).toBe('host-config')
    expect(tunable(tunables, 'plugin').reason).toBe('host-config')
  })
})

describe('可编辑性需要回读与目录/等级同时成立', () => {
  it('model 同时要求 readback.model 与非空目录', () => {
    const noReadback = buildTunables(
      { ...CATALOG, readback: { ...CATALOG.readback, model: false } },
      CONFIRMED,
      { contentAuthorized: true },
    )
    expect(tunable(noReadback, 'model').editable).toBe(false)
    expect(tunable(noReadback, 'model').reason).toBe('catalog-unavailable')

    const noModels = buildTunables(
      { ...CATALOG, models: [] },
      CONFIRMED,
      { contentAuthorized: true },
    )
    expect(tunable(noModels, 'model').editable).toBe(false)
    expect(tunable(noModels, 'model').reason).toBe('catalog-unavailable')
    expect(tunable(noModels, 'model').values).toBeUndefined()
  })

  it('reasoning 要求当前模型至少两个有等级档位与已确认基线', () => {
    const single: ConfirmedSettings = { ...CONFIRMED, model: 'alpha', reasoning: 'low' }
    const tunables = buildTunables(CATALOG, single, { contentAuthorized: true })
    expect(tunable(tunables, 'reasoning').editable).toBe(false)
    expect(tunable(tunables, 'reasoning').reason).toBe('catalog-unavailable')

    const noReadback = buildTunables(
      { ...CATALOG, readback: { ...CATALOG.readback, reasoning: false } },
      CONFIRMED,
      { contentAuthorized: true },
    )
    expect(tunable(noReadback, 'reasoning').editable).toBe(false)

    const noCurrent = buildTunables(CATALOG, undefined, { contentAuthorized: true })
    expect(tunable(noCurrent, 'reasoning').editable).toBe(false)

    // 只有 model 没有已确认 reasoning：decideConfigure 会报 current-unknown。
    const noBaseline = buildTunables(CATALOG, { revision: 5, model: 'zeta' }, { contentAuthorized: true })
    expect(tunable(noBaseline, 'reasoning').editable).toBe(false)
    expect(tunable(noBaseline, 'reasoning').reason).toBe('catalog-unavailable')
  })

  it('permission 要求 readback、lattice 与已确认基线同时成立', () => {
    const noLattice = buildTunables(
      {
        agent: CATALOG.agent,
        models: CATALOG.models,
        readback: CATALOG.readback,
      },
      CONFIRMED,
      { contentAuthorized: true },
    )
    expect(tunable(noLattice, 'permission').editable).toBe(false)
    expect(tunable(noLattice, 'permission').reason).toBe('permission-lattice-unavailable')

    const noReadback = buildTunables(
      { ...CATALOG, readback: { ...CATALOG.readback, permission: false } },
      CONFIRMED,
      { contentAuthorized: true },
    )
    expect(tunable(noReadback, 'permission').editable).toBe(false)
    expect(tunable(noReadback, 'permission').reason).toBe('permission-lattice-unavailable')

    // 已确认快照缺少 permission：decideConfigure 会报 permission-unverifiable。
    const noBaseline = buildTunables(CATALOG, { revision: 5, model: 'zeta' }, { contentAuthorized: true })
    expect(tunable(noBaseline, 'permission').editable).toBe(false)
    expect(tunable(noBaseline, 'permission').reason).toBe('permission-lattice-unavailable')

    expect(tunable(buildTunables(CATALOG, CONFIRMED, { contentAuthorized: true }), 'permission').editable)
      .toBe(true)
  })

  it('plan 要求回读渠道与已确认基线', () => {
    const noReadback = buildTunables(
      { ...CATALOG, readback: { ...CATALOG.readback, plan: false } },
      CONFIRMED,
      { contentAuthorized: true },
    )
    expect(tunable(noReadback, 'plan').editable).toBe(false)
    expect(tunable(noReadback, 'plan').reason).toBe('settings-readback-unavailable')

    // 已确认快照缺少 plan：decideConfigure 会报 current-unknown。
    const noBaseline = buildTunables(
      CATALOG,
      { revision: 5, model: 'zeta', reasoning: 'high' },
      { contentAuthorized: true },
    )
    expect(tunable(noBaseline, 'plan').editable).toBe(false)
    expect(tunable(noBaseline, 'plan').reason).toBe('settings-readback-unavailable')

    expect(tunable(buildTunables(CATALOG, CONFIRMED, { contentAuthorized: true }), 'plan').editable)
      .toBe(true)
  })

  it('goal 要求双重 content 授权与回读渠道', () => {
    const denied = buildTunables(CATALOG, CONFIRMED, { contentAuthorized: false })
    expect(tunable(denied, 'goal').editable).toBe(false)
    expect(tunable(denied, 'goal').reason).toBe('privacy-readback-unavailable')

    const missing = buildTunables(CATALOG, CONFIRMED)
    expect(tunable(missing, 'goal').editable).toBe(false)
    expect(tunable(missing, 'goal').reason).toBe('privacy-readback-unavailable')

    const noReadback = buildTunables(
      { ...CATALOG, readback: { ...CATALOG.readback, goal: false } },
      CONFIRMED,
      { contentAuthorized: true },
    )
    expect(tunable(noReadback, 'goal').editable).toBe(false)
    expect(tunable(noReadback, 'goal').reason).toBe('settings-readback-unavailable')

    expect(tunable(buildTunables(CATALOG, CONFIRMED, { contentAuthorized: true }), 'goal').editable)
      .toBe(true)
  })

  it('claude 同样由目录驱动而不是 agent 转移表', () => {
    const tunables = buildTunables({ ...CATALOG, agent: 'claude' }, CONFIRMED, { contentAuthorized: true })
    expect(tunable(tunables, 'model').editable).toBe(true)
    expect(tunable(tunables, 'reasoning').direction).toBe('tighten-only')
  })
})

describe('values 与 current 只来自显式目录/确认快照', () => {
  it('模型 values 使用目录 id/label，缺 label 时回落 id', () => {
    const tunables = buildTunables(CATALOG, CONFIRMED, { contentAuthorized: true })
    expect(tunable(tunables, 'model').values).toEqual([
      { id: 'zeta', label: 'Zeta' },
      { id: 'alpha', label: 'Alpha' },
      { id: 'unlabeled', label: 'unlabeled' },
    ])
  })

  it('reasoning values 只含当前模型有等级的档位', () => {
    const tunables = buildTunables(CATALOG, CONFIRMED, { contentAuthorized: true })
    expect(tunable(tunables, 'reasoning').values).toEqual([
      { id: 'medium', label: 'medium' },
      { id: 'high', label: 'high' },
      { id: 'low', label: 'low' },
    ])
  })

  it('skill/plugin 是只读目录，仍可展示 entries', () => {
    const tunables = buildTunables(CATALOG, CONFIRMED, { contentAuthorized: true })
    expect(tunable(tunables, 'skill').editable).toBe(false)
    expect(tunable(tunables, 'skill').values).toEqual([
      { id: 'review', label: 'Review' },
      { id: 'plain', label: 'plain' },
    ])
    expect(tunable(tunables, 'plugin').editable).toBe(false)
    expect(tunable(tunables, 'plugin').values).toEqual([{ id: 'build', label: 'build' }])
  })

  it('无确认快照时任何字段都没有 current', () => {
    const tunables = buildTunables(CATALOG, undefined, { contentAuthorized: true })
    for (const item of tunables) expect(item.current).toBeUndefined()
  })

  it('有确认快照时逐字段给出 current', () => {
    const tunables = buildTunables(CATALOG, CONFIRMED, { contentAuthorized: true })
    expect(tunable(tunables, 'model').current).toBe('zeta')
    expect(tunable(tunables, 'reasoning').current).toBe('high')
    expect(tunable(tunables, 'permission').current).toEqual(PERMISSION)
    expect(tunable(tunables, 'plan').current).toBe('on')
    expect(tunable(tunables, 'goal').current).toBe(true)
  })
})

describe('展示顺序不改变能力语义', () => {
  it('模型与强度数组打乱后语义一致', () => {
    const shuffled: TunableCatalog = {
      ...CATALOG,
      models: [...CATALOG.models].reverse().map(model => model.efforts === undefined
        ? model
        : { ...model, efforts: [...model.efforts].reverse() }),
    }
    const original = buildTunables(CATALOG, CONFIRMED, { contentAuthorized: true })
    const permuted = buildTunables(shuffled, CONFIRMED, { contentAuthorized: true })
    expect(semantics(permuted)).toEqual(semantics(original))
    expect(valuesById(permuted)).toEqual(valuesById(original))
  })
})

describe('goal 与只读字段的隐私边界', () => {
  it('ConfirmedSettings 被扩展也不会把 objective 带进能力', () => {
    const wider = {
      revision: 5,
      goal: true,
      objective: 'TOPSECRET-goal-objective',
      model: 'zeta',
    } as unknown as ConfirmedSettings
    const tunables = buildTunables(CATALOG, wider, { contentAuthorized: true })
    expect(tunable(tunables, 'goal').current).toBe(true)
    expect(JSON.stringify(tunables)).not.toContain('TOPSECRET')
  })

  it('skill/plugin 即使回读标志为 true 也永远只读', () => {
    const tunables = buildTunables(
      { ...CATALOG, readback: { ...CATALOG.readback, skill: true, plugin: true } },
      CONFIRMED,
      { contentAuthorized: true },
    )
    expect(tunable(tunables, 'skill').editable).toBe(false)
    expect(tunable(tunables, 'plugin').editable).toBe(false)
    expect(tunable(tunables, 'skill').reason).toBe('host-config')
    expect(tunable(tunables, 'plugin').reason).toBe('host-config')
  })
})
