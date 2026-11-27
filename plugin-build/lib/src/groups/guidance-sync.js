import { taskError } from './pr-material.js';

const inline = text => String(text ?? '').replace(/\s+/g, ' ').replace(/[<>]/g, '').trim();
export function prioritizeGuidance(text, guidance, limit = Infinity) {
    return (guidance ? guidance + (text ? '\n\n' + text : '') : text).slice(0, limit);
}

export function guidanceSessionUnavailable() {
    return Object.assign(taskError('guidance-session-unavailable', '已请求执行，但无法确认新执行会话收到指导。'), { status: 502 });
}

export async function syncGuidanceToAgent({ tasks, targetTicketId, guidanceText, wakeTicket = true,
    resolveTicket, ensureRoom, reviseTicket, rooms, resolveSession, steerResidentSession, store, eventBus }) {
    const guidance = typeof guidanceText === 'string' ? guidanceText.trim() : '';
    if (!guidance || guidance.length > 3000) throw taskError('invalid-guidance', '请输入不超过 3000 字的指导。');
    const context = tasks.map(task => inline(task.title).slice(0, 140) + '（' + task.status + '）'
        + (task.lastSummary ? '：' + inline(task.lastSummary).slice(0, 240) : '')).join(' · ').slice(0, 800);
    // The complete Markdown must fit the host task board's 4,000-character rework limit.
    const summary = ['## 主人指示', guidance, ...(context ? ['## 所选任务上下文（仅供参考）', '> ' + context] : [])].join('\n\n');
    const ticketIds = targetTicketId ? [targetTicketId] : [...new Set(tasks.map(task => task.linkedTicketId).filter(Boolean))];
    // Validate all destinations before touching any room or session.
    const destinations = ticketIds.map(id => ({ ticket: resolveTicket(id) }));
    if (!destinations.length) {
        if (!tasks.length || tasks.some(task => task.type !== 'direct')) {
            throw taskError('invalid-guidance-target', '请选择工单或直连任务。');
        }
        const sessions = new Map();
        for (const task of tasks) {
            const sessionId = await resolveSession(task);
            if (!sessions.has(sessionId)) sessions.set(sessionId, []);
            sessions.get(sessionId).push(task);
        }
        for (const [sessionId, selected] of sessions) destinations.push({ sessionId, selected });
    }
    const deliveries = [];
    const updated = [];
    for (const dest of destinations) {
        let delivered = false;
        const delivery = dest.ticket ? { ticketId: dest.ticket.id } : { sessionId: dest.sessionId };
        try {
            if (dest.ticket) {
                const room = ensureRoom(dest.ticket);
                // The room service publishes the room.message cursor on successful append.
                await rooms.append(room.id, { kind: 'user', phase: 'guidance', actor: '工单操作者', text: summary,
                    ...(room.runId ? { runId: room.runId } : {}) });
                delivered = true;
                eventBus.emit('incidents.changed');
                if (wakeTicket !== false) {
                    delivery.woken = false;
                    try {
                        const wake = await reviseTicket(dest.ticket, summary);
                        if (wake?.woken !== true) throw guidanceSessionUnavailable();
                        delivery.woken = true;
                    } finally {
                        // A failed wake can still change the ticket's execution and incident state.
                        eventBus.emit('tasks.changed');
                        eventBus.emit('incidents.changed');
                    }
                }
            } else {
                await steerResidentSession(dest.sessionId, summary);
                delivered = true;
            }
            const selected = dest.selected ?? (targetTicketId ? tasks : tasks.filter(task => task.linkedTicketId === dest.ticket.id));
            try {
                if (selected.length) updated.push(...store.markSynced(selected, summary));
            } finally {
                eventBus.emit('agents.changed');
                eventBus.emit('tasks.changed');
            }
            deliveries.push({ ...delivery, delivered });
        } catch (error) {
            deliveries.push({ ...delivery, delivered, code: error?.code ?? 'guidance-delivery-failed', status: error?.status ?? 502 });
        }
    }
    return { summary, deliveries, tasks: updated };
}
