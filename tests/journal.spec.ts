import { randomBytes } from 'node:crypto'
import {
  mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_JOURNAL_CAPACITY, JournalError, openJournal, type Journal, type JournalDomain,
} from '../src/node/journal.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-journal-'))
  dirs.push(dir)
  return dir
}

function paths(): { file: string; keyFile: string; initFile: string } {
  const dir = join(tempDir(), 'state')
  return { file: join(dir, 'journal.json'), keyFile: join(dir, 'journal.key'), initFile: join(dir, 'journal.init') }
}

function domain(idempotencyKey: string, sessionId = 's1'): JournalDomain {
  return {
    operatorId: 'operator-1',
    target: { deviceId: 'mac', agent: 'dsh', sessionId },
    idempotencyKey,
  }
}

function fails(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(JournalError)
    expect((error as JournalError).code).toBe(code)
    return
  }
  throw new Error(`expected JournalError ${code}`)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('journal', () => {
  it('首次运行创建 0600 文件与私有目录', () => {
    const { file, keyFile } = paths()
    const journal = openJournal({ file, keyFile })
    try {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(keyFile).mode & 0o777).toBe(0o600)
      expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700)
      expect(journal.size).toBe(0)
      expect(DEFAULT_JOURNAL_CAPACITY).toBe(10_000)
    } finally {
      journal.close()
    }
  })

  it('admit/lookup/settle 只落盘摘要与元数据', () => {
    const { file, keyFile } = paths()
    const journal = openJournal({ file, keyFile })
    const entry = journal.admit({
      domain: domain('k1'),
      op: 'prompt',
      args: { text: 'TOPSECRET-PROMPT' },
    })
    expect(entry).toMatchObject({
      op: 'prompt', deviceId: 'mac', agent: 'dsh', sessionId: 's1', status: 'admitted',
    })
    expect(entry.payloadDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(journal.lookup(domain('k1'))?.status).toBe('admitted')
    // 同域不同载荷的摘要必须不同（conflict 判定依赖它）。
    expect(journal.digestPayload('prompt', domain('k1').target, { text: 'other' }))
      .not.toBe(entry.payloadDigest)

    journal.settle(domain('k1'), 'accepted')
    expect(journal.lookup(domain('k1'))?.status).toBe('accepted')
    journal.close()

    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('TOPSECRET-PROMPT')
    expect(raw).not.toContain('"text"')
    const reopened = openJournal({ file, keyFile })
    try {
      expect(reopened.lookup(domain('k1'))?.status).toBe('accepted')
      expect(reopened.lookup(domain('k1'))?.payloadDigest).toBe(entry.payloadDigest)
    } finally {
      reopened.close()
    }
  })

  it('启动恢复 admitted → outcome-unknown，pending-confirmation 保持', () => {
    const { file, keyFile } = paths()
    const first = openJournal({ file, keyFile })
    first.admit({ domain: domain('crash'), op: 'prompt', args: { text: 'x' } })
    first.admit({ domain: domain('pending'), op: 'configure', args: { field: 'model', value: 'm' } })
    first.settle(domain('pending'), 'pending-confirmation')
    first.close()

    const recovered = openJournal({ file, keyFile })
    try {
      expect(recovered.lookup(domain('crash'))?.status).toBe('outcome-unknown')
      expect(recovered.lookup(domain('pending'))?.status).toBe('pending-confirmation')
    } finally {
      recovered.close()
    }
    // 恢复结果必须已经持久化，而不是只存在于内存。
    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain('"outcome-unknown"')
  })

  it('journal 损坏或密钥缺失/多出都进入 recovery-required', () => {
    const { file, keyFile } = paths()
    const journal = openJournal({ file, keyFile })
    journal.admit({ domain: domain('k'), op: 'prompt', args: {} })
    journal.close()

    const validJournal = readFileSync(file, 'utf8')
    const validKey = readFileSync(keyFile, 'utf8')

    writeFileSync(file, 'not json')
    fails(() => openJournal({ file, keyFile }).close(), 'recovery-required')
    writeFileSync(file, validJournal)

    unlinkSync(keyFile)
    fails(() => openJournal({ file, keyFile }).close(), 'recovery-required')
    writeFileSync(keyFile, validKey)

    unlinkSync(file)
    fails(() => openJournal({ file, keyFile }).close(), 'recovery-required')
  })

  it('第二个实例无法取得排他锁，close 后释放', () => {
    const { file, keyFile } = paths()
    const first = openJournal({ file, keyFile })
    fails(() => openJournal({ file, keyFile }).close(), 'lock-held')
    first.close()
    const second = openJournal({ file, keyFile })
    second.close()
  })

  it('容量满拒绝新写，未决项永不驱逐', () => {
    const { file, keyFile } = paths()
    let clock = 0
    const journal = openJournal({ file, keyFile, capacity: 1, now: () => clock })
    journal.admit({ domain: domain('unknown'), op: 'prompt', args: {} })
    journal.settle(domain('unknown'), 'outcome-unknown')
    clock += 25 * 60 * 60 * 1000
    fails(() => journal.admit({ domain: domain('new'), op: 'prompt', args: {} }), 'size-limit')
    expect(journal.lookup(domain('unknown'))?.status).toBe('outcome-unknown')
    journal.close()
  })

  it('容量满时只回收超过 24h 的终态', () => {
    const { file, keyFile } = paths()
    let clock = 0
    const journal = openJournal({ file, keyFile, capacity: 2, now: () => clock })
    journal.admit({ domain: domain('a'), op: 'prompt', args: {} })
    journal.settle(domain('a'), 'accepted')
    journal.admit({ domain: domain('b'), op: 'prompt', args: {} })
    journal.settle(domain('b'), 'accepted')
    // 未过保留期：不能为了新写入丢终态。
    fails(() => journal.admit({ domain: domain('c'), op: 'prompt', args: {} }), 'size-limit')

    clock += 25 * 60 * 60 * 1000
    journal.admit({ domain: domain('c'), op: 'prompt', args: {} })
    expect(journal.size).toBe(2)
    expect(journal.lookup(domain('c'))?.status).toBe('admitted')
    journal.close()
  })

  it('MARSHAL_JOURNAL_FILE 指向新临时路径时可直接初始化', () => {
    const dir = tempDir()
    const file = join(dir, 'alt-journal.json')
    const previousFile = process.env.MARSHAL_JOURNAL_FILE
    const previousKey = process.env.MARSHAL_JOURNAL_KEY_FILE
    process.env.MARSHAL_JOURNAL_FILE = file
    delete process.env.MARSHAL_JOURNAL_KEY_FILE
    try {
      const journal = openJournal()
      try {
        expect(journal.file).toBe(file)
        expect(statSync(join(dir, 'journal.key')).isFile()).toBe(true)
      } finally {
        journal.close()
      }
    } finally {
      if (previousFile === undefined) delete process.env.MARSHAL_JOURNAL_FILE
      else process.env.MARSHAL_JOURNAL_FILE = previousFile
      if (previousKey === undefined) delete process.env.MARSHAL_JOURNAL_KEY_FILE
      else process.env.MARSHAL_JOURNAL_KEY_FILE = previousKey
    }
  })

  it('首次初始化先写 0600 标记，指纹与代次同步到 journal 头', () => {
    const { file, keyFile, initFile } = paths()
    const journal = openJournal({ file, keyFile, initFile })
    journal.close()

    expect(statSync(initFile).mode & 0o777).toBe(0o600)
    const marker = JSON.parse(readFileSync(initFile, 'utf8')) as {
      version: number; keyFingerprint: string; generation: number; createdAt: number
    }
    const header = JSON.parse(readFileSync(file, 'utf8')) as {
      keyFingerprint: string; generation: number
    }
    expect(marker.keyFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(header.keyFingerprint).toBe(marker.keyFingerprint)
    expect(marker.generation).toBe(header.generation)
    expect(marker.createdAt).toBeGreaterThan(0)
  })

  it('缺少标记（journal/key 已存在）进入 recovery-required，不静默接管', () => {
    const { file, keyFile, initFile } = paths()
    const journal = openJournal({ file, keyFile, initFile })
    journal.admit({ domain: domain('k'), op: 'prompt', args: {} })
    journal.close()

    unlinkSync(initFile)
    fails(() => openJournal({ file, keyFile, initFile }).close(), 'recovery-required')

    // 标记恢复后删掉 journal：标记存在但 journal 缺失同样拒绝。
    writeFileSync(initFile, JSON.stringify({
      version: 1,
      keyFingerprint: JSON.parse(readFileSync(file, 'utf8')).keyFingerprint,
      generation: 1,
      createdAt: 1,
    }))
    unlinkSync(file)
    fails(() => openJournal({ file, keyFile, initFile }).close(), 'recovery-required')
  })

  it('journal 被旧备份回滚（标记代次更高）进入 recovery-required', () => {
    const { file, keyFile, initFile } = paths()
    const journal = openJournal({ file, keyFile, initFile })
    journal.admit({ domain: domain('a'), op: 'prompt', args: {} })
    const backup = readFileSync(file, 'utf8')
    journal.settle(domain('a'), 'accepted')
    journal.close()

    // 代次继续推进后把更旧的 journal 放回去：不能据此重放旧状态。
    writeFileSync(file, backup)
    fails(() => openJournal({ file, keyFile, initFile }).close(), 'recovery-required')
  })

  it('密钥被替换（指纹不匹配）进入 recovery-required', () => {
    const { file, keyFile, initFile } = paths()
    const journal = openJournal({ file, keyFile, initFile })
    journal.close()

    writeFileSync(keyFile, `${randomBytes(32).toString('base64url')}\n`)
    fails(() => openJournal({ file, keyFile, initFile }).close(), 'recovery-required')
  })

  it('只持久化白名单内的最小结果，重放时原样返回', () => {
    const { file, keyFile, initFile } = paths()
    const journal = openJournal({ file, keyFile, initFile })
    journal.admit({ domain: domain('ok'), op: 'prompt', args: {} })
    journal.settle(domain('ok'), 'accepted', undefined, {
      sessionId: 's1',
      accepted: true,
      revision: 3,
      following: { accepted: false, secret: 'NESTED-SECRET' },
      prompt: 'RESULT-SECRET',
      list: [1, 2],
    })
    journal.admit({ domain: domain('big'), op: 'prompt', args: {} })
    journal.settle(domain('big'), 'accepted', undefined, {
      accepted: true,
      sessionId: 'x'.repeat(5000),
    })
    journal.close()

    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('RESULT-SECRET')
    expect(raw).not.toContain('NESTED-SECRET')

    const reopened = openJournal({ file, keyFile, initFile })
    try {
      expect(reopened.lookup(domain('ok'))?.result).toEqual({
        sessionId: 's1', accepted: true, revision: 3,
        following: { accepted: false },
      })
      // 超过 4096 字节的结果按“无结果”处理。
      expect(reopened.lookup(domain('big'))?.result).toBeUndefined()
    } finally {
      reopened.close()
    }
  })
})
