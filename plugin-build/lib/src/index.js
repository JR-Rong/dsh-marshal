import { createDiscussionPort } from "./discussions/ports.js";
import { createNodeDiscussions } from "./discussions/node.js";
import { DISCUSSION_FEATURE } from "./discussions/types.js";
import { hasWriteControl } from "./adapters/types.js";
import { mountHub } from "./hub/runtime.js";
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mountSidebarConnection } from "./sidebar.js";
import { parseConfig } from "./config.js";
import { decodeFrame, encodeFrame } from "./wire/frames.js";
import { readAgentsLedger } from "./groups/inventory.js";
import { createDshSurface } from "./adapters/dsh/surface.js";
import { createDshAdapter } from "./adapters/dsh/adapter.js";
import { createCodexAdapter } from "./agents/codex/adapter.js";
import { createClaudeAdapter } from "./agents/claude/adapter.js";
import { NodeLink } from "./node/link.js";
import { createNodeSync } from "./node/sync.js";
import { openJournal } from "./node/journal.js";
import { hubHttpOrigin, startPhoneRelay } from "./node/phone-sync.js";
import { createFollower, runRoutedCommand } from "./node/runner.js";
import { createSeqAllocator, withPublicSeq } from "./node/seq.js";
import { createQuestionRelay } from "./node/questions.js";
import { createInteractionRelay } from "./node/interactions.js";
import { createAuditLog } from "./node/audit.js";
import { createPrivacyProjector } from "./node/privacy.js";
import { mountSetup } from "./setup.js";
import { mountDispatch } from "./dispatch/mount.js";
import { attachFileProposals, mountMemory } from "./memory/mount.js";
import { mountAgentMemory } from "./memory/agent-memory.js";
import { mountGroups } from "./groups/mount.js";
import { mountWorkspaceIdentity } from "./groups/workspace-identity.js";
export const name = 'marshal';
export function apply(ctx, raw) {
    mountSetup(ctx, raw, applyConfigured);
}
function applyConfigured(ctx, raw) {
    const config = parseConfig(raw, process.env.HOSTNAME ?? 'unknown');
    mountSidebarConnection(ctx, config);
    if (config.role === 'hub') {
        ctx.inject(['webServer'], scoped => applyHub(scoped, config));
    }
    else if (config.agents.includes('dsh')) {
        ctx.inject(config.allowDiscussion ? ['sessionController', 'llm'] : ['sessionController'], scoped => applyNode(scoped, config));
    }
    else {
        applyNode(ctx, config);
    }
}
function applyHub(ctx, config) {
    if (ctx.webServer === undefined)
        throw new Error('marshal: hub role requires the webServer service');
    ctx.effect(() => mountHub(ctx.webServer, config, ctx.logger), 'marshal: hub runtime');
}
const SUPPORTED_AGENTS = new Set(['dsh', 'codex', 'claude']);
function applyNode(ctx, config) {
    // 未知 agent 是启动配置错误：不能带着无法投影的适配器上线。
    for (const agent of config.agents) {
        if (!SUPPORTED_AGENTS.has(agent)) {
            throw new Error(`marshal: unsupported agent in config.agents: ${agent}`);
        }
    }
    // DSH 需要宿主的 sessionController；codex/claude 是独立子进程，不依赖它。
    if (config.agents.includes('dsh') && ctx.sessionController === undefined) {
        throw new Error('marshal: node role requires the sessionController service');
    }
    // journal 在发起任何调用前打开并持有进程间锁；损坏/缺失时直接启动失败，
    // 不能带着空去重表继续接受写命令。
    const hubCa = config.hubCaFile === undefined ? undefined : readFileSync(config.hubCaFile);
    const journal = openJournal();
    // nodeEpoch 只随插件实例生成；普通重连沿用同一个值。
    const nodeEpoch = randomUUID();
    const errorName = (error) => error instanceof Error && error.name !== '' ? error.name : 'error';
    const audit = createAuditLog({ warn: message => ctx.logger.warn(message) });
    // 公开 seq 全节点共用一个分配器；适配器预分配的序号在出站前被覆盖。
    const publicSeq = createSeqAllocator();
    const bindings = new Map();
    const routes = new Map();
    /** 每次握手重建；缺失时一律退回最严格投影。 */
    const projectors = new Map();
    /** 握手前的策略基线：内容/交互必须同时获得两端授权。 */
    const policies = { allowContent: false, allowInteractions: false };
    const buildProjector = (agent, allowContent, allowInteractions) => {
        const nextSeq = bindings.get(agent)?.adapter.nextSeq;
        return createPrivacyProjector({
            privacy: config.privacy,
            allowContent,
            questionRelay: config.questionRelay,
            approvalRelay: config.approvalRelay,
            allowInteractions,
            redaction: config.redaction,
            deviceId: config.deviceId,
            agent,
            nodeEpoch,
            now: Date.now,
            ...(nextSeq === undefined ? {} : { nextSeq: (sessionId) => nextSeq(sessionId) }),
        });
    };
    const fallbackProjectors = new Map();
    const currentProjector = (agent) => {
        const current = projectors.get(agent);
        if (current !== undefined)
            return current;
        // 握手前的兜底也按 agent 缓存，避免每次出口都重编译脱敏规则。
        let strict = fallbackProjectors.get(agent);
        if (strict === undefined) {
            strict = buildProjector(agent, false, false);
            fallbackProjectors.set(agent, strict);
        }
        return strict;
    };
    /** 稳定的委托端口：握手重建后无需重新装配 relay/适配器。 */
    const liveProjector = (agent) => ({
        get content() { return currentProjector(agent).content; },
        event: frame => currentProjector(agent).event(frame),
        ack: ack => currentProjector(agent).ack(ack),
        error: (origin, code, meta) => currentProjector(agent).error(origin, code, meta),
        syncRow: row => currentProjector(agent).syncRow(row),
        statusResult: result => currentProjector(agent).statusResult(result),
        card: card => currentProjector(agent).card(card),
        auditFields: fields => currentProjector(agent).auditFields(fields),
    });
    let discussions;
    let nodeSync;
    /** 逐事件兜底：单帧超限或投影失败只丢这一帧，不能终止跟随循环。 */
    const emitProjected = (agent, event) => {
        let projected;
        try {
            projected = currentProjector(agent).event(event);
        }
        catch (error) {
            ctx.logger.warn(`marshal: project ${agent} dropped event: ${errorName(error)}`);
            return;
        }
        for (const item of projected) {
            try {
                // 同步层记录已投影的增量，扫描时不能用更旧的清单覆盖它。
                nodeSync?.observe(item);
                link.sendEvent(withPublicSeq(publicSeq, item));
            }
            catch (error) {
                ctx.logger.warn(`marshal: send ${agent} dropped event: ${errorName(error)}`);
            }
        }
    };
    // 卡片/通知是交互帧：只走 volatile 出口，断线即丢，绝不进入离线队列。
    // 序号在投影之后统一分配；卡片 payload 已由 relay 投影，这里只补公开 seq。
    const emitVolatile = (event) => {
        link.sendVolatileEvent(withPublicSeq(publicSeq, event));
    };
    const register = (agent, adapter, runtimeEpoch, relayPort) => {
        const emit = (event) => { emitProjected(agent, event); };
        const follower = createFollower({ adapter, send: emit, logger: ctx.logger });
        const inputs = {
            // 待答快照只读：node 内存里的当前有效卡，公开高水位与事件同源。
            snapshot: (sessionId) => relayPort?.snapshot(sessionId) ?? [],
            // 卡片由 relay 的实例代次产出；没有 relay 时退回节点握手代次。
            runtimeEpoch: () => runtimeEpoch,
            // 必须按会话取高水位：hub 把它当作该会话的回放/去重底价。
            highWatermark: (sessionId) => publicSeq.highWatermark({
                deviceId: config.deviceId, agent, sessionId, nodeEpoch,
            }),
        };
        bindings.set(agent, {
            agent, adapter, runtimeEpoch, follower,
            liveProjector: liveProjector(agent),
            relayPort,
            emit,
            emitVolatile,
            inputs,
        });
        // 命令/状态/待答快照都按 target.agent 走各自的投影器与审计。
        routes.set(agent, { adapter, follower, runtime: { projector: () => currentProjector(agent), audit, inputs,
                ...(config.allowDiscussion ? { discussion: (frame, args) => discussions.execute(frame, args) } : {}) } });
    };
    if (config.agents.includes('dsh')) {
        let dshRelay;
        const dshAdapter = createDshAdapter(createDshSurface(ctx.sessionController), {
            deviceId: config.deviceId,
            nodeEpoch,
            answers: {
                settle: (sessionId, requestId, answers) => dshRelay?.settle(sessionId, requestId, answers) ?? 'unknown',
                // 普通提问的 cancel 只结算本进程待答表，不是原生会话取消。
                cancel: (sessionId, requestId) => dshRelay?.cancel(sessionId, requestId) ?? 'unknown',
            },
        });
        if (config.questionRelay !== 'off') {
            dshRelay = createQuestionRelay({
                ctx, timeoutMs: config.answerTimeoutMs,
                projector: liveProjector('dsh'),
                runtimeEpoch: nodeEpoch,
                send: event => emitVolatile(event),
                frame: dshAdapter.frame,
                // 断线/syncing 期间暂停新认领；已认领的请求仍按原 monoDeadline 等待。
                available: () => link.online,
                now: Date.now,
                monoNow: () => globalThis.performance.now(),
                deviceId: config.deviceId,
                agent: 'dsh',
                // 当前协商授权；DSH 只有普通提问，relay 字段必须显式带上。
                authorization: () => {
                    const current = link.binding;
                    if (current === undefined)
                        return undefined;
                    return {
                        relay: config.questionRelay,
                        operatorId: current.operatorId,
                        policyRevision: current.policyRevision,
                        allowInteractions: current.policies.allowInteractions,
                        content: liveProjector('dsh').content,
                    };
                },
            });
        }
        register('dsh', dshAdapter, nodeEpoch, dshRelay);
    }
    /**
     * Codex/Claude 的交互中继：authorization 不含 relay（由 relay 按 kind 组合），
     * stillOwned 用适配器自己的写权端口判断，不能把只读会话的卡交给远答。
     */
    const interactionRelay = (agent, adapter, runtimeEpoch) => {
        if (config.questionRelay === 'off' && config.approvalRelay === 'off')
            return undefined;
        return createInteractionRelay({
            questionRelay: config.questionRelay,
            approvalRelay: config.approvalRelay,
            questionTimeoutMs: config.answerTimeoutMs,
            approvalTimeoutMs: config.approvalTimeoutMs,
            projector: liveProjector(agent),
            runtimeEpoch,
            send: event => emitVolatile(event),
            // 帧工厂由适配器给出；claim 只会在适配器构造完成后发生。
            frame: (sessionId, kind, payload) => adapter().frame(sessionId, kind, payload),
            authorization: () => handshakeAuthorization(agent),
            available: () => link.online,
            stillOwned: sessionId => hasWriteControl(adapter().ownershipPort?.ownership(sessionId) ?? 'unverified'),
            deviceId: config.deviceId,
            agent,
            now: Date.now,
            monoNow: () => globalThis.performance.now(),
        });
    };
    const handshakeAuthorization = (agent) => {
        const current = link.binding;
        if (current === undefined)
            return undefined;
        return {
            operatorId: current.operatorId,
            policyRevision: current.policyRevision,
            allowInteractions: current.policies.allowInteractions,
            content: projectors.get(agent)?.content === true,
        };
    };
    if (config.agents.includes('codex')) {
        const codexEpoch = `${nodeEpoch}:codex:${randomUUID()}`;
        let codexAdapter;
        const codexRelay = interactionRelay('codex', () => codexAdapter, codexEpoch);
        codexAdapter = createCodexAdapter({
            deviceId: config.deviceId,
            nodeEpoch,
            runtimeEpoch: codexEpoch,
            questionRelay: config.questionRelay,
            approvalRelay: config.approvalRelay,
            ...(codexRelay === undefined ? {} : { inputRelay: codexRelay }),
            // 设置正文是否可见只看当前投影器，不看 wire 或请求参数。
            contentAuthorized: () => projectors.get('codex')?.content === true,
            ...(config.codexExecutable === undefined ? {} : { explicitPath: config.codexExecutable }),
        });
        register('codex', codexAdapter, codexEpoch, codexRelay);
    }
    if (config.agents.includes('claude')) {
        const claudeEpoch = `${nodeEpoch}:claude:${randomUUID()}`;
        let claudeAdapter;
        const claudeRelay = interactionRelay('claude', () => claudeAdapter, claudeEpoch);
        claudeAdapter = createClaudeAdapter({
            deviceId: config.deviceId,
            nodeEpoch,
            runtimeEpoch: claudeEpoch,
            questionRelay: config.questionRelay,
            approvalRelay: config.approvalRelay,
            ...(claudeRelay === undefined ? {} : { inputRelay: claudeRelay }),
            ...(config.claudeExecutable === undefined
                ? {}
                : { pathToClaudeCodeExecutable: config.claudeExecutable }),
        });
        register('claude', claudeAdapter, claudeEpoch, claudeRelay);
    }
    /** 未知 agent 的帧工厂：同步层理论上不会走到这里，但也不能抛。 */
    const frameFor = (agent, sessionId, kind, payload) => {
        const source = bindings.get(agent);
        if (source !== undefined)
            return source.adapter.frame(sessionId, kind, payload);
        return {
            v: 2, type: 'event', deviceId: config.deviceId, agent, sessionId,
            nodeEpoch, seq: 0, ts: Date.now(), kind, payload,
        };
    };
    let lastInventory;
    const publishInventory = () => {
        try {
            const ledger = readAgentsLedger();
            const handshake = link.handshake;
            if (handshake !== undefined) {
                const inventory = {
                    v: 2, type: 'device.inventory',
                    connectionId: handshake.connectionId, nodeEpoch: handshake.nodeEpoch,
                    deviceName: config.deviceName,
                    squads: ledger.teams.map(team => ({
                        id: team.id,
                        name: team.name,
                        ...(team.workspaceId ? { workspaceId: team.workspaceId } : {}),
                        members: team.members.map(member => ({
                            id: member.id,
                            name: member.name,
                            ...(member.preset === undefined ? {} : { preset: member.preset }),
                            ...(member.permission === undefined ? {} : { permission: member.permission }),
                            ...(member.model === undefined ? {} : { model: member.model }),
                            ...(member.reasoningEffort === undefined ? {} : { reasoningEffort: member.reasoningEffort }),
                            ...(member.brief === undefined ? {} : { brief: member.brief }),
                            ...(member.sessionId === undefined ? {} : { sessionId: member.sessionId }),
                        })),
                    })),
                    codex: config.agents.includes('codex'),
                };
                const serialized = encodeFrame(inventory);
                if (serialized !== lastInventory) {
                    link.sendControl(serialized);
                    lastInventory = serialized;
                }
            }
        }
        catch { /* inventory is optional metadata */ }
    };
    const link = new NodeLink({
        ...(hubCa === undefined ? {} : { ca: hubCa }),
        url: config.hubUrl, token: config.token, deviceId: config.deviceId,
        deviceName: config.deviceName,
        agents: config.agents,
        nodeEpoch,
        features: config.allowDiscussion ? [DISCUSSION_FEATURE] : [],
        privacy: config.privacy,
        onFrame: text => {
            let frame;
            try {
                frame = decodeFrame(text);
            }
            catch {
                return;
            }
            // sync.ack 是生命周期控制帧，不能进入命令分派。
            if (frame.type === 'sync.ack') {
                nodeSync?.onFrame(frame);
                return;
            }
            // 按 target.agent 分派到该 agent 的适配器/跟随表/投影器；未知 agent 只回拒绝。
            runRoutedCommand(link, routes, frame, config.deviceId, journal, Date.now);
        },
        onHandshake: (binding, previous) => {
            discussions?.invalidate();
            void discussions?.announce().catch(() => { });
            lastInventory = undefined;
            publishInventory();
            const tightened = (previous?.policies.allowContent === true && binding.policies.allowContent !== true)
                || (previous?.policies.allowInteractions === true && binding.policies.allowInteractions !== true);
            // 每个 relay 都先按新协商复核旧卡：授权变化（含仅 revision 变化）立即结算，
            // 且必须发生在重建投影器之前，否则收紧后连 invalidated 终态都发不出去。
            for (const item of bindings.values())
                item.relayPort?.revalidate();
            policies.allowContent = binding.policies.allowContent;
            policies.allowInteractions = binding.policies.allowInteractions;
            // 每个 agent 各自重建：agent 名参与投影，不能共享实例。
            for (const agent of config.agents)
                projectors.set(agent, buildProjector(agent, policies.allowContent, policies.allowInteractions));
            // 旧队列按更宽策略编码，不能在新握手上补发。
            if (tightened)
                link.clearOutbound();
        },
        // hello.ack 后进入 syncing：先完成原子快照屏障，绝不能在这里冲刷普通事件。
        onSyncNeeded: () => { nodeSync?.begin(); },
        // 订阅绑定当前连接：断线即清空每个 agent 的跟随引用。
        onOffline: () => {
            nodeSync?.abort();
            discussions?.invalidate();
            for (const item of bindings.values())
                item.follower.stopAll();
        },
        onError: error => ctx.logger.warn(`marshal: link error: ${errorName(error)}`),
    });
    const inventoryTimer = config.groups ? setInterval(() => {
        if (link.online) publishInventory();
    }, 5_000) : undefined;
    inventoryTimer?.unref();
    if (config.allowDiscussion)
        discussions = createNodeDiscussions({
            enabled: true, journal, link: () => link,
            allowsTaskWorkspace: workspaceId => config.groups && readAgentsLedger().teams.some(team => team.workspaceId === workspaceId),
            port: createDiscussionPort({ agents: config.agents, ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
                ...(config.codexExecutable === undefined ? {} : { codexExecutable: config.codexExecutable }),
                ...(config.claudeExecutable === undefined ? {} : { claudeExecutable: config.claudeExecutable }),
            }),
        });
    nodeSync = createNodeSync({
        link,
        sources: [...bindings.values()].map(item => ({
            agent: item.agent,
            syncSnapshot: (signal) => item.adapter.syncSnapshot(signal),
            sessionCapability: (sessionId) => {
                const capability = item.adapter.capabilities(sessionId);
                return { ...capability, operations: [...capability.operations] };
            },
        })),
        agents: config.agents,
        projector: agent => currentProjector(agent),
        emit: event => {
            const item = bindings.get(event.agent);
            if (item !== undefined)
                item.emit(event);
            else
                emitProjected(event.agent, event);
        },
        frame: (agent, sessionId, kind, payload) => frameFor(agent, sessionId, kind, payload),
        highWatermark: () => publicSeq.highWatermark(),
        logger: ctx.logger,
    });
    // 调度台（派单台账 + 记忆）：刻意放在中继装配之后，失败只降级这两个能力，
    // 绝不影响 node ↔ hub 的会话中继本身。
    let memoryService;
    let agentMemoryService;
    if (config.memory) {
        try {
            memoryService = mountMemory(ctx, config, { logger: ctx.logger });
        }
        catch (error) {
            ctx.logger.warn(`marshal: memory unavailable: ${errorName(error)}`);
        }
        try {
            agentMemoryService = mountAgentMemory(ctx, config, { logger: ctx.logger, fileMemory: memoryService });
            attachFileProposals(memoryService, agentMemoryService);
        }
        catch (error) {
            ctx.logger.warn(`marshal: agent memory unavailable: ${errorName(error)}`);
        }
    }
    if (config.dispatch) {
        try {
            mountDispatch(ctx, config, { logger: ctx.logger, memory: memoryService?.store });
        }
        catch (error) {
            ctx.logger.warn(`marshal: dispatch unavailable: ${errorName(error)}`);
        }
    }
    if (config.groups) {
        try {
            // Only the route table is needed to reach this callback: waiting on every
            // service the squad module uses keeps it from mounting at all when one of
            // them is provided elsewhere in the tree. The module resolves the rest,
            // and a delayed attempt on the plugin context covers a callback that
            // never fires, which otherwise leaves every agent view silently empty.
            let attempted = false;
            const mountEmbeddedAgents = scoped => {
                if (attempted || agentsMountState() !== undefined) return;
                attempted = true;
                const origin = typeof scoped.webServer?.getOrigin === 'function'
                    ? scoped.webServer.getOrigin()
                    : typeof scoped.webServer?.port === 'number' ? 'http://127.0.0.1:' + scoped.webServer.port : '';
                const probe = origin
                    ? fetch(origin + '/dsh-agents/api/state', { signal: AbortSignal.timeout(600) })
                        .then(res => res.status !== 404).catch(() => false)
                    : Promise.resolve(false);
                void probe.then(async (alreadyMounted) => {
                    if (alreadyMounted) { markAgentsMount('served-elsewhere'); return; }
                    const mod = await import('./dsh-agents/index.js');
                    try {
                        mod.apply(scoped, {});
                        markAgentsMount('mounted');
                    }
                    catch (error) {
                        markAgentsMount('error: ' + errorName(error));
                        ctx.logger.warn(`marshal: embedded dsh-agents skipped: ${errorName(error)}`);
                    }
                }).catch((error) => {
                    markAgentsMount('error: ' + errorName(error));
                    ctx.logger.warn(`marshal: embedded dsh-agents unavailable: ${errorName(error)}`);
                });
            };
            try { ctx.inject(['webServer'], mountEmbeddedAgents); } catch (error) {
                ctx.logger.warn(`marshal: embedded dsh-agents inject skipped: ${errorName(error)}`);
            }
            try {
                ctx.effect(() => {
                    const timer = setTimeout(() => { if (agentsMountState() === undefined) mountEmbeddedAgents(ctx); }, 1500);
                    timer.unref?.();
                    return () => clearTimeout(timer);
                }, 'marshal: embedded dsh-agents fallback');
            } catch { /* no effect scheduler: the inject above still tries */ }
        }
        catch (error) {
            ctx.logger.warn(`marshal: embedded dsh-agents inject skipped: ${errorName(error)}`);
        }
        try {
            ctx.inject(['systemPrompt', 'typertGateway', 'workspaceRegistry', 'webServer', 'agents', 'commands'], (scoped) => {
                if (lookupService(ctx, 'taskBoard') !== undefined || lookupService(scoped, 'taskBoard') !== undefined) return;
                void import('./task-board/index.js').then((tb) => {
                    if (lookupService(ctx, 'taskBoard') !== undefined || lookupService(scoped, 'taskBoard') !== undefined) return;
                    tb.apply(scoped, {});
                }).catch((error) => {
                    ctx.logger.warn(`marshal: embedded task-board unavailable: ${errorName(error)}`);
                });
            });
        }
        catch (error) {
            ctx.logger.warn(`marshal: embedded task-board inject skipped: ${errorName(error)}`);
        }
        try {
            mountGroups(ctx, config, { logger: ctx.logger, memory: agentMemoryService });
        }
        catch (error) {
            ctx.logger.warn(`marshal: groups unavailable: ${errorName(error)}`);
        }
        try {
            mountWorkspaceIdentity(ctx);
        }
        catch (error) {
            ctx.logger.warn(`marshal: workspace identity unavailable: ${errorName(error)}`);
        }
    }
    const phoneHost = () => {
        const board = lookupService(ctx, 'taskBoard');
        const hostMemory = lookupService(ctx, 'memory');
        const memory = typeof hostMemory?.readPhone === 'function' ? hostMemory : agentMemoryService;
        const hostRoster = lookupService(ctx, 'roster');
        const roster = typeof hostRoster?.list === 'function' ? hostRoster : config.groups ? { list() {
            const ledger = readAgentsLedger();
            if (!ledger.available) return { code: 'unavailable' };
            return { agents: ledger.teams.flatMap(team => team.members.map(member => ({
                id: team.id + '/' + member.id, name: member.name,
            }))) };
        } } : undefined;
        return {
            ...(board === undefined ? {} : { board }),
            ...(memory === undefined ? {} : { memory }),
            ...(roster === undefined ? {} : { roster }),
        };
    };
    const stopRelay = config.hubUrl !== undefined && config.token !== undefined && config.deviceId !== undefined
        ? startPhoneRelay({
            host: phoneHost,
            contentGrant: () => {
                const handshake = link.handshake;
                const binding = link.binding;
                if (!link.online || !handshake || binding?.policies.allowContent !== true)
                    return undefined;
                return { connectionId: handshake.connectionId, policyRevision: binding.policyRevision };
            },
            origin: hubHttpOrigin(config.hubUrl),
            token: config.token,
            deviceId: config.deviceId,
            ...(hubCa === undefined ? {} : { ca: hubCa }),
        })
        : undefined;
    ctx.effect(() => () => {
        clearInterval(inventoryTimer);
        stopRelay?.();
        discussions?.dispose();
        nodeSync?.dispose();
        for (const item of bindings.values()) {
            item.follower.stopAll();
            item.relayPort?.dispose();
            // 只有 AgentAdapter 有 stop；DSH 适配器随宿主卸载，不能伪造生命周期。
            const stoppable = item.adapter;
            if (typeof stoppable.stop === 'function')
                void stoppable.stop().catch(() => { });
        }
        link.close();
        journal.close();
    }, 'marshal: node link');
    link.start();
}
/**
* Record why the embedded squad service did or did not mount.
*
* `/dsh-agents/api/*` is either served by this build, by another installed agents
* plugin, or not at all — and a silent third case leaves every agent view empty.
* The state rides a global so `/marshal/health` can report it without threading a
* value through the route factory.
*/
function markAgentsMount(state) {
    globalThis[AGENTS_MOUNT_STATE_KEY] = state;
}
function agentsMountState() {
    try { return globalThis[AGENTS_MOUNT_STATE_KEY]; } catch { return undefined; }
}
const AGENTS_MOUNT_STATE_KEY = Symbol.for('marshal.dshAgentsMountState.v1');
function lookupService(ctx, name) {
    const bag = ctx;
    if (typeof bag.get !== 'function') return undefined;
    try { return bag.get(name); }
    catch { return undefined; }
}
