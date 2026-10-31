import { randomUUID } from 'node:crypto'
import { parseConfig, type MarshalConfig } from './config.ts'
import type { Frame } from './wire/frames.ts'
import { decodeFrame, type EventFrame } from './wire/frames.ts'
import type { MarshalContext } from './dsh-types.ts'
import { mountHubSocket, webServerPort } from './hub/server.ts'
import { registerMarshalRoutes } from './hub/api.ts'
import { DeviceRegistry } from './hub/registry.ts'
import { HubRelay } from './hub/relay.ts'
import { ensureInstall } from './hub/identity.ts'
import { createDshSurface } from './adapters/dsh/surface.ts'
import { createDshAdapter } from './adapters/dsh/adapter.ts'
import { NodeLink } from './node/link.ts'
import { openJournal } from './node/journal.ts'
import { createFollower, runCommand } from './node/runner.ts'
import { createSeqAllocator, withPublicSeq } from './node/seq.ts'
import { createQuestionRelay, type QuestionRelay } from './node/questions.ts'
import { createAuditLog } from './node/audit.ts'
import { createPrivacyProjector, type PrivacyProjector } from './node/privacy.ts'

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
      // 只读状态查询走独立完成逻辑，不能混进 ACK 或 event。
      else if (frame.type === 'command.status.result') relay.settleStatus(frame, identity)
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

  // journal 在发起任何调用前打开并持有进程间锁；损坏/缺失时直接启动失败，
  // 不能带着空去重表继续接受写命令。
  const journal = openJournal()
  // nodeEpoch 只随插件实例生成；普通重连沿用同一个值。
  const nodeEpoch = randomUUID()
  const errorName = (error: unknown): string => error instanceof Error && error.name !== '' ? error.name : 'error'
  let relay: QuestionRelay | undefined
  const adapter = createDshAdapter(createDshSurface(controller), {
    deviceId: config.deviceId!,
    nodeEpoch,
    answers: {
      settle: (sessionId, requestId, answers) => relay?.settle(sessionId, requestId, answers) ?? 'unknown',
      // 普通提问的 cancel 只结算本进程待答表，不是原生会话取消。
      cancel: (sessionId, requestId) => relay?.cancel(sessionId, requestId) ?? 'unknown',
    },
  })
  const audit = createAuditLog({ warn: message => ctx.logger.warn(message) })

  // 单一投影端口：策略在每次握手后重建，所有出口都通过 liveProjector 取当前实例。
  const buildProjector = (allowContent: boolean, allowInteractions: boolean): PrivacyProjector =>
    createPrivacyProjector({
      privacy: config.privacy,
      allowContent,
      questionRelay: config.questionRelay,
      approvalRelay: config.approvalRelay,
      allowInteractions,
      redaction: config.redaction,
      deviceId: config.deviceId!,
      agent: adapter.agent,
      nodeEpoch,
      now: Date.now,
      nextSeq: sessionId => adapter.nextSeq?.(sessionId) ?? 0,
    })
  // 握手前一律按最严格策略出站；内容/交互必须同时获得两端授权。
  let projector = buildProjector(false, false)
  const liveProjector: PrivacyProjector = {
    get content() { return projector.content },
    event: frame => projector.event(frame),
    ack: ack => projector.ack(ack),
    error: (origin, code, meta) => projector.error(origin, code, meta),
    syncRow: row => projector.syncRow(row),
    statusResult: result => projector.statusResult(result),
    card: card => projector.card(card),
    auditFields: fields => projector.auditFields(fields),
  }

  let snapshot: AbortController | undefined
  const sendSnapshot = (): void => {
    // 每次连上都重发快照：hub 在 hello 时清掉了本设备的旧索引，必须以最新列表重建。
    snapshot?.abort()
    const abort = new AbortController()
    snapshot = abort
    void (async () => {
      for (const event of await adapter.snapshot(abort.signal)) emitProjected(event)
      // 分页没有终止证据时只报告“不完整”，T06 的同步必须据此标记而不是当全量。
      if (adapter.snapshotCompleteness === 'unconfirmed') {
        ctx.logger.warn('marshal: snapshot incomplete: pagination unconfirmed')
      }
    })().catch((error: unknown) => {
      // 主动取消导致的失败不是故障，不写日志；日志只留错误类型。
      if (!abort.signal.aborted) ctx.logger.warn('marshal: snapshot failed: ' + errorName(error))
    })
  }

  // 公开 seq 只在投影/过滤之后分配；适配器预分配的序号在出站前被覆盖。
  const publicSeq = createSeqAllocator()
  const emitProjected = (event: EventFrame): void => {
    for (const projected of projector.event(event)) link.sendEvent(withPublicSeq(publicSeq, projected))
  }
  const emitVolatileProjected = (event: EventFrame): void => {
    link.sendVolatileEvent(withPublicSeq(publicSeq, event))
  }

  const link = new NodeLink({
    url: config.hubUrl!, token: config.token!, deviceId: config.deviceId!,
    deviceName: config.deviceName,
    agents: config.agents,
    nodeEpoch,
    privacy: config.privacy,
    onFrame: text => {
      let frame: Frame
      try { frame = decodeFrame(text) } catch { return }
      runCommand(link, adapter, follower, frame, config.deviceId!, journal, Date.now, {
        projector: () => projector,
        audit,
      })
    },
    onHandshake: (binding, previous) => {
      const tightened = (previous?.policies.allowContent === true && binding.policies.allowContent !== true)
        || (previous?.policies.allowInteractions === true && binding.policies.allowInteractions !== true)
      // 每次合法 hello.ack 都重新核验旧卡授权（含仅 revision 变化）；
      // 必须在重建投影器之前发出 invalidated，否则收紧后连终态都发不出去。
      relay?.revalidate()
      projector = buildProjector(binding.policies.allowContent, binding.policies.allowInteractions)
      // 旧队列按更宽策略编码，不能在新握手上补发。
      if (tightened) link.clearOutbound()
    },
    onOnline: sendSnapshot,
    // 订阅绑定当前连接：断线即清空引用，重连后由 hub 重新订阅。
    onOffline: () => follower.stopAll(),
    onError: error => ctx.logger.warn(`marshal: link error: ${errorName(error)}`),
  })
  relay = config.questionRelay === 'off'
    ? undefined
    : createQuestionRelay({
        ctx, timeoutMs: config.answerTimeoutMs,
        projector: liveProjector,
        runtimeEpoch: nodeEpoch,
        // 卡片/通知是交互帧：只走 volatile 出口，断线即丢，绝不进入离线队列。
        // 序号在投影之后统一分配，卡片 payload 已投影，这里只补公开 seq。
        send: event => emitVolatileProjected(event),
        frame: adapter.frame,
        // 当前协商授权；卡片创建、answer/cancel 结算与每次 hello.ack 都按它复核。
        authorization: () => {
          const binding = link.binding
          if (binding === undefined) return undefined
          return {
            relay: config.questionRelay,
            operatorId: binding.operatorId,
            policyRevision: binding.policyRevision,
            allowInteractions: binding.policies.allowInteractions,
            content: liveProjector.content,
          }
        },
      })
  const follower = createFollower({
    adapter,
    send: event => emitProjected(event),
    logger: ctx.logger,
  })

  ctx.effect(() => {
    snapshot?.abort()
    follower.stopAll()
    relay?.dispose()
    link.close()
    journal.close()
  }, 'marshal: node link')
  link.start()
}
