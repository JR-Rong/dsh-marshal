# dsh-marshal 架构设计

日期：2026-10-29
上游：[设计文档](2026-10-29-marshal-design.md)
范围：v0 的实现架构（DSH↔DSH 全链路），并为 v1+ 的适配器预留边界

## 1. 运行时视图

三个进程角色，同一份代码：

| 进程 | 组成 | 职责 |
|---|---|---|
| hub | `dsh web` + marshal(hub) | 终止 node 连接、维护注册表、扇出事件、托管页面 |
| node | `dsh web --host 127.0.0.1` + marshal(node) | 扫描本地会话、执行指令、回传归一化事件 |
| 浏览器 | 任意 | 打开 hub 的 `/marshal`，SSE 收流，POST 发指令 |

hub 同时也是一个 node（它自己机器上的 agent 也要被管），实现上 hub 复用 node 的适配器层，只是不向自己拨号。

## 2. 模块分解

仓库根即插件包根。

```
src/
  index.ts                 # Cordis 入口：读 config、按角色装配
  config.ts                # 配置解析与校验（无默认端点）
  types.ts                 # 对外类型再导出
  dsh-types.ts             # 用到的 DSH 服务结构化类型（不依赖 DSH 包）
  wire/
    frames.ts              # zod 帧定义、编解码、版本
    idempotency.ts         # 幂等键 → 结果，TTL + LRU
  hub/
    registry.ts            # 设备注册表（内存，lastSeen 过期）
    server.ts              # WSS 升级路由 + 握手鉴权 + 心跳
    relay.ts               # 命令路由、事件扇出、背压
    api.ts                 # /marshal/api/devices|sessions|command|stream（复用 webServer，不另监听）
    page.ts                # 自包含页面（HTML + 内联 CSS/JS）
    devices.ts             # 设备 token 文件读写 + findByToken
  node/
    link.ts                # 拨号、指数退避、心跳、断线有界缓冲
    runner.ts              # 收指令 → 校验 → 交给适配器 → 回事件
    questions.ts           # user-questions 瀑布桥接：认领、转发、首答胜出
    redact.ts              # 出站脱敏与 metadata 裁剪
  bin/
    device.ts              # marshal-device：签发设备 token，只打印一次
  adapters/
    types.ts               # Adapter 接口
    dsh/
      surface.ts           # 对 ctx.sessionController 的薄封装
      adapter.ts           # 清单、跟随、指令
      map.ts               # SessionFollowFrame → EventFrame
tests/
  fixtures/dsh-follow.jsonl  # follow 帧样本（形状取自 session-controller/src/types.ts）
  support/web.ts             # 把 RouteSink 接到真 http.Server 的测试替身
```

依赖方向严格单向：`index → hub|node → adapters → wire`。`wire` 不 import 任何 DSH 包，因此可以用纯 Node 单测。

## 3. 关键接口

```ts
// adapters/types.ts
export interface Adapter {
  readonly agent: string
  capabilities(sessionId: string): Capability
  /** 当前会话清单，已转成 session.updated 事件。 */
  snapshot(signal: AbortSignal): Promise<readonly EventFrame[]>
  /** 跟随一个会话；seq 由适配器按 sessionId 单调分配。 */
  follow(sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame>
  /** 造一个走同一 seq 计数器的帧；快照、跟随、提问共用一条序列。 */
  frame(sessionId: string, kind: EventFrame['kind'], payload: unknown): EventFrame
  execute(command: { op: string; target: { sessionId: string }; args?: unknown }): Promise<unknown>
}

// hub/server.ts —— 上行入口只依赖一个「谁持有 upgrade 事件」的端口
export interface UpgradePort {
  open(handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): () => void
}
export const nodeServerPort: (server: Server) => UpgradePort
export const webServerPort: (webServer: WebServerLike) => UpgradePort   // 走 registerUpgrade，只登记 /marshal/uplink

// node/link.ts
export interface NodeLink {
  start(): void
  sendEvent(frame: EventFrame): void   // 断线时进有界缓冲，满则丢最旧并计数
  sendRaw(text: string): void          // ack 等非事件帧走同一缓冲
  close(): void
}

// hub/relay.ts
export interface Relay {
  command(cmd: MarshalCommand): Promise<CommandOutcome>
  settle(ack: AckFrame): void
  publish(event: EventFrame): void
  subscribe(consumer: (event: EventFrame) => void): () => void
  sessions(deviceId?: string): readonly SessionRow[]
}
```

`Sender` 只是 `{ send(text: string): void }`，因此 relay 的测试不需要真 WebSocket。

## 4. 状态机

**node 连接**：`idle → dialing → handshaking → online → (draining → dialing) | closed`。`draining` 期间缓冲上限 1000 条，超出丢最旧并累计一个 `dropped` 计数，重连后随第一个事件上报。

**会话写者**：`idle | interactive | marshal`。`execute()` 前检查：非 `idle` 且指令需要写 → 返回 `writer-busy`，不排队（v0 不含跨机排队；排队留给 v1，避免未验证的隐式延迟）。

**待答请求**：`open → answered | expired | cancelled`。终态广播 `input.resolved`，且**只有第一次转移有效**（hub 侧按 requestId 去重）。

## 5. 时序

### 5.1 跨机发一条提示词

```
A 浏览器 ──POST /marshal/api/command──▶ hub
                                     │ 校验 target.device 在线
                                     │ 幂等键查表（未命中）
                                     ▼
                            socket(B) ──command──▶ node B runner
                                                    │ device/session 白名单校验
                                                    │ adapter.execute(prompt)
                                                    ▼
                                              sessionController.prompt()
                                                    │
                            socket(B) ◀──ack─── ────┘
A 浏览器 ◀──200 { ok, seq }── hub
                                     ▲
                            socket(B) ──event(seq=n…)──▶ relay ──SSE──▶ A
```

ack 表示"已受理"，不代表模型已回复；后续内容一律走事件流。

### 5.2 一个选择框

```
node B: DSH 触发 user-questions/request 瀑布
   → marshal 认领（不调 next()），本地弹窗因此不出现
   → adapter.frame() 生成 input.requested（requestId = q-<uuid>）
   → hub 广播，A 的页面弹出卡片
A 点选项 → POST /marshal/api/command{op:'answer'}
   → 到达 B → QuestionRelay.settle() 校验答案形状并 resolve
   → B 广播 input.resolved{outcome:'remote'}
   → 本地 UI 不再弹（请求已被认领）
```

若 `answerTimeoutMs` 内无人回答，或 A 中途放弃、或 B 侧请求被取消：marshal 调 `next()`，把请求交回本地 DSH，本地弹窗此时才出现（会晚一些，README 必须写明）。B 本地抢先回答的场景在认领模式下不存在——认领即独占；要支持"本地同时可见"得放弃认领，v0 不做。

`ctx.userQuestions.answer(...)` 走的是另一条路：它只能结算已经 `continued`（超时后转入）的提问，因此只用于 v1 的补偿，不在 v0 链路上。

## 6. 错误分类

| 码 | 产生方 | 语义 | 客户端行为 |
|---|---|---|---|
| `frame-invalid` | 任一侧 | zod 校验失败 | 关闭该连接，记录首帧内容 |
| `auth-failed` | hub | token 未知或吊销 | node 停止拨号，等人工介入（不无限重试） |
| `device-offline` | hub | 目标不在注册表 | 直接失败，不进缓冲 |
| `session-unknown` | node | sessionId 不在本机清单 | 拒绝，附本机已知 sessionId 列表 |
| `writer-busy` | node | 会话被本地交互占用 | UI 显示"该会话正在本机运行" |
| `unsupported` | node | 适配器不具备该能力 | UI 本来就不该有按钮；防御性拒绝 |
| `timeout` | hub | 30s 未 ack | 失败，不重试 |
| `adapter-crashed` | node | 适配器抛错 | 上报 `error` 事件，node 保持在线 |

所有错误都走 `{ type:'error', code, message, detail? }`，**不把异常堆栈原文发给 hub**（可能含路径与凭据）。

## 7. 与 DSH 的耦合面

按置信度分级，实施时按此顺序验证：

| 接口 | 置信度 | 依据 | 失效时的退路 |
|---|---|---|---|
| `ctx.webServer.register` / `registerUpgrade` | 高 | 已读源码签名 | — |
| `ctx.sessionController.list({})` | 高 | 已读签名，返回 `{items}` | 退回 `ctx.sessionQuery` |
| `ctx.sessionController.events(page, signal)` | 高 | 已读签名；`address` 为 `{kind:'session',sessionId}` | 退回磁盘 JSONL tail |
| `ctx.sessionController.follow(req, signal)` | 中 | 是 Remote 流方法，进程内直接调用需实测不依赖 `ctx.invocation` | 退回 `events()` 500ms 轮询 |
| `ctx.on('user-questions/request', …)` | 高 | `packages/sdk/server/src/user-questions.ts` 即为同一写法：认领 → 请求远端 → 超时 `next()` | 退回"只通知"（`questionRelay` 强制 off） |
| `ctx.userQuestions.answer(agent, callId, answer)` | 中 | 只能结算 `continued` 提问，不是 live 提问的通用入口 | v1 补偿用；v0 不用 |
| `sessionController.prompt(req)` | 高 | 已读签名 | — |
| `webServer` 路由是否经过启动鉴权 | 低 | 未见文档 | 插件内自行校验 cookie，失败则返回 401 |
| `ctx.inject([...], cb)` 条件注入 | 中 | Cordis 通用能力 | 改为在 `apply` 里判断 `ctx.webServer` 是否存在 |

**原则**：所有 DSH 调用集中在 `adapters/dsh/surface.ts` 一个文件里，上层只依赖 `DshSurface` 接口。DSH 升级导致签名变化时，只改这一个文件。

## 8. 可观测性

- 日志前缀统一 `marshal:`，等级由 DSH 日志系统控制。
- 计数器：`events.dropped`、`commands.rejected`、`link.reconnects`、`adapter.errors`（内存计数，页面右下角可见）。
- 审计：每条远端写指令落一行 JSON 到 `~/.dsh-marshal/audit.jsonl`（`ts`、`device`、`agent`、`sessionId`、`op`、`answer?`）。**只记指令，不记内容**。

## 9. 安全边界

```
浏览器 ──(dashboardToken: header 或 ?token=)──▶ hub ──(device token, TLS)──▶ node
```

- hub 侧：`/marshal` 与 `/marshal/api/*` 都要求 `dashboardToken`（`x-marshal-token` 头或 `?token=`），缺失或错误一律 401；`/marshal/uplink` 用独立 device token 鉴权，与 dashboardToken 不通用。
- node 侧：只接受 `device === self` 的帧；`sessionId` 必须在当次清单内；`op` 必须在白名单内。
- node 不监听任何端口，只做出站连接。
- token 只在 `Authorization` 头里传，不出现在 URL 与日志中。

## 10. 非功能目标

| 项 | 目标 | 说明 |
|---|---|---|
| 事件延迟 | 源机器产生到浏览器渲染 < 2s（局域网 < 300ms） | v0 验收第 2 条 |
| 单 node 内存 | < 50 MB（不含 agent 子进程） | 缓冲 + 索引 |
| 断线恢复 | 30s 内自动重连并对齐状态 | v0 验收第 6 条 |
| 帧大小 | 单帧 ≤ 1 MB，超出截断并标记 | 工具输出可能很大 |
| 连接数 | hub 支持 50 个 node | 家用规模 |

## 11. 关键决策（ADR）

**ADR-1 用反向 WebSocket 而不是 P2P 或轮询。** 备选：SSE + 反向 HTTP（每次指令一个请求，无法双向推流）、SSH 隧道（需要每台机器配置密钥，公司机器未必允许）。选 WSS 因为它双向、单连接、穿透性好，且 node 侧不需要任何监听端口。

**ADR-2 自建归一化协议，不复用 DSH Gateway 协议。** 备选：让 hub 作为 peer 连到各 node 的 Gateway。问题在于 Gateway 是 client→host 方向，node 需要先监听；且它只覆盖 DSH 自己的命名空间，管不了 Codex。自建协议以 ACP 的事件词汇为参考（thought / message / tool call），因为那是业界对"agent 流式行为"的共识描述。

**ADR-3 事件内容不落盘。** 备选：hub 存最近 N 小时全部内容，便于回溯。否决理由：内容含源码与命令输出，落盘等于在中心机复制一份敏感数据；权威副本已在源机器。补看需求用 15 分钟内存环形缓冲满足。

**ADR-4 v0 不做跨机指令排队。** 写者非空闲时直接失败。备选：排队等 idle 再执行。否决理由：排队的提示词在几十分钟后突然执行，比失败更危险；等 v1 有明确 UI 反馈后再做。

**ADR-5 页面是服务端渲染的静态 HTML + SSE，不是 SPA。** 备选：注册客户端插槽，做进 DSH 原生界面。否决理由：客户端插槽需要随 DSH 前端一起构建，版本耦合重；独立路由对 Web、桌面浏览器、手机浏览器一视同仁。

## 12. 为 v1+ 预留

- `adapters/types.ts` 已把 `capabilities()` 与 `execute()` 抽成通用接口，新增 Codex 适配器只需实现它，hub 与页面不动。
- 帧里的 `agent` 是字符串而非枚举，新增 agent 不需要升版本号。
- `Tunable` 的 `scope`/`effect` 是数据，不是行为分支；页面按数据渲染。
- v0 的七项 `Tunable` 全部 `editable: false`：v0 只认出字段与拒绝放宽。v1 在 Codex/Claude 上把其中五项置为可改，并把 `skill`/`plugin` 保持只读；DSH 的切换顺延到 v1.1。落地细节见 [v1 架构](2026-10-29-marshal-v1-architecture.md) 与 [v1 实施计划](../plans/2026-10-29-marshal-v1.md)。
