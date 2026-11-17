import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EventFrame } from '../../wire/frames.ts'

/**
 * SDK 消息 / 历史消息 -> marshal 公共事件。
 *
 * 事实来源是 `@anthropic-ai/claude-agent-sdk@0.3.316` 的 `sdk.d.ts`。这里有意用
 * 结构化守卫而不是逐字依赖 SDK 的内部块类型：SDK 会随版本增加消息种类，
 * 未识别的种类一律丢弃（不缓存、不猜测）。
 *
 * 映射原则：
 * - `system/init` 只更新本机状态（原生 session_id/模型/权限），**不产生任何 wire 正文**；
 * - 正文、thinking、工具输入/输出分开成不同 kind，原生 item/call id 保持不变；
 * - `tool_progress` 之类的「运行了 N 毫秒」不是工具输出，不映射（只认 tool_result 与
 *   `input_json_delta`）；
 * - SDK 没有原生 turn id，回合 id 由适配器合成并通过 `context.turnId` 传入。
 */

export interface ClaudeEventMeta {
  readonly deviceId: string
  readonly agent: string
  readonly nodeEpoch: string
  readonly sessionId: string
}

/**
 * 流式块索引 -> 原生 tool_use id。`input_json_delta` 只带 `index`，
 * 所以必须由前面的 `content_block_start` 先记住映射，才能给出 callId。
 *
 * 另外记住当前 assistant 流消息的原生 message id：每条 `stream_event` 都有
 * 自己的 uuid，直接用帧 uuid 做 itemId 会让同一段文本的每个分片换一个 id；
 * `message_start` 里的 message.id 在一次流式回复内稳定。
 */
export interface ClaudeStreamTracker {
  noteMessageStart(event: unknown): void
  noteStart(index: number, block: unknown): void
  callIdFor(index: number): string | undefined
  /** 当前流消息的稳定前缀；没有 message_start 时返回 undefined。 */
  itemBase(): string | undefined
  clear(): void
}

export interface ClaudeMapContext {
  readonly runtimeEpoch: string
  readonly ownership?: string
  /** 适配器为本次活动回合合成的 id；result/state 事件靠它结束回合。 */
  readonly turnId?: string
  readonly stream?: ClaudeStreamTracker
}

type Emit = (kind: EventFrame['kind'], payload: unknown) => void

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function blockList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

export function createClaudeStreamTracker(): ClaudeStreamTracker {
  const callIds = new Map<number, string>()
  let messageKey: string | undefined
  let serial = 0
  return {
    noteMessageStart(event: unknown): void {
      const record = asRecord(event)
      const message = asRecord(record?.message)
      const nativeId = textOf(message?.id)
      if (nativeId !== undefined) {
        messageKey = nativeId
      } else {
        serial += 1
        messageKey = `claude-stream:${serial}`
      }
      callIds.clear()
    },
    noteStart(index: number, block: unknown): void {
      const record = asRecord(block)
      if (record === undefined || record.type !== 'tool_use') return
      const callId = textOf(record.id)
      if (callId === undefined) return
      callIds.set(index, callId)
    },
    callIdFor(index: number): string | undefined {
      return callIds.get(index)
    },
    itemBase(): string | undefined {
      return messageKey
    },
    clear(): void {
      callIds.clear()
      messageKey = undefined
    },
  }
}

function blockIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * 工具结果只取文本块；结构化结果不在这里拼 JSON，避免把未知字段带出适配器。
 * 脱敏/截断由 node 的隐私投影负责。
 */
function toolResultText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  const parts: string[] = []
  for (const block of blockList(value)) {
    const record = asRecord(block)
    if (record === undefined) continue
    const text = textOf(record.text)
    if (text !== undefined) parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** 助手内容块：text -> message.completed，thinking -> reasoning.delta，tool_use -> tool.started。 */
function emitAssistantBlocks(blocks: readonly unknown[], itemBase: string, emit: Emit): void {
  blocks.forEach((block, index) => {
    const record = asRecord(block)
    if (record === undefined) return
    switch (record.type) {
      case 'text': {
        const text = textOf(record.text)
        if (text !== undefined) emit('message.completed', { itemId: `${itemBase}:${index}`, text })
        return
      }
      case 'thinking': {
        const text = textOf(record.thinking)
        if (text !== undefined) emit('reasoning.delta', { itemId: `${itemBase}:${index}`, text })
        return
      }
      case 'tool_use': {
        const callId = textOf(record.id)
        if (callId === undefined) return
        emit('tool.started', {
          callId,
          tool: textOf(record.name) ?? 'tool',
          status: 'running',
          ...(record.input === undefined ? {} : { arguments: record.input }),
        })
        return
      }
      default:
        return
    }
  })
}

/** 用户内容块：只映射 tool_result；用户输入回声/图片等不外发。 */
function emitToolResults(blocks: readonly unknown[], emit: Emit): void {
  for (const block of blocks) {
    const record = asRecord(block)
    if (record === undefined || record.type !== 'tool_result') continue
    const callId = textOf(record.tool_use_id)
    if (callId === undefined) continue
    const text = toolResultText(record.content)
    emit('tool.completed', {
      callId,
      status: record.is_error === true ? 'error' : 'ok',
      ...(text === undefined ? {} : { content: text }),
    })
  }
}

function sessionStatePayload(state: string, context: ClaudeMapContext): Record<string, unknown> {
  return {
    // requires_action 仍在进行中（等待用户），与 Codex 的 active 语义保持一致。
    running: state !== 'idle',
    // 原生状态只说「需要动作」，分不清提问还是审批；先报通用 input，
    // 具体类别由 T05 的 input.requested 卡片决定。
    ...(state === 'requires_action' ? { waitKind: 'input' } : {}),
    ...(context.ownership === undefined ? {} : { ownership: context.ownership }),
  }
}

function resultState(message: Extract<SDKMessage, { type: 'result' }>): 'completed' | 'failed' {
  if (message.subtype !== 'success') return 'failed'
  return message.is_error === true ? 'failed' : 'completed'
}

/**
 * 单条 SDK 消息 -> 事件。`seq`/`ts` 由调用方提供；重复消息的去重由 node 负责，
 * 这里只保证单条消息对应的事件形状。
 */
export function toClaudeEvents(
  message: SDKMessage,
  meta: ClaudeEventMeta,
  nextSeq: () => number,
  context: ClaudeMapContext,
): EventFrame[] {
  const events: EventFrame[] = []
  const emit: Emit = (kind, payload) => {
    events.push({
      v: 2, type: 'event', deviceId: meta.deviceId, agent: meta.agent, sessionId: meta.sessionId,
      nodeEpoch: meta.nodeEpoch, seq: nextSeq(), ts: Date.now(), kind, payload,
    })
  }

  switch (message.type) {
    case 'system': {
      if (message.subtype === 'session_state_changed') {
        emit('session.updated', sessionStatePayload(message.state, context))
      }
      // init 只更新本机状态；permission_denied/task_* 等由 T05 处理，暂不外发。
      return events
    }
    case 'assistant': {
      // 子代理帧不属于主回合；只在主线程上映射，避免把并行子会话混进同一条流。
      if (message.parent_tool_use_id !== null) return events
      const body = asRecord(message.message)
      // 完整消息用原生 message id 作前缀，才能和流式分片（message_start）落到同一个 itemId。
      const itemBase = textOf(body?.id) ?? message.uuid
      emitAssistantBlocks(blockList(body?.content), itemBase, emit)
      return events
    }
    case 'user': {
      if (message.parent_tool_use_id !== null) return events
      // 用户消息多半是我们自己输入的 echo / tool_result 回填：只取工具结果。
      const body = asRecord(message.message)
      emitToolResults(blockList(body?.content), emit)
      return events
    }
    case 'stream_event': {
      if (message.parent_tool_use_id !== null) return events
      emitStreamEvent(message.uuid, asRecord(message.event), context, emit)
      return events
    }
    case 'result': {
      const turnId = context.turnId
      if (turnId === undefined) return events
      emit('turn.completed', {
        turnId,
        state: resultState(message),
        runtimeEpoch: context.runtimeEpoch,
      })
      return events
    }
    default:
      return events
  }
}

function emitStreamEvent(
  uuid: string,
  event: Record<string, unknown> | undefined,
  context: ClaudeMapContext,
  emit: Emit,
): void {
  if (event === undefined) return
  const index = blockIndex(event.index)

  if (event.type === 'message_start') {
    context.stream?.noteMessageStart(event)
    return
  }
  if (event.type === 'content_block_start') {
    // 只记 tool_use id；tool.started 仍由完整 assistant 消息发出，避免重复。
    if (index !== undefined) context.stream?.noteStart(index, event.content_block)
    return
  }
  if (event.type !== 'content_block_delta' || index === undefined) return

  const delta = asRecord(event.delta)
  if (delta === undefined) return
  // 同一段流式回复共用一个原生 message id（message_start），块内再按 index
  // 区分；没有 message_start 时才退回帧 uuid，避免不同分片各自换 id。
  const itemId = `${context.stream?.itemBase() ?? uuid}:${index}`
  switch (delta.type) {
    case 'text_delta': {
      const text = textOf(delta.text)
      if (text !== undefined) emit('message.delta', { itemId, text })
      return
    }
    case 'thinking_delta': {
      const text = textOf(delta.thinking)
      if (text !== undefined) emit('reasoning.delta', { itemId, text })
      return
    }
    case 'input_json_delta': {
      const callId = context.stream?.callIdFor(index)
      const text = textOf(delta.partial_json)
      // 没有 callId 就不能把参数碎片挂到某个工具上，直接丢弃而不是编造 id。
      if (callId === undefined || text === undefined) return
      emit('tool.output', { callId, text })
      return
    }
    default:
      return
  }
}

/**
 * 历史投影：`SessionMessage.message` 是 `unknown`，只提取已知内容块形状。
 *
 * 回合边界是合成的：一条带非 tool_result 内容的 user 消息开启新回合，
 * 其后的 assistant/tool 事件属于它，页末仍未结束的回合按 `completed` 收尾。
 * 回合 id 由消息 uuid（缺省用下标）确定，保证同一会话多次分页读取得到相同 id。
 */
export function historyToEvents(
  messages: readonly SessionMessage[],
  meta: ClaudeEventMeta,
  nextSeq: () => number,
  context: ClaudeMapContext,
): EventFrame[] {
  const events: EventFrame[] = []
  const emit: Emit = (kind, payload) => {
    events.push({
      v: 2, type: 'event', deviceId: meta.deviceId, agent: meta.agent, sessionId: meta.sessionId,
      nodeEpoch: meta.nodeEpoch, seq: nextSeq(), ts: Date.now(), kind, payload,
    })
  }

  let openTurn: string | undefined
  const startTurn = (turnId: string): void => {
    if (openTurn !== undefined) {
      emit('turn.completed', { turnId: openTurn, state: 'completed', runtimeEpoch: context.runtimeEpoch })
    }
    openTurn = turnId
    emit('turn.started', { turnId, state: 'running', runtimeEpoch: context.runtimeEpoch })
  }

  messages.forEach((message, position) => {
    if (message.type === 'system') return
    // 子代理的侧链消息不属于主线程，与实时映射保持同一条规则。
    if (message.parent_tool_use_id !== null) return
    const body = asRecord(message.message)
    const rawContent = body?.content
    const blocks = blockList(rawContent)
    const uuid = typeof message.uuid === 'string' && message.uuid !== '' ? message.uuid : `#${position}`

    if (message.type === 'user') {
      // 历史里的普通输入常是纯字符串（不是内容块数组），同样要开启回合；
      // tool_result-only 的数组消息是上一回合的工具回填，不开新回合。
      const opensTurn = typeof rawContent === 'string'
        ? rawContent.trim() !== ''
        : blocks.some(block => asRecord(block)?.type !== 'tool_result')
      if (opensTurn) startTurn(`claude-turn:history:${uuid}`)
      if (opensTurn) emit('user.message', { itemId: uuid, text: typeof rawContent === 'string' ? rawContent
        : blocks.map(asRecord).filter(part => part?.type === 'text').map(part => part!.text).join('\n') })
      emitToolResults(blocks, emit)
      return
    }

    emitAssistantBlocks(blocks, uuid, emit)
  })

  if (openTurn !== undefined) {
    emit('turn.completed', { turnId: openTurn, state: 'completed', runtimeEpoch: context.runtimeEpoch })
  }
  return events
}
