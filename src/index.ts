import { createDiscussionPort } from './discussions/ports.ts'
import { createNodeDiscussions } from './discussions/node.ts'
import { DISCUSSION_FEATURE } from './discussions/types.ts'
import { hasWriteControl } from './adapters/types.ts'
import { mountHub } from './hub/runtime.ts'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mountSidebarConnection } from './sidebar.ts'
import { parseConfig, type MarshalConfig } from './config.ts'
import type { Frame } from './wire/frames.ts'
import { decodeFrame, type EventFrame } from './wire/frames.ts'
import type { MarshalContext } from './dsh-types.ts'
import { createDshSurface } from './adapters/dsh/surface.ts'
import { createDshAdapter } from './adapters/dsh/adapter.ts'
import type { Adapter } from './adapters/types.ts'
import { createCodexAdapter } from './agents/codex/adapter.ts'
import { createClaudeAdapter } from './agents/claude/adapter.ts'
import type { AgentAdapter, NativeInputPort } from './agents/types.ts'
import { NodeLink } from './node/link.ts'
import { createNodeSync, type NodeSync } from './node/sync.ts'
import { openJournal } from './node/journal.ts'
import { createFollower, runRoutedCommand, type AgentRoute } from './node/runner.ts'
import { createSeqAllocator, withPublicSeq } from './node/seq.ts'
import { createQuestionRelay, type QuestionRelay } from './node/questions.ts'
import { createInteractionRelay } from './node/interactions.ts'
import { createAuditLog } from './node/audit.ts'
import { createPrivacyProjector, type PrivacyProjector } from './node/privacy.ts'
import { mountSetup } from './setup.ts'
import { hubHttpOrigin, mountDesktopPairing, startPhoneRelay, type PhoneHost } from './node/phone-sync.ts'

export const name = 'marshal'

export function apply(ctx: MarshalContext, raw: unknown): void {
  mountSetup(ctx, raw, applyConfigured)
}

function applyConfigured(ctx: MarshalContext, raw: unknown): void {
  const config = parseConfig(raw, process.env.HOSTNAME ?? 'unknown')
  mountSidebarConnection(ctx, config)
  if (config.role === 'hub') {
    ctx.inject(['webServer'], scoped => applyHub(scoped, config))
  } else if (config.agents.includes('dsh')) {
    ctx.inject(config.allowDiscussion ? ['sessionController', 'llm'] : ['sessionController'], scoped => applyNode(scoped, config))
  } else {
    applyNode(ctx, config)
  }
}

function applyHub(ctx: MarshalContext, config: MarshalConfig): void {
  if (ctx.webServer === undefined) throw new Error('marshal: hub role requires the webServer service')
  ctx.effect(() => mountHub(ctx.webServer!, config, ctx.logger), 'marshal: hub runtime')
}

/** 各 agent 独立投影器；agent 名嵌在指纹里，绝不能共用一个实例。 */
interface NodeBinding {
  readonly agent: string
  readonly adapter: Adapter
  readonly runtimeEpoch: string
  readonly follower: ReturnType<typeof createFollower>
  readonly liveProjector: PrivacyProjector
  /** DSH 问题表或 Codex/Claude 交互中继；两者都只做卡片与结算。 */
  readonly relayPort: RelayPort | undefined
  emit(event: EventFrame): void
  emitVolatile(event: EventFrame): void
  readonly inputs: {
    snapshot(sessionId: string): readonly unknown[]
    runtimeEpoch(sessionId: string): string
    highWatermark(sessionId: string): number
  }
}

/** QuestionRelay 与 NativeInputPort 的公共只读/生命周期面。 */
interface RelayPort {
  snapshot(sessionId: string): readonly unknown[]
  revalidate(): void
  dispose(): void
}

const SUPPORTED_AGENTS: ReadonlySet<string> = new Set(['dsh', 'codex', 'claude'])

function applyNode(ctx: MarshalContext, config: MarshalConfig): void {
  // 未知 agent 是启动配置错误：不能带着无法投影的适配器上线。
  for (const agent of config.agents) {
    if (!SUPPORTED_AGENTS.has(agent)) {
      throw new Error(`marshal: unsupported agent in config.agents: ${agent}`)
    }
  }
  // DSH 需要宿主的 sessionController；codex/claude 是独立子进程，不依赖它。
  if (config.agents.includes('dsh') && ctx.sessionController === undefined) {
    throw new Error('marshal: node role requires the sessionController service')
  }

  // journal 在发起任何调用前打开并持有进程间锁；损坏/缺失时直接启动失败，
  // 不能带着空去重表继续接受写命令。
  const hubCa = config.hubCaFile === undefined ? undefined : readFileSync(config.hubCaFile)
  const journal = openJournal()
  // nodeEpoch 只随插件实例生成；普通重连沿用同一个值。
  const nodeEpoch = randomUUID()
  const errorName = (error: unknown): string => error instanceof Error && error.name !== '' ? error.name : 'error'
  const audit = createAuditLog({ warn: message => ctx.logger.warn(message) })

  // 公开 seq 全节点共用一个分配器；适配器预分配的序号在出站前被覆盖。
  const publicSeq = createSeqAllocator()
  const bindings = new Map<string, NodeBinding>()
  const routes = new Map<string, AgentRoute>()
  /** 每次握手重建；缺失时一律退回最严格投影。 */
  const projectors = new Map<string, PrivacyProjector>()
  /** 握手前的策略基线：内容/交互必须同时获得两端授权。 */
  const policies = { allowContent: false, allowInteractions: false }

  const buildProjector = (agent: string, allowContent: boolean, allowInteractions: boolean): PrivacyProjector => {
    const nextSeq = bindings.get(agent)?.adapter.nextSeq
    return createPrivacyProjector({
      privacy: config.privacy,
      allowContent,
      questionRelay: config.questionRelay,
      approvalRelay: config.approvalRelay,
      allowInteractions,
      redaction: config.redaction,
      deviceId: config.deviceId!,
      agent,
      nodeEpoch,
      now: Date.now,
      ...(nextSeq === undefined ? {} : { nextSeq: (sessionId: string) => nextSeq(sessionId) }),
    })
  }
  const fallbackProjectors = new Map<string, PrivacyProjector>()
  const currentProjector = (agent: string): PrivacyProjector => {
    const current = projectors.get(agent)
    if (current !== undefined) return current
    // 握手前的兜底也按 agent 缓存，避免每次出口都重编译脱敏规则。
    let strict = fallbackProjectors.get(agent)
    if (strict === undefined) {
      strict = buildProjector(agent, false, false)
      fallbackProjectors.set(agent, strict)
    }
    return strict
  }
  /** 稳定的委托端口：握手重建后无需重新装配 relay/适配器。 */
  const liveProjector = (agent: string): PrivacyProjector => ({
    get content() { return currentProjector(agent).content },
    event: frame => currentProjector(agent).event(frame),
    ack: ack => currentProjector(agent).ack(ack),
    error: (origin, code, meta) => currentProjector(agent).error(origin, code, meta),
    syncRow: row => currentProjector(agent).syncRow(row),
    statusResult: result => currentProjector(agent).statusResult(result),
    card: card => currentProjector(agent).card(card),
    auditFields: fields => currentProjector(agent).auditFields(fields),
  })

  let discussions: ReturnType<typeof createNodeDiscussions> | undefined
  let nodeSync: NodeSync | undefined
  /** 逐事件兜底：单帧超限或投影失败只丢这一帧，不能终止跟随循环。 */
  const emitProjected = (agent: string, event: EventFrame): void => {
    let projected: EventFrame[]
    try {
      projected = currentProjector(agent).event(event)
    } catch (error) {
      ctx.logger.warn(`marshal: project ${agent} dropped event: ${errorName(error)}`)
      return
    }
    for (const item of projected) {
      try {
        // 同步层记录已投影的增量，扫描时不能用更旧的清单覆盖它。
        nodeSync?.observe(item)
        link.sendEvent(withPublicSeq(publicSeq, item))
      } catch (error) {
        ctx.logger.warn(`marshal: send ${agent} dropped event: ${errorName(error)}`)
      }
    }
  }
  // 卡片/通知是交互帧：只走 volatile 出口，断线即丢，绝不进入离线队列。
  // 序号在投影之后统一分配；卡片 payload 已由 relay 投影，这里只补公开 seq。
  const emitVolatile = (event: EventFrame): void => {
    link.sendVolatileEvent(withPublicSeq(publicSeq, event))
  }

  const register = (
    agent: string,
    adapter: Adapter,
    runtimeEpoch: string,
    relayPort: RelayPort | undefined,
  ): void => {
    const emit = (event: EventFrame): void => { emitProjected(agent, event) }
    const follower = createFollower({ adapter, send: emit, logger: ctx.logger })
    const inputs = {
      // 待答快照只读：node 内存里的当前有效卡，公开高水位与事件同源。
      snapshot: (sessionId: string) => relayPort?.snapshot(sessionId) ?? [],
      // 卡片由 relay 的实例代次产出；没有 relay 时退回节点握手代次。
      runtimeEpoch: () => runtimeEpoch,
      // 必须按会话取高水位：hub 把它当作该会话的回放/去重底价。
      highWatermark: (sessionId: string) => publicSeq.highWatermark({
        deviceId: config.deviceId!, agent, sessionId, nodeEpoch,
      }),
    }
    bindings.set(agent, {
      agent, adapter, runtimeEpoch, follower,
      liveProjector: liveProjector(agent),
      relayPort,
      emit,
      emitVolatile,
      inputs,
    })
    // 命令/状态/待答快照都按 target.agent 走各自的投影器与审计。
    routes.set(agent, { adapter, follower, runtime: { projector: () => currentProjector(agent), audit, inputs,
      ...(config.allowDiscussion ? { discussion: (frame: import('./wire/frames.ts').CommandFrame, args: unknown) => discussions!.execute(frame, args) } : {}) } })
  }

  if (config.agents.includes('dsh')) {
    let dshRelay: QuestionRelay | undefined
    const dshAdapter = createDshAdapter(createDshSurface(ctx.sessionController!), {
      deviceId: config.deviceId!,
      nodeEpoch,
      answers: {
        settle: (sessionId, requestId, answers) => dshRelay?.settle(sessionId, requestId, answers) ?? 'unknown',
        // 普通提问的 cancel 只结算本进程待答表，不是原生会话取消。
        cancel: (sessionId, requestId) => dshRelay?.cancel(sessionId, requestId) ?? 'unknown',
      },
    })
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
        deviceId: config.deviceId!,
        agent: 'dsh',
        // 当前协商授权；DSH 只有普通提问，relay 字段必须显式带上。
        authorization: () => {
          const current = link.binding
          if (current === undefined) return undefined
          return {
            relay: config.questionRelay,
            operatorId: current.operatorId,
            policyRevision: current.policyRevision,
            allowInteractions: current.policies.allowInteractions,
            content: liveProjector('dsh').content,
          }
        },
      })
    }
    register('dsh', dshAdapter, nodeEpoch, dshRelay)
  }

  /**
   * Codex/Claude 的交互中继：authorization 不含 relay（由 relay 按 kind 组合），
   * stillOwned 用适配器自己的写权端口判断，不能把只读会话的卡交给远答。
   */
  const interactionRelay = (
    agent: 'codex' | 'claude',
    adapter: () => AgentAdapter,
    runtimeEpoch: string,
  ): NativeInputPort | undefined => {
    if (config.questionRelay === 'off' && config.approvalRelay === 'off') return undefined
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
      deviceId: config.deviceId!,
      agent,
      now: Date.now,
      monoNow: () => globalThis.performance.now(),
    })
  }
  const handshakeAuthorization = (agent: string) => {
    const current = link.binding
    if (current === undefined) return undefined
    return {
      operatorId: current.operatorId,
      policyRevision: current.policyRevision,
      allowInteractions: current.policies.allowInteractions,
      content: projectors.get(agent)?.content === true,
    }
  }

  if (config.agents.includes('codex')) {
    const codexEpoch = `${nodeEpoch}:codex:${randomUUID()}`
    let codexAdapter: AgentAdapter
    const codexRelay = interactionRelay('codex', () => codexAdapter, codexEpoch)
    codexAdapter = createCodexAdapter({
      deviceId: config.deviceId!,
      nodeEpoch,
      runtimeEpoch: codexEpoch,
      questionRelay: config.questionRelay,
      approvalRelay: config.approvalRelay,
      ...(codexRelay === undefined ? {} : { inputRelay: codexRelay }),
      // 设置正文是否可见只看当前投影器，不看 wire 或请求参数。
      contentAuthorized: () => projectors.get('codex')?.content === true,
      ...(config.codexExecutable === undefined ? {} : { explicitPath: config.codexExecutable }),
    })
    register('codex', codexAdapter, codexEpoch, codexRelay)
  }

  if (config.agents.includes('claude')) {
    const claudeEpoch = `${nodeEpoch}:claude:${randomUUID()}`
    let claudeAdapter: AgentAdapter
    const claudeRelay = interactionRelay('claude', () => claudeAdapter, claudeEpoch)
    claudeAdapter = createClaudeAdapter({
      deviceId: config.deviceId!,
      nodeEpoch,
      runtimeEpoch: claudeEpoch,
      questionRelay: config.questionRelay,
      approvalRelay: config.approvalRelay,
      ...(claudeRelay === undefined ? {} : { inputRelay: claudeRelay }),
      ...(config.claudeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: config.claudeExecutable }),
    })
    register('claude', claudeAdapter, claudeEpoch, claudeRelay)
  }

  /** 未知 agent 的帧工厂：同步层理论上不会走到这里，但也不能抛。 */
  const frameFor = (agent: string, sessionId: string, kind: EventFrame['kind'], payload: unknown): EventFrame => {
    const source = bindings.get(agent)
    if (source !== undefined) return source.adapter.frame(sessionId, kind, payload)
    return {
      v: 2, type: 'event', deviceId: config.deviceId!, agent, sessionId,
      nodeEpoch, seq: 0, ts: Date.now(), kind, payload,
    }
  }

  const link = new NodeLink({
    ...(hubCa === undefined ? {} : { ca: hubCa }),
    url: config.hubUrl!, token: config.token!, deviceId: config.deviceId!,
    deviceName: config.deviceName,
    agents: config.agents,
    nodeEpoch,
    features: config.allowDiscussion ? [DISCUSSION_FEATURE] : [],
    privacy: config.privacy,
    onFrame: text => {
      let frame: Frame
      try { frame = decodeFrame(text) } catch { return }
      // sync.ack 是生命周期控制帧，不能进入命令分派。
      if (frame.type === 'sync.ack') { nodeSync?.onFrame(frame); return }
      // 按 target.agent 分派到该 agent 的适配器/跟随表/投影器；未知 agent 只回拒绝。
      runRoutedCommand(link, routes, frame, config.deviceId!, journal, Date.now)
    },
    onHandshake: (binding, previous) => {
      discussions?.invalidate()
      void discussions?.announce().catch(() => {})
      const tightened = (previous?.policies.allowContent === true && binding.policies.allowContent !== true)
        || (previous?.policies.allowInteractions === true && binding.policies.allowInteractions !== true)
      // 每个 relay 都先按新协商复核旧卡：授权变化（含仅 revision 变化）立即结算，
      // 且必须发生在重建投影器之前，否则收紧后连 invalidated 终态都发不出去。
      for (const item of bindings.values()) item.relayPort?.revalidate()
      policies.allowContent = binding.policies.allowContent
      policies.allowInteractions = binding.policies.allowInteractions
      // 每个 agent 各自重建：agent 名参与投影，不能共享实例。
      for (const agent of config.agents) projectors.set(agent, buildProjector(agent, policies.allowContent, policies.allowInteractions))
      // 旧队列按更宽策略编码，不能在新握手上补发。
      if (tightened) link.clearOutbound()
    },
    // hello.ack 后进入 syncing：先完成原子快照屏障，绝不能在这里冲刷普通事件。
    onSyncNeeded: () => { nodeSync?.begin() },
    // 订阅绑定当前连接：断线即清空每个 agent 的跟随引用。
    onOffline: () => {
      nodeSync?.abort()
      discussions?.invalidate()
      for (const item of bindings.values()) item.follower.stopAll()
    },
    onError: error => ctx.logger.warn(`marshal: link error: ${errorName(error)}`),
  })

  if (config.allowDiscussion) discussions = createNodeDiscussions({
    enabled: true, journal, link: () => link,
    port: createDiscussionPort({ agents: config.agents, ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
      ...(config.codexExecutable === undefined ? {} : { codexExecutable: config.codexExecutable }),
      ...(config.claudeExecutable === undefined ? {} : { claudeExecutable: config.claudeExecutable }),
    }),
  })

  nodeSync = createNodeSync({
    link,
    sources: [...bindings.values()].map(item => ({
      agent: item.agent,
      syncSnapshot: (signal: AbortSignal) => item.adapter.syncSnapshot(signal),
      sessionCapability: (sessionId: string) => {
        const capability = item.adapter.capabilities(sessionId)
        return { ...capability, operations: [...capability.operations] }
      },
    })),
    agents: config.agents,
    projector: agent => currentProjector(agent),
    emit: event => {
      const item = bindings.get(event.agent)
      if (item !== undefined) item.emit(event)
      else emitProjected(event.agent, event)
    },
    frame: (agent, sessionId, kind, payload) => frameFor(agent, sessionId, kind, payload),
    highWatermark: () => publicSeq.highWatermark(),
    logger: ctx.logger,
  })

  const phoneHost = (): PhoneHost => {
    const board = lookupService(ctx, 'taskBoard')
    const memory = lookupService(ctx, 'memory')
    const roster = lookupService(ctx, 'roster')
    return {
      ...(board === undefined ? {} : { board: board as NonNullable<PhoneHost['board']> }),
      ...(memory === undefined ? {} : { memory: memory as NonNullable<PhoneHost['memory']> }),
      ...(roster === undefined ? {} : { roster: roster as NonNullable<PhoneHost['roster']> }),
    }
  }
  const stopRelay = config.hubUrl !== undefined && config.token !== undefined && config.deviceId !== undefined
    ? startPhoneRelay({
        host: phoneHost,
        allowContent: config.privacy === 'content',
        origin: hubHttpOrigin(config.hubUrl),
        token: config.token,
        deviceId: config.deviceId,
        ...(hubCa === undefined ? {} : { ca: hubCa }),
      })
    : undefined
  ctx.inject(['webServer'], (scoped) => {
    if (scoped.webServer === undefined || config.hubUrl === undefined || config.token === undefined) return
    scoped.effect(() => mountDesktopPairing(scoped.webServer!, {
      hubUrl: config.hubUrl!,
      token: config.token!,
      ...(hubCa === undefined ? {} : { ca: hubCa }),
    }), 'marshal: desktop pairing')
  })
  ctx.effect(() => () => {
    stopRelay?.()
    discussions?.dispose()
    nodeSync?.dispose()
    for (const item of bindings.values()) {
      item.follower.stopAll()
      item.relayPort?.dispose()
      // 只有 AgentAdapter 有 stop；DSH 适配器随宿主卸载，不能伪造生命周期。
      const stoppable = item.adapter as Partial<AgentAdapter>
      if (typeof stoppable.stop === 'function') void stoppable.stop().catch(() => {})
    }
    link.close()
    journal.close()
  }, 'marshal: node link')
  link.start()
}

function lookupService(ctx: MarshalContext, name: string): unknown {
  const bag = ctx as MarshalContext & { get?: (service: string) => unknown }
  if (typeof bag.get !== 'function') return undefined
  try { return bag.get(name) } catch { return undefined }
}
