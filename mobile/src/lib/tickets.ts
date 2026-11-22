export const TICKET_TEMPLATES = [
  { id: 'delivery', label: '开发交付', roles: 'Leader + Coder + Reviewer' },
  { id: 'pr-review', label: 'PR 对抗审查', roles: 'Leader + DSH 审查员 + Codex 审查员' },
  { id: 'report', label: '报表与报告', roles: 'Leader + 撰写 + 校核' },
  { id: 'research', label: '技术调研与选型', roles: 'Leader + 调研 + 校核' },
  { id: 'troubleshooting', label: '故障排查', roles: '自由协作' },
] as const

export type TicketFilter = 'all' | 'attention' | 'running' | 'done'
export interface TicketRef { deviceId: string; id: string }
export interface Ticket extends TicketRef {
  title: string
  detail: string
  status: string
  revision: number
  template?: string
  roomId?: string
}

const statusKey = (status: string) => status.trim().toLowerCase()
export function ticketFilter(status: string): Exclude<TicketFilter, 'all'> | undefined {
  switch (statusKey(status)) {
    case 'todo': case 'attention': case 'pending-confirmation': case 'review': case '待确认': return 'attention'
    case 'doing': case 'running': return 'running'
    case 'done': return 'done'
  }
}

const searchKey = (text: string) => text.normalize('NFKC').toLowerCase()
export function filterTickets<T extends Ticket>(tickets: readonly T[], filter: TicketFilter, query: string): T[] {
  const terms = searchKey(query).trim().split(/\s+/).filter(Boolean)
  return tickets.filter(ticket => {
    if (filter !== 'all' && ticketFilter(ticket.status) !== filter) return false
    const label = TICKET_TEMPLATES.find(template => template.id === ticket.template)?.label
    const text = searchKey([ticket.title, ticket.detail, ticket.id, ticket.template, label].join(' '))
    return terms.every(term => text.includes(term))
  })
}

export function ticketStageIndex(status: string): 0 | 1 | 2 | 3 {
  switch (statusKey(status)) {
    case 'doing': case 'running': return 1
    case 'review': return 2
    case 'done': case 'attention': case 'pending-confirmation': case '待确认': return 3
    default: return 0
  }
}

export type DiffLine = { type: 'add' | 'remove' | 'hunk' | 'file' | 'context'; text: string }

/** Bound the rendered UTF-8 text (including line separators); never cut a code point. */
export function parseDiffPreview(detail: string, maxBytes = 48 * 1024): { lines: DiffLine[]; truncated: boolean } {
  const lines: DiffLine[] = []
  const encoder = new TextEncoder()
  const budget = Math.min(48 * 1024, Math.max(0, Math.floor(maxBytes) || 0))
  let used = 0
  let mode: 'diff' | 'files' | null = null
  let fenced = false
  let listedFile = false
  let hunk: { old: number; next: number } | undefined
  for (const match of detail.matchAll(/[^\n]*(?:\n|$)/g)) {
    const raw = match[0]
    if (!raw) break
    let text = raw.replace(/\r?\n$/, '')
    const inHunk = Boolean(hunk && (hunk.old > 0 || hunk.next > 0))
    if (!inHunk && /^\s*```\s*(diff|patch)\s*$/i.test(text)) { mode = 'diff'; fenced = true; hunk = undefined; continue }
    if (!inHunk && /^\s*```\s*$/.test(text)) { mode = null; fenced = false; hunk = undefined; continue }
    let type: DiffLine['type']
    const range = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text)
    if (range) {
      mode = 'diff'; type = 'hunk'
      hunk = { old: Number(range[1] ?? 1), next: Number(range[2] ?? 1) }
    } else if (hunk && (hunk.old > 0 || hunk.next > 0) && /^[+ -]/.test(text)) {
      type = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'remove' : 'context'
      if (type !== 'add') hunk.old--
      if (type !== 'remove') hunk.next--
    } else if (text.startsWith('diff --git ') || /^--- \S/.test(text) && detail.startsWith('+++ ', match.index + raw.length)) {
      mode = 'diff'; type = 'file'; hunk = undefined
    } else if (mode === 'diff' && !hunk && /^(---|\+\+\+) /.test(text)) type = 'file'
    else if (mode === 'diff' && !hunk && text.startsWith('+')) type = 'add'
    else if (mode === 'diff' && !hunk && text.startsWith('-')) type = 'remove'
    else if (mode === 'diff' && (fenced || /^( |\\ |index |(?:new|deleted) file mode )/.test(text))) type = 'context'
    else {
      if (/^\s*(?:#{1,6}\s*)?(?:变更文件(?:列表)?|changed files|files changed)\s*[:：]?\s*$/i.test(text)) {
        mode = 'files'; listedFile = false; continue
      }
      const nameStatus = /^[ACDMRTUXB]\d*\t(.+)$/.exec(text)
      const path = nameStatus?.[1] ?? text.trim().replace(/^(?:[-*+]\s+|\d+\.\s+)/, '').replace(/^`|`$/g, '')
      // The heading scopes the list, not the spelling or extension of its paths.
      if (nameStatus || (mode === 'files' && path && !/^#{1,6}\s/.test(text.trim()))) {
        type = 'file'; text = path; listedFile = true
      } else {
        if (text.trim() || listedFile) mode = null
        continue
      }
    }
    const remaining = budget - used - (lines.length ? 1 : 0)
    if (remaining < 0) return { lines, truncated: true }
    const bytes = encoder.encode(text.slice(0, remaining + 1))
    if (bytes.length > remaining) {
      const prefix = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, remaining), { stream: true })
      if (prefix) lines.push({ type, text: prefix })
      return { lines, truncated: true }
    }
    used += bytes.length + (lines.length ? 1 : 0)
    lines.push({ type, text })
  }
  return { lines, truncated: false }
}

export type TicketNavigation = { view: 'list' } | { view: 'detail' | 'group'; ticket: TicketRef }
export type TicketNavigationAction = { type: 'open'; ticket: TicketRef } | { type: 'enter-group' | 'back' | 'close' }
export function reduceTicketNavigation(state: TicketNavigation, action: TicketNavigationAction): TicketNavigation {
  switch (action.type) {
    case 'open': return { view: 'detail', ticket: action.ticket }
    case 'enter-group': return state.view === 'detail' ? { ...state, view: 'group' } : state
    case 'back': return state.view === 'group' ? { ...state, view: 'detail' } : { view: 'list' }
    case 'close': return { view: 'list' }
  }
}

export function ticketBackAction(sheetOpen: boolean, inTicketGroup: boolean): 'close-sheet' | 'return-to-ticket' | undefined {
  return sheetOpen ? 'close-sheet' : inTicketGroup ? 'return-to-ticket' : undefined
}

export type TicketReceiptState = 'queued' | 'applied' | 'rejected' | 'unconfirmed'
export type TicketWriteState =
  | { phase: 'submitting'; commandId?: undefined; notice?: undefined }
  | { phase: 'refreshing' | 'ready'; commandId?: string; notice?: string }

export const ticketWriteKey = (deviceId: string, taskId?: string) => JSON.stringify([deviceId, taskId ?? null])
export function ticketWriteBlocked(write?: TicketWriteState, receipt?: TicketReceiptState): boolean {
  return Boolean(write && (write.phase !== 'ready' || receipt === 'queued'))
}

/** Lives with the board connection, not with the currently mounted dialog. */
export class TicketWrites {
  private readonly rows = new Map<string, TicketWriteState>()
  get(key: string) { return this.rows.get(key) }
  clear() { this.rows.clear() }
  begin(key: string, receipt?: TicketReceiptState) {
    if (ticketWriteBlocked(this.get(key), receipt)) return undefined
    const attempt = { phase: 'submitting' } as const
    this.rows.set(key, attempt)
    return attempt
  }
  finish(key: string, attempt: TicketWriteState, result: { commandId?: string; notice?: string }) {
    if (this.get(key) === attempt) this.rows.set(key, { ...result, phase: 'refreshing' })
  }
  refreshed() {
    for (const [key, row] of this.rows) {
      if (row.phase === 'refreshing') this.rows.set(key, { ...row, phase: 'ready' })
    }
  }
}
