const TRACE_PREFIX = '<!--marshal-trace:';
const TRACE_SUFFIX = '-->\n';
const MAX_EVENT_BYTES = 60 * 1024;

function clampTail(str, maxChars) {
    const clean = String(str ?? '').trim();
    if (!clean) return '';
    return clean.length <= maxChars ? clean : '…' + clean.slice(-(maxChars - 1));
}

function sanitizeSteps(steps, maxItems = 24) {
    if (!Array.isArray(steps) || steps.length === 0) return [];
    return steps
        .slice(-maxItems)
        .map(item => {
            if (!item || typeof item !== 'object') return null;
            const label = String(item.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
            if (!label) return null;
            const status = item.status === 'running' || item.status === 'failed' ? item.status : 'done';
            const detail = typeof item.detail === 'string' && item.detail.trim() ? item.detail.trim().slice(0, 100) : undefined;
            return { label, status, ...(detail ? { detail } : {}) };
        })
        .filter(Boolean);
}

/**
 * Prepend a compact HTML-comment trace header onto an agent bubble's text when
 * thinking or processing steps were captured. Returns `text` unchanged when no
 * thinking or steps exist, keeping plain/mock outputs byte-identical.
 */
export function encodeAgentTrace(text, rawTrace) {
    const body = String(text ?? '');
    if (!rawTrace || typeof rawTrace !== 'object') return body;
    const steps = sanitizeSteps(rawTrace.steps);
    let thinking = clampTail(rawTrace.thinking, 9500);
    if (!thinking && steps.length === 0) return body;

    const buildHeader = thinkStr => {
        const payload = {
            v: 1,
            ...(thinkStr ? { thinking: thinkStr } : {}),
            ...(steps.length > 0 ? { steps } : {}),
            ...(typeof rawTrace.durationMs === 'number' && Number.isFinite(rawTrace.durationMs)
                ? { durationMs: Math.max(0, Math.round(rawTrace.durationMs)) } : {}),
            ...(typeof rawTrace.model === 'string' && rawTrace.model.trim()
                ? { model: rawTrace.model.trim().slice(0, 80) } : {}),
            ...(typeof rawTrace.stepCount === 'number' && rawTrace.stepCount > 0
                ? { stepCount: Math.round(rawTrace.stepCount) } : {}),
        };
        const json = JSON.stringify(payload).replace(/-->/g, '--\\u003e');
        return TRACE_PREFIX + json + TRACE_SUFFIX;
    };

    let header = buildHeader(thinking);
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    if (Buffer.byteLength(header, 'utf8') + bodyBytes > MAX_EVENT_BYTES && thinking) {
        const avail = Math.max(400, MAX_EVENT_BYTES - bodyBytes - 2048);
        thinking = clampTail(thinking, Math.floor(avail / 3));
        header = buildHeader(thinking);
    }
    if (Buffer.byteLength(header, 'utf8') + bodyBytes > 63 * 1024) {
        return body;
    }
    return header + body;
}

export function decodeAgentTrace(rawText) {
    const raw = String(rawText ?? '');
    if (!raw.startsWith(TRACE_PREFIX)) return { text: raw, trace: undefined };
    const endIdx = raw.indexOf(TRACE_SUFFIX, TRACE_PREFIX.length);
    if (endIdx === -1 || endIdx > 48 * 1024) return { text: raw, trace: undefined };
    const jsonPart = raw.slice(TRACE_PREFIX.length, endIdx);
    const rest = raw.slice(endIdx + TRACE_SUFFIX.length);
    try {
        const parsed = JSON.parse(jsonPart);
        if (!parsed || typeof parsed !== 'object') return { text: rest, trace: undefined };
        return { text: rest, trace: parsed };
    } catch {
        return { text: raw, trace: undefined };
    }
}

export function stripAgentTrace(rawText) {
    return decodeAgentTrace(rawText).text;
}
