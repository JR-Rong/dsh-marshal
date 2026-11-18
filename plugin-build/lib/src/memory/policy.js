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

export function sessionIsGroup(identity, groupSessionIds) {
    if (identity === null || typeof identity !== 'object') return false;
    if (identity.group === true || identity.sessionType === 'group') return true;
    const header = identity.session?.header;
    if (header !== null && typeof header === 'object') {
        if (header.group === true || header.kind === 'group' || header.chat === 'group') return true;
    }
    const sessionId = identity.sessionId;
    return typeof sessionId === 'string' && sessionId !== '' && groupSessionIds?.has(sessionId) === true;
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
