import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
/** 没读到的面不要带上空数组，避免 Hub 用空快照盖掉别的设备或手机刚改的内容。 */
export function forwardBody(input) {
    return {
        read: true,
        ...(input.tasks === null ? {} : { tasks: input.tasks }),
        ...(input.memory === null ? {} : { memory: input.memory }),
        ...(input.roster === null ? {} : { roster: input.roster }),
    };
}
export function rosterFromLedger(ledger, deviceId) {
    const agents = [];
    for (const team of ledger?.teams ?? []) {
        for (const member of team.members ?? []) {
            if (typeof member.name !== 'string' || !member.name.trim())
                continue;
            agents.push({
                deviceId,
                agent: typeof member.id === 'string' && member.id ? member.id : 'dsh',
                name: member.name.trim(),
            });
        }
    }
    return agents;
}
/** 只读私有层和项目层。内容共享关闭时不外发，调用方应省略这个字段而不是上报空数组。 */
export function readMemoryDir(root, allowContent, cap = 24_000) {
    if (!allowContent)
        return null;
    const entries = [];
    let used = 0;
    const take = (id, layer, file) => {
        if (used >= cap)
            return;
        let text = '';
        try {
            text = readFileSync(file, 'utf8');
        }
        catch {
            return;
        }
        text = text.slice(0, Math.max(0, cap - used));
        if (!text.trim())
            return;
        used += text.length;
        entries.push({ id, layer, agent: '', text });
    };
    take('rules', 'private', join(root, 'global', 'rules.md'));
    take('profile', 'private', join(root, 'global', 'profile.md'));
    let names = [];
    try {
        names = readdirSync(join(root, 'workspaces'));
    }
    catch {
        names = [];
    }
    for (const name of names) {
        take(name + '/handoff', 'workspace', join(root, 'workspaces', name, 'handoff.md'));
        take(name + '/notes', 'workspace', join(root, 'workspaces', name, 'notes.md'));
    }
    return entries;
}
export function hubHttpOrigin(hubUrl) {
    const url = new URL(hubUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
    return url.origin;
}
/** 节点上报走自己的 Bearer 前缀，并使用配置里的私有 CA。 */
export function postNodeJson(input) {
    const url = new URL(input.path, input.origin);
    const payload = Buffer.from(JSON.stringify(input.body));
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
        const req = lib.request(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': String(payload.length),
                authorization: 'Bearer mnd1.' + input.token,
            },
            ...(input.ca && url.protocol === 'https:' ? { ca: input.ca } : {}),
        }, (res) => {
            res.resume();
            resolve({ status: res.statusCode ?? 0 });
        });
        req.on('error', () => resolve({ status: 0 }));
        req.end(payload);
    });
}
const BOARD_KINDS = ['create', 'delete', 'run', 'edit', 'move'];
/** 没有 capabilities() 就不调用 apply。现有实现会把不认识的 kind 静默忽略，不能拿来假装写成功。 */
export function boardCapabilities(board) {
    const read = typeof board?.snapshot === 'function';
    let advertised;
    try {
        advertised = board?.capabilities?.();
    }
    catch { /* The Host cannot confirm write support. */ }
    const apply = Array.isArray(advertised?.apply)
        ? advertised.apply.filter((kind) => BOARD_KINDS.includes(kind))
        : [];
    return { read, revision: advertised?.revision === true, apply };
}
function asTasks(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    if (!Array.isArray(record.tasks))
        return null;
    const revision = record.revision;
    return { tasks: record.tasks, revision: typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : null };
}
async function readBoard(board) {
    try {
        return asTasks(await board?.snapshot?.());
    }
    catch {
        return null;
    }
}
async function readPhoneMemory(memory, allowContent) {
    if (!allowContent)
        return { code: 'withheld' };
    try {
        const result = await memory?.readPhone?.({ allowContent, capBytes: 24_000 });
        if (typeof result === 'object' && result !== null) {
            const { entries, code } = result;
            if (code === 'withheld')
                return { code };
            if (code === undefined && Array.isArray(entries))
                return { entries };
        }
    }
    catch { /* A failed read carries no snapshot. */ }
    return { code: 'unavailable' };
}
export async function readPhoneFaces(host, allowContent) {
    const [board, memory] = await Promise.all([readBoard(host?.board), readPhoneMemory(host?.memory, allowContent)]);
    let roster = null;
    if (typeof host?.roster?.list === 'function') {
        try {
            const result = await host.roster.list();
            if (typeof result === 'object' && result !== null && Array.isArray(result.agents)) {
                roster = result.agents;
            }
        }
        catch {
            roster = null;
        }
    }
    return { tasks: board?.tasks ?? null, revision: board?.revision ?? null, memory, roster };
}
export async function applyBoardCommand(host, command) {
    const caps = boardCapabilities(host?.board);
    if (!caps.revision || !caps.apply.includes(command.action) || typeof host?.board?.apply !== 'function') {
        return { ok: false, code: 'unsupported' };
    }
    try {
        const before = await readBoard(host.board);
        if (before?.revision != null && before.revision !== command.baseRevision) {
            return { ok: false, code: 'conflict' };
        }
        const snap = asTasks(await host.board.apply(command.id, {
            kind: command.action,
            baseRevision: command.baseRevision,
            ...(command.taskId === undefined ? {} : { taskId: command.taskId }),
            ...(command.title === undefined ? {} : { input: { title: command.title } }),
            ...(command.status === undefined ? {} : { status: command.status }),
        }));
        const expectedBase = before?.revision ?? command.baseRevision;
        if (snap?.revision == null || snap.revision < expectedBase)
            return { ok: false, code: 'unavailable' };
        if (snap.revision === expectedBase) {
            return { ok: false, code: 'conflict' };
        }
        return { ok: true, revision: snap.revision };
    }
    catch (error) {
        const code = typeof error === 'object' && error !== null && error.code;
        if (code === 'conflict')
            return { ok: false, code: 'conflict' };
        return { ok: false, code: 'unavailable' };
    }
}
export function startPhoneRelay(input) {
    let stopped = false;
    let running = false;
    const post = (path, body) => postNodeJsonRead({
        origin: input.origin,
        path: '/marshal/api/' + path,
        token: input.token,
        body,
        ...(input.ca === undefined ? {} : { ca: input.ca }),
    });
    const postBoard = (board, outcomes) => post('board', {
        ...forwardBody({ tasks: board.tasks, memory: null, roster: null }),
        deviceId: input.deviceId,
        ...(board.revision === null ? {} : { revision: board.revision }),
        ...outcomes,
    });
    const tick = async () => {
        const grant = input.contentGrant();
        const faces = await readPhoneFaces(input.host(), grant !== undefined);
        if (stopped)
            return;
        const current = input.contentGrant();
        const memory = grant && grant.connectionId === current?.connectionId && grant.policyRevision === current.policyRevision
            ? { ...faces.memory, ...grant }
            : { code: 'withheld' };
        const [first] = await Promise.all([
            postBoard(faces),
            post('memory', memory),
            faces.roster === null ? undefined : post('roster', { agents: faces.roster }),
        ]);
        if (stopped || first.status !== 200)
            return;
        const commands = Array.isArray(first.body?.commands)
            ? first.body.commands
            : [];
        const applied = [];
        const rejected = [];
        for (const command of commands) {
            if (stopped)
                return;
            if (typeof command.id !== 'string' || typeof command.action !== 'string' || typeof command.baseRevision !== 'number')
                continue;
            const result = await applyBoardCommand(input.host(), {
                id: command.id,
                action: command.action,
                baseRevision: command.baseRevision,
                ...(typeof command.taskId === 'string' ? { taskId: command.taskId } : {}),
                ...(typeof command.title === 'string' ? { title: command.title } : {}),
                ...(typeof command.status === 'string' ? { status: command.status } : {}),
            });
            if (result.ok)
                applied.push(command.id);
            else
                rejected.push({ id: command.id, code: result.code });
        }
        if (applied.length === 0 && rejected.length === 0)
            return;
        const after = await readBoard(input.host()?.board);
        if (!stopped)
            await postBoard(after ?? { tasks: null, revision: null }, { applied, rejected });
    };
    const run = () => {
        if (stopped || running)
            return;
        running = true;
        void tick().catch(() => { }).finally(() => { running = false; });
    };
    const timer = setInterval(run, input.intervalMs ?? 15_000);
    timer.unref?.();
    run();
    return () => { stopped = true; clearInterval(timer); };
}
function postNodeJsonRead(input) {
    const url = new URL(input.path, input.origin);
    const payload = Buffer.from(JSON.stringify(input.body));
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
        const req = lib.request(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': String(payload.length),
                authorization: 'Bearer mnd1.' + input.token,
            },
            ...(input.ca && url.protocol === 'https:' ? { ca: input.ca } : {}),
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('error', () => resolve({ status: 0, body: { ok: false, code: 'network' } }));
            res.on('end', () => {
                let body = {};
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                }
                catch {
                    body = {};
                }
                resolve({ status: res.statusCode ?? 0, body });
            });
        });
        req.setTimeout(8_000, () => req.destroy());
        req.on('error', () => resolve({ status: 0, body: { ok: false, code: 'network' } }));
        req.end(payload);
    });
}
