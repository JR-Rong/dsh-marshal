# dsh-marshal v1 架构设计

日期：2026-10-29
上游：[v1 设计](2026-10-29-marshal-v1-design.md) · [v0 架构](2026-10-29-marshal-architecture.md)
范围：多 agent 适配层的实现结构；hub、线协议与页面只做增量

## 1. 运行时视图

| 进程 | 组成 | 变化 |
|---|---|---|
| hub | `dsh web` + marshal(hub) | 新增每会话 15 分钟环形缓冲；审批去重表 |
| node | `dsh web --host 127.0.0.1` + marshal(node) + **AgentHost** | 新增子进程监督；每个 agent 一个适配器 |
| Codex 子进程 | `codex app-server --stdio` | 每 node 一个，懒启动，按需多 thread |
| Claude 子进程 | SDK 驱动的 CLI 子进程 | 每个活跃会话一个 `Query`，空闲 10 分钟关闭 |
| 浏览器 | 任意 | 新增控制条、审批卡、补看 |

```
            ┌──────────── node B ────────────┐
            │ marshal(node)                  │
 browser ──▶│  AgentHost                     │
   hub      │   ├─ dsh     (in-process)      │
            │   ├─ codex   ── stdio ──▶ app-server
            │   └─ claude  ── stdio ──▶ SDK CLI
            └────────────────────────────────┘
```

**node 仍然不监听任何入站端口**。两个 agent 子进程都由 node 主动拉起，走 stdio。

## 2. 模块分解

```
src/
  agents/
    types.ts                # AgentAdapter v2、探针结果、所有权枚举
    registry.ts             # agent id → factory，按可用性装配
    host.ts                 # AgentHost：启动、健康、重启、广播能力
    supervisor.ts           # 子进程监督：spawn、stderr 环、退避、优雅退出
    codex/
      protocol.ts           # 只声明用到的 JSON-RPC 方法与载荷（zod）
      peer.ts               # NDJSON 帧、id 分配、请求超时、服务端请求路由
      discover.ts           # thread/list、thread/read、thread/turns/list
      session.ts            # resume、turn/start|steer|interrupt、settings、goal
      map.ts                # 通知 → EventFrame
      approvals.ts          # 服务端请求 → input.requested / input.resolved
      adapter.ts            # 组装成 AgentAdapter
    claude/
      discover.ts           # listSessions、getSessionInfo、getSessionMessages
      session.ts            # query 生命周期、streamInput、interrupt、setModel
      map.ts                # SDKMessage → EventFrame
      permissions.ts        # canUseTool / onElicitation → input.requested
      adapter.ts
  tunables/
    catalog.ts              # 每个 agent 的 Tunable 全量快照
    tighten.ts              # 权限与强度的偏序与转移表
  hub/
    buffer.ts               # v1：每会话 15 分钟环形缓冲
    approvals.ts            # v1：requestId 去重与 TTL
```

依赖方向不变：`index → node|hub → agents → adapters/wire`。`agents/*` 不 import DSH 包；Claude 适配器只 import SDK 类型，Codex 适配器只 import 自己写的协议子集。

## 3. 关键接口

### 3.1 AgentAdapter

v0 的 `Adapter` 不变，v1 在它之上加三个可选能力：

```ts
// src/agents/types.ts
import type { Adapter, Capability } from '../adapters/types.ts'
import type { EventFrame } from '../wire/frames.ts'

export type Ownership = 'ours' | 'foreign-idle' | 'foreign-running'

export interface AgentProbe {
  readonly available: boolean
  readonly version?: string
  readonly missing: readonly string[]   // 探测到但不可用的方法/字段
  readonly reason?: string              // 不可用的一句话原因
}

export interface AgentAdapter extends Adapter {
  /** 启动探测；host 在装配与重启后调用。 */
  probe(signal: AbortSignal): Promise<AgentProbe>
  /** 该会话当前的所有权判定，用于 writer-busy 与页面提示。 */
  ownership(sessionId: string): Ownership
  /** 全量设置快照；页面控制条只读它。 */
  tunables(sessionId: string): readonly import('../adapters/types.ts').Tunable[]
  /** 启动/停止子进程；dsh 适配器为 no-op。 */
  start(): Promise<void>
  stop(): Promise<void>
}
```

`execute` 的 op 在 v1 增加 `'decide'`；其余签名不变，因此 hub 与 relay 不需要认识 agent。

### 3.2 AgentHost

```ts
export interface AgentHost {
  start(): Promise<void>
  stop(): Promise<void>
  adapters(): readonly AgentAdapter[]
  /** 合并所有适配器的快照，按 updatedAt 倒序。 */
  snapshot(signal: AbortSignal): Promise<readonly EventFrame[]>
  /** 按 agent 路由跟随；找不到 agent 时抛 `agent-missing`。 */
  follow(agent: string, sessionId: string, signal: AbortSignal): AsyncIterable<EventFrame>
  execute(command: { op: string; target: { agent: string; sessionId: string }; args?: unknown }): Promise<unknown>
  /** 给 hello 用的能力摘要。 */
  describe(): readonly { agent: string; probe: AgentProbe; capabilities: Capability }[]
}
```

`AgentHost` 是 node 唯一需要认识的新对象；`node/runner.ts` 从"直接持有 dsh adapter"改成"持有 host"。

### 3.3 子进程监督

```ts
export interface SupervisorOptions {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly onLine: (line: string) => void
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void
}

export interface Supervisor {
  start(): void
  stop(): Promise<void>
  readonly running: boolean
  readonly restarts: number
}
```

规则：

- 退避：1s、2s、4s、8s、16s、30s 封顶；滑动窗口 60 秒内最多 5 次，超出进入 `failed`，等下一次用户操作或 5 分钟后重试。
- stderr 只在内存保留最后 200 行，供 `agent-health` 日志用；**不发给 hub**（可能含路径与令牌）。
- 退出时先把该 agent 的所有待答请求置为 `cancelled`，再通知 host。

### 3.4 设置端口

```ts
export interface TunablePort {
  snapshot(sessionId: string): readonly Tunable[]
  apply(sessionId: string, field: Tunable['id'], value: unknown): Promise<{
    ok: boolean
    readback?: unknown
    code?: string
  }>
}
```

`apply` 的实现必须等 agent 的确认，不允许"发完就返回"。回读来源见 §7。

## 4. Codex 子系统

### 4.1 进程与握手

- 二进制：优先用已安装包里的入口脚本（`@openai/codex` 的 `bin.codex`），用当前 `process.execPath` 执行；PATH 上有 `codex` 时作为次选。**不假设** `codex` 在 PATH。
- 参数：`app-server --stdio`。
- 握手：`initialize` → `initialized` 通知 → `model/list` 探测。

```ts
{ id, method: 'initialize', params: {
    clientInfo: { name: 'dsh-marshal', title: 'dsh-marshal', version: '0.1.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
} }
```

`experimentalApi: true` 是为了拿到 `item/tool/requestUserInput`（提问卡）；若对方不认这个能力，提问能力标记为不可用，其余功能不受影响。

协议版本以探测到的 `codex --version` 与 `model/list` 是否可用为准；不硬编码"支持所有 0.x"。

### 4.2 JSON-RPC 传输

- 帧：一行一个 JSON 对象，`\n` 分隔；不支持批处理。
- 请求：`{ id, method, params }`，id 自增；超时 30s，超时后删除 pending 并返回 `agent-timeout`。
- 响应：`{ id, result }` 或 `{ id, error: { code, message } }`。
- 通知：无 id。
- 服务端请求：带 id 与 method，必须回复；v1 只处理 §4.6 列出的五个方法，其余统一回 `error`（`method-not-supported`），不静默挂起。
- 单帧上限 8 MB（Codex 的工具输出可能很大）；超限断开并重启进程，避免内存爆掉。

### 4.3 发现与历史

```ts
// 清单
{ method: 'thread/list', params: {
    limit: 50,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    useStateDbOnly: true,
    sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
} }
```

返回 `data: Thread[]`，每项含 `id`、`name`、`preview`、`cwd`、`updatedAt`（秒）、`createdAt`、`model`、`reasoningEffort`、`status`、`canAcceptDirectInput`、`source`、`cliVersion`。

- `name` 为空时用 `preview` 截断作为标题；再空则用短 id。
- 历史：`thread/read { threadId, includeTurns? }` 只取最近一页；更细的用 `thread/items/list`。
- **不直接读 `$CODEX_HOME/state_*.sqlite`**：文件名含内部版本号，表结构随版本变；`thread/list` 是同一份数据的官方出口。只有 app-server 不可用时，才退化为"列出会话标题 + 说明不可观察"，不做写入。

### 4.4 所有权与续跑

```
foreign-idle --thread/resume--> ours
foreign-running --thread/resume--> 失败 --> writer-busy（状态不变）
```

`thread/resume` 参数：

```ts
{ threadId, excludeTurns: true, initialTurnsPage: { limit: 20 },
  ...可选的 model / effort / approvalPolicy / sandbox 覆盖 }
```

- `excludeTurns: true` 避免一次性拉全部历史；历史用 `thread/items/list` 分页补。
- 成功响应里带 `model`、`reasoningEffort`、`approvalPolicy`、`approvalsReviewer`、`cwd`、`activePermissionProfile`，直接作为首次 `capability.changed` 的值。
- 错误映射：包含 `active`/`running`/`in use` 等词 → `writer-busy`；其余 → `resume-failed`。不把原始 message 发给 hub，只发分类。

### 4.5 事件映射

| Codex 通知 | marshal 事件 | 载荷 |
|---|---|---|
| `turn/started` | `turn.started` | `{ turnId }` |
| `item/started`（`commandExecution`） | `tool.started` | `{ callId: item.id, name: 'exec', args: { command, cwd } }` |
| `item/started`（`fileChange`） | `tool.started` | `{ callId: item.id, name: 'apply_patch', args: { changes: n } }` |
| `item/started`（`mcpToolCall` / `dynamicToolCall` / `webSearch`） | `tool.started` | `{ callId: item.id, name }` |
| `item/reasoning/textDelta`、`summaryTextDelta` | `reasoning.delta` | `{ text, itemId }` |
| `item/agentMessage/delta` | `message.delta` | `{ text, itemId }` |
| `item/commandExecution/outputDelta`、`item/fileChange/outputDelta` | `tool.output` | `{ callId: itemId, text }` |
| `item/plan/delta` | 忽略 | 完成态为准 |
| `item/completed`（`agentMessage`） | `message.completed` | `{ itemId, chars }` |
| `item/completed`（`commandExecution` / `fileChange` / `mcpToolCall`） | `tool.completed` | `{ callId, status, exitCode?, durationMs? }` |
| `item/completed`（`plan`） | `tool.started` + `tool.completed` | `name: 'plan'`，`content: item.text` |
| `turn/completed` | `turn.completed` | `{ turnId, status }` |
| `turn/plan/updated` | 忽略 | 由 `plan` item 呈现 |
| `thread/tokenUsage/updated` | `session.updated` | `{ tokens }` |
| `thread/name/updated` | `session.updated` | `{ title }` |
| `thread/status/changed` | `session.updated` | `{ running, status }` |
| `thread/settings/updated` | `capability.changed` | `{ tunables, readbackAt }` |
| `thread/closed` | `session.updated` | `{ running: false }` |
| `error` | `error` | `{ code: 'agent-error', message: 分类 }` |
| `warning` / `configWarning` | `error` | `{ code: 'agent-warning', message }` |
| `serverRequest/resolved` | 若该请求仍在待答表，发 `input.resolved { outcome: 'cancelled' }` | |

未列出的通知一律忽略并计数，不报错——新版本会加通知，忽略比崩溃好。

**seq 规则**：与 v0 相同，按 `sessionId` 单调递增；所有事件（包括审批卡）都走同一个 `frame()`。

### 4.6 审批映射

| 服务端请求 | 处理 | 回复 |
|---|---|---|
| `item/commandExecution/requestApproval` | 发审批卡，`action: 'command'`，选项来自 `availableDecisions` | `{ decision }` |
| `item/fileChange/requestApproval` | 发审批卡，`action: 'file-change'` | `{ decision }` |
| `item/permissions/requestApproval` | **不弹卡**：这是要求放宽权限，与只收紧冲突；记录一条告警 | `{ permissions: {}, scope: 'turn' }` |
| `item/tool/requestUserInput` | 发提问卡，`kind: 'question'` | `{ answers: { <id>: { answers: [...] } } }` |
| `mcpServer/elicitation/request` | 发通知型卡片（无选项），自动拒绝 | `{ action: 'decline', content: null, _meta: null }` |
| 其余 | 记 `agent-warning`，回 JSON-RPC error | `{ code: -32601, message: 'method not supported by marshal' }` |

`availableDecisions` 是数组，元素可能是字符串或对象（`{ acceptWithExecpolicyAmendment: ... }`）。v1 只呈现四个字符串决策：`accept`、`acceptForSession`、`decline`、`cancel`；对象型决策不呈现，避免让远端触发本机策略修改。

`itemId` 用作 `agentRequestId`；`requestId` 由 node 生成 `a-<uuid>`，与 DSH 的 `q-<uuid>` 区分。

### 4.7 设置

| 字段 | 调用 | 回读 |
|---|---|---|
| `model` | `thread/settings/update { threadId, model }` | `thread/settings/updated` 的 `threadSettings.model` |
| `reasoning` | 同上 `{ effort }` | `threadSettings.effort` |
| `permission` | 同上 `{ approvalPolicy, sandboxPolicy }` 或 `{ permissions }` | `threadSettings.approvalPolicy` / `sandboxPolicy` |
| `plan` | 同上 `{ collaborationMode }` | `threadSettings.collaborationMode` |
| `goal` | `thread/goal/set { threadId, objective, status, tokenBudget }`；`thread/goal/get` 回读 | `goal` 对象 |

- 运行中改回合：`turn/settings/update { threadId, turnId, model?, effort? }`；只支持 `model`/`effort`/`summary`/`approvalsReviewer`。v1 不主动用，避免"回合中途换模型"带来的不可预期；页面控件作用域写的是"下一回合"。
- `thread/queue/*` 不暴露。运行中收到 `prompt` 且 `mode` 不是 `steer` → `writer-busy`。
- `turn/steer` 需要 `expectedTurnId`；拿不到当前活跃 turn 时返回 `writer-busy`，不猜。

## 5. Claude 子系统

### 5.1 进程模型

每个活跃会话一个 `Query`：

```ts
const q = query({
  prompt: input,                    // AsyncIterable<SDKUserMessage>，流式输入模式
  options: {
    resume: sessionId,              // 新会话时省略
    cwd,
    includePartialMessages: true,
    permissionMode,
    model,
    effort,
    canUseTool,
    onElicitation,
    // v1 不声明 onUserDialog / supportedDialogKinds
  },
})
```

- 流式输入模式是 `setModel()` / `setPermissionMode()` / `interrupt()` 的前提；否则这些方法不可用。
- 空闲 10 分钟：`q.close()`；下一次提示词重新 `query({ resume })`。
- 一个会话同时最多一个活跃回合；回合进行中再发 `prompt`：
  - 显式 `mode: 'steer'` → 向 `input` 可迭代对象推一条消息（SDK 会把它并入当前上下文）；
  - 否则 `writer-busy`。
- 进程退出（正常或异常）→ 该会话的待答审批全部 `cancelled`，`turn.completed` 以 `status: 'failed'` 收尾。

### 5.2 发现与历史

- `listSessions({ limit: 100 })` 返回 `SDKSessionInfo[]`：`sessionId`、`summary`、`lastModified`、`cwd`、`gitBranch`、`createdAt`、`fileSize`。
- `getSessionInfo(sessionId)` 取单项；`getSessionMessages(sessionId, { limit })` 回填最近消息。
- 不直接解析 `~/.claude/projects/**/*.jsonl`：格式属于实现细节；SDK 已提供读写接口。
- 标题：`customTitle ?? summary ?? firstPrompt ?? 短 id`。`renameSession` 只在用户显式改名时调用。

### 5.3 事件映射

| SDK 消息 | marshal 事件 | 载荷 |
|---|---|---|
| `system/init` | `session.updated` + `capability.changed` | 会话 id、model、permissionMode、tools |
| `stream_event` `content_block_start`（`tool_use`） | `tool.started` | `{ callId: block.id, name: block.name }` |
| `stream_event` `content_block_delta` `text_delta` | `message.delta` | `{ text }` |
| `stream_event` `content_block_delta` `thinking_delta` | `reasoning.delta` | `{ text }` |
| `stream_event` `content_block_delta` `input_json_delta` | `tool.output` | `{ callId, argsDelta, partial: true }` |
| `stream_event` `message_delta`（usage） | `session.updated` | `{ tokens }` |
| `assistant`（完整消息） | `message.completed` | `{ itemId, chars }`；`tool_use` 已发过的不重复 |
| `user`（`tool_result`） | `tool.completed` | `{ callId, isError }` |
| `result` | `turn.completed` | `{ subtype, isError, durationMs, usage }` |
| `system/session_state_changed` | `session.updated` | `{ running: state === 'running' }` |
| `system/compact_boundary` | `session.updated` | `{ compacted: true }` |
| `tool_progress` | `tool.output` | `{ callId, elapsedMs }` |
| `system/permission_denied` | `error` | `{ code: 'permission-denied', toolName }` |
| 其它 | 忽略并计数 | |

`stream_event` 的 `parent_tool_use_id` 非空表示子 agent 内部事件：v1 打标 `nested: true` 后照常发，页面折叠显示。

### 5.4 权限与提问

`canUseTool(toolName, input, options)` 是所有阻断式交互的入口：

```ts
const canUseTool: CanUseTool = async (toolName, input, options) => {
  if (toolName === 'AskUserQuestion') return askViaMarshal(input, options)
  return approveViaMarshal(toolName, input, options)
}
```

- 审批卡标题优先用 `options.title`，其次 `options.displayName`，最后 `` `${toolName}` ``；`options.description` 作为副标题；`options.blockedPath` 作为路径提示。
- 选项：允许 / 本会话允许（仅当 `options.suggestions` 非空）/ 拒绝 / 拒绝并中止。
- 返回 `{ behavior: 'allow', updatedPermissions: options.suggestions }` 只在用户选了"本会话允许"时。
- 超时：`{ behavior: 'deny', message: 'marshal: no answer within 60s' }`。
- `AskUserQuestion` 的 `input.questions` 映射成统一提问；回答用 `{ behavior: 'allow', updatedInput: { ...input, answers } }`。
- `onElicitation`：v1 只支持 `decline`；卡片是通知型，不提供接受按钮。URL 型 elicitation 需要打开浏览器，属于本机动作。

`onUserDialog` 不接：v1 的 `supportedDialogKinds` 为空，CLI 会走各自的 no-dialog 降级路径。接一个渲染不了全部 dialog 种类的宿主，会让 CLI 把对话框停在无人应答的状态。

### 5.5 设置

| 字段 | 调用 | 生效 | 回读 |
|---|---|---|---|
| `model` | `q.setModel(id)` 或下一次 `query({ model })` | immediate / next-turn | `system/init.model` 或 `ModelInfo` |
| `reasoning` | 无法热改；关闭 `q`，下一回合用新 `effort` 重建 | next-turn | 下一回合 `system/init` |
| `permission` | `q.setPermissionMode(mode)` | immediate | 下一次 `system/init` 或方法返回 |
| `plan` | `q.setPermissionMode('plan')` | immediate | 同上 |
| `goal` | 不支持 | — | `editable: false` |
| `skill` / `plugin` | 只读枚举 `.claude/skills` 与已安装插件 | — | `editable: false` |

`setPermissionMode` 的返回值是 `void`，没有回读载荷；v1 以"下一回合 `system/init.permissionMode`"作为最终回读，ack 里先返回 `readback: 'pending'`，等 init 到了再广播 `capability.changed`。这是 v1 唯一允许"延迟回读"的字段，页面显示"已请求，等待下一回合确认"。

## 6. 所有权与写者状态机

```
                 ┌──────────────┐
   discover ───▶ │  foreign-idle │
                 └──────┬───────┘
                        │ 第一条写指令
                        ▼
                 ┌──────────────┐   resume 失败   ┌───────────────┐
                 │   resuming    │ ─────────────▶ │ writer-busy   │
                 └──────┬───────┘                 └───────────────┘
                        │ 成功
                        ▼
                 ┌──────────────┐
                 │   ours-idle  │ ◀──── turn/completed ────┐
                 └──────┬───────┘                          │
                        │ turn/start | prompt             │
                        ▼                                  │
                 ┌──────────────┐   interrupt / steer      │
                 │  ours-running │ ────────────────────────┘
                 └──────────────┘
```

- 只有 `ours-*` 接受写、审批、改设置。
- `resuming` 期间第二条写指令直接 `writer-busy`（不排队）。
- `foreign-running` 不进入 `resuming`；直接 `writer-busy`，页面显示"该会话正在本机其它进程运行"。
- 状态变化发 `session.updated { running, ownership }`，页面据此禁用按钮。

## 7. 审批状态机与去重

```
open ──decide(remote)──▶ answered ──▶ input.resolved{outcome:'remote',by}
  │
  ├──timeout──▶ expired ──▶ 按拒绝回写 agent ──▶ input.resolved{outcome:'timeout'}
  ├──agent 退出──▶ cancelled ──▶ input.resolved{outcome:'cancelled'}
  └──serverRequest/resolved──▶ cancelled（agent 侧已被别处解决）
```

- **node 侧**：`pending: Map<requestId, { agentRequestId, sessionId, kind, resolve }>`；第一次 `settle` 生效并删除；第二次返回 `unknown`。
- **hub 侧**：`pending: Map<requestId, { device, sessionId, openedAt }>`，TTL 90 秒；同一 requestId 的 `decide` 只转发第一条，其余 `duplicate`。
- **双重去重的目的**：hub 防多设备重复点击，node 防重连后旧指令重放。
- 审批卡不进环形缓冲；重连后页面靠 `input.resolved` 清掉孤儿卡片，或 90 秒后自动置灰。

## 8. 时序

### 8.1 接管一个 Codex 会话并续跑

```
page ──POST /marshal/api/command{op:'resume'}──▶ hub
hub ──command──▶ node B
node ──thread/resume{threadId, excludeTurns:true}──▶ app-server
app-server ──result{model, reasoningEffort, ...}──▶ node
node ──capability.changed + 最近 20 条 item──▶ hub ──SSE──▶ page
page ──POST command{op:'prompt', args:{text, mode:'queue'}}──▶ hub
node ──turn/start{threadId, input:[{type:'text',text}]}──▶ app-server
app-server ──turn/started, item/*, deltas, turn/completed──▶ node ──event──▶ hub ──SSE──▶ page
```

### 8.2 远端审批

```
app-server ──item/commandExecution/requestApproval{id, params}──▶ node
node ──input.requested{requestId:'a-…', kind:'approval', approval:{...decisions}}──▶ hub ──SSE──▶ page
page ──POST command{op:'decide', args:{requestId, decision:'accept'}}──▶ hub
hub ──command──▶ node ──JSON-RPC response{decision:'accept'}──▶ app-server
node ──input.resolved{outcome:'remote', by:'A'}──▶ hub ──SSE──▶ 所有页面
```

超时：node 自己在 60 秒时回写 `decline`，再发 `input.resolved{outcome:'timeout'}`；不依赖 hub 或页面在线。

### 8.3 改模型并回读

```
page ──POST command{op:'configure', args:{field:'model', value:'<id>'}}──▶ hub ──▶ node
node ──thread/settings/update{threadId, model}──▶ app-server
app-server ──thread/settings/updated{threadSettings.model}──▶ node
node ──capability.changed{全量 tunables}──▶ hub ──SSE──▶ page
node ──ack{ok:true, result:{readback:'<agent 的实际值>'}}──▶ hub ──▶ page
```

若 10 秒内没有 `thread/settings/updated`：ack `ok:false, code:'readback-timeout'`；后续通知到了仍然广播。

### 8.4 Claude 回合与提问

```
page ──prompt──▶ node ──streamInput 推入一条 SDKUserMessage──▶ SDK CLI
SDK ──stream_event(text/thinking/tool_use)──▶ node ──event──▶ hub ──SSE──▶ page
SDK ──canUseTool('AskUserQuestion', {questions})──▶ node
node ──input.requested{kind:'question'}──▶ hub ──SSE──▶ page
page ──answer──▶ node ──canUseTool resolve({allow, updatedInput:{answers}})──▶ SDK
```

## 9. 版本兼容

| 面 | 探测 | 缺失时 |
|---|---|---|
| Codex 进程 | `--version`；`initialize` 成功 | agent 标记不可用，`reason: 'not-installed'` |
| Codex 方法 | 首次调用返回 `method not found` | 该能力关闭，写一条 `agent-warning`，不重试 |
| Codex 提问 | `initialize` 接受 `experimentalApi` 后是否收到 `requestUserInput` | `questions: false`，页面不显示提问控件 |
| Claude SDK | 包版本 + `supportedModels()` | 版本低于已知下限时只读 |
| Claude 能力 | `system/init.capabilities`、`canUseTool` 是否存在 | 对应控件关闭 |

能力摘要随 `hello` 与每次重启后的 `capability.changed` 更新。**hub 不缓存旧能力**：node 重连必须重发。

最低版本（v1 实现时写死并在 README 标注）：

- Codex app-server：0.153.x（本设计所依据的协议快照）。
- Claude Agent SDK：0.3.x；Claude Code CLI 2.1.x。

## 10. 错误码

v0 的码不变，v1 增加：

| 码 | 产生方 | 语义 | 客户端 |
|---|---|---|---|
| `agent-missing` | node | 没有该 agent 的适配器 | 隐藏入口 |
| `agent-version` | node | 版本低于下限 | 只读 + 提示 |
| `resume-failed` | node | 接管失败（非占用） | 显示分类，不重试 |
| `approval-disabled` | node | `approvalRelay` 不是 `remote` | 卡片只读 |
| `approval-expired` | node | 审批已超时 | 置灰 |
| `widen-rejected` | node | 试图放宽权限/强度 | 控件回弹到实际值 |
| `readback-mismatch` | node | 回读与请求不一致 | 显示实际值 + 警告 |
| `readback-timeout` | node | 10 秒内无确认 | 显示"确认中" |
| `duplicate` | hub | 同一 requestId 的第二次决定 | 忽略 |

所有错误仍走 `{ type:'error', code, message, detail? }`；`detail` 只放分类与键名，不放堆栈、路径、命令。

## 11. 非功能目标

| 项 | 目标 |
|---|---|
| Codex 事件延迟（同机） | < 200 ms 从通知到 WebSocket 写出 |
| 跨机端到端 | 局域网 < 500 ms；公网 < 2 s |
| Codex 进程内存 | 空载 < 200 MB（含 app-server） |
| Claude 进程 | 每活跃会话一个；空闲 10 分钟回收 |
| 会话清单 | 100 个会话内 1 秒返回；分页上限 50 |
| 审批超时 | 默认 60 s，可配 15–300 s |
| 重启恢复 | agent 崩溃后 30 s 内重新可列；退避封顶 30 s |
| hub 补看 | 15 分钟 / 2000 条 / 会话；内存 |
| 单帧 | ≤ 1 MB 出站；Codex 入站 ≤ 8 MB；超出截断并标记 |

## 12. 安全边界

- 审批是 v1 最高危的面：一个误点就是本机执行命令。因此：
  - 只有 `dashboardToken` owner 能看见与作答；
  - `approvalRelay` 默认 `remote`，但设备可设 `local-only` 一票关闭；
  - 永远不自动 `accept`；超时一律拒绝；
  - "本会话允许"要二次确认，且只使用 agent 提供的 suggestions；
  - `item/permissions/requestApproval` 永不远程放行；
  - 审批内容 4 KB 截断 + 模式脱敏 + 不落盘。
- Codex/Claude 子进程只用 stdio，不监听端口。
- 不写 agent 的全局配置；不读取凭据文件；不把 `env` 发给 hub。
- 审计只记 `(ts, device, agent, sessionId, requestId, op, decision)`，不含命令、路径、答案。

## 13. 关键决策（ADR）

**ADR-1 用 app-server / SDK，而不是解析磁盘会话文件。**
备选：直接 tail Codex 的 rollout JSONL 与 Claude 的 `projects/*.jsonl`。文件格式没有兼容承诺，工具调用与审批在文件里也没有稳定的语义。代价是绑定版本；用能力探测与"只实现子集"控制。
（DSH 已走 app-server 的同一条路：它自己的 Codex 子 agent 就是用 `app-server --stdio`。）

**ADR-2 node 一个 app-server，Claude 一个会话一个 Query。**
Codex 的 app-server 天生多 thread、有会话索引；Claude 的 SDK 是"一次 query 一个会话"，长连接靠流式输入维持。顺着各自的模型走，不强行统一进程拓扑。

**ADR-3 不接管 `foreign-running`。**
跨进程判定不可靠，抢占会损坏本机正在进行的会话。宁可 `writer-busy`。

**ADR-4 超时按拒绝，不按中止。**
`cancel` 会打断回合，影响面比"跳过这一步"大。远端沉默时应选影响最小的保守动作。

**ADR-5 只改会话级设置，不写全局配置。**
远端改全局会让本机后续所有新会话受影响，因果链在用户视角里断了。

**ADR-6 回读由 agent 确认驱动，不做乐观更新。**
乐观值会让页面在失败时显示一个从未生效的设置，比慢半秒更糟。

**ADR-7 不暴露 Codex 原生队列。**
`thread/queue/add` 存在，但"排队等空闲再执行"正是 v0 ADR-4 否决的隐式延迟。运行中只支持用户显式 `steer`。

**ADR-8 审批复用 `input.requested`，不新增事件种类。**
页面、relay、缓冲都只需要处理"一种需要人决策的卡片"；载荷判别比并行两套事件简单。`decide` 单独成 op 是为了审计可读。

## 14. 为 v2+ 预留

- `agents/registry.ts` 按 `probe()` 装配，新增 Hermes/OpenClaw 只需实现 `AgentAdapter`；hub 与页面不动。
- `tunables/catalog.ts` 是数据，不是行为分支；新字段只加数据与转移表。
- 审批载荷的 `action` 是字符串，新增动作不需要升版本。
- 环形缓冲的接口按"事件流"设计，v3 若要做持久化回放，只替换实现。
