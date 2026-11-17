export class AgentRegistryError extends Error {
    name = 'AgentRegistryError';
    code;
    agent;
    constructor(code, agent) {
        super(`marshal: ${code}: ${agent}`);
        this.code = code;
        this.agent = agent;
    }
}
/** 把通用 Capability 序列化成 wire 能力文档；字段与会话级投影白名单保持一致。 */
export function toCapabilityDocument(capability) {
    return {
        observe: { history: capability.observe.history, follow: capability.observe.follow },
        operations: [...capability.operations],
        ownership: capability.ownership,
        reasoning: capability.reasoning,
        toolDetail: capability.toolDetail,
        promptFidelity: capability.promptFidelity,
        tunables: capability.tunables,
        ...(capability.unavailable === undefined ? {} : { unavailable: capability.unavailable }),
    };
}
/** 失败 agent 的能力文档只能带稳定原因码；detail 留在本机 health。 */
export function unavailableCapability(cause) {
    return { unavailable: { adapter: cause.reason } };
}
export function createAgentRegistry(options = {}) {
    const now = options.now ?? Date.now;
    const items = new Map();
    const healthOf = (agent) => {
        const item = items.get(agent);
        if (item === undefined)
            return undefined;
        return {
            agent,
            runtimeEpoch: item.adapter.runtimeEpoch,
            state: item.state,
            updatedAt: item.updatedAt,
            ...(item.reason === undefined ? {} : { unavailable: item.reason }),
            ...(item.capability === undefined ? {} : { capability: item.capability }),
            ...(item.lastProbe === undefined ? {} : { lastProbe: item.lastProbe }),
        };
    };
    const touch = (agent, item) => {
        item.updatedAt = now();
        items.set(agent, item);
    };
    return {
        register(adapter) {
            const existing = items.get(adapter.agent);
            if (existing !== undefined) {
                if (existing.adapter === adapter)
                    return;
                throw new AgentRegistryError('agent-duplicate', adapter.agent);
            }
            items.set(adapter.agent, {
                adapter,
                state: 'starting',
                reason: undefined,
                capability: undefined,
                lastProbe: undefined,
                updatedAt: now(),
            });
        },
        unregister(agent) {
            return items.delete(agent);
        },
        has(agent) {
            return items.has(agent);
        },
        get(agent) {
            return items.get(agent)?.adapter;
        },
        list() {
            return [...items.keys()];
        },
        entries() {
            return [...items.entries()].map(([agent, item]) => ({
                agent,
                runtimeEpoch: item.adapter.runtimeEpoch,
                adapter: item.adapter,
                state: item.state,
                updatedAt: item.updatedAt,
                ...(item.reason === undefined ? {} : { reason: item.reason }),
                ...(item.capability === undefined ? {} : { capability: item.capability }),
                ...(item.lastProbe === undefined ? {} : { lastProbe: item.lastProbe }),
            }));
        },
        health() {
            return [...items.keys()].flatMap(agent => {
                const health = healthOf(agent);
                return health === undefined ? [] : [health];
            });
        },
        healthOf,
        setState(agent, state, reason) {
            const item = items.get(agent);
            if (item === undefined)
                return false;
            item.state = state;
            item.reason = reason;
            touch(agent, item);
            return true;
        },
        markReady(agent, capability) {
            const item = items.get(agent);
            if (item === undefined)
                return false;
            item.state = 'ready';
            item.reason = undefined;
            if (capability !== undefined)
                item.capability = capability;
            touch(agent, item);
            return true;
        },
        markUnavailable(agent, cause) {
            const item = items.get(agent);
            if (item === undefined)
                return false;
            item.state = 'unavailable';
            item.reason = cause;
            touch(agent, item);
            return true;
        },
        recordProbe(agent, result) {
            const item = items.get(agent);
            if (item === undefined)
                return false;
            item.lastProbe = result;
            if (result.ok) {
                item.state = 'ready';
                item.reason = undefined;
                if (result.capability !== undefined)
                    item.capability = result.capability;
            }
            else {
                item.state = 'unavailable';
                item.reason = result.unavailable ?? { reason: 'probe-failed' };
                if (result.capability !== undefined)
                    item.capability = result.capability;
            }
            touch(agent, item);
            return true;
        },
        recordCapability(agent, capability) {
            const item = items.get(agent);
            if (item === undefined)
                return false;
            item.capability = capability;
            touch(agent, item);
            return true;
        },
        capabilityDocument(agent) {
            const item = items.get(agent);
            if (item?.capability === undefined)
                return undefined;
            return { agent, capability: toCapabilityDocument(item.capability) };
        },
    };
}
