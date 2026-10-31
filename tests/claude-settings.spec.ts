import { describe, expect, it } from 'vitest'
import type { ConfigureRequest, SettingsReadRequest } from '../src/agents/types.ts'
import { createClaudeSettingsPort } from '../src/agents/claude/settings.ts'

function signal(): AbortSignal {
  return new AbortController().signal
}

const READ: SettingsReadRequest = { sessionId: 's1', runtimeEpoch: 'epoch-1', revision: 0 }

function configure(field: string, value: unknown): ConfigureRequest {
  return {
    sessionId: 's1',
    field,
    value,
    expectedRevision: 0,
    runtimeEpoch: 'epoch-1',
    contentAuthorized: true,
  }
}

describe('ClaudeSettingsPort', () => {
  it('readSettings 返回空值，不伪造 current', async () => {
    const port = createClaudeSettingsPort({ runtimeEpoch: 'epoch-1' })
    await expect(port.readSettings(READ, signal())).resolves.toEqual({
      values: [],
      runtimeEpoch: 'epoch-1',
      revision: 0,
    })
  })

  it('任何字段的 configure 都在 SDK 之前以 unsupported 拒绝', async () => {
    const port = createClaudeSettingsPort({ runtimeEpoch: 'epoch-1' })
    const cases: ReadonlyArray<{ readonly field: string; readonly value: unknown }> = [
      { field: 'model', value: 'claude-sonnet' },
      { field: 'reasoning', value: 'high' },
      { field: 'permission', value: { approvalPolicy: 'never' } },
      { field: 'plan', value: 'on' },
      { field: 'goal', value: { objective: 'x' } },
    ]
    for (const entry of cases) {
      await expect(port.configure(configure(entry.field, entry.value), signal()))
        .rejects.toMatchObject({ code: 'unsupported' })
    }
  })

  it('旧 runtimeEpoch 先以 stale-connection 拒绝', async () => {
    const port = createClaudeSettingsPort({ runtimeEpoch: 'epoch-1' })
    await expect(port.readSettings({ ...READ, runtimeEpoch: 'old' }, signal()))
      .rejects.toMatchObject({ code: 'stale-connection' })
    await expect(port.configure({ ...configure('goal', { objective: 'x' }), runtimeEpoch: 'old' }, signal()))
      .rejects.toMatchObject({ code: 'stale-connection' })
  })
})
