/** Global memories have two visibility levels. Anything else is no-group. */
export function normalizeGlobalVisibility(value) {
    return value === 'all' ? 'all' : 'no-group';
}

/**
 * Injection rule, enforced by the caller from the session type.
 * `all` is injected everywhere. `no-group` is injected only outside group chat.
 */
export function globalMemoryVisible(item, group) {
    if (item === null || typeof item !== 'object' || item.scope !== 'global') return true;
    if (item.visibility === 'all') return true;
    return group !== true;
}

const DIRECT_TYPES = new Set(['direct', 'solo', 'single', '1:1', '1on1']);
const GROUP_TYPES = new Set(['group', 'discussion']);

function headerOf(identity) {
    const header = identity?.session?.header;
    return header !== null && typeof header === 'object' ? header : undefined;
}

/**
 * Fail closed. A session is not a group only when we positively know it is a
 * 1:1: an explicit direct marker, or a readable group roster that does not
 * contain its session id. Missing identity, an unreadable roster, or no
 * session id without an explicit direct marker is treated as a group.
 */
export function sessionIsGroup(identity, groupSessionIds) {
    const roster = groupSessionIds instanceof Set
        ? { ids: groupSessionIds, status: 'ok' }
        : (groupSessionIds !== null && typeof groupSessionIds === 'object' ? groupSessionIds : { ids: new Set(), status: 'unknown' });
    const ids = roster.ids instanceof Set ? roster.ids : new Set();
    const status = roster.status === 'ok' || roster.status === 'missing' ? roster.status : 'unknown';
    if (identity === null || typeof identity !== 'object') return true;
    const header = headerOf(identity);
    const sessionType = typeof identity.sessionType === 'string' ? identity.sessionType : '';
    const headerKind = typeof header?.kind === 'string' ? header.kind : '';
    const headerChat = typeof header?.chat === 'string' ? header.chat : '';
    if (identity.group === true || GROUP_TYPES.has(sessionType) || GROUP_TYPES.has(headerKind) || GROUP_TYPES.has(headerChat)
        || header?.group === true || typeof identity.groupId === 'string' || typeof identity.session?.groupId === 'string'
        || typeof identity.discussionId === 'string') return true;
    const sessionId = typeof identity.sessionId === 'string' && identity.sessionId !== ''
        ? identity.sessionId
        : (typeof identity.session?.id === 'string' ? identity.session.id : '');
    if (sessionId !== '' && ids.has(sessionId)) return true;
    if (status === 'unknown') return true;
    const explicitDirect = identity.group === false || header?.group === false
        || DIRECT_TYPES.has(sessionType) || DIRECT_TYPES.has(headerKind) || DIRECT_TYPES.has(headerChat);
    if (sessionId === '') return !explicitDirect;
    return false;
}

export function normalizeFact(text) {
    return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Drop SQLite rows whose text is already present in the file-memory block. */
export function dedupeMemories(fileText, items) {
    const file = normalizeFact(fileText);
    if (file === '' || !Array.isArray(items)) return Array.isArray(items) ? items : [];
    return items.filter(item => {
        const content = normalizeFact(item?.content ?? '');
        const fact = normalizeFact((item?.title ?? '') + '\n' + (item?.content ?? ''));
        if (content.length >= 12 && file.includes(content)) return false;
        if (fact.length >= 12 && file.includes(fact)) return false;
        return true;
    });
}
