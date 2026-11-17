/**
 * Claude 的只读发现：`listSessions` / `getSessionMessages` 都是读本地 JSONL 的
 * 只读 API，**这里绝不 import `query`**——观察不得 spawn CLI，也不得触发推理。
 *
 * 两个 API 都是 `limit` + `offset` 的偏移分页（`sdk.d.ts:1138, :934`）。
 * 完整性判定只用「这一页是否满页」：满页说明可能还有下一页，只有不满页才是
 * 终止页；达到页数上限或游标异常一律 `complete: false`，绝不把残缺当全量。
 */
export const CLAUDE_MAX_PAGE_SIZE = 100;
export const CLAUDE_DEFAULT_LIST_PAGE_SIZE = 100;
export const CLAUDE_DEFAULT_HISTORY_PAGE_SIZE = 100;
export const CLAUDE_DEFAULT_MAX_PAGES = 200;
function clampPageSize(value, fallback) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    return Math.min(CLAUDE_MAX_PAGE_SIZE, Math.max(1, Math.floor(value)));
}
function clampPages(value) {
    if (value === undefined || !Number.isFinite(value))
        return CLAUDE_DEFAULT_MAX_PAGES;
    return Math.min(CLAUDE_DEFAULT_MAX_PAGES, Math.max(1, Math.floor(value)));
}
/**
 * `HistoryRequest.cursor` 的编码：十进制 offset 字符串。
 * 非法游标返回 undefined，由调用方拒绝（不猜 0，避免静默重放首页）。
 */
export function parseHistoryCursor(cursor) {
    if (cursor === undefined)
        return 0;
    if (!/^(?:0|[1-9][0-9]{0,8})$/.test(cursor))
        return undefined;
    return Number(cursor);
}
/**
 * 全量清单。重复 sessionId 去重但 offset 仍按返回条数前进；
 * 空页或不足一页即终止。
 */
export async function listAllSessions(sdk, signal, options = {}) {
    const pageSize = clampPageSize(options.pageSize, CLAUDE_DEFAULT_LIST_PAGE_SIZE);
    const maxPages = clampPages(options.maxPages);
    const sessions = [];
    const seen = new Set();
    let offset = 0;
    for (let page = 0; page < maxPages; page += 1) {
        if (signal.aborted)
            throw signal.reason;
        const request = {
            limit: pageSize,
            offset,
            ...(options.dir === undefined ? {} : { dir: options.dir }),
        };
        const batch = await sdk.listSessions(request);
        for (const info of batch) {
            if (typeof info.sessionId !== 'string' || info.sessionId === '')
                continue;
            if (seen.has(info.sessionId))
                continue;
            seen.add(info.sessionId);
            sessions.push(info);
        }
        if (batch.length < pageSize)
            return { sessions, complete: true };
        offset += batch.length;
    }
    return { sessions, complete: false };
}
/** 单页历史；`nextCursor` 只在整页时给出。 */
export async function listSessionMessagesPage(sdk, params, signal) {
    const offset = parseHistoryCursor(params.cursor);
    if (offset === undefined)
        throw new RangeError('marshal: invalid claude history cursor');
    if (signal.aborted)
        throw signal.reason;
    const limit = clampPageSize(params.limit, CLAUDE_DEFAULT_HISTORY_PAGE_SIZE);
    const request = {
        limit,
        offset,
        // 系统消息（压缩边界、提示）不属于可投影内容，明确排除而不是事后过滤。
        includeSystemMessages: false,
        ...(params.dir === undefined ? {} : { dir: params.dir }),
    };
    const batch = await sdk.getSessionMessages(params.sessionId, request);
    const full = batch.length >= limit;
    return {
        messages: batch,
        ...(full ? { nextCursor: String(offset + batch.length) } : {}),
        complete: !full,
    };
}
/** 第一次 init 之前或构造失败时也可能走到这里，缺字段按 0 处理。 */
function updatedAtOf(info) {
    const value = info.lastModified;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return 0;
    return Math.floor(value);
}
/**
 * 从原生名称或首条输入构造有界标题，再由节点隐私层决定是否同步并脱敏。
 * cwd 不进入索引；blank 只携带空会话布尔状态。
 */
export function claudeRow(info) {
    const summary = typeof info.summary === 'string' ? info.summary.trim() : '';
    const firstPrompt = typeof info.firstPrompt === 'string' ? info.firstPrompt.trim() : '';
    const customTitle = typeof info.customTitle === 'string' ? info.customTitle.trim() : '';
    return {
        sessionId: info.sessionId,
        title: (customTitle || summary || firstPrompt || "新会话").replace(/\s+/g, " ").slice(0, 160),
        // Claude 的 `SDKSessionInfo` 没有 running/status 字段（spike §2），
        // 外部会话没有任何存活证据，因此恒为 false；所有权另行标为 foreign-unknown。
        // 受管会话的运行态由适配器用本地 Query 状态覆盖。
        running: false,
        updatedAt: updatedAtOf(info),
        blank: summary === '' && firstPrompt === '' && customTitle === '',
    };
}
