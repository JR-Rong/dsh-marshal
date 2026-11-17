/** 固定顺序：能力文档、测试与页面都按它渲染。 */
export const SETTINGS_FIELDS = [
    'model', 'reasoning', 'permission', 'plan', 'goal', 'skill', 'plugin',
];
export function isSettingsField(value) {
    return SETTINGS_FIELDS.includes(value);
}
const REASONS = {
    catalogUnavailable: 'catalog-unavailable',
    permissionLatticeUnavailable: 'permission-lattice-unavailable',
    settingsReadbackUnavailable: 'settings-readback-unavailable',
    privacyReadbackUnavailable: 'privacy-readback-unavailable',
    readOnlyInV0: 'read-only-in-v0',
    hostConfig: 'host-config',
};
const FIELD_SHAPES = {
    model: { scope: 'next-turn', effect: 'immediate' },
    reasoning: { scope: 'next-turn', effect: 'immediate', direction: 'tighten-only' },
    permission: { scope: 'next-session', effect: 'next-session', direction: 'tighten-only' },
    plan: { scope: 'next-turn', effect: 'immediate' },
    goal: { scope: 'next-turn', effect: 'immediate' },
    skill: { scope: 'host', effect: 'needs-restart' },
    plugin: { scope: 'host', effect: 'needs-restart' },
};
export function findModel(catalog, modelId) {
    return catalog.models.find(model => model.id === modelId);
}
/**
 * 只认目录里显式写出的整数 rank；缺失、非整数或模型未列出时返回 undefined，
 * 调用方据此 fail closed。绝不从数组下标推断等级。
 */
export function effortRank(catalog, modelId, effortId) {
    const model = findModel(catalog, modelId);
    if (model?.efforts === undefined)
        return undefined;
    const level = model.efforts.find(effort => effort.id === effortId);
    if (level === undefined)
        return undefined;
    return Number.isInteger(level.rank) ? level.rank : undefined;
}
function isHostField(field) {
    return field === 'skill' || field === 'plugin';
}
function directoryValues(entries) {
    if (entries === undefined || entries.length === 0)
        return undefined;
    return entries.map(entry => ({ id: entry.id, label: entry.label ?? entry.id }));
}
function directoryFor(catalog, field) {
    return directoryValues(field === 'skill' ? catalog.skills : catalog.plugins);
}
/**
 * DSH（以及任何未显式开放设置的 agent）只读：不声称回读、不给出 current，
 * 避免把请求值或本地缓存当成已确认值。
 */
function readOnlyTunables(catalog) {
    return SETTINGS_FIELDS.map((field) => {
        const host = isHostField(field);
        const values = host ? directoryFor(catalog, field) : undefined;
        return {
            id: field,
            ...FIELD_SHAPES[field],
            ...(values === undefined ? {} : { values }),
            editable: false,
            reason: host ? REASONS.hostConfig : REASONS.readOnlyInV0,
        };
    });
}
export function buildTunables(catalog, current, options) {
    // 只有已实测开放设置的 agent 才走可编辑分支；未知 agent 保持只读。
    if (catalog.agent !== 'codex' && catalog.agent !== 'claude')
        return readOnlyTunables(catalog);
    const contentAuthorized = options?.contentAuthorized === true;
    const readback = catalog.readback;
    const currentModel = current?.model === undefined ? undefined : findModel(catalog, current.model);
    const modelValues = directoryValues(catalog.models);
    const modelEditable = readback.model === true && modelValues !== undefined;
    // 只展示有显式等级的强度档；没有 rank 的档无法比较，给了也只会被拒绝。
    const rankedEfforts = currentModel?.efforts?.filter(level => Number.isInteger(level.rank)) ?? [];
    const reasoningValues = rankedEfforts.length === 0
        ? undefined
        : rankedEfforts.map(level => ({ id: level.id, label: level.id }));
    // 与 decideConfigure 的确认基线要求对齐，避免页面展示必然被拒绝的可编辑项。
    const reasoningEditable = readback.reasoning === true && rankedEfforts.length >= 2
        && current?.model !== undefined && current?.reasoning !== undefined;
    const permissionEditable = readback.permission === true && catalog.permissionLattice !== undefined
        && current?.permission !== undefined;
    const planEditable = readback.plan === true && current?.plan !== undefined;
    const goalEditable = readback.goal === true && contentAuthorized;
    const skillValues = directoryFor(catalog, 'skill');
    const pluginValues = directoryFor(catalog, 'plugin');
    return [
        {
            id: 'model',
            ...FIELD_SHAPES.model,
            ...(modelValues === undefined ? {} : { values: modelValues }),
            ...(current?.model === undefined ? {} : { current: current.model }),
            editable: modelEditable,
            ...(modelEditable ? {} : { reason: REASONS.catalogUnavailable }),
        },
        {
            id: 'reasoning',
            ...FIELD_SHAPES.reasoning,
            ...(reasoningValues === undefined ? {} : { values: reasoningValues }),
            ...(current?.reasoning === undefined ? {} : { current: current.reasoning }),
            editable: reasoningEditable,
            ...(reasoningEditable ? {} : { reason: REASONS.catalogUnavailable }),
        },
        {
            id: 'permission',
            ...FIELD_SHAPES.permission,
            ...(current?.permission === undefined ? {} : { current: current.permission }),
            editable: permissionEditable,
            ...(permissionEditable ? {} : { reason: REASONS.permissionLatticeUnavailable }),
        },
        {
            id: 'plan',
            ...FIELD_SHAPES.plan,
            ...(current?.plan === undefined ? {} : { current: current.plan }),
            editable: planEditable,
            ...(planEditable ? {} : { reason: REASONS.settingsReadbackUnavailable }),
        },
        {
            id: 'goal',
            ...FIELD_SHAPES.goal,
            // goal 的 current 只有存在性；objective 文本永不进入能力文档。
            ...(current?.goal === undefined ? {} : { current: current.goal }),
            editable: goalEditable,
            ...(goalEditable
                ? {}
                : { reason: contentAuthorized ? REASONS.settingsReadbackUnavailable : REASONS.privacyReadbackUnavailable }),
        },
        {
            id: 'skill',
            ...FIELD_SHAPES.skill,
            ...(skillValues === undefined ? {} : { values: skillValues }),
            editable: false,
            reason: REASONS.hostConfig,
        },
        {
            id: 'plugin',
            ...FIELD_SHAPES.plugin,
            ...(pluginValues === undefined ? {} : { values: pluginValues }),
            editable: false,
            reason: REASONS.hostConfig,
        },
    ];
}
