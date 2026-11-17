import { ControlsSchema } from "../agents/controls.js";
import { MAX_FRAME_BYTES, MAX_INTERACTION_INPUT_BYTES } from "../wire/limits.js";
import { COMMAND_OPS, MARSHAL_KINDS, WIRE_ERROR_CODES, } from "../wire/frames.js";
import { redact } from "./redact.js";
/** 大文本分片上限；比契约的 256 KiB 更保守，给 JSON 转义留足空间。 */
const CHUNK_BYTES = 64 * 1024;
/** ACK/状态结果只允许短小结论，超出就不再回传正文。 */
const MAX_ACK_RESULT_BYTES = 64 * 1024;
/** 内置敏感模式始终生效；配置里的 redaction 只能追加，不能移除。 */
const BUILTIN_PATTERNS = [
    // PEM 私钥块：跨行匹配，整块替换。
    '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----',
    '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b',
    '\\bBearer\\s+[A-Za-z0-9._~+/=-]{8,}',
    '\\bsk-[A-Za-z0-9_-]{16,}',
    '\\bghp_[A-Za-z0-9]{20,}',
    '\\bgithub_pat_[A-Za-z0-9_]{20,}',
    '\\bAKIA[0-9A-Z]{16}\\b',
    // 连接串整体替换，避免 host/用户名/口令残留。
    '\\b(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis|rediss|amqp|mssql|clickhouse)://[^\\s"\'<>]+',
    '\\b[a-z][a-z0-9+.-]*://[^/\\s:@]+:[^/\\s@]+@',
    '\\b[A-Za-z0-9._-]+:[^\\s@/:]{1,64}@',
    '\\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\\s*[:=]\\s*[^\\s,;]+',
];
const RESULT_KEYS = new Set([
    'attachmentId', 'complete', 'accepted', 'cancelled', 'following', 'subscriptionId', 'created',
    'sessionId', 'status', 'state', 'count', 'bytes', 'chars', 'reason', 'revision',
]);
const CAPABILITY_OPERATIONS = new Set([
    'prompt', 'interrupt', 'answer', 'cancel', 'configure', 'create', 'fork', 'acquire',
]);
const CAPABILITY_OWNERSHIP = new Set([
    'ours', 'attached', 'foreign-unknown', 'foreign-running', 'unverified',
]);
const CAPABILITY_TOOL_DETAIL = new Set(['args+output', 'args', 'none']);
const CAPABILITY_PROMPT_FIDELITY = new Set(['native', 'relay', 'dom', 'none']);
const CAPABILITY_FOLLOW = new Set(['stream', 'poll', 'none']);
const CAPABILITY_TUNABLE_IDS = new Set([
    'model', 'reasoning', 'permission', 'plan', 'goal', 'skill', 'plugin',
]);
const CAPABILITY_TUNABLE_SCOPES = new Set(['next-turn', 'next-session', 'host']);
const CAPABILITY_TUNABLE_EFFECTS = new Set(['immediate', 'needs-restart', 'next-session']);
const CAPABILITY_TUNABLE_DIRECTIONS = new Set(['tighten-only']);
/** tunable 的 reason 只能是稳定原因码，不能是自由文本。 */
const CAPABILITY_REASON_CODES = new Set([
    'history-unavailable',
    'not-exposed-in-v0',
    'read-only-in-v0',
    'unverified-in-v0',
    'no-atomic-turn-binding',
    'v0-field-only',
    'v0-tighten-only',
    'host-config',
    'ownership-unverified',
    'session-not-owned',
    'native-steer-unverified',
    'catalog-unavailable',
    'permission-lattice-unavailable',
    'settings-readback-unavailable',
    'privacy-readback-unavailable',
    'interaction-relay-unavailable',
    'settings-unsafe',
]);
/** 会话设置的待回读状态；未知值连字段都不发。 */
const CAPABILITY_PENDING_STATUS = new Set(['pending', 'readback-timeout']);
const TURN_STATES = new Set(['running', 'completed', 'failed', 'interrupted']);
const TOOL_STATES = new Set(['running', 'completed', 'failed', 'interrupted', 'error', 'ok', 'cancelled']);
const RESOLVED_STATES = new Set(['answered', 'declined', 'expired', 'cancelled', 'invalidated', 'failed']);
const ACK_STATES = new Set(['accepted', 'confirmed', 'rejected', 'pending-confirmation', 'outcome-unknown']);
const AUDIT_ACTIONS = new Set([
    ...ACK_STATES, 'admitted', 'answered', 'declined', 'expired', 'cancelled', 'invalidated', 'failed', 'timeout',
]);
const AUDIT_OPS = new Set(COMMAND_OPS);
const WIRE_CODE_SET = new Set(WIRE_ERROR_CODES);
const KIND_SET = new Set(MARSHAL_KINDS);
const WAIT_KINDS = new Set(['input', 'question', 'approval']);
/** 审计只收标识符；自由文本（含空格/引号/URL 片段）一律不落盘。 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/;
/** 卡片字段上限；任何切分/丢弃都会把整卡标成 ambiguous。 */
const MAX_QUESTIONS = 32;
const MAX_OPTIONS = 16;
const MAX_DECISIONS = 8;
const MAX_PROMPT_CHARS = 2_000;
const MAX_OPTION_LABEL_CHARS = 200;
const MAX_OPTION_DESCRIPTION_CHARS = 400;
const MAX_ACTION_CHARS = 300;
const MAX_APPROVAL_TITLE_CHARS = 200;
const MAX_APPROVAL_DETAIL_CHARS = 600;
const MAX_DECISION_LABEL_CHARS = 120;
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function safeString(value, max = 128) {
    return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;
}
function safeInt(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
function safeBool(value) {
    return typeof value === 'boolean' ? value : undefined;
}
function bytesOfJson(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
function charCount(value) {
    return typeof value === 'string' ? value.length : 0;
}
/** 从字符串或 DSH 的 content parts 里取纯文本；其它结构不猜。 */
function textOf(value) {
    if (typeof value === 'string')
        return value;
    if (!Array.isArray(value))
        return '';
    const parts = [];
    for (const part of value) {
        if (typeof part === 'string') {
            parts.push(part);
            continue;
        }
        const record = asRecord(part);
        if (record !== undefined && typeof record.text === 'string')
            parts.push(record.text);
    }
    return parts.join('\n');
}
/** 按完整 UTF-8 边界切分；末尾的续字节留给下一片。 */
export function splitUtf8(text, maxBytes = CHUNK_BYTES) {
    const buffer = Buffer.from(text, 'utf8');
    if (buffer.length <= maxBytes)
        return [text];
    const chunks = [];
    let start = 0;
    while (start < buffer.length) {
        let end = Math.min(start + maxBytes, buffer.length);
        if (end < buffer.length) {
            while (end > start && (buffer[end] & 0xc0) === 0x80)
                end -= 1;
            if (end === start)
                end = Math.min(start + maxBytes, buffer.length);
        }
        chunks.push(buffer.subarray(start, end).toString('utf8'));
        start = end;
    }
    return chunks;
}
function compilePatterns(additional) {
    const patterns = [];
    for (const source of [...BUILTIN_PATTERNS, ...additional]) {
        try {
            patterns.push(new RegExp(source, 'gi'));
        }
        catch { /* 配置层已校验；这里只防御 */ }
    }
    return patterns;
}
function sliceChars(text, max) {
    return text.length <= max ? text : text.slice(0, max);
}
export function createPrivacyProjector(options) {
    const patterns = compilePatterns(options.redaction);
    const now = options.now ?? Date.now;
    const content = options.privacy === 'content' && options.allowContent;
    const interactionMode = (kind) => {
        const relay = kind === 'approval' ? options.approvalRelay : options.questionRelay;
        // remote 还要求 hub 侧 allowInteractions；缺一按 off，notify 不受 hub 开关影响。
        if (relay === 'remote' && !options.allowInteractions)
            return 'off';
        return relay;
    };
    const scrub = (text) => {
        const masked = redact(text, patterns);
        return { text: masked, changed: masked !== text };
    };
    /** 切片或脱敏都算 altered：卡片据此整体降级，绝不带着残缺内容允许批准。 */
    const boundedText = (text, max) => {
        const sliced = text.length > max;
        const cleaned = scrub(sliced ? text.slice(0, max) : text);
        return { text: cleaned.text, altered: sliced || cleaned.changed };
    };
    const boundedId = (value, max) => {
        if (typeof value !== 'string' || value === '')
            return { altered: value !== undefined };
        const altered = value.length > max;
        const cleaned = scrub(altered ? value.slice(0, max) : value);
        return altered || cleaned.changed ? { value: cleaned.text, altered: true } : { value: cleaned.text, altered: false };
    };
    const safeText = (value, max = 4096) => {
        const text = typeof value === 'string' ? value : undefined;
        if (text === undefined)
            return undefined;
        return scrub(sliceChars(text, max)).text;
    };
    const validEnvelope = (frame) => {
        if (frame === null || typeof frame !== 'object')
            return false;
        if (frame.v !== 2 || frame.type !== 'event')
            return false;
        if (frame.deviceId !== options.deviceId || frame.agent !== options.agent)
            return false;
        if (typeof frame.sessionId !== 'string' || frame.sessionId === '')
            return false;
        if (typeof frame.nodeEpoch !== 'string' || frame.nodeEpoch === '')
            return false;
        if (!Number.isInteger(frame.seq) || frame.seq < 0)
            return false;
        if (!Number.isInteger(frame.ts) || frame.ts < 0)
            return false;
        return typeof frame.kind === 'string' && KIND_SET.has(frame.kind);
    };
    const itemIdOf = (payload, frame) => {
        const raw = safeString(payload.itemId, 128) ?? `${frame.sessionId}:${frame.seq}`;
        return scrub(raw).text;
    };
    const turnIdOf = (payload) => {
        const value = payload.turnId ?? payload.turn;
        if (typeof value === 'string' && value !== '')
            return scrub(value.slice(0, 128)).text;
        if (typeof value === 'number' && Number.isFinite(value))
            return String(value);
        return undefined;
    };
    const callIdOf = (payload, frame) => {
        const raw = safeString(payload.callId, 128) ?? `call:${frame.seq}`;
        return scrub(raw).text;
    };
    const countsOf = (value) => {
        const record = asRecord(value);
        if (record === undefined)
            return undefined;
        const out = {};
        let seen = 0;
        for (const [key, item] of Object.entries(record)) {
            if (seen >= 16)
                break;
            if (typeof item === 'number' && Number.isInteger(item) && item >= 0) {
                Object.defineProperty(out, scrub(key.slice(0, 32)).text, {
                    value: item, enumerable: true, configurable: true, writable: true,
                });
                seen += 1;
            }
        }
        return seen === 0 ? undefined : out;
    };
    const chunkPayloads = (base, text, field) => {
        const chunks = splitUtf8(text);
        const itemId = typeof base.itemId === 'string' ? base.itemId : undefined;
        return chunks.map((chunk, index) => ({
            ...(itemId === undefined ? {} : { itemId }),
            ...base,
            [field]: chunk,
            chunkIndex: index,
            chunkCount: chunks.length,
        }));
    };
    const metadataPayload = (kind, payload, frame) => {
        switch (kind) {
            case 'session.updated': {
                const out = {};
                if (typeof payload.running === 'boolean')
                    out.running = payload.running;
                if (typeof payload.blank === 'boolean')
                    out.blank = payload.blank;
                if (content && typeof payload.title === 'string')
                    out.title = scrub(payload.title.replace(/\s+/g, ' ').slice(0, 160)).text;
                const updatedAt = safeInt(payload.updatedAt);
                if (updatedAt !== undefined)
                    out.updatedAt = updatedAt;
                const ownership = safeString(payload.ownership, 32);
                if (ownership !== undefined)
                    out.ownership = scrub(ownership).text;
                const counts = countsOf(payload.counts);
                if (counts !== undefined)
                    out.counts = counts;
                // notify 只带受限等待类别；问题/选项正文绝不进入 session.updated。
                if (typeof payload.waitKind === 'string' && WAIT_KINDS.has(payload.waitKind)) {
                    out.waitKind = payload.waitKind;
                }
                return out;
            }
            case 'session.removed':
                return {};
            case 'turn.started':
            case 'turn.completed': {
                const turnId = turnIdOf(payload);
                if (turnId === undefined)
                    return undefined;
                const out = { turnId, state: 'running' };
                const runtimeEpoch = safeString(payload.runtimeEpoch, 128);
                if (runtimeEpoch !== undefined)
                    out.runtimeEpoch = scrub(runtimeEpoch).text;
                const state = typeof payload.state === 'string' && TURN_STATES.has(payload.state)
                    ? payload.state
                    : 'unknown';
                out.state = state;
                return out;
            }
            case 'reasoning.delta':
            case 'message.delta':
                return { itemId: itemIdOf(payload, frame), chars: charCount(payload.text) };
            case 'user.message':
            case 'message.completed':
                return { itemId: itemIdOf(payload, frame), chars: charCount(payload.text) };
            case 'tool.started': {
                const callId = callIdOf(payload, frame);
                const tool = safeString(payload.tool ?? payload.name, 64) ?? 'tool';
                const status = typeof payload.status === 'string'
                    ? TOOL_STATES.has(payload.status) ? payload.status : 'unknown'
                    : 'running';
                return { callId, tool: scrub(tool).text, status };
            }
            case 'tool.output': {
                const callId = callIdOf(payload, frame);
                const text = textOf(payload.text ?? payload.output ?? payload.content);
                return { callId, bytes: Buffer.byteLength(text, 'utf8') };
            }
            case 'tool.completed': {
                const callId = callIdOf(payload, frame);
                const status = typeof payload.status === 'string'
                    ? TOOL_STATES.has(payload.status) ? payload.status : 'unknown'
                    : payload.isError === true ? 'error' : 'ok';
                return { callId, status };
            }
            case 'input.requested': {
                const mode = interactionMode(payload.kind === 'approval' ? 'approval' : 'question');
                // notify 走 session.updated 的 body-less waitKind，绝不注册可答的 input.requested。
                if (mode !== 'remote')
                    return undefined;
                // 适配器可能直接把卡片字段放在 payload 里；缺字段时由 projectCard 拒绝。
                const card = projectCard({
                    kind: payload.kind === 'approval' ? 'approval' : 'question',
                    requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
                    sessionId: frame.sessionId,
                    runtimeEpoch: typeof payload.runtimeEpoch === 'string' ? payload.runtimeEpoch : 'unknown',
                    expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : 0,
                    ...(Array.isArray(payload.questions) ? { questions: payload.questions } : {}),
                    ...(payload.approval === undefined ? {} : { approval: payload.approval }),
                });
                if (card.mode === 'off')
                    return undefined;
                return card.payload;
            }
            case 'input.resolved': {
                // 只有交互可远答时才确认终态；notify/off 连“有人答过”都不外发。
                if (interactionMode('question') !== 'remote' && interactionMode('approval') !== 'remote')
                    return undefined;
                const requestId = safeString(payload.requestId, 128);
                if (requestId === undefined)
                    return undefined;
                const raw = typeof payload.state === 'string' ? payload.state : payload.outcome;
                const state = typeof raw === 'string' && RESOLVED_STATES.has(raw)
                    ? raw
                    : raw === 'remote' ? 'answered' : raw === 'timeout' ? 'expired' : raw === 'local' ? 'cancelled' : 'failed';
                return { requestId, state };
            }
            case 'capability.changed':
                return capabilityPayload(payload);
            case 'error': {
                const raw = payload.code;
                const code = typeof raw === 'string' && WIRE_CODE_SET.has(raw) ? raw : 'unknown';
                const severity = payload.severity === 'warning' ? 'warning' : 'error';
                const out = { code, severity };
                const relatedId = safeString(payload.relatedId, 128);
                if (relatedId !== undefined)
                    out.relatedId = scrub(relatedId).text;
                const relatedKind = typeof payload.relatedKind === 'string' && KIND_SET.has(payload.relatedKind)
                    ? payload.relatedKind
                    : undefined;
                if (relatedKind !== undefined)
                    out.relatedKind = relatedKind;
                return out;
            }
            default:
                return undefined;
        }
    };
    const contentPayload = (kind, payload, frame) => {
        switch (kind) {
            case 'session.updated': {
                const base = metadataPayload(kind, payload, frame);
                if (base === undefined)
                    return undefined;
                return [base];
            }
            case 'reasoning.delta':
            case 'message.delta':
            case 'user.message':
            case 'message.completed': {
                const text = typeof payload.text === 'string' ? payload.text : undefined;
                const itemId = itemIdOf(payload, frame);
                if (text === undefined)
                    return [{ itemId, chars: 0 }];
                return chunkPayloads({ itemId }, scrub(text).text, 'text');
            }
            case 'tool.started': {
                const base = metadataPayload(kind, payload, frame);
                if (base === undefined)
                    return undefined;
                const args = payload.arguments;
                if (args !== undefined)
                    base.arguments = redact(args, patterns);
                return [base];
            }
            case 'tool.output':
            case 'tool.completed': {
                const base = metadataPayload(kind, payload, frame);
                if (base === undefined)
                    return undefined;
                const text = textOf(payload.text ?? payload.output ?? payload.content);
                if (text === '')
                    return [base];
                return chunkPayloads(base, scrub(text).text, 'text');
            }
            case 'turn.started':
            case 'turn.completed': {
                const base = metadataPayload(kind, payload, frame);
                if (base === undefined)
                    return undefined;
                const reason = safeText(payload.reason, 32);
                if (reason !== undefined)
                    base.reason = reason;
                return [base];
            }
            default:
                return undefined;
        }
    };
    const SETTING_VALUE_KEYS = new Set(['approvalPolicy', 'sandbox', 'fileSystem', 'network']);
    /**
     * 设置 current/values 的有界结构投影：只保留已知字段与标量。
     * 目录/规则（additionalDirectories、rules）是路径或自由文本，一律丢弃。
     */
    const projectSettingValue = (value, depth = 0) => {
        if (typeof value === 'boolean')
            return value;
        if (typeof value === 'number')
            return Number.isFinite(value) ? value : undefined;
        if (typeof value === 'string')
            return scrub(value).text.slice(0, 128);
        if (Array.isArray(value)) {
            if (depth > 1)
                return undefined;
            const items = value.slice(0, 16)
                .map(item => projectSettingValue(item, depth + 1))
                .filter(item => item !== undefined);
            return items.length === 0 ? undefined : items;
        }
        const record = asRecord(value);
        if (record === undefined || depth > 1)
            return undefined;
        const out = {};
        for (const key of SETTING_VALUE_KEYS) {
            if (!(key in record))
                continue;
            const item = projectSettingValue(record[key], depth + 1);
            if (item !== undefined)
                out[key] = item;
        }
        return Object.keys(out).length === 0 ? undefined : out;
    };
    function capabilityPayload(payload) {
        const out = {};
        // observe 是独立字段对象；history 与 follow 必须分开投影，不能压回一个字符串。
        const observe = asRecord(payload.observe);
        if (observe !== undefined) {
            const projected = {};
            const history = safeBool(observe.history);
            if (history !== undefined)
                projected.history = history;
            const follow = safeString(observe.follow, 16);
            if (follow !== undefined && CAPABILITY_FOLLOW.has(follow))
                projected.follow = follow;
            // 未知 follow 值连字段都不发，避免页面把陌生枚举当能力。
            if (Object.keys(projected).length > 0)
                out.observe = projected;
        }
        if (Array.isArray(payload.operations)) {
            out.operations = [...new Set(payload.operations
                    .filter((item) => typeof item === 'string' && CAPABILITY_OPERATIONS.has(item)))]
                .slice(0, 32);
        }
        const ownership = safeString(payload.ownership, 32);
        if (ownership !== undefined && CAPABILITY_OWNERSHIP.has(ownership)) {
            out.ownership = ownership;
        }
        const toolDetail = safeString(payload.toolDetail, 32);
        if (toolDetail !== undefined && CAPABILITY_TOOL_DETAIL.has(toolDetail))
            out.toolDetail = toolDetail;
        const promptFidelity = safeString(payload.promptFidelity, 32);
        if (promptFidelity !== undefined && CAPABILITY_PROMPT_FIDELITY.has(promptFidelity)) {
            out.promptFidelity = promptFidelity;
        }
        const reasoning = safeBool(payload.reasoning);
        if (reasoning !== undefined)
            out.reasoning = reasoning;
        const stale = safeBool(payload.stale);
        if (stale !== undefined)
            out.stale = stale;
        for (const key of ['revision', 'readAt', 'settingsRevision']) {
            const value = safeInt(payload[key]);
            if (value !== undefined)
                out[key] = value;
        }
        const runtimeEpoch = safeString(payload.runtimeEpoch, 128);
        if (runtimeEpoch !== undefined)
            out.runtimeEpoch = scrub(runtimeEpoch).text;
        // pending 只保留字段名与枚举状态；requested/requestedAt/baseFieldRevision 一律丢弃。
        const pending = asRecord(payload.pending);
        if (pending !== undefined) {
            const field = safeString(pending.field, 32);
            const status = safeString(pending.status, 32);
            if (field !== undefined && CAPABILITY_TUNABLE_IDS.has(field)
                && status !== undefined && CAPABILITY_PENDING_STATUS.has(status)) {
                out.pending = { field, status };
            }
        }
        if (Array.isArray(payload.tunables)) {
            // 只留固定枚举内的标识与有界设置值；未知字段/自由文本不放大。
            out.tunables = payload.tunables.slice(0, 16).flatMap(item => {
                const tunable = asRecord(item);
                if (tunable === undefined)
                    return [];
                const id = safeString(tunable.id, 32);
                if (id === undefined || !CAPABILITY_TUNABLE_IDS.has(id))
                    return [];
                const entry = { id };
                const scope = safeString(tunable.scope, 32);
                if (scope !== undefined && CAPABILITY_TUNABLE_SCOPES.has(scope))
                    entry.scope = scope;
                const effect = safeString(tunable.effect, 32);
                if (effect !== undefined && CAPABILITY_TUNABLE_EFFECTS.has(effect))
                    entry.effect = effect;
                const direction = safeString(tunable.direction, 32);
                if (direction !== undefined && CAPABILITY_TUNABLE_DIRECTIONS.has(direction)) {
                    entry.direction = direction;
                }
                const editable = safeBool(tunable.editable);
                if (editable !== undefined)
                    entry.editable = editable;
                const reason = safeString(tunable.reason, 64);
                if (reason !== undefined && CAPABILITY_REASON_CODES.has(reason))
                    entry.reason = reason;
                if (Array.isArray(tunable.values)) {
                    const values = [];
                    for (const raw of tunable.values.slice(0, 32)) {
                        const value = asRecord(raw);
                        if (value === undefined)
                            continue;
                        const valueId = safeString(value.id, 64);
                        if (valueId === undefined)
                            continue;
                        const scrubbedId = scrub(valueId).text;
                        const rawLabel = safeString(value.label, 128);
                        const label = rawLabel === undefined ? scrubbedId : scrub(rawLabel).text;
                        values.push({ id: scrubbedId, label });
                    }
                    if (values.length > 0)
                        entry.values = values;
                }
                const current = projectSettingValue(tunable.current);
                if (current !== undefined)
                    entry.current = current;
                return [entry];
            });
        }
        const unavailable = asRecord(payload.unavailable);
        if (unavailable !== undefined) {
            // 原因码是稳定枚举式短串；键名截断，值只留安全字符，未知字段不放大。
            const projected = {};
            let seen = 0;
            for (const [key, value] of Object.entries(unavailable)) {
                if (seen >= 16)
                    break;
                const reason = safeString(value, 64);
                if (reason === undefined)
                    continue;
                Object.defineProperty(projected, scrub(key.slice(0, 64)).text, {
                    value: scrub(reason).text, enumerable: true, configurable: true, writable: true,
                });
                seen += 1;
            }
            if (seen > 0)
                out.unavailable = projected;
        }
        return out;
    }
    const sanitizeResult = (raw) => {
        const record = asRecord(raw);
        if (record === undefined)
            return undefined;
        const out = {};
        const catalog = ControlsSchema.safeParse(record.controls);
        if (content && catalog.success)
            out.controls = { ...catalog.data, models: catalog.data.models.map(model => ({ ...model, label: scrub(model.label).text })) };
        for (const [key, value] of Object.entries(record)) {
            if (!RESULT_KEYS.has(key))
                continue;
            if (typeof value === 'boolean') {
                out[key] = value;
                continue;
            }
            if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
                out[key] = value;
                continue;
            }
            if (typeof value === 'string') {
                const cleaned = scrub(value.slice(0, 128)).text;
                if (cleaned !== '')
                    out[key] = cleaned;
            }
            // 嵌套对象/数组一律丢弃：ACK 结果不是正文通道。
        }
        return Object.keys(out).length === 0 ? undefined : out;
    };
    const applyResult = (body, raw, projected) => {
        if (raw === undefined)
            return;
        if (bytesOfJson(raw) > MAX_ACK_RESULT_BYTES) {
            // 保留真实状态；超大结果只给分类，绝不把正文塞进 ACK。
            if (body.code === undefined)
                body.code = 'result-too-large';
            return;
        }
        if (projected !== undefined)
            body.result = projected;
    };
    function projectCard(input) {
        const kind = input.kind;
        // 卡片身份必须原样保留；被截断的 requestId/sessionId 无法再匹配原生请求，直接不建卡。
        const requestId = boundedId(input.requestId, 128);
        const sessionId = boundedId(input.sessionId, 128);
        const runtimeEpoch = boundedId(input.runtimeEpoch, 128);
        const expiresAt = safeInt(input.expiresAt);
        if (requestId.value === undefined || requestId.altered
            || sessionId.value === undefined || sessionId.altered
            || runtimeEpoch.value === undefined || runtimeEpoch.altered
            || expiresAt === undefined) {
            return { mode: 'off' };
        }
        const mode = interactionMode(kind);
        if (mode === 'off')
            return { mode: 'off' };
        const head = {
            requestId: requestId.value,
            sessionId: sessionId.value,
            runtimeEpoch: runtimeEpoch.value,
            kind,
            expiresAt,
        };
        if (mode === 'notify') {
            // 只报告“有等待”，不含问题、选项或审批正文，也无法远答。
            return { mode: 'notify', payload: { ...head, waitKind: kind, acceptOnceEligible: false } };
        }
        const body = kind === 'question' ? questionCard(input.questions) : approvalCard(input.approval);
        if (body.bodyless === true) {
            const reason = body.reason ?? 'invalid-card';
            return {
                mode: 'remote',
                payload: { ...head, waitKind: kind, acceptOnceEligible: false, ambiguous: true, reason },
                answerable: false,
                reason,
            };
        }
        // 反向守卫：只有完全未改动的卡片才允许标记为可远答。
        const answerable = body.answerable && body.ambiguous !== true;
        const full = {
            ...head,
            ...body.fields,
            ...(body.ambiguous === true ? { ambiguous: true } : {}),
            acceptOnceEligible: answerable,
        };
        if (answerable) {
            if (bytesOfJson(full) <= MAX_INTERACTION_INPUT_BYTES) {
                return {
                    mode: 'remote', payload: full, answerable: true,
                    // 映射随投影对象返回，但不属于 payload，序列化时不会出现。
                    ...(body.mapping === undefined ? {} : { mapping: body.mapping }),
                };
            }
            // 超限即不可远答：保留身份/到期/原因，去掉可误导的决定内容。
            return {
                mode: 'remote',
                payload: minimalCard(head, kind, 'card-too-large'),
                answerable: false,
                reason: 'card-too-large',
            };
        }
        const reason = body.reason ?? (body.ambiguous === true ? 'redaction-ambiguous' : 'card-not-answerable');
        const reduced = reducedCard(head, kind, body.fields, reason);
        return { mode: 'remote', payload: reduced, answerable: false, reason };
    }
    function questionCard(raw) {
        if (!Array.isArray(raw) || raw.length === 0) {
            return { fields: { questions: [] }, answerable: false, reason: 'invalid-card', bodyless: true };
        }
        let ambiguous = false;
        const ids = new Set();
        const questions = [];
        const mapping = new Map();
        let secret = false;
        // 超量不是静默丢弃：整卡标成 ambiguous，用户知道还有未展示的决定但不能批准。
        if (raw.length > MAX_QUESTIONS)
            ambiguous = true;
        raw.slice(0, MAX_QUESTIONS).forEach((item, index) => {
            const fallbackId = `q${index + 1}`;
            const question = asRecord(item);
            if (question === undefined) {
                ambiguous = true;
                questions.push({
                    id: fallbackId, prompt: '[unavailable]', required: true,
                    multi: false, custom: false, secret: false, ambiguous: true,
                });
                return;
            }
            const idInfo = boundedId(question.id, 64);
            const idMask = scrub(idInfo.value ?? fallbackId);
            const id = idMask.text;
            if (idInfo.altered || idMask.changed)
                ambiguous = true;
            if (ids.has(id))
                ambiguous = true;
            ids.add(id);
            if (question.secret === true)
                secret = true;
            const entry = {
                id,
                prompt: '[unavailable]',
                required: question.required !== false,
                multi: question.multi === true || question.multiSelect === true,
                custom: question.custom !== false,
                secret: false,
            };
            let questionAltered = idInfo.altered || idMask.changed;
            const promptRaw = typeof question.prompt === 'string'
                ? question.prompt
                : typeof question.question === 'string' ? question.question : undefined;
            if (promptRaw === undefined) {
                ambiguous = true;
                entry.ambiguous = true;
                questions.push(entry);
                return;
            }
            const prompt = boundedText(promptRaw, MAX_PROMPT_CHARS);
            if (prompt.altered) {
                ambiguous = true;
                questionAltered = true;
            }
            entry.prompt = prompt.text;
            const optionsRaw = question.options;
            const optionLabels = new Map();
            if (Array.isArray(optionsRaw)) {
                if (optionsRaw.length > MAX_OPTIONS)
                    ambiguous = true;
                const labels = new Set();
                const optionIds = new Set();
                const options = [];
                optionsRaw.slice(0, MAX_OPTIONS).forEach((optionValue, optionIndex) => {
                    const fallbackOptionId = `${id}o${optionIndex + 1}`;
                    const option = asRecord(optionValue);
                    if (option === undefined || typeof option.label !== 'string') {
                        ambiguous = true;
                        questionAltered = true;
                        options.push({ id: fallbackOptionId, label: '[unavailable]', ambiguous: true });
                        return;
                    }
                    const label = boundedText(option.label, MAX_OPTION_LABEL_CHARS);
                    if (label.altered) {
                        ambiguous = true;
                        questionAltered = true;
                    }
                    if (labels.has(label.text)) {
                        ambiguous = true;
                        questionAltered = true;
                    }
                    labels.add(label.text);
                    const optionIdInfo = boundedId(option.id, 64);
                    const optionIdMask = scrub(optionIdInfo.value ?? fallbackOptionId);
                    if (optionIdInfo.altered || optionIdMask.changed) {
                        ambiguous = true;
                        questionAltered = true;
                    }
                    // 投影后重复的选项 ID 会让答案映射指向同一 label，整卡不可远答。
                    if (optionIds.has(optionIdMask.text)) {
                        ambiguous = true;
                        questionAltered = true;
                    }
                    optionIds.add(optionIdMask.text);
                    const itemOut = { id: optionIdMask.text, label: label.text };
                    optionLabels.set(optionIdMask.text, option.label);
                    let optionAltered = label.altered || optionIdInfo.altered || optionIdMask.changed;
                    if (option.description !== undefined) {
                        if (typeof option.description !== 'string') {
                            ambiguous = true;
                            questionAltered = true;
                            optionAltered = true;
                        }
                        else {
                            const description = boundedText(option.description, MAX_OPTION_DESCRIPTION_CHARS);
                            if (description.altered) {
                                ambiguous = true;
                                questionAltered = true;
                                optionAltered = true;
                            }
                            itemOut.description = description.text;
                        }
                    }
                    if (optionAltered)
                        itemOut.ambiguous = true;
                    options.push(itemOut);
                });
                entry.options = options;
            }
            else if (optionsRaw !== undefined) {
                // 选项存在但不是数组：宁可整卡不可答，也不假装没有选项。
                ambiguous = true;
                questionAltered = true;
            }
            mapping.set(id, {
                nativeId: typeof question.id === 'string' && question.id !== '' ? question.id : fallbackId,
                required: question.required !== false,
                multi: question.multi === true || question.multiSelect === true,
                custom: question.custom !== false,
                options: optionLabels,
            });
            if (questionAltered)
                entry.ambiguous = true;
            questions.push(entry);
        });
        if (secret) {
            // secret 默认不跨机收集：整卡降级为无正文等待提示。
            return { fields: {}, answerable: false, reason: 'secret-local-only', bodyless: true };
        }
        return {
            fields: { questions },
            answerable: !ambiguous,
            ...(ambiguous ? { ambiguous: true, reason: 'redaction-ambiguous' } : {}),
            ...(ambiguous ? {} : { mapping: { questions: mapping } }),
        };
    }
    function approvalCard(raw) {
        const approval = asRecord(raw);
        if (approval === undefined) {
            return { fields: {}, answerable: false, reason: 'invalid-card', bodyless: true };
        }
        const actionRaw = typeof approval.action === 'string'
            ? approval.action
            : typeof approval.title === 'string' ? approval.title : undefined;
        if (actionRaw === undefined) {
            return { fields: {}, answerable: false, reason: 'invalid-card', bodyless: true };
        }
        let ambiguous = false;
        const action = boundedText(actionRaw, MAX_ACTION_CHARS);
        if (action.altered)
            ambiguous = true;
        const decisionsRaw = Array.isArray(approval.decisions) ? approval.decisions : [];
        if (decisionsRaw.length > MAX_DECISIONS)
            ambiguous = true;
        const decisions = [];
        const decisionIds = new Set();
        decisionsRaw.slice(0, MAX_DECISIONS).forEach((item, index) => {
            const fallbackId = `d${index + 1}`;
            const decision = asRecord(item);
            if (decision === undefined || typeof decision.label !== 'string') {
                ambiguous = true;
                decisions.push({ id: fallbackId, label: '[unavailable]', ambiguous: true });
                return;
            }
            const idInfo = boundedId(decision.id, 32);
            const idMask = scrub(idInfo.value ?? fallbackId);
            const id = idMask.text;
            if (idInfo.altered || idMask.changed)
                ambiguous = true;
            if (decisionIds.has(id))
                ambiguous = true;
            decisionIds.add(id);
            const label = boundedText(decision.label, MAX_DECISION_LABEL_CHARS);
            if (label.altered)
                ambiguous = true;
            const altered = label.altered || idInfo.altered || idMask.changed;
            decisions.push({ id, label: label.text, ...(altered ? { ambiguous: true } : {}) });
        });
        if (decisions.length === 0)
            ambiguous = true;
        const fields = {
            approval: { action: action.text, decisions },
        };
        const nested = fields.approval;
        if (approval.detail !== undefined) {
            if (typeof approval.detail !== 'string') {
                ambiguous = true;
            }
            else {
                const detail = boundedText(approval.detail, MAX_APPROVAL_DETAIL_CHARS);
                if (detail.altered)
                    ambiguous = true;
                nested.detail = detail.text;
            }
        }
        if (typeof approval.title === 'string' && approval.title !== actionRaw) {
            const title = boundedText(approval.title, MAX_APPROVAL_TITLE_CHARS);
            if (title.altered)
                ambiguous = true;
            nested.title = title.text;
        }
        else if (approval.title !== undefined && typeof approval.title !== 'string') {
            ambiguous = true;
        }
        return {
            fields,
            // 决策列表缺失或不可辨别时不推断允许项，只保留拒绝路径的展示。
            answerable: !ambiguous,
            ...(ambiguous ? { ambiguous: true, reason: 'redaction-ambiguous' } : {}),
        };
    }
    function minimalCard(head, kind, reason) {
        const minimal = {
            requestId: head.requestId,
            kind,
            expiresAt: head.expiresAt,
            acceptOnceEligible: false,
            ambiguous: true,
            truncated: true,
            reason,
        };
        if (kind === 'question')
            minimal.questionIds = [];
        else
            minimal.approval = { action: '[unavailable]', decisions: [] };
        return bytesOfJson(minimal) <= MAX_INTERACTION_INPUT_BYTES
            ? minimal
            : { requestId: head.requestId, kind, expiresAt: head.expiresAt, acceptOnceEligible: false, ambiguous: true, truncated: true, reason };
    }
    function reducedCard(head, kind, fields, reason) {
        const reduced = {
            ...head, ...fields, acceptOnceEligible: false, ambiguous: true, reason,
        };
        if (bytesOfJson(reduced) <= MAX_INTERACTION_INPUT_BYTES)
            return reduced;
        // 去掉描述/细节后仍超限：只留身份、到期与原因，防止截断后的危险后缀被误读。
        return minimalCard(head, kind, 'card-too-large');
    }
    return {
        content,
        event(frame) {
            if (!validEnvelope(frame))
                return [];
            const payload = frame.kind === 'session.removed' ? {} : asRecord(frame.payload);
            if (payload === undefined)
                return [];
            const kind = frame.kind;
            let payloads;
            if (content) {
                payloads = contentPayload(kind, payload, frame);
                // 内容档没有专门分支的 kind 仍走白名单（如 session.removed/capability）。
                if (payloads === undefined) {
                    const single = metadataPayload(kind, payload, frame);
                    payloads = single === undefined ? undefined : [single];
                }
            }
            else {
                const single = metadataPayload(kind, payload, frame);
                payloads = single === undefined ? undefined : [single];
            }
            if (payloads === undefined || payloads.length === 0)
                return [];
            const out = [];
            payloads.forEach((projected, index) => {
                const seq = index === 0
                    ? frame.seq
                    : options.nextSeq === undefined ? frame.seq + index : options.nextSeq(frame.sessionId);
                let candidate = { ...frame, seq, payload: projected };
                if (bytesOfJson(candidate) > MAX_FRAME_BYTES) {
                    // 单条内容装不进一帧时退回该 kind 的元数据，绝不截断信封/必填字段。
                    const fallback = metadataPayload(kind, payload, frame);
                    if (fallback === undefined)
                        return;
                    candidate = { ...frame, seq, payload: fallback };
                    if (bytesOfJson(candidate) > MAX_FRAME_BYTES)
                        return;
                }
                out.push(candidate);
            });
            return out;
        },
        ack(input) {
            const status = input.status;
            const valid = status === 'accepted' || status === 'confirmed' || status === 'rejected'
                || status === 'pending-confirmation' || status === 'outcome-unknown';
            const body = {
                v: 2,
                type: 'ack',
                commandId: safeString(input.commandId, 128) ?? 'unknown',
                connectionId: safeString(input.connectionId, 128) ?? 'unknown',
                nodeEpoch: safeString(input.nodeEpoch, 128) ?? 'unknown',
                status: valid ? status : 'outcome-unknown',
            };
            if (!valid)
                body.code = 'unknown';
            else if (input.code !== undefined) {
                body.code = WIRE_CODE_SET.has(input.code) ? input.code : 'unknown';
            }
            applyResult(body, input.result, sanitizeResult(input.result));
            return body;
        },
        error(origin, code, meta) {
            const sessionId = safeString(meta.sessionId, 128) ?? 'unknown';
            const payload = {
                code: WIRE_CODE_SET.has(code) ? code : 'unknown',
                severity: meta.severity === 'warning' ? 'warning' : 'error',
                relatedKind: KIND_SET.has(origin) ? origin : 'error',
            };
            const relatedId = safeString(meta.relatedId, 128);
            if (relatedId !== undefined)
                payload.relatedId = scrub(relatedId).text;
            return {
                v: 2, type: 'event', deviceId: options.deviceId, agent: options.agent, sessionId,
                nodeEpoch: options.nodeEpoch ?? 'unknown', seq: meta.seq ?? 0, ts: meta.ts ?? now(),
                kind: 'error', payload,
            };
        },
        syncRow(row) {
            const record = asRecord(row);
            if (record === undefined)
                return undefined;
            // 能力行是每 agent 一份完整文档；不能按会话行处理，也不扩写未知字段。
            if (record.capability !== undefined) {
                const agent = safeString(record.agent, 64);
                const capability = asRecord(record.capability);
                if (agent === undefined || capability === undefined)
                    return undefined;
                const out = { agent: scrub(agent).text, capability: capabilityPayload(capability) };
                const stale = safeBool(record.stale);
                if (stale !== undefined)
                    out.stale = stale;
                return out;
            }
            const sessionId = safeString(record.sessionId, 128);
            if (sessionId === undefined)
                return undefined;
            const out = { sessionId: scrub(sessionId).text };
            const agent = safeString(record.agent, 64);
            if (agent !== undefined)
                out.agent = scrub(agent).text;
            const running = safeBool(record.running);
            if (running !== undefined)
                out.running = running;
            const updatedAt = safeInt(record.updatedAt);
            if (updatedAt !== undefined)
                out.updatedAt = updatedAt;
            const blank = safeBool(record.blank);
            if (blank !== undefined)
                out.blank = blank;
            const ownership = safeString(record.ownership, 32);
            if (ownership !== undefined)
                out.ownership = scrub(ownership).text;
            const counts = countsOf(record.counts);
            if (counts !== undefined)
                out.counts = counts;
            if (content && typeof record.title === 'string')
                out.title = scrub(record.title.replace(/\s+/g, ' ').slice(0, 160)).text;
            // cwd 与其它未知字段不进入同步快照。
            return out;
        },
        statusResult(input) {
            const status = ACK_STATES.has(input.status) ? input.status : 'outcome-unknown';
            const body = {
                v: 2,
                type: 'command.status.result',
                requestId: safeString(input.requestId, 128) ?? 'unknown',
                status,
            };
            if (input.code !== undefined)
                body.code = WIRE_CODE_SET.has(input.code) ? input.code : 'unknown';
            applyResult(body, input.result, sanitizeResult(input.result));
            return body;
        },
        card(input) {
            return projectCard(input);
        },
        auditFields(input) {
            const out = { ts: now() };
            // 标识符字段：只允许短标识，内置脱敏命中即丢弃（不写回掩码）。
            for (const key of ['operatorId', 'deviceId', 'agent', 'sessionId', 'requestId']) {
                const value = safeString(input[key], 160);
                if (value === undefined || !IDENTIFIER.test(value))
                    continue;
                const cleaned = scrub(value);
                if (!cleaned.changed)
                    out[key] = cleaned.text;
            }
            // 枚举字段：未知值一律丢弃，绝不把自由文本写进审计。
            if (typeof input.op === 'string' && AUDIT_OPS.has(input.op))
                out.op = input.op;
            for (const key of ['decision', 'status']) {
                const value = input[key];
                if (typeof value === 'string' && AUDIT_ACTIONS.has(value))
                    out[key] = value;
            }
            if (typeof input.errorClass === 'string' && WIRE_CODE_SET.has(input.errorClass)) {
                out.errorClass = input.errorClass;
            }
            return out;
        },
    };
}
