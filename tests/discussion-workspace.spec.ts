import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createWorkspaceLeases } from '../src/discussions/workspace.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))
it('locks canonical overlapping workspaces, releases after work, permits independent directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marshal-workspaces-')); dirs.push(dir)
  mkdirSync(join(dir, 'one')); mkdirSync(join(dir, 'one', 'nested')); mkdirSync(join(dir, 'two'))
  symlinkSync(join(dir, 'one'), join(dir, 'alias'))
  const leases = createWorkspaceLeases(), one = leases.acquire(join(dir, 'one'))
  expect(() => leases.acquire(join(dir, 'alias'))).toThrow('writer-busy')
  expect(() => leases.acquire(join(dir, 'one', 'nested'))).toThrow('writer-busy')
  expect(() => leases.acquire(dir)).toThrow('writer-busy')
  leases.acquire(join(dir, 'two')).release(); one.release()
  leases.acquire(join(dir, 'alias')).release()
})
it('rejects non-existent paths, home/root and credential directories', () => {
  const leases = createWorkspaceLeases()
  for (const dir of ['/', homedir(), join(homedir(), '.codex'), 'relative', '/non-existent-marshal-workspace']) {
    expect(() => leases.acquire(dir)).toThrow('invalid-workspace')
  }
})
