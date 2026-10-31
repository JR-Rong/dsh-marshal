import {
  chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync,
  unlinkSync, writeSync, fsyncSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/**
 * 设备表、operator 身份和初始化意图共用同一套受限写入。
 * 契约 §4 要求所有本地写者共用进程间锁，并在锁内重读后再原子提交。
 */

export const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 5_000
const LOCK_DELAYS_MS = [10, 20, 40, 80, 160, 320] as const

export class FileLockError extends Error {
  override readonly name = 'FileLockError'
  readonly code = 'lock-timeout' as const

  constructor(message: string) {
    super(`marshal: lock-timeout: ${message}`)
  }
}

export function sleepSync(ms: number): void {
  // CLI 与同步的装载路径都用同步 API；Atomics.wait 是唯一不阻塞事件循环轮询的
  // 同步睡眠方式，且不需要新增依赖。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export interface LockHandle { release(): void }

/** 原子写入同目录 tmp 后 rename；mode 只在创建时生效，所以 tmp 与目标都要收紧。 */
export function atomicWriteFile(path: string, data: string, mode = 0o600): void {
  ensurePrivateDir(dirname(path))
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', mode)
    writeSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    chmodSync(tmp, mode)
    renameSync(tmp, path)
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 已经关闭或创建失败 */ }
    }
    try { unlinkSync(tmp) } catch { /* tmp 可能从未建立 */ }
    throw error
  }
}

function tryLock(lockPath: string): LockHandle | undefined {
  let fd: number
  try {
    fd = openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw error
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
  } finally {
    closeSync(fd)
  }
  let released = false
  return {
    release() {
      if (released) return
      released = true
      try { unlinkSync(lockPath) } catch { /* 已被 stale 清理 */ }
    },
  }
}

function lockIsStale(lockPath: string, now: () => number): boolean {
  try {
    return now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return false
  }
}

/**
 * `<path>.lock` 以 O_EXCL 创建，拿不到就有限退避重试。
 * 超过 10s 的锁视为崩溃遗留（契约要求可打破），但只删除锁文件本身。
 */
export function withFileLock<T>(path: string, fn: () => T, now: () => number = Date.now): T {
  const lockPath = `${path}.lock`
  ensurePrivateDir(dirname(path))
  const deadline = now() + LOCK_WAIT_MS
  let attempts = 0
  for (;;) {
    const handle = tryLock(lockPath)
    if (handle !== undefined) {
      try { return fn() } finally { handle.release() }
    }
    if (lockIsStale(lockPath, now)) {
      try { unlinkSync(lockPath) } catch { /* 另一写者刚释放 */ }
      continue
    }
    if (now() >= deadline) throw new FileLockError(`timed out waiting for ${lockPath}`)
    const index = Math.min(LOCK_DELAYS_MS.length - 1, attempts)
    const delay = LOCK_DELAYS_MS[index] ?? 10
    attempts += 1
    sleepSync(delay + Math.floor(Math.random() * delay))
  }
}

export function readTextIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
