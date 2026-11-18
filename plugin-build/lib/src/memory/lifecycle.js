const STOP_GRAMS = new Set(['什么', '怎么', '为什', '么样', '怎样', '为何', '哪个', '哪些', '哪种', '多少', '那个', '这个', '那些', '这些', '一下', '上次', '最近', '是不', '不是', '有没', '没有', '能不', '可以', '应该', '我们', '你们', '他们']);

export function queryTerms(text) {
    const source = String(text ?? '').toLowerCase();
    const whole = new Set();
    const grams = new Set();
    for (const chunk of source.split(/[\s，。；、,.!?！？:：()（）【】「」“”"'…—\-\/\\|]+/u)) {
        if (chunk === '') continue;
        if (chunk.length >= 3) whole.add(chunk);
        else if (chunk.length === 2 && !STOP_GRAMS.has(chunk)) grams.add(chunk);
        for (const latin of chunk.match(/[a-z0-9_+#.]+/g) ?? []) if (latin.length >= 2) whole.add(latin);
        for (const run of chunk.match(/[\u3400-\u9fff\uf900-\ufaff]+/gu) ?? []) {
            if (run.length > 2) for (let i = 0; i + 1 < run.length; i++) {
                const gram = run.slice(i, i + 2);
                if (!STOP_GRAMS.has(gram)) grams.add(gram);
            }
        }
    }
    return { whole: [...whole].slice(0, 16), grams: [...grams].slice(0, 60) };
}

export function topicSimilarity(a, b) {
    const left = queryTerms(a);
    const right = queryTerms(b);
    const one = new Set([...left.whole, ...left.grams]);
    const two = new Set([...right.whole, ...right.grams]);
    if (one.size === 0 || two.size === 0) return 0;
    let hit = 0;
    for (const term of one) if (two.has(term)) hit++;
    return hit / Math.max(one.size, two.size);
}

export function redactMemory(text) {
    return String(text ?? '')
        .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, '[已脱敏]')
        .replace(/\b1[3-9]\d{9}\b/g, '[手机号已脱敏]')
        .replace(/\b\d{17}[0-9Xx]\b/g, '[证件号已脱敏]');
}

export function neutralizeMemory(text) {
    const source = redactMemory(text);
    return source
        .split('\n')
        .filter(line => !/^\s*(ignore (all|previous)|忽略(以上|之前|所有).*(规则|指令)|system prompt|you are now)/i.test(line))
        .map(line => line.replace(/<\/?(system|assistant|developer|memory)>/gi, '［标签］'))
        .join('\n')
        .slice(0, 8000);
}

export function clarityLine(record) {
    const kind = record.kind ?? 'fact';
    const text = neutralizeMemory(record.content);
    if (record.clarity === 'fuzzy') return '- 〔' + kind + '·模糊〕' + text.slice(0, 70) + '…（细节记不清了）';
    if (record.clarity === 'trace') return '- 好像有「' + String(record.title ?? '').slice(0, 30) + '」这件事…（想不起来了）';
    const limit = record.clarity === 'clear' ? 160 : 240;
    return '- 〔' + kind + '〕' + (text.length > limit ? text.slice(0, limit) + '…' : text);
}

export function scoreCandidate({ kind = 'fact', text = '', importance, pinned = false }) {
    const body = String(text ?? '');
    let score = Number.isFinite(Number(importance)) ? Number(importance) : 45;
    if (!Number.isFinite(Number(importance))) {
        if (kind === 'decision' || kind === 'promise') score += 20;
        if (kind === 'profile' || kind === 'handoff') score += 30;
        if (/决定|采用|以后|统一|不要|必须|记住|验收|结论|选型/.test(body)) score += 18;
        if (/今天|刚刚|临时|随便|吃了|天气/.test(body)) score -= 24;
        if (body.length < 8) score -= 15;
    }
    if (pinned) score = Math.max(score, 90);
    return Math.max(0, Math.min(100, Math.round(score)));
}

export function shouldStore(kind, score) {
    if (kind === 'event' || kind === 'scene') return score >= 70;
    if (kind === 'feeling') return score >= 60;
    return score >= 42;
}
