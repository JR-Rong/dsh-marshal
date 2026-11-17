/**
 * 稳定、可穷举的不可用原因码。页面/ACK 只应按码渲染，不能依赖自由文本。
 * 新增原因时同步更新页面与测试；细节放 `detail`，且不得包含凭据、路径或正文。
 */
export const UNAVAILABLE_REASONS = [
    'agent-missing',
    'not-installed',
    'version-unsupported',
    'protocol-unsupported',
    'probe-failed',
    'probe-timeout',
    'spawn-failed',
    'start-failed',
    'auth-required',
    'config-invalid',
    'terminal-failure',
    'restart-exhausted',
    'idle-reclaimed',
    'stopped',
    'disabled',
    'ownership-unverified',
    'capability-unavailable',
    'snapshot-failed',
    'health-failed',
    'disposed',
    'unknown',
];
/**
 * 适配器可以抛出它给出比“snapshot-failed”更准确的原因；Host 会原样记录，
 * 不会把 Error.message 写进能力文档或日志。
 */
export class AgentUnavailableError extends Error {
    name = 'AgentUnavailableError';
    unavailable;
    constructor(unavailable) {
        super(`marshal: agent unavailable: ${unavailable.reason}`);
        this.unavailable = unavailable;
    }
}
