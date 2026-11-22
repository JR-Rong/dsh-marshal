import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { phoneTokenDigest, sha256Hex } from "./devices.js";
import { qrSvg } from "./qr.js";
export const PAIRING_TTL_MS = 60_000;
export const MAX_OPEN_CODES = 8;
export const PHONE_PREFIX = 'mph1.';
export const NODE_PREFIX = 'mnd1.';
const ALLOWED_DECISION = new Set(['accept', 'decline', 'cancel']);
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
/** 审批只允许 accept、decline、cancel 这三个 id。其它 id 一律拒绝。提问没有 approval，不受这道限制。 */
export function onceDecisionIds(card) {
    if (typeof card !== 'object' || card === null)
        return null;
    const record = card;
    const approval = typeof record.approval === 'object' && record.approval !== null
        ? record.approval
        : undefined;
    if (!approval)
        return { approval: false, allowedIds: new Set() };
    const allowedIds = new Set();
    if (Array.isArray(approval.decisions)) {
        for (const raw of approval.decisions) {
            if (typeof raw !== 'object' || raw === null)
                continue;
            const id = raw.id;
            if (typeof id === 'string' && ALLOWED_DECISION.has(id))
                allowedIds.add(id);
        }
    }
    return { approval: true, allowedIds };
}
/** 审批必须对上 Hub 已经见过的卡片，并且只能选卡片上的非持久决定。提问不受这道限制。 */
export function phoneAnswerAllowed(args, card) {
    if (!card)
        return false;
    if (!card.approval)
        return true;
    if (card.allowedIds.size === 0)
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
        return ids.length > 0 && ids.every((id) => card.allowedIds.has(id));
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
    const receipts = new Map();
    const memory = new Map();
    const roster = new Map();
    const streams = new Map();
    const boardRevision = new Map();
    const boardConnection = new Map();
    const watched = new Map();
    const MAX_WATCHED = 32;
    const MAX_COMMANDS = 32;
    const MAX_RECEIPTS = 64;
    const COMMAND_TTL_MS = 2 * 60_000;
    const MEMORY_TTL_MS = 45_000;
    const MAX_CARDS = 64;
    const CARD_TTL_MS = 15 * 60_000;
    const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
    const cardFile = join(dirname(options.store.file), 'pending-cards.json');
    const pendingCards = new Map();
    const loadCards = () => {
        let raw = '';
        try {
            raw = readFileSync(cardFile, 'utf8');
        }
        catch {
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (!Array.isArray(parsed))
            return;
        const at = now();
        for (const row of parsed) {
            if (typeof row !== 'object' || row === null)
                continue;
            const item = row;
            if (typeof item.requestId !== 'string' || typeof item.expiresAt !== 'number' || item.expiresAt <= at)
                continue;
            const allowedIds = new Set();
            if (Array.isArray(item.allowedIds)) {
                for (const id of item.allowedIds)
                    if (typeof id === 'string' && id)
                        allowedIds.add(id);
            }
            pendingCards.set(item.requestId, {
                card: { approval: item.approval === true, allowedIds },
                expiresAt: item.expiresAt,
            });
        }
    };
    const saveCards = () => {
        const at = now();
        const rows = [...pendingCards.entries()]
            .filter(([, item]) => item.expiresAt > at)
            .map(([requestId, item]) => ({
            requestId,
            approval: item.card.approval,
            allowedIds: [...item.card.allowedIds],
            expiresAt: item.expiresAt,
        }));
        try {
            writeFileSync(cardFile, JSON.stringify(rows), { mode: 0o600 });
        }
        catch { /* 卡片缓存写失败不影响应答 */ }
    };
    loadCards();
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
    function recordReceipt(pending, state, code) {
        const { id, deviceId, action } = pending.command;
        const history = receipts.get(pending.phoneId) ?? new Map();
        history.delete(id);
        history.set(id, { id, deviceId, action, state, ...(code === undefined ? {} : { code }) });
        if (history.size > MAX_RECEIPTS) {
            const oldest = history.keys().next().value;
            if (oldest !== undefined)
                history.delete(oldest);
        }
        receipts.set(pending.phoneId, history);
    }
    function currentQueue(deviceId) {
        const queue = queued.get(deviceId) ?? [];
        if (queue.length === 0)
            return queue;
        const at = now();
        const active = queue.filter((pending) => {
            if (pending.expiresAt > at)
                return true;
            recordReceipt(pending, 'unconfirmed', 'expired');
            return false;
        });
        if (active.length === 0)
            queued.delete(deviceId);
        else if (active.length !== queue.length)
            queued.set(deviceId, active);
        return active;
    }
    function memoryGrant(id) {
        const device = options.store.findById(id);
        const connectionId = options.nodeConnection?.(id);
        if (!device || !connectionId || device.revoked || device.role === 'phone' || !device.allowContent
            || options.store.isRecoveryRequired(id))
            return undefined;
        const accountHash = options.accountOwnerForNode?.(device) ?? device.accountHash ?? options.ownerHash;
        if (!accountHash)
            return undefined;
        return { device, connectionId, accountHash };
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
            receipts.delete(id);
            for (const [deviceId, queue] of queued) {
                const active = queue.filter(pending => pending.phoneId !== id);
                if (active.length === 0)
                    queued.delete(deviceId);
                else if (active.length !== queue.length)
                    queued.set(deviceId, active);
            }
            const open = streams.get(id);
            streams.delete(id);
            open?.forEach((close) => close());
        },
        rememberCard(requestId, card, expiresAt) {
            const at = now();
            for (const [id, item] of pendingCards)
                if (item.expiresAt <= at)
                    pendingCards.delete(id);
            const expiry = typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : at + CARD_TTL_MS;
            if (!(expiry > at)) {
                if (pendingCards.delete(requestId))
                    saveCards();
                return false;
            }
            if (!pendingCards.has(requestId) && pendingCards.size >= MAX_CARDS)
                return false;
            pendingCards.set(requestId, { card, expiresAt: expiry });
            saveCards();
            return true;
        },
        forgetCard(requestId) {
            if (!pendingCards.delete(requestId))
                return;
            saveCards();
        },
        cardFor(requestId) {
            const found = pendingCards.get(requestId);
            if (!found)
                return undefined;
            if (found.expiresAt <= now()) {
                pendingCards.delete(requestId);
                saveCards();
                return undefined;
            }
            return found.card;
        },
        revisions() {
            return Object.fromEntries(boardRevision);
        },
        unwatch(auth, key) {
            if (!auth.ok)
                return;
            watched.get(auth.phone.id)?.delete(key);
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
            return currentQueue(deviceId).map(pending => pending.command);
        },
        receiptsFor(auth) {
            if (!auth.ok)
                return [];
            for (const deviceId of queued.keys())
                currentQueue(deviceId);
            return [...(receipts.get(auth.phone.id)?.values() ?? [])].reverse();
        },
        writeTasks(auth, body) {
            if (!auth.ok)
                throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
            if ('device' in auth) {
                const deviceId = auth.device.id;
                const connectionId = options.nodeConnection?.(deviceId);
                const connectionChanged = connectionId !== undefined && boardConnection.get(deviceId) !== undefined && boardConnection.get(deviceId) !== connectionId;
                const head = connectionChanged ? undefined : boardRevision.get(deviceId);
                const revision = boardRevisionOf(body.revision);
                // A failed read leaves the last snapshot intact. An actual empty snapshot still replaces it.
                if (body.read === true && Array.isArray(body.tasks) && (head === undefined || (revision !== undefined && revision >= head))) {
                    if (connectionId !== undefined)
                        boardConnection.set(deviceId, connectionId);
                    if (revision !== undefined)
                        boardRevision.set(deviceId, revision);
                    else if (connectionChanged)
                        boardRevision.delete(deviceId);
                    tasks.set(deviceId, normalizeTasks(body.tasks, deviceId, revision));
                }
                const outcomes = new Map();
                if (Array.isArray(body.applied)) {
                    for (const id of body.applied)
                        if (typeof id === 'string')
                            outcomes.set(id, undefined);
                }
                if (Array.isArray(body.rejected)) {
                    for (const item of body.rejected) {
                        if (typeof item !== 'object' || item === null || typeof item.id !== 'string')
                            continue;
                        const code = item.code;
                        outcomes.set(item.id, code === 'unsupported' || code === 'conflict' ? code : 'unavailable');
                    }
                }
                const remaining = currentQueue(deviceId).filter((pending) => {
                    const { id } = pending.command;
                    if (!outcomes.has(id))
                        return true;
                    const code = outcomes.get(id);
                    recordReceipt(pending, code === undefined ? 'applied' : code === 'unavailable' ? 'unconfirmed' : 'rejected', code);
                    return false;
                });
                if (remaining.length === 0)
                    queued.delete(deviceId);
                else
                    queued.set(deviceId, remaining);
                return { tasks: tasks.get(deviceId) ?? [], conflict: false };
            }
            const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
            if (!DEVICE_ID.test(deviceId))
                throw Object.assign(new Error('invalid'), { code: 'invalid' });
            const current = tasks.get(deviceId) ?? [];
            const base = boardRevisionOf(body.baseRevision);
            if (base === undefined || base !== boardRevision.get(deviceId))
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
            const queue = currentQueue(deviceId);
            if (queue.length >= MAX_COMMANDS)
                throw Object.assign(new Error('size-limit'), { code: 'size-limit' });
            const pending = { command, phoneId: auth.phone.id, expiresAt: now() + COMMAND_TTL_MS };
            queued.set(deviceId, [...queue, pending]);
            recordReceipt(pending, 'queued');
            return { tasks: current, conflict: false, commandId: command.id };
        },
        readMemory(auth) {
            if (!auth.ok)
                return [];
            const at = now();
            const entries = [];
            for (const [id, snapshot] of memory) {
                const grant = memoryGrant(id);
                if (!grant || snapshot.connectionId !== grant.connectionId || snapshot.accountHash !== grant.accountHash
                    || snapshot.policyRevision !== grant.device.policyRevision || snapshot.expiresAt <= at) {
                    memory.delete(id);
                    continue;
                }
                if (grant.accountHash !== auth.phone.accountHash)
                    continue;
                entries.push(...snapshot.entries);
            }
            return entries;
        },
        writeMemory(auth, snapshot) {
            if (!auth.ok)
                throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
            const id = auth.device.id;
            const grant = memoryGrant(id);
            if (!grant || snapshot.code === 'withheld') {
                memory.delete(id);
                return;
            }
            const { device, connectionId } = grant;
            if (device.tokenDigest !== auth.device.tokenDigest || device.policyRevision !== auth.device.policyRevision
                || snapshot.connectionId !== connectionId || snapshot.policyRevision !== device.policyRevision)
                return;
            if (snapshot.code === undefined && Array.isArray(snapshot.entries)) {
                memory.set(id, {
                    entries: normalizeMemory(snapshot.entries, id), connectionId, accountHash: grant.accountHash,
                    policyRevision: device.policyRevision, expiresAt: now() + MEMORY_TTL_MS,
                });
            }
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
function boardRevisionOf(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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
            detail: (typeof item.detail === 'string' ? item.detail : typeof item.description === 'string' ? item.description : '').slice(0, 2000),
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
        used += Buffer.byteLength(text);
        if (used > 24_000)
            break;
        entries.push({
            id: typeof item.id === 'string' ? item.id.slice(0, 80) : 'mem-' + String(entries.length),
            deviceId,
            layer: item.layer === 'workspace' || item.layer === 'global' ? item.layer : 'private',
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
    const seen = new Set();
    for (const row of raw) {
        if (typeof row !== 'object' || row === null)
            continue;
        const item = row;
        if (typeof item.name !== 'string' || !item.name.trim())
            continue;
        const id = typeof item.id === 'string' ? item.id : item.agent === 'dsh' ? undefined : item.agent;
        if (typeof id !== 'string' || id.trim() === '' || id.length > 80 || seen.has(id))
            continue;
        seen.add(id);
        agents.push({ deviceId, id, name: item.name.trim().slice(0, 80) });
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
