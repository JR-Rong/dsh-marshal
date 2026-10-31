import type { Tunable } from '../adapters/types.ts'

/**
 * 设置能力目录。
 *
 * 纯数据 + 纯函数：不读取适配器、不发起原生调用。等级（rank）必须由目标
 * 版本实测后显式写入；数组顺序只是展示顺序，任何比较都不看下标。
 *
 * 注意：`catalog-unavailable` / `permission-lattice-unavailable` /
 * `privacy-readback-unavailable` 是稳定的原因码，但当前
 * `src/node/privacy.ts` 的 reason 白名单尚未收录；投影会丢弃未知 reason，
 * 不会泄露正文。补齐投影属于 v1 后续任务，本模块不修改投影层。
 */

export type SettingsField = 'model' | 'reasoning' | 'permission' | 'plan' | 'goal' | 'skill' | 'plugin'

/** 固定顺序：能力文档、测试与页面都按它渲染。 */
export const SETTINGS_FIELDS: readonly SettingsField[] = [
  'model', 'reasoning', 'permission', 'plan', 'goal', 'skill', 'plugin',
]

export function isSettingsField(value: string): value is SettingsField {
  return (SETTINGS_FIELDS as readonly string[]).includes(value)
}

/** rank 必须显式给出；数组顺序只用于展示，绝不参与比较。 */
export interface EffortLevel {
  readonly id: string
  readonly rank: number
}

export interface ModelEntry {
  readonly id: string
  readonly label?: string
  readonly efforts?: readonly EffortLevel[]
  readonly defaultEffort?: string
  readonly permission?: PermissionScope
}

export interface PermissionScope {
  readonly approvalPolicy?: string
  readonly sandbox?: { readonly fileSystem?: string; readonly network?: boolean }
  readonly additionalDirectories?: readonly string[]
  readonly rules?: readonly string[]
}

/** 每个维度的已知等级；未列出的维度只允许相等。 */
export interface PermissionLattice {
  readonly approvalPolicy?: Readonly<Record<string, number>>
  readonly fileSystem?: Readonly<Record<string, number>>
}

export interface TunableCatalog {
  readonly agent: 'dsh' | 'codex' | 'claude'
  readonly models: readonly ModelEntry[]
  /** 该字段是否有已验证的真实回读渠道；false/缺失一律不可编辑。 */
  readonly readback: Readonly<Partial<Record<SettingsField, boolean>>>
  readonly permissionLattice?: PermissionLattice
  readonly skills?: readonly { readonly id: string; readonly label?: string }[]
  readonly plugins?: readonly { readonly id: string; readonly label?: string }[]
}

/** 已确认的设置快照；缺失表示未知，绝不用请求值填补。 */
export interface ConfirmedSettings {
  readonly revision: number
  readonly model?: string
  readonly reasoning?: string
  readonly permission?: PermissionScope
  readonly plan?: 'on' | 'off'
  /** 只用存在性表示已确认的 goal；objective 内容永不进入能力。 */
  readonly goal?: boolean
}

export interface BuildTunablesOptions {
  /** 必须同时满足 node privacy=content 与 hub allowContent 才为 true。 */
  readonly contentAuthorized?: boolean
}

const REASONS = {
  catalogUnavailable: 'catalog-unavailable',
  permissionLatticeUnavailable: 'permission-lattice-unavailable',
  settingsReadbackUnavailable: 'settings-readback-unavailable',
  privacyReadbackUnavailable: 'privacy-readback-unavailable',
  readOnlyInV0: 'read-only-in-v0',
  hostConfig: 'host-config',
} as const

interface FieldShape {
  readonly scope: Tunable['scope']
  readonly effect: Tunable['effect']
  readonly direction?: 'tighten-only'
}

const FIELD_SHAPES: Readonly<Record<SettingsField, FieldShape>> = {
  model: { scope: 'next-turn', effect: 'immediate' },
  reasoning: { scope: 'next-turn', effect: 'immediate', direction: 'tighten-only' },
  permission: { scope: 'next-session', effect: 'next-session', direction: 'tighten-only' },
  plan: { scope: 'next-turn', effect: 'immediate' },
  goal: { scope: 'next-turn', effect: 'immediate' },
  skill: { scope: 'host', effect: 'needs-restart' },
  plugin: { scope: 'host', effect: 'needs-restart' },
}

export function findModel(catalog: TunableCatalog, modelId: string): ModelEntry | undefined {
  return catalog.models.find(model => model.id === modelId)
}

/**
 * 只认目录里显式写出的整数 rank；缺失、非整数或模型未列出时返回 undefined，
 * 调用方据此 fail closed。绝不从数组下标推断等级。
 */
export function effortRank(catalog: TunableCatalog, modelId: string, effortId: string): number | undefined {
  const model = findModel(catalog, modelId)
  if (model?.efforts === undefined) return undefined
  const level = model.efforts.find(effort => effort.id === effortId)
  if (level === undefined) return undefined
  return Number.isInteger(level.rank) ? level.rank : undefined
}

function isHostField(field: SettingsField): boolean {
  return field === 'skill' || field === 'plugin'
}

function directoryValues(
  entries?: readonly { readonly id: string; readonly label?: string }[],
): Tunable['values'] {
  if (entries === undefined || entries.length === 0) return undefined
  return entries.map(entry => ({ id: entry.id, label: entry.label ?? entry.id }))
}

function directoryFor(catalog: TunableCatalog, field: SettingsField): Tunable['values'] {
  return directoryValues(field === 'skill' ? catalog.skills : catalog.plugins)
}

/**
 * DSH（以及任何未显式开放设置的 agent）只读：不声称回读、不给出 current，
 * 避免把请求值或本地缓存当成已确认值。
 */
function readOnlyTunables(catalog: TunableCatalog): readonly Tunable[] {
  return SETTINGS_FIELDS.map((field): Tunable => {
    const host = isHostField(field)
    const values = host ? directoryFor(catalog, field) : undefined
    return {
      id: field,
      ...FIELD_SHAPES[field],
      ...(values === undefined ? {} : { values }),
      editable: false,
      reason: host ? REASONS.hostConfig : REASONS.readOnlyInV0,
    }
  })
}

export function buildTunables(
  catalog: TunableCatalog,
  current?: ConfirmedSettings,
  options?: BuildTunablesOptions,
): readonly Tunable[] {
  // 只有已实测开放设置的 agent 才走可编辑分支；未知 agent 保持只读。
  if (catalog.agent !== 'codex' && catalog.agent !== 'claude') return readOnlyTunables(catalog)

  const contentAuthorized = options?.contentAuthorized === true
  const readback = catalog.readback
  const currentModel = current?.model === undefined ? undefined : findModel(catalog, current.model)

  const modelValues = directoryValues(catalog.models)
  const modelEditable = readback.model === true && modelValues !== undefined

  // 只展示有显式等级的强度档；没有 rank 的档无法比较，给了也只会被拒绝。
  const rankedEfforts = currentModel?.efforts?.filter(level => Number.isInteger(level.rank)) ?? []
  const reasoningValues = rankedEfforts.length === 0
    ? undefined
    : rankedEfforts.map(level => ({ id: level.id, label: level.id }))
  const reasoningEditable = readback.reasoning === true && rankedEfforts.length >= 2

  const permissionEditable = readback.permission === true && catalog.permissionLattice !== undefined
  const planEditable = readback.plan === true
  const goalEditable = readback.goal === true && contentAuthorized
  const skillValues = directoryFor(catalog, 'skill')
  const pluginValues = directoryFor(catalog, 'plugin')

  return [
    {
      id: 'model',
      ...FIELD_SHAPES.model,
      ...(modelValues === undefined ? {} : { values: modelValues }),
      ...(current?.model === undefined ? {} : { current: current.model }),
      editable: modelEditable,
      ...(modelEditable ? {} : { reason: REASONS.catalogUnavailable }),
    },
    {
      id: 'reasoning',
      ...FIELD_SHAPES.reasoning,
      ...(reasoningValues === undefined ? {} : { values: reasoningValues }),
      ...(current?.reasoning === undefined ? {} : { current: current.reasoning }),
      editable: reasoningEditable,
      ...(reasoningEditable ? {} : { reason: REASONS.catalogUnavailable }),
    },
    {
      id: 'permission',
      ...FIELD_SHAPES.permission,
      ...(current?.permission === undefined ? {} : { current: current.permission }),
      editable: permissionEditable,
      ...(permissionEditable ? {} : { reason: REASONS.permissionLatticeUnavailable }),
    },
    {
      id: 'plan',
      ...FIELD_SHAPES.plan,
      ...(current?.plan === undefined ? {} : { current: current.plan }),
      editable: planEditable,
      ...(planEditable ? {} : { reason: REASONS.settingsReadbackUnavailable }),
    },
    {
      id: 'goal',
      ...FIELD_SHAPES.goal,
      // goal 的 current 只有存在性；objective 文本永不进入能力文档。
      ...(current?.goal === undefined ? {} : { current: current.goal }),
      editable: goalEditable,
      ...(goalEditable
        ? {}
        : { reason: contentAuthorized ? REASONS.settingsReadbackUnavailable : REASONS.privacyReadbackUnavailable }),
    },
    {
      id: 'skill',
      ...FIELD_SHAPES.skill,
      ...(skillValues === undefined ? {} : { values: skillValues }),
      editable: false,
      reason: REASONS.hostConfig,
    },
    {
      id: 'plugin',
      ...FIELD_SHAPES.plugin,
      ...(pluginValues === undefined ? {} : { values: pluginValues }),
      editable: false,
      reason: REASONS.hostConfig,
    },
  ]
}
