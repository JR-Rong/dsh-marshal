/** 契约 §10：深度超限只留标记，绝不原样透传深层内容。 */
export const MAX_REDACTION_DEPTH = 16;
export const DEPTH_MARKER = '[truncated]';
function mask(text, patterns) {
    let out = text;
    for (const pattern of patterns)
        out = out.replace(pattern, '***');
    return out;
}
/**
 * 复制并替换敏感片段；深度超过 `MAX_REDACTION_DEPTH` 的对象整体替换为标记。
 * 循环引用会因深度上限自然停止，不需要额外的 visited 集合。
 */
export function redact(value, patterns, depth = 0) {
    if (typeof value === 'string')
        return mask(value, patterns);
    if (value === null || typeof value !== 'object')
        return value;
    if (depth >= MAX_REDACTION_DEPTH)
        return DEPTH_MARKER;
    if (Array.isArray(value))
        return value.map(item => redact(item, patterns, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        // 键名同样可能夹带密钥，先脱敏再落盘；碰撞时后写覆盖即可。
        const safeKey = mask(key, patterns);
        // 不用赋值语法：`__proto__` 会改写原型而不是写入自有属性。
        Object.defineProperty(out, safeKey, {
            value: redact(item, patterns, depth + 1),
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return out;
}
