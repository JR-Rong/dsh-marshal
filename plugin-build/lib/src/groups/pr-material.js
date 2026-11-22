const LINK = /^(https:\/\/(?:github\.com|gitee\.com))\/([a-z\d_.-]+)\/([a-z\d_.-]+)\/(pull|pulls)\/([1-9]\d{0,9})(?:\/(?:files|commits|checks))?\/?(?:[?#][^\r\n]*)?$/i;
const SHA = /^[a-f\d]{40}$/i;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const DIFF_LIMIT = 48 * 1024;

export function taskError(code, message) {
    return Object.assign(new Error(message), { code });
}

export function parsePullRequest(input) {
    const match = typeof input === 'string' ? LINK.exec(input.trim()) : null;
    if (!match || ['.', '..'].includes(match[2]) || ['.', '..'].includes(match[3])) {
        throw taskError('invalid-pr', '请输入 GitHub 或 Gitee 的 PR 链接。');
    }
    const [, site, owner, repo, path, number] = match;
    const github = site.toLowerCase() === 'https://github.com';
    if (path !== (github ? 'pull' : 'pulls')) throw taskError('invalid-pr', 'PR 链接的路径无效。');
    return {
        url: site.toLowerCase() + '/' + owner + '/' + repo + '/' + path + '/' + number,
        api: (github ? 'https://api.github.com' : 'https://gitee.com/api/v5') + '/repos/' + owner + '/' + repo,
        github, number,
    };
}

async function readJson(target, fetchImpl, signal, headers) {
    const response = await fetchImpl(target, { headers, signal, redirect: 'error' });
    if (!response.ok) {
        throw taskError('pr-fetch', '读取 PR 失败（HTTP ' + response.status + '）。请检查链接和仓库读取权限。');
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
        bytes += chunk.byteLength;
        if (bytes > RESPONSE_LIMIT) throw taskError('pr-too-large', 'PR 材料超过首版审查的读取上限。');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw taskError('pr-invalid-response', '仓库返回的 PR 材料无法解析。'); }
}

function hasCompletePatch(file) {
    if (typeof file.patch !== 'string' || file.patch === '') return false;
    if (!Number.isInteger(file.additions) || !Number.isInteger(file.deletions)) return true;
    let hunk = false;
    let additions = 0;
    let deletions = 0;
    for (const line of file.patch.split('\n')) {
        if (line.startsWith('@@')) hunk = true;
        else if (hunk && line.startsWith('+')) additions++;
        else if (hunk && line.startsWith('-')) deletions++;
    }
    return additions === file.additions && deletions === file.deletions;
}

export async function readPullRequest(input, signal, { fetchImpl = fetch, env = process.env } = {}) {
    const { github, api, url, number } = parsePullRequest(input);
    const token = github ? env.DSH_MARSHAL_GITHUB_TOKEN : env.DSH_MARSHAL_GITEE_TOKEN;
    const headers = { accept: github ? 'application/vnd.github+json' : 'application/json', 'user-agent': 'dsh-marshal' };
    if (github && token) headers.authorization = 'Bearer ' + token;
    const pull = async (path, query) => {
        const target = new URL(api + path);
        if (!github && token) target.searchParams.set('access_token', token);
        if (query) target.searchParams.set('per_page', query);
        try { return await readJson(target, fetchImpl, signal, headers); }
        catch (error) {
            if (error.code?.startsWith('pr-')) throw error;
            throw taskError('pr-fetch', '无法连接仓库以读取 PR 材料。');
        }
    };
    const pr = await pull('/pulls/' + number);
    const base = pr?.base?.sha;
    const head = pr?.head?.sha;
    if (typeof base !== 'string' || typeof head !== 'string' || !SHA.test(base) || !SHA.test(head)) {
        throw taskError('pr-invalid-response', '无法确定 PR 的基准和待审查提交。');
    }
    const comparison = await pull('/compare/' + base + '...' + head, github ? '1' : undefined);
    const files = comparison?.files;
    if (!Array.isArray(files) || files.length === 0) throw taskError('pr-empty', '当前提交无可审查的变更文件。');
    if (files.length >= 300 || (Number.isInteger(pr.changed_files) && files.length !== pr.changed_files)) {
        throw taskError('pr-incomplete', '仓库返回的比较文件列表不完整。');
    }
    const diff = [];
    const omitted = [];
    let bytes = 0;
    for (const file of files) {
        const path = typeof file?.filename === 'string' ? file.filename : '';
        if (path === '') throw taskError('pr-invalid-response', 'PR 文件列表中缺少路径。');
        if (!hasCompletePatch(file)) {
            omitted.push(path);
            continue;
        }
        const patch = JSON.stringify({ path, status: file.status, previousPath: file.previous_filename, patch: file.patch });
        bytes += Buffer.byteLength(patch) + 1;
        if (bytes > DIFF_LIMIT) throw taskError('pr-too-large', 'PR 文本变更超过 48 KiB，请拆分后审查。');
        diff.push(patch);
    }
    if (diff.length === 0) throw taskError('pr-empty', '仓库未提供可审查的文本补丁。');
    return { url, base, head, diff: diff.join('\n'), omitted };
}
