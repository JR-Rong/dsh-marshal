/**
 * 把 marshal 插件使用的紧凑参数 DSL 转成 DSH 工具注册要求的 JSON Schema。
 *
 * 官方工具都经 defineTool() 注册，它会调用 parameterSchemaSpecToJsonSchema；
 * 直接 ctx.tools.register(raw) 会把 DSL 原样交给模型供应商，DeepSeek 的函数
 * schema 校验会把 properties.title 当成 JSON Schema 的 title 关键字而报
 * "is not of type string"。这里在注册前做同一层转换。
 */
function convertProperty(spec) {
    if (spec === null || typeof spec !== 'object') return spec;
    if (spec.properties !== undefined) return convertObject(spec);
    const out = {};
    if (spec.description !== undefined) out.description = spec.description;
    if (spec.type !== undefined) out.type = spec.type;
    if (spec.enum !== undefined) out.enum = [...spec.enum];
    if (spec.items !== undefined) {
        out.items = spec.items !== null && typeof spec.items === 'object' && spec.items.properties !== undefined
            ? convertObject(spec.items)
            : convertProperty(spec.items);
    }
    if (spec.type === 'object') out.additionalProperties = spec.additionalProperties === true;
    return out;
}

function convertObject(spec) {
    const properties = {};
    const required = [];
    const source = spec.properties !== undefined ? spec.properties : spec;
    for (const [name, value] of Object.entries(source)) {
        properties[name] = convertProperty(value);
        if (value !== null && typeof value === 'object' && value.required === true) required.push(name);
    }
    return {
        type: 'object',
        ...(spec.description === undefined ? {} : { description: spec.description }),
        properties,
        ...(required.length === 0 ? {} : { required }),
        additionalProperties: spec.additionalProperties === true,
    };
}

export function specToJsonSchema(parameters) {
    return convertObject({ properties: parameters, additionalProperties: false });
}
