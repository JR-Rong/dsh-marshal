import { parseConfig, type MarshalConfig } from './config.ts'
import type { EventFrame, Frame } from './wire/frames.ts'
import { decodeFrame } from './wire/frames.ts'
import type { MarshalContext } from './dsh-types.ts'
import { mountHubSocket, webServerPort } from './hub/server.ts'
import { registerMarshalRoutes } from './hub/api.ts'
import { DeviceRegistry } from './hub/registry.ts'
import { HubRelay } from './hub/relay.ts'
import { loadDevices } from './hub/devices.ts'
import { createDshSurface } from './adapters/dsh/surface.ts'
import { createDshAdapter } from './adapters/dsh/adapter.ts'
import { NodeLink } from './node/link.ts'
import { createFollower, runCommand } from './node/runner.ts'
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
  const relay = new HubRelay({ registry, now: Date.now })
  const socket = mountHubSocket({
    port: webServerPort(webServer),
    registry,
    devices: loadDevices(config.devicesFile),
    now: Date.now,
    onFrame: (_device, frame) => {
      // 事件进索引并扇出；ack 必须回填，否则 relay 的每条指令都会超时。
      if (frame.type === 'event') relay.publish(frame)
      else if (frame.type === 'ack') relay.settle(frame)
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

  const link = new NodeLink({
    url: config.hubUrl!, token: config.token!, device: config.deviceName,
    agents: ['dsh'],
    onFrame: text => {
      let frame: Frame
      try { frame = decodeFrame(text) } catch { return }
      runCommand(link, adapter, follower, frame, config.deviceName)
    },
    onError: error => ctx.logger.warn(`marshal: link error: ${String(error)}`),
  })
  const adapter = createDshAdapter(createDshSurface(controller), { device: config.deviceName })
  const follower = createFollower({
    adapter,
    send: event => link.sendEvent(pipeline(event)),
    logger: ctx.logger,
  })

  ctx.effect(() => { follower.stopAll(); link.close() }, 'marshal: node link')
  link.start()

  void (async () => {
    const abort = new AbortController()
    for (const event of await adapter.snapshot(abort.signal)) link.sendEvent(pipeline(event))
  })().catch((error: unknown) => ctx.logger.warn('marshal: snapshot failed: ' + String(error)))
}
