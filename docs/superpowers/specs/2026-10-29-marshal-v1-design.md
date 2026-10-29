# dsh-marshal v1 设计

日期：2026-10-29
上游：[总体设计](2026-10-29-marshal-design.md) · [v0 架构](2026-10-29-marshal-architecture.md) · [v1 架构](2026-10-29-marshal-v1-architecture.md)
范围：多 agent 适配（Codex、Claude Code）与"远程改设置"的正式开放

## 1. v1 要回答的问题

v0 只证明了一件事：DSH 的会话可以跨机器看、跨机器写。v1 要证明同一套 hub、线协议和页面能管**不是 DSH 的 agent**，并且把"能看"变成"能改"。

三条硬要求：

1. **真流**：思考、正文、工具输出来自 agent 自己的流式事件，不是定时抓快照拼出来的。停顿时页面就是停，不能有假增量。
2. **真续跑**：关掉页面、换台设备回来，从 agent 自己的会话恢复，不复制上下文、不新建影子会话。
3. **真审批**：agent 阻塞等批准时，远端看到同一份选项，能在超时前作答；超时按保守方向收场，绝不自动批准。

v1 之后，"marshal 能管什么 agent"不再由 DSH 决定，而由适配器清单决定。

## 2. 范围

### 2.1 新增

| 项 | 内容 |
|---|---|
| Codex 适配器 | `codex app-server`（JSON-RPC over stdio）：清单、历史、真流、续跑、`turn/steer`、打断、审批、下一回合设置 |
| Claude Code 适配器 | Claude Agent SDK（`query()` + 流式输入）：清单、历史、真流、`resume`、打断、`canUseTool` 审批、`AskUserQuestion` |
| 审批中继 | Codex 的 `item/*/requestApproval`、`mcpServer/elicitation/request`；Claude 的 `canUseTool`、`onElicitation` |
| 设置切换 | `model`、`reasoning`、`permission`、`plan`、`goal` 五项；前四项在 Codex/Claude 上可改（DSH 顺延到 v1.1），`goal` 仅 Codex |
| 设置回读 | 切换后等 agent 自己确认，再用确认值刷新 UI；不回显请求值 |
| 补看缓冲 | hub 内存里每会话 15 分钟事件，迟到的页面能补最近一段 |
| 页面控制条 | 模型/强度/权限/计划/目标五个控件 + 审批卡 + 只读能力表 |

### 2.2 不做

- Hermes、OpenClaw、Qoder 适配器（v2）。
- 移动端 App；页面继续走浏览器（桌面与手机浏览器同一 URL）。
- 多用户、角色、共享看板（v3）。
- 跨机排队：写者不空闲就失败，不做"等它闲下来再发"。
- 远端启停 skill/plugin。
- 远端放宽权限、放宽思考强度。
- 写 agent 的全局配置（`config.toml`、`settings.json`、`~/.claude` 下的任何文件）。

### 2.3 对总体设计的一处收窄

[总体设计](2026-10-29-marshal-design.md) §15 现在把 v1 定义为"Codex/Claude 五项可改"，DSH 的设置切换顺延到 v1.1。v1 本身仍然是五项：

- `skill` 与 `plugin` 是**宿主级**开关，改了会影响本机其它会话，而且 DSH 侧没有已核实的"运行中启停"接口。远端只提供**清单与状态**，开关必须在本机做，做完由回读刷新。
- 远端禁用 marshal 自身会切断唯一的远程通道，属于硬规则禁止项。把它做成可远程操作的按钮没有意义。

这条收窄是刻意的，v2 若拿到可靠的宿主级接口再放开。

## 3. 能力矩阵

| 能力 | DSH | Codex | Claude Code |
|---|---|---|---|
| 观察 | 原生跟随流 | app-server 通知（delta + item + turn） | SDK 流式事件（`includePartialMessages`） |
| 写入 | `sessionController.prompt` | `turn/start`；运行中可 `turn/steer` | 流式输入追加消息；运行中 `interrupt()` |
| 续跑 | `sessionController.follow` | `thread/resume` | `query({ resume })` |
| 历史回填 | 跟随快照 + 记录 | `thread/read` + `thread/turns/list` | `getSessionMessages` |
| 审批 | 无（审批类请求 v3） | `item/*/requestApproval`、`mcpServer/elicitation/request` | `canUseTool`、`onElicitation` |
| 提问 | `user-questions/request`（waterfall 认领） | `item/tool/requestUserInput` | `canUseTool` 里的 `AskUserQuestion` |
| 模型 | 会话级选择 | 会话级 + 下一回合 | `setModel()` / 下一回合 |
| 思考强度 | 会话级 | `effort` | `effort`（需新回合） |
| 权限 | 会话预设 | `approvalPolicy` + `sandboxPolicy` / permissions profile | `permissionMode` |
| 计划模式 | 会话级 | `collaborationMode` | `permissionMode: 'plan'` |
| 目标 | 会话级 | `thread/goal/*` | 无原生等价物 |
| 进程归属 | 与 DSH 同进程 | 本机一个 app-server 子进程 | 每个活跃会话一个 SDK 子进程 |

**进程归属决定写者规则**：只有由本 node 启动或恢复的会话（`ours`）才接受写指令。别的进程正在跑的会话，marshal 只能看历史，不能抢。

## 4. 会话身份与所有权

### 4.1 身份

会话键是 `(device, agent, sessionId)`：

- DSH：`sessionController` 的 `sessionId`。
- Codex：thread id（UUIDv7）。
- Claude：session UUID。

`agent` 是字符串，不是枚举；新增 agent 不升协议版本。

### 4.2 三种所有权

| 状态 | 判定 | 允许 |
|---|---|---|
| `ours` | 本 node 启动、恢复或正在跟随 | 读、写、审批、改设置 |
| `foreign-idle` | 磁盘/索引里有，但没有活跃写者 | 读历史；收到写指令时先尝试接管 |
| `foreign-running` | 另一个进程持有该会话 | 只读；写指令直接 `writer-busy` |

判定方式按 agent 不同：

- Codex：`thread/list` 给出 `canAcceptDirectInput` 与 `thread/status`；`thread/status/changed` 只在自有进程内可靠，跨进程以 `thread/resume` 的实际结果为准。
- Claude：SDK 无法附着到 TUI 进程。索引里存在、但本 node 没有活跃 `Query` 的会话，一律视为 `foreign-idle`；`resume` 失败即 `writer-busy`。

### 4.3 接管

`foreign-idle` 收到第一条写指令时执行接管：

1. 建 `owned` 会话（Codex `thread/resume`；Claude `query({ resume })`）。
2. 成功：执行原指令，全部后续事件归本 node。
3. 失败且错误表明会话活跃/被占用：返回 `writer-busy`，不改状态，不重试。
4. 失败且错误是别的类型：返回 `resume-failed`，附脱敏后的错误分类，不附堆栈。

**不做抢占**。不知道对面进程在做什么时，抢过来比失败更危险。

### 4.4 分叉

`create` 指令支持 `forkFrom`：

- Codex `thread/fork`；Claude `query({ resume, forkSession: true })`。
- 必须由用户显式点"另起一支"，且新会话标题带 `fork of <短 id>`。
- 续跑永不隐式 fork：隐式 fork 会让两台设备各自续写，最后谁都不是"权威副本"。

## 5. 事件与指令的扩展

v0 的 14 个事件种类和 7 个指令操作保持不变。v1 只做**载荷扩展**与**一个新操作**，不升协议版本。

### 5.1 审批复用 `input.requested`

审批和提问在页面上是同一种东西：一张必须由人做决定的卡片。因此不为审批新增事件种类，而是在载荷里加判别字段。

```ts
type InputRequested = {
  requestId: string
  kind: 'question' | 'approval'
  questions?: {
    id: string
    header: string
    question: string
    options?: { label: string; description?: string }[]
    multiSelect?: boolean
    secret?: boolean
  }[]
  approval?: {
    action: 'command' | 'file-change' | 'permissions' | 'user-input' | 'elicitation'
    title: string
    detail?: string
    decisions: { id: string; label: string; hint?: string }[]
    risk?: 'low' | 'medium' | 'high'
    agentRequestId: string
    expiresAt?: string
  }
}

type InputResolved = {
  requestId: string
  kind: 'question' | 'approval'
  outcome: 'remote' | 'timeout' | 'cancelled' | 'local'
  by?: string        // 设备名，仅远程作答时出现
}
```

`agentRequestId` 是 agent 自己的请求标识（Codex 的 JSON-RPC id、Claude 的 `toolUseID`）。它只用于本机回写，不参与 hub 去重。

### 5.2 新指令 `decide`

`COMMAND_OPS` 增加 `'decide'`：

```ts
{ op: 'decide', target, args: { requestId: string, decision: string } }
```

`answer` 继续只用于提问，载荷是 `{ requestId, answers }`。分开的理由：

- 审批的取值是 agent 定义的集合（`accept` / `acceptForSession` / `decline` / `cancel`），提问的取值是用户选项。混在一个 op 里会让审计日志读不出意图。
- 两者的超时收场不同（拒绝 vs 无回答），代码路径也不该合并。

### 5.3 设置回读走 `capability.changed`

```ts
type CapabilityChanged = {
  sessionId?: string
  tunables: Tunable[]      // 全量快照，不是增量
  readbackAt: string
}
```

`Tunable` 在 v0 的形状上补三个字段：

```ts
interface Tunable {
  id: 'model' | 'reasoning' | 'permission' | 'plan' | 'goal' | 'skill' | 'plugin'
  scope: 'next-turn' | 'next-session' | 'host'
  effect: 'immediate' | 'needs-restart' | 'next-session'
  values?: { id: string; label: string }[]
  current?: unknown
  direction?: 'tighten-only'
  editable: boolean          // v1：DSH 全部、skill/plugin、Claude 的 goal 为 false
  reason?: string            // editable 为 false 时给页面看的一句话
}
```

全量快照的理由：增量在丢帧/重连后无法自愈；五项数据的体积可以忽略。

### 5.4 `hello` 带上能力摘要

node 上线时在 `hello` 里附 `agents` 与每个 agent 的探测结果（版本、支持的操作、不可用原因）。hub 只渲染 `capabilities()` 报告的控件，避免"有按钮但点了报 unsupported"。

## 6. 审批语义

### 6.1 三个继电器档位

配置 `approvalRelay`（v0 只解析，v1 生效）：

| 值 | 行为 |
|---|---|
| `remote`（默认） | 发 `input.requested`，等远端决定；超时按拒绝收场 |
| `notify-only` | 发 `input.requested` 但 `decisions` 为空；远端只能看，不能答；本机自行处理 |
| `local-only` | 不发审批帧；本机按 agent 默认策略处理 |

`notify-only` 与 `local-only` 的差别是可见性：前者让远端知道"它卡住了"，后者连这个都不说。

### 6.2 决策映射

**Codex**

| 页面选项 | `decision` | 语义 |
|---|---|---|
| 允许 | `accept` | 只放行这一次 |
| 本会话允许 | `acceptForSession` | agent 自己的会话级缓存 |
| 拒绝 | `decline` | 跳过该动作，回合继续 |
| 拒绝并中止 | `cancel` | 跳过并打断当前回合 |

只提供 agent 在 `availableDecisions` 里给出的选项；没给就不显示。`item/permissions/requestApproval` 默认回 `{ permissions: {}, scope: 'turn' }`（不额外授权）；`mcpServer/elicitation/request` 默认 `decline`。

**Claude**

| 页面选项 | `PermissionResult` |
|---|---|
| 允许 | `{ behavior: 'allow' }` |
| 本会话允许 | `{ behavior: 'allow', updatedPermissions: suggestions }`，仅当用户在页面上明确选了这一项 |
| 拒绝 | `{ behavior: 'deny', message: 'declined by <device>' }` |
| 拒绝并中止 | `{ behavior: 'deny', message: ..., interrupt: true }` |

`updatedPermissions` 只来自 SDK 给的 `suggestions`，不自行拼规则。选择"本会话允许"要二次确认，因为它会改变后续所有同类请求。

### 6.3 超时

- 默认 `approvalTimeoutMs = 60_000`，设备级可配。
- 超时一律按**拒绝**收场：Codex `decline`，Claude `deny`。
- 超时后广播 `input.resolved { outcome: 'timeout' }`，页面把卡片置灰并显示"已按拒绝处理"。
- `cancel` 只能由人点，超时不做"中止回合"这种更重的动作。

### 6.4 去重与顺序

- node 侧：`requestId` 在待答表里，第一次 `settle` 生效，第二次返回 `unknown`。
- hub 侧：同一 `requestId` 的 `decide` 只转发第一条，其余返回 `duplicate`。
- 远端多设备同时作答：先到先得；后到的设备收到 `input.resolved { by: <先答设备> }`。
- 页面不改写已解决的卡片；`input.resolved` 晚到也只会让它从"等待"变成"已处理"。

### 6.5 谁能答

- 只有持有 `dashboardToken` 的 owner 能发 `decide`。
- 设备侧 `approvalRelay` 必须为 `remote`；否则 node 拒绝该指令，返回 `approval-disabled`。
- 审计：`~/.dsh-marshal/audit.jsonl` 记 `ts`、`device`、`agent`、`sessionId`、`requestId`、`decision`。**不记命令原文与文件路径**。

## 7. 提问语义

### 7.1 归一化

三个 agent 的提问统一成 `questions[]`：

- DSH：`user-questions/request` 的 `questions` 原样。
- Codex：`item/tool/requestUserInput` 的 `questions` 映射为 `{ id, header, question, options }`。
- Claude：`canUseTool('AskUserQuestion', input)` 里的 `questions` 映射；`multiSelect` 保留。

答案统一成 `{ answers: [{ id, selected: string[] }] }`（v0 的形状），再由适配器转回各 agent 的原生格式。

### 7.2 超时

| agent | 无人回答时 |
|---|---|
| DSH | `next()` 交回本地 UI（v0 语义，v1 不变） |
| Codex | 回 `{ answers: {} }`，由 Codex 自己走"无回答"路径 |
| Claude | `{ behavior: 'deny', message: 'no answer within Ns' }` |

Codex/Claude 没有"本地 UI 可以接回"这回事——它们的进程由 marshal 独占。因此超时必须是终态，不能挂着等。

### 7.3 secret

`isSecret` / `secret` 的提问：

- 页面用密码框，值不回显。
- `input.resolved` 只发 `{ requestId, outcome }`，不带答案。
- 事件与审计都不落答案。

## 8. 设置语义

### 8.1 五项的能力与作用域

| 字段 | DSH | Codex | Claude | 作用域 | 生效 | 方向 |
|---|---|---|---|---|---|---|
| `model` | 会话级 | `thread/settings/update` / 回合参数 | `setModel()` | next-turn | immediate | 双向 |
| `reasoning` | 会话级 | `effort` | `effort`（新 Query） | next-turn | immediate / next-turn | 只降 |
| `permission` | 会话预设 | `approvalPolicy` + `sandboxPolicy` | `permissionMode` | next-turn | immediate | 只收紧 |
| `plan` | 会话级 | `collaborationMode` | `permissionMode: 'plan'` | next-turn | immediate | 双向 |
| `goal` | 会话级 | `thread/goal/set`、`get`、`clear` | 不支持 | next-turn | immediate | 双向 |
| `skill` | 只读清单 | `skills/list` | `.claude/skills` 只读 | host | — | 不可改 |
| `plugin` | 只读清单 | `plugin/list` | 只读 | host | — | 不可改 |

> DSH 这一列在 v1 里仍然全部只读：v0 只做"认出字段 + 拒绝放宽"，真正的切换与回读排在 v1.1。表中 DSH 的 `会话级` 描述的是目标语义，不是 v1 的交付物。

### 8.2 只收紧怎么判

权限不是一个数字，但可以排成偏序。**只允许沿偏序向下**：

**Codex**（`sandboxPolicy` + `approvalPolicy` 组合）

```
unrestricted = danger-full-access + approvalPolicy:never
workspace    = workspace-write + approvalPolicy:on-request
readonly     = read-only + approvalPolicy:on-request|untrusted
```

只允许 `unrestricted → workspace → readonly`，反向与跨级跳跃都拒绝。

**Claude**

```
bypassPermissions → acceptEdits → default → dontAsk → plan
```

只允许沿箭头向右。`auto` 是分类器模式，不参与排序；从 `auto` 只能去 `default`、`dontAsk`、`plan`，不能去 `bypassPermissions` 或 `acceptEdits`。

**未知取值不比较**：返回 `widen-rejected`，附当前值与可用值，不改。

### 8.3 思考强度

- 只允许降低。等级顺序优先用 agent 自己给的目录（Codex `model.supportedReasoningEfforts` 的顺序、Claude `ModelInfo.supportedEffortLevels` 的顺序），没有目录时用 `low < medium < high < xhigh < max`。
- 提高强度会让远端把本机的成本曲线改陡，必须本机操作。

### 8.4 回读协议

一次 `configure` 的完整路径：

```
node 收到 configure
  → 适配器调用 agent 原生改设置接口
  → 等 agent 自己的确认（Codex thread/settings/updated；Claude setModel/setPermissionMode 返回；DSH 的回读）
  → 用确认值构造 capability.changed 广播
  → ack 里带 readback
```

规则：

- ack 里的 `readback` 必须来自 agent，不是把请求值原样返回。
- 若回读值与请求值不一致：ack `ok: false, code: 'readback-mismatch'`，附两边值，**不回滚**。回滚可能把已经收紧的设置放宽，方向错了。
- 若 agent 在 10 秒内没有给出确认：`ok: false, code: 'readback-timeout'`；后台继续等，一旦确认仍广播 `capability.changed`。

### 8.5 不写全局配置

v1 只改**会话级**状态：

- Codex：`thread/settings/update`、回合参数，不写 `config.toml`。
- Claude：`setModel` / `setPermissionMode`，不写 `settings.json`。
- DSH：只走会话控制器，不改 profile。

理由：远端改全局配置会让本机下一次新开的会话也变，用户看不到因果关系。v1 的承诺是"改这个会话的下一次回合"，不是"改这台机器"。

## 9. 隐私

### 9.1 默认仍是元数据

设备默认 `privacy: metadata`：

- 流事件只发字符数、工具名、参数键名、状态，不发正文与输出。
- 历史回填只发标题、时间、工具名、计数。
- 看板显示"（思考 812 字）""（输出 3.2 KB）"，点开是空的。

### 9.2 审批与提问是受限例外

审批要能作答，就必须给内容：命令、目标路径、问题文本。这是"最小必要披露"，不是把 metadata 档偷偷升成 content：

- 审批帧的 `detail` 上限 4 KB，超出截断并标记 `truncated: true`。
- 已知敏感模式（令牌、私钥头、连接串里的口令）在出站前替换为 `***`。
- 审批帧只发给 owner；不进环形缓冲，不落盘。
- 不接受披露就设 `approvalRelay: local-only`，代价是远端看不到卡点。

提问同理：文本要给，答案不回传。

### 9.3 补看缓冲

- 每会话 15 分钟，内存环形，容量按事件数封顶（默认 2000 条）。
- `privacy: metadata` 下缓冲里也只有元数据。
- 进程退出即丢失，不落盘。

## 10. 失效与降级

| 场景 | 行为 | 页面 |
|---|---|---|
| 本机没装 agent | agent 不出现在 `hello.agents`；其余 agent 正常 | 不显示该 agent |
| agent 版本过低/方法缺失 | 启动探测标记能力缺失，`capabilities()` 返回 `observe: 'none'` 或去掉对应控件 | 控件置灰，附原因 |
| agent 进程崩溃 | node 保持在线；该 agent 的会话标记断开；退避重启（1s→30s，5 次/分钟封顶） | 会话卡片显示"适配器重启中" |
| 崩溃时有待答审批 | 全部 `input.resolved { outcome: 'cancelled' }` | 卡片置灰 |
| 会话被别的进程持有 | `writer-busy`，不重试 | "该会话正在本机其它进程运行" |
| 审批超时 | 按拒绝收场 | "已按拒绝处理" |
| 回读不一致 | `readback-mismatch`，保留 agent 的实际值 | 控件显示实际值 + 一行警告 |
| hub 断线 | node 缓冲 1000 条；重连后补发并带 `dropped` 计数 | 顶部"已重连，丢弃 N 条" |
| 页面迟到 | 从环形缓冲补最近 15 分钟 | 无需手动刷新 |

**一个 agent 失败不影响其它 agent**：每个适配器独立启动、独立重启、独立上报健康。

## 11. 验收

在两台目标机器上执行（A=hub，B=node）：

1. **Codex 真流**：B 上启动一个 Codex 会话并让它跑命令；A 的页面在 2 秒内出现思考、命令卡片与输出增量；B 本机界面与 A 的顺序一致。
2. **Codex 审批**：B 的 Codex 请求执行命令；A 在 60 秒内点"允许"，B 的回合继续；再触发一次，A 不操作，60 秒后 B 收到拒绝且回合继续（不是中止），A 的卡片显示"已按拒绝处理"。
3. **Claude 续跑**：A 打开 B 上一个已存在的 Claude 会话，看到历史摘要；发一条新提示词，B 的新进程 `resume` 同一 session id，A 看到流式回复。
4. **Claude 提问**：B 的 Claude 调 `AskUserQuestion`；A 作答后 B 继续；超时按拒绝收场。
5. **设置回读**：A 把 B 上 Codex 会话的模型与强度改低，`capability.changed` 的值与 B 本机读到的值一致；A 尝试把权限改宽，收到 `widen-rejected`，值不变。
6. **崩溃隔离**：在 B 上杀掉 Codex 子进程；node 仍在线，Claude 会话不受影响，60 秒内 Codex 会话重新可列。
7. **隐私**：`privacy: metadata` 下，A 看不到任何正文与命令输出，只能看到计数与工具名；审批卡仍能看到命令（受限例外）。
8. **v0 回归**：v0 的五条验收全部仍然通过。

测试与验收在你自己的 checkout、CI 或两台目标机器上执行；本文档不假定任何开发工作站的路径、内网地址或已有运行状态。

## 12. 风险与未决

| 风险 | 依据 | 处置 |
|---|---|---|
| Codex app-server 协议随版本变化 | 0.153.4 的协议有 155 个客户端方法、81 个通知；本项目只依赖其中约 25 个 | 只实现子集 + 启动探测；方法缺失降级，不猜 |
| 跨进程会话所有权无法可靠判定 | `thread/status` 只在自有进程内可靠 | 以 `thread/resume` 的实际结果为准；失败即 `writer-busy` |
| Claude SDK 的 `resume` 在会话正被 TUI 使用时可能失败 | SDK 文档未承诺跨进程附加 | 同 Codex：失败即 `writer-busy`，不重试 |
| 审批内容含敏感信息 | 命令、路径、diff 都可能带密钥 | 4 KB 截断 + 模式脱敏 + 只发 owner + 不落盘 |
| 远端审批被误点"本会话允许" | 会放宽后续所有同类请求 | 二次确认 + 审计 + 只有 SDK 给的 suggestions 才可作为授权集合 |
| 回读延迟导致 UI 抖动 | agent 确认可能晚于请求 | 10 秒超时后先报 `readback-timeout`，确认到了再刷新，不用乐观值 |
| Codex 原生队列与"不排队"原则冲突 | `thread/queue/add` 存在 | v1 不暴露队列；运行中只支持显式的 `steer` |
| Claude 每个活跃会话一个子进程 | 进程数随活跃会话增长 | 空闲 10 分钟关闭；重连时 `resume` |
| 页面控件与 agent 能力不同步 | 三个 agent 的五项能力不完全一致 | 控件由 `capability.changed` 的全量快照渲染，不由前端写死 |

## 13. 已定默认

- `approvalRelay: 'remote'`；`approvalTimeoutMs: 60000`；超时按拒绝。
- 权限与思考强度只收紧；模型、计划、目标双向。
- `skill` / `plugin` 只读；不做远端启停。
- 不写 agent 全局配置；只改会话级。
- Codex：一个 node 一个 app-server 子进程；不暴露原生队列。
- Claude：每个活跃会话一个 `Query`，空闲 10 分钟关闭；`effort` 变更走下一回合。
- hub 补看缓冲 15 分钟 / 2000 条；只在内存。
- 审批帧是 metadata 档的唯一内容例外；不接受就设 `local-only`。
