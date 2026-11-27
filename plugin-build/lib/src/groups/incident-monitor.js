import { decodeAgentTrace, toolAnomalyCode } from './agent-trace.js';
import { isPermissionBlockedError } from './task-orchestration.js';

const KINDS = ['review-blocked', 'failed', 'tool-anomaly', 'memory-proposal'];
const errorText = error => typeof error === 'string' ? error : [error?.code, error?.message].filter(Boolean).join('：');
const permissionBlocked = error => isPermissionBlockedError(errorText(error)) || error?.code === 'isolation-violation';

export function buildIncidentsSummary({ tasksState, roomRecordsByTask, memorySummary, now = Date.now() } = {}) {
    const items = [];
    const countsByKind = Object.fromEntries(KINDS.map(kind => [kind, 0]));
    const add = (kind, severity, targetType, target, subtitle, createdAt) => {
        if (!target?.id) return;
        items.push({ id: `${kind}:${target.id}`, kind, severity, title: target.title ?? target.id,
            subtitle: String(subtitle ?? '').slice(0, 600), targetType, targetId: target.id,
            createdAt: createdAt ?? target.updatedAt ?? target.createdAt ?? now });
        countsByKind[kind] += 1;
    };
    for (const task of (Array.isArray(tasksState) ? tasksState : tasksState?.tasks ?? [])) {
        if (task.archivedAt != null || task.taskRoom?.closed || task.status === 'done') continue;
        const wf = task.workflow;
        const supplied = roomRecordsByTask instanceof Map ? roomRecordsByTask.get(task.id) : roomRecordsByTask?.[task.id];
        const records = Array.isArray(supplied) ? supplied : task.taskRoom?.records ?? [];
        const batch = records.findLastIndex(record => record.kind === 'batch');
        const currentRun = wf?.runId ?? task.taskRoom?.runId;
        const latest = task.executions?.at(-1);
        // Do not turn old failures into fresh incidents after an operator retries.
        const execution = wf?.runId ? undefined : latest;
        const currentRecords = records.slice(Math.max(0, batch)).filter(record => {
            if (currentRun && record.runId !== currentRun) return false;
            // Plain host reruns can reuse both the room batch and the session.
            const executionSignal = record.kind === 'status' && (record.id?.startsWith('sess-incident:') || record.phase === 'permission-blocked');
            return !executionSignal || execution?.startedAt == null || record.at >= execution.startedAt;
        });
        const errors = [wf?.error, task.error, execution?.error, execution?.code && { code: execution.code }];
        const permissionSignal = currentRecords.findLast(record => record.kind === 'status' && record.phase === 'permission-blocked');
        const permissionBlockAt = task.permissionBlock?.at;
        const persistedBlock = Number.isFinite(permissionBlockAt) && !(latest?.startedAt > permissionBlockAt);
        const blocked = persistedBlock || permissionSignal || wf?.state === 'permission-blocked' || errors.some(permissionBlocked)
            || wf?.error?.includes?.('沙箱隔离限制');
        if (wf?.state === 'review-blocked' || wf?.state === 'waiting' || task.status === 'waiting'
            || (task.status === 'review' && (wf?.reviewReason === 'waiting' || task.reviewReason === 'waiting'))) {
            add('review-blocked', 'warning', 'task', task, wf?.reviewSummary ?? task.reviewSummary ?? '等待人工裁决', wf?.updatedAt);
        }
        if (blocked || wf?.state === 'failed' || (task.status === 'failed' && (!wf || wf.state === 'ready'))) {
            const summary = (persistedBlock && task.permissionBlock.summary) || errors.map(errorText).find(Boolean);
            add('failed', 'critical', 'task', task, summary || (blocked ? '权限或沙箱受阻' : '执行失败'),
                (persistedBlock ? permissionBlockAt : permissionSignal?.at) ?? wf?.updatedAt);
        }
        const signal = currentRecords.findLast(record => {
            if (['user', 'batch'].includes(record.kind)) return false;
            if (toolAnomalyCode(record.phase, record.type, record.code, errorText(record.error))) return true;
            const { trace } = record.kind === 'agent' ? decodeAgentTrace(record.text) : {};
            return (record.kind === 'status' && toolAnomalyCode(record.text))
                || trace?.steps?.some?.(step => toolAnomalyCode(step.label, step.detail));
        });
        const executionSignal = execution && toolAnomalyCode(execution.code, execution.result, errorText(execution.error));
        const workflowSignal = toolAnomalyCode(wf?.errorCode, errorText(wf?.error));
        if (signal || executionSignal || workflowSignal) {
            add('tool-anomaly', 'critical', 'task', task,
                signal?.kind === 'status' ? signal.text : errorText(wf?.error ?? latest?.error) || '工具调用循环或超时',
                signal?.at ?? (executionSignal ? latest.endedAt : wf?.updatedAt));
        }
    }
    for (const proposal of (Array.isArray(memorySummary) ? memorySummary : memorySummary?.proposals ?? [])) {
        if (proposal.status === 'pending' && (proposal.scope == null || proposal.scope === 'global')) {
            add('memory-proposal', 'warning', 'memory-proposal', proposal, '等待审批全局记忆提案', proposal.createdAt);
        }
    }
    items.sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return { totalCount: items.length, criticalCount: items.filter(item => item.severity === 'critical').length, countsByKind, items };
}
