export function isActiveBoardStatus(status: string): boolean {
  return status === 'doing' || status === 'attention' || status === 'pending-confirmation'
}

export function computeTabBadges(
  tasks: readonly { status: string }[],
  waitingCounts: readonly number[],
  online: boolean,
): { board: number; sessions: number; home: boolean } {
  return {
    board: tasks.filter((task) => isActiveBoardStatus(task.status)).length,
    sessions: waitingCounts.reduce((total, count) => total + count, 0),
    home: !online,
  }
}

export function formatTabBadge(count: number): string {
  return count <= 0 ? '' : count > 99 ? '99+' : String(count)
}

export function scheduleBoardPoll<T>(
  queued: boolean,
  canRefresh: () => boolean,
  refresh: () => void,
  schedule: (callback: () => void, delay: number) => T,
): T {
  return schedule(() => { if (canRefresh()) refresh() }, queued ? 3_000 : 30_000)
}
