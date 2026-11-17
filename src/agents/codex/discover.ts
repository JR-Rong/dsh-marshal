import type { SyncSessionRow } from '../../adapters/types.ts'
import {
  parseThreadListResponse, parseTurnsListResponse, threadBlank, threadRunning,
  threadUpdatedAtMs, type CodexThread, type CodexTurn,
} from './protocol.ts'

/**
 * 只读发现：清单与历史都走 app-server 的分页接口，不读取内部 SQLite，
 * 也不把第一页当全量。只有遍历到 `nextCursor` 为空的终止页才返回 complete。
 */

export type CodexRequest = <T>(
  method: string,
  params: unknown,
  signal: AbortSignal,
  parse: (value: unknown) => T | undefined,
) => Promise<T>

export const CODEX_MAX_PAGE_SIZE = 100
export const CODEX_DEFAULT_MAX_PAGES = 200

export interface CodexPageOptions {
  readonly pageSize?: number
  readonly maxPages?: number
}

export interface CodexThreadDiscovery {
  readonly threads: readonly CodexThread[]
  readonly complete: boolean
}

export interface CodexTurnPage {
  readonly turns: readonly CodexTurn[]
  readonly nextCursor?: string
  readonly complete: boolean
}

function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CODEX_MAX_PAGE_SIZE
  const size = Math.floor(value)
  return Math.min(CODEX_MAX_PAGE_SIZE, Math.max(1, size))
}

function clampPages(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CODEX_DEFAULT_MAX_PAGES
  return Math.min(CODEX_DEFAULT_MAX_PAGES, Math.max(1, Math.floor(value)))
}

/** 完整分页；重复游标或达到页数上限都返回 unconfirmed，绝不把残缺当全量。 */
export async function listAllThreads(
  request: CodexRequest,
  signal: AbortSignal,
  options: CodexPageOptions = {},
): Promise<CodexThreadDiscovery> {
  const pageSize = clampPageSize(options.pageSize)
  const maxPages = clampPages(options.maxPages)
  const threads: CodexThread[] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < maxPages; page += 1) {
    const response = await request('thread/list', {
      limit: pageSize,
      archived: false,
      ...(cursor === undefined ? {} : { cursor }),
    }, signal, parseThreadListResponse)
    for (const thread of response.data) {
      if (ids.has(thread.id)) continue
      ids.add(thread.id)
      threads.push(thread)
    }
    const next = response.nextCursor
    if (next === undefined) return { threads, complete: true }
    // 同一游标重复出现说明服务端没有前进；继续只会死循环。
    if (cursors.has(next)) return { threads, complete: false }
    cursors.add(next)
    cursor = next
  }
  return { threads, complete: false }
}

/**
 * 历史按回合升序分页。`limit` 是回合页大小（不是事件数）；
 * 单页 `complete` 只在没有下一页时为 true。
 */
export async function listTurnsPage(
  request: CodexRequest,
  params: { readonly threadId: string; readonly cursor?: string; readonly limit?: number },
  signal: AbortSignal,
): Promise<CodexTurnPage> {
  const response = await request('thread/turns/list', {
    threadId: params.threadId,
    itemsView: 'full',
    sortDirection: 'asc',
    limit: clampPageSize(params.limit),
    ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
  }, signal, parseTurnsListResponse)
  const next = response.nextCursor
  return {
    turns: response.data,
    ...(next === undefined ? {} : { nextCursor: next }),
    complete: next === undefined,
  }
}

/** 原生名称或 preview 构造有界标题，交节点隐私层过滤；cwd 不进入索引。 */
export function threadRow(thread: CodexThread): SyncSessionRow {
  const updatedAt = threadUpdatedAtMs(thread)
  return {
    sessionId: thread.id,
    title: (thread.name?.trim() || thread.preview?.trim() || "新会话").replace(/\s+/g, " ").slice(0, 160),
    running: threadRunning(thread),
    updatedAt: updatedAt ?? 0,
    blank: threadBlank(thread),
  }
}
