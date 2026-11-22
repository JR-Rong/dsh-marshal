/** 审批结束时，回合还在跑就只更新活动，不把它关掉。 */
export function livePhaseAfterApproval(running: boolean): { title: string; phase: string; end: boolean } {
  return running
    ? { title: '运行中', phase: 'run', end: false }
    : { title: '已处理', phase: 'done', end: true }
}
