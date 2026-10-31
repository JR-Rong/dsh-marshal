import { describe, expect, it } from 'vitest'
import {
  classifyClaudeTool, claudePermissionResult, type ClaudeClassification,
} from '../src/agents/claude/permissions.ts'

const QUESTIONS_INPUT = {
  questions: [
    {
      question: '用哪个数据库？',
      header: '数据库',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: '默认', preview: 'p' },
        { label: 'SQLite' },
      ],
    },
    {
      question: '启用哪些检查？',
      multiSelect: true,
      options: [{ label: 'lint' }, { label: 'typecheck' }],
    },
  ],
}

function questionClassification(input: unknown = QUESTIONS_INPUT): Extract<ClaudeClassification, { kind: 'question' }> {
  const classification = classifyClaudeTool('AskUserQuestion', input)
  if (classification.kind !== 'question') throw new Error(`expected question, got ${classification.kind}`)
  return classification
}

describe('claude tool classification', () => {
  it('projects AskUserQuestion with stable ids and drops preview', () => {
    const classification = questionClassification()
    expect(classification.questions).toEqual([
      {
        id: 'q1',
        question: '用哪个数据库？',
        multiSelect: false,
        options: [
          { label: 'Postgres', description: '默认' },
          { label: 'SQLite' },
        ],
      },
      {
        id: 'q2',
        question: '启用哪些检查？',
        multiSelect: true,
        options: [{ label: 'lint' }, { label: 'typecheck' }],
      },
    ])
    expect(JSON.stringify(classification.questions)).not.toContain('preview')
    // Claude 的答案按问题文本回填，映射必须是投影 id -> 原始文本。
    expect([...classification.answerKeys]).toEqual([
      ['q1', '用哪个数据库？'],
      ['q2', '启用哪些检查？'],
    ])
  })

  it('fails closed on malformed question inputs', () => {
    const malformed: unknown[] = [
      undefined,
      null,
      'text',
      [],
      {},
      { answers: { q: 'A' }, questions: [{ question: 'q' }] },
      { questions: [] },
      { questions: [{ question: '' }] },
      { questions: [{ question: 'q' }, { question: 'q' }] },
      { questions: [{ question: 'q' }, {}, {}, {}, {}] },
      { questions: [{ question: 'q', multiSelect: 'yes' }] },
      { questions: [{ question: 'q', options: 'A' }] },
      { questions: [{ question: 'q', options: [{ description: 'no label' }] }] },
      { questions: [{ question: 'q', options: [{ label: 'A', description: 1 }] }] },
    ]
    for (const input of malformed) {
      expect(classifyClaudeTool('AskUserQuestion', input)).toEqual({ kind: 'deny' })
    }
  })

  it('treats ExitPlanMode and other tools as approvals', () => {
    expect(classifyClaudeTool('ExitPlanMode', { plan: 'x' })).toEqual({
      kind: 'approval',
      approval: {
        action: '批准计划',
        decisions: [
          { id: 'accept', label: '允许一次' },
          { id: 'decline', label: '拒绝' },
          { id: 'cancel', label: '取消' },
        ],
      },
    })
    const other = classifyClaudeTool('Bash', { command: 'ls' })
    expect(other).toMatchObject({ kind: 'approval', approval: { action: 'Bash' } })
    expect(classifyClaudeTool('', {})).toMatchObject({ kind: 'approval', approval: { action: '工具调用' } })
    // 工具参数不进卡片：审批只表达“是否允许一次”。
    expect(JSON.stringify(other)).not.toContain('ls')
  })
})

describe('claude permission results', () => {
  it('allows a question answer with only the expected updatedInput', () => {
    const classification = questionClassification()
    const result = claudePermissionResult(classification, {
      decision: 'answer',
      value: {
        answers: [
          { id: 'q1', selected: ['Postgres'] },
          { id: 'q2', selected: ['lint', 'typecheck'], custom: '再加 e2e' },
        ],
      },
    })
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: QUESTIONS_INPUT.questions,
        answers: {
          '用哪个数据库？': 'Postgres',
          '启用哪些检查？': '再加 e2e',
        },
      },
    })
    if (result.behavior !== 'allow') throw new Error('expected allow')
    expect('updatedPermissions' in result).toBe(false)
  })

  it('joins multi-select labels with commas when no custom text is given', () => {
    const classification = questionClassification()
    const result = claudePermissionResult(classification, {
      decision: 'answer',
      value: {
        answers: [
          { id: 'q1', selected: ['SQLite'] },
          { id: 'q2', selected: ['lint', 'typecheck'] },
        ],
      },
    })
    if (result.behavior !== 'allow') throw new Error('expected allow')
    expect(result.updatedInput?.answers).toEqual({
      '用哪个数据库？': 'SQLite',
      '启用哪些检查？': 'lint, typecheck',
    })
  })

  it('denies question answers with unknown ids, missing answers or bad shapes', () => {
    const classification = questionClassification()
    const bad: unknown[] = [
      undefined,
      'answer',
      { answers: 'no' },
      { answers: [{ id: 'q9', selected: ['x'] }, { id: 'q2', selected: [] }] },
      { answers: [{ id: 'q1', selected: [] }] },
      { answers: [{ id: 'q1', selected: [1] }, { id: 'q2', selected: [] }] },
      { answers: [{ id: 'q1', selected: [], custom: 9 }, { id: 'q2', selected: [] }] },
      { answers: [{ id: 'q1', selected: [] }, { id: 'q1', selected: [] }] },
    ]
    for (const value of bad) {
      expect(claudePermissionResult(classification, { decision: 'answer', value }))
        .toMatchObject({ behavior: 'deny' })
    }
  })

  it('allows an approved tool once without updatedInput or updatedPermissions', () => {
    const classification = classifyClaudeTool('Bash', { command: 'ls' })
    const result = claudePermissionResult(classification, { decision: 'answer', value: 'accept' })
    expect(result).toEqual({ behavior: 'allow' })
  })

  it('maps decline and cancel to distinct deny results', () => {
    const classification = classifyClaudeTool('Bash', { command: 'ls' })
    expect(claudePermissionResult(classification, { decision: 'decline' })).toEqual({
      behavior: 'deny', message: '已在 marshal 拒绝此操作',
    })
    expect(claudePermissionResult(classification, { decision: 'cancel' })).toEqual({
      behavior: 'deny', message: '已在 marshal 取消此操作', interrupt: true,
    })
  })

  it('always denies an unclassifiable request regardless of the decision', () => {
    const denied = { kind: 'deny' } as const
    for (const decision of [
      { decision: 'answer', value: 'accept' },
      { decision: 'decline' },
      { decision: 'cancel' },
    ] as const) {
      expect(claudePermissionResult(denied, decision)).toEqual({
        behavior: 'deny', message: '无法在 marshal 中表达此原生请求',
      })
    }
  })
})
