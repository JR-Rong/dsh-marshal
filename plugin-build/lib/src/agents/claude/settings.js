import { PreCallRejection } from "../../adapters/types.js";
/**
 * Claude 设置端口（`@anthropic-ai/claude-agent-sdk@0.3.316`）。
 *
 * SDK 只提供返回 void 的 setter（`setModel`/`setPermissionMode`/`applyFlagSettings`）
 * 和一次性的 init 快照；两者都不是“当前值”的合法回读。没有真实读回渠道时
 * 绝不发布伪造 current，也不接受任何字段的写入（包括 goal/model/plan）。
 * 目标机验证设置回读之前，所有 configure 都在调用 SDK 之前拒绝。
 */
export function createClaudeSettingsPort(options) {
    return {
        async readSettings(request, _signal) {
            if (request.runtimeEpoch !== options.runtimeEpoch) {
                throw new PreCallRejection('stale-connection');
            }
            // 没有可验证的当前值来源：返回空值，而不是把请求/初始缓存当确认值。
            return { values: [], runtimeEpoch: options.runtimeEpoch, revision: 0 };
        },
        async configure(request, _signal) {
            if (request.runtimeEpoch !== options.runtimeEpoch) {
                throw new PreCallRejection('stale-connection');
            }
            throw new PreCallRejection('unsupported', 'settings-readback-unavailable');
        },
    };
}
