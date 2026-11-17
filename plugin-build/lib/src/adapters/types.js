/**
 * 适配器在**发起原生调用之前**给出的明确拒绝：会话不存在、参数非法、
 * 能力不支持等。只有这种错误可以安全记为 `rejected`；调用之后的异常
 * 没有可靠证据，必须由 runner 记为 `outcome-unknown`。
 */
export class PreCallRejection extends Error {
    name = 'PreCallRejection';
    code;
    constructor(code, detail) {
        super(detail === undefined ? `marshal: ${code}: ${code}` : `marshal: ${code}: ${detail}`);
        this.code = code;
    }
}
export function hasWriteControl(ownership) {
    return ownership === 'ours' || ownership === 'attached';
}
