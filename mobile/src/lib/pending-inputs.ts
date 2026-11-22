import type { InputCard, Target } from './marshal.ts'

type SessionTarget = Target & { sessionId: string }
type Change = { id: string; card?: InputCard }

export function inputTarget(event: Record<string, unknown>): SessionTarget | null {
  const { deviceId, agent, sessionId } = event
  return typeof deviceId === 'string' && typeof agent === 'string' && typeof sessionId === 'string'
    ? { deviceId, agent, sessionId } : null
}

export function inputTargetKey({ deviceId, agent, sessionId }: Target): string {
  return JSON.stringify([deviceId, agent, sessionId])
}

/** Hub resets announce a barrier, not its cards. Keep live mutations received
 * while /inputs snapshots are in flight. */
export function createPendingInputs() {
  const sessions = new Map<string, { target: Target; cards: Map<string, InputCard> }>()
  const snapshots = new Map<string, Map<string, Change>>()
  function apply(cards: Map<string, InputCard>, { id, card }: Change): void {
    if (card) cards.set(id, card)
    else cards.delete(id)
  }
  return {
    cards(target: Target): InputCard[] { return [...(sessions.get(inputTargetKey(target))?.cards.values() ?? [])] },
    waitingCounts(): number[] {
      return [...sessions.values()].map(({ cards }) => [...cards.values()].filter(card => !card.approval).length)
    },
    update(target: Target, id: string, card?: InputCard): void {
      const key = inputTargetKey(target)
      const change = { id, card }
      const cards = sessions.get(key)?.cards ?? new Map<string, InputCard>()
      apply(cards, change)
      if (cards.size) sessions.set(key, { target, cards })
      else sessions.delete(key)
      snapshots.get(key)?.set(id, change)
    },
    remove(target: Target): void {
      sessions.delete(inputTargetKey(target))
      snapshots.delete(inputTargetKey(target))
    },
    beginSnapshot(target: Target): (cards?: InputCard[]) => void {
      const key = inputTargetKey(target)
      const changes = new Map<string, Change>()
      snapshots.set(key, changes)
      return cards => {
        if (snapshots.get(key) !== changes) return
        snapshots.delete(key)
        if (!cards) return // A failed snapshot is not an empty session.
        const next = new Map(cards.map(card => [card.requestId, card]))
        for (const change of changes.values()) apply(next, change)
        if (next.size) sessions.set(key, { target, cards: next })
        else sessions.delete(key)
      }
    },
    knownTargets(): Target[] { return [...sessions.values()].map(({ target }) => target) },
  }
}
