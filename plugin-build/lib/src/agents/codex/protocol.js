/**
 * Codex app-server 协议最小子集，pin 到 `rust-v0.166.0` 的生成 schema
 * （`codex_app_server_protocol.v2.schemas.json`）。这里只声明适配器实际使用
 * 的字段；字段缺失/类型不符一律按协议错误处理，不做“尽量兼容”。
 *
 * 0.166.0 没有 `protocolVersion`：版本只按 `initialize.userAgent` 旁证。
 * 设置快照解析器对未知附加字段保持宽容，但对已知字段不做猜测：无法表达的
 * sandbox/approval 形状直接省略整个 permission，绝不合成“更安全”的值。
 */
export const CODEX_SUPPORTED_VERSION = '0.166.0';
export const CODEX_SCHEMA_REVISION = 'rust-v0.166.0@6ff1e1ca3b30fc8b914720681fcf5fe62e95f856';
export const CODEX_CLIENT_INFO = { name: 'dsh-marshal', version: '0.0.0' };
export const CODEX_JSONRPC_METHOD_NOT_FOUND = -32601;
export const CODEX_JSONRPC_INTERNAL_ERROR = -32603;
/**
 * 目标版本已知的 server notification。未列入集合的方法由 peer 做有界计数；
 * 列入但未映射的方法（settings/goal/diff 等）属于“已知但本版本不投影”。
 */
export const CODEX_KNOWN_NOTIFICATIONS = new Set([
    'error',
    'thread/started',
    'thread/status/changed',
    'thread/readState/changed',
    'thread/archived',
    'thread/deleted',
    'thread/unarchived',
    'thread/closed',
    'thread/reverted',
    'thread/name/updated',
    'thread/attachment/updated',
    'thread/goal/updated',
    'thread/goal/cleared',
    'thread/queue/changed',
    'thread/settings/updated',
    'thread/tokenUsage/updated',
    'thread/compacted',
    'turn/started',
    'turn/completed',
    'turn/diff/updated',
    'turn/plan/updated',
    'turn/moderationMetadata',
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/commandExecution/outputDelta',
    'item/commandExecution/terminalInteraction',
    'item/fileChange/outputDelta',
    'item/fileChange/patchUpdated',
    'item/mcpToolCall/progress',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta',
    'item/autoApprovalReview/started',
    'item/autoApprovalReview/completed',
    'serverRequest/resolved',
    'skills/changed',
    'account/updated',
    'account/rateLimits/updated',
    'mcpServer/startupStatus/updated',
    'model/rerouted',
    'warning',
    'guardianWarning',
    'deprecationNotice',
    'configWarning',
]);
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function nonEmptyString(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function optionalString(value) {
    return typeof value === 'string' ? value : undefined;
}
/** 只接受 string|null；其它形状视为协议错误，不猜“缺失”。 */
function optionalCursor(value) {
    if (value === null || value === undefined)
        return {};
    if (typeof value === 'string' && value !== '')
        return { cursor: value };
    return undefined;
}
export function parseThreadStatus(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    if (record.type === 'active') {
        if (!Array.isArray(record.activeFlags))
            return undefined;
        if (!record.activeFlags.every(flag => typeof flag === 'string'))
            return undefined;
        return { type: 'active', activeFlags: [...record.activeFlags] };
    }
    if (record.type === 'idle' || record.type === 'notLoaded' || record.type === 'systemError') {
        return { type: record.type };
    }
    return undefined;
}
export function parseThread(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const id = nonEmptyString(record.id);
    if (id === undefined)
        return undefined;
    const status = record.status === undefined ? undefined : parseThreadStatus(record.status);
    if (record.status !== undefined && status === undefined)
        return undefined;
    const updatedAt = record.updatedAt === undefined ? undefined : finiteNumber(record.updatedAt);
    const createdAt = record.createdAt === undefined ? undefined : finiteNumber(record.createdAt);
    if (record.updatedAt !== undefined && updatedAt === undefined)
        return undefined;
    if (record.createdAt !== undefined && createdAt === undefined)
        return undefined;
    const turns = record.turns === undefined ? undefined : parseTurns(record.turns);
    if (record.turns !== undefined && turns === undefined)
        return undefined;
    const forkedFromId = record.forkedFromId === undefined
        ? undefined
        : record.forkedFromId === null ? null : nonEmptyString(record.forkedFromId);
    if (record.forkedFromId !== undefined && forkedFromId === undefined)
        return undefined;
    return {
        id,
        ...(status === undefined ? {} : { status }),
        ...(updatedAt === undefined ? {} : { updatedAt }),
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(typeof record.model === 'string' ? { model: record.model } : {}),
        ...(typeof record.reasoningEffort === 'string' ? { reasoningEffort: record.reasoningEffort } : {}),
        ...(typeof record.path === 'string' ? { path: record.path } : {}),
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        ...(typeof record.preview === 'string' ? { preview: record.preview } : {}),
        ...(turns === undefined ? {} : { turns }),
        ...(forkedFromId === undefined ? {} : { forkedFromId }),
    };
}
export function parseThreadItem(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const id = nonEmptyString(record.id);
    const type = nonEmptyString(record.type);
    if (id === undefined || type === undefined)
        return undefined;
    return { ...record, id, type };
}
export function parseTurn(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const id = nonEmptyString(record.id);
    const status = nonEmptyString(record.status);
    if (id === undefined || status === undefined)
        return undefined;
    const items = record.items === undefined ? undefined : parseItems(record.items);
    if (record.items !== undefined && items === undefined)
        return undefined;
    // 原生 Turn 的两个时间戳均可为 null，尤其 turn/start 的首次响应。
    const startedAt = record.startedAt == null ? undefined : finiteNumber(record.startedAt);
    const completedAt = record.completedAt == null ? undefined : finiteNumber(record.completedAt);
    if (record.startedAt != null && startedAt === undefined)
        return undefined;
    if (record.completedAt != null && completedAt === undefined)
        return undefined;
    return {
        id,
        status,
        ...(items === undefined ? {} : { items }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(completedAt === undefined ? {} : { completedAt }),
        ...(typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0 ? { durationMs: record.durationMs } : {}),
    };
}
function parseItems(value) {
    if (!Array.isArray(value))
        return undefined;
    const items = [];
    for (const entry of value) {
        const item = parseThreadItem(entry);
        if (item === undefined)
            return undefined;
        items.push(item);
    }
    return items;
}
function parseTurns(value) {
    if (!Array.isArray(value))
        return undefined;
    const turns = [];
    for (const entry of value) {
        const turn = parseTurn(entry);
        if (turn === undefined)
            return undefined;
        turns.push(turn);
    }
    return turns;
}
export function parseInitializeResponse(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const userAgent = nonEmptyString(record.userAgent);
    if (userAgent === undefined)
        return undefined;
    return {
        userAgent,
        ...(optionalString(record.codexHome) === undefined ? {} : { codexHome: record.codexHome }),
        ...(optionalString(record.platformFamily) === undefined ? {} : { platformFamily: record.platformFamily }),
        ...(optionalString(record.platformOs) === undefined ? {} : { platformOs: record.platformOs }),
    };
}
export function parseThreadListResponse(value) {
    const record = asRecord(value);
    if (record === undefined || !Array.isArray(record.data))
        return undefined;
    const cursor = optionalCursor(record.nextCursor);
    if (cursor === undefined)
        return undefined;
    const threads = [];
    for (const entry of record.data) {
        const thread = parseThread(entry);
        if (thread === undefined)
            return undefined;
        threads.push(thread);
    }
    return { data: threads, ...(cursor.cursor === undefined ? {} : { nextCursor: cursor.cursor }) };
}
export function parseTurnsListResponse(value) {
    const record = asRecord(value);
    if (record === undefined || !Array.isArray(record.data))
        return undefined;
    const cursor = optionalCursor(record.nextCursor);
    if (cursor === undefined)
        return undefined;
    const turns = parseTurns(record.data);
    if (turns === undefined)
        return undefined;
    return { data: turns, ...(cursor.cursor === undefined ? {} : { nextCursor: cursor.cursor }) };
}
export function parseTurnStartResponse(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const turn = parseTurn(record.turn);
    return turn === undefined ? undefined : { turn };
}
export function parseThreadRefResponse(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const thread = parseThread(record.thread);
    return thread === undefined ? undefined : { thread };
}
/** `userAgent` 形如 `dsh-marshal/0.0.0 (linux; x86_64) codex/0.166.0`；只认第一个语义版本号。 */
export function parseVersionFromUserAgent(userAgent) {
    const match = /\b(\d+\.\d+\.\d+)\b/.exec(userAgent);
    return match?.[1];
}
export function supportsVersion(version) {
    return version === CODEX_SUPPORTED_VERSION;
}
export function threadRunning(thread) {
    return thread.status?.type === 'active';
}
/** Thread 的时间戳是秒；对外统一毫秒，异常值不猜。 */
export function threadUpdatedAtMs(thread) {
    const value = thread.updatedAt;
    if (value === undefined || value < 0)
        return undefined;
    return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
}
/** 没有 preview 也没有回合才算空白；标题/正文不参与判定之外的输出。 */
export function threadBlank(thread) {
    const preview = typeof thread.preview === 'string' ? thread.preview.trim() : '';
    if (preview !== '')
        return false;
    return thread.turns === undefined || thread.turns.length === 0;
}
export function threadWaitKind(thread) {
    const status = thread.status;
    if (status?.type !== 'active')
        return undefined;
    if (status.activeFlags.includes('waitingOnApproval'))
        return 'approval';
    if (status.activeFlags.includes('waitingOnUserInput'))
        return 'question';
    return undefined;
}
/**
 * approvalPolicy 只接受字符串形式。granular 对象形式在 0.166.0 的确切语义
 * 未验证，连同 sandbox 一起省略 permission，而不是只保留一半。
 */
function sandboxMapping(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    switch (record.type) {
        case 'readOnly': {
            const network = typeof record.networkAccess === 'boolean' ? record.networkAccess : undefined;
            return {
                applicable: true,
                scope: { fileSystem: 'read-only', ...(network === undefined ? {} : { network }) },
            };
        }
        case 'workspaceWrite': {
            const network = typeof record.networkAccess === 'boolean' ? record.networkAccess : undefined;
            const writableRoots = record.writableRoots;
            const roots = Array.isArray(writableRoots) && writableRoots.every(root => typeof root === 'string')
                ? [...writableRoots]
                : undefined;
            return {
                applicable: true,
                scope: { fileSystem: 'workspace-write', ...(network === undefined ? {} : { network }) },
                ...(roots === undefined ? {} : { additionalDirectories: roots }),
            };
        }
        case 'dangerFullAccess':
            // 0.166.0 的该分支没有 networkAccess；不能推断网络范围。
            return { applicable: true, scope: { fileSystem: 'danger-full-access' } };
        case 'externalSandbox':
            // 外部 sandbox 的有效范围未知：整个 permission 省略。
            return { applicable: false };
        default:
            // 未识别的联合分支是协议演进，同样不能伪造可比较范围。
            return { applicable: false };
    }
}
/**
 * permission 只有同时具备可比较的 approvalPolicy（non-empty string）与可映射的
 * sandbox 时才发布；任一缺失/不可表达都省略整个 permission，绝不发布一半。
 */
function permissionScope(approvalValue, sandboxValue) {
    const approvalPolicy = nonEmptyString(approvalValue);
    if (approvalPolicy === undefined)
        return undefined;
    const sandbox = sandboxMapping(sandboxValue);
    if (sandbox === undefined || !sandbox.applicable || sandbox.scope === undefined)
        return undefined;
    return {
        approvalPolicy,
        sandbox: sandbox.scope,
        ...(sandbox.additionalDirectories === undefined
            ? {}
            : { additionalDirectories: sandbox.additionalDirectories }),
    };
}
function planFromCollaborationMode(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    if (record.mode === 'plan')
        return 'on';
    if (record.mode === 'default')
        return 'off';
    return undefined;
}
function threadSettings(threadId, modelValue, reasoningValue, approvalValue, sandboxValue, collaborationValue) {
    const model = nonEmptyString(modelValue);
    if (model === undefined)
        return undefined;
    // 0.166.0 用 string|null 表示“未设置 effort”；null 等价于缺失。
    const reasoning = optionalString(reasoningValue);
    const permission = permissionScope(approvalValue, sandboxValue);
    const plan = planFromCollaborationMode(collaborationValue);
    return {
        threadId,
        model,
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(permission === undefined ? {} : { permission }),
        ...(plan === undefined ? {} : { plan }),
    };
}
/** `thread/resume` 响应：`sandbox` 是 SandboxPolicy 联合。 */
export function parseThreadSettingsSnapshot(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const thread = parseThread(record.thread);
    if (thread === undefined)
        return undefined;
    return threadSettings(thread.id, record.model, record.reasoningEffort, record.approvalPolicy, record.sandbox, record.collaborationMode);
}
/**
 * `thread/settings/updated` 只有 threadId + threadSettings，没有版次或请求关联：
 * 只能更新长期 current，绝不能用来确认 pending。
 */
export function parseThreadSettingsUpdated(params) {
    const record = asRecord(params);
    if (record === undefined)
        return undefined;
    const threadId = nonEmptyString(record.threadId);
    if (threadId === undefined)
        return undefined;
    const settings = asRecord(record.threadSettings);
    if (settings === undefined)
        return undefined;
    const snapshot = threadSettings(threadId, settings.model, settings.effort, settings.approvalPolicy, settings.sandboxPolicy, settings.collaborationMode);
    return snapshot === undefined ? undefined : { threadId, snapshot };
}
/** goal get 的权威结果；objective 是内容型字段，调用方不得外传。 */
export function parseGoalGetResponse(value) {
    const record = asRecord(value);
    if (record === undefined || !('goal' in record))
        return undefined;
    if (record.goal === null)
        return { goal: null };
    const goal = asRecord(record.goal);
    if (goal === undefined)
        return undefined;
    const objective = optionalString(goal.objective);
    return objective === undefined ? undefined : { goal: { objective } };
}
/**
 * set 响应不是权威值（可能回显请求），这里只做形状校验，调用方仍以
 * 紧随其后的 goal/get 为准。
 */
export function parseGoalSetResponse(value) {
    const record = asRecord(value);
    const goal = asRecord(record?.goal);
    if (goal === undefined)
        return undefined;
    const objective = optionalString(goal.objective);
    return objective === undefined ? undefined : { goal: { objective } };
}
export function parseGoalClearResponse(value) {
    const record = asRecord(value);
    if (record === undefined || typeof record.cleared !== 'boolean')
        return undefined;
    return { cleared: record.cleared };
}
export function parseGoalUpdatedNotification(params) {
    const record = asRecord(params);
    if (record === undefined)
        return undefined;
    const threadId = nonEmptyString(record.threadId);
    if (threadId === undefined)
        return undefined;
    const goal = asRecord(record.goal);
    const objective = optionalString(goal?.objective);
    if (objective === undefined)
        return undefined;
    return { threadId, objective };
}
export function parseGoalClearedNotification(params) {
    const threadId = nonEmptyString(asRecord(params)?.threadId);
    return threadId === undefined ? undefined : { threadId };
}
