import { attachmentText, validateOptions } from "../controls.js";
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { PreCallRejection, hasWriteControl, } from "../../adapters/types.js";
import { AgentUnavailableError, } from "../types.js";
import { createOwnershipCoordinator, OwnershipError } from "../ownership.js";
import { createSupervisor } from "../supervisor.js";
import { classifyCodexServerRequest, codexResponseFor } from "./approvals.js";
import { resolveCodexBinary } from "./binary.js";
import { listAllThreads, threadRow } from "./discover.js";
import { notificationThreadId, toCodexEvents, turnToEvents, } from "./map.js";
import { CodexPeerError, createCodexPeer, } from "./peer.js";
import { CODEX_CLIENT_INFO, CODEX_KNOWN_NOTIFICATIONS, parseInitializeResponse, parseThread, parseThreadListResponse, parseThreadRefResponse, parseThreadStatus, parseTurn, parseTurnStartResponse, parseVersionFromUserAgent, supportsVersion, threadRunning, } from "./protocol.js";
import { listHistoryPage } from "./history.js";
import { createCodexStatistics } from "./statistics.js";
import { createCodexSessionRegistry } from "./session.js";
import { CODEX_SETTINGS_CATALOG, createCodexSettingsPort } from "./settings.js";
import { buildTunables } from "../../tunables/catalog.js";
/**
 * Codex 基础适配器（app-server over stdio）。
 *
 * 安全边界：
 * - 观察不恢复会话；显式 acquire 才调用 thread/resume，保持原 ID。
 * - 恢复后使用 attached（原生句柄，非跨进程排他）；有效句柄才能 turn/start。
 * - steer 未经验证，保持关闭；interrupt 必须带 runtimeEpoch + 已绑定 turnId。
 * - 所有副作用调用只发一次；超时/断连不做任何自动重发。
 */
const CAPABILITY_REVISION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const CODEX_TUNABLES = [
    { id: 'model', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
    { id: 'reasoning', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
    { id: 'permission', scope: 'next-session', effect: 'next-session', direction: 'tighten-only', editable: false, reason: 'settings-readback-unavailable' },
    { id: 'plan', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
    { id: 'goal', scope: 'next-turn', effect: 'immediate', editable: false, reason: 'settings-readback-unavailable' },
    { id: 'skill', scope: 'host', effect: 'needs-restart', editable: false, reason: 'host-config' },
    { id: 'plugin', scope: 'host', effect: 'needs-restart', editable: false, reason: 'host-config' },
];
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/** 原生请求所属会话；缺失/非法时不能交给中继，只能按协议拒绝。 */
function requestThreadId(params) {
    const threadId = asRecord(params)?.threadId;
    return typeof threadId === 'string' && threadId !== '' ? threadId : undefined;
}
function withSignal(promise, signal) {
    if (signal.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => { reject(signal.reason); };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(value => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, error => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
/** JSON-RPC 错误意味着原生调用没有被受理；映射成无副作用的调用前拒绝。 */
function rpcRejection(error) {
    switch (error.rpcCode) {
        case -32602: return new PreCallRejection('invalid-args');
        case -32601: return new PreCallRejection('unsupported');
        default: return new PreCallRejection('conflict');
    }
}
function parseEmptyResponse(value) {
    // turn/interrupt 的合法响应可能是 `{}`/`null`；只有缺失结果才算协议错误。
    return value === undefined ? undefined : true;
}
export function createCodexAdapter(options) {
    const now = options.now ?? Date.now;
    const runtimeEpoch = options.runtimeEpoch ?? `${options.nodeEpoch}:codex:${randomUUID()}`;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const binary = options.binary ?? resolveCodexBinary({
        ...(options.explicitPath === undefined ? {} : { explicitPath: options.explicitPath }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.platform === undefined ? {} : { platform: options.platform }),
    });
    const sessions = createCodexSessionRegistry();
    const coordinator = createOwnershipCoordinator({
        runtimeEpoch,
        holder: runtimeEpoch,
        now,
    });
    const seqs = new Map();
    let completeness = 'unconfirmed';
    let phase = 'starting';
    let lastProbe;
    let lastVersion;
    let peerEntry;
    let startup;
    let stopping = false;
    /** 正在等待中继决定的原生审批；连接关闭/停止时一次性 abort，留下原生等待会挂死 agent。 */
    const pendingApprovals = new Set();
    const abortPendingApprovals = () => {
        for (const controller of pendingApprovals)
            controller.abort();
        pendingApprovals.clear();
    };
    const nextSeq = (sessionId) => {
        const next = (seqs.get(sessionId) ?? 0) + 1;
        seqs.set(sessionId, next);
        return next;
    };
    const frame = (sessionId, kind, payload) => ({
        v: 2, type: 'event', deviceId: options.deviceId, agent: 'codex', sessionId,
        nodeEpoch: options.nodeEpoch, seq: nextSeq(sessionId), ts: now(), kind, payload,
    });
    const statistics = createCodexStatistics({
        ...(options.env?.CODEX_HOME ? { codexHome: options.env.CODEX_HOME } : {}),
        onChanged: (id, counts) => sessions.publish(id, frame(id, 'session.updated', { counts })),
    });
    let selectedStatistics;
    const refreshStatistics = async (sessionId, signal) => {
        const response = await request('thread/read', { threadId: sessionId, includeTurns: false }, signal, parseThreadRefResponse);
        if (response.thread.id === sessionId)
            await statistics.refresh(sessionId, response.thread.path);
    };
    const closePeer = () => {
        abortPendingApprovals();
        const entry = peerEntry;
        if (entry === undefined)
            return;
        peerEntry = undefined;
        entry.detach();
        entry.peer.close();
    };
    const supervisor = createSupervisor({
        command: binary.entry?.command ?? 'codex',
        args: binary.entry?.args ?? [],
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
        ...(options.platform === undefined ? {} : { platform: options.platform }),
        classify: (error) => {
            if (error instanceof AgentUnavailableError) {
                if (error.unavailable.reason === 'version-unsupported'
                    || error.unavailable.reason === 'protocol-unsupported')
                    return 'terminal';
                if (error.unavailable.reason === 'auth-required'
                    || error.unavailable.reason === 'config-invalid'
                    || error.unavailable.reason === 'not-installed')
                    return 'config';
            }
            return 'retryable';
        },
        onExit: (_generation, reason) => {
            closePeer();
            // 进程退出/重启即丢失受管身份与写权证据；重启不会恢复控制。
            sessions.clear();
            coordinator.clear();
            statistics.resetActive();
            // peer 断开后旧回读不再可信；端口本身保持可用，等新连接重建。
            settings.reset();
            lastVersion = undefined;
            if (!stopping && reason !== 'stopped')
                phase = 'unavailable';
        },
        // 有受管会话时保守地不允许 idle 回收；活跃回合由 coordinator 另行阻止。
        busy: () => sessions.managedIds().length > 0,
    });
    const request = async (method, params, signal, parse) => {
        const peer = await ensurePeer(signal);
        return await peer.request(method, params, signal, parse);
    };
    /**
     * 设置回读变化后重新发布会话能力。回调只会在初始化完成后触发，
     * 因此可以引用后面声明的 buildSessionCapability。
     */
    const publishCapability = (sessionId) => {
        sessions.publish(sessionId, frame(sessionId, 'capability.changed', capabilityPayload(buildSessionCapability(sessionId))));
    };
    const settings = createCodexSettingsPort({
        request,
        runtimeEpoch,
        writable: id => sessions.isManaged(id) && hasWriteControl(coordinator.ownership(id)),
        idle: id => coordinator.state(id) === 'ours-idle',
        beginConfigure: id => coordinator.beginConfigure(id),
        endConfigure: id => coordinator.endConfigure(id),
        onChanged: publishCapability,
        ...(options.now === undefined ? {} : { now: options.now }),
    });
    const relayEnabled = () => options.inputRelay !== undefined
        && (options.questionRelay === 'remote' || options.approvalRelay === 'remote');
    /** 只有本实例受管且当前持有写权的会话才能把原生等待交给中继。 */
    const relayable = (sessionId) => !stopping
        && options.inputRelay !== undefined
        && sessions.isManaged(sessionId)
        && hasWriteControl(coordinator.ownership(sessionId));
    const handleServerRequest = async (request) => {
        const classification = classifyCodexServerRequest(request.method, request.params);
        if (classification.kind === 'response')
            return classification.response;
        const threadId = requestThreadId(request.params);
        const relay = options.inputRelay;
        if (threadId === undefined || relay === undefined || !relayable(threadId)) {
            return codexResponseFor(request.method, request.params, { decision: 'decline' });
        }
        const controller = new AbortController();
        pendingApprovals.add(controller);
        try {
            // 0.166.0 审批不带原生期限，不传 nativeExpiry。
            const decision = await relay.claim({
                kind: 'approval',
                sessionId: threadId,
                runtimeEpoch,
                approval: classification.approval,
            }, controller.signal);
            return codexResponseFor(request.method, request.params, decision);
        }
        catch {
            // 中继异常只影响本次决定；原生端必须收到明确的拒绝而不是被挂起。
            return codexResponseFor(request.method, request.params, { decision: 'decline' });
        }
        finally {
            pendingApprovals.delete(controller);
        }
    };
    const bindTurnFromNotification = (sessionId, params) => {
        const record = asRecord(params);
        const turn = parseTurn(record?.turn);
        if (turn === undefined)
            return;
        const state = coordinator.state(sessionId);
        if (state !== 'ours-running')
            return;
        if (coordinator.turn(sessionId) !== undefined)
            return;
        try {
            coordinator.bindTurn(sessionId, turn.id);
        }
        catch {
            // 晚到/冲突的绑定不能覆盖当前回合；后续 turn/start 响应会自行核对。
        }
    };
    const handleNotification = (method, params) => {
        const sessionId = notificationThreadId(method, params);
        if (sessionId === undefined)
            return;
        const record = asRecord(params);
        statistics.observe(sessionId, method, params);
        if (method === 'thread/started') {
            const thread = parseThread(record?.thread);
            if (thread !== undefined) {
                coordinator.noteObserved(thread.id, threadRunning(thread));
            }
        }
        else if (method === 'thread/status/changed') {
            const status = parseThreadStatus(record?.status);
            if (status !== undefined)
                coordinator.noteObserved(sessionId, status.type === 'active');
        }
        else if (method === 'turn/started') {
            coordinator.noteObserved(sessionId, true);
            bindTurnFromNotification(sessionId, params);
        }
        else if (method === 'turn/completed') {
            const turn = parseTurn(asRecord(params)?.turn);
            if (turn !== undefined)
                coordinator.endTurn(sessionId, turn.id);
            coordinator.noteObserved(sessionId, false);
        }
        // 设置/goal 通知只更新长期 current，没有版次也不是 pending 的确认来源。
        if (method === 'thread/settings/updated'
            || method === 'thread/goal/updated'
            || method === 'thread/goal/cleared') {
            settings.observeNotification(method, params);
        }
        const meta = {
            deviceId: options.deviceId,
            agent: 'codex',
            nodeEpoch: options.nodeEpoch,
            sessionId,
        };
        for (const event of toCodexEvents(method, params, meta, () => nextSeq(sessionId), {
            runtimeEpoch,
            ownership: coordinator.ownership(sessionId),
        })) {
            sessions.publish(sessionId, event);
        }
    };
    const openPeer = async (generation) => {
        const transport = supervisor.transport();
        if (transport === undefined || transport.generation !== generation
            || transport.stdin === null || transport.stdout === null) {
            throw new AgentUnavailableError({ reason: 'start-failed' });
        }
        const stdin = transport.stdin;
        const stdout = transport.stdout;
        const peer = createCodexPeer({
            write: line => {
                if (!stdin.writable)
                    throw new Error('codex stdin closed');
                stdin.write(line + '\n');
            },
            knownNotifications: CODEX_KNOWN_NOTIFICATIONS,
            requestTimeoutMs,
            onFatal: () => {
                if (supervisor.isCurrent(generation))
                    supervisor.fail(new CodexPeerError('protocol'));
            },
            onNotification: handleNotification,
            onServerRequest: handleServerRequest,
        });
        const onData = (chunk) => {
            if (typeof chunk === 'string')
                peer.handle(chunk);
            else if (chunk instanceof Uint8Array)
                peer.handle(Buffer.from(chunk));
        };
        stdout.on('data', onData);
        const entry = {
            generation,
            peer,
            detach: () => { stdout.removeListener('data', onData); },
        };
        peerEntry = entry;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), handshakeTimeoutMs);
        timer.unref();
        try {
            const initialized = await peer.request('initialize', { clientInfo: CODEX_CLIENT_INFO }, controller.signal, parseInitializeResponse);
            const version = parseVersionFromUserAgent(initialized.userAgent);
            if (!supportsVersion(version)) {
                throw new AgentUnavailableError({ reason: 'version-unsupported' });
            }
            peer.notify('initialized');
            // 能力自检：能列出一页即证明 thread/list 可用；不是全量快照。
            await peer.request('thread/list', { limit: 1 }, controller.signal, parseThreadListResponse);
            if (!supervisor.isCurrent(generation)) {
                throw new AgentUnavailableError({ reason: 'start-failed' });
            }
            lastVersion = version;
            supervisor.markReady();
            phase = 'ready';
            return peer;
        }
        catch (error) {
            if (peerEntry?.peer === peer) {
                peerEntry = undefined;
                entry.detach();
            }
            peer.close();
            if (error instanceof AgentUnavailableError) {
                // 版本/协议错误不循环重启，交由监督器进入 failed。
                supervisor.fail(error);
                throw error;
            }
            if (controller.signal.aborted) {
                throw new AgentUnavailableError({ reason: 'start-failed' });
            }
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    };
    async function ensurePeer(signal) {
        if (stopping)
            throw new AgentUnavailableError({ reason: 'stopped' });
        if (signal.aborted)
            throw signal.reason;
        // openPeer 在握手完成前就登记 transport；并发调用必须共享整段初始化屏障。
        if (startup !== undefined)
            return await withSignal(startup, signal);
        const existing = peerEntry;
        if (existing !== undefined && !existing.peer.closed && supervisor.isCurrent(existing.generation)) {
            return existing.peer;
        }
        if (existing?.peer.closed && supervisor.isCurrent(existing.generation)) {
            supervisor.fail(new CodexPeerError('closed'));
        }
        if (!binary.ok) {
            throw new AgentUnavailableError({ reason: binary.reason ?? 'not-installed' });
        }
        const health = supervisor.health();
        if (health.state === 'failed' || health.state === 'stopped') {
            throw new AgentUnavailableError({ reason: health.reason?.reason ?? 'start-failed' });
        }
        if (supervisor.transport() === undefined) {
            if (!supervisor.start()) {
                const after = supervisor.health();
                throw new AgentUnavailableError({ reason: after.reason?.reason ?? 'start-failed' });
            }
        }
        const generation = supervisor.generation;
        startup = openPeer(generation).finally(() => { startup = undefined; });
        return await withSignal(startup, signal);
    }
    /** 控制路径在发送前失败没有副作用；转换为 agent-crashed 而不是伪造 rejected 副作用。 */
    async function ensurePeerForControl(signal) {
        try {
            return await ensurePeer(signal);
        }
        catch (error) {
            if (error instanceof AgentUnavailableError)
                throw new PreCallRejection('agent-crashed');
            throw error;
        }
    }
    const buildAgentCapability = () => {
        const operations = new Set(['create', 'fork', 'acquire']);
        const unavailable = {
            prompt: 'ownership-unverified',
            interrupt: 'ownership-unverified',
            configure: 'settings-readback-unavailable',
        };
        if (relayEnabled()) {
            operations.add('answer');
            operations.add('cancel');
        }
        else {
            unavailable.answer = 'interaction-relay-unavailable';
            unavailable.cancel = 'interaction-relay-unavailable';
        }
        return {
            observe: { history: true, follow: 'stream' },
            operations,
            ownership: 'foreign-unknown',
            reasoning: true,
            toolDetail: 'args+output',
            promptFidelity: 'native',
            tunables: CODEX_TUNABLES,
            unavailable,
            settingsRevision: 0,
            runtimeEpoch,
        };
    };
    const buildSessionCapability = (sessionId) => {
        const ownership = coordinator.ownership(sessionId);
        const owns = hasWriteControl(ownership);
        const managed = sessions.isManaged(sessionId);
        const snapshot = settings.snapshot(sessionId);
        const operations = new Set(['create', 'fork', 'acquire']);
        const unavailable = {};
        // 外部/未管理的会话永远没有可答卡，能力里也不能暴露 answer/cancel。
        if (relayEnabled() && owns && managed) {
            operations.add('answer');
            operations.add('cancel');
        }
        else {
            unavailable.answer = 'interaction-relay-unavailable';
            unavailable.cancel = 'interaction-relay-unavailable';
        }
        if (owns) {
            operations.add('prompt');
            if (coordinator.turn(sessionId) === undefined) {
                unavailable.interrupt = 'no-atomic-turn-binding';
            }
            else {
                operations.add('interrupt');
            }
        }
        else if (managed) {
            unavailable.prompt = 'session-not-owned';
            unavailable.interrupt = 'session-not-owned';
        }
        else {
            unavailable.prompt = 'ownership-unverified';
            unavailable.interrupt = 'ownership-unverified';
        }
        // 只有受管、写权属于本实例且回读未闩锁时才宣传 configure。
        if (managed && owns && snapshot?.unsafe !== true) {
            operations.add('configure');
            delete unavailable.configure;
        }
        else if (snapshot?.unsafe === true) {
            unavailable.configure = 'settings-unsafe';
        }
        else if (managed && !owns) {
            unavailable.configure = 'session-not-owned';
        }
        else {
            unavailable.configure = 'ownership-unverified';
        }
        const pending = snapshot?.pending;
        return {
            observe: { history: true, follow: 'stream' },
            operations,
            ownership,
            reasoning: true,
            toolDetail: 'args+output',
            promptFidelity: 'native',
            tunables: buildTunables(CODEX_SETTINGS_CATALOG, snapshot?.current, {
                contentAuthorized: options.contentAuthorized?.() === true,
            }),
            unavailable,
            settingsRevision: snapshot?.current.revision ?? 0,
            runtimeEpoch,
            ...(pending === undefined
                ? {}
                : {
                    pending: {
                        field: pending.field,
                        status: pending.status === 'pending' ? 'pending' : 'readback-timeout',
                    },
                }),
        };
    };
    const capabilityPayload = (capability) => ({
        observe: { history: capability.observe.history, follow: capability.observe.follow },
        operations: [...capability.operations],
        ownership: capability.ownership,
        reasoning: capability.reasoning,
        toolDetail: capability.toolDetail,
        promptFidelity: capability.promptFidelity,
        tunables: capability.tunables,
        ...(capability.unavailable === undefined ? {} : { unavailable: capability.unavailable }),
        settingsRevision: capability.settingsRevision ?? 0,
        runtimeEpoch: capability.runtimeEpoch ?? runtimeEpoch,
        ...(capability.pending === undefined
            ? {}
            : { pending: { field: capability.pending.field, status: capability.pending.status } }),
        revision: CAPABILITY_REVISION,
        readAt: now(),
    });
    const list = async (signal) => {
        const discovery = await listAllThreads(request, signal);
        for (const thread of discovery.threads) {
            coordinator.noteObserved(thread.id, threadRunning(thread));
        }
        completeness = discovery.complete ? 'complete' : 'unconfirmed';
        if (selectedStatistics)
            await refreshStatistics(selectedStatistics, signal).catch(() => { });
        return { rows: discovery.threads.map(thread => ({ ...threadRow(thread),
                ...(statistics.get(thread.id) ? { counts: statistics.get(thread.id) } : {}) })), completeness };
    };
    const syncSnapshot = async (signal) => {
        const listed = await list(signal);
        return {
            rows: listed.rows,
            capabilities: [{ agent: 'codex', capability: capabilityPayload(buildAgentCapability()) }],
            completeness: listed.completeness,
        };
    };
    const controls = async (sessionId, signal) => {
        const models = [];
        let cursor;
        for (let page = 0; page < 10; page++) {
            const response = await request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }, signal, value => value && typeof value === 'object' && Array.isArray(value.data) ? value : undefined);
            for (const model of response.data) {
                if (model.hidden || typeof model.model !== 'string')
                    continue;
                models.push({ id: model.model, label: model.displayName || model.model,
                    efforts: (model.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort).filter((effort) => typeof effort === 'string') });
            }
            if (!response.nextCursor || response.nextCursor === cursor)
                break;
            cursor = response.nextCursor;
        }
        const response = await request('thread/read', { threadId: sessionId, includeTurns: false }, signal, parseThreadRefResponse);
        if (response.thread.id !== sessionId)
            throw new PreCallRejection('session-unknown');
        selectedStatistics = sessionId;
        await statistics.refresh(sessionId, response.thread.path);
        const model = models.find(model => model.id === response.thread.model);
        return { models: models.slice(0, 100), ...(model ? { current: { model: model.id,
                    ...(response.thread.reasoningEffort && model.efforts.includes(response.thread.reasoningEffort)
                        ? { reasoning: response.thread.reasoningEffort } : {}) } } : {}) };
    };
    const promptSession = async (sessionId, text, signal, extras = {}) => {
        await refreshStatistics(sessionId, signal).catch(() => { });
        if (extras.options)
            validateOptions(await controls(sessionId, signal), extras.options);
        // beginPrompt 在第一个 await 之前置 busy：并发第二次写入立即被拒。
        coordinator.beginPrompt(sessionId);
        let peer;
        try {
            peer = await ensurePeerForControl(signal);
        }
        catch (error) {
            coordinator.endTurn(sessionId);
            throw error;
        }
        try {
            const response = await peer.request('turn/start', {
                threadId: sessionId,
                input: [{ type: 'text', text: attachmentText(text, extras.files) }, ...(extras.files ?? []).filter(file => file.mime.startsWith('image/')).map(file => ({ type: 'localImage', path: file.path }))],
                ...(extras.options?.model ? { model: extras.options.model } : {}),
                ...(extras.options?.reasoning ? { effort: extras.options.reasoning } : {}),
            }, signal, parseTurnStartResponse);
            const turnId = response.turn.id;
            if (turnId === '') {
                coordinator.endTurn(sessionId);
                throw new Error('marshal: codex turn id missing');
            }
            coordinator.bindTurn(sessionId, turnId);
            return { accepted: true, runtimeEpoch, turnId };
        }
        catch (error) {
            if (error instanceof CodexPeerError) {
                if (error.code === 'rpc') {
                    // 原生明确拒绝：没有受理证据，可以安全清除 busy。
                    coordinator.endTurn(sessionId);
                    throw rpcRejection(error);
                }
                if (error.code === 'busy') {
                    // pending 已满：请求尚未写出，不可能产生回合。
                    coordinator.endTurn(sessionId);
                    throw error;
                }
            }
            // write/closed/timeout/aborted/协议错误：无法证明未写出或未受理，保持 busy 直到事件结算。
            throw error;
        }
    };
    const interruptSession = async (sessionId, requestedTurnId, requestedEpoch, signal) => {
        if (requestedEpoch !== runtimeEpoch)
            throw new PreCallRejection('stale-connection');
        const turnId = requestedTurnId ?? coordinator.turn(sessionId);
        if (turnId === undefined)
            throw new PreCallRejection('stale-connection', 'turn-unbound');
        // authorizeControl 只允许当前 runtimeEpoch 绑定的活动回合。
        coordinator.authorizeControl(sessionId, turnId);
        const peer = await ensurePeerForControl(signal);
        try {
            await peer.request('turn/interrupt', { threadId: sessionId, turnId }, signal, parseEmptyResponse);
        }
        catch (error) {
            if (error instanceof CodexPeerError && error.code === 'rpc')
                throw rpcRejection(error);
            throw error;
        }
        return { accepted: true, runtimeEpoch, turnId };
    };
    const ownershipPort = {
        async acquire(sessionId, signal) {
            return await coordinator.acquire(sessionId, async (context) => {
                const peer = await ensurePeerForControl(context.signal);
                const resumed = !sessions.isManaged(sessionId) || sessions.isResumed(sessionId);
                try {
                    const before = await peer.request('thread/read', {
                        threadId: sessionId, includeTurns: false,
                    }, context.signal, parseThreadRefResponse);
                    if (before.thread.id !== sessionId)
                        return undefined;
                    if (before.thread.status?.type === 'active')
                        throw new OwnershipError('writer-busy');
                    let thread = before.thread;
                    if (!sessions.isManaged(sessionId)) {
                        // 显式恢复原 ID，不覆盖模型、工作目录、权限或创建分支。
                        thread = (await peer.request('thread/resume', {
                            threadId: sessionId, excludeTurns: true,
                        }, context.signal, parseThreadRefResponse)).thread;
                    }
                    if (thread.id !== sessionId)
                        return undefined;
                    if (thread.status?.type === 'active')
                        throw new OwnershipError('writer-busy');
                    if (thread.status?.type !== 'idle')
                        return undefined;
                    context.signal.throwIfAborted();
                    if (stopping || peerEntry?.peer !== peer)
                        throw new OwnershipError('stale-runtime');
                    sessions.markManaged(sessionId, resumed);
                    return {
                        sessionId,
                        ...(resumed ? { scope: 'native-runtime' } : {}),
                        mechanism: resumed ? 'native-thread-resume' : 'managed-thread',
                        holder: coordinator.holder,
                        runtimeEpoch,
                        acquiredAt: now(),
                        invalidatesOn: ['process-exit', 'peer-close', 'plugin-reload', 'journal-recovery'],
                    };
                }
                catch (error) {
                    if (error instanceof CodexPeerError && error.code === 'rpc')
                        throw rpcRejection(error);
                    throw error;
                }
            }, { signal });
        },
        async release(sessionId) {
            coordinator.release(sessionId);
        },
        ownership(sessionId) {
            return coordinator.ownership(sessionId);
        },
        evidence(sessionId) {
            return coordinator.evidence(sessionId);
        },
        controlReason(sessionId) {
            return coordinator.controlReason(sessionId);
        },
    };
    const observe = (sessionId, signal) => {
        return (async function* () {
            // 观察同样需要 app-server 运行；启动它不产生会话副作用。
            await ensurePeer(signal);
            yield* sessions.observe(sessionId, signal);
        })();
    };
    const adapter = {
        agent: 'codex',
        runtimeEpoch,
        capabilities(sessionId) {
            return buildSessionCapability(sessionId);
        },
        get snapshotCompleteness() {
            return completeness;
        },
        async probe(signal) {
            const at = now();
            if (!binary.ok) {
                const result = {
                    ok: false,
                    at,
                    runtimeEpoch,
                    unavailable: { reason: binary.reason ?? 'not-installed' },
                };
                lastProbe = result;
                return result;
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
            timer.unref();
            const combined = AbortSignal.any([signal, controller.signal]);
            try {
                await ensurePeer(combined);
                await request('thread/list', { limit: 1 }, combined, parseThreadListResponse);
                const result = {
                    ok: true,
                    at,
                    runtimeEpoch,
                    ...(lastVersion === undefined ? {} : { version: lastVersion }),
                    capability: buildAgentCapability(),
                };
                lastProbe = result;
                return result;
            }
            catch (error) {
                const reason = error instanceof AgentUnavailableError
                    ? error.unavailable.reason
                    : controller.signal.aborted ? 'probe-timeout'
                        : error instanceof CodexPeerError && error.code === 'timeout' ? 'probe-timeout'
                            : 'probe-failed';
                const result = {
                    ok: false,
                    at,
                    runtimeEpoch,
                    ...(lastVersion === undefined ? {} : { version: lastVersion }),
                    unavailable: { reason },
                };
                lastProbe = result;
                return result;
            }
            finally {
                clearTimeout(timer);
            }
        },
        async start(signal) {
            await ensurePeer(signal);
        },
        async stop() {
            stopping = true;
            closePeer();
            abortPendingApprovals();
            sessions.clear();
            coordinator.clear();
            // 停止后不再提供设置端口；onExit 的 reset 在 dispose 之后是幂等的。
            settings.dispose();
            await supervisor.stop();
            phase = 'stopped';
        },
        health() {
            const supervisorHealth = supervisor.health();
            const state = stopping || supervisorHealth.state === 'stopped'
                ? 'stopped'
                : supervisorHealth.state === 'failed' ? 'failed'
                    : phase === 'ready' && supervisorHealth.state === 'running' ? 'ready'
                        : 'unavailable';
            return {
                agent: 'codex',
                runtimeEpoch,
                state,
                updatedAt: now(),
                ...(supervisorHealth.reason === undefined ? {} : { unavailable: supervisorHealth.reason }),
                ...(lastProbe === undefined ? {} : { lastProbe }),
                restarts: supervisorHealth.restarts,
            };
        },
        list,
        async history(historyRequest, signal) {
            selectedStatistics = historyRequest.sessionId;
            const page = await listHistoryPage(request, {
                threadId: historyRequest.sessionId,
                ...(historyRequest.cursor === undefined ? {} : { cursor: historyRequest.cursor }),
                ...(historyRequest.limit === undefined ? {} : { limit: historyRequest.limit }),
            }, signal);
            if (!historyRequest.cursor)
                await refreshStatistics(historyRequest.sessionId, signal).catch(() => { });
            const meta = {
                deviceId: options.deviceId,
                agent: 'codex',
                nodeEpoch: options.nodeEpoch,
                sessionId: historyRequest.sessionId,
            };
            const items = [];
            if (page.turn) {
                items.push(...turnToEvents(page.turn, meta, () => nextSeq(historyRequest.sessionId), {
                    runtimeEpoch,
                    ownership: coordinator.ownership(historyRequest.sessionId),
                }, page));
            }
            return {
                items,
                completeness: page.nextCursor ? 'unconfirmed' : 'complete',
                ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            };
        },
        observe,
        follow(sessionId, signal) {
            return (async function* () {
                await ensurePeer(signal);
                // 先给订阅者一份当前能力（含 settingsRevision/runtimeEpoch/pending），
                // 再流式转发后续事件；observe 本身保持只读语义不变。
                yield frame(sessionId, 'capability.changed', capabilityPayload(buildSessionCapability(sessionId)));
                yield* sessions.observe(sessionId, signal);
            })();
        },
        frame,
        nextSeq,
        async syncSnapshot(signal) {
            return await syncSnapshot(signal);
        },
        async snapshot(signal) {
            const listed = await syncSnapshot(signal);
            const events = [];
            for (const row of listed.rows) {
                events.push(frame(row.sessionId, 'session.updated', {
                    running: row.running,
                    updatedAt: row.updatedAt,
                    blank: row.blank,
                    title: row.title,
                    ...(row.counts ? { counts: row.counts } : {}),
                    ownership: coordinator.ownership(row.sessionId),
                }));
                // 会话级能力必须带该会话自己的所有权，不能复用 agent 级文档。
                events.push(frame(row.sessionId, 'capability.changed', capabilityPayload(buildSessionCapability(row.sessionId))));
            }
            return events;
        },
        controls,
        async prompt(promptRequest, signal) {
            if (promptRequest.runtimeEpoch !== runtimeEpoch)
                throw new PreCallRejection('stale-connection');
            return await promptSession(promptRequest.sessionId, promptRequest.text, signal, promptRequest);
        },
        async steer(_steerRequest, _signal) {
            // 运行时 steer 的 expectedTurnId 语义尚未在目标机验证；保持关闭而不是悄悄入队。
            throw new PreCallRejection('unsupported', 'native-steer-unverified');
        },
        async interrupt(interruptRequest, signal) {
            return await interruptSession(interruptRequest.sessionId, interruptRequest.turnId, interruptRequest.runtimeEpoch, signal);
        },
        async createSession(createRequest, signal) {
            const cwd = createRequest.cwd;
            if (cwd !== undefined && !isAbsolute(cwd))
                throw new PreCallRejection('invalid-args');
            const peer = await ensurePeerForControl(signal);
            try {
                const response = await peer.request('thread/start', {
                    ...(cwd === undefined ? {} : { cwd }),
                }, signal, parseThreadRefResponse);
                const sessionId = response.thread.id;
                if (sessionId === '')
                    throw new Error('marshal: codex thread id missing');
                sessions.markManaged(sessionId);
                statistics.empty(sessionId);
                return { sessionId, runtimeEpoch };
            }
            catch (error) {
                if (error instanceof CodexPeerError && error.code === 'rpc')
                    throw rpcRejection(error);
                throw error;
            }
        },
        async forkSession(forkRequest, signal) {
            const parentSessionId = forkRequest.parentSessionId;
            if (parentSessionId === '')
                throw new PreCallRejection('session-unknown');
            const peer = await ensurePeerForControl(signal);
            // 父会话存在性是调用前校验；清单不完整时交给原生 fork 裁定。
            const discovery = await listAllThreads(request, signal);
            if (discovery.complete && !discovery.threads.some(thread => thread.id === parentSessionId)) {
                throw new PreCallRejection('session-unknown');
            }
            try {
                const response = await peer.request('thread/fork', {
                    threadId: parentSessionId,
                    excludeTurns: true,
                }, signal, parseThreadRefResponse);
                const sessionId = response.thread.id;
                if (sessionId === '' || sessionId === parentSessionId) {
                    // 新身份缺失/未变化：原生调用已经发生，不能伪装成 rejected。
                    throw new Error('marshal: codex fork identity missing');
                }
                sessions.markManaged(sessionId);
                return { sessionId, runtimeEpoch, parentSessionId };
            }
            catch (error) {
                if (error instanceof CodexPeerError && error.code === 'rpc')
                    throw rpcRejection(error);
                throw error;
            }
        },
        ownershipPort,
        settingsPort: settings,
        ...(options.inputRelay === undefined ? {} : { nativeInputPort: options.inputRelay }),
        async execute(command) {
            const sessionId = command.target.sessionId;
            const args = asRecord(command.args) ?? {};
            switch (command.op) {
                case 'observe':
                    // 历史由 AgentAdapter.history 提供；跟随由 node runner 的订阅表处理。
                    throw new PreCallRejection('unsupported', 'observe is served by runner subscriptions');
                case 'prompt': {
                    const text = typeof args.text === 'string' ? args.text : '';
                    if (text.trim() === '')
                        throw new PreCallRejection('invalid-args', 'text is required');
                    return await promptSession(sessionId, text, new AbortController().signal, args);
                }
                case 'interrupt': {
                    const requestedEpoch = typeof args.runtimeEpoch === 'string' ? args.runtimeEpoch : '';
                    const turnId = typeof args.turnId === 'string' ? args.turnId : undefined;
                    return await interruptSession(sessionId, turnId, requestedEpoch, new AbortController().signal);
                }
                case 'steer':
                    throw new PreCallRejection('unsupported', 'native-steer-unverified');
                case 'acquire': {
                    const snapshot = await ownershipPort.acquire(sessionId, new AbortController().signal);
                    // 写权状态已改变（ours）：立即广播新的会话能力，页面不必等下一次同步。
                    publishCapability(sessionId);
                    return { ownership: snapshot.wire, state: snapshot.state };
                }
                case 'answer': {
                    const relay = options.inputRelay;
                    if (relay === undefined) {
                        throw new PreCallRejection('unsupported', 'interaction-relay-unavailable');
                    }
                    const requestId = typeof args.requestId === 'string' ? args.requestId : '';
                    if (requestId === '')
                        throw new PreCallRejection('invalid-args', 'requestId is required');
                    const answers = args.answers;
                    if (!Array.isArray(answers))
                        throw new PreCallRejection('invalid-args', 'answers is required');
                    const result = relay.answer(sessionId, requestId, { answers });
                    if (result !== 'ok')
                        throw new PreCallRejection(result);
                    return { accepted: true };
                }
                case 'cancel': {
                    const relay = options.inputRelay;
                    if (relay === undefined) {
                        throw new PreCallRejection('unsupported', 'interaction-relay-unavailable');
                    }
                    const requestId = typeof args.requestId === 'string' ? args.requestId : '';
                    if (requestId === '')
                        throw new PreCallRejection('invalid-args', 'requestId is required');
                    const result = relay.cancel(sessionId, requestId);
                    if (result !== 'ok')
                        throw new PreCallRejection(result);
                    return { cancelled: true };
                }
                case 'configure':
                    // wire args 不能提供可信的 contentAuthorized；T09 由 node runner 直接调用 settingsPort。
                    throw new PreCallRejection('unsupported', 'settings-readback-unavailable');
                default:
                    throw new PreCallRejection('unsupported');
            }
        },
    };
    return adapter;
}
