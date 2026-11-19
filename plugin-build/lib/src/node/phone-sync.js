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
    const advertised = typeof board?.capabilities === 'function' ? board.capabilities() : undefined;
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
    return { tasks: record.tasks, revision: typeof record.revision === 'number' ? record.revision : null };
}
/** 只上报主机真的返回的面。读失败或方法不存在时该面是 null，不能补成空数组。 */
export async function readPhoneFaces(host, allowContent) {
    let tasks = null;
    let revision = null;
    if (typeof host?.board?.snapshot === 'function') {
        try {
            const snap = asTasks(await host.board.snapshot());
            if (snap) {
                tasks = snap.tasks;
                revision = snap.revision;
            }
        }
        catch {
            tasks = null;
        }
    }
    let memory = null;
    if (typeof host?.memory?.readPhone === 'function') {
        try {
            const result = await host.memory.readPhone({ allowContent, capBytes: 24_000 });
            if (typeof result === 'object' && result !== null && Array.isArray(result.entries)) {
                memory = result.entries;
            }
        }
        catch {
            memory = null;
        }
    }
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
    return { tasks, memory, roster, revision };
}
export async function applyBoardCommand(host, command) {
    const caps = boardCapabilities(host?.board);
    if (!caps.apply.includes(command.action) || typeof host?.board?.apply !== 'function') {
        return { ok: false, code: 'unsupported' };
    }
    try {
        const snap = asTasks(await host.board.apply(command.id, {
            kind: command.action,
            baseRevision: command.baseRevision,
            ...(command.taskId === undefined ? {} : { taskId: command.taskId }),
            ...(command.title === undefined ? {} : { input: { title: command.title } }),
            ...(command.status === undefined ? {} : { status: command.status }),
        }));
        if (!snap)
            return { ok: false, code: 'unavailable' };
        if (caps.revision && snap.revision !== null && snap.revision === command.baseRevision) {
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
    const postBoard = (body) => postNodeJsonRead({
        origin: input.origin,
        path: '/marshal/api/board',
        token: input.token,
        body,
        ...(input.ca === undefined ? {} : { ca: input.ca }),
    });
    const tick = async () => {
        if (stopped)
            return;
        const faces = await readPhoneFaces(input.host(), input.allowContent);
        const memory = input.allowContent ? faces.memory : null;
        if (memory !== null) {
            await postNodeJsonRead({
                origin: input.origin, path: '/marshal/api/memory', token: input.token,
                body: { entries: memory },
                ...(input.ca === undefined ? {} : { ca: input.ca }),
            });
        }
        if (faces.roster !== null) {
            await postNodeJsonRead({
                origin: input.origin, path: '/marshal/api/roster', token: input.token,
                body: { agents: faces.roster },
                ...(input.ca === undefined ? {} : { ca: input.ca }),
            });
        }
        const first = await postBoard({
            ...forwardBody({ tasks: faces.tasks, memory: null, roster: null }),
            deviceId: input.deviceId,
            ...(faces.revision === null ? {} : { revision: faces.revision }),
        });
        const commands = Array.isArray(first.body?.commands)
            ? first.body.commands
            : [];
        const applied = [];
        const rejected = [];
        for (const command of commands) {
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
        const after = await readPhoneFaces(input.host(), input.allowContent);
        await postBoard({
            ...forwardBody({ tasks: after.tasks, memory: null, roster: null }),
            deviceId: input.deviceId,
            ...(after.revision === null ? {} : { revision: after.revision }),
            applied,
            rejected,
        });
    };
    const timer = setInterval(() => { void tick(); }, input.intervalMs ?? 15_000);
    timer.unref?.();
    void tick();
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
        req.on('error', () => resolve({ status: 0, body: { ok: false, code: 'network' } }));
        req.end(payload);
    });
}
