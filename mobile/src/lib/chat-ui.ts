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

export function shouldTriggerOlderHistory({ scrollTop, prevScrollTop, deltaY = 0, touchPullDy = 0, loading, hasCursor }: {
  scrollTop: number; prevScrollTop?: number; deltaY?: number; touchPullDy?: number; loading: boolean; hasCursor: boolean
}): boolean {
  if (loading || !hasCursor) return false
  return (scrollTop <= 8 && prevScrollTop !== undefined && scrollTop < prevScrollTop)
    || (scrollTop <= 2 && (deltaY < -12 || touchPullDy > 28))
}

export function preserveScrollAnchor(prevScrollHeight: number, nextScrollHeight: number, prevScrollTop: number): number {
  return Math.max(0, prevScrollTop + nextScrollHeight - prevScrollHeight)
}

export function transcriptMessageKey(message: { id: string; role: string }): string {
  return `${message.role}:${message.id}`
}

interface TranscriptMessage {
  id: string
  role: string
  text: string
  at: number
  open: boolean
  endedAt?: number
  snapshotText?: string
  snapshotPrefix?: string
  streamText?: string
  completed?: boolean
}

function splitSnapshotPrefix(snapshot: string, stream: string): string {
  if (!stream || snapshot.startsWith(stream) || stream.startsWith(snapshot)) return ''
  for (let length = Math.min(snapshot.length, stream.length); length > 0; length--) {
    if (snapshot.endsWith(stream.slice(0, length))) return snapshot.slice(0, snapshot.length - length)
  }
  return snapshot
}

function composeTranscriptText(snapshot: string, prefix: string, stream: string): string {
  if (!stream) return snapshot
  if (prefix) return prefix + stream
  if (snapshot && snapshot.startsWith(stream)) return snapshot
  return stream
}

export function appendTranscriptDelta<T extends TranscriptMessage>(message: T, delta: string): T {
  if (message.completed) return message
  const hasStream = message.streamText !== undefined || message.open
  const snapshotText = message.snapshotText ?? (hasStream ? '' : message.text)
  const snapshotPrefix = message.snapshotPrefix ?? (hasStream ? '' : message.text)
  const streamText = (message.streamText ?? (message.open ? message.text : '')) + delta
  return {
    ...message,
    snapshotText,
    snapshotPrefix,
    streamText,
    text: composeTranscriptText(snapshotText, snapshotPrefix, streamText),
    open: true,
    endedAt: undefined,
  }
}

export function mergeTranscriptSnapshot<T extends TranscriptMessage>(
  historyMessages: readonly T[], liveMessages: readonly T[], { prepend = false, liveEvent = false } = {},
): T[] {
  const merged = new Map(liveMessages.map(message => [transcriptMessageKey(message), message]))
  const order = [...merged.keys()]
  const historyKeys = historyMessages.map(transcriptMessageKey)
  const existing = new Set(order)
  let floor = 0
  for (const [index, history] of historyMessages.entries()) {
    const key = historyKeys[index]!
    const live = merged.get(key)
    if (live) {
      if ((history.role === 'assistant' || history.role === 'reason') && !live.completed) {
        if (history.completed) {
          const text = history.text.length >= live.text.length ? history.text : live.text
          merged.set(key, {
            ...live,
            text,
            open: false,
            completed: true,
            endedAt: live.endedAt ?? history.endedAt,
          })
        } else {
          const oldSnapshot = live.snapshotText ?? (live.open ? '' : live.text)
          const snapshotText = !prepend && history.text.length >= oldSnapshot.length ? history.text : oldSnapshot
          const streamText = live.streamText ?? (live.open ? live.text : '')
          const snapshotPrefix = splitSnapshotPrefix(snapshotText, streamText)
          const endedAt = live.open ? undefined : live.endedAt ?? history.endedAt
          merged.set(key, {
            ...live,
            snapshotText,
            snapshotPrefix,
            streamText,
            text: composeTranscriptText(snapshotText, snapshotPrefix, streamText),
            ...(endedAt !== undefined ? { endedAt } : {}),
          })
        }
      } else if (history.role === 'tool' && history.completed && !live.completed) {
        merged.set(key, { ...history, at: live.at })
      }
      floor = Math.max(floor, order.indexOf(key) + 1)
      continue
    }
    // A known remote ID cannot acknowledge a second identical prompt. Older
    // pages or history items older than the local send also cannot acknowledge recent sends.
    const pending = !prepend && history.role === 'user' && !history.id.startsWith('local-')
      ? order.find(candidate => {
        const entry = merged.get(candidate)!
        return entry.role === 'user' && entry.id.startsWith('local-') && entry.text === history.text
          && (liveEvent || history.at >= entry.at)
      }) : undefined
    merged.set(key, history)
    if (pending !== undefined) {
      merged.delete(pending)
      const position = order.indexOf(pending)
      order[position] = key
      floor = Math.max(floor, position + 1)
      continue
    }
    // Shared IDs anchor the server's window. Preserve retained order even when
    // the adapter stamps older pages with their fetch time.
    const nextAnchor = historyKeys.slice(index + 1).find(candidate => existing.has(candidate))
    const ceiling = nextAnchor ? order.indexOf(nextAnchor) : order.length
    let position = floor
    if (!prepend) {
      while (position < ceiling && merged.get(order[position]!)!.at <= history.at) position++
    }
    order.splice(position, 0, key)
    floor = position + 1
  }
  return order.map(key => merged.get(key)!)
}

export function historyPageProgress(cursor: string, nextCursor: string | undefined, completeness: string, visited: ReadonlySet<string>) {
  const stalled = Boolean(nextCursor && (nextCursor === cursor || visited.has(nextCursor)))
  return {
    cursor: stalled ? null : nextCursor || null,
    reachedStart: !nextCursor && completeness === 'complete',
    notice: stalled ? '历史分页未推进，已暂停加载' : !nextCursor && completeness !== 'complete' ? '暂时无法确认更早的历史' : '',
  }
}

export const EFFORT_META: Readonly<Record<string, { label: string; description: string }>> = {
  off: { label: '关闭', description: '直接作答，不额外推理' },
  low: { label: '低', description: '轻量思考，适合简单任务' },
  medium: { label: '中', description: '平衡推理深度和耗时' },
  high: { label: '高', description: '深入推演，适合复杂任务' },
  max: { label: '最高', description: '投入更多时间处理复杂问题' },
}

export function buildEffortSheetOptions(availableEfforts: readonly string[], currentEffort: string) {
  const available = new Set(availableEfforts.filter(Boolean))
  return [...new Set([...Object.keys(EFFORT_META), ...available])].filter(id => available.has(id)).map(id => ({
    id, ...(Object.hasOwn(EFFORT_META, id) ? EFFORT_META[id] : { label: id, description: '' }),
    badge: id === currentEffort ? '当前' : '',
  }))
}

export function formatThoughtSummary(message: { open: boolean; at?: number; endedAt?: number }, _nowMs?: number): string {
  if (message.open) return '正在深度思考…'
  const elapsed = (message.endedAt ?? NaN) - (message.at ?? NaN)
  return Number.isFinite(elapsed) && elapsed > 0
    ? `已深度思考 ${Math.max(1, Math.round(elapsed / 1000))} 秒 ›`
    : '已深度思考 ›'
}
