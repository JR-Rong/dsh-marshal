import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  SDKAssistantMessage, SDKMessage, SDKPartialAssistantMessage, SDKResultSuccess, SDKUserMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  createClaudeStreamTracker, historyToEvents, toClaudeEvents,
  type ClaudeEventMeta, type ClaudeMapContext, type ClaudeStreamTracker,
} from '../src/agents/claude/map.ts'

const meta: ClaudeEventMeta = {
  deviceId: 'device-1',
  agent: 'claude',
  nodeEpoch: 'node-epoch-1',
  sessionId: 'session-1',
}

function counter(): () => number {
  let value = 0
  return () => {
    value += 1
    return value
  }
}

function context(
  turnId: string | null = 'claude-turn:t1',
  stream?: ClaudeStreamTracker,
): ClaudeMapContext {
  return {
    runtimeEpoch: 'epoch-1',
    ownership: 'ours',
    ...(turnId === null ? {} : { turnId }),
    ...(stream === undefined ? {} : { stream }),
  }
}

function assistant(content: unknown[], id?: string): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: (id === undefined
      ? { role: 'assistant', content }
      : { id, role: 'assistant', content }) as SDKAssistantMessage['message'],
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: 'session-1',
  }
}

function user(content: unknown[], parentToolUseId: string | null = null): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content } as SDKUserMessage['message'],
    parent_tool_use_id: parentToolUseId,
    uuid: randomUUID(),
    session_id: 'session-1',
  }
}

function streamEvent(event: Record<string, unknown>): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    event: event as unknown as SDKPartialAssistantMessage['event'],
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: 'session-1',
  }
}

function stateMessage(state: 'idle' | 'running' | 'requires_action'): SDKMessage {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: randomUUID(),
    session_id: 'session-1',
  }
}

function resultMessage(isError = false): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: isError,
    num_turns: 1,
    result: 'done',
    stop_reason: null,
    total_cost_usd: 0,
    usage: {} as SDKResultSuccess['usage'],
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: 'session-1',
  }
}

function historyMessage(
  type: SessionMessage['type'],
  content: unknown,
  uuid: string | undefined = randomUUID(),
): SessionMessage {
  return {
    type,
    uuid: uuid ?? randomUUID(),
    session_id: 'session-1',
    message: { role: type === 'assistant' ? 'assistant' : 'user', content },
    parent_tool_use_id: null,
    parent_agent_id: null,
  }
}

describe('claude message mapping', () => {
  it('maps native run state without inventing idle', () => {
    const events = toClaudeEvents(stateMessage('requires_action'), meta, counter(), context())
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('session.updated')
    expect(events[0]?.payload).toEqual({
      running: true,
      waitKind: 'input',
      ownership: 'ours',
    })

    const idle = toClaudeEvents(stateMessage('idle'), meta, counter(), context())
    expect(idle[0]?.payload).toEqual({ running: false, ownership: 'ours' })
  })

  it('separates text, thinking and tool input with native ids', () => {
    const message = assistant([
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'considering' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
    ])
    const events = toClaudeEvents(message, meta, counter(), context())
    expect(events.map(item => item.kind)).toEqual([
      'message.completed', 'reasoning.delta', 'tool.started',
    ])
    expect(events[0]?.payload).toEqual({ itemId: `${message.uuid}:0`, text: 'hello' })
    expect(events[1]?.payload).toEqual({ itemId: `${message.uuid}:1`, text: 'considering' })
    expect(events[2]?.payload).toEqual({
      callId: 'tool-1', tool: 'Bash', status: 'running', arguments: { command: 'ls' },
    })
  })

  it('maps only tool results from user messages and keeps error status', () => {
    const events = toClaudeEvents(user([
      { type: 'text', text: 'echo' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'a.txt' }] },
      { type: 'tool_result', tool_use_id: 'tool-2', is_error: true, content: 'boom' },
    ]), meta, counter(), context())
    expect(events.map(item => item.kind)).toEqual(['tool.completed', 'tool.completed'])
    expect(events[0]?.payload).toEqual({ callId: 'tool-1', status: 'ok', content: 'a.txt' })
    expect(events[1]?.payload).toEqual({ callId: 'tool-2', status: 'error', content: 'boom' })
  })

  it('binds streamed tool input to the block id recorded at content_block_start', () => {
    const stream = createClaudeStreamTracker()
    const tracked = context('claude-turn:t1', stream)

    stream.noteStart(2, { type: 'tool_use', id: 'tool-9', name: 'Read' })
    const output = toClaudeEvents(streamEvent({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"path":' },
    }), meta, counter(), tracked)
    expect(output.map(item => item.kind)).toEqual(['tool.output'])
    expect(output[0]?.payload).toEqual({ callId: 'tool-9', text: '{"path":' })

    const start = streamEvent({ type: 'message_start', message: { id: 'msg-1' } })
    expect(toClaudeEvents(start, meta, counter(), tracked)).toEqual([])

    const delta = streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hi' },
    })
    const text = toClaudeEvents(delta, meta, counter(), tracked)
    expect(text.map(item => item.kind)).toEqual(['message.delta'])
    // message_start 的原生 message id 让同一段流的每个分片共享 itemId。
    expect(text[0]?.payload).toEqual({ itemId: 'msg-1:0', text: 'hi' })
  })

  it('aligns completed text with the streamed native message id', () => {
    const events = toClaudeEvents(
      assistant([{ type: 'text', text: 'hello' }], 'msg-1'),
      meta, counter(), context(),
    )
    expect(events[0]?.payload).toEqual({ itemId: 'msg-1:0', text: 'hello' })
  })

  it('drops tool input deltas that have no recorded call id', () => {
    const events = toClaudeEvents(streamEvent({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    }), meta, counter(), context('claude-turn:t1', createClaudeStreamTracker()))
    expect(events).toEqual([])
  })

  it('completes the bound turn from a result and ignores stray subagent frames', () => {
    const completed = toClaudeEvents(resultMessage(), meta, counter(), context())
    expect(completed.map(item => item.kind)).toEqual(['turn.completed'])
    expect(completed[0]?.payload).toEqual({
      turnId: 'claude-turn:t1', state: 'completed', runtimeEpoch: 'epoch-1',
    })

    const failed = toClaudeEvents(resultMessage(true), meta, counter(), context())
    expect(failed[0]?.payload).toMatchObject({ state: 'failed' })

    const unbound = toClaudeEvents(resultMessage(), meta, counter(), context(null))
    expect(unbound).toEqual([])

    const subagent = assistant([{ type: 'text', text: 'child' }])
    subagent.parent_tool_use_id = 'tool-parent'
    expect(toClaudeEvents(subagent, meta, counter(), context())).toEqual([])
  })

  it('opens a history turn for plain string user prompts', () => {
    const events = historyToEvents([
      historyMessage('user', 'plain prompt', 'uuid-s'),
      historyMessage('assistant', [{ type: 'text', text: 'reply' }]),
    ], meta, counter(), context(null))
    expect(events.map(item => item.kind)).toEqual([
      'turn.started', 'user.message', 'message.completed', 'turn.completed',
    ])
    expect(events[0]?.payload).toMatchObject({ turnId: 'claude-turn:history:uuid-s' })
  })

  it('synthesizes stable history turns and closes the trailing turn', () => {
    const messages = [
      historyMessage('user', [{ type: 'text', text: 'one' }], 'uuid-a'),
      historyMessage('assistant', [{ type: 'text', text: 'first' }]),
      historyMessage('user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'out' }]),
      historyMessage('user', [{ type: 'text', text: 'two' }], 'uuid-b'),
      historyMessage('assistant', [{ type: 'text', text: 'second' }]),
    ]
    const events = historyToEvents(messages, meta, counter(), context(null))
    expect(events.map(item => item.kind)).toEqual([
      'turn.started', 'user.message', 'message.completed', 'tool.completed',
      'turn.completed', 'turn.started', 'user.message', 'message.completed', 'turn.completed',
    ])
    expect(events[0]?.payload).toMatchObject({ turnId: 'claude-turn:history:uuid-a', state: 'running' })
    expect(events[4]?.payload).toMatchObject({ turnId: 'claude-turn:history:uuid-a', state: 'completed' })
    expect(events[5]?.payload).toMatchObject({ turnId: 'claude-turn:history:uuid-b', state: 'running' })
    expect(events[8]?.payload).toMatchObject({ turnId: 'claude-turn:history:uuid-b', state: 'completed' })
  })
})
