import { describe, expect, it } from 'vitest'
import type { AckFrame, EventFrame, MarshalKind } from '../src/wire/frames.ts'
import { MAX_FRAME_BYTES } from '../src/wire/limits.ts'
import {
  createPrivacyProjector, splitUtf8,
  type AuditInput, type CardProjection, type PrivacyProjector,
} from '../src/node/privacy.ts'

/** 合成哨兵：任何出口出现它都视为泄漏。 */
const SENTINEL = `sk-${'A'.repeat(24)}`
const JWT = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`

function projector(overrides: Partial<Parameters<typeof createPrivacyProjector>[0]> = {}): PrivacyProjector {
  return createPrivacyProjector({
    privacy: 'metadata',
    allowContent: false,
    questionRelay: 'off',
    approvalRelay: 'off',
    allowInteractions: false,
    redaction: [],
    deviceId: 'mac',
    agent: 'dsh',
    nodeEpoch: 'epoch-1',
    now: () => 100,
    ...overrides,
  })
}

function event(kind: MarshalKind, payload: unknown, seq = 1): EventFrame {
  return {
    v: 2, type: 'event', deviceId: 'mac', agent: 'dsh', sessionId: 's1',
    nodeEpoch: 'epoch-1', seq, ts: 10, kind, payload,
  }
}

function ack(result?: unknown, code?: AckFrame['code']): AckFrame {
  return {
    v: 2, type: 'ack', commandId: 'c1', connectionId: 'conn-1', nodeEpoch: 'epoch-1',
    status: 'accepted',
    ...(code === undefined ? {} : { code }),
    ...(result === undefined ? {} : { result }),
  }
}

function expectNoSentinel(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(SENTINEL)
}

describe('privacy projector: metadata', () => {
  it('正文只留字符数，未知字段与 cwd/title 一律丢弃', () => {
    const p = projector()
    const delta = p.event(event('message.delta', { itemId: 'i1', text: `hello ${SENTINEL}`, passthrough: 'x' }))
    expect(delta).toHaveLength(1)
    expect(delta[0]?.payload).toEqual({ itemId: 'i1', chars: `hello ${SENTINEL}`.length })
    expectNoSentinel(delta)

    const updated = p.event(event('session.updated', {
      running: true, updatedAt: 5, cwd: '/home/secret', title: 'Secret title',
      publicAlias: true, ownership: 'self', counts: { turns: 2 }, unknown: SENTINEL,
    }))
    expect(updated[0]?.payload).toEqual({
      running: true, updatedAt: 5, ownership: 'self', counts: { turns: 2 },
    })
    expectNoSentinel(updated)
  })

  it('工具参数值不进入 metadata', () => {
    const p = projector()
    const projected = p.event(event('tool.started', {
      callId: 'call-1', tool: 'bash', status: 'running',
      arguments: { cmd: SENTINEL, cwd: '/home/secret' },
    }))
    expect(projected[0]?.payload).toEqual({ callId: 'call-1', tool: 'bash', status: 'running' })
    expectNoSentinel(projected)
  })

  it('错误只给分类，不带 message/stack', () => {
    const p = projector()
    const projected = p.event(event('error', {
      code: 'agent-crashed', severity: 'error', message: SENTINEL, stack: SENTINEL,
      relatedId: SENTINEL, relatedKind: 'tool.completed',
    }))
    expect(projected[0]?.payload).toEqual({
      code: 'agent-crashed', severity: 'error', relatedKind: 'tool.completed', relatedId: '***',
    })
    expectNoSentinel(projected)
  })
})

describe('privacy projector: content authorization', () => {
  it('node=content 但 hub 未授权时仍按 metadata 投影', () => {
    const p = projector({ privacy: 'content', allowContent: false })
    const projected = p.event(event('message.delta', { itemId: 'i1', text: SENTINEL }))
    expect(projected[0]?.payload).toEqual({ itemId: 'i1', chars: SENTINEL.length })
    expect(p.content).toBe(false)
    expectNoSentinel(projected)
  })

  it('两端同时授权才带正文，并始终执行内置脱敏', () => {
    const p = projector({ privacy: 'content', allowContent: true })
    const projected = p.event(event('message.delta', { itemId: 'i1', text: `key ${SENTINEL} tail` }))
    expect(p.content).toBe(true)
    expect(projected[0]?.payload).toMatchObject({ itemId: 'i1', text: 'key *** tail' })
    expectNoSentinel(projected)
  })

  it('内置模式覆盖 JWT/连接串，配置只能追加', () => {
    const p = projector({ privacy: 'content', allowContent: true, redaction: ['custom-secret'] })
    const projected = p.event(event('message.completed', {
      itemId: 'i1',
      text: `${JWT} postgres://user:pass@db.example/x custom-secret`,
    }))
    expectNoSentinel(projected)
    const text = String((projected[0]?.payload as { text?: string }).text)
    expect(text).not.toContain(JWT)
    expect(text).not.toContain('postgres://')
    expect(text).not.toContain('custom-secret')
  })

  it('深度超限的嵌套参数整体替换为标记', () => {
    let nested: Record<string, unknown> = { secret: SENTINEL }
    for (let index = 0; index < 20; index += 1) nested = { [`l${index}`]: nested }
    const p = projector({ privacy: 'content', allowContent: true })
    const projected = p.event(event('tool.started', {
      callId: 'call-1', tool: 'bash', status: 'running', arguments: nested,
    }))
    expect(JSON.stringify(projected)).toContain('[truncated]')
    expectNoSentinel(projected)
  })

  it('安全显示别名独立于原生标题', () => {
    const p = projector({ privacy: 'content', allowContent: true })
    const visible = p.event(event('session.updated', {
      running: false, updatedAt: 1, title: 'Native title', publicAlias: true,
    }))
    expect(visible[0]?.payload).toMatchObject({ title: 'Native title' })
    const hidden = p.event(event('session.updated', { running: false, updatedAt: 1, title: 'Native title' }))
    expect((hidden[0]?.payload as { title?: string }).title).toBeUndefined()
  })
})

describe('privacy projector: chunking', () => {
  it('按完整 UTF-8 边界分片，每片都不含替换字符', () => {
    let seq = 100
    const p = projector({ privacy: 'content', allowContent: true, nextSeq: () => ++seq })
    const text = '😀中文'.repeat(60_000)
    const chunks = p.event(event('message.delta', { itemId: 'i1', text }))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]?.seq).toBe(1)
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify(chunk), 'utf8')).toBeLessThanOrEqual(MAX_FRAME_BYTES)
      const payload = chunk.payload as { text: string; itemId: string; chunkIndex: number; chunkCount: number }
      expect(payload.itemId).toBe('i1')
      expect(payload.chunkCount).toBe(chunks.length)
      expect(payload.text).not.toContain('\uFFFD')
      expect(Buffer.byteLength(payload.text, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    }
    expect(new Set(chunks.map(chunk => chunk.seq)).size).toBe(chunks.length)
    expectNoSentinel(chunks)
  })

  it('splitUtf8 不拆开多字节字符', () => {
    const text = '😀'.repeat(10)
    const chunks = splitUtf8(text, 5)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every(chunk => !chunk.includes('\uFFFD'))).toBe(true)
  })
})

describe('privacy projector: ack/status', () => {
  it('结果只保留白名单标量，嵌套对象与未知键丢弃', () => {
    const p = projector()
    const projected = p.ack(ack({ accepted: true, sessionId: 's1', nested: { token: SENTINEL }, token: SENTINEL }))
    expect(projected.result).toEqual({ accepted: true, sessionId: 's1' })
    expectNoSentinel(projected)
  })

  it('白名单字符串仍会脱敏', () => {
    const p = projector()
    const projected = p.ack(ack({ status: `next ${SENTINEL}` }))
    expectNoSentinel(projected)
    expect((projected.result as { status: string }).status).toContain('***')
  })

  it('超过 64 KiB 的结果只回分类，不截断正文', () => {
    const p = projector()
    const projected = p.ack(ack({ accepted: true, blob: 'x'.repeat(70 * 1024), text: 'x'.repeat(70 * 1024) }))
    expect(projected.code).toBe('result-too-large')
    expect(projected.result).toBeUndefined()
  })

  it('非法状态与未知 code 归为 unknown', () => {
    const p = projector()
    const projected = p.ack({ ...ack(), status: 'weird' as AckFrame['status'], code: 'made-up' as AckFrame['code'] })
    expect(projected.status).toBe('outcome-unknown')
    expect(projected.code).toBe('unknown')
  })

  it('状态查询结果走同一白名单', () => {
    const p = projector()
    const projected = p.statusResult({
      v: 2, type: 'command.status.result', requestId: 'r1', status: 'accepted',
      result: { accepted: true, cwd: '/home/secret', nested: { token: SENTINEL } },
    })
    expect(projected.result).toEqual({ accepted: true })
    expectNoSentinel(projected)
  })
})

describe('privacy projector: sync rows', () => {
  it('只同步会话标识与运行态，cwd/标题不进入快照', () => {
    const p = projector()
    const row = p.syncRow({
      sessionId: 's1', agent: 'dsh', running: true, updatedAt: 9,
      ownership: 'self', counts: { turns: 1 }, cwd: '/home/secret', title: SENTINEL,
    })
    expect(row).toEqual({
      sessionId: 's1', agent: 'dsh', running: true, updatedAt: 9,
      ownership: 'self', counts: { turns: 1 },
    })
    expectNoSentinel(row)
  })

  it('缺少 sessionId 的行直接丢弃', () => {
    expect(projector().syncRow({ cwd: '/x' })).toBeUndefined()
  })
})

describe('privacy projector: interaction cards', () => {
  const questions = [
    { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
  ]
  const cardInput = {
    kind: 'question' as const,
    requestId: 'q-1',
    sessionId: 's1',
    runtimeEpoch: 'epoch-1',
    expiresAt: 1_000,
    questions,
  }

  it('四种双授权组合', () => {
    const off = projector({ questionRelay: 'off', allowInteractions: true })
    expect(off.card(cardInput)).toEqual({ mode: 'off' })

    const notify = projector({ questionRelay: 'notify', allowInteractions: false })
    const notifyCard = notify.card(cardInput) as Extract<CardProjection, { mode: 'notify' }>
    expect(notifyCard.mode).toBe('notify')
    expect(notifyCard.payload).toMatchObject({
      waitKind: 'question', acceptOnceEligible: false,
    })
    expect(JSON.stringify(notifyCard.payload)).not.toContain('选哪个')

    const denied = projector({ questionRelay: 'remote', allowInteractions: false })
    expect(denied.card(cardInput)).toEqual({ mode: 'off' })

    const remote = projector({ questionRelay: 'remote', allowInteractions: true })
    const remoteCard = remote.card(cardInput)
    expect(remoteCard.mode).toBe('remote')
    if (remoteCard.mode === 'remote') {
      expect(remoteCard.answerable).toBe(true)
      expect(remoteCard.payload).toMatchObject({
        requestId: 'q-1', sessionId: 's1', runtimeEpoch: 'epoch-1', kind: 'question',
        expiresAt: 1_000, acceptOnceEligible: true,
      })
    }
  })

  it('secret 问题降级为无正文等待，不能远答', () => {
    const p = projector({ questionRelay: 'remote', allowInteractions: true })
    const card = p.card({
      ...cardInput,
      questions: [{ id: 'q1', question: '口令？', secret: true, options: [{ label: 'A' }] }],
    })
    expect(card.mode).toBe('remote')
    if (card.mode === 'remote') {
      expect(card.answerable).toBe(false)
      expect(card.reason).toBe('secret-local-only')
      expect(JSON.stringify(card.payload)).not.toContain('口令')
      expect(card.payload.acceptOnceEligible).toBe(false)
    }
  })

  it('重复选项或脱敏歧义使整卡不可答', () => {
    const p = projector({ questionRelay: 'remote', allowInteractions: true })
    const duplicate = p.card({
      ...cardInput,
      questions: [{
        id: 'q1', question: '选哪个？',
        options: [{ label: 'A' }, { label: 'A' }],
      }],
    })
    expect(duplicate.mode).toBe('remote')
    if (duplicate.mode === 'remote') {
      expect(duplicate.answerable).toBe(false)
      expect(duplicate.reason).toBe('redaction-ambiguous')
      expect(duplicate.payload.acceptOnceEligible).toBe(false)
    }

    const masked = p.card({
      ...cardInput,
      questions: [{ id: 'q1', question: `口令 ${SENTINEL}`, options: [{ label: 'A' }] }],
    })
    expect(masked.mode).toBe('remote')
    if (masked.mode === 'remote') {
      expect(masked.answerable).toBe(false)
      expectNoSentinel(masked.payload)
    }
  })

  it('超过 4096 字节的卡片截断为最小卡且不可审批', () => {
    const p = projector({ questionRelay: 'remote', allowInteractions: true })
    const huge = Array.from({ length: 8 }, (_, index) => ({
      id: `q${index + 1}`,
      question: 'x'.repeat(1_000),
      options: [{ label: 'A' }, { label: 'B' }],
    }))
    const card = p.card({ ...cardInput, questions: huge })
    expect(card.mode).toBe('remote')
    if (card.mode === 'remote') {
      expect(card.answerable).toBe(false)
      expect(card.reason).toBe('card-too-large')
      expect(card.payload.acceptOnceEligible).toBe(false)
      expect(card.payload.truncated).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(card.payload), 'utf8')).toBeLessThanOrEqual(4096)
    }
  })

  it('审批卡缺少决策列表时不可远答', () => {
    const p = projector({ approvalRelay: 'remote', allowInteractions: true })
    const card = p.card({
      kind: 'approval', requestId: 'a-1', sessionId: 's1',
      runtimeEpoch: 'epoch-1', expiresAt: 1_000,
      approval: { action: '删除文件' },
    })
    expect(card.mode).toBe('remote')
    if (card.mode === 'remote') {
      expect(card.answerable).toBe(false)
      expect(card.payload.acceptOnceEligible).toBe(false)
    }
  })
})

describe('privacy projector: audit fields', () => {
  it('只输出白名单，正文/答案/额外字段进不来', () => {
    const p = projector()
    const input = {
      operatorId: 'op-1', deviceId: 'mac', agent: 'dsh', sessionId: 's1',
      op: 'prompt', requestId: 'c1', decision: 'accepted', status: 'accepted',
      errorClass: 'unknown', prompt: SENTINEL, answers: [{ selected: [SENTINEL] }],
    } as unknown as AuditInput
    const fields = p.auditFields(input) as Record<string, unknown>
    expect(Object.keys(fields).sort()).toEqual([
      'agent', 'decision', 'deviceId', 'errorClass', 'op', 'operatorId',
      'requestId', 'sessionId', 'status', 'ts',
    ])
    expectNoSentinel(fields)
  })
})
