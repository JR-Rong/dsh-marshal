export type SessionCategory = 'single' | 'group' | 'ticketRoom'
interface SessionHints { kind: 'single' | 'group'; ticketRoom?: boolean }

export function categorizeSession(session: SessionHints): SessionCategory {
  return session.ticketRoom ? 'ticketRoom' : session.kind
}
export function filterSessionsByCategory<T extends SessionHints>(sessions: readonly T[], category: SessionCategory): T[] {
  return sessions.filter(session => categorizeSession(session) === category)
}

export type WizardStep = 'host' | 'agent' | 'cwd'
export type WizardState = { mode: 'group' } | {
  mode: 'single'; step: WizardStep; deviceId: string; engineOrAgentId: string; cwd?: string
}
export function initialWizardState(mode: WizardState['mode'] = 'single'): WizardState {
  return mode === 'group' ? { mode } : { mode, step: 'host', deviceId: '', engineOrAgentId: '' }
}
export function validateWizardState(state: WizardState): Partial<Record<'deviceId' | 'engineOrAgentId' | 'cwd', string>> {
  if (state.mode === 'group') return {}
  return {
    ...(!state.deviceId.trim() && { deviceId: '请选择运行主机。' }),
    ...(!state.engineOrAgentId.trim() && { engineOrAgentId: '请选择该主机可用的引擎或智能体。' }),
    ...((state.cwd?.trim().length ?? 0) > 4096 && { cwd: '工作目录不能超过 4096 个字符。' }),
  }
}
export function selectWizardHost(state: WizardState, deviceId: string): WizardState {
  return state.mode === 'single' && state.deviceId !== deviceId
    ? { ...state, step: 'host', deviceId, engineOrAgentId: '', cwd: undefined } : state
}
export function moveWizardStep(state: WizardState, step: WizardStep): WizardState {
  if (state.mode === 'group') return state
  const errors = validateWizardState(state)
  if ((step !== 'host' && errors.deviceId) || (step === 'cwd' && errors.engineOrAgentId)) return state
  return { ...state, step }
}

export const WELCOME_STARTERS = [
  '梳理当前仓库未提交的代码改动',
  '运行最近修改模块的单元测试并汇报结果',
  '检查跨设备记忆同步是否存在冲突',
] as const

export function sessionCenterRoute(category: SessionCategory = 'group') {
  return { view: category === 'single' ? 'sessions' as const : 'groups' as const, category }
}

export function groupBackCategory(view: 'groupRoom' | 'groupNew', category: SessionCategory): 'group' | 'ticketRoom' {
  return view === 'groupRoom' && category === 'ticketRoom' ? 'ticketRoom' : 'group'
}

export function roomRetryId(room: { id: string } | null, requestedId: string | null, busy: boolean): string | null {
  return !room && !busy ? requestedId : null
}

export type CreateAttempt = { key: string; busy: boolean }
export function beginCreateAttempt(keys: Map<string, string>, signature: string, newKey: () => string): CreateAttempt {
  const key = keys.get(signature) ?? newKey()
  keys.set(signature, key)
  return { key, busy: true }
}
export function finishCreateAttempt(keys: Map<string, string>, signature: string, attempt: CreateAttempt, definitive: boolean): CreateAttempt {
  if (definitive && keys.get(signature) === attempt.key) keys.delete(signature)
  return { ...attempt, busy: false }
}
export function canCloseCreateSheet(attempt: CreateAttempt): boolean {
  return !attempt.busy
}

export type HistoryStatus = 'loading' | 'error' | 'ready'
export function isUnconfirmedEmpty(completeness: string, itemCount: number, hasCursor: boolean): boolean {
  return completeness !== 'complete' && itemCount === 0 && !hasCursor
}
export function isWelcomeEmpty(status: HistoryStatus, itemCount: number, messageCount: number, hasCursor: boolean): boolean {
  return status === 'ready' && itemCount === 0 && messageCount === 0 && !hasCursor
}

export function fillWelcomeStarter(input: { value: string; focus(): void }, starter: typeof WELCOME_STARTERS[number]): string {
  input.value = starter
  input.focus()
  return starter
}
