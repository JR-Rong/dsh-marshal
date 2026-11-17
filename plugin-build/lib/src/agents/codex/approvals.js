/**
 * Codex app-server 服务器请求的纯分类与回写映射（不依赖适配器/连接状态）。
 *
 * 安全边界：
 * - 唯一白名单是 accept-once / decline / cancel；`acceptForSession`、
 *   execpolicy amendment、network amendment 永不生成。
 * - 权限扩大请求无论回答什么都回空授权，绝不因一次点击放宽 fileSystem/network；
 *   因此该方法的卡片只提供 decline/cancel，绝不出现 accept 这种无效承诺。
 * - `requestUserInput` 的远端可答性未验证，本版本不建卡也不代答；
 *   elicitation 只允许拒绝。
 */
const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
const FILE_CHANGE_APPROVAL = 'item/fileChange/requestApproval';
const PERMISSIONS_APPROVAL = 'item/permissions/requestApproval';
const USER_INPUT = 'item/tool/requestUserInput';
const ELICITATION = 'mcpServer/elicitation/request';
const METHOD_NOT_FOUND = { error: { code: -32601, message: 'method not found' } };
/** 权限扩大请求的“拒绝”没有独立形状：回空授权 + 本回合范围。 */
const EMPTY_GRANT = {
    result: { permissions: { fileSystem: null, network: null }, scope: 'turn' },
};
const NO_ANSWERS = { result: { answers: {} } };
const DECLINE_ELICITATION = { result: { action: 'decline' } };
const DECLINE_APPROVAL = { result: { decision: 'decline' } };
const WHITELIST = [
    { id: 'accept', label: '允许一次' },
    { id: 'decline', label: '拒绝' },
    { id: 'cancel', label: '取消' },
];
/** 权限扩大请求恒回空授权，accept 在原生侧不产生任何放宽，故永不提供。 */
const PERMISSION_WIDENING_DECISIONS = new Set(['decline', 'cancel']);
const MAX_AVAILABLE_DECISIONS = 32;
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function declineResponseFor(method) {
    switch (method) {
        case COMMAND_APPROVAL:
        case FILE_CHANGE_APPROVAL:
            return DECLINE_APPROVAL;
        case PERMISSIONS_APPROVAL:
            return EMPTY_GRANT;
        case USER_INPUT:
            return NO_ANSWERS;
        case ELICITATION:
            return DECLINE_ELICITATION;
        default:
            return METHOD_NOT_FOUND;
    }
}
/**
 * 可选 `availableDecisions`（旧/新 schema）：字符串取白名单交集，
 * 对象分支是持久化 amendment，本项目从不支持，直接忽略；
 * 交集为空表示没有可安全表达的决定，调用方必须回拒绝而不是建卡。
 */
function availableDecisions(record) {
    const raw = record.availableDecisions;
    if (raw === undefined)
        return WHITELIST.map(entry => ({ id: entry.id, label: entry.label }));
    // 有该字段但形状不可解释：不推断允许项，按拒绝路径处理。
    if (!Array.isArray(raw))
        return undefined;
    const offered = new Set();
    for (const item of raw.slice(0, MAX_AVAILABLE_DECISIONS)) {
        if (typeof item !== 'string')
            continue;
        if (WHITELIST.some(entry => entry.id === item))
            offered.add(item);
    }
    return WHITELIST
        .filter(entry => offered.has(entry.id))
        .map(entry => ({ id: entry.id, label: entry.label }));
}
export function classifyCodexServerRequest(method, params) {
    // 远端答题契约未验证：无答案结算，页面也不展示可答卡。
    if (method === USER_INPUT)
        return { kind: 'response', response: NO_ANSWERS };
    if (method === ELICITATION)
        return { kind: 'response', response: DECLINE_ELICITATION };
    if (method !== COMMAND_APPROVAL && method !== FILE_CHANGE_APPROVAL
        && method !== PERMISSIONS_APPROVAL) {
        return { kind: 'response', response: METHOD_NOT_FOUND };
    }
    const record = asRecord(params);
    if (record === undefined || typeof record.threadId !== 'string' || record.threadId === ''
        || typeof record.itemId !== 'string' || record.itemId === '') {
        return { kind: 'response', response: declineResponseFor(method) };
    }
    const decisions = availableDecisions(record);
    if (decisions === undefined || decisions.length === 0) {
        return { kind: 'response', response: declineResponseFor(method) };
    }
    if (method === PERMISSIONS_APPROVAL) {
        // 即使 availableDecisions 列出 accept 也不给：点了也只会拿到空授权。
        const safe = decisions.filter(decision => PERMISSION_WIDENING_DECISIONS.has(decision.id));
        if (safe.length === 0)
            return { kind: 'response', response: declineResponseFor(method) };
        return { kind: 'approval', approval: { action: '请求扩大权限', decisions: safe } };
    }
    if (method === FILE_CHANGE_APPROVAL) {
        const reason = record.reason;
        return {
            kind: 'approval',
            approval: {
                action: '修改文件',
                ...(typeof reason === 'string' && reason !== '' ? { detail: reason } : {}),
                decisions,
            },
        };
    }
    const command = record.command;
    return {
        kind: 'approval',
        approval: {
            action: '运行命令',
            // 只接受原样字符串；对象/数组绝不 stringify 后当命令展示。
            ...(typeof command === 'string' && command !== '' ? { detail: command } : {}),
            decisions,
        },
    };
}
/** 中继决定 -> 原生决策；只有字面量 'accept' 才是允许，其余一律保守。 */
function nativeDecision(decision) {
    if (decision.decision === 'cancel')
        return 'cancel';
    if (decision.decision === 'answer') {
        if (decision.value === 'accept')
            return 'accept';
        if (decision.value === 'cancel')
            return 'cancel';
    }
    return 'decline';
}
export function codexResponseFor(method, _params, decision) {
    switch (method) {
        case COMMAND_APPROVAL:
        case FILE_CHANGE_APPROVAL:
            return { result: { decision: nativeDecision(decision) } };
        case PERMISSIONS_APPROVAL:
            return EMPTY_GRANT;
        case USER_INPUT:
            return NO_ANSWERS;
        case ELICITATION:
            return DECLINE_ELICITATION;
        default:
            return METHOD_NOT_FOUND;
    }
}
