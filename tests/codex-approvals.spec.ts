import { describe, expect, it } from 'vitest'
import { classifyCodexServerRequest, codexResponseFor } from '../src/agents/codex/approvals.ts'

const COMMAND = 'item/commandExecution/requestApproval'
const FILE = 'item/fileChange/requestApproval'
const PERMISSIONS = 'item/permissions/requestApproval'
const USER_INPUT = 'item/tool/requestUserInput'
const ELICITATION = 'mcpServer/elicitation/request'

const ids = (decisions: readonly { id: string; label: string }[]): string[] =>
  decisions.map(decision => decision.id)

describe('codex server request classification', () => {
  it('classifies a command approval with the command string as detail', () => {
    const result = classifyCodexServerRequest(COMMAND, {
      threadId: 't1', itemId: 'i1', command: 'ls -la', cwd: '/tmp',
    })
    expect(result).toEqual({
      kind: 'approval',
      approval: {
        action: '运行命令',
        detail: 'ls -la',
        decisions: [
          { id: 'accept', label: '允许一次' },
          { id: 'decline', label: '拒绝' },
          { id: 'cancel', label: '取消' },
        ],
      },
    })
  })

  it('never stringifies a non-string command or cwd into the card', () => {
    const result = classifyCodexServerRequest(COMMAND, {
      threadId: 't1', itemId: 'i1', command: { shell: 'rm -rf /' }, cwd: '/tmp',
    })
    expect(result.kind).toBe('approval')
    if (result.kind !== 'approval') throw new Error('expected approval')
    expect(result.approval.detail).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('rm -rf')
  })

  it('classifies a file change approval using only a string reason', () => {
    const withReason = classifyCodexServerRequest(FILE, {
      threadId: 't1', itemId: 'i1', reason: 'apply patch',
    })
    expect(withReason).toMatchObject({ kind: 'approval', approval: { action: '修改文件', detail: 'apply patch' } })

    const withoutReason = classifyCodexServerRequest(FILE, { threadId: 't1', itemId: 'i1', reason: null })
    expect(withoutReason.kind).toBe('approval')
    if (withoutReason.kind !== 'approval') throw new Error('expected approval')
    expect(withoutReason.approval.detail).toBeUndefined()
  })

  it('classifies a permission widening request without detail', () => {
    const result = classifyCodexServerRequest(PERMISSIONS, {
      threadId: 't1', itemId: 'i1', cwd: '/tmp', permissions: { network: true },
    })
    expect(result.kind).toBe('approval')
    if (result.kind !== 'approval') throw new Error('expected approval')
    expect(result.approval).toEqual({
      action: '扩大权限',
      decisions: [
        { id: 'accept', label: '允许一次' },
        { id: 'decline', label: '拒绝' },
        { id: 'cancel', label: '取消' },
      ],
    })
  })

  it('intersects availableDecisions with the whitelist without adding accept', () => {
    const result = classifyCodexServerRequest(COMMAND, {
      threadId: 't1', itemId: 'i1', command: 'ls', availableDecisions: ['decline', 'cancel'],
    })
    expect(result.kind).toBe('approval')
    if (result.kind !== 'approval') throw new Error('expected approval')
    expect(ids(result.approval.decisions)).toEqual(['decline', 'cancel'])
  })

  it('ignores amendment objects and unknown strings in availableDecisions', () => {
    const result = classifyCodexServerRequest(COMMAND, {
      threadId: 't1',
      itemId: 'i1',
      command: 'ls',
      availableDecisions: [
        'acceptForSession',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } },
        'accept',
        'unknown',
      ],
    })
    expect(result.kind).toBe('approval')
    if (result.kind !== 'approval') throw new Error('expected approval')
    expect(ids(result.approval.decisions)).toEqual(['accept'])
    expect(JSON.stringify(result)).not.toContain('acceptForSession')
    expect(JSON.stringify(result)).not.toContain('Amendment')
  })

  it('declines instead of creating a card when the intersection is empty', () => {
    const result = classifyCodexServerRequest(COMMAND, {
      threadId: 't1', itemId: 'i1', command: 'ls', availableDecisions: ['acceptForSession'],
    })
    expect(result).toEqual({ kind: 'response', response: { result: { decision: 'decline' } } })
  })

  it('declines when availableDecisions is present but not an array', () => {
    const result = classifyCodexServerRequest(FILE, {
      threadId: 't1', itemId: 'i1', availableDecisions: 'accept',
    })
    expect(result).toEqual({ kind: 'response', response: { result: { decision: 'decline' } } })
  })

  it('never creates a card for malformed approval params', () => {
    const malformed: unknown[] = [
      undefined,
      null,
      'params',
      [],
      { itemId: 'i1' },
      { threadId: '', itemId: 'i1' },
      { threadId: 't1' },
      { threadId: 't1', itemId: '' },
    ]
    for (const params of malformed) {
      expect(classifyCodexServerRequest(COMMAND, params)).toEqual({
        kind: 'response', response: { result: { decision: 'decline' } },
      })
    }
  })

  it('settles requestUserInput with no answers and no card', () => {
    const result = classifyCodexServerRequest(USER_INPUT, {
      threadId: 't1', itemId: 'i1', isBlocking: true, questions: [{ id: 'q1' }],
    })
    expect(result).toEqual({ kind: 'response', response: { result: { answers: {} } } })
    expect(codexResponseFor(USER_INPUT, {}, {
      decision: 'answer', value: { answers: [{ id: 'q1', selected: ['x'] }] },
    })).toEqual({ result: { answers: {} } })
  })

  it('declines MCP elicitation and never accepts it', () => {
    const result = classifyCodexServerRequest(ELICITATION, {
      mode: 'form', message: 'token?', requestedSchema: {},
    })
    expect(result).toEqual({ kind: 'response', response: { result: { action: 'decline' } } })
    expect(codexResponseFor(ELICITATION, {}, {
      decision: 'answer', value: { action: 'accept', content: {} },
    })).toEqual({ result: { action: 'decline' } })
  })

  it('answers unknown server requests with method-not-found', () => {
    expect(classifyCodexServerRequest('item/unknown', {})).toEqual({
      kind: 'response', response: { error: { code: -32601, message: 'method not found' } },
    })
    expect(codexResponseFor('item/unknown', {}, { decision: 'answer', value: 'accept' })).toEqual({
      error: { code: -32601, message: 'method not found' },
    })
  })
})

describe('codex approval responses', () => {
  it('maps accept-once, decline and cancel onto the native decision strings', () => {
    expect(codexResponseFor(COMMAND, {}, { decision: 'answer', value: 'accept' }))
      .toEqual({ result: { decision: 'accept' } })
    expect(codexResponseFor(COMMAND, {}, { decision: 'decline' }))
      .toEqual({ result: { decision: 'decline' } })
    expect(codexResponseFor(FILE, {}, { decision: 'cancel' }))
      .toEqual({ result: { decision: 'cancel' } })
    expect(codexResponseFor(COMMAND, {}, { decision: 'answer', value: 'decline' }))
      .toEqual({ result: { decision: 'decline' } })
  })

  it('never turns another answer value into accept', () => {
    const values: unknown[] = ['acceptForSession', 'allow', { accept: true }, null, 1, ['accept']]
    for (const value of values) {
      expect(codexResponseFor(COMMAND, {}, { decision: 'answer', value }))
        .toEqual({ result: { decision: 'decline' } })
    }
  })

  it('answers a permission request with an empty turn-scoped grant on any decision', () => {
    const grant = { result: { permissions: { fileSystem: null, network: null }, scope: 'turn' } }
    for (const decision of [
      { decision: 'answer', value: 'accept' },
      { decision: 'answer', value: 'acceptForSession' },
      { decision: 'decline' },
      { decision: 'cancel' },
    ] as const) {
      expect(codexResponseFor(PERMISSIONS, {}, decision)).toEqual(grant)
    }
  })
})
