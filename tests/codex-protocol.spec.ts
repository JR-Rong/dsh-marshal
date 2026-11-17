import { describe, expect, it } from 'vitest'
import { parseTurn } from '../src/agents/codex/protocol.ts'

describe('Codex native turn timestamps', () => {
  it('accepts nullable timestamps from the 0.166.0 turn/start response', () => {
    expect(parseTurn({ id: 'turn-1', status: 'inProgress', items: [], startedAt: null, completedAt: null }))
      .toEqual({ id: 'turn-1', status: 'inProgress', items: [] })
    expect(parseTurn({ id: 'turn-1', status: 'completed', startedAt: 100, completedAt: 102 }))
      .toMatchObject({ startedAt: 100, completedAt: 102 })
  })

  it.each(['startedAt', 'completedAt'])('still rejects malformed %s rather than dropping it', field => {
    for (const value of ['100', false, {}, NaN, Infinity]) {
      expect(parseTurn({ id: 'turn-1', status: 'inProgress', [field]: value })).toBeUndefined()
    }
  })
})
