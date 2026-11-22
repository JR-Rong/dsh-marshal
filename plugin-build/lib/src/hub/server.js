import { DISCUSSION_FEATURE } from "../discussions/types.js";
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { CLOSE_CODES, CONTRACT_REVISION, FrameError, decodeFrame, directionOf, encodeFrame, } from "../wire/frames.js";
import { MAX_FRAME_BYTES } from "../wire/limits.js";
import { DeviceStateError, sha256Hex, } from "./devices.js";
export const UPLINK_PATH = '/marshal/uplink';
/** 握手成功后多久之内必须收到合法 hello，否则断开（可被 options.helloTimeoutMs 覆盖）。 */
const HELLO_TIMEOUT_MS = 10_000;
/** 契约 §11：双方应用心跳 5s 一次，15s 无有效应答即判定半开连接。 */
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const LIVENESS_CHECK_MS = 1_000;
/** 同时等待 hello 的未认证 socket 上限，防止匿名连接堆积。 */
const MAX_PENDING_HELLOS = 32;
/** 单连接最多保留多少个未应答心跳 nonce。 */
const MAX_PENDING_HEARTBEATS = 8;
/** ws ping 只作为传输层存活检查，应用心跳才是授权/半开判定依据。 */
const WS_PING_MS = 30_000;
/** 原子 rename 会替换 inode，必须 watch 目录而不是文件本身。 */
const WATCH_POLL_MS = 2_000;
export const nodeServerPort = (server) => ({
    open(handler) {
        server.on('upgrade', handler);
        return () => { server.off('upgrade', handler); };
    },
});
/** 走 DSH 的 registerUpgrade：DSH 会销毁没匹配到路由的 upgrade 连接，因此这里只登记一条路径。 */
export const webServerPort = (webServer) => ({
    open(handler) { return webServer.registerUpgrade({ path: UPLINK_PATH, handler }); },
});
function bearerToken(req) {
    const header = req.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}
/** 只取 pathname；畸形 URL 视作不匹配。 */
function pathnameOf(req) {
    try {
        return new URL(req.url ?? '', 'http://marshal.invalid').pathname;
    }
    catch {
        return undefined;
    }
}
function endHttp(socket, status) {
    if (socket.writable) {
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
    else {
        socket.destroy();
    }
}
/** 非 uplink 路径直接回 404 并断开，不进入握手，也不看 token。 */
function rejectUpgrade(socket) {
    endHttp(socket, '404 Not Found');
}
/** 一次性检查重复摘要；持久表加载时已校验，这里是 mount 边界的最后防线。 */
function assertUniqueDigests(records) {
    const owners = new Map();
    for (const record of records) {
        const first = owners.get(record.tokenDigest);
        if (first !== undefined) {
            // 只报 device id，不碰摘要本身。
            throw new Error(`marshal: devices "${first}" and "${record.id}" share the same token digest`);
        }
        owners.set(record.tokenDigest, record.id);
    }
}
function recordMap(records) {
    return new Map(records.map(record => [record.id, record]));
}
export function mountHubSocket(options) {
    const { registry, store, now } = options;
    const hubEpoch = options.hubEpoch ?? randomUUID();
    const operatorId = options.operatorId;
    assertUniqueDigests(store.list());
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    const ponged = new WeakMap();
    const connections = new WeakMap();
    const socketOf = new Map();
    const liveness = new WeakMap();
    /**
     * 当前实际持有内容授权的设备：节点自报 privacy === 'content' 且 hub 记录
     * allowContent === true 才算生效（hub 策略始终优先）。跨重连保留，用于识别
     * “从有内容权限变为没有”的收紧瞬间。
     */
    const contentDevices = new Set();
    /**
     * 最近一次 hello 自报 content 的设备。只在 hello 路径更新：收紧后重新握手
     * 即使已删过 contentDevices，也要再清一次，接住在途事件。
     */
    const reportedContent = new Set();
    /** 升级成功但还没完成 hello 的 socket 数量；超过上限直接 4408。 */
    let pendingHellos = 0;
    /** 节点自报更高 revision 时只隔离该设备，不抬高全局修订。 */
    const recoveryFloor = new Map();
    const helloTimers = new Set();
    let records = recordMap(store.list());
    /** 非法 reload 后停止接受新连接，直到文件恢复为可解析的完整表。 */
    let stateUnconfirmed = false;
    let disposed = false;
    let watcher;
    let pollTimer;
    let reloadTimer;
    const sendFrame = (ws, frame) => {
        if (ws.readyState !== WebSocket.OPEN)
            return;
        ws.send(encodeFrame(frame));
    };
    const isCurrent = (connection) => {
        const slot = registry.get(connection.deviceId);
        return slot !== undefined
            && slot.sender === connection.sender
            && slot.connectionId === connection.connectionId;
    };
    const identityOf = (connection) => ({
        deviceId: connection.deviceId,
        connectionId: connection.connectionId,
        nodeEpoch: connection.nodeEpoch,
    });
    const stopHubHeartbeat = (ws) => {
        const state = liveness.get(ws);
        if (state?.timer !== undefined)
            clearInterval(state.timer);
        liveness.delete(ws);
    };
    /** hub 主动发 heartbeat；刷新只认带当前 connectionId/nodeEpoch 且 nonce 匹配的应答。 */
    const startHubHeartbeat = (ws, connection) => {
        const state = { lastAck: now(), nonces: new Set() };
        liveness.set(ws, state);
        const timer = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN || !isCurrent(connection))
                return;
            const nonce = randomUUID();
            state.nonces.add(nonce);
            while (state.nonces.size > MAX_PENDING_HEARTBEATS) {
                const first = state.nonces.values().next().value;
                if (first === undefined)
                    break;
                state.nonces.delete(first);
            }
            sendFrame(ws, {
                v: 2, type: 'heartbeat', nonce,
                connectionId: connection.connectionId,
                nodeEpoch: connection.nodeEpoch,
                sentAt: now(),
            });
        }, options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
        timer.unref();
        state.timer = timer;
    };
    const acceptHeartbeatAck = (ws, connection, nonce, connectionId, nodeEpoch) => {
        const state = liveness.get(ws);
        if (state === undefined)
            return;
        if (connectionId !== connection.connectionId || nodeEpoch !== connection.nodeEpoch)
            return;
        if (!state.nonces.delete(nonce))
            return;
        state.lastAck = now();
    };
    const closeDevice = (deviceId, code, reason) => {
        const ws = socketOf.get(deviceId);
        if (ws !== undefined && ws.readyState === WebSocket.OPEN)
            ws.close(code, reason);
    };
    const failReload = (error) => {
        stateUnconfirmed = true;
        const code = error instanceof DeviceStateError ? error.code : 'invalid';
        options.logger?.error(`marshal: device-state-${code}: reload rejected; closing device connections`);
        // 4409 可重试：操作者修好文件后节点会重新握手，而不是把节点钉死在 4401。
        for (const deviceId of [...socketOf.keys()])
            closeDevice(deviceId, CLOSE_CODES.STALE_CONNECTION, 'invalid-reload');
    };
    const reload = () => {
        if (disposed)
            return;
        try {
            store.reload();
        }
        catch (error) {
            failReload(error);
            return;
        }
        const next = recordMap(store.list());
        for (const [deviceId, previous] of records) {
            const current = next.get(deviceId);
            if (current === undefined || current.revoked) {
                closeDevice(deviceId, CLOSE_CODES.AUTH_FAILED, 'device-revoked');
            }
            else if (store.isRecoveryRequired(deviceId)) {
                // 修订不可确认：可重试关闭，修好后重新握手，不把修订重置为零。
                closeDevice(deviceId, CLOSE_CODES.STALE_CONNECTION, 'recovery-required');
            }
            else if (current.policyRevision !== previous.policyRevision) {
                // 授权变化必须让节点重新握手拿到新 ack；4409 可重试且不更换 nodeEpoch。
                closeDevice(deviceId, CLOSE_CODES.STALE_CONNECTION, 'policy-changed');
            }
            // 只有 allowContent 真正由真变假（或设备消失/撤销）才算内容收紧；
            // 修订不可确认不是收紧证据：设备按 recovery-required 关闭，修好后重新握手。
            // contentDevices 记录的是实际生效过的授权，重复 reload 不再重复清历史。
            if (!store.isRecoveryRequired(deviceId)
                && previous.allowContent
                && (current === undefined || current.revoked || !current.allowContent)
                && contentDevices.delete(deviceId)) {
                options.onContentRevoked?.(deviceId);
            }
        }
        records = next;
        stateUnconfirmed = false;
        for (const [deviceId, floor] of [...recoveryFloor]) {
            const current = next.get(deviceId);
            if (current !== undefined && current.policyRevision >= floor)
                recoveryFloor.delete(deviceId);
        }
    };
    const scheduleReload = () => {
        if (disposed)
            return;
        if (reloadTimer !== undefined)
            clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
            reloadTimer = undefined;
            reload();
        }, 50);
        // 热加载不应阻止进程退出。
        reloadTimer.unref();
    };
    const onUpgrade = (req, socket, head) => {
        if (disposed) {
            socket.destroy();
            return;
        }
        if (pathnameOf(req) !== UPLINK_PATH) {
            rejectUpgrade(socket);
            return;
        }
        if (stateUnconfirmed) {
            endHttp(socket, '503 Service Unavailable');
            return;
        }
        // token 只在 Authorization 头里；按摘要查找，绝不记录原值。
        const record = store.findByTokenDigest(sha256Hex(bearerToken(req)));
        if (record === undefined || record.revoked || record.role === 'phone') {
            endHttp(socket, '401 Unauthorized');
            return;
        }
        const maxPendingHellos = options.maxPendingHellos ?? MAX_PENDING_HELLOS;
        if (pendingHellos >= maxPendingHellos) {
            // 未认证 socket 不能无限堆积：完成升级后立即用 4408 关闭并强拆。
            wss.handleUpgrade(req, socket, head, ws => {
                ws.on('error', () => ws.terminate());
                ws.close(CLOSE_CODES.HANDSHAKE_TIMEOUT, 'handshake-timeout');
                const force = setTimeout(() => ws.terminate(), 1_000);
                force.unref();
                helloTimers.add(force);
            });
            return;
        }
        pendingHellos += 1;
        wss.handleUpgrade(req, socket, head, ws => {
            // 没有 error 监听器时，底层 socket 错误会变成 uncaught。
            ws.on('error', () => ws.terminate());
            ponged.set(ws, true);
            ws.on('pong', () => ponged.set(ws, true));
            let helloDone = false;
            const completeHello = () => {
                if (helloDone)
                    return;
                helloDone = true;
                pendingHellos = Math.max(0, pendingHellos - 1);
            };
            const connectionId = randomUUID();
            const helloTimer = setTimeout(() => {
                completeHello();
                // 先发 4408 关闭帧；对端不回应关闭握手时再强拆，避免半开连接常驻。
                ws.close(CLOSE_CODES.HANDSHAKE_TIMEOUT, 'handshake-timeout');
                const force = setTimeout(() => ws.terminate(), 1_000);
                force.unref();
                helloTimers.add(force);
            }, options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
            helloTimers.add(helloTimer);
            const clearHelloTimer = () => {
                clearTimeout(helloTimer);
                helloTimers.delete(helloTimer);
            };
            const sender = {
                send: text => { if (ws.readyState === WebSocket.OPEN)
                    ws.send(text); },
            };
            const syncHost = {
                send: frame => sendFrame(ws, frame),
                close: (code, reason) => ws.close(code, reason),
            };
            ws.on('close', () => {
                completeHello();
                clearHelloTimer();
                stopHubHeartbeat(ws);
                const connection = connections.get(ws);
                if (connection === undefined)
                    return;
                // 同一设备重连后，旧连接迟到的 close 不能摘掉新连接的槽位。
                if (registry.detachIf(connection.deviceId, sender)) {
                    if (socketOf.get(connection.deviceId) === ws)
                        socketOf.delete(connection.deviceId);
                    options.onDetach?.(connection.deviceId);
                }
                // 协调器自己按连接身份忽略旧连接的迟到 close。
                options.sync?.detach(identityOf(connection));
            });
            ws.on('message', data => {
                let frame;
                try {
                    frame = decodeFrame(String(data));
                }
                catch (error) {
                    const code = error instanceof FrameError && error.code === 'version-unsupported'
                        ? CLOSE_CODES.VERSION_UNSUPPORTED
                        : CLOSE_CODES.FRAME_INVALID;
                    ws.close(code, error instanceof FrameError ? error.code : 'frame-invalid');
                    return;
                }
                const current = connections.get(ws);
                if (current === undefined) {
                    // 未发 hello 的 socket 不进注册表；首帧必须既是 hello，又与握手时那个设备一致。
                    if (frame.type !== 'hello') {
                        ws.close(CLOSE_CODES.FRAME_INVALID, 'frame-invalid');
                        return;
                    }
                    if (frame.deviceId !== record.id) {
                        ws.close(CLOSE_CODES.DEVICE_MISMATCH, 'device-mismatch');
                        return;
                    }
                    if (frame.contractRevision !== CONTRACT_REVISION) {
                        ws.close(CLOSE_CODES.VERSION_UNSUPPORTED, 'version-unsupported');
                        return;
                    }
                    // 热加载可能已在 upgrade 与 hello 之间撤销该设备。
                    const latest = store.findById(record.id);
                    if (latest === undefined || latest.revoked) {
                        ws.close(CLOSE_CODES.AUTH_FAILED, 'device-revoked');
                        return;
                    }
                    if (store.isRecoveryRequired(latest.id)) {
                        // 修订不可确认：拒绝授权但保持可重试，修复文件后重新握手。
                        ws.close(CLOSE_CODES.STALE_CONNECTION, 'recovery-required');
                        return;
                    }
                    const floor = recoveryFloor.get(latest.id);
                    if (floor !== undefined && latest.policyRevision < floor) {
                        // 隔离该设备：连现有连接一起关闭，避免旧连接继续写入。
                        const existing = socketOf.get(latest.id);
                        if (existing !== undefined && existing !== ws) {
                            existing.close(CLOSE_CODES.STALE_CONNECTION, 'recovery-required');
                        }
                        ws.close(CLOSE_CODES.STALE_CONNECTION, 'recovery-required');
                        return;
                    }
                    if (floor !== undefined)
                        recoveryFloor.delete(latest.id);
                    if (frame.operatorId !== undefined
                        && frame.operatorId === operatorId
                        && frame.policyRevision !== undefined
                        && frame.policyRevision > latest.policyRevision) {
                        // 节点自报更高修订只隔离该设备，不降低也不抬高 hub 的持久值。
                        recoveryFloor.set(latest.id, frame.policyRevision);
                        options.logger?.error(`marshal: recovery-required: device ${latest.id} reported policyRevision ${frame.policyRevision} above hub ${latest.policyRevision}`);
                        const existing = socketOf.get(latest.id);
                        if (existing !== undefined && existing !== ws) {
                            existing.close(CLOSE_CODES.STALE_CONNECTION, 'recovery-required');
                        }
                        ws.close(CLOSE_CODES.STALE_CONNECTION, 'recovery-required');
                        return;
                    }
                    const previous = socketOf.get(latest.id);
                    if (previous !== undefined && previous !== ws) {
                        // 旧连接先收到 4409；它的迟到 close 由 detachIf 保护，不会摘掉新槽位。
                        previous.close(CLOSE_CODES.STALE_CONNECTION, 'stale-connection');
                    }
                    const connection = {
                        deviceId: latest.id,
                        deviceName: latest.name,
                        connectionId,
                        nodeEpoch: frame.nodeEpoch,
                        agents: new Set(frame.agents),
                        features: new Set(frame.features),
                        sender,
                        ws,
                    };
                    clearHelloTimer();
                    completeHello();
                    connections.set(ws, connection);
                    socketOf.set(latest.id, ws);
                    startHubHeartbeat(ws, connection);
                    registry.attach({ id: latest.id, name: latest.name, agents: frame.agents }, sender, now(), { connectionId, nodeEpoch: frame.nodeEpoch });
                    // 节点重连后会重新同步：协调器保留旧索引并标 stale，或按新 epoch 丢弃旧能力。
                    options.sync?.attach(identityOf(connection), frame.agents);
                    options.onAttach?.(latest.id);
                    // 内容授权 = 节点自报 privacy + hub 持久 allowContent；收紧时清掉历史正文。
                    const effectiveContent = frame.privacy === 'content' && latest.allowContent === true;
                    if (effectiveContent) {
                        contentDevices.add(latest.id);
                        reportedContent.add(latest.id);
                    }
                    else {
                        contentDevices.delete(latest.id);
                        // reload 触发的清理可能在握手前已经执行；重连时再清一次，拦住仍在途的帧。
                        // reportedContent 只在 hello 更新，因此同一次授权状态不会重复回调。
                        if (reportedContent.delete(latest.id))
                            options.onContentRevoked?.(latest.id);
                    }
                    const ack = {
                        v: 2, type: 'hello.ack', connectionId, hubEpoch,
                        contractRevision: CONTRACT_REVISION,
                        features: [...frame.features],
                        nodeEpoch: frame.nodeEpoch,
                        operatorId, policyRevision: latest.policyRevision,
                        deviceId: latest.id,
                        policies: {
                            // 内容策略始终以 hub 记录为准；privacy 先反映节点自报快照。
                            privacy: frame.privacy ?? 'metadata',
                            questionRelay: 'off',
                            approvalRelay: 'off',
                            allowContent: latest.allowContent,
                            allowInteractions: latest.allowInteractions,
                            allowDiscussion: latest.allowDiscussion,
                        },
                        serverTime: now(),
                    };
                    sendFrame(ws, ack);
                    return;
                }
                // 同设备新连接已接管槽位：旧连接上的帧一律视为过期，不能修改索引或完成新命令。
                if (!isCurrent(current)) {
                    ws.close(CLOSE_CODES.STALE_CONNECTION, 'stale-connection');
                    return;
                }
                // 每条已认证连接只接受 node→hub 或双向帧；hub→node 帧从设备发来即协议错误。
                const direction = directionOf(frame);
                if (direction !== 'node-to-hub' && direction !== 'both') {
                    ws.close(CLOSE_CODES.FRAME_INVALID, 'frame-invalid');
                    return;
                }
                if (frame.type === 'hello') {
                    ws.close(CLOSE_CODES.FRAME_INVALID, 'frame-invalid');
                    return;
                }
                const frameConnectionId = 'connectionId' in frame ? frame.connectionId : undefined;
                const frameNodeEpoch = 'nodeEpoch' in frame ? frame.nodeEpoch : undefined;
                // 心跳应答不参与业务分派；只有匹配当前连接和未应答 nonce 才刷新存活。
                if (frame.type === 'heartbeat.ack') {
                    if (frameConnectionId !== undefined && frameNodeEpoch !== undefined) {
                        acceptHeartbeatAck(ws, current, frame.nonce, frameConnectionId, frameNodeEpoch);
                    }
                    return;
                }
                const connectionMismatch = frameConnectionId !== undefined && frameConnectionId !== current.connectionId;
                const epochMismatch = frameNodeEpoch !== undefined && frameNodeEpoch !== current.nodeEpoch;
                if (connectionMismatch || epochMismatch) {
                    // 错代次 ACK 交给 relay 拒绝并计数，绝不结算；迟到的节点心跳直接忽略。
                    if (frame.type === 'ack') {
                        options.onFrame?.(identityOf(current), frame);
                        return;
                    }
                    if (frame.type === 'heartbeat')
                        return;
                    ws.close(CLOSE_CODES.STALE_CONNECTION, 'stale-connection');
                    return;
                }
                registry.touch(current.deviceId, now());
                if (frame.type === 'heartbeat') {
                    // 节点发来的 heartbeat 立即回执；hub 自己的存活只由 heartbeat.ack 刷新。
                    sendFrame(ws, {
                        v: 2, type: 'heartbeat.ack',
                        nonce: frame.nonce,
                        connectionId: current.connectionId,
                        nodeEpoch: current.nodeEpoch,
                        sentAt: frame.sentAt,
                    });
                    return;
                }
                if (frame.type === 'discussion.catalog' || frame.type === 'discussion.result' || frame.type === 'discussion.progress') {
                    if (!current.features.has(DISCUSSION_FEATURE)) {
                        ws.close(CLOSE_CODES.FRAME_INVALID, 'frame-invalid');
                        return;
                    }
                }
                if (frame.type === 'history.result') {
                    if (frame.target.deviceId !== current.deviceId || !current.agents.has(frame.target.agent)) {
                        ws.close(CLOSE_CODES.DEVICE_MISMATCH, 'device-mismatch');
                        return;
                    }
                    if (!contentDevices.has(current.deviceId)) {
                        options.onFrame?.(identityOf(current), { v: 2, type: 'ack', commandId: frame.commandId,
                            connectionId: current.connectionId, nodeEpoch: current.nodeEpoch, status: 'rejected', code: 'unsupported' });
                        return;
                    }
                }
                if (frame.type === 'event') {
                    // 只信握手绑定的身份：帧里自报的 deviceId/agent 不能冒充别的设备或未声明的 agent。
                    if (frame.deviceId !== current.deviceId) {
                        ws.close(CLOSE_CODES.DEVICE_MISMATCH, 'device-mismatch');
                        return;
                    }
                    if (!current.agents.has(frame.agent)) {
                        ws.close(CLOSE_CODES.FRAME_INVALID, 'frame-invalid');
                        return;
                    }
                    if (options.sync !== undefined) {
                        const verdict = options.sync.acceptEvent(identityOf(current), frame);
                        // 缺口不能跳过：要求节点重连并重新走完整同步屏障。
                        if (verdict === 'gap') {
                            ws.close(CLOSE_CODES.STALE_CONNECTION, 'sync-gap');
                            return;
                        }
                        if (verdict !== 'accept')
                            return;
                    }
                }
                if (frame.type === 'sync.begin' || frame.type === 'sync.chunk' || frame.type === 'sync.end') {
                    if (options.sync !== undefined) {
                        options.sync.onFrame(identityOf(current), frame, syncHost);
                        return;
                    }
                }
                options.onFrame?.(identityOf(current), frame);
            });
        });
    };
    const closePort = options.port.open(onUpgrade);
    const pingTimer = setInterval(() => {
        for (const ws of wss.clients) {
            if (ws.readyState !== WebSocket.OPEN)
                continue;
            if (ponged.get(ws) === false) {
                ws.terminate();
                continue;
            }
            ponged.set(ws, false);
            ws.ping();
        }
    }, WS_PING_MS);
    pingTimer.unref();
    const livenessTimer = setInterval(() => {
        const at = now();
        const timeout = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
        for (const ws of wss.clients) {
            if (ws.readyState !== WebSocket.OPEN)
                continue;
            const state = liveness.get(ws);
            if (state !== undefined && at - state.lastAck > timeout)
                ws.terminate();
        }
    }, options.livenessCheckMs ?? LIVENESS_CHECK_MS);
    livenessTimer.unref();
    if (options.watchDevices ?? true) {
        try {
            watcher = watch(dirname(store.file), { persistent: false }, (_event, filename) => {
                const changed = filename === null ? undefined : filename.toString();
                if (changed === undefined || changed === basename(store.file))
                    scheduleReload();
            });
            watcher.on('error', () => { });
        }
        catch {
            // 目录不可 watch 时依赖轮询；不影响启动。
        }
        pollTimer = setInterval(reload, options.pollMs ?? WATCH_POLL_MS);
        pollTimer.unref();
    }
    return {
        dispose() {
            if (disposed)
                return;
            disposed = true;
            if (watcher !== undefined)
                watcher.close();
            if (pollTimer !== undefined)
                clearInterval(pollTimer);
            if (reloadTimer !== undefined)
                clearTimeout(reloadTimer);
            clearInterval(livenessTimer);
            clearInterval(pingTimer);
            for (const helloTimer of helloTimers)
                clearTimeout(helloTimer);
            helloTimers.clear();
            contentDevices.clear();
            reportedContent.clear();
            closePort();
            for (const ws of wss.clients) {
                stopHubHeartbeat(ws);
                ws.terminate();
            }
            wss.close();
        },
        closeDevice,
        reload,
    };
}
