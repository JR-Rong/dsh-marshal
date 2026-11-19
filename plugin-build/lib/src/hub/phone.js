import { randomBytes } from 'node:crypto';
import { phoneTokenDigest, sha256Hex } from "./devices.js";
import { qrSvg } from "./qr.js";
export const PAIRING_TTL_MS = 60_000;
export const MAX_OPEN_CODES = 8;
export const PHONE_PREFIX = 'mph1.';
export const NODE_PREFIX = 'mnd1.';
const UNSAFE_APPROVAL = /always|persist|remember|session|don'?t\s*ask|总是|始终|会话内/i;
export function parseBearer(header) {
    if (!header)
        return undefined;
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match?.[1])
        return undefined;
    const value = match[1];
    if (value.startsWith(PHONE_PREFIX))
        return { kind: 'phone', token: value.slice(PHONE_PREFIX.length) };
    if (value.startsWith(NODE_PREFIX))
        return { kind: 'node', token: value.slice(NODE_PREFIX.length) };
    return undefined;
}
const ONCE_MARK = /once|这一次|仅此一次|允许一次|只这一次/;
export function onceDecisionIds(card) {
    if (typeof card !== 'object' || card === null)
        return null;
    const record = card;
    const approval = typeof record.approval === 'object' && record.approval !== null
        ? record.approval
        : undefined;
    if (!approval)
        return { approval: false, onceIds: new Set() };
    const onceIds = new Set();
    if (Array.isArray(approval.decisions)) {
        for (const raw of approval.decisions) {
            if (typeof raw !== 'object' || raw === null)
                continue;
            const decision = raw;
            const id = typeof decision.id === 'string' ? decision.id : '';
            const label = typeof decision.label === 'string' ? decision.label : '';
            if (!id || UNSAFE_APPROVAL.test(id) || UNSAFE_APPROVAL.test(label))
                continue;
            if (ONCE_MARK.test(id) || ONCE_MARK.test(label))
                onceIds.add(id);
        }
    }
    return { approval: true, onceIds };
}
/** 审批必须对上 Hub 已经见过的卡片，并且只能选「这一次」。提问不受这道限制。 */
export function phoneAnswerAllowed(args, card) {
    if (!card)
        return false;
    if (!card.approval)
        return true;
    if (card.onceIds.size === 0)
        return false;
    if (typeof args !== 'object' || args === null || !Array.isArray(args.answers))
        return false;
    return args.answers.every((answer) => {
        if (typeof answer !== 'object' || answer === null)
            return false;
        const row = answer;
        const selected = Array.isArray(row.selectedOptionIds)
            ? row.selectedOptionIds.filter((id) => typeof id === 'string' && id.length > 0)
            : [];
        const ids = selected.length > 0 ? selected : (typeof row.id === 'string' ? [row.id] : []);
        return ids.length > 0 && ids.every((id) => card.onceIds.has(id));
    });
}
export function controllerCommandAllowed(op, args, card) {
    const allowed = new Set(['prompt', 'answer', 'interrupt', 'create', 'fork', 'observe', 'cancel']);
    if (!allowed.has(op))
        return false;
    if (op !== 'answer')
        return true;
    return phoneAnswerAllowed(args, card);
}
function digest(value) {
    return phoneTokenDigest(value);
}
function nodeDigest(value) {
    return sha256Hex(value);
}
export function createPhoneHub(options) {
    const now = options.now ?? Date.now;
    const codes = new Map();
    const tasks = new Map();
    const queued = new Map();
    const memory = new Map();
    const roster = new Map();
    const streams = new Map();
    const boardRevision = new Map();
    const watched = new Map();
    const MAX_WATCHED = 32;
    const purgeCodes = () => {
        const at = now();
        for (const [code, item] of codes)
            if (item.expiresAt <= at)
                codes.delete(code);
        while (codes.size > MAX_OPEN_CODES) {
            const oldest = codes.keys().next().value;
            if (oldest === undefined)
                break;
            codes.delete(oldest);
        }
    };
    function authenticate(token) {
        if (!token)
            return { ok: false, code: 'unauthorized' };
        const row = options.store.findByTokenDigest(digest(token));
        if (!row || row.role !== 'phone')
            return { ok: false, code: 'unauthorized' };
        if (row.revoked)
            return { ok: false, code: 'revoked' };
        if (options.ownerHash && row.accountHash && row.accountHash !== options.ownerHash)
            return { ok: false, code: 'cross-account' };
        return { ok: true, phone: row };
    }
    function authenticateNode(token) {
        if (!token)
            return { ok: false, code: 'unauthorized' };
        const row = options.findNode?.(nodeDigest(token));
        if (!row || row.role === 'phone')
            return { ok: false, code: 'unauthorized' };
        if (row.revoked)
            return { ok: false, code: 'revoked' };
        return { ok: true, device: row };
    }
    return {
        authenticate,
        authenticateNode,
        issuePairing(accountHash, hubOrigin, replace) {
            purgeCodes();
            if (options.ownerHash && accountHash !== options.ownerHash) {
                throw Object.assign(new Error('cross-account'), { code: 'cross-account' });
            }
            // 刷新二维码时作废同一账号尚未使用的旧码，只留即将显示的这一张。
            if (replace) {
                const previous = codes.get(replace);
                if (previous?.accountHash === accountHash) {
                    for (const [code, item] of codes)
                        if (item.accountHash === accountHash)
                            codes.delete(code);
                }
            }
            while (codes.size >= MAX_OPEN_CODES) {
                const oldest = codes.keys().next().value;
                if (oldest === undefined)
                    break;
                codes.delete(oldest);
            }
            const code = randomBytes(16).toString('base64url');
            const expiresAt = now() + PAIRING_TTL_MS;
            codes.set(code, { accountHash, expiresAt });
            const url = 'marshal://pair?code=' + encodeURIComponent(code) + '&hub=' + encodeURIComponent(hubOrigin);
            return { code, expiresAt, url, svg: qrSvg(url) };
        },
        redeem(code, name, installationId) {
            purgeCodes();
            const found = codes.get(code);
            codes.delete(code);
            if (!found || found.expiresAt <= now())
                throw Object.assign(new Error('unknown'), { code: 'unknown' });
            if (options.ownerHash && found.accountHash !== options.ownerHash) {
                throw Object.assign(new Error('cross-account'), { code: 'cross-account' });
            }
            const created = options.store.enrollPhone({ name, accountHash: found.accountHash, installationId });
            const open = streams.get(created.record.id);
            streams.delete(created.record.id);
            open?.forEach((close) => close());
            return created;
        },
        revoke(id) {
            options.store.revoke(id);
            const open = streams.get(id);
            streams.delete(id);
            open?.forEach((close) => close());
        },
        watch(auth, key) {
            if (!auth.ok || !key)
                return;
            const set = watched.get(auth.phone.id) ?? new Set();
            if (!set.has(key) && set.size >= MAX_WATCHED)
                return;
            set.add(key);
            watched.set(auth.phone.id, set);
        },
        watchedBy(phoneId) {
            return watched.get(phoneId) ?? new Set();
        },
        seen(phoneId) {
            options.store.touchPhone(phoneId, now());
        },
        attachStream(phoneId, close) {
            const set = streams.get(phoneId) ?? new Set();
            set.add(close);
            streams.set(phoneId, set);
            options.store.touchPhone(phoneId, now());
            return () => { set.delete(close); if (set.size === 0)
                streams.delete(phoneId); };
        },
        listPhones() {
            const at = now();
            return options.store.phones().map((phone) => ({
                id: phone.id,
                name: phone.name,
                online: (streams.get(phone.id)?.size ?? 0) > 0
                    || (typeof phone.lastSeen === 'number' && at - phone.lastSeen < 45_000),
            }));
        },
        tasksFor(deviceId) {
            if (deviceId)
                return tasks.get(deviceId) ?? [];
            return [...tasks.values()].flat();
        },
        commandsFor(deviceId) {
            return queued.get(deviceId) ?? [];
        },
        writeTasks(auth, body) {
            if (!auth.ok)
                throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
            if ('device' in auth) {
                if (body.read !== true)
                    return { tasks: tasks.get(auth.device.id) ?? [], conflict: false };
                if (typeof body.revision === 'number' && Number.isInteger(body.revision) && body.revision >= 0) {
                    boardRevision.set(auth.device.id, body.revision);
                }
                const next = normalizeTasks(body.tasks, auth.device.id, boardRevision.get(auth.device.id));
                tasks.set(auth.device.id, next);
                const drop = new Set();
                if (Array.isArray(body.applied)) {
                    for (const id of body.applied)
                        if (typeof id === 'string')
                            drop.add(id);
                }
                if (Array.isArray(body.rejected)) {
                    for (const item of body.rejected) {
                        if (typeof item === 'object' && item !== null && typeof item.id === 'string') {
                            drop.add(item.id);
                        }
                    }
                }
                if (drop.size > 0) {
                    queued.set(auth.device.id, (queued.get(auth.device.id) ?? []).filter((command) => !drop.has(command.id)));
                }
                return { tasks: next, conflict: false };
            }
            const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
            if (!deviceId)
                throw Object.assign(new Error('invalid'), { code: 'invalid' });
            const current = tasks.get(deviceId) ?? [];
            const head = boardRevision.get(deviceId);
            if (head === undefined)
                return { tasks: current, conflict: true };
            const base = typeof body.baseRevision === 'number' ? body.baseRevision : head;
            if (base !== head)
                return { tasks: current, conflict: true };
            const action = body.action;
            if (action !== 'create' && action !== 'edit' && action !== 'move' && action !== 'delete') {
                throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
            }
            const command = {
                id: randomBytes(16).toString('hex'),
                deviceId,
                action,
                baseRevision: base,
                ...(typeof body.title === 'string' ? { title: body.title.slice(0, 120) } : {}),
                ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
                ...(body.status === 'todo' || body.status === 'doing' || body.status === 'done' ? { status: body.status } : {}),
            };
            queued.set(deviceId, [...(queued.get(deviceId) ?? []), command]);
            return { tasks: current, conflict: false };
        },
        readMemory(deviceId) {
            return deviceId ? (memory.get(deviceId) ?? []) : [...memory.values()].flat();
        },
        writeMemory(auth, entries) {
            if (!auth.ok)
                throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
            const next = normalizeMemory(entries, auth.device.id);
            memory.set(auth.device.id, next);
            return next;
        },
        readRoster(deviceId) {
            return deviceId ? (roster.get(deviceId) ?? []) : [...roster.values()].flat();
        },
        writeRoster(auth, agents) {
            if (!auth.ok)
                throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
            const next = normalizeRoster(agents, auth.device.id);
            roster.set(auth.device.id, next);
            return next;
        },
        registerPush(auth, target) {
            if (!auth.ok || !target.token)
                throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
            options.store.setPhonePush(auth.phone.id, target);
        },
    };
}
function normalizeTasks(raw, deviceId, boardRevision) {
    if (!Array.isArray(raw))
        return [];
    const cards = [];
    for (const row of raw) {
        if (typeof row !== 'object' || row === null)
            continue;
        const item = row;
        if (typeof item.id !== 'string' || typeof item.title !== 'string' || !item.title.trim())
            continue;
        cards.push({
            id: item.id.slice(0, 80),
            deviceId,
            title: item.title.trim().slice(0, 120),
            detail: typeof item.detail === 'string' ? item.detail.slice(0, 2000) : '',
            status: item.status === 'doing' || item.status === 'done' ? item.status : 'todo',
            revision: typeof boardRevision === 'number'
                ? boardRevision
                : (typeof item.revision === 'number' ? item.revision : 0),
        });
    }
    return cards;
}
function normalizeMemory(raw, deviceId) {
    if (!Array.isArray(raw))
        return [];
    const entries = [];
    let used = 0;
    for (const row of raw) {
        if (typeof row !== 'object' || row === null)
            continue;
        const item = row;
        if (typeof item.text !== 'string' || !item.text)
            continue;
        const text = item.text.slice(0, 2000);
        used += text.length;
        if (used > 24_000)
            break;
        entries.push({
            id: typeof item.id === 'string' ? item.id.slice(0, 80) : 'mem-' + String(entries.length),
            deviceId,
            layer: item.layer === 'workspace' ? 'workspace' : 'private',
            agent: typeof item.agent === 'string' ? item.agent.slice(0, 80) : '',
            text,
        });
    }
    return entries;
}
function normalizeRoster(raw, deviceId) {
    if (!Array.isArray(raw))
        return [];
    const agents = [];
    for (const row of raw) {
        if (typeof row !== 'object' || row === null)
            continue;
        const item = row;
        if (typeof item.name !== 'string' || !item.name.trim())
            continue;
        agents.push({
            deviceId,
            agent: typeof item.agent === 'string' ? item.agent.slice(0, 80) : 'dsh',
            name: item.name.trim().slice(0, 80),
        });
    }
    return agents;
}
/** 到期前 5 秒更换，和桌面「手机连接」弹层用的是同一个提前量。 */
export function pairingRefreshDelay(expiresAt, at) {
    return Math.max(1_000, expiresAt - at - 5_000);
}
export function pairingPage(url, code, expiresAt, csrfCookie) {
    const payload = JSON.stringify({ code, expiresAt, url }).replace(/</g, '\\u003c');
    return `<!doctype html><meta charset="utf-8"><title>手机配对</title>
<body style="font-family:sans-serif;background:#151719;color:#edf0f3">
<main><h1>手机配对</h1>
<p>二维码只有 Hub 地址和 60 秒一次性配对码。到期前 5 秒自动更换，旧码立即作废。</p>
<div id="qr">${qrSvg(url)}</div>
<p id="status"></p></main>
<script>
const csrfName = ${JSON.stringify(csrfCookie)};
let current = ${payload};
const status = document.getElementById('status');
const qr = document.getElementById('qr');
function csrf() {
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const item = part.trim();
    if (item.startsWith(csrfName + '=')) return decodeURIComponent(item.slice(csrfName.length + 1));
  }
  return '';
}
function paint() {
  const left = Math.max(0, Math.round((current.expiresAt - Date.now()) / 1000));
  status.textContent = left > 0 ? '剩余 ' + left + ' 秒，到期前 5 秒自动更换' : '正在更换配对码…';
}
async function rotate() {
  const response = await fetch('/marshal/api/pairing', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-marshal-csrf': csrf() },
    body: JSON.stringify({ replace: current.code }),
  });
  if (!response.ok) { status.textContent = '更换失败，请重新打开这个页面'; return; }
  const next = await response.json();
  if (!next || typeof next.url !== 'string' || typeof next.code !== 'string' || typeof next.expiresAt !== 'number') return;
  current = next;
  qr.innerHTML = typeof next.svg === 'string' ? next.svg : '';
  arm();
}
function arm() {
  paint();
  const delay = Math.max(1000, current.expiresAt - Date.now() - 5000);
  setTimeout(() => { rotate().catch(() => { status.textContent = '更换失败，请重新打开这个页面'; }); }, delay);
}
setInterval(paint, 1000);
arm();
</script></body>`;
}
