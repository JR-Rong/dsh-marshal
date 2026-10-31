# Claude fixture 规则（V1-T00）

状态：**未采集（BLOCKED）**。本目录当前没有任何 `.jsonl` 样本。
原因：本工作站未安装 `claude` 二进制（`command -v claude` 为空），任务边界禁止运行任何 agent/CLI，也不伪造"捕获流量"。

## 1. 唯一合法来源

1. 目标机安装的 `@anthropic-ai/claude-agent-sdk@0.3.316`（类型来源 `sdk.d.ts`）与其内置 CLI（SDK 包内 `manifest.json` 声明 `2.1.316`，commit `cd7ceb459c6864567b16a11f60101b24421475c1`）。
2. 目标机 `@anthropic-ai/claude-code@2.1.316` 的 CLI 输出（仅用于 `--version` 与 init 对照）。
3. 由真实 `query()` 会话产生的 `SDKMessage` 流（`system/init`、`assistant`、`result`、`session_state_changed` 等）。

禁止：用类型定义手写"看起来像消息"的样本；从旧版本 SDK 复制；把 docs 示例当流量；只保留成功路径而省略拒绝/中断路径。

## 2. 采集步骤（目标机）

1. `claude --version`，并与首个 `system/init.claude_code_version` 对照，写入 `meta.json`。
2. 只读（不建 Query）：`listSessions({dir})` 与 `getSessionMessages(id,{dir,limit,offset})` 的结果各存一份快照；同时用 `strace -f -e execve` 记录是否存在 `claude` 子进程。
3. 受管 Query（streaming input）：保存完整 `SDKMessage` 序列，至少覆盖：
   - `system/init`（记录 `model`、`permissionMode`、`effort`、`capabilities`、`tools`）；
   - `assistant`（含 tool_use）、`stream_event`（若开启 `includePartialMessages`）；
   - `system/session_state_changed`（`idle/running/requires_action`）；
   - `result`（success 与至少一种 error 子类型）。
4. 审批：`canUseTool` 分别命中 AskUserQuestion、普通工具、plan-review；每种保存 allow / deny / `null` 三条；拒绝样本必须含 `message`。
5. setter 时序：`setModel`、`setPermissionMode`、`applyFlagSettings({effortLevel})` 前后各保留 30 秒消息流，标记首个反映新值的帧。
6. 中断：`interrupt()` 的返回值（`still_queued` / `cancelled`）与该回合的 `result` 顺序。
7. 跨进程：TUI 持有同一 session 时，第二个进程 `query({options:{resume:id}})` 的结果或错误。

## 3. 脱敏规则（强制）

- 删除/替换：账号、邮箱、组织、token、cookie、`apiKeySource` 的具体凭据线索、绝对路径中的用户名、`cwd` 家目录、MCP server 的 URL/凭据。
- 保留并可用于断言：`type`/`subtype`、`uuid`/`session_id`（替换为固定假 UUID，同一文件内保持一致）、`parent_tool_use_id`、`permissionMode`、`model` 名、工具名、`PermissionResult.behavior`、`PermissionUpdate.destination`。
- 所有文本内容（`message.content`、`result.result`、工具输出）替换为 `"<redacted:text len=N sha256=…>"`；工具输入只保留键名与类型，不保留值。
- `SessionMessage.message` 在类型上是 `unknown`，脱敏后也不得把它当作可解析结构导出。

## 4. 类型推导示例（不是运行样本）

以下仅从 `sdk.d.ts`（0.3.316）推导的**最小结构**，用于写解析器时对照；不是抓包，不要命名为 `.jsonl`。

```ts
// system/init（SDKSystemMessage）
{ type:'system', subtype:'init', model:'…', permissionMode:'default', effort:'high',
  claude_code_version:'2.1.316', cwd:'…', tools:[], slash_commands:[], mcp_servers:[],
  session_id:'…', uuid:'…' }

// result（SDKResultSuccess）
{ type:'result', subtype:'success', result:'…', num_turns:1, stop_reason:'end_turn',
  total_cost_usd:0, modelUsage:{} }

// canUseTool 的 PermissionResult
{ behavior:'allow', updatedInput:{…} }
{ behavior:'deny', message:'…', interrupt:false }

// 权限更新（仅结构，策略上不会返回）
{ type:'addRules', rules:[{toolName:'…',ruleContent:'…'}], behavior:'allow',
  destination:'session' }
```

## 5. 待补清单

- [ ] 只读 API 零 spawn 的 strace 证据
- [ ] init / assistant / result / state 四类成功路径
- [ ] AskUserQuestion 的 allow/deny/null 三种
- [ ] setter 后首个回读帧（或"没有回读帧"的反证）
- [ ] interrupt 回执与 result 的顺序
- [ ] 双进程同 session 的并发结果

在补齐前，Claude 的映射只允许基于 `.d.ts` 写类型与校验；不得宣称"已支持 Claude"或"只读 API 不创建 Query"已证。
