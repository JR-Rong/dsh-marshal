import { describe, expect, it } from 'vitest'
import { DEPTH_MARKER, redact } from '../src/node/redact.ts'

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
    let deep: Record<string, unknown> = { secret: 'sk-testtesttesttest' }
    for (let index = 0; index < 18; index += 1) deep = { [`l${index}`]: deep }
    const result = redact(deep, [/sk-[a-z]{16}/i])
    expect(JSON.stringify(result)).not.toContain('sk-testtesttesttest')
    expect(JSON.stringify(result)).toContain(DEPTH_MARKER)
  })

  it('键名中的敏感片段也被替换', () => {
    const input = { 'sk-testtesttesttest': 1 }
    const result = redact(input, [/sk-[a-z]{16}/i]) as Record<string, unknown>
    expect(Object.keys(result)).toEqual(['***'])
  })

  it('不因循环引用抛错', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => redact(a, [/sk-[a-z]{16}/i])).not.toThrow()
  })
})
