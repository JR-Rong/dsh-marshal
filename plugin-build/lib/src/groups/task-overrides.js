import { readFileSync } from 'node:fs';
import { atomicWriteFile } from '../hub/state-file.js';

const EFFORT_LABELS = {
    '': '跟随默认',
    off: '关闭思考 (直出)',
    none: '关闭思考 (直出)',
    low: '低 (low)',
    medium: '中 (medium)',
    high: '高 (high)',
    xhigh: '极高 (xhigh)',
};

export function formatEffortLabel(effort, fallbackEffort = '') {
    const val = typeof effort === 'string' ? effort.trim() : '';
    if (!val) {
        const fb = typeof fallbackEffort === 'string' ? fallbackEffort.trim() : '';
        return fb ? `跟随默认 (${EFFORT_LABELS[fb] ?? fb})` : '跟随默认';
    }
    return EFFORT_LABELS[val] ?? val;
}

export function formatModelLabel(model, fallbackModel = '') {
    if (model === null || model === 'off') return '已关闭';
    const val = typeof model === 'string' ? model.trim() : '';
    if (!val) {
        const fb = typeof fallbackModel === 'string' ? fallbackModel.trim() : '';
        return fb ? `默认 (${fb})` : '跟随默认';
    }
    if (val === 'auto') return '自动选择 Codex';
    return val;
}

export function extractAssignedAgentName(card) {
    for (const tag of Array.isArray(card?.tags) ? card.tags : []) {
        const name = typeof tag?.name === 'string' ? tag.name.trim() : '';
        if (name.startsWith('智能体:') && name.length > 4) return name.slice(4).trim();
        if (name.startsWith('@') && name.length > 1) return name.slice(1).trim();
    }
    return '';
}

export function describePlainConfigChanges(prevCard, nextCard) {
    const changes = [];
    const prevAgent = extractAssignedAgentName(prevCard);
    const nextAgent = extractAssignedAgentName(nextCard);
    if (prevAgent !== nextAgent) {
        changes.push(`执行 Agent 由「${prevAgent || '未指派'}」切换为「${nextAgent || '未指派'}」`);
    }
    const prevModel = typeof prevCard?.model === 'string' ? prevCard.model.trim() : '';
    const nextModel = typeof nextCard?.model === 'string' ? nextCard.model.trim() : '';
    if (prevModel !== nextModel) {
        changes.push(`模型由「${formatModelLabel(prevModel)}」切换为「${formatModelLabel(nextModel)}」`);
    }
    const prevEffort = typeof prevCard?.reasoningEffort === 'string' ? prevCard.reasoningEffort.trim() : '';
    const nextEffort = typeof nextCard?.reasoningEffort === 'string' ? nextCard.reasoningEffort.trim() : '';
    if (prevEffort !== nextEffort) {
        changes.push(`思考强度由「${formatEffortLabel(prevEffort)}」切换为「${formatEffortLabel(nextEffort)}」`);
    }
    if (changes.length === 0) return { changes: [], summary: '' };
    const targetName = nextAgent || prevAgent;
    const prefix = targetName ? `⚙️ 配置变更（${targetName}）：` : '⚙️ 工单执行配置变更：';
    return {
        changes,
        summary: `${prefix}${changes.join('；')} —— 将在下一轮对话生效。`,
    };
}

function attachmentDigestList(list) {
    if (!Array.isArray(list) || list.length === 0) return '';
    return list.map(item => `${item.attachmentId}:${item.name}`).join('|');
}

export function describeContentSteeringMessage(prevCard, nextCard, contentPatch = {}) {
    if (!contentPatch || typeof contentPatch !== 'object') return '';
    const sections = [];
    if ('title' in contentPatch && String(prevCard?.title ?? '') !== String(nextCard?.title ?? '')) {
        sections.push(`- **最新标题**：${String(nextCard?.title ?? '').slice(0, 400)}`);
    }
    if ('description' in contentPatch && String(prevCard?.description ?? '') !== String(nextCard?.description ?? '')) {
        const desc = String(nextCard?.description ?? '').trim();
        sections.push(`- **最新描述**：\n${desc ? desc.slice(0, 4500) : '（已清空）'}`);
    }
    if ('prompt' in contentPatch && String(prevCard?.prompt ?? '') !== String(nextCard?.prompt ?? '')) {
        const prm = String(nextCard?.prompt ?? '').trim();
        sections.push(`- **最新执行指令 (Prompt)**：\n${prm ? prm.slice(0, 4500) : '（已清空）'}`);
    }
    if ('attachments' in contentPatch) {
        const prevAtt = attachmentDigestList(prevCard?.attachments);
        const nextAtt = attachmentDigestList(nextCard?.attachments);
        if (prevAtt !== nextAtt) {
            const list = Array.isArray(nextCard?.attachments) ? nextCard.attachments : [];
            sections.push(list.length > 0
                ? `- **最新附件（${list.length}）**：${list.map(a => a.name).join('、')}`
                : '- **最新附件**：（已清空全部附件）');
        }
    }
    if (sections.length === 0) return '';
    const head = `📝 【工单内容实时修订插话】机主刚刚修订了正在运行的工单「${String(nextCard?.title ?? prevCard?.title ?? '').slice(0, 120)}」，请立即按以下最新内容调整执行：`;
    return `${head}\n${sections.join('\n')}`.slice(0, 12_000);
}

function loadOverrides(file) {
    if (!file) return new Map();
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (raw?.version !== 1 || !raw.overrides || typeof raw.overrides !== 'object') return new Map();
        const map = new Map();
        for (const [k, v] of Object.entries(raw.overrides)) {
            if (v && typeof v === 'object') map.set(k, { ...v });
        }
        return map;
    } catch (error) {
        if (error?.code === 'ENOENT') return new Map();
        return new Map();
    }
}

export function createTaskOverrides(file) {
    const entries = loadOverrides(file);
    const keyFor = (source, taskId) => `${source}/${taskId}`;
    const save = () => {
        if (!file) return;
        const overrides = Object.fromEntries(entries.entries());
        atomicWriteFile(file, JSON.stringify({ version: 1, overrides }, null, 2) + '\n');
    };

    return {
        get(source, taskId) {
            const found = entries.get(keyFor(source, taskId));
            return found ? { ...found } : undefined;
        },
        set(source, taskId, patch = {}) {
            const key = keyFor(source, taskId);
            const prev = entries.get(key) ?? {};
            const next = { ...prev };
            if ('title' in patch && typeof patch.title === 'string' && patch.title.trim() !== '') {
                next.title = patch.title.trim();
            }
            if ('description' in patch && typeof patch.description === 'string') {
                next.description = patch.description;
            }
            if ('prompt' in patch && typeof patch.prompt === 'string') {
                next.prompt = patch.prompt;
            }
            if ('attachments' in patch) {
                if (patch.attachments === null || (Array.isArray(patch.attachments) && patch.attachments.length === 0)) {
                    next.attachments = [];
                } else if (Array.isArray(patch.attachments)) {
                    next.attachments = patch.attachments.map(item => ({ ...item }));
                }
            }
            next.updatedAt = Date.now();
            entries.set(key, next);
            save();
            return { ...next };
        },
        applyTo(source, task) {
            if (!task || typeof task !== 'object') return task;
            const ov = entries.get(keyFor(source, task.id));
            if (!ov) return task;
            const merged = { ...task };
            if (typeof ov.title === 'string' && ov.title !== '') merged.title = ov.title;
            if (typeof ov.description === 'string') merged.description = ov.description;
            if (typeof ov.prompt === 'string') merged.prompt = ov.prompt;
            if (Array.isArray(ov.attachments)) {
                if (ov.attachments.length === 0) delete merged.attachments;
                else merged.attachments = ov.attachments.map(item => ({ ...item }));
            }
            if (typeof ov.updatedAt === 'number') {
                merged.updatedAt = Math.max(Number(task.updatedAt ?? 0), ov.updatedAt);
            }
            return merged;
        },
        remove(source, taskId) {
            if (!entries.delete(keyFor(source, taskId))) return false;
            save();
            return true;
        },
    };
}
