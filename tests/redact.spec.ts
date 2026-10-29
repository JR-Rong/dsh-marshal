import { describe, expect, it } from 'vitest'
import { redact, stripContent } from '../src/node/redact.ts'

describe('redact', () => {
  it('替换嵌套字符串中的敏感片段', () => {
    const input = { a: 'key=sk-testtesttesttest', b: { c: '/home/example/x' }, d: 3 }
    expect(redact(input, [/sk-[a-z]{16}/i, /\/home\/[^/\s"]+/g])).toEqual({
      a: 'key=***', b: { c: '***/x' }, d: 3,
    })
  })

  it('限制递归深度，避免超大对象', () => {
    const deep = { x: { y: { z: { w: 'sk-testtesttesttest' } } } }
    expect(() => redact(deep, [/sk-[a-z]{16}/i])).not.toThrow()
  })

  it('超深子树整体替换，不泄漏深层密钥', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 'sk-testtesttesttest' } } } } } } }
    const result = redact(deep, [/sk-[a-z]{16}/i])
    expect(JSON.stringify(result)).not.toContain('sk-testtesttesttest')
    expect(result).toEqual({ l1: { l2: { l3: { l4: { l5: { l6: '***' } } } } } })
  })
})

describe('stripContent', () => {
  const event = { v: 1, type: 'event', device: 'mac', agent: 'dsh', sessionId: 's1', seq: 1, ts: 't', kind: 'message.delta', payload: { text: 'hello there' } } as const

  it('metadata 档把正文换成字符数', () => {
    const stripped = stripContent(event)
    expect(stripped.payload).toEqual({ chars: 11, redacted: true })
    expect(stripped.kind).toBe('message.delta')
  })

  it('工具参数只留键名', () => {
    const tool = stripContent({ ...event, kind: 'tool.started', payload: { callId: 'c1', name: 'bash', arguments: { cmd: 'ls', cwd: '/x' } } })
    expect(tool.payload).toEqual({ callId: 'c1', name: 'bash', argumentKeys: ['cmd', 'cwd'] })
  })

  it('不碰 session.updated 这类元数据事件', () => {
    const meta = { ...event, kind: 'session.updated', payload: { running: true, updatedAt: 1 } } as const
    expect(stripContent(meta)).toEqual(meta)
  })
})
