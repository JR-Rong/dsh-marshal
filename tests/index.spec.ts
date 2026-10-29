import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

describe('plugin module', () => {
  it('导出 name 与 apply', () => {
    expect(plugin.name).toBe('marshal')
    expect(typeof plugin.apply).toBe('function')
  })
})

describe('bundle patch', () => {
  it('通过 insert 条目挂载 dsh-marshal', () => {
    const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
    expect(patch).toContain('insert:')
    expect(patch).toContain('id: dsh-marshal')
  })
})
