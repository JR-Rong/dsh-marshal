import type { ConfigureRequest } from '../agents/types.ts'
import type { WireErrorCode } from '../wire/frames.ts'
import {
  effortRank, findModel, isSettingsField,
  type ConfirmedSettings, type PermissionLattice, type PermissionScope,
  type SettingsField, type TunableCatalog,
} from './catalog.ts'

/**
 * configure 的纯决策：只回答“允许 apply / 已确认 no-op / 拒绝及原因”，
 * 不发起原生调用，也不写任何状态。回读、pending 与 revision 推进由端口层
 * 在真实调用后完成；任何关联字段的实际变化都必须调用 nextSettingsRevision。
 */

export type PermissionComparison = 'tighter' | 'equal' | 'wider' | 'incomparable'

export interface ConfigureContext {
  readonly agent: 'dsh' | 'codex' | 'claude'
  readonly runtimeEpoch: string
  readonly state: 'idle' | 'running' | 'requires_action' | 'starting' | 'unavailable' | 'stopped'
  readonly settingsRevision: number
  readonly current: ConfirmedSettings
  readonly catalog: TunableCatalog
  readonly contentAuthorized: boolean
  readonly pending?: { readonly requestId: string; readonly field: SettingsField }
}

export type ConfigureDecision =
  | { readonly outcome: 'apply' }
  | { readonly outcome: 'no-op' }
  | { readonly outcome: 'reject'; readonly code: WireErrorCode; readonly reason: string }

const PERMISSION_KEYS: ReadonlySet<string> = new Set([
  'approvalPolicy', 'sandbox', 'additionalDirectories', 'rules',
])
const SANDBOX_KEYS: ReadonlySet<string> = new Set(['fileSystem', 'network'])

/** goal objective 的长度上限；超限整体拒绝，不截断后继续。 */
const MAX_GOAL_OBJECTIVE_CHARS = 20_000

function reject(code: WireErrorCode, reason: string): ConfigureDecision {
  return { outcome: 'reject', code, reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && (value as readonly unknown[]).every(item => typeof item === 'string')
}

/** 未知键意味着“完整有效范围”无法比较；不能只比较认识的键后放行。 */
function hasUnknownPermissionKeys(scope: PermissionScope): boolean {
  const record = scope as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!PERMISSION_KEYS.has(key)) return true
  }
  const sandbox = record.sandbox
  if (sandbox === undefined) return false
  if (!isRecord(sandbox)) return true
  for (const key of Object.keys(sandbox)) {
    if (!SANDBOX_KEYS.has(key)) return true
  }
  return false
}

function rankOf(
  ranks: Readonly<Record<string, number>> | undefined,
  id: string,
): number | undefined {
  if (ranks === undefined) return undefined
  const rank = ranks[id]
  return typeof rank === 'number' && Number.isFinite(rank) ? rank : undefined
}

/** 等级只来自 lattice；缺等级的 mode 名称之间不存在被证明的线性顺序。 */
function compareRankedField(
  requested: unknown,
  current: unknown,
  ranks: Readonly<Record<string, number>> | undefined,
): PermissionComparison {
  if (requested === undefined && current === undefined) return 'equal'
  if (requested === undefined || current === undefined) return 'incomparable'
  if (typeof requested !== 'string' || typeof current !== 'string') return 'incomparable'
  const requestedRank = rankOf(ranks, requested)
  const currentRank = rankOf(ranks, current)
  if (requestedRank === undefined || currentRank === undefined) return 'incomparable'
  if (requestedRank === currentRank) return 'equal'
  return requestedRank < currentRank ? 'tighter' : 'wider'
}

function compareFileSystem(
  requestedSandbox: unknown,
  currentSandbox: unknown,
  ranks: Readonly<Record<string, number>> | undefined,
): PermissionComparison {
  if (requestedSandbox === undefined && currentSandbox === undefined) return 'equal'
  // 一侧没有 sandbox 不等于“空范围”：未知与已知不可比较。
  if (requestedSandbox === undefined || currentSandbox === undefined) return 'incomparable'
  if (!isRecord(requestedSandbox) || !isRecord(currentSandbox)) return 'incomparable'
  return compareRankedField(requestedSandbox.fileSystem, currentSandbox.fileSystem, ranks)
}

function compareNetwork(requestedSandbox: unknown, currentSandbox: unknown): PermissionComparison {
  if (requestedSandbox === undefined && currentSandbox === undefined) return 'equal'
  if (requestedSandbox === undefined || currentSandbox === undefined) return 'incomparable'
  if (!isRecord(requestedSandbox) || !isRecord(currentSandbox)) return 'incomparable'
  const requested = requestedSandbox.network
  const current = currentSandbox.network
  if (requested === undefined && current === undefined) return 'equal'
  if (requested === undefined || current === undefined) return 'incomparable'
  if (typeof requested !== 'boolean' || typeof current !== 'boolean') return 'incomparable'
  if (requested === current) return 'equal'
  return requested === false ? 'tighter' : 'wider'
}

/** 集合比较：缺失（未知）与空数组（已知为空）不是同一件事。 */
function compareStringSubset(requested: unknown, current: unknown): PermissionComparison {
  if (requested === undefined && current === undefined) return 'equal'
  if (requested === undefined || current === undefined) return 'incomparable'
  if (!isStringArray(requested) || !isStringArray(current)) return 'incomparable'
  const currentSet = new Set(current)
  if (requested.some(item => !currentSet.has(item))) return 'wider'
  const requestedSet = new Set(requested)
  return requestedSet.size === currentSet.size ? 'equal' : 'tighter'
}

function aggregate(parts: readonly PermissionComparison[]): PermissionComparison {
  if (parts.includes('wider')) return 'wider'
  if (parts.includes('incomparable')) return 'incomparable'
  return parts.every(part => part === 'equal') ? 'equal' : 'tighter'
}

export function comparePermission(
  requested: PermissionScope,
  current: PermissionScope,
  lattice: PermissionLattice | undefined,
): PermissionComparison {
  if (hasUnknownPermissionKeys(requested) || hasUnknownPermissionKeys(current)) return 'incomparable'
  return aggregate([
    compareRankedField(requested.approvalPolicy, current.approvalPolicy, lattice?.approvalPolicy),
    compareFileSystem(requested.sandbox, current.sandbox, lattice?.fileSystem),
    compareNetwork(requested.sandbox, current.sandbox),
    compareStringSubset(requested.additionalDirectories, current.additionalDirectories),
    compareStringSubset(requested.rules, current.rules),
  ])
}

/**
 * 任何关联字段（model/plan/permission/reasoning）的实际确认值变化都必须调用它，
 * 让同一个 settingsRevision 前进；不能只推进被修改的那个字段。
 */
export function nextSettingsRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) return revision
  return revision + 1
}

function decideModel(value: unknown, context: ConfigureContext): ConfigureDecision {
  if (typeof value !== 'string') return reject('unsupported', 'unknown-model')
  const entry = findModel(context.catalog, value)
  if (entry === undefined) return reject('unsupported', 'unknown-model')
  const current = context.current
  if (current.model === value) return { outcome: 'no-op' }

  // 已确认 effort 存在时，新模型的默认 effort 必须可证明不会上调。
  if (current.reasoning !== undefined) {
    const currentRank = current.model === undefined
      ? undefined
      : effortRank(context.catalog, current.model, current.reasoning)
    const defaultRank = entry.defaultEffort === undefined
      ? undefined
      : effortRank(context.catalog, entry.id, entry.defaultEffort)
    if (currentRank === undefined || defaultRank === undefined) {
      return reject('unsupported', 'model-unverifiable')
    }
    if (defaultRank > currentRank) return reject('tighten-only', 'model-widens-effort')
  }

  // 模型默认权限同样是组合检查的一部分，不能只比较 effort。
  if (current.permission !== undefined) {
    if (entry.permission === undefined) return reject('unsupported', 'model-unverifiable')
    const comparison = comparePermission(entry.permission, current.permission, context.catalog.permissionLattice)
    if (comparison === 'wider') return reject('widen-rejected', 'model-widens-permission')
    if (comparison === 'incomparable') return reject('widen-rejected', 'model-permission-incomparable')
  }

  return { outcome: 'apply' }
}

function decideReasoning(value: unknown, context: ConfigureContext): ConfigureDecision {
  if (typeof value !== 'string') return reject('unsupported', 'unknown-effort')
  const { current, catalog } = context
  if (current.model === undefined || current.reasoning === undefined) {
    return reject('unsupported', 'current-unknown')
  }
  const currentRank = effortRank(catalog, current.model, current.reasoning)
  if (currentRank === undefined) return reject('unsupported', 'current-unknown')
  const requestedRank = effortRank(catalog, current.model, value)
  if (requestedRank === undefined) return reject('unsupported', 'unknown-effort')
  if (requestedRank === currentRank) return { outcome: 'no-op' }
  if (requestedRank > currentRank) return reject('tighten-only', 'effort-raise-rejected')
  return { outcome: 'apply' }
}

function decidePermission(value: unknown, context: ConfigureContext): ConfigureDecision {
  if (!isPlainObject(value)) return reject('invalid-args', 'permission-shape-invalid')
  if (context.current.permission === undefined || context.catalog.permissionLattice === undefined) {
    return reject('unsupported', 'permission-unverifiable')
  }
  const comparison = comparePermission(
    value as unknown as PermissionScope,
    context.current.permission,
    context.catalog.permissionLattice,
  )
  if (comparison === 'equal') return { outcome: 'no-op' }
  if (comparison === 'tighter') return { outcome: 'apply' }
  return reject(
    'widen-rejected',
    comparison === 'wider' ? 'permission-widens' : 'permission-incomparable',
  )
}

function decidePlan(value: unknown, context: ConfigureContext): ConfigureDecision {
  if (value !== 'on' && value !== 'off') return reject('invalid-args', 'plan-value-invalid')
  const currentPlan = context.current.plan
  // 没有已确认基线就无法证明“只在收紧”，不能把未知当作 off。
  if (currentPlan === undefined) return reject('unsupported', 'current-unknown')
  if (currentPlan === value) return { outcome: 'no-op' }
  // plan off 会放宽权限：即使目标只是“关 plan”也必须按 widen 拒绝。
  if (value === 'off') return reject('widen-rejected', 'plan-may-widen')
  return { outcome: 'apply' }
}

function decideGoal(
  value: unknown,
  request: ConfigureRequest,
  context: ConfigureContext,
): ConfigureDecision {
  // objective 属于内容型设置：请求级与上下文授权必须同时成立，任一缺失都关闭。
  if (context.contentAuthorized !== true || request.contentAuthorized !== true) {
    return reject('unsupported', 'privacy-readback-unavailable')
  }
  if (context.catalog.readback.goal !== true) return reject('unsupported', 'settings-readback-unavailable')
  // null 表示 clear；实际为空仍须由关联回读确认，决策只放行。
  if (value === null) return { outcome: 'apply' }
  if (!isPlainObject(value)) return reject('invalid-args', 'goal-objective-invalid')
  const objective = value.objective
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    return reject('invalid-args', 'goal-objective-invalid')
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_CHARS) {
    return reject('invalid-args', 'goal-objective-too-large')
  }
  // 决策只带 outcome；objective 不进入返回值，避免被记录或投影。
  return { outcome: 'apply' }
}

export function decideConfigure(
  request: ConfigureRequest,
  context: ConfigureContext,
): ConfigureDecision {
  // 网关顺序固定：任何一条不满足都直接拒绝，绝不隐式排队或先比较字段。
  if (context.agent !== 'codex' && context.agent !== 'claude') {
    return reject('unsupported', 'read-only-in-v0')
  }
  if (context.catalog.agent !== context.agent) {
    return reject('unsupported', 'catalog-agent-mismatch')
  }
  if (request.runtimeEpoch !== context.runtimeEpoch) {
    return reject('stale-connection', 'runtime-epoch-mismatch')
  }
  if (context.state !== 'idle') return reject('writer-busy', 'session-not-idle')
  if (context.pending !== undefined) return reject('conflict', 'configure-pending')
  if (request.expectedRevision !== context.settingsRevision) {
    return reject('revision-conflict', 'settings-revision-mismatch')
  }

  if (!isSettingsField(request.field)) return reject('unsupported', 'unknown-field')
  switch (request.field) {
    case 'skill':
    case 'plugin':
      return reject('unsupported', 'host-config')
    case 'model':
      return decideModel(request.value, context)
    case 'reasoning':
      return decideReasoning(request.value, context)
    case 'permission':
      return decidePermission(request.value, context)
    case 'plan':
      return decidePlan(request.value, context)
    case 'goal':
      return decideGoal(request.value, request, context)
  }
}
