export type LockPhase = 'locked' | 'unlocked'

/** 有应用锁时，进入后台就锁上；回到前台也不会自动解开。 */
export function reduceActivity(
  phase: LockPhase,
  hasLock: boolean,
  active: boolean,
  seenInactive: boolean,
): { phase: LockPhase; seenInactive: boolean } {
  if (!hasLock) return { phase: 'unlocked', seenInactive: false }
  if (!active) return { phase: 'locked', seenInactive: true }
  if (seenInactive) return { phase: 'locked', seenInactive: false }
  return { phase, seenInactive }
}
