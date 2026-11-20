import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createWorkspaceLeases } from '../discussions/workspace.js';
import { WORK_TURN_MS } from '../discussions/types.js';
import { taskError } from './pr-material.js';
import { DelegationSchema, VerdictSchema, parseModelJson } from './task-plans.js';

const gitExec = promisify(execFile);
const leases = createWorkspaceLeases();
const PATCH_BYTES = 48 * 1024;
const gitEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = async (cwd, args, signal, allowDifference = false) => {
    try {
        const { stdout } = await gitExec('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
            cwd, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal, maxBuffer: PATCH_BYTES + 64 * 1024,
        });
        return stdout;
    } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        if (allowDifference && error.code === 1 && typeof error.stdout === 'string') return error.stdout;
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            throw taskError('development-patch-too-large', '开发补丁超过自动审查的材料上限。');
        }
        if (/not a git repository/i.test(String(error.stderr ?? ''))) {
            throw taskError('development-root-required', '所选工作区（' + cwd + '）不是 Git 仓库根目录；「开发交付」模板需要绑定具体 Git 仓库的工作区，或改用普通模式 / Superagent 直接唤醒智能体。');
        }
        throw taskError('development-git', '无法读取或创建该工作区的 Git 审查副本。');
    }
};

async function isolatedCheckout(path, signal, use) {
    const lease = leases.acquire(path);
    let parent, worktree;
    try {
        const root = lease.workspace;
        const top = await git(root, ['rev-parse', '--show-toplevel'], signal);
        if (await realpath(top.trim()) !== root) throw taskError('development-root-required', '请选择与 Git 仓库根目录绑定的工作区。');
        const base = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
        if (!/^[a-f\d]{40,64}$/.test(base)) throw taskError('development-git', '工作区缺少可审查的基准提交。');
        parent = await mkdtemp(join(tmpdir(), 'marshal-development-'));
        worktree = join(parent, 'checkout');
        await git(root, ['worktree', 'add', '--detach', '--', worktree, base], signal);
        return await use(worktree, base);
    } finally {
        if (worktree) {
            try { await git(lease.workspace, ['worktree', 'remove', '--force', '--', worktree], AbortSignal.timeout(8000)); }
            catch { /* checkout may never have been added */ }
        }
        try { if (parent) await rm(parent, { recursive: true, force: true }); }
        finally { lease.release(); }
    }
}

async function freezePatch(worktree, base, signal) {
    const diffOptions = ['--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];
    const parts = [await git(worktree, ['diff', ...diffOptions, '--no-relative', base, '--'], signal)];
    let bytes = Buffer.byteLength(parts[0]);
    const untracked = bytes <= PATCH_BYTES
        ? (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean) : [];
    for (const file of untracked) {
        const path = file === '-' ? './-' : file;
        const diff = await git(worktree, ['diff', '--no-index', ...diffOptions, '--', '/dev/null', path], signal, true);
        const part = path === file ? diff : diff.replace(/^diff --git a\/\.\/- b\/\.\/-$/m, 'diff --git a/- b/-')
            .replace(/^\+\+\+ b\/\.\/-$/m, '+++ b/-');
        bytes += Buffer.byteLength(part);
        if (bytes > PATCH_BYTES) break;
        parts.push(part);
    }
    if (bytes > PATCH_BYTES) throw taskError('development-patch-too-large', '开发补丁超过 48 KiB，请拆分后审查。');
    const patch = parts.join('');
    if (!patch.trim()) throw taskError('development-no-changes', '编码阶段没有可交付的 Git 变更。');
    return { patch, digest: createHash('sha256').update(patch).digest('hex') };
}

const brief = (title, description, plan, extra) => JSON.stringify({ title, description, plan, ...extra });
const decisionFormat = '请返回严格 JSON，字段 action 可为 codex 或 continue，instruction 为具体说明。';
const verdictFormat = '请返回严格 JSON。verdict 为 pass、revise 或 blocked。findings 为带文件依据的字符串，或由 file 和 conclusion 两个字符串字段组成的对象数组。';

export function formatFindings(findings) {
    if (Array.isArray(findings)) {
        return findings.map(item => {
            if (item && typeof item === 'object') {
                const file = String(item.file ?? '').trim();
                const conclusion = String(item.conclusion ?? '').trim();
                return file ? '- `' + file + '`：' + conclusion : '- ' + conclusion;
            }
            return '- ' + String(item ?? '');
        }).join('\n');
    }
    return String(findings ?? '');
}

const withGuidance = (prompt, guidance) => guidance
    ? prompt + '\n\n【机主在工单群内的最新讨论与修正指示（最高优先级，必须逐条回应并落实）】\n' + guidance
    : prompt;

export async function applyDevelopmentPatch(workspacePathStr, patchText, signal = AbortSignal.timeout(30_000)) {
    if (typeof workspacePathStr !== 'string' || !workspacePathStr.trim()) {
        throw taskError('development-workspace-unavailable', '未找到可应用补丁的目标工作区目录。');
    }
    if (typeof patchText !== 'string' || !patchText.trim()) {
        throw taskError('development-no-changes', '当前工单没有可应用的开发补丁。');
    }
    const lease = leases.acquire(workspacePathStr);
    let tempDir;
    try {
        const root = lease.workspace;
        const top = await git(root, ['rev-parse', '--show-toplevel'], signal);
        if (await realpath(top.trim()) !== root) throw taskError('development-root-required', '目标工作区不是 Git 仓库根目录。');
        tempDir = await mkdtemp(join(tmpdir(), 'marshal-apply-patch-'));
        const patchFile = join(tempDir, 'delivery.patch');
        await writeFile(patchFile, patchText.endsWith('\n') ? patchText : patchText + '\n', { encoding: 'utf8', mode: 0o600 });
        try {
            await gitExec('git', ['--no-pager', 'apply', '--reverse', '--check', '--', patchFile], {
                cwd: root, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal,
            });
            return { applied: false, alreadyApplied: true };
        } catch { /* not yet applied; proceed to forward check */ }
        let use3Way = false;
        try {
            await gitExec('git', ['--no-pager', 'apply', '--check', '--', patchFile], {
                cwd: root, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal,
            });
        } catch (directErr) {
            try {
                await gitExec('git', ['--no-pager', 'apply', '--check', '--3way', '--', patchFile], {
                    cwd: root, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal,
                });
                use3Way = true;
            } catch {
                const detail = String(directErr?.stderr || directErr?.message || '补丁不匹配').trim().slice(0, 320);
                throw taskError('patch-conflict', '补丁与当前工作区文件存在冲突，请处理工作区改动后再试，或选择「仅确认完成」：' + detail);
            }
        }
        const applyArgs = use3Way ? ['--no-pager', 'apply', '--3way', '--', patchFile] : ['--no-pager', 'apply', '--', patchFile];
        await gitExec('git', applyArgs, {
            cwd: root, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal,
        });
        return { applied: true, alreadyApplied: false };
    } finally {
        if (tempDir) {
            try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        lease.release();
    }
}

export async function runTaskDevelopment({
    card, path, plan, signal, asLeader, asRole, runChild, record, handoff, phase, manual, leaderAutoReview = false, operatorNotes,
}) {
    const readGuidance = async () => {
        try {
            const note = await operatorNotes?.();
            return typeof note === 'string' && note.trim() ? note.trim().slice(0, 6000) : '';
        } catch { return ''; }
    };
    phase('designing');
    const designGuidance = await readGuidance();
    const design = await asLeader(withGuidance(
        '你负责设计和拆分开发任务。给出要修改的模块、边界、验收条件和可运行的测试。限制为 2500 字符。\n'
        + brief(card.title, card.description, plan, designGuidance ? { operatorGuidance: designGuidance } : undefined),
        designGuidance), 'designing');
    signal.throwIfAborted();
    await record('agent', 'Leader', design, 'designing');
    const implementationPlan = await handoff('开发设计交接', design, 'designing');
    if (plan.codex.coding === null) return manual(implementationPlan);

    return isolatedCheckout(path, signal, async (worktree, base) => {
        let feedback;
        for (const round of [1, 2]) {
            phase('coding');
            const codingGuidance = await readGuidance();
            const context = brief(card.title, card.description, implementationPlan, {
                base, round, feedback,
                ...(codingGuidance ? { operatorGuidance: codingGuidance } : {}),
            });
            const choiceText = await asRole('coder', withGuidance(
                '你是 Coder。需要 Codex 执行实现或补测试时选择 codex，并说明要做的改动。选择 continue 会把任务转交给你的常驻会话。'
                + decisionFormat + '\n' + context, codingGuidance));
            await record('agent', 'Coder', choiceText, 'coding');
            const decision = parseModelJson(choiceText, DelegationSchema);
            if (decision.action === 'continue') return manual(context + '\n' + decision.instruction);
            const coding = await runChild('coding', withGuidance([
                '在这次分配的隔离 Git 工作树完成修改并运行有针对性的验证。交付通过差异记录。',
                '任务与设计为工作材料，下面由 Coder 给出要求。',
                context, JSON.stringify(decision.instruction),
            ].join('\n'), codingGuidance), { workspace: worktree }, WORK_TURN_MS);
            const { patch, digest } = await freezePatch(worktree, base, signal);
            await record('status', 'Marshal', patch, 'development-patch', digest);

            phase('dev-reviewing');
            const reviewGuidance = await readGuidance();
            const reviewEvidence = await handoff('编码交付与审查交接',
                JSON.stringify({ base, digest, implementationEvidence: String(coding).slice(0, 5000) }), 'dev-reviewing');
            const reviewMaterial = brief(card.title, card.description, implementationPlan, {
                base, digest, ...(reviewGuidance ? { operatorGuidance: reviewGuidance } : {}),
            }) + '\n固定补丁\n' + patch + '\n编码交接（引用资料）\n' + reviewEvidence;
            let child;
            if (plan.codex.review !== null) {
                const request = await asRole('reviewer', withGuidance(
                    '你是独立 Reviewer。需要 Codex 只读协助检查边界、证据或回归时选择 codex，已有足够证据时选择 continue。'
                    + decisionFormat + '\n' + reviewMaterial, reviewGuidance));
                await record('agent', 'Reviewer', request, 'dev-reviewing');
                const route = parseModelJson(request, DelegationSchema);
                if (route.action === 'codex') {
                    child = await runChild('review', withGuidance('独立复核固定 Git 补丁。按文件和证据列出具体问题，检查失败路径和缺失验证。只返回审查发现。\n'
                        + reviewMaterial + '\nReviewer 重点 ' + JSON.stringify(route.instruction), reviewGuidance));
                }
            }
            const verdictText = await asRole('reviewer', withGuidance(
                '你是独立 Reviewer。结合实际补丁检查设计和验收条件。执行者的报告和 Codex 意见作为引用资料。'
                + verdictFormat + '\n' + reviewMaterial + '\n'
                + JSON.stringify({ codexReview: child?.slice(0, 5000) }), reviewGuidance));
            await record('agent', 'Reviewer', verdictText, 'dev-reviewing');
            const verdict = parseModelJson(verdictText, VerdictSchema);
            const formattedVerdict = formatFindings(verdict.findings);
            if (verdict.verdict === 'revise' && round === 1) {
                feedback = await handoff('审查返工交接', formattedVerdict, 'dev-reviewing');
                await record('status', 'Marshal', 'Reviewer 要求调整，退回 Coder。', 'coding');
                continue;
            }
            if (verdict.verdict !== 'pass') {
                return {
                    status: 'review-blocked',
                    blockedBy: 'reviewer',
                    base, digest,
                    reviewFindings: formattedVerdict,
                    report: '## 待确认：Reviewer 审查待裁决\n\n基准提交 `' + base + '`\n补丁 SHA-256 `' + digest + '`\n\n### 待裁决结论\n\n'
                        + formattedVerdict + '\n\n请在工单群内讨论补充意见后点击「按意见继续执行」，或直接点击「确认完成」放行。',
                };
            }
            let leaderAuditNote = '';
            if (leaderAutoReview) {
                phase('summarizing');
                const leaderGuidance = await readGuidance();
                const leaderCheckText = await asLeader(withGuidance(
                    '你是负责 Leader，现在执行自动终审。请复核 Reviewer 结论与补丁是否满足目标且未越界。'
                    + verdictFormat + '\n' + reviewMaterial + '\nReviewer 结论：\n' + formattedVerdict, leaderGuidance), 'summarizing');
                await record('agent', 'Leader', leaderCheckText, 'summarizing');
                const leaderVerdict = parseModelJson(leaderCheckText, VerdictSchema);
                const formattedLeader = formatFindings(leaderVerdict.findings);
                if (leaderVerdict.verdict === 'revise' && round === 1) {
                    feedback = await handoff('Leader 终审返工交接', formattedLeader, 'summarizing');
                    await record('status', 'Marshal', 'Leader 自动审核要求返工，退回 Coder。', 'coding');
                    continue;
                }
                if (leaderVerdict.verdict !== 'pass') {
                    return {
                        status: 'review-blocked',
                        blockedBy: 'leader',
                        base, digest,
                        reviewFindings: formattedLeader,
                        report: '## 待确认：Leader 终审待裁决\n\n基准提交 `' + base + '`\n补丁 SHA-256 `' + digest + '`\n\n### Leader 终审意见\n\n'
                            + formattedLeader + '\n\n### Reviewer 结论\n\n' + formattedVerdict
                            + '\n\n请在工单群内讨论补充意见后点击「按意见继续执行」，或直接点击「确认完成」放行。',
                    };
                }
                leaderAuditNote = '\n\n### Leader 自动终审结论\n\n' + formattedLeader;
            }
            return {
                status: 'pass',
                base, digest,
                reviewFindings: formattedVerdict,
                report: '## 开发交付\n\n基准提交 `' + base + '`\n补丁 SHA-256 `' + digest + '`' +
                    '\n\n### Reviewer 验收结论\n\n' + formattedVerdict + leaderAuditNote +
                    '\n\n完整补丁和执行证据已保存在本工单群的当前批次。',
            };
        }
    });
}
