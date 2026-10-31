import type { EventFrame } from '../../wire/frames.ts'
import {
  parseThread, parseThreadItem, parseThreadStatus, parseTurn,
  threadBlank, threadUpdatedAtMs, threadWaitKind,
  type CodexThread, type CodexThreadItem, type CodexTurn,
} from './protocol.ts'

/**
 * 把 Codex app-server 通知与历史回合映射成 marshal 公共事件。
 *
 * 分支以 0.166.0 生成 schema 为事实来源；未列入的 method 不产生事件。
 * 工具参数/输出只填原始值，脱敏/截断完全交给 node 的隐私投影，不在这里
 * 自造第二套白名单。
 */

export interface CodexEventMeta {
  readonly deviceId: string
  readonly agent: string
  readonly nodeEpoch: string
  readonly sessionId: string
}

export interface CodexMapContext {
  readonly runtimeEpoch: string
  readonly ownership?: string
}

type Emit = (kind: EventFrame['kind'], payload: unknown) => EventFrame[]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function turnState(status: string): 'running' | 'completed' | 'failed' | 'interrupted' {
  switch (status) {
    case 'inProgress': return 'running'
    case 'completed': return 'completed'
    case 'interrupted': return 'interrupted'
    default: return 'failed'
  }
}

function toolStatus(status: unknown, fallback: 'running' | 'ok' | 'error'): 'running' | 'ok' | 'error' | 'interrupted' {
  switch (status) {
    case 'inProgress': return 'running'
    case 'completed': return 'ok'
    case 'failed': return 'error'
    case 'declined': return 'interrupted'
    default: return fallback
  }
}

interface ToolDescriptor {
  readonly tool: string
  readonly arguments?: unknown
}

/** 只映射有稳定公共形状的工具项；plan/子代理等留在本机，不伪造通用工具。 */
function toolDescriptor(item: CodexThreadItem): ToolDescriptor | undefined {
  switch (item.type) {
    case 'commandExecution': {
      const command = textOf(item.command)
      return { tool: 'command', ...(command === undefined ? {} : { arguments: { command } }) }
    }
    case 'fileChange':
      return { tool: 'fileChange', arguments: { changes: item.changes } }
    case 'mcpToolCall': {
      const server = textOf(item.server) ?? 'mcp'
      const tool = textOf(item.tool) ?? 'tool'
      return { tool: `${server}.${tool}`, arguments: item.arguments }
    }
    case 'dynamicToolCall':
      return { tool: textOf(item.tool) ?? 'tool', arguments: item.arguments }
    case 'webSearch':
      return { tool: 'webSearch', arguments: { query: item.query } }
    case 'imageGeneration':
      return { tool: 'imageGeneration' }
    case 'collabAgentToolCall':
      return { tool: `collab.${textOf(item.tool) ?? 'tool'}` }
    default:
      return undefined
  }
}

/** 只取文本内容；结构化结果不在这里拼 JSON，避免把未知字段带出适配器。 */
function itemContent(item: CodexThreadItem): unknown {
  switch (item.type) {
    case 'commandExecution':
      return typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined
    case 'mcpToolCall': {
      const result = asRecord(item.result)
      return result?.content
    }
    case 'dynamicToolCall':
      return Array.isArray(item.contentItems) ? item.contentItems : undefined
    case 'webSearch':
      return Array.isArray(item.results) ? item.results : undefined
    default:
      return undefined
  }
}

function reasoningText(item: CodexThreadItem): string | undefined {
  const parts: string[] = []
  for (const field of [item.content, item.summary]) {
    if (!Array.isArray(field)) continue
    for (const entry of field) {
      if (typeof entry === 'string') { parts.push(entry); continue }
      const record = asRecord(entry)
      const text = record === undefined ? undefined : textOf(record.text)
      if (text !== undefined) parts.push(text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

function threadPayload(thread: CodexThread, context: CodexMapContext): Record<string, unknown> {
  const updatedAt = threadUpdatedAtMs(thread)
  const waitKind = threadWaitKind(thread)
  return {
    running: thread.status?.type === 'active',
    blank: threadBlank(thread),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(waitKind === undefined ? {} : { waitKind }),
    ...(context.ownership === undefined ? {} : { ownership: context.ownership }),
  }
}

export function notificationThreadId(method: string, params: unknown): string | undefined {
  const record = asRecord(params)
  if (record === undefined) return undefined
  if (method === 'thread/started') return textOf(asRecord(record.thread)?.id)
  return textOf(record.threadId)
}

function itemStart(item: CodexThreadItem): { kind: EventFrame['kind']; payload: unknown } | undefined {
  const descriptor = toolDescriptor(item)
  if (descriptor === undefined) return undefined
  return {
    kind: 'tool.started',
    payload: {
      callId: item.id,
      tool: descriptor.tool,
      status: 'running',
      ...(descriptor.arguments === undefined ? {} : { arguments: descriptor.arguments }),
    },
  }
}

function itemComplete(item: CodexThreadItem): { kind: EventFrame['kind']; payload: unknown } | undefined {
  if (item.type === 'agentMessage') {
    const text = typeof item.text === 'string' ? item.text : ''
    return { kind: 'message.completed', payload: { itemId: item.id, text } }
  }
  const descriptor = toolDescriptor(item)
  if (descriptor === undefined) return undefined
  const content = itemContent(item)
  return {
    kind: 'tool.completed',
    payload: {
      callId: item.id,
      status: toolStatus(item.status, 'ok'),
      ...(content === undefined ? {} : { content }),
    },
  }
}

/**
 * 通知 -> 事件。`seq` 由调用方分配，重复通知的去重也由调用方负责；
 * 这里只保证单条通知对应的事件形状。
 */
export function toCodexEvents(
  method: string,
  params: unknown,
  meta: CodexEventMeta,
  nextSeq: () => number,
  context: CodexMapContext,
): EventFrame[] {
  const record = asRecord(params)
  if (record === undefined) return []
  const emit: Emit = (kind, payload) => [{
    v: 2, type: 'event', deviceId: meta.deviceId, agent: meta.agent, sessionId: meta.sessionId,
    nodeEpoch: meta.nodeEpoch, seq: nextSeq(), ts: Date.now(), kind, payload,
  }]

  switch (method) {
    case 'thread/started': {
      const thread = parseThread(record.thread)
      return thread === undefined ? [] : emit('session.updated', threadPayload(thread, context))
    }
    case 'thread/status/changed': {
      const status = parseThreadStatus(record.status)
      if (status === undefined) return []
      const waitKind = threadWaitKind({ id: '', status })
      return emit('session.updated', {
        running: status.type === 'active',
        ...(waitKind === undefined ? {} : { waitKind }),
        ...(context.ownership === undefined ? {} : { ownership: context.ownership }),
      })
    }
    case 'turn/started':
    case 'turn/completed': {
      const turn = parseTurn(record.turn)
      if (turn === undefined) return []
      const kind = method === 'turn/started' ? 'turn.started' : 'turn.completed'
      return emit(kind, {
        turnId: turn.id,
        state: method === 'turn/started' ? 'running' : turnState(turn.status),
        runtimeEpoch: context.runtimeEpoch,
      })
    }
    case 'item/started': {
      const item = parseThreadItem(record.item)
      const event = item === undefined ? undefined : itemStart(item)
      return event === undefined ? [] : emit(event.kind, event.payload)
    }
    case 'item/completed': {
      const item = parseThreadItem(record.item)
      const event = item === undefined ? undefined : itemComplete(item)
      return event === undefined ? [] : emit(event.kind, event.payload)
    }
    case 'item/agentMessage/delta': {
      const text = typeof record.delta === 'string' ? record.delta : undefined
      const itemId = textOf(record.itemId)
      if (text === undefined || itemId === undefined) return []
      return emit('message.delta', { itemId, text })
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const text = typeof record.delta === 'string' ? record.delta : undefined
      const itemId = textOf(record.itemId)
      if (text === undefined || itemId === undefined) return []
      return emit('reasoning.delta', { itemId, text })
    }
    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta': {
      const text = typeof record.delta === 'string' ? record.delta : undefined
      const itemId = textOf(record.itemId)
      if (text === undefined || itemId === undefined) return []
      return emit('tool.output', { callId: itemId, text })
    }
    case 'item/mcpToolCall/progress': {
      const text = typeof record.message === 'string' ? record.message : undefined
      const itemId = textOf(record.itemId)
      if (text === undefined || itemId === undefined) return []
      return emit('tool.output', { callId: itemId, text })
    }
    default:
      return []
  }
}

/**
 * 历史回合 -> 事件。历史没有增量，因此只发完成态内容：
 * 消息正文、完整推理文本、工具终态与聚合输出。
 */
export function turnToEvents(
  turn: CodexTurn,
  meta: CodexEventMeta,
  nextSeq: () => number,
  context: CodexMapContext,
): EventFrame[] {
  const events: EventFrame[] = []
  const emit = (kind: EventFrame['kind'], payload: unknown): void => {
    events.push({
      v: 2, type: 'event', deviceId: meta.deviceId, agent: meta.agent, sessionId: meta.sessionId,
      nodeEpoch: meta.nodeEpoch, seq: nextSeq(), ts: Date.now(), kind, payload,
    })
  }
  emit('turn.started', {
    turnId: turn.id,
    state: 'running',
    runtimeEpoch: context.runtimeEpoch,
  })
  for (const item of turn.items ?? []) {
    if (item.type === 'agentMessage') {
      emit('message.completed', {
        itemId: item.id,
        text: typeof item.text === 'string' ? item.text : '',
      })
      continue
    }
    if (item.type === 'reasoning') {
      const text = reasoningText(item)
      if (text !== undefined) emit('reasoning.delta', { itemId: item.id, text })
      continue
    }
    const complete = itemComplete(item)
    if (complete !== undefined) emit(complete.kind, complete.payload)
  }
  emit('turn.completed', {
    turnId: turn.id,
    state: turnState(turn.status),
    runtimeEpoch: context.runtimeEpoch,
  })
  return events
}
