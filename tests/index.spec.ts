import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

describe('plugin module', () => {
  it('导出 name 与 apply', () => {
    expect(plugin.name).toBe('marshal')
    expect(typeof plugin.apply).toBe('function')
  })
})
