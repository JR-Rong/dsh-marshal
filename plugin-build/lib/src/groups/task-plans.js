import { z } from 'zod';
import { taskError } from './pr-material.js';

export const TEMPLATES = [
    { id: 'development', name: '开发交付', groupTemplate: 'delivery', stages: ['Leader 设计和拆分', 'Coder 编码并验证', 'Reviewer 审查'], automated: true },
    { id: 'pr-review', name: 'PR 对抗审查', groupTemplate: 'adversarial', stages: ['DSH 与 Codex 独立审查', '互相复核', 'Leader 汇总'], automated: true },
    { id: 'report', name: '报表与报告', groupTemplate: 'delivery', stages: ['整理数据和出处', '撰写报告', '复核口径与引用'], automated: false },
    { id: 'research', name: '技术调研与选型', groupTemplate: 'delivery', stages: ['明确问题和评价标准', '调研方案和来源', '比较取舍并给出建议'], automated: false },
    { id: 'incident', name: '故障排查', groupTemplate: 'free', stages: ['收集现象与证据', '提出并验证假设', '复盘根因与跟踪项'], automated: false },
];
export const GROUP_TEMPLATES = [
    { id: 'free', name: '自由协作', count: 2 },
    { id: 'delivery', name: '分阶段交付', count: 3 },
    { id: 'adversarial', name: '对抗复核', count: 3 },
];
export const ROLE_LABELS = {
    coder: 'Coder', reviewer: 'Reviewer', critic: 'DSH 审查员', codexCritic: 'Codex 审查员',
    writer: '报告撰写', researcher: '技术调研', checker: '校核', collaborator: '协作者',
};
const ROLE_NAMES = {
    development: ['coder', 'reviewer'],
    'pr-review': ['critic', 'codexCritic'],
    report: ['writer', 'checker'],
    research: ['researcher', 'checker'],
    incident: ['collaborator'],
    none: ['collaborator'],
};
export const TEMPLATE_VERSION = 2;
export const templateById = id => TEMPLATES.find(template => template.id === id);
export const codeWriter = member => ['workspace-write', 'danger-full-access'].includes(member?.permission);
const memberId = z.string().min(1).max(256);
const codexModel = z.string().min(1).max(128).nullable();
export const PlanSchema = z.object({
    templateId: z.enum(['none', ...TEMPLATES.map(template => template.id)]),
    codeWork: z.boolean().optional(),
    members: z.partialRecord(z.enum(Object.keys(ROLE_LABELS)), memberId).optional(),
    codex: z.object({ coding: codexModel.optional(), review: codexModel.optional() }).strict().optional(),
}).strict();
export const DelegationSchema = z.object({
    action: z.enum(['codex', 'continue']),
    instruction: z.string().trim().min(1).max(4000),
}).strict();
const findingsText = z.string().trim().min(1).max(5000);
const findingsList = z.array(z.object({
    file: z.string().trim().min(1).max(280),
    conclusion: z.string().trim().min(1).max(1800),
}).strict()).min(1).max(12).transform(items =>
    items.map(item => '- ' + item.file + '：' + item.conclusion).join('\n'));
export const VerdictSchema = z.object({
    verdict: z.enum(['pass', 'revise', 'blocked']),
    findings: z.union([findingsText, findingsList]).pipe(findingsText),
}).strict();

export function parseModelJson(text, schema) {
    const raw = String(text).trim();
    const candidates = [raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
    for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
        if (match[1]) candidates.push(match[1].trim());
    }
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));
    for (const candidate of candidates) {
        try { return schema.parse(JSON.parse(candidate)); }
        catch { /* try next candidate */ }
    }
    throw taskError('invalid-role-output', 'Agent 未返回有效的阶段决定。');
}

export function roleSlots(templateId, codeWork) {
    const names = codeWork && templateId !== 'development' && templateId !== 'pr-review'
        ? ['coder', 'reviewer', ...ROLE_NAMES[templateId]] : ROLE_NAMES[templateId];
    return names.map(id => ({ id, name: ROLE_LABELS[id],
        required: id === 'coder' || id === 'reviewer' || id === 'codexCritic',
    }));
}

/** Slots are scoped to the selected workspace. A model proposes ids, and the service validates them. */
export function taskPlan({ raw, task, candidates, recommend = false }) {
    let parsed;
    try { parsed = PlanSchema.parse(raw); }
    catch { throw taskError('invalid-task-plan', '编排分工格式无效。'); }
    if ((task.choice === 'template' && parsed.templateId !== task.templateId) ||
        (task.choice === 'none' && parsed.templateId !== 'none') ||
        (parsed.templateId === 'pr-review' && !task.prUrl)) {
        throw taskError('invalid-task-plan', '分工和任务模板不一致。');
    }
    const templateId = parsed.templateId;
    const codeWork = templateId === 'development' || (templateId !== 'pr-review' && parsed.codeWork === true);
    const slots = roleSlots(templateId, codeWork);
    const used = new Set([task.leaderId]);
    const members = {};
    for (const { id } of slots) {
        if (id === 'codexCritic') {
            members[id] = '@codex';
            continue;
        }
        const requested = parsed.members?.[id];
        const available = candidates.filter(member => member.workspaceId === task.workspaceId && !used.has(member.id) &&
            (id !== 'coder' || codeWriter(member)));
        let member = available.find(item => item.id === requested);
        if (requested && !member && !recommend && !(requested === '@dsh' && id === 'critic')) {
            throw taskError('invalid-task-assignee', '角色需要同一工作区的合格 Agent，编码者和审查者须独立指派。');
        }
        if (!member && recommend) member = available[0];
        if (member) {
            members[id] = member.id;
            used.add(member.id);
        } else if (id === 'critic') members[id] = '@dsh';
    }
    const codexDefault = (name, enabled) => enabled
        ? (parsed.codex && Object.hasOwn(parsed.codex, name) ? parsed.codex[name] : 'auto') : null;
    return {
        templateId, groupTemplate: codeWork ? 'delivery' : templateById(templateId)?.groupTemplate ?? 'free', codeWork, members,
        codex: { coding: codexDefault('coding', codeWork), review: codexDefault('review', codeWork || templateId === 'pr-review') },
    };
}

export function pickCodex(models, slot, write = false) {
    if (slot === null) return undefined;
    const options = models.filter(model => model.agent === 'codex' && (!write || model.work === true));
    const model = slot === 'auto' || slot === undefined ? options[0] : options.find(model => model.id === slot);
    if (!model) throw taskError('codex-slot-unavailable', '配置的 Codex 子 Agent 当前不可用。请检查节点或修改分工。');
    return model;
}
