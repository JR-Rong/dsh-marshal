import { randomUUID } from 'node:crypto'
import { parseConfig, type MarshalConfig } from './config.ts'
import type { EventFrame, Frame } from './wire/frames.ts'
import { decodeFrame } from './wire/frames.ts'
import type { MarshalContext } from './dsh-types.ts'
import { mountHubSocket, webServerPort } from './hub/server.ts'
import { registerMarshalRoutes } from './hub/api.ts'
import { DeviceRegistry } from './hub/registry.ts'
import { HubRelay } from './hub/relay.ts'
import { ensureInstall } from './hub/identity.ts'
import { createDshSurface } from './adapters/dsh/surface.ts'
import { createDshAdapter } from './adapters/dsh/adapter.ts'
import { NodeLink } from './node/link.ts'
import { createFollower, runCommand } from './node/runner.ts'
import { createQuestionRelay, type QuestionRelay } from './node/questions.ts'
import { redact, stripContent } from './node/redact.ts'

export const name = 'marshal'

export function apply(ctx: MarshalContext, raw: unknown): void {
  const config = parseConfig(raw, process.env.HOSTNAME ?? 'unknown')
  if (config.role === 'hub') { applyHub(ctx, config); return }
  applyNode(ctx, config)
}

function applyHub(ctx: MarshalContext, config: MarshalConfig): void {
  const webServer = ctx.webServer
  if (webServer === undefined) throw new Error('marshal: hub role requires the webServer service')
  const registry = new DeviceRegistry()
  const install = ensureInstall(config.devicesFile)
  if (install.initialized) ctx.logger.warn('marshal: empty device table')
  const relay = new HubRelay({ registry, now: Date.now, operatorId: install.operatorId })
  const hubEpoch = randomUUID()
  const socket = mountHubSocket({
    port: webServerPort(webServer),
    registry,
    store: install.store,
    operatorId: install.operatorId,
    hubEpoch,
    now: Date.now,
    logger: ctx.logger,
    // 设备重连时节点会重发快照：先清索引，再让快照重建。
    onAttach: deviceId => relay.clearDevice(deviceId),
    onDetach: deviceId => relay.deviceOffline(deviceId),
    onFrame: (identity, frame) => {
      // 事件进索引并扇出；ACK 必须同时匹配 commandId 与连接身份才结算。
      if (frame.type === 'event') relay.publish(frame)
      else if (frame.type === 'ack') relay.settle(frame, identity)
    },
  })
  ctx.effect(() => { socket.dispose(); relay.dispose() }, 'marshal: uplink socket')
  ctx.effect(registerMarshalRoutes({
    webServer, registry, relay, requireToken: config.dashboardToken!,
  }).dispose, 'marshal: dashboard routes')
  ctx.logger.info(`marshal: hub ready at ${webServer.getOrigin()}/marshal`)
}

function applyNode(ctx: MarshalContext, config: MarshalConfig): void {
  const controller = ctx.sessionController
  if (controller === undefined) throw new Error('marshal: node role requires the sessionController service')

  const patterns = config.redaction.map(source => new RegExp(source, 'gi'))
  const pipeline = (event: EventFrame): EventFrame => {
    const masked = config.privacy === 'content' ? event : stripContent(event)
    return { ...masked, payload: redact(masked.payload, patterns) }
  }

  let snapshot: AbortController | undefined
  const sendSnapshot = (): void => {
    // 每次连上都重发快照：hub 在 hello 时清掉了本设备的旧索引，必须以最新列表重建。
    snapshot?.abort()
    const abort = new AbortController()
    snapshot = abort
    void (async () => {
      for (const event of await adapter.snapshot(abort.signal)) link.sendEvent(pipeline(event))
    })().catch((error: unknown) => {
      // 主动取消导致的失败不是故障，不写日志。
      if (!abort.signal.aborted) ctx.logger.warn('marshal: snapshot failed: ' + String(error))
    })
  }

  // nodeEpoch 只随插件实例生成；普通重连沿用同一个值。
  const nodeEpoch = randomUUID()
  const link = new NodeLink({
    url: config.hubUrl!, token: config.token!, deviceId: config.deviceId!,
    deviceName: config.deviceName,
    agents: config.agents,
    nodeEpoch,
    privacy: config.privacy,
    onFrame: text => {
      let frame: Frame
      try { frame = decodeFrame(text) } catch { return }
      runCommand(link, adapter, follower, frame, config.deviceId!)
    },
    onOnline: sendSnapshot,
    onError: error => ctx.logger.warn(`marshal: link error: ${String(error)}`),
  })
  let relay: QuestionRelay | undefined
  const adapter = createDshAdapter(createDshSurface(controller), {
    deviceId: config.deviceId!,
    nodeEpoch,
    answers: {
      settle: (sessionId, requestId, answers) => relay?.settle(sessionId, requestId, answers) ?? 'unknown',
    },
  })
  relay = config.questionRelay === 'remote'
    ? createQuestionRelay({
        ctx, timeoutMs: config.answerTimeoutMs,
        send: event => link.sendEvent(pipeline(event)),
        frame: adapter.frame,
      })
    : undefined
  const follower = createFollower({
    adapter,
    send: event => link.sendEvent(pipeline(event)),
    logger: ctx.logger,
  })

  ctx.effect(() => { snapshot?.abort(); follower.stopAll(); relay?.dispose(); link.close() }, 'marshal: node link')
  link.start()
}
