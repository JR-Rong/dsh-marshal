import { join, dirname } from 'node:path'
import { openJournal } from '../node/journal.ts'
import { createDiscussions, type Discussions } from './discussions/coordinator.ts'
import { randomUUID } from 'node:crypto'
import type { MarshalConfig } from '../config.ts'
import type { LoggerLike, WebServerLike } from '../dsh-types.ts'
import { registerMarshalRoutes } from './api.ts'
import { ensureInstall } from './identity.ts'
import { DeviceRegistry } from './registry.ts'
import { HubRelay } from './relay.ts'
import { mountHubSocket, webServerPort } from './server.ts'
import { createHubSync } from './sync.ts'
import { createAccountLogin } from './account.ts'
import { createPhoneHub } from './phone.ts'
import { deliverPush, noticeForEvent } from './push-send.ts'
import { readFileSync } from 'node:fs'

/** Shared Hub composition for the desktop host and the standalone cloud service. */
export function mountHub(webServer: WebServerLike, config: MarshalConfig, logger: LoggerLike): () => void {
  if (config.role !== 'hub') throw new Error('marshal: Hub runtime requires role=hub')
  const disposers: (() => void)[] = []
  const dispose = (): void => { for (const stop of disposers.splice(0).reverse()) stop() }
  try {
    const registry = new DeviceRegistry()
    const install = ensureInstall(config.devicesFile)
    if (install.initialized) logger.warn('marshal: empty device table')
    const hubEpoch = randomUUID()
    const accountLogin = config.accountLogin ? createAccountLogin(config.dshAccountHash!) : undefined
    if (accountLogin) disposers.push(() => accountLogin.dispose())
    const relay = new HubRelay({
      registry, now: Date.now, operatorId: install.operatorId, hubEpoch,
      historyTtlMs: config.ringBufferMinutes * 60_000,
    })
    const sync = createHubSync({ relay, now: Date.now, logger })
    disposers.push(() => { sync.dispose(); relay.dispose() })
    relay.setSyncGate((deviceId, connectionId, nodeEpoch) =>
      sync.isSynced({ deviceId, connectionId, nodeEpoch }))
    const discussionDir = join(dirname(config.devicesFile), 'discussions')
    let discussions: Discussions | undefined
    try {
      const discussionJournal = openJournal({ file: join(discussionDir, 'journal.json'),
        keyFile: join(discussionDir, 'journal.key'), initFile: join(discussionDir, 'journal.init') })
      disposers.push(() => discussionJournal.close())
      discussions = createDiscussions({ registry, relay, sync, store: install.store, journal: discussionJournal,
        file: join(discussionDir, 'rooms.json'), operatorId: install.operatorId })
      disposers.push(() => discussions?.dispose())
    } catch {
      logger.warn('marshal: group discussion storage requires recovery; group calls disabled')
    }
    const phone = createPhoneHub({
      now: Date.now,
      store: install.store,
      findNode: (tokenDigest) => {
        const row = install.store.findByTokenDigest(tokenDigest)
        return row !== undefined && row.role !== 'phone' ? row : undefined
      },
    })
    const pushConfig = readPushConfig(config.devicesFile)
    const stopPush = relay.subscribe((event) => {
      const payload = typeof event.payload === 'object' && event.payload !== null
        ? event.payload as Record<string, unknown>
        : {}
      const notice = noticeForEvent(event.kind, {
        ...payload,
        deviceId: event.deviceId,
        agent: event.agent,
        sessionId: event.sessionId,
      }, phone.watchedKeys())
      if (notice === null) return
      for (const target of install.store.phones()) {
        if (target.pushProvider === undefined || target.pushToken === undefined) continue
        void deliverPush({
          config: pushConfig,
          deviceId: target.id,
          target: {
            provider: target.pushProvider,
            token: target.pushToken,
            ...(target.liveToken === undefined ? {} : { liveToken: target.liveToken }),
          },
          notice,
        }).then((result) => {
          if (!result.delivered) logger.warn(`marshal: push ${result.reason}`)
        })
      }
    })
    disposers.push(stopPush)
    const socket = mountHubSocket({
      port: webServerPort(webServer), registry, store: install.store,
      operatorId: install.operatorId, hubEpoch, now: Date.now, logger, sync,
      onDetach: deviceId => { relay.deviceOffline(deviceId); discussions?.invalidate(deviceId) },
      onContentRevoked: deviceId => { relay.purgeHistory(deviceId) },
      onFrame: (identity, frame) => {
        if (frame.type === 'discussion.catalog') discussions?.acceptCatalog(identity, frame)
        else if (frame.type === 'discussion.result') discussions?.acceptResult(identity, frame)
        else if (frame.type === 'discussion.progress') discussions?.acceptProgress(identity, frame)
        else if (frame.type === 'event') relay.publish(frame)
        else if (frame.type === 'ack') relay.settle(frame, identity)
        else if (frame.type === 'history.result') relay.settleHistory(frame, identity)
        else if (frame.type === 'command.status.result') relay.settleStatus(frame, identity)
        else if (frame.type === 'inputs.snapshot.result') relay.settleInputs(frame, identity)
      },
    })
    disposers.push(() => socket.dispose())
    for (const desktopEmbed of [false, true]) {
      disposers.push(registerMarshalRoutes({
        webServer, registry, relay, sync, deviceStore: install.store, phone, ...(discussions === undefined ? {} : { discussions }), desktopEmbed, requireToken: config.dashboardToken!,
        publicOrigin: config.publicOrigin!, operatorId: install.operatorId,
        ...(accountLogin === undefined ? {} : { accountLogin }),
      }).dispose)
    }
    logger.info(`marshal: hub ready at ${webServer.getOrigin()}/marshal`)
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}

function readPushConfig(devicesFile: string): ReturnType<typeof loadPush> {
  return loadPush(devicesFile)
}

function loadPush(devicesFile: string) {
  try {
    const text = readFileSync(join(dirname(devicesFile), 'push.json'), 'utf8')
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as import('./push-send.ts').PushConfig : undefined
  } catch {
    return undefined
  }
}
