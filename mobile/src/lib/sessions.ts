import { sessionTitle, type SessionRow } from './marshal.ts'

export const ALL_DEVICES_ID = '__all__'
export const SESSION_PAGE_SIZE = 60
export const SESSION_PAGE_STEP = 100

const AGENT_ORDER = ['dsh', 'codex', 'claude']

export function sortSessions(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    const timeDiff = (b.updatedAt || 0) - (a.updatedAt || 0)
    if (timeDiff !== 0) return timeDiff
    const runDiff = Number(Boolean(b.running)) - Number(Boolean(a.running))
    if (runDiff !== 0) return runDiff
    return a.sessionId.localeCompare(b.sessionId)
  })
}

export function matchSession(row: SessionRow, query: string, deviceName = ''): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return sessionTitle(row).toLowerCase().includes(needle)
    || row.sessionId.toLowerCase().includes(needle)
    || row.agent.toLowerCase().includes(needle)
    || (deviceName !== '' && deviceName.toLowerCase().includes(needle))
}

function orderedAgentCounts(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort(([a], [b]) => {
    const ia = AGENT_ORDER.indexOf(a)
    const ib = AGENT_ORDER.indexOf(b)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return a.localeCompare(b)
  })
}

export function sliceSessions(
  rows: SessionRow[],
  query: string,
  limit: number,
  agentFilter = '',
  deviceNameOf?: (deviceId: string) => string,
): {
  shown: SessionRow[]
  total: number
  filteredTotal: number
  agentCounts: Array<[string, number]>
  hasMore: boolean
} {
  const matched = sortSessions(
    rows.filter((row) => matchSession(row, query, deviceNameOf ? deviceNameOf(row.deviceId) : '')),
  )
  const counts = new Map<string, number>()
  for (const row of matched) counts.set(row.agent, (counts.get(row.agent) ?? 0) + 1)
  const filtered = agentFilter ? matched.filter((row) => row.agent === agentFilter) : matched
  const cap = Math.max(0, limit)
  const shown = filtered.slice(0, cap)
  return {
    shown,
    total: matched.length,
    filteredTotal: filtered.length,
    agentCounts: orderedAgentCounts(counts),
    hasMore: filtered.length > shown.length,
  }
}
