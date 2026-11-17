import { AgentUnavailableError, } from "./types.js";
import { unavailableCapability, } from "./registry.js";
export class AgentHostError extends Error {
    name = 'AgentHostError';
    code;
    agent;
    constructor(code, agent) {
        super(agent === undefined ? `marshal: ${code}` : `marshal: ${code}: ${agent}`);
        this.code = code;
        this.agent = agent;
    }
}
function throwIfAborted(signal) {
    if (signal.aborted)
        throw signal.reason;
}
/** 只取样例给出的稳定原因，绝不把 Error.message 写进能力文档。 */
function causeOf(error) {
    return error instanceof AgentUnavailableError
        ? error.unavailable
        : { reason: 'snapshot-failed' };
}
function unavailableDocument(agent, cause) {
    return { agent, capability: unavailableCapability(cause) };
}
export function createAgentHost(options) {
    const { registry } = options;
    let disposed = false;
    let disposePromise;
    const resolveHealth = (entry) => {
        const recorded = registry.healthOf(entry.agent);
        if (recorded !== undefined
            && (recorded.state === 'unavailable'
                || recorded.state === 'failed'
                || recorded.state === 'stopped')) {
            return recorded;
        }
        try {
            // adapter.health() 是实时诊断；读取失败只降低这一项。
            const reported = entry.adapter.health();
            return {
                ...reported,
                agent: entry.agent,
                runtimeEpoch: entry.adapter.runtimeEpoch,
            };
        }
        catch {
            const base = recorded ?? {
                agent: entry.agent,
                runtimeEpoch: entry.adapter.runtimeEpoch,
                state: entry.state,
                updatedAt: entry.updatedAt,
            };
            return { ...base, state: 'unavailable', unavailable: { reason: 'health-failed' } };
        }
    };
    const requireAgent = (agent) => {
        if (disposed)
            throw new AgentHostError('host-disposed', agent);
        const entry = registry.entries().find(item => item.agent === agent);
        if (entry === undefined)
            throw new AgentHostError('agent-unknown', agent);
        return entry;
    };
    return {
        get agents() {
            return registry.list();
        },
        get disposed() {
            return disposed;
        },
        health() {
            return registry.entries().map(resolveHealth);
        },
        healthOf(agent) {
            if (disposed && !registry.has(agent))
                return undefined;
            const entry = registry.entries().find(item => item.agent === agent);
            return entry === undefined ? undefined : resolveHealth(entry);
        },
        async snapshotAll(signal) {
            if (disposed)
                throw new AgentHostError('host-disposed');
            throwIfAborted(signal);
            const rows = [];
            const capabilities = [];
            const reports = [];
            let complete = true;
            // 逐个采集，单个 adapter 的失败只影响它自己的报告。
            for (const entry of registry.entries()) {
                throwIfAborted(signal);
                try {
                    const snapshot = await entry.adapter.syncSnapshot(signal);
                    if (snapshot.completeness !== 'complete')
                        complete = false;
                    const ownRows = [...snapshot.rows];
                    const ownCapabilities = snapshot.capabilities.filter(item => item.agent === entry.agent);
                    if (ownCapabilities.length === 0) {
                        const fallback = registry.capabilityDocument(entry.agent);
                        ownCapabilities.push(fallback ?? {
                            agent: entry.agent,
                            capability: { unavailable: { adapter: 'capability-unavailable' } },
                        });
                    }
                    rows.push(...ownRows);
                    capabilities.push(...ownCapabilities);
                    registry.markReady(entry.agent);
                    reports.push({
                        agent: entry.agent,
                        state: 'ready',
                        rows: ownRows,
                        capabilities: ownCapabilities,
                        completeness: snapshot.completeness,
                    });
                }
                catch (error) {
                    // 调用方中止不是 adapter 故障，不能吞掉。
                    if (signal.aborted)
                        throw error;
                    const cause = causeOf(error);
                    const document = unavailableDocument(entry.agent, cause);
                    complete = false;
                    registry.markUnavailable(entry.agent, cause);
                    capabilities.push(document);
                    reports.push({
                        agent: entry.agent,
                        state: 'unavailable',
                        rows: [],
                        capabilities: [document],
                        completeness: 'unconfirmed',
                        unavailable: cause,
                    });
                }
            }
            return {
                rows,
                capabilities,
                completeness: complete ? 'complete' : 'unconfirmed',
                agents: reports,
            };
        },
        execute(agent, command) {
            let entry;
            try {
                entry = requireAgent(agent);
            }
            catch (error) {
                return Promise.reject(error);
            }
            return entry.adapter.execute(command);
        },
        follow(agent, sessionId, signal) {
            const entry = requireAgent(agent);
            return entry.adapter.follow(sessionId, signal);
        },
        dispose() {
            if (disposePromise !== undefined)
                return disposePromise;
            disposed = true;
            disposePromise = (async () => {
                for (const entry of registry.entries()) {
                    try {
                        await entry.adapter.stop();
                    }
                    catch {
                        // 一个 adapter 停止失败不能阻止其它进程清理。
                    }
                    registry.setState(entry.agent, 'stopped', { reason: 'disposed' });
                }
            })();
            return disposePromise;
        },
    };
}
