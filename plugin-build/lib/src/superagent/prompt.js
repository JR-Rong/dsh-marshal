/**
 * Turn one card plus one member into (a) the execution prompt and (b) the
 * pre-run card patch.
 *
 * The prompt is the only place the agent identity can travel: a board-native
 * session composes the board's default preset, not a dsh-agents member. The
 * patch is deliberately narrow — it never overwrites a value the operator put
 * on the card, and it never raises the effective permission above the board's
 * session default (that gate belongs to a human).
 */

const PERMISSION_RANK = { 'read-only': 1, 'workspace-write': 2, 'danger-full-access': 3 };
const MAX_PROMPT_CHARS = 24000;
const MAX_TAG_CHARS = 32;
const MAX_TAGS = 8;

function text(value) {
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

function clip(value, limit) {
    const body = text(value);
    if (body.length <= limit) return body;
    return body.slice(0, Math.max(0, limit - 20)).trimEnd() + '\n…（截断）';
}

export function permissionRank(value) {
    return PERMISSION_RANK[value] ?? 0;
}

export function agentTagName(name) {
    const value = text(name);
    return clip('智能体:' + value, MAX_TAG_CHARS);
}

function extractRequirement(prompt) {
    const marker = '【任务要求】';
    const at = prompt.indexOf(marker);
    if (at === -1) return '';
    const rest = prompt.slice(at + marker.length).replace(/^\n+/, '');
    const end = rest.indexOf('\n\n【执行约定】');
    return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function mergeTags(task, member) {
    const existing = (Array.isArray(task.tags) ? task.tags : [])
        .filter(tag => tag !== null && typeof tag === 'object' && typeof tag.name === 'string' && tag.name.trim() !== '')
        .map(tag => ({
            name: tag.name.trim(),
            ...(typeof tag.promptPrefix === 'string' && tag.promptPrefix.trim() !== '' ? { promptPrefix: tag.promptPrefix.trim() } : {}),
        }));
    const agentTag = agentTagName(member.name);
    // Only one bridge-assigned executor belongs on a card. Removing every
    // 智能体: tag is what makes a reassignment move the identity instead of
    // leaving the previous agent's tag first in the list. Replacing an old
    // agent tag never grows the tag list, so it is allowed at the cap.
    const without = existing.filter(tag => !tag.name.startsWith('智能体:'));
    const hadAgentTag = existing.some(tag => tag.name.startsWith('智能体:'));
    // A ninth tag would evict one the operator chose; show the agent in the
    // prompt and the dispatch ledger instead of silently rewriting the card.
    if (!hadAgentTag && existing.length >= MAX_TAGS) return existing;
    const seen = new Set();
    const result = [];
    for (const tag of [{ name: agentTag }, ...without]) {
        if (seen.has(tag.name) || tag.name.length > MAX_TAG_CHARS) continue;
        seen.add(tag.name);
        result.push(tag);
    }
    return result.slice(0, MAX_TAGS);
}

/**
 * Build the prompt one woken agent sees as its first user message.
 * @param {object} input - member, task, memory block and settings.
 * @returns {string} bounded execution prompt.
 */
export function composePrompt({ member, task, memory = '', memoryCount = 0 }) {
    const name = text(member?.name) || '未命名智能体';
    const brief = text(member?.brief);
    const title = text(task?.title) || '(未命名工单)';
    const description = text(task?.description);
    const existing = text(task?.prompt);
    // A failed run or a reassignment can leave the prepared prompt on the card.
    // Recover the operator's requirement from it and rebuild the block for the
    // CURRENT member; returning the old block would hand B A's identity and
    // memory while settlement writes the result into B's memory.
    const requirement = existing.startsWith('【超级智能体派发】')
        ? extractRequirement(existing) || description || title
        : existing || description || title;
    const lines = [];
    lines.push('【超级智能体派发】');
    lines.push('智能体：' + name);
    lines.push('身份与职责：');
    lines.push(brief === '' ? '（该成员未填写 brief，请按工单要求执行。）' : brief);
    if (memoryCount > 0 && memory !== '') {
        lines.push('');
        lines.push('【你的长期记忆（节选 ' + memoryCount + ' 条，供参考；与本工单冲突时以本工单为准）】');
        lines.push(memory);
    }
    lines.push('');
    lines.push('【工单】' + title + '（' + (text(task?.id) || '无 id') + '）');
    if (description !== '') lines.push(description);
    lines.push('');
    lines.push('【任务要求】');
    lines.push(requirement);
    lines.push('');
    lines.push('【执行约定】');
    lines.push('1. 你正在任务看板的原生执行会话中工作；请直接完成本工单，不要重复建卡。');
    lines.push('2. 完成后用一段话总结你做了什么、结果如何；这段总结会写入你的长期记忆。');
    lines.push('3. 需要皇上决断时，用 ask_user_question 提问，不要自行假设。');
    return clip(lines.join('\n'), MAX_PROMPT_CHARS);
}

/**
 * Resolve the pre-run patch. A card value wins; the member fills only blanks.
 * A permission above the board's session default is reported, never applied:
 * the board would refuse the run until a human confirms, and auto-confirming
 * is exactly the bypass this bridge must not perform.
 */
export function planCardPatch({ task, member, snapshot, prompt }) {
    const patch = { prompt };
    const notes = [];
    const finalModel = text(task.model) || text(member.model);
    if (text(task.mode) === '' && text(member.preset) !== '') patch.mode = text(member.preset);
    if (text(task.model) === '' && text(member.model) !== '') patch.model = text(member.model);
    if (text(task.reasoningEffort) === '' && text(member.reasoningEffort) !== '') {
        if (finalModel !== '' && (text(task.model) === '' || finalModel === text(member.model))) patch.reasoningEffort = text(member.reasoningEffort);
    }
    if (text(task.permission) === '' && text(member.permission) !== '') {
        const defaultRank = permissionRank(snapshot?.sessionDefaultPermission);
        const memberRank = permissionRank(member.permission);
        if (memberRank === 0) {
            notes.push('permission-unknown: member "' + member.name + '" pins an unknown permission; the card is left at the deployment default');
        }
        else if (defaultRank === 0) {
            notes.push('permission-default-unknown: the board snapshot carries no sessionDefaultPermission; the card is left at the deployment default');
        }
        else if (memberRank <= defaultRank) {
            patch.permission = text(member.permission);
        }
        else {
            notes.push('permission-not-raised: member "' + member.name + '" pins ' + member.permission + ' above the board default; card left at the default and the run gate decides');
        }
    }
    const tags = mergeTags(task, member);
    if (tags.length > 0) patch.tags = tags;
    return { patch, notes };
}

export function taskIsDispatchable(task, settings, options = {}) {
    if (task === null || typeof task !== 'object') return { ok: false, code: 'task-missing' };
    if (typeof task.id !== 'string' || task.id === '') return { ok: false, code: 'task-missing' };
    if (task.archivedAt !== undefined) return { ok: false, code: 'task-archived' };
    if (options.requireTodo === true && task.status !== 'todo') {
        return { ok: false, code: 'not-todo' };
    }
    if (options.requireTodo === true && task.schedule?.enabled === true) {
        return { ok: false, code: 'scheduled-task' };
    }
    if (settings.rootOnly === true && typeof task.parentId === 'string' && task.parentId !== '') {
        return { ok: false, code: 'subtask-suppressed' };
    }
    const executions = Array.isArray(task.executions) ? task.executions : [];
    if (executions.some(execution => execution?.endedAt === undefined && execution?.result === undefined)) {
        return { ok: false, code: 'already-running' };
    }
    if (executions.length > 0) return { ok: false, code: 'already-executed' };
    return { ok: true, code: 'ok' };
}
