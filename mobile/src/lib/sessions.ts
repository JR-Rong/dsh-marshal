import { sessionTitle, type SessionRow } from './marshal.ts'

export const SESSION_PAGE_SIZE = 40

export function matchSession(row: SessionRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return sessionTitle(row).toLowerCase().includes(needle)
    || row.sessionId.toLowerCase().includes(needle)
    || row.agent.toLowerCase().includes(needle)
}

export function sliceSessions(rows: SessionRow[], query: string, limit: number): {
  shown: SessionRow[]
  total: number
  hasMore: boolean
} {
  const matched = rows.filter((row) => matchSession(row, query))
  const cap = Math.max(0, limit)
  const shown = matched.slice(0, cap)
  return { shown, total: matched.length, hasMore: matched.length > shown.length }
}
