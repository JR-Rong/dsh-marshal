import {
  existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_MAX_BYTES, createAuditLog, defaultAuditFile } from '../src/node/audit.ts'

const SENTINEL = `sk-${'B'.repeat(24)}`

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-audit-'))
  dirs.push(dir)
  return dir
}

function lines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('audit log', () => {
  it('只写白名单字段，正文/答案/额外对象一律丢弃', () => {
    const dir = tempDir()
    const file = join(dir, 'audit.jsonl')
    const audit = createAuditLog({ file, now: () => 1_000 })
    audit.write({
      operatorId: 'op-1', deviceId: 'mac', agent: 'dsh', sessionId: 's1',
      op: 'prompt', requestId: 'c1', decision: 'accepted', status: 'accepted',
      errorClass: 'unknown',
      prompt: SENTINEL,
      answers: [{ selected: [SENTINEL] }],
      nested: { token: SENTINEL },
    } as unknown as Parameters<typeof audit.write>[0])

    const [entry] = lines(file)
    expect(entry).toEqual({
      ts: 1_000, operatorId: 'op-1', deviceId: 'mac', agent: 'dsh', sessionId: 's1',
      op: 'prompt', requestId: 'c1', decision: 'accepted', status: 'accepted', errorClass: 'unknown',
    })
    expect(JSON.stringify(entry)).not.toContain(SENTINEL)
  })

  it('文件与目录只允许属主读写', () => {
    const dir = tempDir()
    const file = join(dir, 'nested', 'audit.jsonl')
    createAuditLog({ file, now: () => 1 }).write({ op: 'prompt', status: 'accepted' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700)
  })

  it('超过上限单次轮转为 .1，旧文件保留', () => {
    const dir = tempDir()
    const file = join(dir, 'audit.jsonl')
    const audit = createAuditLog({ file, maxBytes: 80, now: () => 1 })
    audit.write({ op: 'first', status: 'accepted', operatorId: 'op-1' })
    audit.write({ op: 'second', status: 'accepted', operatorId: 'op-1' })
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(lines(`${file}.1`).map(entry => entry.op)).toEqual(['first'])
    expect(lines(file).map(entry => entry.op)).toEqual(['second'])
  })

  it('长字段截断而不是写正文', () => {
    const dir = tempDir()
    const file = join(dir, 'audit.jsonl')
    createAuditLog({ file, now: () => 1 }).write({ op: 'x'.repeat(500) })
    const [entry] = lines(file)
    expect(String(entry?.op)).toHaveLength(160)
  })

  it('写失败只告警一次且绝不外抛', () => {
    const dir = tempDir()
    const blocker = join(dir, 'blocked')
    writeFileSync(blocker, 'x')
    const warnings: string[] = []
    const audit = createAuditLog({
      file: join(blocker, 'audit.jsonl'),
      warn: message => warnings.push(message),
    })
    expect(() => audit.write({ op: 'prompt', status: 'accepted' })).not.toThrow()
    expect(() => audit.write({ op: 'prompt', status: 'accepted' })).not.toThrow()
    expect(warnings).toEqual(['marshal: audit-write-failed: cannot append'])
  })

  it('默认路径可由 MARSHAL_AUDIT_FILE 覆盖', () => {
    expect(defaultAuditFile({ MARSHAL_AUDIT_FILE: '/tmp/audit.jsonl' })).toBe('/tmp/audit.jsonl')
    expect(defaultAuditFile({ MARSHAL_AUDIT_FILE: '   ' })).toBe(join(homedir(), '.dsh-marshal', 'audit.jsonl'))
    expect(AUDIT_MAX_BYTES).toBe(5 * 1024 * 1024)
  })
})
