# Agent 协议、版本与能力 spike（V1-T00）

日期：2026-10-29（证据采集于 2026-10-31）
任务：[v1 计划 V1-T00](../plans/2026-10-29-marshal-v1.md) · 架构依据：[v1 架构 §2–§4](../specs/2026-10-29-marshal-v1-architecture.md)
状态：**静态证据报告。没有运行任何真实 agent，所有运行期行为均未验证。不得据此宣称 v1 已支持 Codex/Claude。**

采集方式：`npm view` / `npm pack` 到 `/tmp` 并解包读 `.d.ts`；GitHub 用 `git ls-remote` 定位 tag、`raw.githubusercontent.com` 读取 pin 到 commit 的生成 schema、`git clone --filter=blob:none --sparse` 读仓库源码。未执行 `codex`、`claude`、任何 agent CLI 或模型 API；未读取 `~/.claude`、`~/.codex` 内任何认证内容。

## 0. 固定版本清单

| 对象 | 固定版本 | 校验值 | 证据 URL |
|---|---|---|---|
| `@openai/codex`（npm） | `0.166.0` | tarball sha256 `67ee6f4069d9328956401f54ac202c20369233159058af9f4ec1af731b87f5b7` | https://registry.npmjs.org/@openai/codex/0.166.0 · tarball https://registry.npmjs.org/@openai/codex/-/codex-0.166.0.tgz |
| openai/codex 仓库 | tag `rust-v0.166.0` | annotated tag object `593389380740f7b4762771573c447ccfdc59742f`；解引用 commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`（2026-10-29 14:44:30 -0300） | https://github.com/openai/codex/tree/rust-v0.166.0 |
| `@anthropic-ai/claude-agent-sdk` | `0.3.316` | tarball sha256 `d0e613aeaa8d861dcaecfee281baa8998cb05a1a87407d080ccce941cbddca92`；npm integrity `sha512-mCMr0que5kIy80JslJub6WFDB2+GYRGWNeVgSZaBpkBwXrr4wnRMnnGHitkA2BEJ5QP5xWyc6YH/6do/edxCWg==` | https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.316 |
| `@anthropic-ai/claude-code` | `2.1.316` | tarball sha256 `0b23c8ff73a58c263e88aa740bd8647723141f70dad089df63061858e019c4c3`；npm integrity `sha512-i3BpzyDkcCPnsa0CSkWgxGPs7WMsyqDkxkqT0SDxyEC5XMIxEmcUmluWRHG9VSeBY8Vyv+l9X34JvJ/Bj54nBQ==` | https://registry.npmjs.org/@anthropic-ai/claude-code/2.1.316 |
| Claude CLI（SDK 0.3.316 内置清单） | `2.1.316` | SDK 包内 `manifest.json`：`version 2.1.316`、`commit cd7ceb459c6864567b16a11f60101b24421475c1`、`buildDate 2026-10-30T23:47:48Z`、各平台 `binary: "claude"` | 解包自 `@anthropic-ai/claude-agent-sdk@0.3.316` 的 `manifest.json`（无公开 URL；npm tarball 内文件） |
| 本机 Node / OS | Node `v22.22.0`；Linux `6.8.0-138-generic` `x86_64` | `node --version`；`uname -a`；`command -v codex claude` 均为空 | 本机观测；engines 来源见下 |

engines 与运行前提（包元数据原文）：

- `@anthropic-ai/claude-agent-sdk@0.3.316`：`"engines": {"node": ">=18.14.0"}`；peerDependencies `@anthropic-ai/sdk >=0.93.0`、`@modelcontextprotocol/sdk ^1.29.0`、`zod ^4.0.0`。
- `@anthropic-ai/claude-code@2.1.316`：`"engines": {"node": ">=22.0.0"}`；tarball 内只有 `bin/claude.exe`（500 字节占位）与 `cli-wrapper.cjs`，真正二进制来自平台包 `@anthropic-ai/claude-code-linux-x64@2.1.316`。
- 本项目 `package.json`：`"engines": {"node": ">=24"}`。**本机 Node 22.22.0 低于项目要求**，本机不是可用的目标运行环境，进一步支持"本机只做静态检查"的边界。
- 目标平台包存在但未下载/未执行：`@openai/codex@0.166.0-linux-x64`、`@anthropic-ai/claude-agent-sdk-linux-x64@0.3.316`。

启动参数证据来源（均 pin 到同一 commit）：

- `codex app-server` 子命令与 `--stdio` / `--listen`：https://raw.githubusercontent.com/openai/codex/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/cli/src/main.rs
- app-server 侧 `--listen` 默认值与传输协议：https://raw.githubusercontent.com/openai/codex/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server/src/main.rs
- schema 生成入口（`justfile`）：https://raw.githubusercontent.com/openai/codex/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/justfile
- 生成器分拆规则（`JSON_V1_ALLOWLIST` 等）：https://raw.githubusercontent.com/openai/codex/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-protocol/src/export.rs
- Claude 侧启动参数只有类型证据 `Options.pathToClaudeCodeExecutable`（npm tarball 内 `sdk.d.ts:2040`），子进程 argv 无公开 URL 可引。

类型来源判定：**`@anthropic-ai/claude-agent-sdk@0.3.316` 才是 Query/SDK 类型来源**。`@anthropic-ai/claude-code@2.1.316` 只发布 `sdk-tools.d.ts`（与 SDK 包内同名文件 sha256 完全相同：`e36072cc125f5215f3b02f1eb5977262bb418b9cdf005001a3ccafe6caaaac27`），没有 `query()`、`Options`、`SDKMessage`、`PermissionResult` 等类型。

版本证据的已知缺口：Codex app-server 在 0.166.0 的生成 schema 中**没有 `protocolVersion` 字段**（见 §3.1），Claude SDK 也无法从类型上证明其内置 CLI 与 `@anthropic-ai/claude-code` 同构建；这两点都需要目标机运行探测（§5）。

## 1. 总表

状态口径：**OK** = 有可复核的静态证据（类型/schema/源码/包元数据）；**UNKNOWN** = 只能靠真实运行证明，当前未验证；**BLOCKED** = 需要目标机二进制/真实样本，本机明确不可得。

| # | 条目 | 状态 | 证据（路径/URL/tag/类型名） | 目标机探测步骤 |
|---|---|---|---|---|
| 1 | Codex 精确版本与协议 schema 定位（V1-T00 复选框 1） | **OK** | npm `@openai/codex@0.166.0`；tag `rust-v0.166.0` → commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`；生成 schema 路径 `codex-rs/app-server-protocol/schema/json/{ClientRequest,ClientNotification,ServerRequest,ServerNotification,codex_app_server_protocol.schemas,codex_app_server_protocol.v2.schemas}.json` | `codex --version`，记录输出；与 `initialize` 响应的 `userAgent` 对照 |
| 2 | Claude SDK/CLI 精确版本与真实类型来源（复选框 1） | **OK** | SDK `0.3.316` 的 `sdk.d.ts`（10405 行）为类型来源；CLI 清单 `manifest.json` 声明 `2.1.316`；`claude-code@2.1.316` 无 SDK 类型 | `claude --version`；SDK `system/init` 的 `claude_code_version` 与之一致性 |
| 3 | 本机 Node/OS 与项目 engines | **OK** | Node `v22.22.0`、Linux 6.8 x86_64；项目 `>=24`，SDK `>=18.14`，CLI `>=22` | 目标机 `node --version`、`uname -a`；要求 Node ≥ 24 |
| 4 | Codex 启动参数（复选框 1） | **OK** | `codex app-server`（CLI 帮助自述 `[experimental] Run the app server or related tooling`，`codex-rs/cli/src/main.rs:173`）；`--stdio` 等价 `--listen stdio://`，支持 `stdio://|unix://|unix://PATH|ws://IP:PORT|off`（`codex-rs/cli/src/main.rs:591-602`；`codex-rs/app-server/src/main.rs:42-56`） | `codex app-server --help`；以 `codex app-server --stdio` 启动并记录 argv |
| 5 | Claude 子进程启动参数 | **UNKNOWN** | `Options.pathToClaudeCodeExecutable?: string`（`sdk.d.ts:2040`）证明可指定可执行文件；SDK 内部 spawn 的 argv 仅在压缩后的 `sdk.mjs` 中，未从类型/文档取证 | `strace -f -e execve node probe.mjs` 记录 SDK 实际 spawn 参数；同时记录 `system/init.claude_code_version` |
| 6 | 用目标二进制重新生成 Codex schema（复选框 2） | **BLOCKED** | 仓库有可复核的重新生成入口：`justfile` 的 `write-app-server-schema` → `app-server-protocol/scripts/write_schema_fixtures.py` → `cargo test -p codex-app-server-protocol --lib schema_fixtures_tests::write_schema_fixtures_from_env -- --exact --ignored`；本机未安装 codex 二进制，且未准备 Rust 构建环境（仅 sparse checkout 了源码） | 目标机在 `rust-v0.166.0` checkout 执行 `just write-app-server-schema`，与仓库内 `schema/json` 做 diff |
| 7 | Codex `initialize` / `initialized` 形状（复选框 2） | **OK** | `InitializeParams{clientInfo{name,version,title?},capabilities?}`；`InitializeResponse{userAgent,codexHome,platformFamily,platformOs}`；`initialized` 客户端通知无 params；重复 initialize 返回 `invalid_request: Already initialized`（`initialize_processor.rs:68-69,142`） | 发送 initialize → 读响应；再发一次确认错误码；随后发 `initialized` |
| 8 | Codex `thread/list` 只读分页（复选框 2） | **OK** | params：`cursor,limit,archived,cwd,excludedThreadIds,modelProviders,originators,searchTerm,sectionId,sortDirection,sortKey,sourceKinds,useStateDbOnly`；响应 `{data:Thread[],nextCursor,backwardsCursor}`；README 明确单页最多 100（`codex-rs/app-server/README.md:11-19`） | 以 `limit:50` 循环 `nextCursor` 到 null，再以 `limit:100` 复跑；对比总数 |
| 9 | Codex `thread/read`（复选框 2） | **OK** | `ThreadReadParams{threadId,includeTurns=false}` → `ThreadReadResponse{thread}`；schema 描述"全量 hydration 已弃用，改用 turns/items 分页" | 同一 threadId 分别用 `includeTurns:false/true`，记录 `turns` 与 `itemsView` |
| 10 | Codex `thread/turns/list` + `thread/items/list`（复选框 2） | **OK** | turns params `{threadId,cursor,limit,sortDirection,itemsView}` → `{data:Turn[],nextCursor,backwardsCursor}`；items params `{threadId,turnId,cursor,limit,sortDirection}` → `{data:ThreadItemEntry[],nextCursor}`；`Turn{id,items,status,startedAt,completedAt,error}` | 对一个多回合 thread 全量翻页，核对 turn 数与 item 数；验证 `itemsView` 三档 |
| 11 | Codex `thread/resume`（复选框 2） | **OK** | params `{threadId,model?,cwd?,approvalPolicy?,approvalsReviewer?,sandbox?,config?,baseInstructions?,developerInstructions?,excludeTurns?,modelProvider?,personality?,serviceTier?}`；响应含 `model,reasoningEffort,approvalPolicy,sandbox,approvalsReviewer,collaborationMode,activePermissionProfile`；schema 原文：若 thread 正在运行，app-server **rejoin** 该 thread（共享而非加锁） | 单 client resume 读回设置；再开第二个 app-server/TUI resume 同一 thread，观察是否都能 `turn/start` |
| 12 | Codex `turn/start` / `turn/steer` / `turn/interrupt`（复选框 2） | **OK** | `TurnStartParams{threadId,input:UserInput[],model?,effort?,approvalPolicy?,sandboxPolicy?,cwd?,clientUserMessageId?,…}` → `{turn}`；`TurnSteerParams{threadId,input,expectedTurnId}`（`expectedTurnId` 是"必须匹配当前 active turn"的前置条件）；`TurnInterruptParams{threadId,turnId}` | 启动一个 turn，记录 `turn.id`；用错误/正确 `expectedTurnId` 各试一次 steer；interrupt 后看 `turn/completed.status` |
| 13 | Codex 审批请求集合与决策枚举（复选框 6） | **OK** | server request 10 个：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`item/tool/call`、`account/chatgptAuthTokens/refresh`、`attestation/generate`、`applyPatchApproval`、`execCommandApproval`。command 决策：`accept|acceptForSession|acceptWithExecpolicyAmendment|applyNetworkPolicyAmendment|decline|cancel`；file 决策：`accept|acceptForSession|decline|cancel`。**0.166.0 的审批 params 没有 `availableDecisions` 字段** | 目标机触发命令/文件审批，记录请求全文；对每个决策值逐一试答，记录 agent 后续行为 |
| 14 | Codex `item/tool/requestUserInput`（复选框 2/6） | **OK**（仅形状） | params `{threadId,turnId,itemId,questions[{id,header,question,options?[{label,description}],isOther,isSecret}],isBlocking,autoResolutionMs?}`；响应 `{answers:{[questionId]:{answers:string[]}}}`；标注 EXPERIMENTAL | 触发一次提问，记录题目/选项；验证空 answers、未知 questionId、超时（不答）三种应答 |
| 15 | Codex 设置回读面（复选框 5/6） | **OK**（回读面存在；时机 UNKNOWN） | `ThreadSettings{model,modelProvider,approvalPolicy,approvalsReviewer,sandboxPolicy,effort,summary,collaborationMode,personality,cwd,serviceTier,disabledPluginIds,activePermissionProfile}`；通知 `thread/settings/updated{threadId,threadSettings}`；`thread/resume` 响应同名字段；`Thread.model/reasoningEffort`；`model/list` 返回 `Model.supportedReasoningEfforts/defaultReasoningEffort` | 每次 set 前后抓 `thread/settings/updated` 与 `thread/resume` 响应，记录首个可回读事件的时间点 |
| 16 | Codex goal 读/写/清（复选框 5） | **OK**（方法存在） | `thread/goal/get{threadId}` → `{goal:ThreadGoal\|null}`；`thread/goal/set`/`thread/goal/clear`；另有 `thread/goal/updated`/`cleared` 通知 | set 后立刻 get，再等通知；记录返回值与通知顺序 |
| 17 | Claude SDK 入口与控制方法（复选框 3） | **OK** | `query({prompt,options})`（`sdk.d.ts:3345`）；`Query extends AsyncGenerator<SDKMessage,void>`（2938）含 `interrupt/setPermissionMode/setModel/applyFlagSettings/initializationResult/streamInput/close/supportedModels`；`setPermissionMode`、`setModel`、`applyFlagSettings` 均返回 `Promise<void>` | 目标机以 streaming input 建 Query，逐个调用并记录返回值与随后消息 |
| 18 | Claude list/history 只读 API（复选框 3） | **OK** | `listSessions(ListSessionsOptions{dir?,limit?,offset?,includeWorktrees?,includeProgrammatic?,sessionStore?})` → `SDKSessionInfo[]`（`sessionId,summary,lastModified,customTitle?,firstPrompt?,cwd?,tag?,createdAt?`）；`getSessionMessages(id,{dir?,limit?,offset?,includeSystemMessages?})` → `SessionMessage{type,uuid,session_id,message:unknown,parent_tool_use_id,parent_agent_id}`；另有 `getSessionInfo/listSubagents/getSubagentMessages/forkSession/deleteSession/renameSession/tagSession` | 只读列目录+读一个会话；记录是否出现 `claude` 子进程 |
| 19 | Claude `SDKMessage` 联合（复选框 3） | **OK** | 39 个成员，含 `SDKSystemMessage`（`subtype:'init'`）、`SDKAssistantMessage`、`SDKUserMessage`/`SDKUserMessageReplay`、`SDKResultMessage`（success/error）、`SDKPartialAssistantMessage`、`SDKSessionStateChangedMessage`、`SDKPermissionDeniedMessage` 等（`sdk.d.ts:5604`） | 一次真实 Query 遍历，统计实际出现的成员与字段 |
| 20 | Claude init/result/assistant/state 形状（复选框 3） | **OK** | init：`model,permissionMode,effort?,capabilities?,claude_code_version,cwd,tools,mcp_servers,slash_commands,session_id`（`sdk.d.ts:6234-6310`）；result success/error：`subtype 'success'\|'error_during_execution'\|'error_max_turns'\|'error_max_budget_usd'\|'error_max_structured_output_retries'`，error 含 `permission_denials`；state：`session_state_changed{state:'idle'\|'running'\|'requires_action'}`（6184） | 记录首个 init、每个 result、state 切换；验证 `setModel` 后是否再出现 init/新 model 帧 |
| 21 | Claude `canUseTool` / `PermissionResult` / 权限模式（复选框 3/6） | **OK** | `CanUseTool(toolName,input,options{signal,suggestions?:PermissionUpdate[],toolUseID,requestId,decisionReason?,title?,defaultToNo?,suppressAlwaysAllowRule?,…}) => Promise<PermissionResult\|null>`（228）；`PermissionResult = {behavior:'allow';updatedInput?;updatedPermissions?} \| {behavior:'deny';message:string;interrupt?}`（2594）；`PermissionMode='default'\|'acceptEdits'\|'bypassPermissions'\|'plan'\|'dontAsk'\|'auto'`（2571）；`PermissionUpdateDestination='userSettings'\|'projectSettings'\|'localSettings'\|'session'\|'cliArg'`（2642） | 目标机构造 AskUserQuestion、普通工具、plan-review 三类审批，分别返回 allow/deny/null，记录 CLI 行为与 result |
| 22 | Claude 只读 API 不创建 Query（复选框 3） | **UNKNOWN** | 类型上 `listSessions/getSessionMessages` 不返回 `Query`，JSDoc 称读取 JSONL transcript（`sdk.d.ts:1138-1190,934-970`）；但"不 spawn CLI"只能运行证明 | `strace -f -e execve node probe.mjs`：仅调用 listSessions+getSessionMessages，断言无 `claude` execve |
| 23 | 两 agent 的跨进程控制边界（复选框 4） | **UNKNOWN** | 静态只得到否定线索：Codex `thread/resume` 对运行中 thread 是 rejoin（共享）；0.166.0 schema 无 `canAcceptDirectInput`；`ThreadStatus.activeFlags` 只有 `waitingOnApproval\|waitingOnUserInput`；Claude `SDKSessionInfo` 无 running/status 字段 | 目标机：本地 TUI 活跃时，另一 app-server resume 同 thread 并尝试 turn/start；Claude 侧 TUI 与第二个 Query 同时 resume 同一 session，记录双方错误/成功 |
| 24 | resume 成功 ≠ 排他（复选框 4） | **OK**（静态否定结论） | 同上：Codex schema 明说运行中 thread 会被 rejoin；Claude 会话列表不含 liveness，无法从 API 区分 foreign-idle / foreign-running | 与 #23 同一组实验，另记录 resume 后 `thread/status` 与实际并发写结果 |
| 25 | 模型/effort/权限/plan/goal 的实际回读来源与生效时机（复选框 5） | **UNKNOWN** | 回读面存在但时序未证：Codex 依赖 `thread/settings/updated`/resume 响应；Claude 只有 init 快照与 void setter，无 getter（`list_permission_rules` 仅内部 control subtype，未暴露为 Query 方法） | 每次 set 后轮询/抓通知，记录"首次反映新值"的帧类型与相对时间；重复 3 次看抖动 |
| 26 | 无答案/拒绝行为（复选框 6） | **UNKNOWN** | 静态只有语义描述：Codex `decline` = 拒绝但回合继续，`cancel` = 拒绝并立即中断回合（schema description）；`requestUserInput` 空答案/超时语义未写；Claude `PermissionResult` 允许返回 `null`，但 null 的 CLI 行为类型未定义 | 对每个审批/提问分别测：不答、空答案、deny、cancel、null，记录 turn 状态与后续消息 |
| 27 | 脱敏请求/响应/通知 fixture（复选框 2） | **BLOCKED** | `tests/fixtures/codex/README.md`、`tests/fixtures/claude/README.md` 均标记未采集；本机无二进制 | 目标机按 fixture README 的采集与脱敏规则生成，禁止手写 |
| 28 | 字段/方法缺失时的降级（复选框 7） | **OK** | 见 §6 降级表；缺失即关闭对应能力，不因方法名存在就 editable | 不适用（策略表）；实现后由 V1-T09 能力页用例验证 |

计数：**OK 21 条，UNKNOWN 5 条，BLOCKED 2 条**（合计 28）。

## 2. Claude 类型摘录（`@anthropic-ai/claude-agent-sdk@0.3.316` 的 `sdk.d.ts`）

仅摘必要字段，省略 JSDoc。

```ts
// 入口（:3345）
function query(p: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;

interface Query extends AsyncGenerator<SDKMessage, void> {          // :2938
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
  setPermissionMode(mode: PermissionMode): Promise<void>;           // 无返回值
  setModel(model?: string): Promise<void>;                          // 无返回值
  applyFlagSettings(settings: {...}): Promise<void>;                // 无返回值
  initializationResult(): Promise<SDKControlInitializeResponse>;    // models/commands/agents/account，无当前设置
  supportedModels(): Promise<ModelInfo[]>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  close(): void;
}

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'; // :2571

type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];      // 仅建议；不作为授权来源
  toolUseID: string; requestId: string;
  decisionReason?: string; defaultToNo?: boolean; suppressAlwaysAllowRule?: boolean;
  mcpServer?: { name: string; source: string };
}) => Promise<PermissionResult | null>;  // :228

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };      // :2594

type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'; // :2642

// 只读发现/历史（:1138, :934, :6138, :6809）
function listSessions(o?: { dir?: string; limit?: number; offset?: number;
  includeWorktrees?: boolean; includeProgrammatic?: boolean; sessionStore?: SessionStore }): Promise<SDKSessionInfo[]>;
function getSessionMessages(id: string, o?: { dir?: string; limit?: number; offset?: number;
  includeSystemMessages?: boolean; sessionStore?: SessionStore }): Promise<SessionMessage[]>;

type SDKSessionInfo = { sessionId: string; summary: string; lastModified: number;
  fileSize?: number; customTitle?: string; firstPrompt?: string; gitBranch?: string;
  cwd?: string; tag?: string; createdAt?: number };                  // 没有 running/status

type SessionMessage = { type: 'user' | 'assistant' | 'system'; uuid: string; session_id: string;
  message: unknown; parent_tool_use_id: string | null; parent_agent_id: string | null };

// system/init（:6234）
type SDKSystemMessage = { type: 'system'; subtype: 'init'; model: string;
  permissionMode: PermissionMode; effort?: 'low'|'medium'|'high'|'xhigh'|'max' | null;
  capabilities?: string[]; claude_code_version: string; cwd: string; tools: string[];
  slash_commands: string[]; mcp_servers: { name: string; status: string; source?: string }[];
  session_id: string; uuid: UUID };

// 回合/结果（:6025, :5958, :6184）
type SDKResultSuccess = { type: 'result'; subtype: 'success'; result: string; num_turns: number;
  stop_reason: string | null; total_cost_usd: number; modelUsage: Record<string, ModelUsage> };
type SDKResultError  = { type: 'result';
  subtype: 'error_during_execution'|'error_max_turns'|'error_max_budget_usd'|'error_max_structured_output_retries';
  errors: string[]; permission_denials: SDKPermissionDenial[] };
type SDKSessionStateChangedMessage = { type: 'system'; subtype: 'session_state_changed';
  state: 'idle' | 'running' | 'requires_action'; session_id: string };

// Options 关键项（:1581 起）
type Options = { resume?: string; forkSession?: boolean; sessionId?: string;
  permissionMode?: PermissionMode; canUseTool?: CanUseTool; effort?: EffortLevel;
  pathToClaudeCodeExecutable?: string; settingSources?: SettingSource[]; abortController?: AbortController };
```

`AskUserQuestion` 的输入 schema 在 `sdk-tools.d.ts:1139`（`questions[1..4]{question,header,options[2..4]{label,description,preview?},multiSelect}`，`options` 不含 "Other"，由 CLI 自动补）。

## 3. Codex 协议形状摘录（tag `rust-v0.166.0`，commit `6ff1e1c`）

证据：仓库内生成 schema（非手写）。根 bundle 83 个 definition、v2 bundle 677 个；`ClientRequest` 106 个方法、`ServerNotification` 85 个、`ServerRequest` 10 个、`ClientNotification` 1 个（`initialized`）。
生成器的分拆规则可从源码复核：`export.rs` 的 `JSON_V1_ALLOWLIST = ["InitializeParams","InitializeResponse"]`、`FLAT_V2_SHARED_DEFINITIONS = ["ClientRequest","ServerNotification"]`。因此 `InitializeResponse` 在根 bundle，而 thread/turn 类型在 v2 bundle，读 schema 时必须成对使用。

### 3.1 初始化

```jsonc
// client -> server (ClientRequest.json)
{"id":1,"method":"initialize","params":{
  "clientInfo":{"name":"dsh-marshal","version":"0.0.0","title":null},
  "capabilities":{"experimentalApi":false,"optOutNotificationMethods":null}}}
// server -> client (codex_app_server_protocol.schemas.json#InitializeResponse)
{"codexHome":"/…","platformFamily":"unix","platformOs":"linux","userAgent":"…/0.166.0 (…)"}
// 随后 client -> server，无 params
{"method":"initialized"}
```

`userAgent` 由 `get_codex_user_agent()` 拼接 `"{originator}/{version} (os; arch) …"`（`codex-rs/login/src/auth/default_client.rs:152-166`），可作为二进制版本旁证，但不是协议版本号。

### 3.2 只读分页与读取

```jsonc
// thread/list
{"id":2,"method":"thread/list","params":{"cursor":null,"limit":50,"archived":false,
  "sortKey":null,"sortDirection":null,"cwd":null,"searchTerm":null}}
// -> {data:[Thread…], nextCursor:"…"|null, backwardsCursor:"…"|null}

// thread/read（全量 hydration 已弃用）
{"id":3,"method":"thread/read","params":{"threadId":"…","includeTurns":false}}
// -> {thread:{id,status,model,reasoningEffort,cwd,updatedAt,turns:[…]}}

// thread/turns/list
{"id":4,"method":"thread/turns/list","params":{"threadId":"…","cursor":null,"limit":50,
  "sortDirection":null,"itemsView":"summary"}}
// thread/items/list
{"id":5,"method":"thread/items/list","params":{"threadId":"…","turnId":"…","cursor":null,"limit":50}}
```

### 3.3 取得写权后的 resume 与 turn

```jsonc
{"id":6,"method":"thread/resume","params":{"threadId":"…","excludeTurns":true,
  "model":null,"approvalPolicy":null,"sandbox":null}}
// -> {model,reasoningEffort,approvalPolicy,approvalsReviewer,sandbox,cwd,activePermissionProfile,…}

{"id":7,"method":"turn/start","params":{"threadId":"…","input":[{"type":"text","text":"…"}],
  "model":null,"effort":null,"approvalPolicy":null,"clientUserMessageId":null}}
// -> {turn:{id,status:"inProgress",items:[…]}}

{"id":8,"method":"turn/steer","params":{"threadId":"…","expectedTurnId":"…","input":[…]}}
{"id":9,"method":"turn/interrupt","params":{"threadId":"…","turnId":"…"}}
```

`TurnStatus = "completed"|"interrupted"|"failed"|"inProgress"`；`ThreadStatus = notLoaded|idle|systemError|active{activeFlags:[waitingOnApproval|waitingOnUserInput]}`。`ReasoningEffort` 在 0.166.0 是**非空字符串**（值由 `model/list` 的 `supportedReasoningEfforts` 给出），不是固定枚举。

### 3.4 审批与提问（server -> client request）

```jsonc
{"id":10,"method":"item/commandExecution/requestApproval","params":{
  "threadId":"…","turnId":"…","itemId":"…","startedAtMs":0,
  "command":"…","cwd":"…","reason":null,"approvalId":null,"kind":"command",
  "proposedExecpolicyAmendment":null,"proposedNetworkPolicyAmendments":null}}
// 应答：{"decision":"accept"|"acceptForSession"|{"acceptWithExecpolicyAmendment":{…}}
//        |{"applyNetworkPolicyAmendment":{…}}|"decline"|"cancel"}

{"id":11,"method":"item/fileChange/requestApproval","params":{
  "threadId":"…","turnId":"…","itemId":"…","startedAtMs":0,"reason":null,"grantRoot":null}}
// 应答：{"decision":"accept"|"acceptForSession"|"decline"|"cancel"}

{"id":12,"method":"item/tool/requestUserInput","params":{
  "threadId":"…","turnId":"…","itemId":"…","isBlocking":true,
  "questions":[{"id":"q1","header":"…","question":"…","isOther":false,"isSecret":false,
                "options":[{"label":"…","description":"…"}]}]}}
// 应答：{"answers":{"q1":{"answers":["…"]}}}

{"id":13,"method":"item/permissions/requestApproval","params":{
  "threadId":"…","turnId":"…","itemId":"…","cwd":"…","startedAtMs":0,"permissions":{…}}}
// 应答：{"permissions":{"fileSystem":null,"network":null},"scope":"turn"|"session"}

{"id":14,"method":"mcpServer/elicitation/request","params":{"mode":"form","message":"…","requestedSchema":{…}}}
// 应答：{"action":"accept"|"decline"|"cancel","content":…}
```

关键否定证据：**0.166.0 没有 `availableDecisions`**（旧版有）。客户端只能按自己的白名单与上述枚举求交集。

### 3.5 通知

| 通知 | 关键字段 |
|---|---|
| `turn/started`、`turn/completed` | `{threadId, turn}` |
| `item/started` | `{threadId,turnId,item,startedAtMs}` |
| `item/completed` | `{threadId,turnId,item,completedAtMs}` |
| `item/agentMessage/delta` | `{threadId,turnId,itemId,delta}` |
| `thread/status/changed` | `{threadId,status}` |
| `thread/settings/updated` | `{threadId,threadSettings}` |
| `serverRequest/resolved` | `{requestId,threadId}` |
| `thread/goal/updated`、`thread/goal/cleared` | goal 快照 |

### 3.6 settings / goal 回读面

`ThreadSettings` 必填：`approvalPolicy,approvalsReviewer,collaborationMode,cwd,model,modelProvider,sandboxPolicy`；可选：`effort,summary,personality,serviceTier,disabledPluginIds,activePermissionProfile`。
`thread/goal/get{threadId}` → `{goal:ThreadGoal|null}`；写用 `thread/goal/set`，清用 `thread/goal/clear`。
`model/list` → `{data:[Model…],nextCursor}`，`Model` 含 `supportedReasoningEfforts,defaultReasoningEffort,isDefault,hidden`。

### 3.7 0.166.0 中"不存在"的字段（同样是证据）

- 无 `protocolVersion`（全 schema 0 命中）。
- 无 `canAcceptDirectInput`（schema 与 app-server README 0 命中）。
- 无 `availableDecisions`。
- 因此架构 §4.2 提到的 `canAcceptDirectInput` 判断路径在目标版本**不可用**，只能依赖 `thread/status` + 实际并发写探测。

## 4. 审批、混合对象、suggestions 与无答案

### 4.1 可用决策集合

| agent/请求 | 原生可用 | 计划采用（保守子集） |
|---|---|---|
| Codex command | accept, acceptForSession, acceptWithExecpolicyAmendment, applyNetworkPolicyAmendment, decline, cancel | accept, decline, cancel（不写 session/execpolicy/network 持久授权） |
| Codex fileChange | accept, acceptForSession, decline, cancel | accept, decline, cancel |
| Codex permissions | `{permissions:{fileSystem?,network?}, scope:'turn'\|'session'}` | 空授权（不扩大 fileSystem/network），scope=turn |
| Codex elicitation | accept, decline, cancel | decline/cancel（不代用户填写表单） |
| Codex requestUserInput | `answers` map | 按问题策略回答；无答案时待探测（当前关闭"可答"能力） |
| Claude canUseTool | `{allow, updatedInput?}` / `{deny, message}` / `null` | allow（仅回填必要 updatedInput）/ deny（带 message）；从不返回 updatedPermissions |

### 4.2 混合对象决策

- Codex：决策是 `string | {tagged object}` 的联合，两个对象分支分别是 `{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":[...]}}` 与 `{"applyNetworkPolicyAmendment":{"network_policy_amendment":…}}`。**形状 OK；运行期是否接受、是否即时生效 UNKNOWN**（探测见 §5）。
- Claude：`PermissionResult` 以 `behavior` 判别；`PermissionUpdate` 以 `type` 判别（`addRules/replaceRules/removeRules/setMode/addDirectories/removeDirectories`）。形状 OK；`updatedInput` 是否被完整采纳 UNKNOWN。

### 4.3 suggestions destination

- Claude `PermissionUpdateDestination` 五值齐全：`userSettings`、`projectSettings`、`localSettings`、`session`、`cliArg`（`sdk.d.ts:2642`）。**OK**。
- 策略：`suggestions` 仅用于展示"本来可以持久允许"，**不作为授权来源**；应答永不返回 `updatedPermissions`，因此不会写到任何 destination。**OK（策略）**。
- 运行期：CLI 是否在缺省情况下自行持久化、以及 `session` 与 `cliArg` 的实际落盘差异，**UNKNOWN**。

### 4.4 无答案/拒绝行为

- Codex 静态语义（schema description）：`decline` = 拒绝，agent 继续该回合；`cancel` = 拒绝并立即中断回合。文件审批同义。**OK（仅语义）**。
- `requestUserInput` 的"空 answers / 不答 / 超时"没有任何 schema 说明；`autoResolutionMs` 已标 deprecated，`isBlocking` 才是现行语义。**UNKNOWN**。
- Claude `CanUseTool` 可返回 `null`，但类型未定义 null 的 CLI 行为；`deny` 必须带 `message`，`interrupt?: boolean` 可请求中断。**UNKNOWN**。
- 计划：在未证明前，一律返回显式 `deny`（带 message），不用 `null`，不静默挂起。

## 5. 目标机探测步骤（本机未执行）

通用要求：在目标机本地进行；只记录脱敏后的方法名/字段/ID 前缀；任何 token、cookie、账号、路径中的用户名必须剔除；不得把完整 `~/.claude`、`~/.codex` 内容写入仓库。

### 5.1 Codex

1. `codex --version`，记录完整输出与二进制路径（`command -v codex`）。
2. `codex app-server --help`，确认 `--stdio`、`--listen` 存在（0.166.0 源码中已确认，但需确认目标二进制一致）。
3. 启动 `codex app-server --stdio`，stdin 写 `initialize` → 读响应 → 写 `initialized`；再发一次 `initialize` 验证 `Already initialized`。
4. 只读分页：`thread/list` 用 `limit:50` 翻到 `nextCursor:null`；再用 `limit:100` 复跑，核对总数一致（README 声明单页上限 100）。
5. `thread/read`（`includeTurns:false/true`）+ `thread/turns/list` + `thread/items/list` 全量翻页，核对 turn/item 数量与 `itemsView`。
6. 回读时机：`thread/resume{excludeTurns:true}` 读 `model/reasoningEffort/approvalPolicy`；随后 `turn/start{model,effort}`，记录 `thread/settings/updated` 首次到达时间与值；重复 3 次。
7. 审批：分别触发 command / fileChange / permissions / requestUserInput / elicitation，保存脱敏请求；对每个决策值试答，记录 `serverRequest/resolved` 与 turn 状态。
8. 跨进程：同一 `CODEX_HOME` 启两个 app-server，A 持有 thread 并运行 turn，B `thread/resume` 同一 thread 后尝试 `turn/start`；再叠加本地 TUI 打开同一 thread。记录双方是否同时成功。
9. schema 复核（可选，需源码）：在 `rust-v0.166.0` checkout 执行 `just write-app-server-schema`，`git diff -- codex-rs/app-server-protocol/schema` 应为空。

### 5.2 Claude

1. `claude --version`，记录输出；与 SDK `system/init.claude_code_version` 对照。
2. 只读不 spawn：写一个只调用 `listSessions({dir})` + `getSessionMessages(id,{dir})` 的脚本，用 `strace -f -e execve node probe.mjs` 运行，确认没有 `claude` execve。
3. Query 生命周期：`query({prompt: asyncIterable, options:{permissionMode:'default', canUseTool}})`；记录首个 `system/init` 的 `model/permissionMode/effort/capabilities`。
4. setter 回读：`setModel`、`setPermissionMode`、`applyFlagSettings({effortLevel})` 后持续记录所有消息，确认是否出现新的 init/设置帧以及到达时间；重复 3 次。
5. 审批：构造 AskUserQuestion、普通工具、plan-review 三类 `canUseTool`；分别返回 allow（带/不带 updatedInput）、deny、null；记录 turn 状态、`permission_denials`、后续消息。
6. suggestions：令 `canUseTool` 收到非空 `suggestions`，应答不带 `updatedPermissions`，检查 CLI 是否自行持久化（对比应答前后设置文件 mtime/内容摘要，不读取凭据）。
7. 跨进程：本地 TUI 打开同一 session，第二个进程用 `query({options:{resume:id}})`；记录是否能并发写入、错误码、以及 `listSessions` 是否反映运行态。
8. 历史完整性：对同一 session 用 `limit/offset` 分页读，核对条数与顺序；并与 `getSessionInfo.lastModified` 对照。

## 6. 降级表（字段/方法缺失 → 能力）

| 缺失/未证 | 影响 | 降级 |
|---|---|---|
| Codex 无 `protocolVersion` | 无法做协议版本协商 | 只按 `codex --version` + `userAgent` 记录；版本不符则 agent `unavailable`，不尝试兼容 |
| Codex 无 `canAcceptDirectInput` | 无法用官方字段判断"可直输" | 不据此判 idle；`thread/status` 仅作展示；写权仍需独立证据 |
| Codex 无 `availableDecisions` | 不知道原生允许集合 | 仅提交自身白名单子集；未知请求返回 JSON-RPC 错误，不静默挂起 |
| Codex `thread/resume` 对运行中 thread 是 rejoin | resume 成功 ≠ 排他 | 仅实现外部历史观察；`acquire` 返回 `ownership-unverified` |
| Codex goal 回读时序未证 | 不能确认 set 生效 | goal 只读展示；set 保持 pending，超时后标记 unknown |
| Codex `requestUserInput` 无答案语义未证 | 不能安全代答 | 该能力关闭（只展示问题，不提供回答入口） |
| Codex elicitation 为 EXPERIMENTAL | 形状可能变 | 一律 decline/cancel，不建卡 |
| Claude 无 model/permissionMode getter（setter 返回 void） | 无法发布 confirmed | 设置后只发 `pending-confirmation`；读不到新 init 则不宣称生效 |
| Claude effort 仅 init 快照 + void `applyFlagSettings` | 无独立回读 | effort 编辑能力关闭 |
| Claude 无 goal API | 无 goal 概念 | goal 能力 `unavailable`（不伪造） |
| Claude `SDKSessionInfo` 无 running/status | 无法区分 foreign-idle / foreign-running | 外部会话一律 `foreign-unknown`，只读 |
| Claude `SessionMessage.message: unknown` | 历史内容无结构保证 | 只投影有限字段 + 隐私计数，不按内容建索引 |
| Claude `canUseTool` 可返回 `null` 但语义未定义 | 无答案行为不可控 | 显式 `deny`（带 message），不用 `null` |
| Claude 持久 destination 存在（user/project/local/cliArg） | 可能越权固化 | 忽略 `suggestions`，永不返回 `updatedPermissions` |
| Claude `query()` 是控制动作 | observe 不得触发推理 | observe 只调 `listSessions/getSessionMessages`；Query 仅由显式控制请求创建 |

## 7. 结论与边界

1. 目标版本的**协议/类型形状**已足够支撑适配器骨架设计：Codex 0.166.0 的 initialize/分页/resume/turn/审批/设置/goal 全部有生成 schema；Claude 0.3.316 的 Query、流消息、权限、历史 API 全部有真实 `.d.ts`。
2. 但**没有任何运行期能力被验证**：只读 API 是否零 spawn、跨进程排他、setter 回读时机、混合决策接受度、suggestions 落盘、无答案/拒绝行为，全部 UNKNOWN。
3. 因此按计划原则：Codex/Claude 的 v1 适配只能先做**只读历史观察**；写权、设置编辑、审批代答在目标机证据补齐前保持关闭或 `ownership-unverified`。
4. 本报告不构成 v1 支持 Codex/Claude 的声明；fixture 目录当前为空（仅 README），任何"看起来像流量"的 jsonl 都不得提交。

## 8. 采集障碍记录

- 本机无 `gh`（`command -v gh` 为空）；GitHub REST API 返回 `403 API rate limit exceeded`（同一出口 IP）。
- 替代路径成功：`git ls-remote --tags https://github.com/openai/codex` 定位 tag；`raw.githubusercontent.com` 按 commit 读取 schema；`git clone --depth 1 --branch rust-v0.166.0 --filter=blob:none --sparse` 读取 `justfile`、CLI/协议源码。clone 后 `git log -1` 为 `6ff1e1ca…`，与 tag 解引用一致。
- 网络整体可用；无 package.json / pnpm-lock.yaml 改动，无 `pnpm add/install`，无测试运行，无 commit/push/PR。
