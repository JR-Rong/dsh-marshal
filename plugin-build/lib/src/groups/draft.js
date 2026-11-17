const DRAFT_SYSTEM = [
    '你是调度官的智能体配置助手。用户会给一句话描述，你要把它变成一个可用的智能体定义。',
    '只输出严格 JSON，不要 markdown，不要解释。格式：',
    '{"name":"...","brief":"...","permission":"read-only|workspace-write|danger-full-access"}',
    '规则：',
    '- name：2-12 个中文字符，像人名或角色名，不要带标点。',
    '- brief：120-300 字，写清职责、性格/语气、工作方式、边界与禁止事项；它会被放进该智能体会话的系统提示。',
    '- permission：审查/只读/分析类用 read-only；写代码/改文件用 workspace-write；只有用户明确要求完全访问才用 danger-full-access。',
    '- 不要编造工具、模型或不存在的配置。',
].join('\n');

export function parseAgentDraft(text) {
    let raw = String(text ?? '').trim();
    const fence = raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
    if (fence !== null) raw = fence[1].trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error('draft-invalid-json'); }
    const name = typeof data.name === 'string' ? data.name.trim().slice(0, 40) : '';
    const brief = typeof data.brief === 'string' ? data.brief.trim().slice(0, 2000) : '';
    const permission = ['read-only', 'workspace-write', 'danger-full-access'].includes(data.permission)
        ? data.permission
        : 'workspace-write';
    if (name === '' || brief === '') throw new Error('draft-invalid-fields');
    return { name, brief, permission };
}

export function createAgentDrafter({ llm, defaultModel } = {}) {
    if (llm === undefined) return undefined;
    return async (text, preferred) => {
        const seen = [];
        const candidates = [];
        const push = (provider, model) => {
            if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return;
            if (!candidates.some((entry) => entry.provider === provider && entry.model === model)) {
                candidates.push({ provider, model });
            }
        };
        if (preferred !== undefined && preferred !== null) {
            push(preferred.provider, preferred.model);
            seen.push(preferred.provider + ':preferred');
        }
        // 部署默认模型最可靠：就是当前会话在用的那条路由。
        if (typeof defaultModel === 'function') {
            try {
                const fallback = defaultModel();
                if (fallback !== undefined && fallback !== null) {
                    push(fallback.provider, fallback.model);
                    seen.push(fallback.provider + ':default');
                }
            }
            catch { /* ignore an unavailable default service */ }
        }
        // 再按 provider 目录补充候选；不是每个 provider 都有可用模型。
        try {
            const providers = llm.listProviders();
            if (Array.isArray(providers)) {
                for (const entry of providers) {
                    const provider = typeof entry === 'string' ? entry : entry && entry.id;
                    if (typeof provider !== 'string' || provider === '') continue;
                    try {
                        const models = await llm.listModels(provider);
                        const list = Array.isArray(models) ? models : [];
                        seen.push(provider + ':' + list.length);
                        for (const model of list) {
                            if (model && typeof model.id === 'string') { push(provider, model.id); break; }
                        }
                    }
                    catch { seen.push(provider + ':error'); }
                }
            }
        }
        catch { /* no catalog: the default route may still work */ }
        if (candidates.length === 0) throw new Error('no-model (' + seen.join(', ') + ')');
        let prepared;
        for (const candidate of candidates) {
            try {
                prepared = await llm.prepareCall({ ...candidate, maxTokens: 900 });
                break;
            }
            catch { seen.push(candidate.provider + ':call-failed'); }
        }
        if (prepared === undefined) throw new Error('no-model (' + seen.join(', ') + ')');
        let output = '';
        for await (const chunk of prepared.stream({
            ...prepared.config,
            tools: [],
            messages: [
                { role: 'user', content: [{ type: 'text', text: DRAFT_SYSTEM + '\n\n用户描述：' + String(text).slice(0, 500) }] },
            ],
        })) {
            if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta') output += chunk.text;
            if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') break;
        }
        return parseAgentDraft(output);
    };
}
