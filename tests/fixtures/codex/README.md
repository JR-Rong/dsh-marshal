# Codex fixture 规则（V1-T00）

状态：**未采集（BLOCKED）**。本目录当前没有任何 `.jsonl` 样本。
原因：本工作站未安装 `codex` 二进制（`command -v codex` 为空），按任务边界不运行任何 agent，也不伪造"捕获流量"。

## 1. 唯一合法来源

1. 目标机安装的 `@openai/codex@0.166.0`（仓库 tag `rust-v0.166.0`，commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`）。
2. 通过 `codex app-server --stdio` 产生的真实 NDJSON 请求/响应/通知，逐条带 `direction`（client→server / server→client）与到达时间。
3. 由目标机上的 `just write-app-server-schema`（仓库 `justfile` 配方，commit 同上）生成的 schema，可作为**形状**校验，但不是流量样本。

禁止：手写、拼接、补全"合理"字段；从其它版本复制；把单条样本改造成多回合；把压缩/摘要后的内容写成原文。

## 2. 采集步骤（目标机）

1. `codex --version` 与 `command -v codex` 结果写入 `meta.json`。
2. 以 `codex app-server --stdio` 启动，stdin/stdout 原样落盘（一行一条 JSON），同时记录时间戳。
3. 覆盖的最小场景：
   - `initialize` → 响应 → `initialized`；重复 `initialize` 取错误样本。
   - `thread/list` 至少两页（含 `nextCursor` 与最后一页 `nextCursor:null`）。
   - `thread/read`（`includeTurns:false` 与 `true` 各一条）。
   - `thread/turns/list`、`thread/items/list` 各至少两页。
   - `thread/resume`（`excludeTurns:true`）。
   - `turn/start` → `turn/started`/`item/*`/`item/agentMessage/delta`/`turn/completed` 全链路。
   - 审批：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`；每种至少 accept 与 decline，能触发时补 cancel。
   - `thread/settings/updated`、`thread/status/changed`、`serverRequest/resolved`。
4. 每个场景一个文件，文件名即场景：`initialize.pair.jsonl`、`thread-list.page1.jsonl`、`turn-command-approval.pair.jsonl` 等。

## 3. 脱敏规则（强制）

- 删除/替换：账号、邮箱、token、cookie、`Authorization`、`codexHome` 中用户名、绝对路径中的家目录、git remote、命令中的密钥与环境变量值。
- 保留并可用于断言：方法名、`requestId`（可重编号为 1..n）、`threadId`/`turnId`/`itemId`（替换为固定假 UUID，但同一文件内保持一致）、枚举值、字段名与类型。
- 正文（assistant 文本、命令字符串、文件 diff）统一替换为 `"<redacted:text len=N sha256=…>"`，只保留长度与哈希；不要保留可还原内容。
- 脱敏后必须能通过仓库内 schema 的结构校验；**不得**为了通过校验而增删字段。

## 4. 类型/schema 推导示例（不是运行样本）

以下仅从 0.166.0 生成 schema 推导出的**最小结构**，用于写解析器时对照；不是抓包，不要命名为 `.jsonl`。

```jsonc
// ClientRequest.json / InitializeParams
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"…","version":"…"},"capabilities":{"experimentalApi":false}}}
// codex_app_server_protocol.schemas.json#InitializeResponse
{"codexHome":"…","platformFamily":"unix","platformOs":"linux","userAgent":"…"}
// ClientNotification.json
{"method":"initialized"}
// ThreadListResponse（codex_app_server_protocol.v2.schemas.json）
{"data":[],"nextCursor":null,"backwardsCursor":null}
// TurnCompletedNotification（ServerNotification.json）
{"threadId":"…","turn":{"id":"…","items":[],"status":"completed"}}
```

## 5. 待补清单

- [ ] `initialize` / 重复 initialize 错误
- [ ] 三处分页（list / turns / items）的首末页
- [ ] 四类审批请求与 accept/decline/cancel 应答
- [ ] `requestUserInput` 的有答案/空答案/不答
- [ ] `thread/settings/updated` 在 set 前后的时序
- [ ] 双进程同 thread 的并发结果

在补齐前，Codex 的协议映射只允许基于 schema 写类型与校验，不允许宣称"已用真实流量验证"。
