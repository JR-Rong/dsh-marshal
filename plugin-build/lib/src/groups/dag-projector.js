import { decodeAgentTrace } from './agent-trace.js';
import { extractPatchTouchedFiles, parsePatchArtifactHeader } from './patch-store.js';
import { ROLE_LABELS } from './task-plans.js';

const STAGES = {
    intake: ['需求立项', 'owner'], assignment: ['编排分工', 'marshal'],
    designing: ['方案设计', 'leader'], coding: ['编码实施', 'coder'],
    'codex-coding': ['Codex 编码辅助', 'codexCoding'], 'development-patch': ['开发补丁', 'artifact'],
    'dev-reviewing': ['代码审查', 'reviewer'], 'codex-review': ['Codex 审查辅助', 'codexReview'],
    guidance: ['指导同步', 'owner'], revise: ['返工', 'owner'], summarizing: ['总结交付', 'leader'],
    handoff: ['交接执行', 'leader'], selecting: ['选择编排', 'leader'], material: ['读取审查材料', 'marshal'],
    reviewing: ['独立审查', 'reviewer'], 'cross-check': ['同行复核', 'reviewer'],
    review: ['待确认', 'marshal'], failed: ['执行失败', 'marshal'], execution: ['任务执行', 'agent'],
};
const AUXILIARY = new Set(['codex-coding', 'codex-review']);
const TERMINAL = new Set(['failed', 'interrupted', 'permission-blocked', 'review-blocked', 'cancelled', 'done']);
const isMarshalNotice = record => record?.kind === 'status' && record.actor === 'Marshal' &&
    !(record.requestId && AUXILIARY.has(recordedPhase(record)));

function recordedPhase(record) {
    const phase = record.phase;
    if (record.kind === 'user') {
        if (phase === 'brief') return 'intake';
        if (phase === 'guidance') return phase;
        if (phase === 'revision' || phase === 'revise') return 'revise';
        return undefined;
    }
    if (record.kind === 'batch') return ['revise', 'retry', 'reassign'].includes(phase) ? 'revise' : undefined;
    if (phase === 'coding' && record.kind === 'status' && /返工|退回 Coder/.test(record.text ?? '')) return 'revise';
    if (phase === 'coding-assistant') return 'codex-coding';
    if (phase === 'review-assistant') return 'codex-review';
    return Object.hasOwn(STAGES, phase) ? phase : undefined;
}

function project(task, roomRecords) {
    const workflow = task.workflow ?? {};
    const records = [...(roomRecords.length ? roomRecords : task.taskRoom?.records ?? [])].sort((a, b) =>
        (a.seq != null && b.seq != null) ? a.seq - b.seq : (a.at ?? 0) - (b.at ?? 0));
    const entries = [];
    const requests = new Map();
    let batch = 0;
    let round = 1;
    let runId;
    let assignment;
    let reworkPending = false;
    const add = (phase, id, extra = {}) => {
        const [label, role] = STAGES[phase];
        const node = { id, phase, label, role, agentName: null, model: null, reasoning: null,
            status: 'recorded', sessionId: null, durationMs: null, tokens: null, summary: null,
            patchDigest: null, diffFiles: [], logs: [], batch, round, runId: runId ?? null, ...extra };
        entries.push(node);
        return node;
    };
    add('intake', 'intake', { summary: task.title ?? null, startedAt: task.createdAt ?? null, status: 'done' });
    for (const [i, record] of records.entries()) {
        if (record.kind === 'batch' || (record.runId && record.runId !== runId)) {
            batch += 1;
            round = 1;
            runId = record.runId;
            assignment = undefined;
            reworkPending = false;
        }
        const phase = recordedPhase(record);
        if (!phase) continue;
        const last = entries.at(-1);
        if (phase === 'revise' && entries.some(node => node.batch === batch && node.round === round && node.phase === 'coding')) reworkPending = true;
        const codingRound = reworkPending && (phase === 'coding' || phase === 'codex-coding') ? round + 1 : round;
        if (codingRound !== round && (record.kind === 'agent' || (phase === 'codex-coding' && record.requestId))) {
            round = codingRound;
            reworkPending = false;
        }
        const { text, trace } = record.kind === 'agent' ? decodeAgentTrace(record.text) : { text: record.text };
        if (phase === 'assignment') {
            try { assignment = JSON.parse(text); } catch { /* Older rooms have no structured assignment. */ }
        }
        const request = AUXILIARY.has(phase) && record.requestId ? `${batch}/${round}/${phase}/${record.requestId}` : undefined;
        const actor = record.actor ?? null;
        const notice = isMarshalNotice(record);
        const node = phase === 'intake' && batch <= 1 ? entries[0] : (request && requests.get(request)) ||
            (!request && last.phase === phase && last.batch === batch && last.round === codingRound && last.agentName === actor
                && isMarshalNotice(last.logs[0]) === notice
                && phase !== 'guidance' && phase !== 'revise' && phase !== 'development-patch' ? last :
                add(phase, `${phase}:${record.id ?? record.seq ?? i}`, { agentName: actor, round: codingRound,
                    ...(notice && ['leader', 'coder', 'reviewer', 'codexCoding', 'codexReview'].includes(STAGES[phase][1]) ? { role: 'marshal' } : {}),
                    startedAt: record.startedAt ?? record.at ?? null, requestId: request ? record.requestId : undefined }));
        if (request) requests.set(request, node);
        const cfg = assignment?.agentConfigs?.[node.role] ?? (runId === workflow.runId
            ? workflow.plan?.agentConfigs?.[node.role] ?? workflow.agentConfigs?.[node.role] : undefined);
        const plannedModel = AUXILIARY.has(phase) ? assignment?.codex?.[phase === 'codex-coding' ? 'coding' : 'review'] : undefined;
        const invokedModel = AUXILIARY.has(phase) && /^已请求子 Agent ([^（\s]+)/.exec(text ?? '')?.[1];
        node.model = trace?.model ?? record.model ?? (invokedModel || cfg?.model || (plannedModel !== 'auto' ? plannedModel : null)) ?? node.model;
        const invokedReasoning = AUXILIARY.has(phase) && /（思考：([^）]+)）/.exec(text ?? '')?.[1];
        node.reasoning = record.reasoning ?? (invokedReasoning || cfg?.reasoningEffort) ?? node.reasoning;
        node.durationMs = trace?.durationMs ?? record.durationMs ?? node.durationMs;
        node.tokens = trace?.usage ?? record.tokens ?? node.tokens;
        if (!notice) node.sessionId = record.sessionId ?? node.sessionId;
        node.logs.push({ ...record, text, ...(trace ? { trace } : {}) });
        if (record.kind === 'agent') node.status = 'done';
        else if (AUXILIARY.has(phase)) node.status = /未完成/.test(text ?? '') ? 'failed' : node.status;
        else if (phase === 'failed') node.status = 'failed';
        else if (phase === 'review') node.status = 'review';
        if (record.endedAt != null || (AUXILIARY.has(phase) && ['done', 'failed'].includes(node.status))) node.endedAt = record.endedAt ?? record.at;
        if (text) node.summary = text.slice(0, 600);
        if (phase === 'development-patch') {
            const artifact = parsePatchArtifactHeader(text);
            node.patchDigest = artifact?.meta.digest ?? record.ref ?? null;
            node.diff = artifact?.body ?? text;
            node.diffFiles = [...new Set([...(artifact?.meta.files ?? []), ...extractPatchTouchedFiles(node.diff)])];
        }
    }
    if (!workflow.runId && !workflow.phase) {
        for (const [index, run] of (task.executions ?? []).entries()) {
            if (!run) continue;
            add('execution', 'execution:' + (run.id ?? index), { startedAt: run.startedAt ?? null,
                status: run.result === 'cancelled' ? 'cancelled' : ['failed', 'interrupted'].includes(run.result) || run.error
                    ? 'failed' : run.endedAt != null ? 'done' : 'running',
                sessionId: run.sessionId ?? null, endedAt: run.endedAt ?? null,
                durationMs: run.startedAt != null && run.endedAt != null ? run.endedAt - run.startedAt : null,
                summary: run.summary ?? run.error ?? null });
        }
    }
    const currentStages = entries.filter(node => node.runId === (workflow.runId ?? null) && node.phase !== 'intake');
    const lastStage = currentStages.findLast(node => !['guidance', 'revise'].includes(node.phase));
    if (workflow.state === 'handed-off' && workflow.sessionId) {
        // The workflow confirms the handoff is active, but its status message
        // is not an executor turn and must not carry the destination session.
        const phase = Object.hasOwn(STAGES, workflow.phase) ? workflow.phase : 'handoff';
        const role = phase !== 'handoff' ? STAGES[phase][1] : (workflow.plan?.codeWork ? 'coder' : (workflow.plan ? 'leader' : 'agent'));
        const expectedActor = role === 'leader' ? workflow.leaderName ?? null : assignment?.roles?.[ROLE_LABELS[role]] ?? null;
        const shortSess = String(workflow.sessionId).slice(-12);
        const execution = currentStages.findLast(node => (node.phase === 'handoff' || node.phase === phase) &&
            !node.logs.some(isMarshalNotice) && node.logs.some(record => record.kind === 'agent') &&
            node.endedAt == null &&
            (node.sessionId === workflow.sessionId || (node.sessionId == null && (
                node.logs.some(r => typeof r.id === 'string' && (r.id.startsWith('sess-msg:' + shortSess + ':') || r.id.startsWith('sess-end:' + shortSess + ':'))) ||
                !expectedActor || !node.agentName || node.agentName === expectedActor
            ))));
        const handoff = execution ?? add(phase, `handoff:${workflow.runId ?? 'current'}`, { role,
            runId: workflow.runId ?? null,
            agentName: expectedActor });
        handoff.sessionId = workflow.sessionId;
        handoff.role = role;
        handoff.status = 'running';
    } else if (workflow.phase && Object.hasOwn(STAGES, workflow.phase) && !TERMINAL.has(workflow.state)) {
        const lastExecution = currentStages.findLast(node => !['guidance', 'revise', 'assignment'].includes(node.phase));
        // A child call occupies the current phase until it returns; don't add a phantom parent turn.
        const childPhase = ({ coding: 'codex-coding', 'dev-reviewing': 'codex-review' })[workflow.phase];
        const [, role] = STAGES[workflow.phase];
        const activeRound = reworkPending && workflow.phase === 'coding' ? round + 1 : round;
        // Marshal's stage handoff is evidence of the transition, not an executor turn.
        const marshalNotice = lastExecution?.logs.some(isMarshalNotice);
        const active = lastExecution && !marshalNotice && lastExecution.round === activeRound &&
            lastExecution.endedAt == null && ['recorded', 'running'].includes(lastExecution.status)
            && (lastExecution.phase === workflow.phase || lastExecution.phase === childPhase)
            ? lastExecution : add(workflow.phase, `active:${workflow.runId ?? 'current'}:${workflow.phase}:${batch}:${activeRound}`, {
                runId: workflow.runId ?? null, round: activeRound,
                agentName: role === 'leader' ? workflow.leaderName ?? null : assignment?.roles?.[ROLE_LABELS[role]]
                    ?? currentStages.findLast(node => node.phase === workflow.phase && node.round === activeRound && node.status === 'done')?.agentName ?? null,
            });
        active.status = 'running';
    }
    const development = workflow.development;
    if (development?.digest && !currentStages.some(node => node.patchDigest === development.digest)) {
        add('development-patch', `patch:${workflow.runId ?? 'current'}:${development.digest}`, {
            patchDigest: development.digest, runId: workflow.runId ?? null,
        });
    }
    if (workflow.reportId && !currentStages.some(node => node.phase === 'summarizing')) {
        add('summarizing', `report:${workflow.reportId}`, { runId: workflow.runId ?? null, reportId: workflow.reportId,
            summary: workflow.reviewSummary ?? null, status: workflow.state === 'review-blocked' ? 'review' : 'done' });
    }
    if (lastStage && TERMINAL.has(workflow.state)) {
        if (workflow.state !== 'done') lastStage.status = workflow.state;
        else if (lastStage.status === 'recorded') lastStage.status = 'done';
        if (lastStage.phase !== 'development-patch') lastStage.summary = workflow.reviewSummary ?? workflow.error ?? lastStage.summary;
    }
    const layers = [];
    const recorded = entries.filter(node => node.phase !== 'execution');
    const executions = entries.filter(node => node.phase === 'execution').sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
    // Merge the plain execution start times without reordering any room records.
    const ordered = [recorded[0]];
    let executionIndex = 0;
    for (const node of recorded.slice(1)) {
        while (executionIndex < executions.length && (executions[executionIndex].startedAt ?? Infinity) < (node.startedAt ?? Infinity)) {
            ordered.push(executions[executionIndex++]);
        }
        ordered.push(node);
    }
    ordered.push(...executions.slice(executionIndex));
    for (const node of ordered) {
        const previous = layers.at(-1);
        // Development currently awaits child calls sequentially. Only positive overlap
        // of distinct recorded auxiliary invocations warrants a parallel layer.
        const overlaps = previous?.nodes.every(other => node.requestId && other.requestId && node.requestId !== other.requestId
            && other.phase === node.phase && other.batch === node.batch && other.round === node.round
            && Number.isFinite(other.startedAt) && Number.isFinite(node.startedAt)
            && Number.isFinite(other.endedAt) && Number.isFinite(node.endedAt)
            && Math.max(node.startedAt, other.startedAt) < Math.min(node.endedAt, other.endedAt));
        if (overlaps) {
            previous.type = 'parallel';
            previous.nodes.push(node);
        } else layers.push({ id: 'layer:' + node.id, label: node.label, type: 'single', nodes: [node] });
    }
    return { taskId: task.id, layers };
}

export function projectTaskDag(task, roomRecords = []) {
    const dag = project(task, roomRecords);
    for (const layer of dag.layers) layer.nodes = layer.nodes.map(({ diff, logs, ...node }) => ({
        ...node, logs: logs.map(({ id, kind, at, seq, text }) => ({ id, kind, at, seq, text: text?.slice(0, 240) })),
    }));
    return dag;
}

export function getTaskDagNodeDetail(task, roomRecords = [], nodeId) {
    return project(task, roomRecords).layers.flatMap(layer => layer.nodes).find(node => node.id === nodeId);
}
