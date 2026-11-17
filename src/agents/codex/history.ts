import { z } from 'zod'
import { PreCallRejection } from '../../adapters/types.ts'
import type { CodexRequest } from './discover.ts'
import { parseThreadItem, parseTurnsListResponse, type CodexTurn } from './protocol.ts'

// Carry only pagination metadata. A single turn can contain hundreds of MB of
// tool output, so neither the native response nor the relay page loads a whole turn.
const Cursor = z.object({
  session: z.string().min(1),
  turnCursor: z.string().min(1).optional(),
  itemCursor: z.string().min(1).optional(),
  turn: z.object({ id: z.string().min(1), status: z.string().min(1),
    startedAt: z.number().finite().optional(), completedAt: z.number().finite().optional(),
  }).strict().optional(),
}).strict()
const prefix = 'items-v1:'
type CursorState = z.infer<typeof Cursor>

function decode(session: string, cursor?: string): CursorState {
  if (!cursor) return { session }
  try {
    if (!cursor.startsWith(prefix) || cursor.length > 2048) throw Error()
    const state = Cursor.parse(JSON.parse(Buffer.from(cursor.slice(prefix.length), 'base64url').toString()))
    if (state.session !== session || Boolean(state.itemCursor) !== Boolean(state.turn)) throw Error()
    return state
  } catch { throw new PreCallRejection('invalid-args') }
}
function encode(state: CursorState): string {
  const cursor = prefix + Buffer.from(JSON.stringify(state)).toString('base64url')
  if (cursor.length > 2048) throw new RangeError('history cursor too large')
  return cursor
}

export async function listHistoryPage(request: CodexRequest,
  params: { threadId: string; cursor?: string; limit?: number }, signal: AbortSignal,
): Promise<{ turn?: CodexTurn; start: boolean; end: boolean; nextCursor?: string }> {
  const state = decode(params.threadId, params.cursor)
  let turn = state.turn
  let turnCursor = state.turnCursor
  if (!turn) {
    const page = await request('thread/turns/list', {
      threadId: params.threadId, itemsView: 'notLoaded', sortDirection: 'asc', limit: 1,
      ...(turnCursor ? { cursor: turnCursor } : {}),
    }, signal, parseTurnsListResponse)
    if (page.nextCursor && page.nextCursor === turnCursor) throw new Error('nonadvancing history')
    turnCursor = page.nextCursor
    const first = page.data[0]
    if (!first) return { start: false, end: false, ...(turnCursor ? { nextCursor: encode({ session: params.threadId, turnCursor }) } : {}) }
    turn = { id: first.id, status: first.status,
      ...(first.startedAt === undefined ? {} : { startedAt: first.startedAt }),
      ...(first.completedAt === undefined ? {} : { completedAt: first.completedAt }) }
  }
  const turnId = turn.id
  const items = await request('thread/items/list', {
    threadId: params.threadId, turnId, sortDirection: 'asc',
    limit: Math.max(1, Math.min(20, Math.floor(params.limit ?? 20))),
    ...(state.itemCursor ? { cursor: state.itemCursor } : {}),
  }, signal, value => {
    const parsed = z.object({ data: z.array(z.object({ turnId: z.literal(turnId), item: z.unknown() })).max(20),
      nextCursor: z.string().min(1).nullable().optional() }).safeParse(value)
    if (!parsed.success) return undefined
    const data = parsed.data.data.map(entry => parseThreadItem(entry.item))
    if (data.some(item => !item)) return undefined
    return { data: data.filter(item => item !== undefined), nextCursor: parsed.data.nextCursor ?? undefined }
  })
  if (items.nextCursor && items.nextCursor === state.itemCursor) throw new Error('nonadvancing history')
  const next = items.nextCursor
    ? { session: params.threadId, turn, itemCursor: items.nextCursor, ...(turnCursor ? { turnCursor } : {}) }
    : turnCursor ? { session: params.threadId, turnCursor } : undefined
  return { turn: { id: turn.id, status: turn.status, items: items.data,
    ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    ...(turn.completedAt === undefined ? {} : { completedAt: turn.completedAt }) }, start: !state.itemCursor, end: !items.nextCursor,
    ...(next ? { nextCursor: encode(next) } : {}) }
}
