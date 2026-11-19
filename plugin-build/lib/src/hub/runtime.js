import { join, dirname } from 'node:path';
import { openJournal } from "../node/journal.js";
import { createDiscussions } from "./discussions/coordinator.js";
import { createCrossGroups } from "./cross-groups.js";
import { randomUUID } from 'node:crypto';
import { registerMarshalRoutes } from "./api.js";
import { ensureInstall } from "./identity.js";
import { DeviceRegistry } from "./registry.js";
import { HubRelay } from "./relay.js";
import { mountHubSocket, webServerPort } from "./server.js";
import { createHubSync } from "./sync.js";
import { createAccountLogin } from "./account.js";
import { createHubMemorySync } from "./memory-sync.js";
import { createPhoneHub } from "./phone.js";
import { deliverPush, noticeForEvent } from "./push-send.js";
import { readFileSync } from 'node:fs';
/** Shared Hub composition for the desktop host and the standalone cloud service. */
export function mountHub(webServer, config, logger) {
    if (config.role !== 'hub')
        throw new Error('marshal: Hub runtime requires role=hub');
    const disposers = [];
    const dispose = () => { for (const stop of disposers.splice(0).reverse())
        stop(); };
    try {
        const registry = new DeviceRegistry();
        const inventories = new Map();
        const install = ensureInstall(config.devicesFile);
        const memorySync = createHubMemorySync({ file: join(dirname(config.devicesFile), 'memory-sync.json') });
        if (install.initialized)
            logger.warn('marshal: empty device table');
        const hubEpoch = randomUUID();
        const accountLogin = config.accountLogin ? createAccountLogin(config.dshAccountHash) : undefined;
        if (accountLogin)
            disposers.push(() => accountLogin.dispose());
        const relay = new HubRelay({
            registry, now: Date.now, operatorId: install.operatorId, hubEpoch,
            historyTtlMs: config.ringBufferMinutes * 60_000,
        });
        const sync = createHubSync({ relay, now: Date.now, logger });
        disposers.push(() => { sync.dispose(); relay.dispose(); });
        relay.setSyncGate((deviceId, connectionId, nodeEpoch) => sync.isSynced({ deviceId, connectionId, nodeEpoch }));
        const discussionDir = join(dirname(config.devicesFile), 'discussions');
        let discussions;
        try {
            const discussionJournal = openJournal({ file: join(discussionDir, 'journal.json'),
                keyFile: join(discussionDir, 'journal.key'), initFile: join(discussionDir, 'journal.init') });
            disposers.push(() => discussionJournal.close());
            discussions = createDiscussions({ registry, relay, sync, store: install.store, journal: discussionJournal,
                file: join(discussionDir, 'rooms.json'), operatorId: install.operatorId });
            disposers.push(() => discussions?.dispose());
        }
        catch {
            logger.warn('marshal: group discussion storage requires recovery; group calls disabled');
        }
        const phone = createPhoneHub({
            now: Date.now,
            ...(config.dshAccountHash === undefined ? {} : { ownerHash: config.dshAccountHash }),
            store: install.store,
            findNode: (tokenDigest) => {
                const row = install.store.findByTokenDigest(tokenDigest);
                return row !== undefined && row.role !== 'phone' ? row : undefined;
            },
        });
        const pushConfig = readPushConfig(config.devicesFile);
        const stopPush = relay.subscribe((event) => {
            const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload : {};
            for (const target of install.store.phones()) {
                if (target.pushProvider === undefined || target.pushToken === undefined) continue;
                const notice = noticeForEvent(event.kind, {
                    ...payload,
                    deviceId: event.deviceId,
                    agent: event.agent,
                    sessionId: event.sessionId,
                }, phone.watchedBy(target.id));
                if (notice === null) continue;
                void deliverPush({
                    config: pushConfig,
                    deviceId: target.id,
                    target: {
                        provider: target.pushProvider,
                        token: target.pushToken,
                        ...(target.liveToken === undefined ? {} : { liveToken: target.liveToken }),
                        ...(target.liveTokens === undefined ? {} : { liveTokens: target.liveTokens }),
                    },
                    notice,
                }).then((result) => {
                    if (!result.delivered) logger.warn(`marshal: push ${result.reason}`);
                });
            }
        });
        disposers.push(stopPush);
        const crossGroups = createCrossGroups({ relay: relay, now: Date.now, file: join(dirname(config.devicesFile), 'cross-groups.json') });
        disposers.push(() => crossGroups.dispose());
        const socket = mountHubSocket({
            port: webServerPort(webServer), registry, store: install.store,
            operatorId: install.operatorId, hubEpoch, now: Date.now, logger, sync,
            onDetach: deviceId => { relay.deviceOffline(deviceId); discussions?.invalidate(deviceId); },
            onContentRevoked: deviceId => { relay.purgeHistory(deviceId); },
            onFrame: (identity, frame) => {
                if (frame.type === 'discussion.catalog')
                    discussions?.acceptCatalog(identity, frame);
                else if (frame.type === 'discussion.result')
                    discussions?.acceptResult(identity, frame);
                else if (frame.type === 'discussion.progress')
                    discussions?.acceptProgress(identity, frame);
                else if (frame.type === 'device.inventory')
                    inventories.set(identity.deviceId, {
                        deviceName: frame.deviceName,
                        squads: frame.squads,
                        codex: frame.codex,
                        receivedAt: Date.now(),
                    });
                else if (frame.type === 'event')
                    relay.publish(frame);
                else if (frame.type === 'ack')
                    relay.settle(frame, identity);
                else if (frame.type === 'history.result')
                    relay.settleHistory(frame, identity);
                else if (frame.type === 'command.status.result')
                    relay.settleStatus(frame, identity);
                else if (frame.type === 'inputs.snapshot.result')
                    relay.settleInputs(frame, identity);
            },
        });
        disposers.push(() => socket.dispose());
        for (const desktopEmbed of [false, true]) {
            disposers.push(registerMarshalRoutes({
                webServer, registry, relay, sync, deviceStore: install.store, phone, inventories, ...(discussions === undefined ? {} : { discussions }), crossGroups, memorySync, desktopEmbed, requireToken: config.dashboardToken,
                publicOrigin: config.publicOrigin, operatorId: install.operatorId,
                ...(accountLogin === undefined ? {} : { accountLogin }),
            }).dispose);
        }
        logger.info(`marshal: hub ready at ${webServer.getOrigin()}/marshal`);
        return dispose;
    }
    catch (error) {
        dispose();
        throw error;
    }
}
function readPushConfig(devicesFile) {
    try {
        const text = readFileSync(join(dirname(devicesFile), 'push.json'), 'utf8');
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
