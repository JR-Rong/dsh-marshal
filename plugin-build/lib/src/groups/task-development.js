import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createWorkspaceLeases } from '../discussions/workspace.js';
import { WORK_TURN_MS } from '../discussions/types.js';
import { taskError } from './pr-material.js';
import { DelegationSchema, VerdictSchema, parseModelJson } from './task-plans.js';
import { extractPatchTouchedFiles, formatPatchRoomRecord, MAX_STORED_PATCH_BYTES } from './patch-store.js';

const gitExec = promisify(execFile);
const leases = createWorkspaceLeases();
export const PATCH_BYTES = 512 * 1024;
const INLINE_REVIEW_PATCH_BYTES = 24 * 1024;
const GIT_MAX_BUFFER = MAX_STORED_PATCH_BYTES + 256 * 1024;
const gitEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = async (cwd, args, signal, allowDifference = false) => {
    try {
        const { stdout } = await gitExec('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
            cwd, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal, maxBuffer: GIT_MAX_BUFFER,
        });
        return stdout;
    } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        if (allowDifference && error.code === 1 && typeof error.stdout === 'string') return error.stdout;
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            throw taskError('development-patch-too-large', '开发补丁超过自动审查的最大缓冲上限（2 MiB），请按模块拆分工单。');
        }
        if (/not a git repository/i.test(String(error.stderr ?? ''))) {
            throw taskError('development-root-required', '所选工作区（' + cwd + '）不是 Git 仓库根目录；「开发交付」模板需要绑定具体 Git 仓库的工作区，或改用普通模式 / Superagent 直接唤醒智能体。');
        }
        throw taskError('development-git', '无法读取或创建该工作区的 Git 审查副本。');
    }
};

export async function linkWorkspaceNodeModules(root, worktree) {
    const created = [];
    const tryLinkPath = async relPath => {
        const src = join(root, relPath);
        const dst = join(worktree, relPath);
        const dstParent = join(dst, '..');
        if (!existsSync(src) || !existsSync(dstParent) || existsSync(dst)) return;
        try {
            const st = await lstat(dst).catch(() => null);
            if (st) return;
            await symlink(src, dst, 'dir');
            created.push(dst);
        } catch { /* best-effort read-only dependency projection */ }
    };
    const tryLink = async relDir => {
        const relPath = relDir ? join(relDir, 'node_modules') : 'node_modules';
        await tryLinkPath(relPath);
    };
    await tryLink('');
    await tryLinkPath('.toolchain');
    try {
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            await tryLink(entry.name);
            if (entry.name === 'packages' || entry.name === 'apps' || entry.name === 'plugins') {
                const nested = await readdir(join(root, entry.name), { withFileTypes: true }).catch(() => []);
                for (const sub of nested) {
                    if (sub.isDirectory() && !sub.name.startsWith('.') && sub.name !== 'node_modules') {
                        await tryLink(join(entry.name, sub.name));
                    }
                }
            }
            const subPluginsDir = join(root, entry.name, 'plugins');
            if (existsSync(subPluginsDir)) {
                const subPlugins = await readdir(subPluginsDir, { withFileTypes: true }).catch(() => []);
                for (const sub of subPlugins) {
                    if (sub.isDirectory() && !sub.name.startsWith('.') && sub.name !== 'node_modules') {
                        await tryLink(join(entry.name, 'plugins', sub.name));
                    }
                }
            }
        }
    } catch { /* ignore unreadable workspace dirs */ }
    return async () => {
        for (const dst of created.splice(0).reverse()) {
            try {
                const st = await lstat(dst);
                if (st.isSymbolicLink()) await unlink(dst);
            } catch { /* already removed */ }
        }
    };
}

export async function readRepoContext(workspacePathStr, card, signal) {
    if (typeof workspacePathStr !== 'string' || !workspacePathStr.trim()) return undefined;
    try {
        const root = await realpath(workspacePathStr);
        const [branchRaw, headRaw, logRaw, statusRaw, entriesRaw] = await Promise.all([
            git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal).catch(() => ''),
            git(root, ['rev-parse', '--short', 'HEAD'], signal).catch(() => ''),
            git(root, ['log', '-n', '5', '--oneline'], signal).catch(() => ''),
            git(root, ['status', '--porcelain'], signal).catch(() => ''),
            readdir(root, { withFileTypes: true }).catch(() => []),
        ]);
        const dirtyLines = statusRaw.split('\n').map(l => l.trim()).filter(Boolean);
        const topLevel = entriesRaw
            .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
            .map(e => e.isDirectory() ? e.name + '/' : e.name)
            .sort()
            .slice(0, 32);
        const text = [card?.title, card?.description, card?.prompt].filter(Boolean).join('\n');
        const pathMatches = new Set();
        const re = /(?:^|[\s`"'(（\[【])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9]+)?)/g;
        let match;
        while ((match = re.exec(text)) !== null && pathMatches.size < 20) {
            const candidate = match[1].replace(/[.,;:!?)'"`\]]+$/, '');
            if (!candidate || candidate.startsWith('http') || candidate.includes('..') || candidate.startsWith('/')) continue;
            pathMatches.add(candidate);
        }
        const referencedPaths = [...pathMatches].slice(0, 16).map(rel => ({
            path: rel,
            exists: existsSync(join(root, rel)),
        }));
        return {
            branch: branchRaw.trim() || undefined,
            head: headRaw.trim() || undefined,
            recentCommits: logRaw.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 5),
            dirtyFilesCount: dirtyLines.length,
            ...(dirtyLines.length > 0 ? { dirtyPreview: dirtyLines.slice(0, 10) } : {}),
            topLevel,
            ...(referencedPaths.length > 0 ? { referencedPaths } : {}),
        };
    } catch {
        return undefined;
    }
}

async function applyPatchToDir(dir, patchText, signal) {
    const tempDir = await mkdtemp(join(tmpdir(), 'marshal-seed-patch-'));
    try {
        const patchFile = join(tempDir, 'seed.patch');
        await writeFile(patchFile, patchText.endsWith('\n') ? patchText : patchText + '\n', { encoding: 'utf8', mode: 0o600 });
        try {
            await gitExec('git', ['--no-pager', 'apply', '--check', '--', patchFile], {
                cwd: dir, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal,
            });
            await gitExec('git', ['--no-pager', 'apply', '--', patchFile], {
                cwd: dir, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal,
            });
            return { applied: true, method: 'direct' };
        } catch {
            try {
                await gitExec('git', ['--no-pager', 'apply', '--check', '--3way', '--', patchFile], {
                    cwd: dir, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal,
                });
                await gitExec('git', ['--no-pager', 'apply', '--3way', '--', patchFile], {
                    cwd: dir, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal,
                });
                return { applied: true, method: '3way' };
            } catch (err) {
                return { applied: false, reason: String(err?.stderr || err?.message || 'patch-mismatch').trim().slice(0, 200) };
            }
        }
    } finally {
        try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

async function isolatedCheckout(path, signal, use, { seedPatch } = {}) {
    const lease = leases.acquire(path);
    let parent, worktree, activeUnlink;
    try {
        const root = lease.workspace;
        const top = await git(root, ['rev-parse', '--show-toplevel'], signal);
        if (await realpath(top.trim()) !== root) throw taskError('development-root-required', '请选择与 Git 仓库根目录绑定的工作区。');
        const base = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
        if (!/^[a-f\d]{40,64}$/.test(base)) throw taskError('development-git', '工作区缺少可审查的基准提交。');
        const dirtyStatus = await git(root, ['status', '--porcelain'], signal).catch(() => '');
        const dirtyLines = dirtyStatus.split('\n').map(l => l.trim()).filter(Boolean);
        parent = await mkdtemp(join(tmpdir(), 'marshal-development-'));
        worktree = join(parent, 'checkout');
        await git(root, ['worktree', 'add', '--detach', '--', worktree, base], signal);
        let seedResult = { applied: false };
        if (typeof seedPatch === 'string' && seedPatch.trim() !== '') {
            seedResult = await applyPatchToDir(worktree, seedPatch, signal);
        }
        const mountDeps = async () => {
            if (activeUnlink) await activeUnlink();
            activeUnlink = await linkWorkspaceNodeModules(root, worktree);
            return async () => {
                const fn = activeUnlink;
                activeUnlink = undefined;
                if (fn) await fn();
            };
        };
        return await use(worktree, base, mountDeps, {
            dirtyFilesCount: dirtyLines.length,
            seededFromPreviousPatch: seedResult.applied === true,
            seedFailureReason: seedResult.applied ? undefined : seedResult.reason,
        });
    } finally {
        if (activeUnlink) {
            try { await activeUnlink(); } catch { /* ignore */ }
        }
        if (worktree) {
            try { await git(lease.workspace, ['worktree', 'remove', '--force', '--', worktree], AbortSignal.timeout(8000)); }
            catch { /* checkout may never have been added */ }
        }
        try { if (parent) await rm(parent, { recursive: true, force: true }); }
        finally { lease.release(); }
    }
}

const IGNORED_WORKTREE_CACHE_SEGMENTS = new Set(['.npm', 'Library', '.cache', '.vite', '.swiftpm', '.toolchain', 'node_modules', 'node-compile-cache', 'xcrun_db']);
function isIgnoredWorktreeCachePath(relPath) {
    const normalized = String(relPath || '').replace(/^\/+/, '');
    if (!normalized) return true;
    const segments = normalized.split('/');
    return segments.some(seg => IGNORED_WORKTREE_CACHE_SEGMENTS.has(seg));
}

async function freezePatch(worktree, base, signal, patchStore) {
    const diffOptions = ['--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];
    const tracked = await git(worktree, ['diff', ...diffOptions, '--no-relative', base, '--'], signal);
    const statTracked = await git(worktree, ['diff', '--stat', '--no-color', base, '--'], signal).catch(() => '');
    const parts = [tracked];
    let bytes = Buffer.byteLength(tracked, 'utf8');
    const untracked = (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'], signal))
        .split('\0')
        .filter(file => Boolean(file) && !isIgnoredWorktreeCachePath(file));
    for (const file of untracked) {
        const filePath = file === '-' ? './-' : file;
        const diff = await git(worktree, ['diff', '--no-index', ...diffOptions, '--', '/dev/null', filePath], signal, true);
        const part = filePath === file ? diff : diff.replace(/^diff --git a\/\.\/- b\/\.\/-$/m, 'diff --git a/- b/-')
            .replace(/^\+\+\+ b\/\.\/-$/m, '+++ b/-');
        bytes += Buffer.byteLength(part, 'utf8');
        parts.push(part);
        if (bytes > MAX_STORED_PATCH_BYTES) break;
    }
    const untrackedStat = untracked.length > 0
        ? untracked.slice(0, 30).map(f => ' ' + f + ' (new file)').join('\n')
        : '';
    const diffStat = [statTracked.trim(), untrackedStat].filter(Boolean).join('\n');
    const patch = parts.join('');
    if (!patch.trim()) throw taskError('development-no-changes', '编码阶段没有可交付的 Git 变更。');
    const digest = createHash('sha256').update(patch).digest('hex');
    if (bytes > PATCH_BYTES) {
        let savedHint = '';
        if (patchStore && bytes <= MAX_STORED_PATCH_BYTES) {
            try {
                const saved = patchStore.save(patch, { digest });
                savedHint = '（已将完整超限补丁暂存至本机补丁库，SHA-256: ' + saved.digest.slice(0, 12) + '）';
            } catch { /* ignore save error on oversized patch */ }
        }
        const statHint = diffStat ? '\n变更摘要：\n' + diffStat.slice(0, 800) : '';
        throw taskError('development-patch-too-large',
            '开发补丁体积 ' + (bytes / 1024).toFixed(1) + ' KiB 超过单工单上限（' + (PATCH_BYTES / 1024) + ' KiB），请拆分工单后审查。' + savedHint + statHint);
    }
    let stored = false;
    if (patchStore) {
        try {
            patchStore.save(patch, { digest });
            stored = true;
        } catch { /* inline fallback still works for small patches */ }
    }
    const roomRecordText = formatPatchRoomRecord(patch, { digest, stat: diffStat, stored });
    return { patch, digest, bytes, diffStat, roomRecordText };
}

const brief = (title, description, plan, extra) => JSON.stringify({ title, description, plan, ...extra });
const decisionFormat = '请返回严格 JSON，字段 action 可为 codex 或 continue，instruction 为具体说明。';
const verdictFormat = '请直接返回紧凑的严格 JSON（切勿展开冗长推演，最多列出最关键的 6 条，每条结论控制在 150 字以内）。verdict 为 pass、revise 或 blocked。裁决红线：严格尊重工单声明的修改范围，禁止因工单禁止修改的基线文件或范围外上游限制判 revise/blocked（此类观察可作为非阻断建议记录并判 pass）；仅对本补丁范围内引入的 P0/P1 阻断缺陷（构建/测试失败、崩溃、数据损坏、安全漏洞、主流程缺失）判 revise/blocked，轻微 P2 润色建议在 findings 记明后判 pass。findings 为带文件依据的字符串，或由 file 和 conclusion 两个字符串字段组成的对象数组。';

const RECOVERABLE_VERDICT_CODES = new Set(['response-incomplete', 'outcome-unknown', 'empty-output', 'size-limit', 'invalid-role-output']);

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

export async function applyDevelopmentPatch(workspacePathStr, patchText, signal = AbortSignal.timeout(30_000), options = {}) {
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
        let alreadyApplied = false;
        let applied = false;
        try {
            await gitExec('git', ['--no-pager', 'apply', '--reverse', '--check', '--', patchFile], {
                cwd: root, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal,
            });
            alreadyApplied = true;
        } catch { /* not yet applied; proceed to forward check */ }
        if (!alreadyApplied) {
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
            applied = true;
        }
        let committed = false;
        let commitHash;
        const commitMsg = typeof options?.commitMessage === 'string' ? options.commitMessage.trim() : '';
        if (commitMsg) {
            const touchedFiles = extractPatchTouchedFiles(patchText);
            if (touchedFiles.length > 0) {
                await gitExec('git', ['--no-pager', 'add', '-A', '--', ...touchedFiles], {
                    cwd: root, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal,
                });
                const staged = await git(root, ['diff', '--cached', '--name-only', '--', ...touchedFiles], signal).catch(() => '');
                if (staged.trim()) {
                    const hasName = (await git(root, ['config', 'user.name'], signal).catch(() => '')).trim();
                    const hasEmail = (await git(root, ['config', 'user.email'], signal).catch(() => '')).trim();
                    const authorArgs = (!hasName || !hasEmail)
                        ? ['-c', 'user.name=Marshal', '-c', 'user.email=marshal@local']
                        : [];
                    await gitExec('git', ['--no-pager', ...authorArgs, 'commit', '-m', commitMsg, '--', ...touchedFiles], {
                        cwd: root, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' }, signal,
                    });
                    commitHash = (await git(root, ['rev-parse', '--short', 'HEAD'], signal).catch(() => '')).trim() || undefined;
                    committed = true;
                }
            }
        }
        return {
            applied,
            alreadyApplied,
            ...(committed ? { committed: true, commitHash } : {}),
        };
    } finally {
        if (tempDir) {
            try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        lease.release();
    }
}

export async function runTaskDevelopment({
    card, getCard, path, plan, getPlan, signal, asLeader, asRole, runChild, record, handoff, phase, manual,
    leaderAutoReview = false, operatorNotes, patchStore, seedPatch,
}) {
    const readGuidance = async () => {
        try {
            const note = await operatorNotes?.();
            return typeof note === 'string' && note.trim() ? note.trim().slice(0, 6000) : '';
        } catch { return ''; }
    };
    const resolveCard = async () => (await getCard?.()) ?? card;
    const resolvePlan = () => getPlan?.() ?? plan;
    const initialCard = await resolveCard();
    const initialAttachments = Array.isArray(initialCard.resolvedAttachments) && initialCard.resolvedAttachments.length > 0 ? initialCard.resolvedAttachments : undefined;
    const repoContext = await readRepoContext(path, initialCard, signal);
    phase('designing');
    const designGuidance = await readGuidance();
    const design = await asLeader(withGuidance(
        '你负责设计和拆分开发任务。给出要修改的模块、边界、验收条件和可运行的测试。请严格基于 repoContext 中的真实分支、提交与文件存在情况设计方案，不要编造不存在的文件或旧提交。限制为 2500 字符。\n'
        + brief(initialCard.title, initialCard.description, resolvePlan(), {
            ...(repoContext ? { repoContext } : {}),
            ...(seedPatch ? { incrementalRevision: true } : {}),
            ...(initialAttachments ? { attachments: initialAttachments } : {}),
            ...(designGuidance ? { operatorGuidance: designGuidance } : {}),
        }),
        designGuidance), 'designing');
    signal.throwIfAborted();
    await record('agent', 'Leader', design, 'designing');
    const implementationPlan = await handoff('开发设计交接', design, 'designing');
    if (resolvePlan().codex?.coding === null) return manual(implementationPlan);

    return isolatedCheckout(path, signal, async (worktree, base, mountDeps, checkoutMeta) => {
        if (checkoutMeta?.dirtyFilesCount > 0) {
            await record('status', 'Marshal',
                '提示：宿主工作区存在 ' + checkoutMeta.dirtyFilesCount + ' 处未提交改动；本隔离工作树基于基准提交 ' + base.slice(0, 8) + ' 创建。若依赖前序工单改动，请先提交或合并后再运行。',
                'coding');
        }
        if (checkoutMeta?.seededFromPreviousPatch) {
            await record('status', 'Marshal', '已将上一轮未落盘补丁预载到隔离工作树，本轮将在上次改动基础上继续增量修正。', 'coding');
        } else if (seedPatch && checkoutMeta?.seedFailureReason) {
            await record('status', 'Marshal', '提示：未能自动预载上一轮补丁（' + checkoutMeta.seedFailureReason + '），将从当前 HEAD 重新构建。', 'coding');
        }
        const invokeDelegation = async (callFn, actorName, phaseName, fullPrompt, compactPrompt, fallbackDecision) => {
            try {
                const raw = await callFn(fullPrompt);
                await record('agent', actorName, raw, phaseName);
                return parseModelJson(raw, DelegationSchema);
            } catch (firstErr) {
                if (signal.aborted || !RECOVERABLE_VERDICT_CODES.has(firstErr?.code)) throw firstErr;
                try {
                    const retryRaw = await callFn(compactPrompt);
                    await record('agent', actorName, retryRaw, phaseName);
                    return parseModelJson(retryRaw, DelegationSchema);
                } catch (secondErr) {
                    if (signal.aborted || !RECOVERABLE_VERDICT_CODES.has(secondErr?.code)) throw secondErr;
                    if (fallbackDecision) {
                        await record('status', 'Marshal', actorName + ' 委派响应格式受限（' + (secondErr?.code || firstErr?.code) + '），已自动回退为直接进入下一步裁决。', phaseName);
                        return fallbackDecision;
                    }
                    throw secondErr;
                }
            }
        };
        const invokeVerdict = async (callFn, actorName, phaseName, fullPrompt, compactPrompt) => {
            try {
                const raw = await callFn(fullPrompt);
                await record('agent', actorName, raw, phaseName);
                return { ok: true, verdict: parseModelJson(raw, VerdictSchema) };
            } catch (firstErr) {
                if (signal.aborted || !RECOVERABLE_VERDICT_CODES.has(firstErr?.code)) throw firstErr;
                try {
                    const retryRaw = await callFn(compactPrompt);
                    await record('agent', actorName, retryRaw, phaseName);
                    return { ok: true, verdict: parseModelJson(retryRaw, VerdictSchema) };
                } catch (secondErr) {
                    if (signal.aborted || !RECOVERABLE_VERDICT_CODES.has(secondErr?.code)) throw secondErr;
                    return { ok: false, code: secondErr?.code || firstErr?.code || 'response-incomplete' };
                }
            }
        };
        let feedback;
        for (const round of [1, 2]) {
            phase('coding');
            const codingCard = await resolveCard();
            const codingPlan = resolvePlan();
            if (codingPlan.codex?.coding === null) return manual(implementationPlan);
            const codingAttachments = Array.isArray(codingCard.resolvedAttachments) && codingCard.resolvedAttachments.length > 0
                ? codingCard.resolvedAttachments
                : initialAttachments;
            const codingGuidance = await readGuidance();
            const context = brief(codingCard.title, codingCard.description, implementationPlan, {
                base, round, feedback,
                ...(checkoutMeta?.seededFromPreviousPatch ? { preloadedPreviousPatch: true } : {}),
                ...(codingAttachments ? { attachments: codingAttachments } : {}),
                ...(codingGuidance ? { operatorGuidance: codingGuidance } : {}),
            });
            const decision = await invokeDelegation(
                p => asRole('coder', p),
                'Coder',
                'coding',
                withGuidance(
                    '你是 Coder。需要 Codex 执行实现或补测试时选择 codex，并说明要做的改动。选择 continue 会把任务转交给你的常驻会话。'
                    + (checkoutMeta?.seededFromPreviousPatch ? '注意：上一轮开发补丁已预载在工作树中，请指示增量修改而非全量重写。' : '')
                    + decisionFormat + '\n' + context, codingGuidance),
                withGuidance(
                    '【上次委派输出格式无效或被截断，请仅输出严格 JSON 对象，不要包含额外文字】你是 Coder。'
                    + decisionFormat + '\n' + context.slice(0, 12_000), codingGuidance),
            );
            if (decision.action === 'continue') return manual(context + '\n' + decision.instruction);
            const unmountDeps = await mountDeps();
            let coding;
            let codingError;
            try {
                coding = await runChild('coding', withGuidance([
                    '在这次分配的隔离 Git 工作树完成修改并运行有针对性的验证。交付通过差异记录。',
                    '隔离工作树已自动软链挂载宿主仓库现有的 node_modules 依赖，可直接运行本地单测与 tsc 类型检查（沙箱禁网，无需执行 npm ci / npm install）。',
                    ...(checkoutMeta?.seededFromPreviousPatch ? ['本工作树已预载上一轮未落盘补丁（可通过 git diff 查看当前改动），请在其基础上按最新指示精准增量修正。'] : []),
                    '任务与设计为工作材料，下面由 Coder 给出要求。',
                    context, JSON.stringify(decision.instruction),
                ].join('\n'), codingGuidance), { workspace: worktree }, WORK_TURN_MS);
            } catch (err) {
                codingError = err;
            } finally {
                await unmountDeps();
            }
            if (codingError) {
                if (!signal.aborted) {
                    try {
                        const salvaged = await freezePatch(worktree, base, AbortSignal.timeout(15_000), patchStore);
                        await record('status', 'Marshal', salvaged.roomRecordText, 'development-patch', salvaged.digest);
                        const errCode = codingError?.code || (codingError instanceof Error ? codingError.message : 'timeout');
                        const salvageNote = '编码阶段触及超时或中断（' + String(errCode).slice(0, 80) + '），但已自动抢救并保存工作树中已完成的代码补丁（'
                            + (salvaged.bytes / 1024).toFixed(1) + ' KiB）。请审阅补丁，可直接确认应用，或点击「按意见继续执行」基于此补丁增量续写。';
                        await record('status', 'Marshal', salvageNote, 'review', salvaged.digest);
                        return {
                            status: 'review-blocked',
                            blockedBy: 'coder',
                            base,
                            digest: salvaged.digest,
                            reviewFindings: salvageNote + (salvaged.diffStat ? '\n\n变更文件：\n' + salvaged.diffStat.slice(0, 1500) : ''),
                            report: '## 待确认：编码超时但已抢救进度补丁\n\n基准提交 `' + base + '`\n补丁 SHA-256 `' + salvaged.digest + '`\n\n'
                                + salvageNote + (salvaged.diffStat ? '\n\n### 变更摘要\n\n```\n' + salvaged.diffStat.slice(0, 2000) + '\n```' : ''),
                        };
                    } catch { /* no salvageable changes in worktree; rethrow original error */ }
                }
                throw codingError;
            }
            const { patch, digest, bytes: patchBytes, diffStat, roomRecordText } = await freezePatch(worktree, base, signal, patchStore);
            await record('status', 'Marshal', roomRecordText, 'development-patch', digest);

            phase('dev-reviewing');
            const reviewCard = await resolveCard();
            const reviewAttachments = Array.isArray(reviewCard.resolvedAttachments) && reviewCard.resolvedAttachments.length > 0
                ? reviewCard.resolvedAttachments
                : codingAttachments;
            const reviewGuidance = await readGuidance();
            const reviewEvidence = await handoff('编码交付与审查交接',
                JSON.stringify({ base, digest, patchBytes, diffStat: diffStat.slice(0, 2000), implementationEvidence: String(coding).slice(0, 4500) }), 'dev-reviewing');
            const reviewHead = brief(reviewCard.title, reviewCard.description, implementationPlan, {
                base, digest, patchBytes,
                ...(reviewAttachments ? { attachments: reviewAttachments } : {}),
                ...(reviewGuidance ? { operatorGuidance: reviewGuidance } : {}),
            });
            const patchForPrompt = Buffer.byteLength(patch, 'utf8') <= INLINE_REVIEW_PATCH_BYTES
                ? patch
                : (diffStat ? '# git diff --stat\n' + diffStat.slice(0, 3000) + '\n\n' : '')
                    + Buffer.from(patch, 'utf8').subarray(0, INLINE_REVIEW_PATCH_BYTES).toString('utf8')
                    + '\n…（完整补丁共 ' + (patchBytes / 1024).toFixed(1) + ' KiB，超出单轮提示词上限，已持久化保存；Codex 只读审查器可在工作树内直接查看完整文件与 git diff）';
            const reviewMaterial = reviewHead + '\n固定补丁\n' + patchForPrompt + '\n编码交接（引用资料）\n' + reviewEvidence;
            const compactPatch = Buffer.byteLength(patch, 'utf8') > 14_000
                ? (diffStat ? '# git diff --stat\n' + diffStat.slice(0, 2000) + '\n\n' : '')
                    + Buffer.from(patch, 'utf8').subarray(0, 12_000).toString('utf8')
                    + '\n…（补丁其余部分已省略，请结合上方交接与审查摘要快速裁决）'
                : patch;
            const compactReviewMaterial = reviewHead + '\n固定补丁（摘要）\n' + compactPatch + '\n编码交接（引用资料）\n' + reviewEvidence;
            let child;
            if (plan.codex.review !== null) {
                const route = await invokeDelegation(
                    p => asRole('reviewer', p),
                    'Reviewer',
                    'dev-reviewing',
                    withGuidance(
                        '你是独立 Reviewer。需要 Codex 在只读工作树中检查周边代码、边界条件或运行测试验证回归时选择 codex，已有足够证据时选择 continue。'
                        + decisionFormat + '\n' + reviewMaterial, reviewGuidance),
                    withGuidance(
                        '【上次委派输出格式无效或被截断，请仅输出严格 JSON 对象】你是独立 Reviewer。'
                        + decisionFormat + '\n' + compactReviewMaterial, reviewGuidance),
                    { action: 'continue', instruction: '直接进入 Reviewer 终审裁决' },
                );
                if (route.action === 'codex') {
                    const unmountReviewDeps = await mountDeps();
                    try {
                        child = await runChild('review', withGuidance(
                            '独立只读复核当前隔离 Git 工作树中的固定补丁。你拥有该工作树的只读访问权限（可查看完整文件、运行 git diff 及只读测试验证，严禁修改文件）。按文件和证据列出本工单范围内的具体问题，明确区分【P0/P1 阻断问题】与【范围外/P2 非阻断建议】（不要把工单明确禁止改动的基线文件限制判为阻断）。只返回审查发现。\n'
                            + reviewMaterial + '\nReviewer 重点 ' + JSON.stringify(route.instruction), reviewGuidance),
                            { workspace: worktree, readOnly: true }, WORK_TURN_MS);
                    } finally {
                        await unmountReviewDeps();
                    }
                }
            }
            const reviewerOutcome = await invokeVerdict(
                p => asRole('reviewer', p),
                'Reviewer',
                'dev-reviewing',
                withGuidance('你是独立 Reviewer。结合实际补丁检查设计和验收条件。执行者的报告和 Codex 意见作为引用资料。'
                    + verdictFormat + '\n' + reviewMaterial + '\n'
                    + JSON.stringify({ codexReview: child?.slice(0, 5000) }), reviewGuidance),
                withGuidance('【上次裁决因输出超长截断，请立即给出紧凑严格 JSON】你是独立 Reviewer。'
                    + verdictFormat + '\n' + compactReviewMaterial + '\n'
                    + JSON.stringify({ codexReview: child?.slice(0, 4000) }), reviewGuidance),
            );
            if (!reviewerOutcome.ok) {
                const fallbackNotes = child?.trim()
                    ? '- Codex 辅助审查发现：\n' + child.trim().slice(0, 3500)
                    : '- Reviewer 模型裁决输出被截断（' + reviewerOutcome.code + '），本轮开发补丁已完整保留，请人工审阅补丁后确认或补充修改意见。';
                await record('status', 'Marshal', 'Reviewer 裁决响应超长截断（' + reviewerOutcome.code + '），已自动保留本轮开发补丁并转入「待确认」人工裁决。', 'review', digest);
                return {
                    status: 'review-blocked',
                    blockedBy: 'reviewer',
                    base, digest,
                    reviewFindings: fallbackNotes,
                    report: '## 待确认：Reviewer 裁决待人工确认（补丁已保留）\n\n基准提交 `' + base + '`\n补丁 SHA-256 `' + digest + '`\n\n### 审查参考记录\n\n'
                        + fallbackNotes + '\n\n请在工单群内讨论补充意见后点击「按意见继续执行」，或直接点击「应用补丁到工作区并完成」放行。',
                };
            }
            const verdict = reviewerOutcome.verdict;
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
                const leaderOutcome = await invokeVerdict(
                    p => asLeader(p, 'summarizing'),
                    'Leader',
                    'summarizing',
                    withGuidance('你是负责 Leader，现在执行自动终审。请复核 Reviewer 结论与补丁是否满足目标且未越界。'
                        + verdictFormat + '\n' + reviewMaterial + '\nReviewer 结论：\n' + formattedVerdict, leaderGuidance),
                    withGuidance('【上次终审因输出超长截断，请立即给出紧凑严格 JSON】你是负责 Leader，现在执行自动终审。'
                        + verdictFormat + '\n' + compactReviewMaterial + '\nReviewer 结论：\n' + formattedVerdict, leaderGuidance),
                );
                if (!leaderOutcome.ok) {
                    await record('status', 'Marshal', 'Leader 终审响应截断（' + leaderOutcome.code + '），已保留本轮开发补丁与 Reviewer 通过结论并转入「待确认」。', 'review', digest);
                    return {
                        status: 'review-blocked',
                        blockedBy: 'leader',
                        base, digest,
                        reviewFindings: formattedVerdict,
                        report: '## 待确认：Leader 终审待确认（Reviewer 已通过，补丁已保留）\n\n基准提交 `' + base + '`\n补丁 SHA-256 `' + digest + '`\n\n### Reviewer 结论\n\n'
                            + formattedVerdict + '\n\n请在工单群内确认后点击「应用补丁到工作区并完成」，或补充意见继续执行。',
                    };
                }
                const leaderVerdict = leaderOutcome.verdict;
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
    }, { seedPatch });
}
