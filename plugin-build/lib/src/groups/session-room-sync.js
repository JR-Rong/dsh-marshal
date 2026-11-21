import { encodeAgentTrace, sanitizeUsage } from './agent-trace.js';

function joinTail(parts, maxChars = 9000) {
    if (!Array.isArray(parts) || parts.length === 0) return '';
    const joined = parts.join('\n\n').trim();
    if (!joined) return '';
    return joined.length <= maxChars ? joined : '…' + joined.slice(-(maxChars - 1));
}

function summarizeToolArgs(name, rawArgs) {
    let args = rawArgs;
    if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs); } catch { args = undefined; }
    }
    if (!args || typeof args !== 'object') return String(name || 'tool');
    const hint = args.toolSummary || args.description || args.file_path || args.path || args.pattern || args.query || args.command || args.CommandLine || '';
    const compact = String(hint).replace(/\s+/g, ' ').trim().slice(0, 150);
    return compact ? `${name}: ${compact}` : String(name || 'tool');
}

function addEventUsage(acc, rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') return acc;
    const rawIn = typeof rawUsage.inputTokens === 'number' && Number.isFinite(rawUsage.inputTokens) ? rawUsage.inputTokens : 0;
    const rawOut = typeof rawUsage.outputTokens === 'number' && Number.isFinite(rawUsage.outputTokens) ? rawUsage.outputTokens : 0;
    const cacheRead = typeof rawUsage.cacheReadTokens === 'number' && Number.isFinite(rawUsage.cacheReadTokens) ? rawUsage.cacheReadTokens : 0;
    const cacheWrite = typeof rawUsage.cacheWriteTokens === 'number' && Number.isFinite(rawUsage.cacheWriteTokens) ? rawUsage.cacheWriteTokens : 0;
    const reasoning = typeof rawUsage.reasoningTokens === 'number' && Number.isFinite(rawUsage.reasoningTokens) ? rawUsage.reasoningTokens : 0;
    const stepIn = typeof rawUsage.totalTokens === 'number' && rawUsage.totalTokens === rawIn + rawOut
        ? rawIn
        : rawIn + cacheRead + cacheWrite;
    const stepOut = rawOut;
    const stepTotal = typeof rawUsage.totalTokens === 'number' && rawUsage.totalTokens >= stepIn + stepOut
        ? rawUsage.totalTokens
        : stepIn + stepOut;
    if (stepTotal <= 0 && stepIn <= 0 && stepOut <= 0) return acc;
    const prev = acc ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0 };
    return {
        inputTokens: prev.inputTokens + stepIn,
        outputTokens: prev.outputTokens + stepOut,
        totalTokens: prev.totalTokens + stepTotal,
        reasoningTokens: prev.reasoningTokens + reasoning,
    };
}

/**
 * Inspects a resident DSH session (e.g. `handed-off` ordinary ticket or plain
 * superagent session), persists completed assistant replies with full thinking,
 * tool-step, and token-usage traces into the ticket room, settles `handed-off`
 * workflows when the turn completes, and returns a live in-flight bubble while active.
 */
export async function syncResidentSessionToRoom({
    surface, rooms, room, sessionId, actor, runId, workflowState, onTurnCompleted,
}) {
    if (!surface || typeof surface.history !== 'function' || !rooms || !room || !sessionId) {
        return undefined;
    }
    let historyPage;
    let activeTurnInfo;
    try {
        [historyPage, activeTurnInfo] = await Promise.all([
            surface.history({ sessionId, limit: 80 }, AbortSignal.timeout(3500)),
            typeof surface.activeTurn === 'function'
                ? Promise.resolve(surface.activeTurn(sessionId)).catch(() => undefined)
                : Promise.resolve(undefined),
        ]);
    } catch {
        return undefined;
    }
    const events = Array.isArray(historyPage?.events)
        ? [...historyPage.events].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
        : [];
    if (events.length === 0) return undefined;

    let maxTurn = 0;
    let lastUserIdx = -1;
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const t = ev?.data?.turn;
        if (typeof t === 'number' && t > maxTurn) maxTurn = t;
        if (ev?.type === 'user/message' || ev?.type === 'turn/start') lastUserIdx = i;
    }
    const turnEvents = lastUserIdx >= 0
        ? events.slice(lastUserIdx)
        : (maxTurn > 0 ? events.filter(ev => !ev?.data?.turn || ev.data.turn === maxTurn) : events);

    let currentStep = 0;
    let turnStartedAt;
    let turnEnd;
    let cumulativeUsage;
    const thinkingParts = [];
    const steps = [];
    const stepByCallId = new Map();
    const ptcChildrenByRoot = new Map();
    const assistantMessages = [];

    for (const ev of turnEvents) {
        if (!ev || typeof ev !== 'object') continue;
        const data = ev.data ?? {};
        if (typeof ev.timestamp === 'number' && !turnStartedAt) turnStartedAt = ev.timestamp;
        if (typeof data.step === 'number' && data.step > currentStep) currentStep = data.step;
        if (ev.type === 'turn/start' || ev.type === 'step/start') {
            turnEnd = undefined;
            if (typeof data.step === 'number') currentStep = Math.max(currentStep, data.step);
        }
        if (ev.type === 'assistant/message') {
            cumulativeUsage = addEventUsage(cumulativeUsage, data.usage ?? data.message?.usage);
            const content = Array.isArray(data.message?.content) ? data.message.content : [];
            const rText = content
                .filter(p => p && (p.type === 'reasoning' || p.type === 'thinking') && typeof p.text === 'string' && p.text.trim())
                .map(p => p.text.trim())
                .join('\n');
            if (rText) {
                thinkingParts.push((currentStep > 0 ? `[第 ${currentStep} 步] ` : '') + rText);
            }
            const vText = content
                .filter(p => p && p.type === 'text' && typeof p.text === 'string' && p.text.trim())
                .map(p => p.text.trim())
                .join('\n\n');
            if (vText && Number.isSafeInteger(ev.seq)) {
                assistantMessages.push({
                    seq: ev.seq,
                    text: vText,
                    thinking: joinTail(thinkingParts, 9000),
                    steps: steps.map(s => ({ ...s })).slice(-20),
                    stepCount: currentStep,
                    usage: sanitizeUsage(cumulativeUsage),
                });
            }
        } else if (ev.type === 'tool/ptc-dispatch-start') {
            const subId = String(data.subCallId || data.rootCallId || ('ptc-' + steps.length));
            const rootId = String(data.rootCallId || '');
            const stepObj = {
                id: subId,
                label: (currentStep > 0 ? `#${currentStep} ` : '') + summarizeToolArgs(data.name || 'bash', data.arguments),
                status: 'running',
            };
            steps.push(stepObj);
            stepByCallId.set(subId, stepObj);
            if (rootId) {
                const parent = stepByCallId.get(rootId);
                if (parent && parent.rawName === 'run_code') {
                    const idx = steps.indexOf(parent);
                    if (idx !== -1) steps.splice(idx, 1);
                }
                const list = ptcChildrenByRoot.get(rootId) ?? [];
                list.push(stepObj);
                ptcChildrenByRoot.set(rootId, list);
            }
        } else if (ev.type === 'tool/ptc-dispatch') {
            const subId = String(data.subCallId || '');
            const hit = stepByCallId.get(subId);
            if (hit) hit.status = 'done';
        } else if (ev.type === 'tool/call') {
            const callId = String(data.callId || ('call-' + steps.length));
            const name = String(data.name || 'tool');
            const stepObj = {
                id: callId,
                rawName: name,
                label: (currentStep > 0 ? `#${currentStep} ` : '') + summarizeToolArgs(name, data.arguments),
                status: 'running',
            };
            steps.push(stepObj);
            stepByCallId.set(callId, stepObj);
        } else if (ev.type === 'tool/result') {
            const callId = String(data.message?.toolCallId || '');
            const failed = data.message?.isError === true;
            const hit = stepByCallId.get(callId);
            if (hit) hit.status = failed ? 'failed' : 'done';
            for (const child of ptcChildrenByRoot.get(callId) ?? []) {
                if (child.status === 'running') child.status = failed ? 'failed' : 'done';
            }
        } else if (ev.type === 'turn/end') {
            turnEnd = {
                seq: ev.seq,
                reason: typeof data.reason?.kind === 'string' ? data.reason.kind : 'completed',
            };
        }
    }

    const speaker = actor || '执行智能体';
    const shortSess = String(sessionId).slice(-12);
    const cleanUsage = sanitizeUsage(cumulativeUsage);

    if (!room.closed) {
        for (const msg of assistantMessages) {
            const detId = `sess-msg:${shortSess}:${msg.seq}`;
            if (rooms.hasEvent?.(room.id, detId)) continue;
            try {
                await rooms.append(room.id, {
                    id: detId,
                    kind: 'agent',
                    ...(runId ? { runId } : {}),
                    actor: speaker,
                    phase: 'handoff',
                    text: encodeAgentTrace(msg.text, {
                        thinking: msg.thinking,
                        steps: msg.steps,
                        stepCount: msg.stepCount,
                        usage: msg.usage ?? cleanUsage,
                        model: '常驻会话',
                    }),
                });
            } catch { /* ignore concurrent duplicate append */ }
        }
        if (turnEnd && assistantMessages.length === 0 && (thinkingParts.length > 0 || steps.length > 0 || cleanUsage) && Number.isSafeInteger(turnEnd.seq)) {
            const detEndId = `sess-end:${shortSess}:${turnEnd.seq}`;
            if (!rooms.hasEvent?.(room.id, detEndId)) {
                try {
                    await rooms.append(room.id, {
                        id: detEndId,
                        kind: 'agent',
                        ...(runId ? { runId } : {}),
                        actor: speaker,
                        phase: 'handoff',
                        text: encodeAgentTrace(
                            turnEnd.reason === 'completed'
                                ? '常驻会话已完成本轮执行（请展开上方查看完整思考链与执行命令）。'
                                : `常驻会话本轮结束（原因：${turnEnd.reason}）。`,
                            {
                                thinking: joinTail(thinkingParts, 9000),
                                steps: steps.slice(-20),
                                stepCount: currentStep,
                                usage: cleanUsage,
                                model: '常驻会话',
                            },
                        ),
                    });
                } catch { /* ignore */ }
            }
        }
    }

    const isStillActive = Boolean(activeTurnInfo) || (!turnEnd && (currentStep > 0 || steps.some(s => s.status === 'running')));
    if (turnEnd && !activeTurnInfo && workflowState === 'handed-off') {
        try {
            await onTurnCompleted?.(turnEnd.reason, assistantMessages.at(-1)?.text ?? '');
        } catch { /* best-effort state transition */ }
    }

    if (!isStillActive) return undefined;

    const latestThinking = joinTail(thinkingParts, 9000);
    const recentSteps = steps.slice(-20).map(({ label, status, detail }) => ({
        label, status, ...(detail ? { detail } : {}),
    }));
    const runningStep = [...recentSteps].reverse().find(s => s.status === 'running');
    return {
        id: 'live-sess:' + sessionId,
        actor: speaker,
        phase: 'handoff',
        model: currentStep > 0 ? `常驻会话 · 第 ${currentStep} 步` : '常驻会话执行中',
        startedAt: turnStartedAt || Date.now(),
        updatedAt: Date.now(),
        thinking: latestThinking,
        steps: recentSteps,
        ...(cleanUsage ? { usage: cleanUsage } : {}),
        text: runningStep
            ? `正在执行 ${runningStep.label}…`
            : (currentStep > 0
                ? `常驻会话正在持续推演与处理（当前第 ${currentStep} 步）…`
                : '常驻会话正在思考与规划任务…'),
    };
}
